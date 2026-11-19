/**
 * AN EVENT'S WORKFLOW RUNS ON THE ASSISTANT THAT OWNS IT (ADR-061 decision 2, DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8).
 *
 * The room's primary orchestrates: it answers the turns nobody addressed and says the room's notices. An event's workflow is
 * owned: a trigger's by the assistant it was attached for, a typed room's by the role its type names, every other room's by
 * its primary. Pinned here, against the real resolvers and the assignment records:
 *  - an ops room's events run the ops assistant's workflows, whether the room's primary tag names the ops assistant or the
 *    Advisor (a room opened before the type named its primary);
 *  - an ordinary room's run its primary's, with no extra read;
 *  - an owner that is not a member of the room, an owner nobody holds, and an unreadable roster each refuse with a reason,
 *    and never run as the primary instead;
 *  - a trigger runs the workflow of the assistant it was attached for, and one naming no live assistant refuses;
 *  - an ops room is created with exactly one primary, the ops assistant; the Advisor stays a member, and its ops work is
 *    handed to the ops assistant, while an unaddressed turn is the ops assistant's as primary;
 *  - every event handler in the router resolves its runner through the one owner resolver, so no workflow runs as an
 *    assistant that does not own it.
 */
jest.unmock('../../lambda/src/lib/conversation-primary');
const mockSsmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: mockSsmSend })) };
});

import * as fs from 'fs';
import * as path from 'path';
import { workflowOwnerOf, workflowOwnerRoleOf } from '../../lambda/src/lib/workflow-owner';
import { primaryAssistantOf, primaryAssignmentOf, primaryTagFor, PRIMARY_TAG, __resetRoomPrimaryCache } from '../../lambda/src/lib/conversation-primary';
import { __resetAssistantCacheForTests } from '../../lambda/src/lib/default-agents';
import { CONVERSATION_TYPES } from '../../lib/config/conversation-types';
import { decideDelegation, delegationKey } from '../../lambda/src/lib/delegation';
import { routeHandover, type HandoverDispatch } from '../../lambda/src/lib/handover-routing';
import { handoverContent, handoverMetadata } from '../../lambda/src/lib/assistant-handover';
import { triggerRuleId, triggerTargetInput, watchRuleTags, WATCH_TAG } from '../../lambda/src/lib/event-triggers';
import type { Roommate } from '../../lambda/src/lib/assistant-advertisement';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1';
const ROOM = `${APP}/channel/room-1`;
const ADVISOR = `${APP}/bot/advisor-bot`;
const OPS = `${APP}/bot/ops-bot`;
const PERSON = `${APP}/user/person-1`;

const PREMIUM = [
  { assistant: 'advisor', role: 'primary', botArn: ADVISOR },
  { assistant: 'ops-premium', role: 'ops', botArn: OPS },
];
const assignments = (records: Array<{ assistant: string; role: string; botArn: string } & Record<string, unknown>>) =>
  mockSsmSend.mockResolvedValue({ Parameters: records.map((r) => ({ Value: JSON.stringify({ ...r, occupancy: 'live' }) })) });
const roomTags = (tags: Record<string, string>) => ({
  send: jest.fn(async () => ({ Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) })),
});
const inRoom = (...bots: string[]) => jest.fn(async () => bots);

beforeEach(() => {
  mockSsmSend.mockReset();
  __resetAssistantCacheForTests();
  __resetRoomPrimaryCache();
});

describe('the ops types name the ops assistant as the owner of their workflows; the primary stays the classification\'s', () => {
  it.each(['ops', 'ops-team'])('%s: the ops role owns its workflows, and the Advisor stays a member', (type) => {
    expect(CONVERSATION_TYPES[type].workflowOwner).toEqual({ assistantRole: 'ops' });
    expect([...(CONVERSATION_TYPES[type].defaultAgents ?? []), ...(CONVERSATION_TYPES[type].optionalAgents ?? [])]).toEqual(['advisor', 'ops-premium']);
    expect(workflowOwnerRoleOf(type)).toBe('ops');
  });

  it('an ops room requires the ops assistant; the team room adds it where the deployment declares it, and stands without it', () => {
    expect(CONVERSATION_TYPES.ops.defaultAgents).toEqual(['advisor', 'ops-premium']);
    expect(CONVERSATION_TYPES['ops-team'].defaultAgents).toEqual(['advisor']);
    expect(CONVERSATION_TYPES['ops-team'].optionalAgents).toEqual(['ops-premium']);
  });

  it('an ordinary type names no owner, so its rooms run their primary\'s workflows', () => {
    expect(CONVERSATION_TYPES.general.workflowOwner).toBeUndefined();
    expect(workflowOwnerRoleOf('general')).toBeUndefined();
    expect(workflowOwnerRoleOf(undefined)).toBeUndefined();
    expect(workflowOwnerRoleOf('no-such-type')).toBeUndefined();
  });
});

