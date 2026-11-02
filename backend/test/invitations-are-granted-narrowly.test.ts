/**
 * INVITATIONS ARE GRANTED NARROWLY, LAYER BY LAYER (M-10, A8, tenet D3).
 *
 * Synthesized, the invitation's three writers and the `link` session hold exactly their halves:
 *
 *  - the invitations function (Conversations) writes `invitation#*` records and no other kind, lists through
 *    the one sparse index, adds and removes members only as the service admin in a channel of a member
 *    classification, and invokes the credential exchange and nothing else;
 *  - the credential exchange reads and consumes `invitation#*` and never puts one, so it cannot issue an
 *    invitation; it removes an invitee's expiration;
 *  - the `link` session role (Identity) is assumable by the exchange only with the `person`, `channel` and
 *    `classification` session tags, the last one of the classifications the issuer declares; its policy and
 *    its permissions boundary reach the one tagged channel at the session's own classification, as the
 *    tagged invitee, with the read-and-post set, and no `CreateChannel`, membership change or model;
 *  - `Tokens` gains one index, keyed on what only an invitation record carries;
 *  - the landing page (`invite.html`) is served never framed, with no referrer;
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MessagingStack } from '../lib/stacks/messaging-stack';
import { IdentityStack } from '../lib/stacks/identity-stack';
import { ConversationsStack } from '../lib/stacks/conversations-stack';
import { WidgetStack } from '../lib/stacks/widget-stack';
import { INVITATIONS_BY_CHANNEL, INVITATION_CHANNEL_ATTRIBUTE } from '../lambda/src/lib/invitations';
import { LINK_SESSION_ACTIONS } from '../lib/constructs/invitation-link-issuer';
import { CAPABILITY_RESOURCES, INSTANCE_NAME, SSM_ROOT } from '../lib/stacks/agent-classification-common';
import { defaultProfileRegistry as profiles } from '../lib/profile-registry';
import { admitsTags } from './helpers/tag-condition';
import { TEST_ENV } from './helpers/synth';

type Statement = { Sid?: string; Effect?: string; Action: unknown; Resource: unknown; Condition?: Record<string, Record<string, unknown>>; Principal?: unknown };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const text = (v: unknown) => JSON.stringify(v);

const ISSUERS = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
  { id: 'invitation', kind: 'invitation-link', clearance: { fixed: ['basic', 'standard'], classifications: ['basic', 'standard'] } },
];

const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], issuers: ISSUERS, appUrl: 'https://app.example.com', widgetUrl: 'https://widget.example.com' } });
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
  transactionalMail: true,
});
const widget = new WidgetStack(app, 'Widget', { env: TEST_ENV });
const conv = Template.fromStack(conversations);
const idT = Template.fromStack(identity);
const widgetT = Template.fromStack(widget);

function statementsOfRole(t: Template, rolePattern: RegExp): Statement[] {
  const out: Statement[] = [];
  for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as any[]) {
    if (text(p.Properties.Roles).match(rolePattern)) out.push(...p.Properties.PolicyDocument.Statement);
  }
  for (const p of Object.values(t.findResources('AWS::IAM::ManagedPolicy')) as any[]) {
    if (text(p.Properties.Roles ?? '').match(rolePattern)) out.push(...p.Properties.PolicyDocument.Statement);
  }
  for (const [id, r] of Object.entries(t.findResources('AWS::IAM::Role')) as Array<[string, any]>) {
    if (!rolePattern.test(id)) continue;
    for (const pol of r.Properties.Policies ?? []) out.push(...pol.PolicyDocument.Statement);
  }
  return out;
}

describe('the invitations function', () => {
  const st = statementsOfRole(conv, /InvitationsFunctionServiceRole/);

  it('exists, on the person routes', () => {
    const fns = Object.values(conv.findResources('AWS::Lambda::Function')) as any[];
    const fn = fns.find((f) => f.Properties.Environment?.Variables?.CREDENTIAL_EXCHANGE_FUNCTION);
    expect(fn).toBeDefined();
    // EVERY INVITATION LANDS IN THE CHAT APP (`invitationLandingFor`), a declared widget notwithstanding.
    expect(fn.Properties.Environment.Variables.INVITATION_LANDING_ORIGIN).toBe('https://app.example.com');
    expect(JSON.parse(fn.Properties.Environment.Variables.INVITATION_LINK_REACH)).toEqual(['basic', 'standard']);
    expect(conversations.routes.filter((r) => r.path.startsWith('/invitations')).map((r) => `${r.method} ${r.path}`).sort())
      .toEqual(['GET /invitations', 'POST /invitations', 'POST /invitations/revoke']);
  });

  it('writes the invitation kind in Tokens and no other', () => {
    const onTokens = st.filter((s) => text(s.Resource).includes('TokensTable') && list(s.Action).some((a) => /dynamodb:(Put|Update|Delete)/.test(String(a))));
    expect(onTokens.length).toBeGreaterThan(0);
    for (const s of onTokens) {
      if (text(s.Resource).includes('/index/')) continue;
      expect(s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']).toEqual(
        list(s.Action).includes('dynamodb:PutItem') && s.Sid === 'WriteEmailTokens' ? ['unsubscribe#*', 'reply#*'] : ['invitation#*'],
      );
    }
    const query = st.filter((s) => list(s.Action).includes('dynamodb:Query') && text(s.Resource).includes('TokensTable'));
    expect(text(query.map((s) => s.Resource))).toContain(`/index/${INVITATIONS_BY_CHANNEL}`);
  });

  it('changes membership only as the service admin, in a classified channel whose audience is the deployment\'s own people', () => {
    const membership = st.filter((s) => list(s.Action).includes('chime:CreateChannelMembership') && s.Effect !== 'Deny');
    expect(membership).toHaveLength(2);
    // Any conversation's classification, by its tag being present, and never the admin plane's: no list.
    const channel = membership.find((s) => text(s.Resource).includes('/channel/'))!;
    expect(channel.Condition?.Null?.['aws:ResourceTag/classification']).toBe('false');
    expect(channel.Condition?.StringEquals?.['aws:ResourceTag/classification']).toBeUndefined();
    // The second layer under the handler: never an outside conversation, and never one with no audience.
    const denied = st.filter((s) => s.Effect === 'Deny' && list(s.Action).includes('chime:CreateChannelMembership'));
    expect(denied.map((s) => s.Condition)).toEqual([
      { StringEquals: { 'aws:ResourceTag/audience': 'outside' } },
      { Null: { 'aws:ResourceTag/audience': 'true' } },
    ]);
    expect(denied.every((s) => text(s.Resource).includes('/channel/*'))).toBe(true);
    const bearer = membership.find((s) => !text(s.Resource).includes('/channel/'))!;
    expect(text(bearer.Resource)).toContain('-admin');
    expect(text(bearer.Resource)).not.toContain('/user/*');
  });

  it('invokes the credential exchange and no other function, and names the Notifications mail sender', () => {
    const invokes = st.filter((s) => list(s.Action).includes('lambda:InvokeFunction') && s.Sid !== 'NameANoticeToTheRouter');
    expect(invokes).toHaveLength(1);
    expect(text(invokes[0].Resource)).toContain('CredentialExchangeFunction');
    const fns = Object.values(conv.findResources('AWS::Lambda::Function')) as any[];
    const fn = fns.find((f) => f.Properties.Environment?.Variables?.CREDENTIAL_EXCHANGE_FUNCTION);
    expect(fn.Properties.Environment.Variables.TRANSACTIONAL_MAIL_FUNCTION).toBe(CAPABILITY_RESOURCES.transactionalMail);
  });

  it('names invitation-sent only to the routers of the classifications a person may be invited into (ADR-061, deny test)', () => {
    const routers = st.filter((s) => s.Sid === 'NameANoticeToTheRouter');
    expect(routers).toHaveLength(1);
    expect(list(routers[0].Action)).toEqual(['lambda:InvokeFunction']);
    // A router, found by its construct id, of this instance and of a member classification: never a guest's or the
    // admin plane's, and never any other function.
    expect(text(routers[0].Resource)).toMatch(/-AgentHandler\*/);
    // Bounded by tags, not by a list, so adding a classification changes nothing here (the deploy matrix's additivity).
    const fn = (classification: string, instance = INSTANCE_NAME) => (
      { Instance: instance, classification, audience: profiles.audienceOf(classification) });
    const invokes = (tags: Record<string, string>) => admitsTags(routers[0].Condition, tags);
    for (const member of ['basic', 'standard', 'premium']) expect(invokes(fn(member))).toBe(true);
    expect(invokes(fn('guest'))).toBe(false);
    expect(invokes(fn('customer'))).toBe(false);
    expect(invokes(fn('admin'))).toBe(false);
    expect(invokes(fn('standard', `${INSTANCE_NAME}-another`))).toBe(false);
    expect(invokes({ Instance: INSTANCE_NAME })).toBe(false);
    expect(text(routers[0].Condition)).not.toMatch(/basic|standard|premium|guest|customer/);
    // It reads only those routers' ARN parameters, under this instance's path, and resolves no room primary: the
    // router verifies the record.
    const params = st.filter((s) => s.Sid === 'ReadTheRouterByName');
    expect(params).toHaveLength(1);
    expect(list(params[0].Action)).toEqual(['ssm:GetParameter']);
    expect(text(params[0].Resource)).toContain(`parameter${SSM_ROOT}/assistant/*/router-arn`);
    const param = (classification: string) => ({ classification, audience: profiles.audienceOf(classification) });
    const reads = (tags: Record<string, string>) => admitsTags(params[0].Condition, tags, 'ssm:resourceTag/');
    expect(reads(param('standard'))).toBe(true);
    expect(reads(param('guest'))).toBe(false);
    expect(reads(param('customer'))).toBe(false);
    expect(reads(param('admin'))).toBe(false);
    expect(reads({})).toBe(false);
  });

  // DESIGN-CONVERSATION-TYPES section 6.1: an invitation's participant role is the invitee's holding, and a role that
  // confers `moderator` makes them one. Both grants are the narrowest that do it.
  it('writes only the participantRoles attribute of the context row, and nothing else of it (deny test)', () => {
    const writes = st.filter((s) => text(s.Resource).includes('ChannelContextTable') && list(s.Action).some((a) => /dynamodb:(Put|Update|Delete|BatchWrite)/.test(String(a))));
    expect(writes).toHaveLength(1);
    expect(list(writes[0].Action)).toEqual(['dynamodb:UpdateItem']);
    expect(text(writes[0].Resource)).not.toContain('/index/');
    expect(writes[0].Condition?.['ForAllValues:StringEquals']?.['dynamodb:Attributes']).toEqual(['channelArn', 'participantRoles']);
    expect(writes[0].Condition?.StringEqualsIfExists?.['dynamodb:ReturnValues']).toEqual(['NONE']);
  });

  it('makes and unmakes a moderator only as the service admin, never in an outside conversation (deny test)', () => {
    const moderation = st.filter((s) => s.Effect !== 'Deny' && list(s.Action).some((a) => a === 'chime:CreateChannelModerator' || a === 'chime:DeleteChannelModerator'));
    expect(moderation).toHaveLength(2);
    for (const s of moderation) expect(list(s.Action)).toEqual(expect.arrayContaining(['chime:CreateChannelModerator', 'chime:DeleteChannelModerator']));
    const bearer = moderation.find((s) => !text(s.Resource).includes('/channel/'))!;
    expect(text(bearer.Resource)).toContain('-admin');
    expect(text(bearer.Resource)).not.toContain('/user/*');
    const denied = st.filter((s) => s.Effect === 'Deny' && list(s.Action).includes('chime:CreateChannelModerator'));
    expect(denied.map((s) => s.Condition)).toEqual([
      { StringEquals: { 'aws:ResourceTag/audience': 'outside' } },
      { Null: { 'aws:ResourceTag/audience': 'true' } },
    ]);
  });

  it('holds no SES send: the invitation email is sent by Notifications', () => {
    expect(st.filter((s) => list(s.Action).some((a) => String(a).startsWith('ses:')))).toEqual([]);
  });
});

