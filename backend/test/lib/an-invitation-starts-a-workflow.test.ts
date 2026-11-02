/**
 * AN INVITATION STARTS A WORKFLOW (ADR-061 decision 1, `invitation-sent`; decisions 3, 5 and 8).
 *
 * What it proves, as ADR-061 "What proves it" lists for `invitation-sent`: the invitations function names the event,
 * by ids alone, once the invitation's `Tokens` record is written; the router reads that record and starts nothing for
 * an invitation that does not exist, belongs to another conversation or classification, or is redeemed, revoked or
 * expired; the invitee, the inviter and the reason come from the record, never from the payload; a run is keyed by the
 * invitation, so a redelivered naming starts nothing twice; a version declares at most one workflow on the event and no
 * welcome names it; the event is not an arrival, so its workflow may open with an agent step, and an agent step written
 * for the invitee, who is not reading the room, is refused; and the invitation sends one email, the invitations
 * function's transactional one, because a workflow's send at this event emails nobody.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  ARRIVAL_EVENTS,
  EVENT_WORKFLOW_EVENTS,
  EVENTS_NAMING_A_PERSON,
  declaredWorkflowOn,
  eventNaturalKey,
  eventRunKey,
  eventWorkflowErrors,
  runEventWorkflow,
  versionEventWorkflowsErrors,
  workflowSendEmailKind,
  type EventRunContext,
  type EventRunDeps,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { welcomeWorkflowErrors } from '../../lambda/src/lib/profile-lifecycle';
import { EVENT_FIELDS, FIXED_SOURCES, buildSourceTable, sourceLookup, whenErrors } from '../../lambda/src/lib/variables';
import { INVITATIONS_BY_CHANNEL, INVITATION_CHANNEL_ATTRIBUTE, INVITATION_RECORD_ATTRIBUTES, everyInvitation, findInvitation, pendingInvitation } from '../../lambda/src/lib/invitations';
import { DIRECTIVE_NOTICE_KINDS } from '../../lambda/src/lib/notify-directive';
import { NOTICE_KINDS } from '../../lambda/src/lib/notice-preferences';
import { assistantsOf } from '../helpers/assistants';
import { CLASSIFICATION_TEST_PROPS } from '../helpers/synth';

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
const INVITEE = `${APP}/user/jordan`;
const INVITER = `${APP}/user/riley`;
const ID = '0b7f2a52-0000-4000-8000-000000000001';

/** A version's own workflow on `invitation-sent`: the room is told, the inviter is told privately, then a look at the room. */
const SENT: EventWorkflow = {
  on: 'invitation-sent',
  initial: 'tell-room',
  states: {
    'tell-room': { send: { to: 'room', template: 'workflow-opening', mention: { who: 'event:person', by: 'invitation:inviter' } }, onSuccess: 'tell-inviter', onFailure: 'done' },
    'tell-inviter': { send: { to: { people: 'invitation:inviter' }, template: 'workflow-subject-welcome', mention: { name: 'invitation:inviter' } }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
};

describe('validation (ADR-061 decisions 1, 3 and 8)', () => {
  it('invitation-sent is a built event that names the invitee, and is not an arrival', () => {
    expect(EVENT_WORKFLOW_EVENTS).toContain('invitation-sent');
    expect(EVENTS_NAMING_A_PERSON).toContain('invitation-sent');
    expect(ARRIVAL_EVENTS).not.toContain('invitation-sent');
    expect(EVENT_FIELDS.find((f) => f.event === 'invitation-sent')).toMatchObject({ field: 'person', type: 'person-list', computedByPlatform: true });
    expect(eventWorkflowErrors('sent', SENT)).toEqual([]);
  });

  it('the invitation\'s people are platform-trust person-lists and its reason is member text, each only at an invitation\'s events', () => {
    const INVITATION = ['invitation-sent', 'invitation-unredeemed'];
    expect(FIXED_SOURCES['invitation:inviter']).toMatchObject({ type: 'person-list', trust: 'platform', events: INVITATION });
    expect(FIXED_SOURCES['invitation:invitee']).toMatchObject({ type: 'person-list', trust: 'platform', events: INVITATION });
    expect(FIXED_SOURCES['invitation:reason']).toMatchObject({ type: 'string', trust: 'member', describesPerson: true, events: INVITATION });
    const lookup = sourceLookup(buildSourceTable({ catalog: [] }));
    expect(whenErrors({ 'invitation:reason': 'budget' }, lookup, { event: 'invitation-sent', selects: 'addressed' }).join()).toMatch(/member text/);
    expect(whenErrors({ 'invitation:inviter': { op: 'exists' } } as never, lookup, { event: 'person-joined', selects: 'addressed' }).join()).toMatch(/exists only at invitation-sent/);
    expect(whenErrors({ 'invitation:inviter': { op: 'exists' } } as never, lookup, { event: 'invitation-sent', selects: 'addressed' })).toEqual([]);
    // THE ROLE AN INVITATION RECORDS is a closed enum of the names a type declares invitable, at invitation-sent only.
    expect(lookup('invitation:role')).toMatchObject({ type: 'enum', trust: 'closed-enum', describesPerson: false, events: ['invitation-sent', 'invitation-unredeemed'] });
    expect(whenErrors({ 'invitation:role': 'lead' } as never, lookup, { event: 'person-joined', selects: 'addressed' }).join()).toMatch(/exists only at invitation-sent/);
  });

  it('the inviter is an audience and a mention only at an invitation\'s events', () => {
    const atJoin = clone(SENT) as unknown as Record<string, any>;
    atJoin.on = 'person-joined';
    const errs = eventWorkflowErrors('x', atJoin).join('\n');
    expect(errs).toMatch(/tell-inviter\.send\.to names invitation:inviter, which only invitation-sent and invitation-unredeemed carry/);
    expect(errs).toMatch(/mention\.by binds invitation:inviter, which only invitation-sent and invitation-unredeemed carry/);
  });

  it('nobody is waiting on an invitation, so its workflow may open with an agent step, written for the room or the inviter', () => {
    const look: EventWorkflow = {
      on: 'invitation-sent',
      initial: 'look',
      states: {
        look: {
          agent: { prompt: 'join-recap', to: { people: 'invitation:inviter' }, deadlineMs: 15_000, fallback: { send: { to: { people: 'invitation:inviter' }, template: 'workflow-subject-welcome' } } },
          onSuccess: 'done', onFailure: 'done',
        },
        done: { disposition: 'success' },
      },
    };
    expect(eventWorkflowErrors('look', look)).toEqual([]);
    // The same opening on an arrival event is refused: the people who arrived wait on no model.
    expect(eventWorkflowErrors('look', { ...clone(look), on: 'person-joined', states: { ...clone(look).states, look: { ...clone(look).states.look, agent: { ...look.states.look.agent!, to: 'joined', fallback: { send: { to: 'joined', template: 'workflow-subject-welcome' } } } } } }).join())
      .toMatch(/initial must be a send/);
  });

  it('an agent step addressed to the invitee, who reads nothing in the room, is refused; a reminder reaches them as a proposal (decision 8, rule 6)', () => {
    const forInvitee: EventWorkflow = {
      on: 'invitation-sent',
      initial: 'brief',
      states: {
        brief: {
          agent: { prompt: 'join-recap', to: { people: 'event:person' }, deadlineMs: 15_000, fallback: { send: { to: { people: 'event:person' }, template: 'workflow-subject-welcome' } } },
          onSuccess: 'done', onFailure: 'done',
        },
        done: { disposition: 'success' },
      },
    };
    expect(eventWorkflowErrors('brief', forInvitee).join()).toMatch(/names the invitee, who reads nothing in the conversation until they redeem the invitation; address the inviter, and propose send_nudge/);
  });

  it('a version declares at most one workflow on invitation-sent, and its event selects it', () => {
    expect(versionEventWorkflowsErrors({ a: SENT, b: SENT }).join()).toMatch(/declares 2 workflows on invitation-sent \(a, b\); a version declares at most one/);
    expect(declaredWorkflowOn({ sent: SENT }, 'invitation-sent')).toEqual({ name: 'sent', workflow: SENT });
    expect(declaredWorkflowOn({ sent: SENT }, 'person-joined')).toBeUndefined();
    expect(declaredWorkflowOn({ sent: SENT }, 'assistant-joined')).toBeUndefined();
    expect(welcomeWorkflowErrors({ eventWorkflows: { sent: SENT } } as never)).toEqual([]);
  });
});

describe('a run per invitation (ADR-061 decision 5)', () => {
  it('the natural key is the invitation, so two invitations are two runs and a naming with no invitation is none', () => {
    expect(eventNaturalKey('invitation-sent', CHANNEL, INVITEE, ID)).toBe(`invitation-${ID}`);
    expect(eventNaturalKey('invitation-sent', CHANNEL, INVITEE)).toBeUndefined();
    expect(eventNaturalKey('invitation-sent', CHANNEL, INVITEE, 'not/an#id')).toBeUndefined();
    expect(eventRunKey('invitation-sent', `invitation-${ID}`, 'advisor')).toBe(`invitation-sent#invitation-${ID}#advisor`);
  });

  const taken = new Set<string>();
  function deps() {
    const key = eventRunKey('invitation-sent', eventNaturalKey('invitation-sent', CHANNEL, INVITEE, ID)!, 'advisor');
    const sent: Array<{ template: string; to: string[]; values: Record<string, string> }> = [];
    const greeted: string[] = [];
    const d: EventRunDeps = {
      claimRun: async () => (taken.has(key) ? false : (taken.add(key), true)),
      claimStep: async (step) => (taken.has(`${key}#${step}`) ? false : (taken.add(`${key}#${step}`), true)),
      mentionName: async (arn) => (arn === INVITEE ? 'Jordan' : arn === INVITER ? 'Riley' : ''),
      send: async (a) => { sent.push({ template: a.template, to: a.to, values: a.values }); return true; },
      dispatchAgent: async () => true,
      greeted: async (arn) => { greeted.push(arn); },
    };
    return { d, sent, greeted };
  }
  const ctx: EventRunContext = { event: 'invitation-sent', channelArn: CHANNEL, eventPerson: INVITEE, invitationId: ID, inviter: INVITER, values: {} };

  it('tells the room who was invited and by whom, tells the inviter privately, and records no greeting', async () => {
    const { d, sent, greeted } = deps();
    expect((await runEventWorkflow('sent', SENT, ctx, d)).ran).toBe(true);
    expect(sent).toEqual([
      { template: 'workflow-opening', to: [], values: { who: 'Jordan', by: 'Riley' } },
      { template: 'workflow-subject-welcome', to: [INVITER], values: { name: 'Riley' } },
    ]);
    // Naming an invitee or an inviter in the room greets neither: their first turn still greets them by name.
    expect(greeted).toEqual([]);
  });

  it('a redelivered naming of the same invitation starts no second run', async () => {
    const again = deps();
    expect((await runEventWorkflow('sent', SENT, ctx, again.d)).ran).toBe(false);
    expect(again.sent).toEqual([]);
  });
});

describe('one email per invitation (ADR-061 decision 3)', () => {
  it('a workflow\'s send at invitation-sent emails nobody; the arrival events still email the person they welcome', () => {
    expect(workflowSendEmailKind('invitation-sent', [INVITEE])).toBeUndefined();
    expect(workflowSendEmailKind('invitation-sent', [INVITER])).toBeUndefined();
    expect(workflowSendEmailKind('person-joined', [INVITEE])).toBe('conversation-shared');
  });

  it('the invitation email stays transactional: the directive admits only kinds a person can mute, and invitation is not one', () => {
    expect(NOTICE_KINDS.invitation).toEqual({ transactional: true });
    expect(DIRECTIVE_NOTICE_KINDS).not.toContain('invitation');
    for (const k of DIRECTIVE_NOTICE_KINDS) expect((NOTICE_KINDS as Record<string, { transactional?: boolean }>)[k]?.transactional).not.toBe(true);
    // The invitations function sends it, and names the event after it, by ids.
    const fn = read('invitations.ts');
    const create = fn.slice(fn.indexOf('export async function createInvitation('), fn.indexOf('// ── LIST AND REVOKE'));
    expect(create.indexOf('sendInvitationEmail(')).toBeGreaterThan(create.indexOf('putToken('));
    expect(create.indexOf('invitationSentThroughRouter)(facts.classification, channelArn, record.invitationId, record.pk)')).toBeGreaterThan(create.indexOf('sendInvitationEmail('));
  });
});

describe('the router verifies the invitation against its record (ADR-061 decision 1)', () => {
  const NOW = 1_800_000_000;
  const base = {
    pk: 'invitation#abc', kind: 'invitation', channelArn: CHANNEL, personArn: INVITEE, invitationId: ID, inviterArn: INVITER,
    inviterName: 'Riley', inviteeName: 'Jordan', mode: 'sign-in', classification: 'standard', conversationType: 'general',
    conversationName: 'Plan', expiresAt: NOW + 3600, reason: 'to review the budget', [INVITATION_CHANNEL_ATTRIBUTE]: CHANNEL,
  };
  const docOf = (items: Array<Record<string, unknown>>) => ({
    send: async (cmd: any) => {
      expect(cmd.constructor.name).toBe('QueryCommand');
      expect(cmd.input.IndexName).toBe(INVITATIONS_BY_CHANNEL);
      return { Items: items.filter((r) => r[INVITATION_CHANNEL_ATTRIBUTE] === cmd.input.ExpressionAttributeValues[':c']) };
    },
  });

  it('a pending invitation of this conversation at this classification is the one a run is for', async () => {
    const out = await pendingInvitation(docOf([base]), 'Tokens', CHANNEL, ID, 'standard', NOW);
    expect(out).toEqual({ record: base });
  });

  it.each([
    ['an id this conversation holds no invitation for', [base], 'other-id', 'standard', 'unknown'],
    ['another conversation\'s invitation', [{ ...base, channelArn: `${APP}/channel/other`, [INVITATION_CHANNEL_ATTRIBUTE]: `${APP}/channel/other` }], ID, 'standard', 'unknown'],
    ['a record that names another conversation under this index key', [{ ...base, channelArn: `${APP}/channel/other` }], ID, 'standard', 'unknown'],
    ['another classification\'s invitation', [base], ID, 'premium', 'another classification'],
    ['a redeemed invitation', [{ ...base, consumedAt: NOW - 1 }], ID, 'standard', 'redeemed'],
    ['a revoked invitation', [{ ...base, revokedAt: NOW - 1 }], ID, 'standard', 'revoked'],
    ['an expired invitation', [{ ...base, expiresAt: NOW }], ID, 'standard', 'expired'],
  ])('refuses %s', async (_label, items, id, classification, refused) => {
    expect(await pendingInvitation(docOf(items), 'Tokens', CHANNEL, id, classification, NOW)).toEqual({ refused });
  });

  // A RECORD WRITTEN A MOMENT AGO: the base table holds it, and the eventually consistent index does not show it yet.
  const KEY = `invitation#${'a'.repeat(64)}`;
  const freshDoc = (item: Record<string, unknown> | undefined) => {
    const calls: any[] = [];
    return {
      calls,
      send: async (cmd: any) => {
        calls.push(cmd);
        if (cmd.constructor.name === 'QueryCommand') return { Items: [] };
        expect(cmd.constructor.name).toBe('GetCommand');
        return { Item: cmd.input.Key.pk === KEY ? item : undefined };
      },
    };
  };

  it('a just-written invitation named with its key is read by that key, strongly consistent, and verifies', async () => {
    const doc = freshDoc({ ...base, pk: KEY });
    const out = await pendingInvitation(doc, 'Tokens', CHANNEL, ID, 'standard', NOW, KEY);
    expect(out).toEqual({ record: { ...base, pk: KEY } });
    expect(doc.calls).toHaveLength(1);
    expect(doc.calls[0].input).toMatchObject({ Key: { pk: KEY }, ConsistentRead: true });
    // Only the attributes verifying needs, the ones the router's grant names.
    expect(Object.values(doc.calls[0].input.ExpressionAttributeNames).sort()).toEqual([...INVITATION_RECORD_ATTRIBUTES].sort());
    // Without the key the same moment's index read misses it, which is the refusal the key removes.
    expect(await pendingInvitation(freshDoc({ ...base, pk: KEY }), 'Tokens', CHANNEL, ID, 'standard', NOW)).toEqual({ refused: 'unknown' });
  });

  it('the key decides nothing: a record of another id, another conversation, or no invitation at all is refused', async () => {
    expect(await pendingInvitation(freshDoc({ ...base, pk: KEY, invitationId: 'other' }), 'Tokens', CHANNEL, ID, 'standard', NOW, KEY)).toEqual({ refused: 'unknown' });
    expect(await pendingInvitation(freshDoc({ ...base, pk: KEY, channelArn: `${APP}/channel/other` }), 'Tokens', CHANNEL, ID, 'standard', NOW, KEY)).toEqual({ refused: 'unknown' });
    expect(await pendingInvitation(freshDoc(undefined), 'Tokens', CHANNEL, ID, 'standard', NOW, KEY)).toEqual({ refused: 'unknown' });
    // A key that is not an invitation's reads nothing.
    const doc = freshDoc({ ...base, pk: KEY });
    expect(await pendingInvitation(doc, 'Tokens', CHANNEL, ID, 'standard', NOW, 'guest-refresh#x')).toEqual({ refused: 'unknown' });
    expect(doc.calls).toHaveLength(0);
  });

  // A CONVERSATION WITH MORE INVITATIONS THAN A PAGE: the one sought is on the last page.
  const pagedDoc = (pages: Array<Array<Record<string, unknown>>>) => ({
    send: async (cmd: any) => {
      const at = cmd.input.ExclusiveStartKey?.page ?? 0;
      const filter = cmd.input.FilterExpression ? cmd.input.ExpressionAttributeValues[':i'] : undefined;
      const items = filter ? pages[at].filter((r) => r.invitationId === filter) : pages[at];
      return { Items: items, ...(at + 1 < pages.length ? { LastEvaluatedKey: { page: at + 1 } } : {}) };
    },
  });
  const many = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ ...base, pk: `invitation#${from + i}`, invitationId: `id-${from + i}` }));

  it('an invitation behind more than 500 others is found: the index is read to its end', async () => {
    const pages = [many(500, 0), many(400, 500), [{ ...base }]];
    expect(await findInvitation(pagedDoc(pages), 'Tokens', CHANNEL, ID)).toEqual(base);
    expect(await pendingInvitation(pagedDoc(pages), 'Tokens', CHANNEL, ID, 'standard', NOW)).toEqual({ record: base });
  });

  it('every one of a conversation\'s invitations is listed, however many, so an archive cancels each one\'s deadline', async () => {
    const pages = [many(500, 0), many(500, 500), many(3, 1000)];
    expect((await everyInvitation(pagedDoc(pages), 'Tokens', CHANNEL)).length).toBe(1003);
  });

  const router = read('router-agent-handler.ts');

  it('invitation-sent is verified by the key its writer names, and the cancel path lists every invitation', () => {
    const fn = router.slice(router.indexOf('export async function handleInvitationSent('), router.indexOf('export async function handleDeadlineFired('));
    expect(fn).toMatch(/const invitationKey = typeof req\?\.invitationKey === 'string' \? req\.invitationKey : undefined;/);
    expect(fn).toMatch(/verifyInvitationEvent\(channelArn, invitationId, invitationKey\)/);
    expect(router).toMatch(/return everyInvitation\(invitationsDoc, INVITATIONS_TABLE, channelArn\);/);
    expect(router).not.toMatch(/listInvitations\([^)]*500\)/);
    expect(read('invitations.ts')).toMatch(/invitationSentThroughRouter\)\(facts\.classification, channelArn, record\.invitationId, record\.pk\)/);
  });

  it('verifies before anything runs: the classification, the record, the primary, then the declared workflow', () => {
    const fn = router.slice(router.indexOf('export async function handleInvitationSent('), router.indexOf('export async function handlePersonJoined('));
    const order = ['resolveChannelClassificationTag(channelArn)', 'verifyInvitationEvent(channelArn, invitationId, invitationKey)', 'primaryAssistantOf(', 'servedWelcomeVersion(', "declaredWorkflowOn(served?.version.eventWorkflows, 'invitation-sent')", 'runWorkflowFor('].map((t) => fn.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The people are the record's, never the payload's, which carries ids alone.
    expect(fn).toMatch(/eventPerson: record\.personArn, invitationId: record\.invitationId, inviter: record\.inviterArn/);
    expect(fn).not.toMatch(/req\.(personArn|inviter|eventPerson)/);
    // A refusal is logged by reason and conversation, never by person.
    expect(fn).toMatch(/refused: invitation\.refused, channelArn, classification: STATIC_CLASSIFICATION/);
  });

  it('a hand-back after an agent step reads the invitation again, and continues nothing for one that no longer matters', () => {
    const fn = router.slice(router.indexOf('export async function handleEventContinuation('), router.indexOf('async function sayWorkflowSend('));
    expect(fn).toMatch(/eventNaturalKey\(wf\.on, channelArn, person\(req\.eventPerson\), str\(req\.invitationId\), alarm\)/);
    expect(fn).toMatch(/isInvitationEvent\(wf\.on\) \? await verifyInvitationEvent\(channelArn, str\(req\.invitationId\)\)/);
    expect(fn).toMatch(/eventPerson: invitation\.record\.personArn, invitationId: invitation\.record\.invitationId, inviter: invitation\.record\.inviterArn/);
  });

  it('the reason is a value the resolver says only where its readers allow, never a run value a room send inserts as is', () => {
    const values = router.slice(router.indexOf('function eventSourceValues('), router.indexOf('async function routerGate('));
    expect(values).toMatch(/'invitation:reason': invitationReason/);
    const handler = router.slice(router.indexOf('export async function handleInvitationSent('), router.indexOf('export async function handlePersonJoined('));
    expect(handler).toMatch(/values: \{\},/);
  });

  it('the two agent steps of two invitations are two turns: the dispatch is correlated by the invitation', () => {
    expect(router).toMatch(/eventNaturalKey\(args\.event, channelArn, args\.eventPerson, args\.invitationId, args\.alarm\)/);
  });
});