describe('whose workflow an event runs', () => {
  it('an ops room\'s conversation-opened runs the ops assistant\'s workflow, even where the room\'s primary is the Advisor', async () => {
    assignments(PREMIUM);
    const botsInRoom = inRoom(ADVISOR, OPS);
    const owner = await workflowOwnerOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'advisor' }), { conversationType: 'ops' }, { botsInRoom });
    expect(owner).toEqual({ assistant: 'ops-premium', botArn: OPS, classification: 'premium', source: 'type' });
    // The roster is read as the room's primary, which is a member by creation.
    expect(botsInRoom).toHaveBeenCalledWith(ROOM, ADVISOR);
  });

  it('an ops room whose primary is the ops assistant runs its workflow, with no roster read', async () => {
    assignments(PREMIUM);
    const botsInRoom = inRoom();
    const owner = await workflowOwnerOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'ops-premium' }), { conversationType: 'ops' }, { botsInRoom });
    expect(owner).toMatchObject({ assistant: 'ops-premium', botArn: OPS, source: 'type' });
    expect(botsInRoom).not.toHaveBeenCalled();
  });

  it('the team room\'s incident (event-received in ops-team) runs the ops assistant\'s workflow', async () => {
    assignments(PREMIUM);
    const owner = await workflowOwnerOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'advisor' }), { conversationType: 'ops-team' }, { botsInRoom: inRoom(ADVISOR, OPS) });
    expect(owner).toMatchObject({ assistant: 'ops-premium', botArn: OPS });
  });

  it('an ordinary room runs its primary\'s workflows, as before', async () => {
    assignments(PREMIUM);
    const botsInRoom = inRoom();
    const owner = await workflowOwnerOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'advisor' }), { conversationType: 'general' }, { botsInRoom });
    expect(owner).toEqual({ assistant: 'advisor', botArn: ADVISOR, classification: 'premium', source: 'primary' });
    expect(botsInRoom).not.toHaveBeenCalled();
  });

  it('refuses, with its reason, where the owning assistant is not a member of the room, and never runs as the primary', async () => {
    assignments(PREMIUM);
    const owner = await workflowOwnerOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'advisor' }), { conversationType: 'ops' }, { botsInRoom: inRoom(ADVISOR) });
    expect(owner).toEqual({ refused: 'the assistant that owns the workflow is not a member of the room' });
  });

  it('refuses where the roster cannot be read', async () => {
    assignments(PREMIUM);
    const unreadable = jest.fn(async () => null);
    expect(await workflowOwnerOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'advisor' }), { conversationType: 'ops' }, { botsInRoom: unreadable }))
      .toEqual({ refused: 'the room\'s members could not be read' });
    const throws = jest.fn(async () => { throw new Error('ThrottlingException'); });
    expect(await workflowOwnerOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'advisor' }), { conversationType: 'ops' }, { botsInRoom: throws }))
      .toEqual({ refused: 'the room\'s members could not be read' });
  });

  it('runs the primary\'s workflows where the deployment declares no assistant in the owning role; a console-created one never stands in', async () => {
    assignments([PREMIUM[0], { assistant: 'ops-copy', role: 'ops', botArn: `${APP}/bot/copy`, source: 'runtime' }]);
    for (const conversationType of ['ops', 'ops-team']) {
      __resetAssistantCacheForTests();
      __resetRoomPrimaryCache();
      const owner = await workflowOwnerOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'advisor' }), { conversationType }, { botsInRoom: inRoom(ADVISOR, `${APP}/bot/copy`) });
      expect(owner).toMatchObject({ assistant: 'advisor', botArn: ADVISOR, source: 'primary' });
    }
  });

  it('where the role is declared, its assistant owns the team room\'s workflows and the primary never stands in', async () => {
    assignments(PREMIUM);
    const owner = await workflowOwnerOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'advisor' }), { conversationType: 'ops-team' }, { botsInRoom: inRoom(ADVISOR) });
    expect(owner).toEqual({ refused: 'the assistant that owns the workflow is not a member of the room' });
  });

  it('a trigger runs the workflow of the assistant it was attached for', async () => {
    assignments(PREMIUM);
    const owner = await workflowOwnerOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'ops-premium' }), { conversationType: 'ops-team', attachedBy: 'advisor' }, { botsInRoom: inRoom(ADVISOR, OPS) });
    expect(owner).toEqual({ assistant: 'advisor', botArn: ADVISOR, classification: 'premium', source: 'trigger' });
  });

  it('a trigger attached for an assistant that is not live here, or not a member, or named by nothing a handle is, refuses', async () => {
    assignments(PREMIUM);
    const tags = roomTags({ classification: 'premium', [PRIMARY_TAG]: 'advisor' });
    expect(await workflowOwnerOf(ROOM, tags, { attachedBy: 'analyst' }, { botsInRoom: inRoom(ADVISOR, OPS) }))
      .toEqual({ refused: 'the assistant the trigger was attached for is not a live assistant of this classification' });
    expect(await workflowOwnerOf(ROOM, tags, { attachedBy: 'ops-premium' }, { botsInRoom: inRoom(ADVISOR) }))
      .toEqual({ refused: 'the assistant that owns the workflow is not a member of the room' });
    expect(await workflowOwnerOf(ROOM, tags, { attachedBy: '' }, { botsInRoom: inRoom(ADVISOR, OPS) }))
      .toEqual({ refused: 'the trigger names no assistant' });
  });
});

