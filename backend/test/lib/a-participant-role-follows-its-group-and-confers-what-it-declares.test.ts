/**
 * A PARTICIPANT ROLE FOLLOWS ITS GROUP, ADDS ITS HOLDERS WHERE IT SAYS SO, AND CONFERS WHAT IT DECLARES
 * (DESIGN-CONVERSATION-TYPES section 6.1, SPEC-CONVERSATION-TYPES FR30 and FR31, ADR-061 slice 3).
 *
 *  - a `group` source: the creator records the group's admitted members, and the membership reconcile keeps the holding
 *    equal to the group: a person who leaves it loses the holding and the moderation the role gave them, a person who
 *    joins holds it, a person whose groups cannot be read keeps what they held, and a group that cannot be listed
 *    changes nothing;
 *  - `adds` (a role as a member): the creator and the reconcile add the admitted holders and name their arrival as
 *    `person-joined`; synthesis refuses it where a membership source would remove them;
 *  - `fromRole`: a send says each person the template their role confers, an agent step drafts from the brief, each
 *    falling back to the step's own;
 *  - an agent step and its fallback address and mention a role: the router hands the step the holdings it read, and the
 *    processor keeps only holders who are members now;
 *  - a workflow with no `types` naming a role earns a warning at synthesis and beside a version's validation;
 *  - a role's list of names is joined in its readers' language;
 *  - a `person:` condition at `person-joined` and `invitation-sent` reads the person the event names, and selects only a
 *    step addressed to them.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONVERSATION_TYPES, type ConversationTypeConfig } from '../../lib/config/conversation-types';
import { participantRoleDeclarationErrors, roleGroups } from '../../lib/config/participant-roles';
import {
  groupRoleHoldings,
  holdersToAdd,
  holdingsAtCreation,
  type ParticipantRoleHolding,
} from '../../lambda/src/lib/participant-roles';
import { groupsToReconcile, reconcileGroupRoles, type RoleReconcileDeps } from '../../lambda/src/group-membership-reconcile';
import {
  PLATFORM_EVENT_WORKFLOWS,
  conferredBy,
  eventWorkflowErrors,
  eventWorkflowRoleWarnings,
  holderList,
  runEventWorkflow,
  templatesForPeople,
  type EventRunContext,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const arn = (id: string) => `${APP}/user/${id}`;
const CH = `${APP}/channel/oncall-1`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');

/** A manual type at premium whose on-call role is the ops group's admitted people, added to the room, moderators. */
const ONCALL: ConversationTypeConfig = {
  classifications: ['premium'],
  driftEnabled: false,
  participants: {
    participantRoles: {
      'on-call:ops': { from: [{ group: 'ops' }], adds: true, confers: { moderator: true, template: 'oncall-welcome', brief: 'oncall-brief' } },
      reviewer: { from: [{ group: 'reviewers' }], confers: { template: 'reviewer-welcome' } },
    },
  },
};
const types = CONVERSATION_TYPES as Record<string, ConversationTypeConfig>;
beforeAll(() => { types['test-oncall'] = ONCALL; });
afterAll(() => { delete types['test-oncall']; });

describe('the group source and adds, declared', () => {
  const ctx = { membershipGroups: { ops: 'premium', reviewers: 'premium' } };
  it('a declared membership group fills a role, and its groups are reconciled at the type\'s classification only', () => {
    expect(participantRoleDeclarationErrors({ 'test-oncall': ONCALL }, ctx)).toEqual([]);
    expect(participantRoleDeclarationErrors({ 'test-oncall': ONCALL }, { membershipGroups: {} }).join()).toMatch(/group 'ops' is not a declared membership group/);
    expect(roleGroups('premium')).toEqual(['ops', 'reviewers']);
    expect(roleGroups('standard')).toEqual([]);
    expect(groupsToReconcile({ detail: { eventName: 'AdminRemoveUserFromGroup', requestParameters: { groupName: 'reviewers' } } }, 'premium')).toEqual(['reviewers']);
  });

  it('refuses adds where a membership source would remove the added holders, and adds with no source that names outsiders', () => {
    const sourced = { ...CONVERSATION_TYPES.ops, participants: { participantRoles: { 'on-call:ops': { from: [{ group: 'ops' }], adds: true } } } } as ConversationTypeConfig;
    expect(participantRoleDeclarationErrors({ ops: sourced }, ctx).join()).toMatch(/membership source keeps its room equal to that source/);
    const eventAdds = { ...CONVERSATION_TYPES.ops, participants: { participantRoles: { lead: { from: [{ event: 'forPerson' }], adds: true } } } } as ConversationTypeConfig;
    expect(participantRoleDeclarationErrors({ ops: eventAdds }, ctx).join()).toMatch(/adds needs a source that names people who are not members yet/);
  });
});