describe('naming invitation-sent through the router (ADR-061 decision 1)', () => {
  const ROUTER = 'arn:aws:lambda:us-east-1:1:function:standard-router';
  beforeEach(async () => {
    mockLambdaSend.mockReset();
    const { routerArnEnvName } = await import('../../lambda/src/lib/router-arn');
    process.env[routerArnEnvName('standard')] = ROUTER;
  });

  it('invokes the classification\'s router asynchronously with the conversation and the invitation id alone', async () => {
    const { invitationSentThroughRouter } = await import('../../lambda/src/lib/say-through-router');
    mockLambdaSend.mockResolvedValueOnce({});
    expect(await invitationSentThroughRouter('standard', CHANNEL, ID)).toBe(true);
    const call = mockLambdaSend.mock.calls[0][0];
    expect(call.input).toMatchObject({ FunctionName: ROUTER, InvocationType: 'Event' });
    expect(JSON.parse(Buffer.from(call.input.Payload).toString())).toEqual({ aeEvent: { event: 'invitation-sent', channelArn: CHANNEL, invitationId: ID } });
  });

  it('carries the record\'s key, the token\'s hash and never the token, so the router reads the fresh record consistently', async () => {
    const { invitationSentThroughRouter } = await import('../../lambda/src/lib/say-through-router');
    mockLambdaSend.mockResolvedValueOnce({});
    const key = `invitation#${'b'.repeat(64)}`;
    expect(await invitationSentThroughRouter('standard', CHANNEL, ID, key)).toBe(true);
    const call = mockLambdaSend.mock.calls[0][0];
    expect(JSON.parse(Buffer.from(call.input.Payload).toString())).toEqual({ aeEvent: { event: 'invitation-sent', channelArn: CHANNEL, invitationId: ID, invitationKey: key } });
  });

  it('never throws: a refused invoke or a classification with no router reports nothing named', async () => {
    const { invitationSentThroughRouter } = await import('../../lambda/src/lib/say-through-router');
    mockLambdaSend.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await invitationSentThroughRouter('standard', CHANNEL, ID)).toBe(false);
    expect(await invitationSentThroughRouter('not-a-classification', CHANNEL, ID)).toBe(false);
  });
});