describe('a trigger records the assistant it was attached for', () => {
  const channelArn = `${APP}/channel/team-ops-team-premium`;
  const pattern = { source: ['a'], 'detail-type': ['b'] };

  it('in the team room rule\'s input, and as another rule than the same workflow attached for another assistant', () => {
    const input = triggerTargetInput({ rule: 'abc', channelArn, workflow: 'w', assistant: 'ops-premium' });
    const rendered = input.InputTemplate.replace('<at>', '"t"').replace('<source>', '"s"').replace('<detailType>', '"d"').replace('<resource>', '"r"');
    expect(JSON.parse(rendered).aeRuleEvent.assistant).toBe('ops-premium');
    expect(triggerRuleId(channelArn, 'w', pattern, 'ops-premium')).not.toBe(triggerRuleId(channelArn, 'w', pattern, 'advisor'));
    // A rule attached before the attach recorded an assistant keeps its id.
    expect(triggerRuleId(channelArn, 'w', pattern)).toBe(triggerRuleId(channelArn, 'w', pattern, undefined));
  });

  it('on the watch rule\'s tags', () => {
    const tags = watchRuleTags({ classification: 'premium', workflow: 'w', typeKey: 'ops', kind: 'ops-incident', source: 's', detailType: 'd', assistant: 'ops-premium' });
    expect(tags).toContainEqual({ Key: WATCH_TAG.assistant, Value: 'ops-premium' });
  });
});