describe('at creation', () => {
  const lead = arn('lead-1');
  const ana = arn('ana-2');
  const ben = arn('ben-3');
  it('records a group\'s admitted people, and puts the ones a role adds in the room', () => {
    const groups = { ops: [ana, ben], reviewers: [ben, arn('out-4')] };
    expect(holdersToAdd('test-oncall', groups, [lead])).toEqual([ana, ben]);
    const held = holdingsAtCreation('test-oncall', { forPerson: lead, groups, members: [lead, ana, ben] });
    expect(held['on-call:ops']).toEqual({ 'ana-2': { origin: 'group' }, 'ben-3': { origin: 'group' } });
    // A role that does not add its holders holds only the group's people who are members.
    expect(held.reviewer).toEqual({ 'ben-3': { origin: 'group' } });
  });

  it('the creator resolves each role\'s group, adds the holders, and makes a moderator role\'s holders moderators while the service admin creates', () => {
    const creator = src('lambda/src/typed-conversation-from-event.ts');
    expect(creator).toMatch(/groupSourcedRoles\(\(k\) => k === typeKey\)/);
    expect(creator).toMatch(/holdersToAdd\(typeKey, roleGroups, \[forUserArn, \.\.\.humans\]\)/);
    expect(creator).toMatch(/moderation: moderationOrigin\(role\)/);
    const core = src('lambda/src/lib/channel-creation.ts');
    expect(core).toMatch(/for \(const arn of core\.roleModerators \?\? \[\]\)[\s\S]{0,200}setParticipantRoleModerator\(\{ channelArn, personArn: arn, bearerArn: addBearer, moderator: true \}\)/);
  });
});