describe('IAM: the router reads an invitation and nothing else of the token store (deny test)', () => {
  type Resource = { Type: string; Properties?: Record<string, any> };
  const synth = (classification: string): Record<string, Resource> => {
    const app = new cdk.App();
    const stack = assistantsOf(classification)(app, `AgentEchelonAssistants-${classification}`, CLASSIFICATION_TEST_PROPS as never);
    return (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
  };
  const resources = synth('standard');
  const statements = Object.values(resources).flatMap((r) => (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy')
    ? (r.Properties?.PolicyDocument?.Statement ?? []).map((s: any) => ({ ...s, roles: JSON.stringify(r.Properties?.Roles ?? '') }))
    : []);
  // THE ROUTER'S statements on the token store; the processor's one write, a proposal, is deny-tested beside the
  // proposals (`a-proposal-is-applied-once-by-its-addressee.test.ts`).

  it('the router queries the sparse invitation index, reads an invitation by its key and only its verifying attributes, and writes nothing', () => {
    const verify = statements.filter((s: any) => s.Sid === 'VerifyAnInvitationEvent');
    expect(verify).toHaveLength(1);
    expect(verify[0].roles).toMatch(/AgentHandlerRole/);
    expect(verify[0].Action).toBe('dynamodb:Query');
    expect(JSON.stringify(verify[0].Resource)).toContain(`/index/${INVITATIONS_BY_CHANNEL}`);
    const byKey = statements.filter((s: any) => s.Sid === 'VerifyAJustWrittenInvitation');
    expect(byKey).toHaveLength(1);
    expect(byKey[0].roles).toMatch(/AgentHandlerRole/);
    expect(byKey[0].Action).toBe('dynamodb:GetItem');
    expect(byKey[0].Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['invitation#*'] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': [...INVITATION_RECORD_ATTRIBUTES] },
      StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    });
    // DENY: every statement of the router's on the store, found by the store's own ARN reference, is the index query or
    // that one keyed read; nothing writes, scans or reads another kind, and the keyed read names no attribute but the
    // ones verifying needs.
    const tokensRef = JSON.stringify(byKey[0].Resource).match(/"Ref":"([^"]+)"/)?.[1];
    expect(tokensRef).toBeTruthy();
    const onTokens = statements.filter((s: any) => JSON.stringify(s.Resource ?? '').includes(tokensRef!) && /AgentHandlerRole/.test(s.roles));
    expect(onTokens).toHaveLength(2);
    for (const s of onTokens) {
      for (const a of [s.Action].flat()) expect(['dynamodb:Query', 'dynamodb:GetItem']).toContain(a);
      if ([s.Action].flat().includes('dynamodb:Query')) expect(JSON.stringify(s.Resource)).toContain(`/index/${INVITATIONS_BY_CHANNEL}`);
    }
    expect(INVITATION_RECORD_ATTRIBUTES).not.toContain('emailed');
    expect(INVITATION_RECORD_ATTRIBUTES.some((a) => /token|secret|address|email/i.test(a))).toBe(false);
    const fn = Object.values(resources).find((r) => r.Type === 'AWS::Lambda::Function' && JSON.stringify(r.Properties?.Handler ?? '').includes('handler')
      && r.Properties?.Environment?.Variables?.TOKENS_TABLE);
    expect(fn).toBeDefined();
  });
});

