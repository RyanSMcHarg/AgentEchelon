/**
 * A PARTICIPANT ROLE IS DECLARED ON ITS TYPE, HELD ON THE CONTEXT ROW, AND ADDRESSED ONLY WHILE ITS HOLDER IS A MEMBER
 * (DESIGN-CONVERSATION-TYPES section 6.1, ADR-061 slice 3, ADR-060 `participant:role` and `participantRole:<name>`).
 *
 *  - the declarations: the shipped types synthesize; a source no path fills, a conferral no reader binds, an
 *    `invitable` role with no invitation source, a moderator a vendor or an outsider could fill, and the rest of
 *    section 6.1's rules are refused at synthesis, each with its reason; no vendor implements `lookupRole`;
 *  - the holdings: kept to the roles the type declares, never a host's assertion, and read over the live roster, so a
 *    former holder is addressed by nothing and every member no source names holds the default role; the creator
 *    records the opening event's person as the ops room's lead;
 *  - the variables and the workflow: `participant:role` and `participantRole:<name>` are platform trust, checked against
 *    the workflow's declared types (ADR-060's proof that waited on this slice), a `{ participantRole }` send addresses
 *    the holders who are members, a mention lists them, a room a guest reads hears a holding only where the role says
 *    so, and an audience over the cap sends nothing;
 *  - the invitations path: a role is recorded only when the type declares it invitable, and one that confers
 *    `moderator` only when the inviter holds it or moderates the room (deny tests); the invitee's holding and its
 *    moderation are recorded, and revoking removes that moderation and no other;
 *  - the router reads the holdings from the context row alone, never from channel Metadata.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONVERSATION_TYPES, type ConversationTypeConfig } from '../../lib/config/conversation-types';
import {
  NOT_BUILT_ROLE_SOURCES,
  declaredParticipantRoleNames,
  invitableRoleOf,
  participantRoleDeclarationErrors,
  roleSaidInRoom,
  typeIsMixedTrust,
} from '../../lib/config/participant-roles';
import { connectorErrors } from '../../lib/config/connectors';
import { holdersByRole, holdingsAtCreation, parseHoldings, rolesOfPerson } from '../../lambda/src/lib/participant-roles';
import {
  PLATFORM_EVENT_WORKFLOWS,
  eventWorkflowErrors,
  holderList,
  participantRoleReferences,
  runEventWorkflow,
  type EventRunContext,
  type EventRunDeps,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { buildSourceTable, sourceLookup, whenErrors, whenHolds } from '../../lambda/src/lib/variables';
import { createInvitation, revokeForMember, type InvitationsDeps } from '../../lambda/src/invitations';
import { edgeContext } from '../helpers/edge-context';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const arn = (id: string) => `${APP}/user/${id}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const OPS = PLATFORM_EVENT_WORKFLOWS['ops-room'];
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../lambda/src', rel), 'utf8');

/** A type a deployment could declare: invitations redeemed by signing in, and two invitable roles. */
const REVIEW: ConversationTypeConfig = {
  driftEnabled: false,
  invitations: { modes: ['sign-in'], default: 'sign-in' },
  participants: {
    participantRoles: {
      reviewer: { from: [{ invitation: true }], invitable: true, holders: 'many', confers: { moderator: true } },
      observer: { from: [{ invitation: true }], invitable: true },
      chair: { from: [{ invitation: true }], invitable: true, holders: 'one' },
    },
  },
};

beforeAll(() => { (CONVERSATION_TYPES as Record<string, ConversationTypeConfig>)['test-review'] = REVIEW; });
afterAll(() => { delete (CONVERSATION_TYPES as Record<string, ConversationTypeConfig>)['test-review']; });

