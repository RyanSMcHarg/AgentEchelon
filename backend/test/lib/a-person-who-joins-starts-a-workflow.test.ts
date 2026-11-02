/**
 * A PERSON WHO JOINS STARTS A WORKFLOW (ADR-061 decision 1, `person-joined`; decisions 3 and 5).
 *
 * What it proves, as ADR-061 "What proves it" lists for `person-joined`: the event is named by each path that adds a
 * person (the creator, the share and the add-member path) once the membership exists; the router verifies each person
 * against the live roster and starts no run for a person who is not a member; each person is a run of their own, keyed
 * by the conversation and the person, so a redelivered add starts nothing twice; a version declares at most one
 * workflow on the event and no welcome names it; where a run owns a person's welcome, the source sends no
 * `memberWelcome` and the share dispatches no join recap, and the run's targeted send carries the email the welcome
 * carried; where the version declares none, each source welcomes as it did before the event existed.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  EVENT_WORKFLOW_EVENTS,
  eventNaturalKey,
  eventRunKey,
  eventWorkflowErrors,
  personJoinedWorkflowOf,
  withJoinRecap,
  runEventWorkflow,
  verifiedJoiners,
  versionEventWorkflowsErrors,
  workflowSendEmailKind,
  welcomeWorkflowOf,
  type EventRunContext,
  type EventRunDeps,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { welcomeWorkflowErrors } from '../../lambda/src/lib/profile-lifecycle';
import { welcomeIntoOpenedConversation } from '../../lambda/src/lib/typed-conversation-notice';
import { EVENT_FIELDS } from '../../lambda/src/lib/variables';

const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((args) => ({ __type: 'Invoke', input: args })),
  InvocationType: { Event: 'Event', RequestResponse: 'RequestResponse' },
}));

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const APP = 'arn:aws:chime:us-east-1:1:app-instance/ai';
const CHANNEL = `${APP}/channel/ch-1`;
const DANA = `${APP}/user/dana`;
const SAM = `${APP}/user/sam`;
const BOT = `${APP}/bot/advisor`;

/** A version's own workflow on `person-joined`: a private greeting, then a catch-up turn, both to the person who joined. */
const JOINED: EventWorkflow = {
  on: 'person-joined',
  initial: 'greet',
  states: {
    greet: { send: { to: 'joined', template: 'workflow-subject-welcome', mention: { name: 'event:person' } }, onSuccess: 'catch-up', onFailure: 'done' },
    'catch-up': {
      agent: {
        prompt: 'join-recap',
        to: 'joined',
        deadlineMs: 20_000,
        fallback: { send: { to: 'joined', template: 'workflow-subject-welcome', mention: { name: 'event:person' } } },
      },
      onSuccess: 'done',
      onFailure: 'done',
    },
    done: { disposition: 'success' },
  },
};

