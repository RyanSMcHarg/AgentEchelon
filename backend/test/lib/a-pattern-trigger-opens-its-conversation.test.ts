/**
 * A PATTERN TRIGGER'S EVENT RUNS IN THE CONVERSATION ITS TYPE'S PATTERN NAMES (DESIGN-EVENT-TARGETS 11.2, phase 6).
 *
 * A pattern trigger is a watch rule marked with the reserved `pattern` kind. What this proves:
 *  - the router holds the policy, the event's type and its age before anything is created, then resolves the pattern from the
 *    event and asks the creator for the conversation it names, with the policy's daily cap;
 *  - DENY: a pattern rule on a type with no pattern, an event the pattern cannot resolve, and a creator that refuses start nothing;
 *  - the creator checks a standing conversation's classification and type before it reuses it, recreates an archived one at the
 *    same id as its next generation, its row reset first so the new generation inherits none of the previous one's role
 *    holdings, identities or watches, and takes one of the day's creations before it creates;
 *  - DENY: the day's cap refuses a creation; IAM admits the creator's delete only on an archived pattern conversation of its own
 *    classification; a type declaring both a pattern and a watch never synthesizes.
 */
// THE DEPLOYMENT'S POLICY, as a deployment that never set its own reads it.
jest.mock('../../lambda/src/lib/event-policy', () => {
  const actual = jest.requireActual('../../lambda/src/lib/event-policy');
  return { ...actual, readEventPolicy: async () => actual.DEV_EVENT_POLICY };
});
import * as fs from 'fs';
import * as path from 'path';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CONVERSATION_TYPES, conversationPatternErrors } from '../../lib/config/conversation-types';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { handleWatchEvent, openPatternConversation } from '../../lambda/src/router-agent-handler';
import { __setChannelContextStore, claimPatternCreation, putChannelContext, resetPatternRoomContext } from '../../lambda/src/lib/channel-context-client';