describe('an ops room keeps the classification\'s primary, the ops assistant owns its events, and the Advisor hands ops work over', () => {
  it('is created with exactly one primary tag, naming the classification\'s primary', async () => {
    assignments(PREMIUM);
    expect(await primaryAssignmentOf('premium')).toEqual({ assistant: 'advisor', botArn: ADVISOR });
    expect(await primaryTagFor('premium', ADVISOR)).toEqual({ Key: PRIMARY_TAG, Value: 'advisor' });
  });

  it('the room\'s primary is the Advisor, while the ops role owns its events', async () => {
    assignments(PREMIUM);
    expect(await primaryAssistantOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'advisor' })))
      .toMatchObject({ assistant: 'advisor', botArn: ADVISOR, source: 'tag' });
    expect(workflowOwnerRoleOf('ops')).toBe('ops');
  });

  const roommate = (assistant: string, botArn: string, role: string, intents: Array<[string, string]>): Roommate => ({
    assistant, botArn, role, advertisement: { assistant, displayName: assistant, intents: intents.map(([key, summary]) => ({ key, summary })) },
  });

  it('a message @Advisor asking for ops work is handed to the ops assistant, not kept by the Advisor', async () => {
    const ops = roommate('ops-premium', OPS, 'ops', [['incident_first_look', 'ask me to take a first look at an incident']]);
    const decision = decideDelegation({ classifiedIntent: delegationKey('ops-premium', 'incident_first_look'), roommates: [ops] });
    expect(decision).toMatchObject({ kind: 'handover', roommate: { assistant: 'ops-premium', botArn: OPS } });

    // The Advisor's handover reaches the ops assistant, the roommate the work belongs to.
    const dispatched: HandoverDispatch[] = [];
    const outcome = await routeHandover({
      source: 'flow', channelArn: ROOM, handoverMessageId: 'h-1', senderArn: ADVISOR, content: handoverContent({ name: 'ops-premium', botArn: OPS }),
      metadata: handoverMetadata({ kind: 'capability', personMessageId: 'm-1', personSenderArn: PERSON, intent: 'incident_first_look' }),
    }, {
      readMessage: async (_c, id) => (id === 'h-1' ? { Sender: { Arn: ADVISOR }, Target: [{ MemberArn: OPS }] } : { Sender: { Arn: PERSON }, Target: [] }),
      listMembers: async () => [{ arn: ADVISOR, name: 'Advisor', isBot: true }, { arn: OPS, name: 'ops-premium', isBot: true }, { arn: PERSON, name: 'Pat', isBot: false }] as never,
      claim: async () => true,
      dispatch: async (turn) => { dispatched.push(turn); return true; },
    });
    expect(outcome).toBe('dispatched');
    expect(dispatched.map((d) => d.receiverBotArn)).toEqual([OPS]);
  });
});

describe('every event handler runs its workflow as the assistant that owns it', () => {
  const router = fs.readFileSync(path.join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const fnOf = (name: string): string => {
    const start = router.search(new RegExp(`\\n(export )?(async )?function ${name}[(<]`));
    expect(start).toBeGreaterThan(-1);
    const next = router.slice(start + 10).search(/\n(export )?(async )?function /);
    return router.slice(start, next < 0 ? undefined : start + 10 + next);
  };
  const handlers = ['handleInvitationSent', 'handleDeadlineFired', 'handleAlarmStateChanged', 'handleRuleEvent', 'handleWatchEvent', 'handlePersonJoined', 'handleConversationOpened', 'handleMeetingLifecycle'];

  it.each(handlers)('%s resolves its runner through the one owner resolver, and never runs as the primary', (name) => {
    const fn = fnOf(name);
    expect(fn).toMatch(/await eventWorkflowOwner\(/);
    expect(fn).toMatch(/if \('refused' in owner\) return /);
    expect(fn).toMatch(/runnerOf\(owner\.botArn, /);
    expect(fn).not.toMatch(/runnerOf\(primary\.botArn/);
  });

  it('the resolver holds the owner to this router\'s classification, and reads the roster as the primary', () => {
    const fn = fnOf('eventWorkflowOwner');
    expect(fn).toContain('workflowOwnerOf(channelArn, chimeClient,');
    expect(fn).toContain("owner.classification !== STATIC_CLASSIFICATION) return { refused: 'primary is another classification' }");
  });

  it('a trigger\'s assistant is the one its rule recorded, never inferred', () => {
    expect(fnOf('handleRuleEvent')).toContain('const attachedBy = r.assistant === undefined ? undefined : str(r.assistant, 64);');
    expect(fnOf('watchBindingOf')).toContain('const assistant = tags[WATCH_TAG.assistant];');
  });
  it('a team conversation opened before its type named the owning assistant is completed, and the event is delivered again', () => {
    const fn = fnOf('handleRuleEvent');
    expect(fn).toContain("if ('refused' in owner && owner.refused === OWNER_NOT_IN_ROOM) {");
    expect(fn.indexOf('await completeTeamRoom(roomType);')).toBeLessThan(fn.indexOf("throw new Error('the team conversation is completed"));
    expect(fnOf('completeTeamRoom')).toContain('teamRoom: true');
    const owner = fs.readFileSync(path.join(__dirname, '../../lambda/src/lib/workflow-owner.ts'), 'utf8');
    expect(owner).toContain("refused: 'the assistant that owns the workflow is not a member of the room'");
    expect(router).toContain("const OWNER_NOT_IN_ROOM = 'the assistant that owns the workflow is not a member of the room';");
  });
});