describe('validation (ADR-061 decisions 1 and 3)', () => {
  it('person-joined is a built event, and its person is a declared platform-trust event field', () => {
    expect(EVENT_WORKFLOW_EVENTS).toContain('person-joined');
    expect(EVENT_FIELDS.find((f) => f.event === 'person-joined' && f.field === 'person')).toMatchObject({ computedByPlatform: true, describesPerson: true, type: 'person-list' });
    expect(eventWorkflowErrors('joined', JOINED)).toEqual([]);
  });

  it('the joined audience and the event:person mention exist only where the event names a person', () => {
    const onJoin = clone(JOINED);
    (onJoin.states.greet.send as { to: unknown }).to = { people: 'event:person' };
    expect(eventWorkflowErrors('joined', onJoin)).toEqual([]);
    const atWelcome = clone(JOINED);
    atWelcome.on = 'assistant-joined';
    const errs = eventWorkflowErrors('joined', atWelcome);
    expect(errs).toEqual(expect.arrayContaining([
      expect.stringMatching(/greet\.send\.to is joined, which only person-joined carries/),
      expect.stringMatching(/greet\.send\.mention\.name binds event:person, which only conversation-opened, person-joined, invitation-sent, invitation-unredeemed carry/),
    ]));
  });

  it('the opening of a person-joined workflow is a platform send: the person who arrived waits on no model', () => {
    const agentFirst = clone(JOINED);
    agentFirst.initial = 'catch-up';
    expect(eventWorkflowErrors('joined', agentFirst)).toEqual([expect.stringMatching(/initial must be a send/)]);
  });

  it('a version declares at most one workflow on person-joined, and that is the one the event runs', () => {
    expect(versionEventWorkflowsErrors({ a: JOINED, b: clone(JOINED) })).toEqual([expect.stringMatching(/declares 2 workflows on person-joined \(a, b\); a version declares at most one/)]);
    // The version's own, with the join recap after its steps (`withJoinRecap`), which owns the welcome; with none, the
    // platform's recap, which owns nobody's welcome.
    expect(personJoinedWorkflowOf({ welcome: { ...clone(JOINED), on: 'assistant-joined' }, joined: JOINED })).toEqual({ name: 'joined', workflow: withJoinRecap(JOINED), declared: true });
    expect(personJoinedWorkflowOf({})).toMatchObject({ name: 'join-recap', declared: false });
    expect(personJoinedWorkflowOf(undefined)).toMatchObject({ name: 'join-recap', declared: false });
  });

  it('a person-joined workflow is selected by its event, never as the welcome', () => {
    expect(welcomeWorkflowErrors({ modelKey: 'x', eventWorkflows: { joined: JOINED } } as never)).toEqual([]);
    expect(welcomeWorkflowOf({ joined: JOINED }, undefined)).toMatchObject({ name: 'welcome', declared: false });
  });

  it('a person-joined agent step\'s tools are the assistant\'s own', () => {
    const withTool = clone(JOINED);
    withTool.states['catch-up'].agent!.tools = ['read_deployment_health'];
    expect(welcomeWorkflowErrors({ modelKey: 'x', tools: ['load_company_context'], eventWorkflows: { joined: withTool } } as never))
      .toEqual([expect.stringMatching(/eventWorkflows\.joined, whose step catch-up uses read_deployment_health, which this assistant's tools do not include/)]);
  });
});

describe('a run per person (ADR-061 decision 5)', () => {
  it('the natural key is the conversation and the person, so two people are two runs and a person-less naming is none', () => {
    expect(eventNaturalKey('person-joined', CHANNEL, DANA)).toBe('ch-1#dana');
    expect(eventNaturalKey('person-joined', CHANNEL, SAM)).toBe('ch-1#sam');
    expect(eventNaturalKey('person-joined', CHANNEL)).toBeUndefined();
    expect(eventNaturalKey('assistant-joined', CHANNEL)).toBe('ch-1');
    expect(eventNaturalKey('conversation-opened', CHANNEL, DANA)).toBe('ch-1');
    expect(eventRunKey('person-joined', 'ch-1#dana', 'advisor')).toBe('person-joined#ch-1#dana#advisor');
  });

  it('a person the live roster does not hold as a person starts no run', () => {
    const roster = [{ arn: DANA }, { arn: BOT, isBot: true }];
    expect(verifiedJoiners([DANA, SAM, BOT, DANA], roster)).toEqual([DANA]);
    expect(verifiedJoiners([SAM], roster)).toEqual([]);
  });

  /** A claim store with DynamoDB's put-if-absent semantics, keyed by run. */
  const taken = new Set<string>();
  function deps(person: string) {
    const key = eventRunKey('person-joined', eventNaturalKey('person-joined', CHANNEL, person)!, 'advisor');
    const sent: Array<{ template: string; to: string[]; values: Record<string, string> }> = [];
    const dispatched: string[] = [];
    const d: EventRunDeps = {
      claimRun: async () => (taken.has(key) ? false : (taken.add(key), true)),
      claimStep: async (step) => (taken.has(`${key}#${step}`) ? false : (taken.add(`${key}#${step}`), true)),
      mentionName: async (arn) => (arn === DANA ? 'Dana' : 'Sam'),
      send: async (a) => { sent.push({ template: a.template, to: a.to, values: a.values }); return true; },
      dispatchAgent: async (step) => { dispatched.push(step); return true; },
    };
    return { d, sent, dispatched };
  }
  const ctx = (person: string): EventRunContext => ({ event: 'person-joined', channelArn: CHANNEL, eventPerson: person, values: {} });

  it('greets the person who joined privately, by name, then hands the catch-up turn over', async () => {
    const { d, sent, dispatched } = deps(DANA);
    const out = await runEventWorkflow('joined', JOINED, ctx(DANA), d);
    expect(out.ran).toBe(true);
    expect(sent).toEqual([{ template: 'workflow-subject-welcome', to: [DANA], values: { name: 'Dana' } }]);
    expect(dispatched).toEqual(['catch-up']);
  });

  it('a redelivered add starts no second run, and a second person added is a run of their own', async () => {
    const again = deps(DANA);
    expect((await runEventWorkflow('joined', JOINED, ctx(DANA), again.d)).ran).toBe(false);
    expect(again.sent).toEqual([]);
    const sam = deps(SAM);
    expect((await runEventWorkflow('joined', JOINED, ctx(SAM), sam.d)).ran).toBe(true);
    expect(sam.sent.map((s) => s.to)).toEqual([[SAM]]);
  });
});

describe('the welcome a run replaces is replaced whole (ADR-061 decisions 3 and 5)', () => {
  it('a send addressed to a person at an event that adds them is emailed as conversation-shared; a room send and the welcome are not', () => {
    expect(workflowSendEmailKind('person-joined', [DANA])).toBe('conversation-shared');
    expect(workflowSendEmailKind('conversation-opened', [DANA])).toBe('conversation-shared');
    expect(workflowSendEmailKind('person-joined', [])).toBeUndefined();
    expect(workflowSendEmailKind('assistant-joined', [DANA])).toBeUndefined();
  });

  it('the router\'s send carries the notify directive for that email, its subject the template\'s own', () => {
    const router = read('router-agent-handler.ts');
    const send = router.slice(router.indexOf('async function sayWorkflowSend('), router.indexOf('async function sendLanguages('));
    // A task step's send names its own kind (ADR-063 decision C2); every other send's kind is the event's rule.
    expect(send).toMatch(/const kind = args\.emailKind && args\.to\.length \? args\.emailKind : workflowSendEmailKind\(args\.event, args\.to\);/);
    expect(send).toMatch(/rendered\.sections\['email\.subject'\]/);
    expect(send).toMatch(/notifyDirective\(\{ \.\.\.\(subject \? \{ subject \} : \{\}\), targets: args\.to, kind, conversationId: conversationKey\(args\.channelArn\) \}\)/);
  });

  it('a creation sends no separate welcome to a person whose run welcomed them, and still welcomes the rest', async () => {
    const said: string[] = [];
    const out = await welcomeIntoOpenedConversation({
      classification: 'premium', channelArn: CHANNEL, botArn: BOT, leadArn: DANA, people: [SAM], topicLabel: 'API latency',
      welcomedByRun: new Set([DANA]),
    }, { say: async (_c, n) => { said.push(...n.to); return { posted: true }; } });
    expect(said).toEqual([SAM]);
    expect(out).toEqual({ said: 1, notSaid: 0 });
  });
});

describe('where it is named, and verified (ADR-061 decision 1)', () => {
  const router = read('router-agent-handler.ts');

  it('person-joined is verified before anything runs: the classification, the primary, the declared workflow, then the live roster', () => {
    const fn = router.slice(router.indexOf('export async function handlePersonJoined('), router.indexOf('export async function handleConversationOpened('));
    const order = ['resolveChannelClassificationTag(channelArn)', 'primaryAssistantOf(', 'servedWelcomeVersion(', 'personJoinedWorkflowOf(', 'resolveChannelSize(', 'verifiedJoiners(', 'runWorkflowFor('].map((t) => fn.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The people a run owns are the verified members, never the people the payload named.
    expect(fn).toMatch(/return \{ ran, people: declared \? members : \[\], recapped: members \};/);
    // A refused person is logged by count and conversation, never by who they are.
    expect(fn).toMatch(/refused: named\.length - members\.length, channelArn, classification: STATIC_CLASSIFICATION/);
  });

  it('a hand-back after a person-joined agent step recomputes its run key with the person', () => {
    const fn = router.slice(router.indexOf('export async function handleEventContinuation('), router.indexOf('async function sayWorkflowSend('));
    expect(fn).toMatch(/const naturalKey = eventNaturalKey\(wf\.on, channelArn, person\(req\.eventPerson\), str\(req\.invitationId\), alarm\);/);
    expect(fn).toMatch(/const runKey = eventRunKey\(wf\.on, naturalKey, assistant\.profile\.name\);/);
  });

  it('two people\'s agent steps are two turns: the dispatch is correlated by the natural key', () => {
    expect(router).toMatch(/correlationId: eventDispatchId\('event', \[args\.event, eventNaturalKey\(args\.event, channelArn, args\.eventPerson, args\.invitationId, args\.alarm\) \?\? conversationKey\(channelArn\), args\.step, botIdFromArn\(botArn\)\]\)/);
  });

  it('the share, the add-member path and the creator each name it once the membership exists, and welcome only the people no run owns', () => {
    const share = fs.readFileSync(path.join(SRC, '..', 'share-conversation', 'index.js'), 'utf8');
    const named = share.indexOf('personJoinedThroughRouter(channelTier, conversationArn, [recipientUserArn])');
    expect(named).toBeGreaterThan(share.indexOf('new CreateChannelMembershipCommand('));
    expect(named).toBeLessThan(share.indexOf('await dispatchJoinRecapTurn('));
    expect(named).toBeLessThan(share.indexOf("kind: 'memberWelcome'"));

    const management = read('conversation-management.ts');
    const add = management.slice(management.indexOf('async function addContextMemberFor('));
    const event = add.indexOf('personJoinedThroughRouter(CONTEXT_CLASSIFICATION, conversationArn, [userArn])');
    expect(event).toBeGreaterThan(add.indexOf('addContextMember({'));
    expect(event).toBeLessThan(add.indexOf("kind: 'memberWelcome'"));
    expect(add.slice(event, add.indexOf("kind: 'memberWelcome'"))).toMatch(/\.has\(userArn\)\) \{\n\s+return \{ ok: true/);

    const creator = read('typed-conversation-from-event.ts');
    expect(creator).toMatch(/personJoinedThroughRouter\(DEPLOYED_CLASSIFICATION, created\.channelArn, peopleJoiningAfterOpening\(forUserArn, humans, ownedByOpening\)\)/);
    expect(creator).toMatch(/welcomedByRun: joinedRun,/);
  });
});

describe('naming the event through the router (ADR-061 decision 1)', () => {
  const ROUTER = 'arn:aws:lambda:us-east-1:1:function:premium-router';
  beforeEach(async () => {
    mockLambdaSend.mockReset();
    const { routerArnEnvName } = await import('../../lambda/src/lib/router-arn');
    process.env[routerArnEnvName('premium')] = ROUTER;
  });
  const answer = (body: unknown) => mockLambdaSend.mockResolvedValueOnce({ Payload: Buffer.from(JSON.stringify(body)) });

  it('names every person one add admitted in one invoke of the classification\'s router, and returns the people a run owns', async () => {
    const { personJoinedThroughRouter } = await import('../../lambda/src/lib/say-through-router');
    answer({ ran: true, people: [DANA, 'arn:aws:chime:us-east-1:1:app-instance/ai/user/someone-not-named'] });
    const owned = await personJoinedThroughRouter('premium', CHANNEL, [DANA, SAM, DANA, BOT]);
    expect([...owned]).toEqual([DANA]);
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    const call = mockLambdaSend.mock.calls[0][0];
    expect(call.input).toMatchObject({ FunctionName: ROUTER, InvocationType: 'RequestResponse' });
    expect(JSON.parse(Buffer.from(call.input.Payload).toString())).toEqual({ aeEvent: { event: 'person-joined', channelArn: CHANNEL, personArns: [DANA, SAM] } });
  });

  it('a router that fails, errors or declares no workflow owns nobody, so the source welcomes as before', async () => {
    const { personJoinedThroughRouter } = await import('../../lambda/src/lib/say-through-router');
    answer({ ran: false, reason: 'no workflow', people: [] });
    expect([...await personJoinedThroughRouter('premium', CHANNEL, [DANA])]).toEqual([]);
    mockLambdaSend.mockResolvedValueOnce({ FunctionError: 'Unhandled' });
    expect([...await personJoinedThroughRouter('premium', CHANNEL, [DANA])]).toEqual([]);
    mockLambdaSend.mockRejectedValueOnce(new Error('throttled'));
    expect([...await personJoinedThroughRouter('premium', CHANNEL, [DANA])]).toEqual([]);
    expect([...await personJoinedThroughRouter('premium', CHANNEL, [])]).toEqual([]);
  });
});