describe('the declarations (DESIGN-CONVERSATION-TYPES section 6.1)', () => {
  const ctx = { membershipGroups: { ops: 'premium' }, outside: ['guest', 'customer'] };
  const errorsOf = (types: Record<string, ConversationTypeConfig>) => participantRoleDeclarationErrors(types, ctx).join('\n');
  const withRoles = (base: string, participants: ConversationTypeConfig['participants']) => ({ [base]: { ...CONVERSATION_TYPES[base], participants } });

  it('synthesis refuses a declaration that cannot be built, in every classification\'s stack', () => {
    const stack = fs.readFileSync(path.join(__dirname, '../../lib/stacks/assistant-profile-stack.ts'), 'utf8');
    expect(stack).toMatch(/assertParticipantRolesAreDeclared\(\{\s*membershipGroups: defaultProfileRegistry\.membershipGroups\(\),\s*outside: defaultProfileRegistry\.outsideClassificationValues\(\),/);
  });

  it('the shipped types and a sign-in-only type with invitable roles synthesize', () => {
    expect(participantRoleDeclarationErrors(CONVERSATION_TYPES, ctx)).toEqual([]);
    expect(CONVERSATION_TYPES.ops.participants?.participantRoles?.lead).toMatchObject({ from: [{ event: 'forPerson' }], holders: 'one', confers: { moderator: true } });
    expect(CONVERSATION_TYPES.ops.participants?.defaultRole).toBe('responder');
    expect(declaredParticipantRoleNames(['ops'])).toEqual(['lead', 'responder']);
  });

  it('refuses a source no path fills yet, each with what is missing', () => {
    // `creator` is filled by a confirmed `open_conversation` proposal (ADR-061 slice 3d), so it is no longer refused.
    expect(NOT_BUILT_ROLE_SOURCES.creator).toBeUndefined();
    // `host` is read over the row's `memberIdentities` (`hostRoleHoldings`, slice 3e), so it is no longer refused either.
    expect(NOT_BUILT_ROLE_SOURCES.host).toBeUndefined();
    expect(errorsOf(withRoles('ops', { participantRoles: { x: { from: [{ host: true } as never] } } }))).not.toMatch(/host source is NOT BUILT/);
    // A lookup through a connector: listed on the type, declared with lookupRole, and no vendor implements it.
    const lookedUp = errorsOf(withRoles('ops', { resolveVia: [{ connectorId: 'pd' }], participantRoles: { 'on-call:network': { from: [{ resolveVia: 'pd', op: 'lookupRole' }] } } }));
    expect(lookedUp).toMatch(/connector 'pd' is not declared in the registry with the lookupRole capability/);
    expect(lookedUp).toMatch(/a resolveVia source is NOT BUILT: no vendor adapter implements lookupRole/);
    expect(errorsOf(withRoles('ops', { participantRoles: { x: { from: [{ resolveVia: 'other', op: 'lookupRole' }] } } }))).toMatch(/connector 'other' is not in this type's participants.resolveVia/);
    expect(connectorErrors([{ id: 'pd', vendor: 'pagerduty', capabilities: ['lookupRole'] }], { issuers: [] } as never, ['connectors']).join()).toMatch(/does not implement "lookupRole"/);
  });

  it('accepts a template and a brief a role confers by name, and refuses a role a host fills that would decide anything', () => {
    expect(errorsOf(withRoles('ops', { participantRoles: { lead: { from: [{ event: 'forPerson' }], confers: { template: 'ops-lead-welcome', brief: 'ops-first-look' } } } }))).toBe('');
    expect(errorsOf(withRoles('ops', { participantRoles: { lead: { from: [{ event: 'forPerson' }], confers: { brief: 'Not A Name' } } } }))).toMatch(/confers.brief names a prompt template/);
    expect(errorsOf(withRoles('ops', { participantRoles: { x: { from: [{ host: true }], visibleToGuests: true } } }))).toMatch(/host source confers nothing/);
  });

  it('holds each source to the type that can fill it', () => {
    expect(errorsOf(withRoles('general', { participantRoles: { lead: { from: [{ event: 'forPerson' }] } } }))).toMatch(/event source needs a type an event opens/);
    expect(errorsOf(withRoles('ops', { participantRoles: { guest: { from: [{ invitation: true }], invitable: true } } }))).toMatch(/invitation source needs a type that declares invitations/);
    expect(errorsOf(withRoles('ops', { participantRoles: { lead: { from: [{ event: 'forPerson' }], invitable: true } } }))).toMatch(/invitable needs an invitation source/);
    expect(errorsOf(withRoles('ops', { participantRoles: { x: { from: [] } } }))).toMatch(/names no source, and only the type's defaultRole may/);
    expect(errorsOf(withRoles('ops', { defaultRole: 'nobody', participantRoles: { lead: { from: [{ event: 'forPerson' }] } } }))).toMatch(/defaultRole 'nobody' is not one of its participant roles/);
    expect(errorsOf(withRoles('ops', { participantRoles: { 'Lead Person': { from: [{ event: 'forPerson' }] } } }))).toMatch(/a name is lowercase letters/);
  });

  it('never lets a source an outsider can fill confer moderator: a link-redeemed invitation in an ordinary conversation', () => {
    expect(typeIsMixedTrust('general')).toBe(true);
    expect(typeIsMixedTrust('ops')).toBe(false);
    expect(errorsOf(withRoles('general', { participantRoles: { reviewer: { from: [{ invitation: true }], invitable: true, confers: { moderator: true } } } })))
      .toMatch(/confers moderator, and an invitation or event source on a type a guest or a link session reads never fills it/);
    expect(errorsOf({ 'test-review': REVIEW })).toBe('');
  });
});

describe('the holdings, on the context row (DESIGN-CONVERSATION-TYPES section 6.1)', () => {
  const lead = arn('lead-1');
  const ana = arn('ana-2');
  const ben = arn('ben-3');

  it('the creator records the opening event\'s person as the ops room\'s lead, by AppInstanceUser id', () => {
    expect(holdingsAtCreation('ops', { forPerson: lead })).toEqual({ lead: { 'lead-1': { origin: 'event' } } });
    expect(holdingsAtCreation('general', { forPerson: lead })).toEqual({});
    expect(read('typed-conversation-from-event.ts')).toMatch(/const participantRoles = holdingsAtCreation\(typeKey, \{\s+forPerson: forUserArn, groups: roleGroups, members: \[forUserArn, \.\.\.humans\],/);
    expect(read('lib/channel-context-client.ts')).toMatch(/'participantRoles',\n(\s+\/\/[^\n]*\n\s+'watchedAlarm',\n)?\];/);
  });

  it('keeps only what the type declares, and never reads a host\'s assertion', () => {
    const raw = { lead: { 'lead-1': { origin: 'event' } }, organizer: { 'ana-2': { origin: 'event' } }, responder: { 'ben-3': { origin: 'host' }, 'bad id!': { origin: 'event' } } };
    expect(parseHoldings(raw, 'ops')).toEqual({ lead: { 'lead-1': { origin: 'event' } } });
    expect(parseHoldings('not a map', 'ops')).toEqual({});
  });

  it('reads them over the live roster: a former holder is no holder, and every member no source names holds the default', () => {
    const raw = { lead: { 'lead-1': { origin: 'event' } } };
    expect(holdersByRole(raw, 'ops', [lead, ana, ben])).toEqual({ lead: [lead], responder: [ana, ben] });
    // THE LEAD LEFT: they lead nobody, and the rest still respond.
    expect(holdersByRole(raw, 'ops', [ana, ben])).toEqual({ lead: [], responder: [ana, ben] });
    expect(rolesOfPerson(holdersByRole(raw, 'ops', [lead, ana]), lead)).toEqual(['lead']);
    // A one-holder role takes its first holder.
    expect(holdersByRole({ chair: { 'ana-2': { origin: 'invitation' }, 'ben-3': { origin: 'invitation' } } }, 'test-review', [ana, ben]).chair).toEqual([ana]);
    // NO HOLDINGS RECORDED: nobody leads, and the default still holds over the members.
    expect(holdersByRole(undefined, 'ops', [ana])).toEqual({ responder: [ana] });
  });
});

describe('the variables and the workflow (ADR-060, ADR-061 decisions 2, 3 and 6)', () => {
  const lookup = sourceLookup(buildSourceTable({ catalog: [] }));

  it('publishes participant:role, participantRole:<name> and invitation:role as deciding values that describe no person', () => {
    expect(lookup('participant:role')).toMatchObject({ type: 'set', trust: 'platform', describesPerson: false });
    expect(lookup('participant:role')?.values).toEqual(expect.arrayContaining(['lead', 'responder']));
    expect(lookup('participantRole:lead')).toMatchObject({ type: 'person-list', trust: 'platform', describesPerson: false });
    expect(lookup('invitation:role')).toMatchObject({ type: 'enum', trust: 'closed-enum', events: ['invitation-sent', 'invitation-unredeemed'] });
    // A room step may be selected on who leads: the room's shape, not a fact about one person.
    expect(whenErrors({ 'participant:role': { op: 'has', value: 'lead' } }, lookup, { selects: 'room' })).toEqual([]);
  });

  // ADR-060, "What proves it": validation refuses a participant:role the declared types do not declare.
  it('refuses a condition on a participant role the workflow\'s declared types do not declare', () => {
    const conditioned = (when: unknown): EventWorkflow => {
      const wf = clone(OPS) as unknown as Record<string, any>;
      wf.states.opening.onSuccess = [{ to: 'greet-lead', when }, { to: 'first-look' }];
      return wf as unknown as EventWorkflow;
    };
    expect(eventWorkflowErrors('x', conditioned({ 'participant:role': { op: 'has', value: 'lead' } }))).toEqual([]);
    expect(eventWorkflowErrors('x', conditioned({ 'participant:role': { op: 'has', value: 'reviewer' } })).join()).toMatch(/is a set of lead, responder/);
    expect(eventWorkflowErrors('x', conditioned({ 'participantRole:reviewer': { op: 'exists' } })).join()).toMatch(/not a source this classification publishes/);
    expect(eventWorkflowErrors('x', conditioned({ 'participantRole:lead': { op: 'exists' } }))).toEqual([]);
  });

  it('a role named in an audience or a mention must be declared by every declared type, and sayable in a room a guest reads', () => {
    const wf = clone(OPS) as unknown as Record<string, any>;
    wf.on = 'person-joined'; wf.types = ['general']; wf.initial = 'opening';
    wf.states.opening.send.mention = { lead: 'participantRole:lead' };
    expect(eventWorkflowErrors('x', wf).join('\n')).toMatch(/participant role lead, which type general does not declare/);
    const visible = clone(wf);
    visible.types = ['test-review'];
    visible.states.opening.send.mention = { lead: 'participantRole:observer' };
    visible.states['greet-lead'].send.to = { participantRole: 'observer' };
    expect(eventWorkflowErrors('x', visible).join('\n')).toBe('');
    // test-review admits no link and no outside classification, so a holding is said in its rooms.
    expect(roleSaidInRoom('test-review', 'observer')).toBe(true);
    expect(roleSaidInRoom('ops', 'lead')).toBe(true);
    // A workflow that declares no types is checked at run time, where an undeclared role addresses nobody.
    const untyped = clone(visible); delete untyped.types;
    expect(eventWorkflowErrors('x', untyped)).toEqual([]);
    expect([...participantRoleReferences(untyped as EventWorkflow).roles].sort()).toEqual(['observer']);
  });

  describe('a run', () => {
    const lead = arn('lead-1');
    const left = arn('left-9');
    const ana = arn('ana-2');
    const base: EventRunContext = { event: 'conversation-opened', channelArn: `${APP}/channel/ops-1`, eventPerson: lead, values: { label: 'L' } };
    const run = async (ctx: EventRunContext, wf: EventWorkflow = OPS, names: Record<string, string> = { [lead]: 'Dana', [ana]: 'Ana' }) => {
      const sent: Array<{ template: string; to: string[]; values: Record<string, string> }> = [];
      const taken = new Set<string>();
      const d: EventRunDeps = {
        claimRun: async () => true,
        claimStep: async (step) => { if (taken.has(step)) return false; taken.add(step); return true; },
        mentionName: async (p) => names[p] ?? '',
        send: async (a) => { sent.push({ template: a.template, to: a.to, values: a.values }); return true; },
        dispatchAgent: async () => true,
      };
      const out = await runEventWorkflow('ops-room', wf, ctx, d);
      return { sent, out };
    };

    it('addresses and mentions the role\'s holders who are members', async () => {
      const { sent } = await run({ ...base, roles: { lead: [lead] } });
      expect(sent.map((s) => [s.template, s.to])).toEqual([['ops-room-opening', []], ['ops-lead-welcome', [lead]]]);
      expect(sent[0].values.lead).toBe('Dana');
    });

    // DENY TEST: a former holder who left receives no targeted message and no email from a { participantRole } send.
    it('a former holder who left the conversation is sent nothing and emailed nothing', async () => {
      const holders = holdersByRole({ lead: { 'left-9': { origin: 'event' } } }, 'ops', [ana]);
      const { sent, out } = await run({ ...base, eventPerson: left, roles: holders });
      expect(sent.map((s) => s.template)).toEqual(['ops-room-opening']);
      expect(sent.flatMap((s) => s.to)).not.toContain(left);
      expect(sent[0].values.lead).toBeUndefined();
      expect(out.steps.find((s) => s.step === 'greet-lead')?.outcome).toBe('skipped');
    });

    it('in a room a guest reads, a holding the role does not declare visible renders empty', async () => {
      const { sent } = await run({ ...base, roles: { lead: [lead] }, roleSaidInRoom: () => false });
      expect(sent[0].values.lead).toBeUndefined();
      // The targeted greeting still reaches the holder: it is not said to the room.
      expect(sent[1].to).toEqual([lead]);
    });

    it('a role with more holders than the cap sends nothing and takes the failure edge', async () => {
      const many = Array.from({ length: 11 }, (_, i) => arn(`p-${i}`));
      const { sent, out } = await run({ ...base, roles: { lead: many } });
      expect(sent.map((s) => s.template)).toEqual(['ops-room-opening']);
      expect(out.steps.find((s) => s.step === 'greet-lead')?.outcome).toBe('failed');
    });

    it('a mention of several holders lists at most five names and counts the rest', () => {
      expect(holderList([])).toBe('');
      expect(holderList(['A'])).toBe('A');
      const seven = holderList(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
      expect(seven).toContain('E');
      expect(seven).not.toContain('F');
      expect(seven).toContain('+2');
    });

    it('a condition on participant:role holds for the person the event names', () => {
      const values = { 'participant:role': rolesOfPerson({ lead: [lead], responder: [ana] }, lead) };
      const site = { callSite: { identitySettled: false, conversationSettled: true, subjectSettled: false }, audience: 'room' as const };
      expect(whenHolds({ 'participant:role': { op: 'has', value: 'lead' } }, { lookup, values, site })).toBe(true);
      expect(whenHolds({ 'participant:role': { op: 'has', value: 'responder' } }, { lookup, values, site })).toBe(false);
    });
  });
});

describe('the router reads the holdings from the context row alone', () => {
  const router = read('router-agent-handler.ts');
  const fn = router.slice(router.indexOf('async function participantRolesForRun('), router.indexOf('interface RouterGateHeld'));

  it('from getChannelContext, over the live roster, and never from channel Metadata', () => {
    expect(fn).toMatch(/getChannelContext\(ctx\.channelArn/);
    expect(fn).toMatch(/holdersByRole\(row\?\.participantRoles, conversationType, memberArns\)/);
    expect(fn).toMatch(/resolveChannelSize\(chimeClient, ctx\.channelArn, who\.botArn\)/);
    expect(fn).not.toMatch(/Metadata/);
    // No reader anywhere in the router takes a participant role from Metadata.
    expect(router).not.toMatch(/Metadata[^\n]*participantRoles|participantRoles[^\n]*Metadata/);
  });

  it('at invitation-sent, participant:role is the role the invitation records', () => {
    expect(router).toMatch(/if \(isInvitationEvent\(ctx\.event\)\) return \{ 'participant:role': invitationRole \? \[invitationRole\] : \[\] \};/);
    expect(router).toMatch(/record\.participantRole \? \{ invitationRole: record\.participantRole \}/);
  });
});

describe('an invitation records a participant role (DESIGN-CONVERSATION-TYPES section 6.1)', () => {
  const POOL_ISS = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Deployment';
  const INVITER = '0190c0de-0000-7000-8000-000000000001';
  const MOD = '0190c0de-0000-7000-8000-000000000003';
  const HOLDER = '0190c0de-0000-7000-8000-000000000004';
  const INVITEE_ID = '0190c0de-0000-7000-8000-0000000000ee';
  const INVITEE = arn(INVITEE_ID);
  const CH = `${APP}/channel/review-1`;
  const ADMIN = arn('test-admin');

  beforeAll(() => {
    process.env.APP_INSTANCE_ARN = APP;
    process.env.TRUSTED_ISSUERS = JSON.stringify([
      { id: 'deployment', kind: 'cognito-pool', pool: 'us-east-1_Deployment', iss: POOL_ISS, subject: ['sub'], clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true, groupsClaim: 'cognito:groups' },
    ]);
  });

  function world(opts: { type?: string; holdings?: Record<string, unknown> } = {}) {
    const tokens = new Map<string, Record<string, any>>();
    const context: Record<string, any> = { channelArn: CH, conversationType: opts.type ?? 'test-review', ...(opts.holdings ? { participantRoles: clone(opts.holdings) } : {}) };
    const members = new Set([INVITER, MOD, HOLDER].map(arn));
    const moderators = new Set([arn(MOD)]);
    const chime: string[] = [];
    const doc = {
      async send(cmd: any) {
        const name = cmd.constructor.name;
        const i = cmd.input;
        if (name === 'GetCommand' && i.TableName === 'Context') return { Item: clone(context) };
        if (name === 'PutCommand') { tokens.set(i.Item.pk, { ...i.Item }); return {}; }
        if (name === 'QueryCommand') return { Items: [...tokens.values()] };
        if (name === 'UpdateCommand' && i.TableName === 'Context') {
          // Only the participantRoles attribute is ever named (the IAM grant allows no other).
          expect(Object.values(i.ExpressionAttributeNames)[0]).toBe('participantRoles');
          const n = i.ExpressionAttributeNames;
          if (i.UpdateExpression === 'SET #pr = if_not_exists(#pr, :empty)') context.participantRoles ??= {};
          else if (i.UpdateExpression === 'SET #pr.#r = if_not_exists(#pr.#r, :empty)') context.participantRoles[n['#r']] ??= {};
          else if (i.UpdateExpression === 'SET #pr.#r.#p = :h') {
            // A ONE-HOLDER CLAIM: written only where the role holds nobody else, as DynamoDB evaluates the condition.
            const held = context.participantRoles[n['#r']];
            if (i.ConditionExpression === 'size(#pr.#r) = :none OR attribute_exists(#pr.#r.#p)' && Object.keys(held).length && !(n['#p'] in held)) {
              throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
            }
            held[n['#p']] = i.ExpressionAttributeValues[':h'];
          }
          else if (i.UpdateExpression === 'REMOVE #pr.#r.#p') delete context.participantRoles?.[n['#r']]?.[n['#p']];
          return {};
        }
        if (name === 'UpdateCommand') {
          const row = tokens.get(i.Key.pk)!;
          if (i.UpdateExpression.includes('revokedAt')) { Object.assign(row, { revokedAt: 1 }); return { Attributes: { ...row } }; }
          return {};
        }
        throw new Error(`unexpected ${name}`);
      },
    };
    const messaging = {
      async send(cmd: any) {
        const name = cmd.constructor.name;
        const i = cmd.input;
        if (name === 'DescribeChannelCommand') {
          if (!members.has(i.ChimeBearer)) throw Object.assign(new Error('no'), { name: 'ForbiddenException' });
          return { Channel: { ChannelArn: CH, Name: 'Design review' } };
        }
        if (name === 'ListTagsForResourceCommand') return { Tags: [{ Key: 'classification', Value: 'standard' }] };
        if (name === 'DescribeChannelModeratorCommand') {
          if (!moderators.has(i.ChannelModeratorArn)) throw Object.assign(new Error('no'), { name: 'NotFoundException' });
          return { ChannelModerator: {} };
        }
        throw new Error(`unexpected ${name}`);
      },
    };
    const deps: InvitationsDeps = {
      doc, messaging,
      lambda: { async send() { return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true, personArn: INVITEE })) }; } },
      tokensTable: 'Tokens', contextTable: 'Context', appInstanceArn: APP, exchangeFunction: 'arn:exchange',
      landingOrigin: 'https://widget.example.com', linkReach: [],
      adminBearer: async () => ADMIN, now: () => 1_800_000_000_000,
      mail: async () => true, addMember: async () => undefined, removeMember: async () => undefined, nameEvent: async () => true,
      moderate: async (m) => { expect(m.bearerArn).toBe(ADMIN); chime.push(`${m.moderator ? 'CreateChannelModeratorCommand' : 'DeleteChannelModeratorCommand'}:${m.personArn}`); },
    };
    return { deps, context, tokens, chime };
  }

  const asCaller = (personId: string, body: unknown, resource = '/invitations') => ({
    httpMethod: 'POST', resource, queryStringParameters: null,
    requestContext: { authorizer: edgeContext({ claims: { sub: `sub-${personId}`, iss: POOL_ISS, 'cognito:groups': ['standard'], name: 'Riley Inviter' }, personId }) },
    body: JSON.stringify(body),
  });
  const ask = (personId: string, body: Record<string, unknown>) => asCaller(personId, { channelArn: CH, name: 'Riley', email: 'riley@example.com', ...body });
  const parse = (res: any) => JSON.parse(res.body);

  it('a role the type does not declare invitable is refused for every inviter, before anything is minted', async () => {
    const w = world();
    expect(parse(await createInvitation(ask(MOD, { role: 'auditor' }), w.deps)).code).toBe('ROLE_NOT_DECLARED');
    const general = world({ type: 'general' });
    expect(parse(await createInvitation(ask(MOD, { role: 'reviewer' }), general.deps)).code).toBe('ROLE_NOT_DECLARED');
    expect(invitableRoleOf('ops', 'lead')).toBeUndefined();
    expect(parse(await createInvitation(ask(MOD, { role: 'Not A Role' }), w.deps)).code).toBe('INVITATION_INVALID');
    expect(w.tokens.size).toBe(0);
  });

  // DENY TEST: an inviter who neither holds a role that confers moderator nor moderates the channel is refused recording it.
  it('refuses a moderator-conferring role to an inviter who neither holds it nor moderates the room', async () => {
    const w = world();
    const res = await createInvitation(ask(INVITER, { role: 'reviewer' }), w.deps);
    expect(res.statusCode).toBe(403);
    expect(parse(res).code).toBe('ROLE_NOT_CONFERRABLE');
    expect(w.tokens.size).toBe(0);
    expect(w.chime).toEqual([]);
  });

  it('a holder of the role, or a moderator, may confer it: the invitee holds it, moderates, and the moderation is the role\'s', async () => {
    const byHolder = world({ holdings: { reviewer: { [HOLDER]: { origin: 'invitation' } } } });
    const res = await createInvitation(ask(HOLDER, { role: 'reviewer' }), byHolder.deps);
    expect(res.statusCode).toBe(201);
    expect([...byHolder.tokens.values()][0].participantRole).toBe('reviewer');
    expect(byHolder.chime).toEqual([`CreateChannelModeratorCommand:${INVITEE}`]);
    expect(byHolder.context.participantRoles.reviewer[INVITEE_ID]).toEqual({ origin: 'invitation', moderation: 'participantRole:reviewer' });
    const byModerator = world();
    expect((await createInvitation(ask(MOD, { role: 'reviewer' }), byModerator.deps)).statusCode).toBe(201);
  });

  it('a role that confers nothing is recorded for any inviter, and makes nobody a moderator', async () => {
    const w = world();
    expect((await createInvitation(ask(INVITER, { role: 'observer' }), w.deps)).statusCode).toBe(201);
    expect(w.context.participantRoles.observer[INVITEE_ID]).toEqual({ origin: 'invitation' });
    expect(w.chime).toEqual([]);
  });

  it('a one-holder role somebody holds is refused', async () => {
    const w = world({ holdings: { chair: { [HOLDER]: { origin: 'invitation' } } } });
    expect(parse(await createInvitation(ask(MOD, { role: 'chair' }), w.deps)).code).toBe('ROLE_HELD');
  });

  it('two invitations made at once for a one-holder role: one holds it, the other is refused and its invitee removed', async () => {
    const w = world();
    // Each invitation mints its own invitee.
    const ids = ['0190c0de-0000-7000-8000-0000000000e1', '0190c0de-0000-7000-8000-0000000000e2'];
    let minted = 0;
    w.deps.lambda = { async send() { return { Payload: new TextEncoder().encode(JSON.stringify({ ok: true, personArn: arn(ids[minted++]) })) }; } } as never;
    const removed: string[] = [];
    w.deps.removeMember = async (m: { inviteeArn: string }) => { removed.push(m.inviteeArn); };
    // Both read the row before either writes: the read check passes for both, and the conditional write decides.
    const out = await Promise.all([createInvitation(ask(MOD, { role: 'chair' }), w.deps), createInvitation(ask(MOD, { role: 'chair' }), w.deps)]);
    expect(out.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(parse(out.find((r) => r.statusCode === 409)).code).toBe('ROLE_HELD');
    expect(Object.keys(w.context.participantRoles.chair)).toHaveLength(1);
    // The refused one leaves no invitation and no member behind.
    expect(w.tokens.size).toBe(1);
    const holder = Object.keys(w.context.participantRoles.chair)[0];
    expect(removed).toEqual([arn(ids.find((id) => id !== holder)!)]);
  });

  it('revoking removes the holding and the role\'s moderation, and leaves a moderation of any other origin', async () => {
    const w = world();
    await createInvitation(ask(MOD, { role: 'reviewer' }), w.deps);
    const invitationId = [...w.tokens.values()][0].invitationId;
    const revoke = asCaller(MOD, { channelArn: CH, invitationId }, '/invitations/revoke');
    expect((await revokeForMember(revoke, w.deps)).statusCode).toBe(200);
    expect(w.context.participantRoles.reviewer[INVITEE_ID]).toBeUndefined();
    expect(w.chime).toEqual([`CreateChannelModeratorCommand:${INVITEE}`, `DeleteChannelModeratorCommand:${INVITEE}`]);
    // A moderation the holding does not name as the role's is never removed.
    const other = world({ holdings: { observer: { [INVITEE_ID]: { origin: 'invitation' } } } });
    const issued = [...w.tokens.values()][0];
    other.tokens.set(issued.pk, { ...issued, revokedAt: undefined, participantRole: 'observer' });
    const res = await revokeForMember(asCaller(MOD, { channelArn: CH, invitationId }, '/invitations/revoke'), other.deps);
    expect(res.statusCode).toBe(200);
    expect(other.chime).toEqual([]);
    expect(other.context.participantRoles.observer[INVITEE_ID]).toBeUndefined();
  });
});