describe('the credential exchange', () => {
  it('reads and consumes an invitation, and never puts one', () => {
    const exchange = (Object.values(conv.findResources('AWS::IAM::Policy')) as any[])
      .filter((p) => text(p.Properties.Roles).includes('CredentialExchangeRole'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[])
      .filter((s) => text(s.Condition).includes('invitation#*'));
    expect(exchange).toHaveLength(1);
    expect(list(exchange[0].Action).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
  });

  it('removes an invitee\'s expiration, and carries the invitation configuration', () => {
    const st = statementsOfRole(idT, /CredentialExchangeRole/);
    expect(st.some((s) => s.Sid === 'InviteeExpiration' && list(s.Action).includes('chime:PutAppInstanceUserExpirationSettings'))).toBe(true);
    const fn = (Object.values(idT.findResources('AWS::Lambda::Function')) as any[]).find((f) => f.Properties.Environment?.Variables?.INVITATION_CONFIG);
    expect(text(fn.Properties.Environment.Variables.INVITATION_CONFIG)).toContain('tokensTableParameter');
  });

  it('serves the landing page\'s read and the link redemption, unauthenticated and throttled', () => {
    const routes = identity.routes.filter((r) => r.path.startsWith('/invitations')).map((r) => `${r.method} ${r.path} ${r.auth} ${r.throttle?.rate}`);
    expect(routes.sort()).toEqual(['POST /invitations/peek none 10', 'POST /invitations/redeem none 5']);
  });
});

describe('the link session role', () => {
  const roles = idT.findResources('AWS::IAM::Role');
  const [roleId, role] = Object.entries(roles).find(([id]) => id.startsWith('InvitationLinkIssuerSessionRole')) as [string, any];

  it('is assumable by the exchange only with the three session tags, at a classification the issuer declares', () => {
    const trust = role.Properties.AssumeRolePolicyDocument.Statement as Statement[];
    for (const s of trust) {
      expect(text(s.Principal)).toContain('CredentialExchangeRole');
      expect(s.Condition?.StringEquals?.['aws:RequestTag/classification']).toEqual(['basic', 'standard']);
      expect(s.Condition?.StringLike).toEqual({ 'aws:RequestTag/person': '*', 'aws:RequestTag/channel': '*' });
    }
    expect(role.Properties.PermissionsBoundary).toBeDefined();
  });

  it('reaches the tagged channel at the session\'s own classification, as the tagged invitee, and nothing more', () => {
    const own = statementsOfRole(idT, new RegExp(roleId));
    const boundaryId = Object.keys(idT.findResources('AWS::IAM::ManagedPolicy')).find((id) => id.startsWith('InvitationLinkIssuerSessionBoundary'))!;
    const boundary = (idT.findResources('AWS::IAM::ManagedPolicy')[boundaryId] as any).Properties.PolicyDocument.Statement as Statement[];
    for (const set of [own, boundary]) {
      const allowed = set.filter((s) => s.Effect !== 'Deny').flatMap((s) => list(s.Action).map(String));
      expect(allowed.filter((a) => /Create|Delete|Membership(?!s)|bedrock|s3:/i.test(a) && a !== 'chime:ListChannelMemberships')).toEqual([]);
      const channel = set.find((s) => s.Sid === 'TheInvitedConversation')!;
      expect(text(channel.Resource)).toContain('${aws:PrincipalTag/channel}');
      expect(channel.Condition?.StringEquals?.['aws:ResourceTag/classification']).toBe('${aws:PrincipalTag/classification}');
      expect(list(channel.Action).sort()).toEqual([...LINK_SESSION_ACTIONS].sort());
      expect(text(set.find((s) => s.Sid === 'ConnectAsTheInvitee')!.Resource)).toContain('${aws:PrincipalTag/person}');
    }
  });

  it('is not built where the registry declares no invitation-link issuer', () => {
    const plain = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const m = new MessagingStack(plain, 'Messaging', { env: TEST_ENV, appInstanceName: 'test' });
    const i = new IdentityStack(plain, 'Identity', { env: TEST_ENV, appInstanceArn: m.appInstanceArn });
    expect(Object.keys(Template.fromStack(i).findResources('AWS::IAM::Role')).filter((id) => id.startsWith('InvitationLink'))).toEqual([]);
    expect(i.routes.map((r) => r.path)).not.toContain('/invitations/redeem');
    expect(i.invitationLinkReach).toBeUndefined();
  });
});

describe('the token store and the landing page', () => {
  it('Tokens has one index, keyed on what only an invitation carries', () => {
    const [table] = Object.entries(conv.findResources('AWS::DynamoDB::Table')).filter(([k]) => k.startsWith('TokensTable')).map(([, v]) => v as any);
    expect(table.Properties.GlobalSecondaryIndexes).toEqual([expect.objectContaining({
      IndexName: INVITATIONS_BY_CHANNEL,
      KeySchema: [{ AttributeName: INVITATION_CHANNEL_ATTRIBUTE, KeyType: 'HASH' }, { AttributeName: 'createdAt', KeyType: 'RANGE' }],
    })]);
  });

  it('serves invite.html never framed and with no referrer', () => {
    const dist = Object.values(widgetT.findResources('AWS::CloudFront::Distribution'))[0] as any;
    const behaviors = dist.Properties.DistributionConfig.CacheBehaviors as any[];
    expect(behaviors.map((b) => b.PathPattern)).toEqual(['invite.html']);
    const policyId = behaviors[0].ResponseHeadersPolicyId.Ref;
    const policy = (widgetT.findResources('AWS::CloudFront::ResponseHeadersPolicy')[policyId] as any).Properties.ResponseHeadersPolicyConfig;
    expect(policy.SecurityHeadersConfig.ReferrerPolicy.ReferrerPolicy).toBe('no-referrer');
    expect(policy.SecurityHeadersConfig.FrameOptions.FrameOption).toBe('DENY');
    expect(policy.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy).toContain("frame-ancestors 'none'");
  });
});