describe('a voice send at an invitation\'s events (ADR-062 decision 4)', () => {
  it('carries the event\'s own values resolved, an invitation\'s reason among them, where its readers may read them', () => {
    const router = read('router-agent-handler.ts');
    const fn = router.slice(router.indexOf('async function sayWorkflowSend('), router.indexOf('async function sendLanguages('));
    expect(fn).toMatch(/const eventResolved = resolveTemplateFields\(choice\.written\.fields \?\? \{\}, \{ \.\.\.resolver, site: \{ callSite: turnCallSite\(undefined, args\.channelArn\), audience, section: 'chat' \} \}\);/);
    expect(fn).toMatch(/dispatchVoiceSend\(\{ \.\.\.args, values: \{ \.\.\.eventResolved, \.\.\.args\.values \},/);
    // The resolver it reads holds the event's values, the reason included, as the written send's does.
    expect(fn).toMatch(/const resolver = \{ \.\.\.held, values: \{ \.\.\.held\.values, \.\.\.\(args\.eventValues \?\? \{\}\) \} \};/);
    // The processor renders the values it is handed as data.
    expect(read('assistant-async-processor.ts')).toMatch(/renderVoice\(\{ written, values: \{ \.\.\.resolved, \.\.\.req\.values \}/);
  });
});