const ROOT = path.join(__dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const AT = new Date().toISOString();
const event = (over: Record<string, unknown> = {}) => ({ rule: 'abcdef012345', at: AT, source: 'ae.ops', detailType: 'Incident updated', resource: '', key: 'INC-1', ...over });
const PATTERN_BINDING = { workflow: 'ticket-updated', type: 'test-ticket', kind: 'pattern', source: 'ae.ops', detailType: 'Incident updated' };

beforeAll(() => {
  (CONVERSATION_TYPES as Record<string, unknown>)['test-ticket'] = { classifications: ['premium'], initiation: 'system', conversationPattern: 'ticket:{key}' };
});
afterAll(() => { delete (CONVERSATION_TYPES as Record<string, unknown>)['test-ticket']; });

describe('the router, for a pattern trigger\'s event', () => {
  it('resolves the pattern from the event and asks the creator for the conversation it names, with the day\'s cap and the event to hand back', async () => {
    const asked: unknown[][] = [];
    const out = await handleWatchEvent(event(), { binding: async () => PATTERN_BINDING, roomTags: async () => null, patternRuns: async () => undefined, openPattern: async (...a) => { asked.push(a); return true; } });
    expect(asked).toEqual([['test-ticket', 'ticket:INC-1', 25, undefined, event()]]);
    expect(out).toEqual({ ran: false, reason: 'the pattern conversation is being opened; the event is handed back once it stands' });
  });

  it('runs in a standing conversation of this type at once, and asks nothing; a handed-back event never asks again', async () => {
    const open = jest.fn();
    // THE ROUTER'S OWN CLASSIFICATION, as its deployment sets it (unset in this test).
    const standing = { classification: process.env.CLASSIFICATION || '', conversationType: 'test-ticket' };
    // Past the conversation, the run's own checks read the room (here unreachable), so the point is that nothing is asked.
    await handleWatchEvent(event(), { binding: async () => PATTERN_BINDING, roomTags: async () => standing, patternRuns: async () => undefined, openPattern: open }).catch(() => undefined);
    expect(open).not.toHaveBeenCalled();
    expect(await handleWatchEvent({ ...event(), handedBack: 1 }, { binding: async () => PATTERN_BINDING, roomTags: async () => null, patternRuns: async () => undefined, openPattern: open }))
      .toEqual({ ran: false, reason: 'the pattern conversation does not stand after the creator handed the event back' });
    expect(open).not.toHaveBeenCalled();
  });

  it('DENY: an archived conversation, or one of another type, at the derived id is not run in: the creator is asked, and it refuses another type', async () => {
    const open = jest.fn(async () => true);
    await handleWatchEvent(event(), { binding: async () => PATTERN_BINDING, roomTags: async () => ({ classification: 'premium', conversationType: 'test-ticket', archived: 'true' }), patternRuns: async () => undefined, openPattern: open });
    await handleWatchEvent(event(), { binding: async () => PATTERN_BINDING, roomTags: async () => ({ classification: 'premium', conversationType: 'ops' }), patternRuns: async () => undefined, openPattern: open });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('DENY: a pattern rule on a type with no pattern opens nothing', async () => {
    const open = jest.fn();
    expect(await handleWatchEvent(event(), { binding: async () => ({ ...PATTERN_BINDING, type: 'ops' }), patternRuns: async () => undefined, openPattern: open }))
      .toEqual({ ran: false, reason: 'the rule names a type with no conversation pattern' });
    expect(open).not.toHaveBeenCalled();
  });

  it('DENY: an event the policy does not allow, or one the pattern cannot resolve, creates nothing', async () => {
    const open = jest.fn();
    expect(await handleWatchEvent(event({ source: 'ae.other' }), { binding: async () => ({ ...PATTERN_BINDING, source: 'ae.other' }), patternRuns: async () => undefined, openPattern: open }))
      .toEqual({ ran: false, reason: 'the event type is not allowed' });
    expect(await handleWatchEvent(event({ key: 'a b' }), { binding: async () => PATTERN_BINDING, patternRuns: async () => undefined, openPattern: open }))
      .toEqual({ ran: false, reason: 'the event does not resolve the type\'s conversation pattern' });
    expect(await handleWatchEvent(event({ at: new Date(Date.now() - 3_600_000).toISOString() }), { binding: async () => PATTERN_BINDING, patternRuns: async () => undefined, openPattern: open }))
      .toEqual({ ran: false, reason: 'the event is older than the policy allows' });
    expect(open).not.toHaveBeenCalled();
  });

  it('derives the conversation\'s id as the creator does, and asks the creator asynchronously, so this router fires no synchronous invoke', () => {
    const router = read('lambda/src/router-agent-handler.ts');
    expect(router).toContain('patternChannelId(STATIC_CLASSIFICATION, binding.type, resolved)');
    expect(router).not.toContain('InvocationType.RequestResponse');
    const creator = read('lambda/src/typed-conversation-from-event.ts');
    expect(creator).toContain('await handWatchEventBack({ ...(detail.patternRoom.handBack as Record<string, unknown>), handedBack: 1 });');
  });

});

describe('the day\'s creations of a pattern type', () => {
  const send = jest.spyOn(DynamoDBDocumentClient.prototype, 'send') as unknown as jest.Mock;
  beforeAll(() => { process.env.CHANNEL_CONTEXT_TABLE = 'ctx'; });
  afterEach(() => send.mockReset());

  it('counts one per creation, per classification, type and day, under the cap', async () => {
    send.mockResolvedValue({});
    expect(await claimPatternCreation('premium', 'test-ticket', 25, Date.parse('2026-11-20T10:00:00Z'))).toBe(true);
    const input = (send.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({
      Key: { channelArn: 'pattern-created#premium#test-ticket#2026-11-20' },
      ConditionExpression: 'attribute_not_exists(#n) OR #n < :cap',
      ExpressionAttributeValues: expect.objectContaining({ ':cap': 25 }),
    });
  });

  it('DENY: a day at its cap creates nothing, and a count that cannot be taken throws', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'ConditionalCheckFailedException' }));
    expect(await claimPatternCreation('premium', 'test-ticket', 25)).toBe(false);
    send.mockRejectedValueOnce(Object.assign(new Error('down'), { name: 'ServiceUnavailable' }));
    await expect(claimPatternCreation('premium', 'test-ticket', 25)).rejects.toThrow('down');
  });
});

