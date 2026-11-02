/**
 * A PERSON IS WELCOMED ONCE PER ARRIVAL (ADR-061 decision 5).
 *
 * A conversation an event opens has two paths that can greet the people it was opened for: the join (`WelcomeIntent`,
 * the room's opening, an intake, an `assistant-joined` workflow's `subject` step) and the creator's events
 * (`conversation-opened`, then `person-joined` for each person it admits). They run concurrently, so which one owns a
 * person's welcome is read from configuration, never from which finished first (`arrivalWelcomeOwner`):
 *
 *  - a `conversation-opened` workflow owns the room and its lead: the join posts nothing and starts no intake, and the
 *    creator names the lead in no `person-joined` (the router returns the lead as the opening run's);
 *  - a `person-joined` workflow for a type an event opens owns every admitted person, the lead included: the join says
 *    the room's opening (structured or `prompt`) addressed to nobody, starts no intake, and runs an `assistant-joined`
 *    workflow with no subject;
 *  - otherwise the join owns the room's opening and the subject's intake or greeting, and each source welcomes as before.
 *
 * Each mode is proven: the owner the rule names, the run-level count of welcomes addressed to the lead, and the
 * router's join honoring the rule before it starts an intake or greets a subject.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  arrivalWelcomeOwner,
  eventNaturalKey,
  eventRunKey,
  runEventWorkflow,
  PLATFORM_EVENT_WORKFLOWS,
  type EventRunContext,
  type EventRunDeps,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { peopleJoiningAfterOpening, welcomeIntoOpenedConversation } from '../../lambda/src/lib/typed-conversation-notice';
import { CONVERSATION_TYPES } from '../../lib/config/conversation-types';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

const APP = 'arn:aws:chime:us-east-1:1:app-instance/ai';
const CHANNEL = `${APP}/channel/ops-1`;
const LEAD = `${APP}/user/lead`;
const SAM = `${APP}/user/sam`;
const BOT = `${APP}/bot/ops`;

/** A type an event opens, and one nobody's event opens. */
const OPENED = Object.keys(CONVERSATION_TYPES).find((t) => (CONVERSATION_TYPES[t].openedBy ?? []).length)!;
const PLAIN = 'general';