describe('the reconcile keeps a group-sourced role equal to its group', () => {
  const ana = arn('ana-2');
  const ben = arn('ben-3');
  const cal = arn('cal-5');
  function deps(state: { admitted: string[]; undetermined?: string[]; members: string[]; holdings?: Record<string, Record<string, ParticipantRoleHolding>>; unlistable?: boolean }) {
    const calls: string[] = [];
    const store = { holdings: clone(state.holdings ?? {}) as Record<string, Record<string, ParticipantRoleHolding>> };
    const d: RoleReconcileDeps = {
      classification: 'premium', appInstanceArn: APP, bearer: `${APP}/bot/premium`, directory: {} as never,
      listChannels: async (t) => (t === 'test-oncall' ? [CH] : []),
      classificationOf: async () => 'premium',
      members: async () => [...state.members],
      readHoldings: async () => clone(store.holdings),
      writeHoldings: async (_c, role, h) => { store.holdings[role] = clone(h); calls.push(`write:${role}`); },
      addMember: async (_c, p) => { calls.push(`add:${p}`); },
      setModerator: async (_c, p, m) => { calls.push(`${m ? 'moderate' : 'unmoderate'}:${p}`); },
      nameJoined: async (_c, people) => { calls.push(`joined:${people.join(',')}`); },
      resolveAllowed: async (source) => {
        if (state.unlistable) throw new Error('the group cannot be listed');
        return { admitted: new Set(source.group === 'ops' ? state.admitted : []), undetermined: new Set(state.undetermined ?? []), refused: [], unminted: [], flagged: [] } as never;
      },
    };
    return { d, calls, store };
  }

  // THE PROOF THE OWNER ASKED FOR: a person who leaves the group loses the holding.
  it('a person who leaves the group loses the holding and the moderation the role gave them', async () => {
    const w = deps({
      admitted: [ana], members: [ana, ben],
      holdings: { 'on-call:ops': { 'ana-2': { origin: 'group', moderation: 'participantRole:on-call:ops' }, 'ben-3': { origin: 'group', moderation: 'participantRole:on-call:ops' } } },
    });
    await reconcileGroupRoles(w.d, ['ops']);
    expect(w.store.holdings['on-call:ops']).toEqual({ 'ana-2': { origin: 'group', moderation: 'participantRole:on-call:ops' } });
    expect(w.calls).toContain(`unmoderate:${ben}`);
    // Membership is never removed here: a role does not decide who is in the room.
    expect(w.calls.some((c) => c.startsWith('remove'))).toBe(false);
  });

  it('a person who joins the group is added, named as person-joined, holds the role and moderates', async () => {
    const w = deps({ admitted: [ana, cal], members: [ana], holdings: { 'on-call:ops': { 'ana-2': { origin: 'group', moderation: 'participantRole:on-call:ops' } } } });
    await reconcileGroupRoles(w.d, ['ops']);
    expect(w.calls).toEqual(expect.arrayContaining([`add:${cal}`, `joined:${cal}`, `moderate:${cal}`, 'write:on-call:ops']));
    expect(w.store.holdings['on-call:ops']['cal-5']).toEqual({ origin: 'group', moderation: 'participantRole:on-call:ops' });
  });

  it('a person whose groups cannot be read keeps what they held, and a group that cannot be listed changes nothing', async () => {
    const kept = deps({ admitted: [], undetermined: [ben], members: [ben], holdings: { 'on-call:ops': { 'ben-3': { origin: 'group' } } } });
    await reconcileGroupRoles(kept.d, ['ops']);
    expect(kept.store.holdings['on-call:ops']).toEqual({ 'ben-3': { origin: 'group' } });
    const unlistable = deps({ admitted: [], members: [ben], holdings: { 'on-call:ops': { 'ben-3': { origin: 'group' } } }, unlistable: true });
    const out = await reconcileGroupRoles(unlistable.d, ['ops']);
    expect(out.failed).toBe(1);
    expect(unlistable.calls).toEqual([]);
  });

  it('keeps a holding of another origin, and a moderation of another origin', () => {
    const next = groupRoleHoldings({ 'x-1': { origin: 'invitation' }, 'y-2': { origin: 'group' } }, { admitted: new Set(), undetermined: new Set(), members: [arn('x-1'), arn('y-2')] });
    expect(next).toEqual({ 'x-1': { origin: 'invitation' } });
  });

  it('runs on the group change and on the backstop, with the role\'s holdings beside the membership reconcile', () => {
    expect(src('lambda/src/group-membership-reconcile.ts')).toMatch(/const roles = await reconcileGroupRoles\(\{/);
  });
});

describe('fromRole: a role confers the template and the brief its holders get', () => {
  const ana = arn('ana-2');
  const ben = arn('ben-3');
  const ctx = { roles: { 'on-call:ops': [ana], reviewer: [ben] }, conversationType: 'test-oncall' };

  it('each person is said their role\'s template, else the step\'s own; a brief is the first held role\'s', () => {
    expect(conferredBy(ctx, ana, 'template')).toBe('oncall-welcome');
    expect(conferredBy(ctx, ana, 'brief')).toBe('oncall-brief');
    expect(conferredBy(ctx, ben, 'brief')).toBeUndefined();
    expect(templatesForPeople({ to: 'joined', template: 'plain', fromRole: 'template' }, ctx, [ana, ben, arn('z-9')]))
      .toEqual([{ template: 'oncall-welcome', to: [ana] }, { template: 'reviewer-welcome', to: [ben] }, { template: 'plain', to: [arn('z-9')] }]);
    expect(templatesForPeople({ to: 'joined', template: 'plain' }, ctx, [ana])).toEqual([{ template: 'plain', to: [ana] }]);
  });

  it('a run sends each group its own template, under the step\'s one claim', async () => {
    const wf: EventWorkflow = {
      on: 'person-joined', types: ['test-oncall'], initial: 'greet',
      states: { greet: { send: { to: { participantRole: 'on-call:ops' }, template: 'workflow-subject-welcome', fromRole: 'template' }, onSuccess: 'done' }, done: { disposition: 'success' } },
    };
    const sent: Array<[string, string[]]> = [];
    await runEventWorkflow('greet', wf, { event: 'person-joined', channelArn: CH, eventPerson: ana, values: {}, ...ctx } as EventRunContext, {
      claimRun: async () => true, claimStep: async () => true, mentionName: async () => '', dispatchAgent: async () => true,
      send: async (a) => { sent.push([a.template, a.to]); return true; },
    });
    expect(sent).toEqual([['oncall-welcome', [ana]]]);
  });

  it('fromRole is refused on a room send, and a brief on an agent step not written for one person', () => {
    const base = clone(PLATFORM_EVENT_WORKFLOWS['ops-room']) as any;
    base.states.opening.send.fromRole = 'template';
    expect(eventWorkflowErrors('x', base).join()).toMatch(/fromRole says the template a person's role confers, so it is on a send to people/);
    const agent = clone(PLATFORM_EVENT_WORKFLOWS['ops-room']) as any;
    agent.states['first-look'].agent.fromRole = 'brief';
    expect(eventWorkflowErrors('x', agent).join()).toMatch(/fromRole drafts one person's brief/);
    agent.states['first-look'].agent.to = { people: 'event:person' };
    // A step written for one person opens no task the room works on.
    delete agent.states['first-look'].agent.workflow;
    expect(eventWorkflowErrors('x', agent)).toEqual([]);
  });
});

describe('an agent step and its fallback address a role', () => {
  it('the router hands the step the holdings it read, and the processor keeps only members now', () => {
    const router = src('lambda/src/router-agent-handler.ts');
    expect(router).toMatch(/\.\.\.\(ctx\.roles \? \{ roles: stepRoles\(_def, ctx\) \} : \{\}\)/);
    const processor = src('lambda/src/assistant-async-processor.ts');
    expect(processor).toMatch(/\(Array\.isArray\(arns\) \? arns : \[\]\)\.filter\(\(a\) => people\.has\(a\)\)/);
    expect(processor).toMatch(/conferredBy\(ctx, targetsOf\(def\.to\)\[0\], 'brief'\)/);
    expect(processor).toMatch(/templatesForPeople\(send, ctx, to\)/);
  });

  it('a run continued past an agent step reads the holdings again', () => {
    const router = src('lambda/src/router-agent-handler.ts');
    const fn = router.slice(router.indexOf('export async function handleEventContinuation('), router.indexOf('async function sayWorkflowSend('));
    expect(fn).toMatch(/participantRolesForRun\(str\(req\.workflow\), wf, base/);
  });
});

describe('a workflow with no types that names a role is warned about', () => {
  it('names each role and the types where it addresses nobody', () => {
    const wf: EventWorkflow = {
      on: 'person-joined', initial: 'greet',
      states: { greet: { send: { to: { participantRole: 'lead' }, template: 'workflow-subject-welcome' }, onSuccess: 'done' }, done: { disposition: 'success' } },
    };
    const warnings = eventWorkflowRoleWarnings('greet', wf);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/names participant role lead and declares no types; in .*general.* it addresses nobody/);
    expect(eventWorkflowRoleWarnings('greet', { ...wf, types: ['ops'] })).toEqual([]);
  });

  it('at synthesis for the platform\'s workflows, and beside a version\'s validation, as the console shows it', () => {
    expect(src('lib/stacks/assistant-profile-stack.ts')).toMatch(/eventWorkflowRoleWarnings\(name, wf\)\) cdk\.Annotations\.of\(this\)\.addWarning\(warning\)/);
    expect(src('lambda/src/lib/profile-lifecycle.ts')).toMatch(/return \{ errors, configId: draft\.configId, \.\.\.\(warnings\.length \? \{ warnings \} : \{\}\)(, \.\.\.\(errorDetails\.length \? \{ errorDetails \} : \{\}\))? \}/);
    expect(src('lambda/src/manage-profiles.ts')).toMatch(/\.\.\.\(warnings\?\.length \? \{ warnings \} : \{\}\)/);
  });
});

describe('a role\'s list of names is joined in its readers\' language', () => {
  it('in the language given, and the runtime\'s for an unknown tag', () => {
    const names = ['Ana', 'Ben', 'Cal'];
    expect(holderList(names, 'ja')).toBe(new Intl.ListFormat('ja', { style: 'short', type: 'unit' }).format(names));
    expect(holderList(names, 'not a tag!')).toBe(new Intl.ListFormat(undefined, { style: 'short', type: 'unit' }).format(names));
  });

  it('the router reads the order a send\'s template is chosen in, and the processor its resolver\'s', () => {
    expect(src('lambda/src/router-agent-handler.ts')).toMatch(/listLanguage: async \(to\) => \{\s*const langs = await sendLanguages\(ctx\.channelArn, \[\.\.\.to\]\);/);
    expect(src('lambda/src/assistant-async-processor.ts')).toMatch(/languages\['person:preferredLanguage'\] \?\? languages\['signal:userLanguage'\]/);
  });
});

describe('a person: condition at person-joined and invitation-sent', () => {
  const wf = (event: 'person-joined' | 'invitation-sent', to: unknown): EventWorkflow => ({
    on: event, initial: 'greet',
    states: {
      greet: { send: { to, template: 'workflow-subject-welcome' } as never, when: { 'person:onboarded': false }, onSuccess: 'done' },
      done: { disposition: 'success' },
    },
  });

  it('selects only a step addressed to the person the event names', () => {
    expect(eventWorkflowErrors('x', wf('person-joined', 'joined'))).toEqual([]);
    expect(eventWorkflowErrors('x', wf('invitation-sent', { people: 'event:person' }))).toEqual([]);
    expect(eventWorkflowErrors('x', wf('invitation-sent', { people: 'invitation:inviter' })).join()).toMatch(/reads a fact about the person the event names, so the step is addressed to that person alone/);
    expect(eventWorkflowErrors('x', wf('person-joined', { participantRole: 'lead' })).join()).toMatch(/addressed to that person alone/);
  });

  it('the router reads that person\'s onboarded flag and clearance, under the grants the join uses', () => {
    const router = src('lambda/src/router-agent-handler.ts');
    expect(router).toMatch(/const eventSettlesPerson = \(ctx\.event === 'person-joined' \|\| isInvitationEvent\(ctx\.event\)\) && !!ctx\.eventPerson;/);
    expect(router).toMatch(/onboardingStatus\(personId\)/);
    expect(router).toMatch(/resolveUserClearance\(personArn\)/);
  });
});