describe('the creator, for a pattern conversation', () => {
  const creator = read('lambda/src/typed-conversation-from-event.ts');
  const branch = creator.slice(creator.indexOf('if (detail.patternRoom) {'), creator.indexOf('// THE ROOM IS NAMED AT CREATION'));

  it('checks a standing conversation\'s classification and type, then recreates an archived one, then takes the day\'s creation', () => {
    const steps = [
      'if (!isPatternType(typeKey))', 'channelStands(channelArn, admin)',
      "tags.classification !== DEPLOYED_CLASSIFICATION || tags[CONVERSATION_TYPE_TAG] !== typeKey",
      'if (isArchived(tags))', 'deleteArchivedPatternRoom(channelArn, admin)',
      'claimPatternCreation(DEPLOYED_CLASSIFICATION, typeKey, detail.patternRoom.capPerDay)',
    ].map((t) => branch.indexOf(t));
    expect(steps.every((i) => i > -1)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    // ITS ID IS DERIVED FROM THIS CREATOR'S OWN CLASSIFICATION, never taken from the caller.
    expect(creator).toMatch(/patternChannelId\(DEPLOYED_CLASSIFICATION, detail\.conversationType, detail\.patternRoom\.resolved\)/);
  });

  it('DENY: IAM admits its delete only on an archived pattern conversation of its own classification', () => {
    const construct = read('lib/constructs/conversation-creator.ts');
    expect(construct).toMatch(/sid: 'RecreateAnArchivedPatternConversation',\s+actions: \['chime:DeleteChannel'\],\s+resources: \[`\$\{appInstanceArn\}\/channel\/pat-\$\{classification\}-\*`\],\s+conditions: \{ StringEquals: \{ 'aws:ResourceTag\/classification': classification, 'aws:ResourceTag\/archived': 'true' \} \},/);
  });

  it('DENY: a type declaring both a pattern and a watch, or a watch of the reserved kind, never synthesizes', () => {
    const errs = conversationPatternErrors({
      both: { conversationPattern: 't:{key}', initiation: 'system', openedBy: [{ watches: { kind: 'ticket' } }] },
      reserved: { initiation: 'system', openedBy: [{ watches: { kind: 'pattern' } }] },
    }).join('\n');
    expect(errs).toMatch(/both declares both conversationPattern and an opener that watches a key/);
    expect(errs).toMatch(/reserved\.openedBy records a "pattern", "named" or "process" key, kinds reserved for pattern, named and process triggers/);
  });
});

describe('the admin list reads a recreated conversation\'s latest generation', () => {
  it('counts deletion and archiving only since the last creation', () => {
    const q = read('lambda/src/analytics-aurora/admin-conversations-aurora.ts');
    expect(q).toMatch(/AND \(g\.born IS NULL OR l\.created_at >= g\.born\)/);
  });
});

describe('what IAM refuses the creator whatever its code asks', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { creatorTypeBounds } = require('../../lib/constructs/conversation-creator') as typeof import('../../lib/constructs/conversation-creator');
  const json = (classification: string) => creatorTypeBounds(classification, 'arn:aws:chime:us-east-1:1:app-instance/i').map((s) => s.toStatementJson());

  it('DENY: a create of a type the classification does not permit, and a pattern tag naming anything but a declared pattern type', () => {
    const [types, pattern] = json('premium');
    expect(types).toMatchObject({ Effect: 'Deny', Action: 'chime:CreateChannel', Condition: { StringNotEquals: { 'aws:RequestTag/conversationType': expect.arrayContaining(['ops', 'ops-team']) } } });
    expect(pattern).toMatchObject({ Effect: 'Deny', Action: 'chime:CreateChannel', Condition: { StringNotEquals: { 'aws:RequestTag/pattern-room': ['test-ticket'] }, Null: { 'aws:RequestTag/pattern-room': 'false' } } });
  });

  it('a classification no type permits as a pattern refuses every pattern tag', () => {
    delete (CONVERSATION_TYPES as Record<string, unknown>)['test-ticket'];
    const [, pattern] = json('premium');
    expect(pattern.Condition).toEqual({ Null: { 'aws:RequestTag/pattern-room': 'false' } });
    (CONVERSATION_TYPES as Record<string, unknown>)['test-ticket'] = { classifications: ['premium'], initiation: 'system', conversationPattern: 'ticket:{key}' };
  });
});