const JOINED: EventWorkflow = {
  on: 'person-joined',
  initial: 'greet',
  states: {
    greet: { send: { to: 'joined', template: 'workflow-subject-welcome', mention: { name: 'event:person' } }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
};
const OPS_ROOM = PLATFORM_EVENT_WORKFLOWS['ops-room'];
const OPENING_AND_SUBJECT = PLATFORM_EVENT_WORKFLOWS['opening-and-subject'];

describe('which run owns the welcome of the people a room was opened for, mode by mode', () => {
  it('the shipped types include one an event opens and one none does', () => {
    expect(OPENED).toBeDefined();
    expect(CONVERSATION_TYPES[PLAIN].openedBy ?? []).toEqual([]);
  });

  it('a conversation-opened workflow for the type: that run owns the lead, whatever else the version declares', () => {
    for (const own of [{ 'ops-room': OPS_ROOM }, { 'ops-room': OPS_ROOM, joined: JOINED }] as Array<Record<string, EventWorkflow>>) {
      expect(arrivalWelcomeOwner({ conversationType: OPENED, own })).toBe('conversation-opened');
    }
  });

  it.each([
    ['the welcome of the platform', {}],
    ['a welcome with a prompt step', { welcome: { on: 'assistant-joined', initial: 'o', states: { o: { opening: {}, onSuccess: 'p' }, p: { prompt: { template: 'welcome-greeting' }, onSuccess: 'd' }, d: { disposition: 'success' } } } }],
    ['a welcome that runs', { 'opening-and-subject': OPENING_AND_SUBJECT }],
  ])('%s, with a person-joined workflow, in a type an event opens: the person-joined run owns every admitted person', (_label, welcome) => {
    expect(arrivalWelcomeOwner({ conversationType: OPENED, own: { ...(welcome as Record<string, EventWorkflow>), joined: JOINED } })).toBe('person-joined');
  });

  it.each([
    ['no person-joined workflow', OPENED, {}],
    ['a welcome that runs, and no person-joined workflow', OPENED, { 'opening-and-subject': OPENING_AND_SUBJECT }],
    ['a person-joined workflow in a type no event opens (its people were not named at creation)', PLAIN, { joined: JOINED }],
    ['a person-joined workflow that does not run in this type', OPENED, { joined: { ...JOINED, types: [PLAIN] } }],
    ['no type recorded', undefined, { joined: JOINED }],
  ])('%s: the join owns the room and its subject, as before', (_label, conversationType, own) => {
    expect(arrivalWelcomeOwner({ conversationType, own: own as Record<string, EventWorkflow> })).toBeUndefined();
  });
});

describe('the lead is welcomed once (run level)', () => {
  /** Every message a run addresses to a person, by person: what counts as a welcome. */
  function world() {
    const taken = new Set<string>();
    const addressed = new Map<string, string[]>();
    const room: string[] = [];
    const deps = (event: string, key: string): EventRunDeps => ({
      claimRun: async () => (taken.has(key) ? false : (taken.add(key), true)),
      claimStep: async (step) => (taken.has(`${key}#${step}`) ? false : (taken.add(`${key}#${step}`), true)),
      mentionName: async () => 'Lee',
      send: async (a) => {
        if (!a.to.length) room.push(`${event}:${a.template}`);
        for (const p of a.to) addressed.set(p, [...(addressed.get(p) ?? []), `${event}:${a.template}`]);
        return true;
      },
      dispatchAgent: async () => true,
    });
    return { addressed, room, deps };
  }

  it('conversation-opened and person-joined both declared: the opening run welcomes the lead, person-joined everyone else', async () => {
    const w = world();
    const opened: EventRunContext = { event: 'conversation-opened', channelArn: CHANNEL, eventPerson: LEAD, roles: { lead: [LEAD] }, values: {} };
    const out = await runEventWorkflow('ops-room', OPS_ROOM, opened, w.deps('conversation-opened', eventRunKey('conversation-opened', eventNaturalKey('conversation-opened', CHANNEL)!, 'ops')));
    expect(out.ran).toBe(true);
    // What the router returns for the opening (`handleConversationOpened`): the lead, whose welcome the run owns.
    const owned = new Set(out.ran ? [LEAD] : []);
    const joining = peopleJoiningAfterOpening(LEAD, [SAM, LEAD], owned);
    expect(joining).toEqual([SAM]);
    for (const p of joining) {
      await runEventWorkflow('joined', JOINED, { event: 'person-joined', channelArn: CHANNEL, eventPerson: p, values: {} },
        w.deps('person-joined', eventRunKey('person-joined', eventNaturalKey('person-joined', CHANNEL, p)!, 'ops')));
    }
    expect(w.addressed.get(LEAD)).toEqual(['conversation-opened:ops-lead-welcome']);
    expect(w.addressed.get(SAM)).toEqual(['person-joined:workflow-subject-welcome']);
    expect(w.room).toEqual(['conversation-opened:ops-room-opening']);
  });

  it('without the opening run, everyone the room admitted is named once, the lead first', () => {
    expect(peopleJoiningAfterOpening(LEAD, [SAM, LEAD], new Set())).toEqual([LEAD, SAM]);
  });

  it('structured, prompt or assistant-joined workflow with person-joined declared: the join addresses nobody, so the lead\'s one welcome is person-joined\'s', async () => {
    const w = world();
    // The join runs `opening-and-subject` with no subject (the router passes none where person-joined owns arrivals).
    await runEventWorkflow('opening-and-subject', OPENING_AND_SUBJECT, { event: 'assistant-joined', channelArn: CHANNEL, values: {} },
      w.deps('assistant-joined', eventRunKey('assistant-joined', eventNaturalKey('assistant-joined', CHANNEL)!, 'ops')));
    for (const p of peopleJoiningAfterOpening(LEAD, [SAM], new Set())) {
      await runEventWorkflow('joined', JOINED, { event: 'person-joined', channelArn: CHANNEL, eventPerson: p, values: {} },
        w.deps('person-joined', eventRunKey('person-joined', eventNaturalKey('person-joined', CHANNEL, p)!, 'ops')));
    }
    expect(w.addressed.get(LEAD)).toEqual(['person-joined:workflow-subject-welcome']);
    expect(w.addressed.get(SAM)).toEqual(['person-joined:workflow-subject-welcome']);
    expect(w.room).toEqual(['assistant-joined:workflow-opening']);
  });

  it('a person a run welcomed is sent no memberWelcome, so a failed naming still leaves exactly one welcome each', async () => {
    const said: string[] = [];
    await welcomeIntoOpenedConversation({
      classification: 'premium', channelArn: CHANNEL, botArn: BOT, leadArn: LEAD, people: [SAM], topicLabel: 'API latency',
      welcomedByRun: new Set([SAM]),
    }, { say: async (_c, n) => { said.push(...n.to); return { posted: true }; } });
    expect(said).toEqual([LEAD]);
  });
});

describe('the router and the creator honor the owner (ADR-061 decision 5)', () => {
  const router = read('router-agent-handler.ts');
  const join = router.slice(router.indexOf("if (lexIntentName === 'WelcomeIntent'"), router.indexOf('// A PERSON OF ANOTHER ISSUER'));

  it('the join reads the owner from configuration before it starts an intake', () => {
    const owner = join.indexOf('const arrivals = arrivalWelcomeOwner({ conversationType: welcomeTypeKey, own: loaded.served?.version.eventWorkflows });');
    expect(owner).toBeGreaterThan(-1);
    expect(owner).toBeLessThan(join.indexOf('startIntake('));
  });

  it('conversation-opened: the join posts nothing and starts no intake', () => {
    const silent = join.indexOf("if (channelArn && arrivals === 'conversation-opened') return formatLexNothingToPost(event);");
    expect(silent).toBeGreaterThan(-1);
    expect(silent).toBeLessThan(join.indexOf('startIntake('));
  });

  it('person-joined: no intake starts, and an assistant-joined workflow runs with no subject', () => {
    expect(join).toMatch(/if \(isOnboardingEnabled\(intakeConfig\) && arrivals === 'person-joined'\) \{\n\s+console\.log\([^)]*no intake starts here'\);\n\s+\} else if \(isOnboardingEnabled\(intakeConfig\) && workflowOwnsIntake\) \{[\s\S]{0,200}\} else if \(isOnboardingEnabled\(intakeConfig\)\) \{/);
    expect(join).toMatch(/subject: participants\.subject && arrivals !== 'person-joined' \? userArnFor\(/);
    // The room's opening is still said in the structured and prompt modes: the return below is unconditional.
    expect(join).toContain("return formatLexResponse(event, [{ contentType: 'PlainText', content: withTurnDeclaration(welcome.content, { kind: 'welcome' }) }]);");
  });

  it('the opening run returns the lead it owns, and the creator names everyone else in person-joined', () => {
    const opened = router.slice(router.indexOf('export async function handleConversationOpened('), router.indexOf('async function noticeSelection('));
    expect(opened).toMatch(/return \{ ran: out\.ran, \.\.\.\(out\.ran \? \{ people: \[personArn\] \} : \{\}\) \};/);
    const creator = read('typed-conversation-from-event.ts');
    expect(creator).toMatch(/const ownedByOpening = new Set\(opened\.people \?\? \[\]\);/);
    expect(creator).toMatch(/personJoinedThroughRouter\(DEPLOYED_CLASSIFICATION, created\.channelArn, peopleJoiningAfterOpening\(forUserArn, humans, ownedByOpening\)\)/);
    expect(creator.indexOf('nameEventThroughRouter(DEPLOYED_CLASSIFICATION')).toBeLessThan(creator.indexOf('personJoinedThroughRouter('));
  });
});
