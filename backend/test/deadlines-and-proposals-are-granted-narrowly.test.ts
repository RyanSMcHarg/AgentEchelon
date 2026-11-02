/**
 * DEADLINES AND PROPOSALS ARE GRANTED NARROWLY (ADR-061 "IAM this adds", tenet P4): every grant slice 3d adds, with
 * the refusal that proves its scope.
 *
 *  - Each classification's scheduler role is trusted by the scheduler service only for schedules in its own group of
 *    this account, and invokes its own router and no other function: classification A's scheduler role is refused
 *    invoking classification B's router.
 *  - Each router creates and deletes schedules in its own classification's group alone, and passes only its own
 *    scheduler role, to the scheduler service alone.
 *  - The assistant's session writes `proposal#*` records and no other kind, and reads none; the processor's own role
 *    holds nothing on the token store.
 *  - The apply endpoint reads and consumes `proposal#*` alone, reads three attributes of the context row, invokes the
 *    invitations function and the typed creators of member classifications of this instance, and nothing else.
 *  - The credential exchange and offboarding, sensitive principals, hold no router invoke: a redeemed or deleted
 *    invitation's schedule fires, finds nothing pending, and deletes itself.
 *  - The invitations function deletes no invitation record: a reminder adds a second link beside the first.
 *  - A deadline that could not be scheduled raises its classification's alarm through the one notifier.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MessagingStack } from '../lib/stacks/messaging-stack';
import { IdentityStack } from '../lib/stacks/identity-stack';
import { ConversationsStack } from '../lib/stacks/conversations-stack';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS, TEST_ENV } from './helpers/synth';
import { INSTANCE_NAME } from '../lib/stacks/agent-classification-common';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';
import { admitsTags, tagsOf } from './helpers/tag-condition';

type Statement = { Sid?: string; Effect?: string; Action: unknown; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
type Resource = { Type: string; Properties?: Record<string, any> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const text = (v: unknown) => JSON.stringify(v);

function statementsOfRole(resources: Record<string, Resource>, rolePattern: RegExp): Statement[] {
  const out: Statement[] = [];
  for (const [id, r] of Object.entries(resources)) {
    if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') {
      if (rolePattern.test(text(r.Properties?.Roles ?? ''))) out.push(...(r.Properties?.PolicyDocument?.Statement ?? []));
    } else if (r.Type === 'AWS::IAM::Role' && rolePattern.test(id)) {
      for (const pol of r.Properties?.Policies ?? []) out.push(...pol.PolicyDocument.Statement);
    }
  }
  return out;
}

const synthAssistants = (classification: string): Record<string, Resource> => {
  const app = new cdk.App();
  const stack = assistantsOf(classification)(app, `AgentEchelonAssistants-${classification}`, CLASSIFICATION_TEST_PROPS as never);
  return (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
};

describe('a deadline reaches only its own router (deny tests)', () => {
  const A = synthAssistants('standard');
  const B = synthAssistants('premium');
  const routerOf = (r: Record<string, Resource>) => Object.keys(r).find((id) => r[id].Type === 'AWS::Lambda::Function' && /^AgentHandler[0-9A-F]{8}$/.test(id))!;
  const groupOf = (r: Record<string, Resource>) => Object.values(r).find((x) => x.Type === 'AWS::Scheduler::ScheduleGroup')?.Properties?.Name as string;
  const roleIdOf = (r: Record<string, Resource>) => Object.keys(r).find((id) => r[id].Type === 'AWS::IAM::Role' && /^EventDeadlineSchedulerRole/.test(id))!;

  it('each classification owns one schedule group, named for it', () => {
    expect(groupOf(A)).toMatch(/-standard-event-deadlines$/);
    expect(groupOf(B)).toMatch(/-premium-event-deadlines$/);
    expect(groupOf(A)).not.toBe(groupOf(B));
  });

  it('the scheduler role is trusted by the scheduler service alone, for its own group of this account', () => {
    const trust = A[roleIdOf(A)].Properties!.AssumeRolePolicyDocument.Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0].Principal).toEqual({ Service: 'scheduler.amazonaws.com' });
    expect(trust[0].Condition.StringEquals['aws:SourceAccount']).toBeDefined();
    // The scheduler presents the schedule GROUP's ARN when it checks it may assume the role at creation, so the trust
    // names that group exactly; a `schedule/<group>/*` pattern matches nothing it presents and refuses every create.
    const source = text(trust[0].Condition.StringEquals['aws:SourceArn']);
    expect(source).toContain(`:schedule-group/${groupOf(A)}`);
    expect(source).not.toContain(groupOf(B));
    expect(trust[0].Condition.ArnLike).toBeUndefined();
  });

  it('DENY: classification A\'s scheduler role invokes A\'s router and nothing else, so it is refused B\'s router', () => {
    const st = statementsOfRole(A, new RegExp(roleIdOf(A)));
    expect(st).toHaveLength(1);
    expect(list(st[0].Action)).toEqual(['lambda:InvokeFunction']);
    const targets = list(st[0].Resource).map(text);
    expect(targets).toHaveLength(2);
    for (const t of targets) expect(t).toContain(routerOf(A));
    // No wildcard function and no name pattern that another classification's router could match.
    expect(text(st[0].Resource)).not.toMatch(/function:\*|AgentHandler\*|premium/);
    // Every target is this stack's own router by reference, never an ARN written out that could name another's.
    for (const t of list(st[0].Resource)) expect(typeof t).not.toBe('string');
  });

  it('DENY: the router creates and deletes schedules in its own group alone, and passes only its own scheduler role, to the scheduler', () => {
    const st = statementsOfRole(A, /AgentHandlerRole/);
    const sched = st.filter((s) => list(s.Action).some((a) => String(a).startsWith('scheduler:')));
    expect(sched).toHaveLength(1);
    expect(list(sched[0].Action).sort()).toEqual(['scheduler:CreateSchedule', 'scheduler:DeleteSchedule']);
    expect(text(sched[0].Resource)).toContain(`schedule/${groupOf(A)}/*`);
    expect(text(sched[0].Resource)).not.toContain(groupOf(B));
    const pass = st.filter((s) => list(s.Action).includes('iam:PassRole'));
    expect(pass).toHaveLength(1);
    expect(text(pass[0].Resource)).toContain(roleIdOf(A));
    expect(pass[0].Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } });
    // Its environment names its own group and role.
    const env = A[routerOf(A)].Properties!.Environment.Variables;
    expect(env.EVENT_DEADLINE_GROUP).toBe(groupOf(A));
    expect(text(env.EVENT_DEADLINE_ROLE_ARN)).toContain(roleIdOf(A));
  });

  it('a deadline that could not be scheduled raises this classification\'s alarm, through the one notifier', () => {
    const alarms = Object.values(A).filter((r) => r.Type === 'AWS::CloudWatch::Alarm' && /event-deadline-unscheduled$/.test(String(r.Properties?.AlarmName)));
    expect(alarms).toHaveLength(1);
    const p = alarms[0].Properties!;
    expect(p.AlarmName).toMatch(/-standard-event-deadline-unscheduled$/);
    expect(p).toMatchObject({ Namespace: 'AgentEchelon/EventDeadlines', MetricName: 'DeadlineScheduleFailed', Dimensions: [{ Name: 'Classification', Value: 'standard' }], Threshold: 0, ComparisonOperator: 'GreaterThanThreshold', TreatMissingData: 'notBreaching' });
    expect(p.AlarmActions).toHaveLength(1);
    expect(p.OKActions).toEqual(p.AlarmActions);
    const notifier = Object.values(A).find((r) => r.Type === 'AWS::Lambda::Function' && /EventDeadlineAlarmFunction/.test(text(r.Properties?.Role)));
    expect(notifier).toBeDefined();
  });

  it('the router, its ARN parameter and the typed creator carry the audience the shared grants are bounded by', () => {
    const G = synthAssistants('guest');
    const typedCreators = (r: Record<string, Resource>) => Object.entries(r)
      .filter(([id, x]) => x.Type === 'AWS::Lambda::Function' && /^TypedConversationFromEvent[0-9A-F]{8}$/.test(id)).map(([, x]) => x);
    const audienceOf = (r: Record<string, Resource>, id: RegExp, type: string) => {
      const found = Object.entries(r).filter(([k, x]) => x.Type === type && id.test(k));
      expect(found).toHaveLength(1);
      return tagsOf(found[0][1].Properties).audience;
    };
    for (const [r, audience] of [[A, 'members'], [B, 'members'], [G, 'outside']] as const) {
      expect(audienceOf(r, /^AgentHandler[0-9A-F]{8}$/, 'AWS::Lambda::Function')).toBe(audience);
      expect(audienceOf(r, /^RouterArnParam/, 'AWS::SSM::Parameter')).toBe(audience);
      for (const t of typedCreators(r)) expect(tagsOf(t.Properties).audience).toBe(audience);
    }
    // Non-vacuity: a member classification here builds a typed creator.
    expect([...typedCreators(A), ...typedCreators(B)].length).toBeGreaterThan(0);
  });

  it('DENY: the assistant\'s session writes proposal records and no other kind, and reads none', () => {
    const actingId = Object.keys(A).find((id) => A[id].Type === 'AWS::IAM::Role' && /^AssistantActingRole/.test(id))!;
    expect(actingId).toBeDefined();
    const st = statementsOfRole(A, new RegExp(actingId)).filter((s) => /tokens/i.test(text(s.Resource)));
    expect(st).toHaveLength(1);
    expect(list(st[0].Action)).toEqual(['dynamodb:PutItem']);
    expect(st[0].Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['proposal#*'] } });
  });

  it('DENY: the processor\'s own role holds nothing on the token store, so a proposal is never written as nobody', () => {
    const st = statementsOfRole(A, /ProcessorRole/).filter((s) => /tokens/i.test(text(s.Resource)));
    expect(st).toEqual([]);
  });
});

describe('the apply endpoint, the exchange and offboarding (deny tests)', () => {
  const ISSUERS = [{ id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true }];
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], issuers: ISSUERS, widgetUrl: 'https://widget.example.com' } });
  const messaging = new MessagingStack(app, 'Messaging', { env: TEST_ENV, appInstanceName: 'test' });
  const identity = new IdentityStack(app, 'Identity', { env: TEST_ENV, appInstanceArn: messaging.appInstanceArn });
  const conversations = new ConversationsStack(app, 'Conversations', {
    env: TEST_ENV,
    appInstanceArn: messaging.appInstanceArn,
    selfPoolId: identity.selfPoolId,
    offboardingRoleArn: identity.offboardingRoleArn,
    credentialExchangeRoleArn: identity.credentialExchangeRoleArn,
    credentialExchangeFunctionArn: identity.credentialExchangeFunction.functionArn,
    invitationLinkReach: identity.invitationLinkReach,
  });
  const conv = (Template.fromStack(conversations).toJSON() as { Resources: Record<string, Resource> }).Resources;
  const idR = (Template.fromStack(identity).toJSON() as { Resources: Record<string, Resource> }).Resources;
  const apply = statementsOfRole(conv, /ProposalsFunctionServiceRole/);

  it('the apply endpoint is the one person route POST /proposals/apply', () => {
    expect(conversations.routes.filter((r) => r.path === '/proposals/apply').map((r) => `${r.api} ${r.method}`)).toEqual(['person POST']);
  });

  it('DENY: it reads and consumes proposal records alone, and writes no other kind', () => {
    const tokens = apply.filter((s) => text(s.Resource).includes('TokensTable'));
    expect(tokens).toHaveLength(1);
    expect(list(tokens[0].Action).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    expect(tokens[0].Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['proposal#*'] } });
  });

  it('DENY: it reads three attributes of the context row and writes none of it', () => {
    const ctx = apply.filter((s) => text(s.Resource).includes('ChannelContext'));
    expect(ctx).toHaveLength(1);
    expect(list(ctx[0].Action)).toEqual(['dynamodb:GetItem']);
    expect(ctx[0].Condition).toEqual({ 'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['channelArn', 'conversationType', 'participantRoles'] } });
  });

  it('DENY: it invokes the invitations function and the typed creators of member classifications of this instance, and no other function', () => {
    const invokes = apply.filter((s) => list(s.Action).includes('lambda:InvokeFunction'));
    expect(invokes.map((s) => s.Sid).sort()).toEqual(['OpenAConfirmedConversation', 'SendAConfirmedReminder']);
    expect(text(invokes.find((s) => s.Sid === 'SendAConfirmedReminder')!.Resource)).toContain('InvitationsFunction');
    const open = invokes.find((s) => s.Sid === 'OpenAConfirmedConversation')!;
    expect(text(open.Resource)).toMatch(/Assistants-\*-TypedCreator"?$|Assistants-\*-TypedCreator/);
    // Bounded by tags rather than a list, so adding a classification changes nothing here (the deploy matrix).
    const fn = (classification: string, instance = INSTANCE_NAME) => (
      { Instance: instance, classification, audience: profiles.audienceOf(classification) });
    const opens = (tags: Record<string, string>) => admitsTags(open.Condition, tags);
    for (const member of ['basic', 'standard', 'premium']) expect(opens(fn(member))).toBe(true);
    for (const outside of ['guest', 'customer', 'admin']) expect(opens(fn(outside))).toBe(false);
    expect(opens(fn('standard', `${INSTANCE_NAME}-another`))).toBe(false);
    expect(opens({ Instance: INSTANCE_NAME })).toBe(false);
    expect(text(open.Condition)).not.toMatch(/basic|standard|premium|guest|customer/);
    // No SES and no channel write: the act is the invitations function's or the creator's.
    expect(apply.filter((s) => list(s.Action).some((a) => /^ses:|chime:(Send|Create|Delete|Update)/.test(String(a))))).toEqual([]);
  });

  it('DENY: the invitations function deletes no invitation record: a reminder adds a second link beside the first', () => {
    const inv = statementsOfRole(conv, /InvitationsFunctionServiceRole/).filter((s) => list(s.Action).includes('dynamodb:DeleteItem'));
    expect(inv).toEqual([]);
  });

  it.each([['the credential exchange', /CredentialExchangeRole/], ['offboarding', /OffboardingRole/]])(
    "DENY: %s holds no router invoke: a redeemed or deleted invitation's schedule fires, finds nothing pending, and deletes itself",
    (_who, role) => {
      const st = statementsOfRole(idR, role);
      expect(st.filter((s) => s.Sid === 'NameANoticeToTheRouter' || /AgentHandler/.test(text(s.Resource)))).toEqual([]);
      expect(st.filter((s) => s.Sid === 'ReadTheRouterByName')).toEqual([]);
    },
  );
});