describe('the attach API, for a pattern type', () => {
  it('writes a watch rule marked with the pattern kind, reading the key only where the pattern names {key}', () => {
    const api = read('lambda/src/event-triggers-api.ts');
    expect(api).toMatch(/const kind = named \? NAMED_WATCH_KIND : byPattern \? PATTERN_WATCH_KIND :/);
    expect(api).toMatch(/const keyPath = handoff \? HANDOFF_KEY_PATH : named \|\| \(byPattern && !usesKey\) \? '\$\.resources\[0\]' :/);
    expect(api).toMatch(/if \(!byPattern && !named && !handoff && \(!kindSource \|\| !recorded\)\)/);
  });
});

describe('the recreate grant, where a classification has a pattern type', () => {
  it('DENY: a classification that permits no pattern type holds no delete for one', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { classificationHasPatternTypes } = require('../../lib/constructs/conversation-creator') as typeof import('../../lib/constructs/conversation-creator');
    expect(classificationHasPatternTypes('premium')).toBe(true);
    expect(classificationHasPatternTypes('standard')).toBe(false);
  });
});

describe('a recreated pattern conversation starts from its own row', () => {
  const ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst/channel/pat-premium-test-ticket-abc';
  /** The context table in memory: a get, and an update's SET (with if_not_exists), REMOVE and its generation condition. */
  function memoryTable(rows: Map<string, Record<string, unknown>>) {
    return {
      send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
        const { Key, UpdateExpression, ConditionExpression, ExpressionAttributeNames: names = {}, ExpressionAttributeValues: values = {} } = cmd.input;
        const row = rows.get(Key.channelArn);
        if (cmd.constructor.name === 'GetCommand') return { Item: row ? { ...row } : undefined };
        const next: Record<string, unknown> = { ...(row ?? { channelArn: Key.channelArn }) };
        if (ConditionExpression) {
          const g = next[names['#generation']];
          if (!(g === undefined || g === values[':g'])) throw Object.assign(new Error('condition'), { name: 'ConditionalCheckFailedException' });
        }
        const [setPart, removePart] = String(UpdateExpression).split(/\s*REMOVE\s*/);
        for (const clause of setPart.replace(/^SET\s*/, '').split(/,\s*(?=#)/).filter(Boolean)) {
          const [lhs, rhs] = clause.split(/\s*=\s*/);
          const value = rhs.startsWith('if_not_exists') ? (next[names[lhs]] ?? values[rhs.match(/(:\w+)\)/)![1]]) : values[rhs.trim()];
          next[names[lhs]] = value;
        }
        for (const n of (removePart ?? '').split(/,\s*/).filter(Boolean)) delete next[names[n.trim()]];
        rows.set(Key.channelArn, next);
        return {};
      },
    };
  }
  beforeAll(() => { process.env.CHANNEL_CONTEXT_TABLE = 'ctx'; });
  afterEach(() => __setChannelContextStore(null));

  it('does not inherit the previous generation\'s participant roles, identities or watches', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    __setChannelContextStore(memoryTable(rows) as never);
    await putChannelContext(ARN, {
      conversationType: 'test-ticket', generation: 1, participantRoles: { 'on-call:ops': { 'arn:old-holder': { origin: 'group' } } },
      watchedRefs: ['ticket#INC-1'], eventSummary: 'The first generation.',
    });
    expect(rows.get(ARN)).toMatchObject({ participantRoles: { 'on-call:ops': { 'arn:old-holder': { origin: 'group' } } } });
    await resetPatternRoomContext(ARN, 1);
    expect(rows.get(ARN)).toEqual({ channelArn: ARN });
    // THE NEXT GENERATION WRITES ITS OWN ROW, here with no role holdings of its own, and none of the first's comes back.
    await putChannelContext(ARN, { conversationType: 'test-ticket', generation: 2 });
    expect(rows.get(ARN)?.participantRoles).toBeUndefined();
    expect(rows.get(ARN)?.watchedRefs).toBeUndefined();
    expect(rows.get(ARN)).toMatchObject({ generation: 2 });
  });

  it('DENY: a row that names a later generation is never wiped, and the recreation stops there', async () => {
    const rows = new Map<string, Record<string, unknown>>([[ARN, { channelArn: ARN, generation: 3, participantRoles: { lead: ['arn:now'] } }]]);
    __setChannelContextStore(memoryTable(rows) as never);
    await expect(resetPatternRoomContext(ARN, 2)).rejects.toThrow('condition');
    expect(rows.get(ARN)).toMatchObject({ participantRoles: { lead: ['arn:now'] } });
  });

  it('a row written before its generation was recorded is reset, and an absent row is nothing to reset', async () => {
    const rows = new Map<string, Record<string, unknown>>([[ARN, { channelArn: ARN, participantRoles: { lead: ['arn:old'] } }]]);
    __setChannelContextStore(memoryTable(rows) as never);
    await resetPatternRoomContext(ARN, 2);
    expect(rows.get(ARN)).toEqual({ channelArn: ARN });
    rows.clear();
    await resetPatternRoomContext(ARN, 1);
    expect(rows.has(ARN)).toBe(false);
  });

  it('the creator resets the row before it deletes the archived conversation, and records each generation on the row', () => {
    const creator = read('lambda/src/typed-conversation-from-event.ts');
    const reset = creator.indexOf('await resetPatternRoomContext(channelArn, archivedGeneration);');
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(creator.indexOf('await deleteArchivedPatternRoom(channelArn, admin);'));
    expect(read('lambda/src/lib/channel-creation.ts')).toContain('...(input.patternRoom ? { generation: input.patternRoom.generation } : {}),');
    // THE RESET IS AN UPDATE THE CREATOR ALREADY HOLDS: no PutItem or DeleteItem is granted for it.
    const stack = read('lib/stacks/assistant-profile-stack.ts');
    expect(stack).toMatch(/eventCreateRole\.addToPrincipalPolicy\(new iam\.PolicyStatement\(\{\s+actions: \['dynamodb:GetItem', 'dynamodb:UpdateItem'\],\s+resources: \[shared\.channelContextArn\],/);
  });
});

describe('DENY: a pattern conversation with nobody to open it for', () => {
  it('is refused at attach where its pattern names no person and its type no one-holder lead role', () => {
    const api = read('lambda/src/event-triggers-api.ts');
    expect(api).toMatch(/if \(!handoff && byPattern && !variables\.includes\('person'\) && !teamRoomLeadRole\(typeKey\)\) \{\s+return respond\(event, 409, \{ code: 'PATTERN_NO_LEAD_ROLE'/);
  });

  it('asks the creator nothing at the router, once, rather than a request the creator refuses every time', async () => {
    process.env.TYPED_CREATOR_NAME = 'ae-premium-TypedConversationFromEvent';
    const send = jest.spyOn(LambdaClient.prototype, 'send').mockResolvedValue({} as never);
    try {
      // `test-ticket` declares no participant role, and its pattern names no person.
      expect(await openPatternConversation('test-ticket', 'INC-1', 25, undefined, {})).toBe(false);
      expect(send).not.toHaveBeenCalled();
      // A pattern that names its person opens for that person.
      expect(await openPatternConversation('test-ticket', 'INC-1', 25, 'arn:aws:chime:us-east-1:111122223333:app-instance/inst/user/p-1', {})).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
      delete process.env.TYPED_CREATOR_NAME;
    }
  });
});

describe('DENY: an event that could never run opens no conversation', () => {
  it('a workflow its owner does not serve for the type, or an owner that is not live, is refused before the creator is asked', async () => {
    const open = jest.fn(async () => true);
    const out = await handleWatchEvent(event(), {
      binding: async () => PATTERN_BINDING, roomTags: async () => null, openPattern: open,
      patternRuns: async () => 'the workflow runs in another type of conversation',
    });
    expect(out).toEqual({ ran: false, reason: 'the workflow runs in another type of conversation' });
    expect(open).not.toHaveBeenCalled();
  });

  it('a named conversation that is gone is refused once, from one read of its tags', async () => {
    const prev = process.env.APP_INSTANCE_ARN;
    process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst';
    const reads: string[] = [];
    try {
      const out = await handleWatchEvent(
        { ...event({ source: 'ae.connector', detailType: 'Fact' }), fact: { connectorId: 'c1', eventId: 'e1', conversation: 'conv-gone' } },
        {
          binding: async () => ({ workflow: 'ticket-updated', type: 'test-ticket', kind: 'named', source: 'ae.connector', detailType: 'Fact' }),
          confirms: async () => true, roomTags: async (arn) => { reads.push(arn); return null; },
        },
      );
      expect(out).toEqual({ ran: false, reason: 'the conversation the event names is gone' });
      expect(reads).toHaveLength(1);
    } finally {
      process.env.APP_INSTANCE_ARN = prev;
    }
  });
});

describe('a recreated pattern conversation, its id and its lead', () => {
  it('a create whose id a delete in flight still holds is tried again with a growing pause, and any other failure is not', async () => {
    const { retryWhileConflict, CONFLICT_ATTEMPTS } = await import('../../lambda/src/lib/transient-retry');
    const pauses: number[] = [];
    let calls = 0;
    const conflict = () => Object.assign(new Error('held'), { name: 'ConflictException' });
    const out = await retryWhileConflict(async () => { calls += 1; if (calls < 3) throw conflict(); return 'created'; }, 1000, { pause: async (ms) => { pauses.push(ms); } });
    expect(out).toBe('created');
    expect(pauses).toEqual([1000, 2000]);
    calls = 0;
    await expect(retryWhileConflict(async () => { calls += 1; throw conflict(); }, 1, { pause: async () => undefined })).rejects.toThrow('held');
    expect(calls).toBe(CONFLICT_ATTEMPTS);
    calls = 0;
    await expect(retryWhileConflict(async () => { calls += 1; throw new Error('denied'); }, 1, { pause: async () => undefined })).rejects.toThrow('denied');
    expect(calls).toBe(1);
  });

  it('the creator retries only the create: the day\'s creation and the generation are taken once, before the delete', () => {
    const creator = read('lambda/src/typed-conversation-from-event.ts');
    expect(creator).toContain('? retryWhileConflict(() => createConversationFromEvent(createInput), RECREATE_CONFLICT_PAUSE_MS)');
    expect(creator.indexOf('claimPatternCreation(DEPLOYED_CLASSIFICATION, typeKey, detail.patternRoom.capPerDay)')).toBeLessThan(creator.indexOf('retryWhileConflict(() => createConversationFromEvent(createInput)'));
  });

  it('a standing pattern conversation whose lead role has no single holder takes its event back; one to create or recreate is refused', () => {
    const creator = read('lambda/src/typed-conversation-from-event.ts');
    expect(creator).toContain('if (detail.patternRoom) await handBackStandingPatternRoom(detail, err);');
    const fn = creator.slice(creator.indexOf('async function handBackStandingPatternRoom('), creator.indexOf('/** Hand the run that asked for this conversation back'));
    expect(fn).toMatch(/if \(!\(await channelStands\(channelArn, admin\)\)\) throw leadErr;/);
    expect(fn).toMatch(/if \(isArchived\(tags\)\) throw leadErr;/);
    expect(fn).toContain('await handWatchEventBack({ ...(detail.patternRoom.handBack as Record<string, unknown>), handedBack: 1 });');
  });

  it('DENY: a pattern that can resolve past the id\'s bound is refused at synth, and an event that resolves past it starts nothing', async () => {
    const { MAX_PATTERN_RESOLVED, patternResolvedMax } = await import('../../lib/config/conversation-types');
    expect(patternResolvedMax('ticket:{key}')).toBe(7 + 128);
    expect(conversationPatternErrors({ wide: { initiation: 'system', conversationPattern: '{key}:{person}' } } as never).join('\n')).toMatch(/can resolve to more than 200 characters/);
    expect(conversationPatternErrors({ narrow: { initiation: 'system', conversationPattern: 'ticket:{key}' } } as never)).toEqual([]);
    expect(MAX_PATTERN_RESOLVED).toBe(200);
    expect(read('lambda/src/router-agent-handler.ts')).toContain('if (resolved.length > MAX_PATTERN_RESOLVED) return refuse(');
  });
});
