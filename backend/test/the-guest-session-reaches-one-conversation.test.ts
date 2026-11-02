/**
 * THE GUEST ISSUER, AS SYNTHESIZED: ITS KEY, ITS CONTROLS, AND A SESSION ROLE THAT REACHES ONE CONVERSATION.
 *
 * With a guest issuer declared, Identity carries the KMS signing key (`ECC_NIST_P256`, `SIGN_VERIFY`),
 * the throttle alarm, the kill switch under `SSM_ROOT`, the address salt and the guest-session role
 * under its permissions boundary, and the exchange holds `kms:Sign` on the signing key and nothing more
 * of it. The guest-session role is asserted the way IAM would read it with NO session policy: every
 * statement in its policy and its boundary names the one channel the session is tagged with, as the one
 * person it is tagged with, and neither holds `CreateChannel` or `CreateChannelMembership`.
 *
 * Conversations carries `Tokens` (`pk`, TTL on `reclaimAt`), and each writer's grant on it carries
 * `dynamodb:LeadingKeys` limited to its own kinds. Without a guest issuer none of the guest's resources
 * exist. The live proof is `scripts/deny-test-guest.mjs` and `scripts/deny-test-tokens.mjs`.
 */
import { Template } from 'aws-cdk-lib/assertions';
import { conversationsTemplate, identityTemplate } from './helpers/synth';
import { SSM_ROOT } from '../lib/stacks/agent-classification-common';
import { GUEST_REFRESH_THROTTLE, GUEST_START_THROTTLE } from '../lib/constructs/guest-issuer';

const ALL = ['basic', 'standard', 'premium', 'admin'];
const ISSUERS = [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ALL }, admin: true },
  { id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] }, allowedOrigins: ['https://www.example.com'] },
];
const CONTEXT = { issuers: ISSUERS };

type Statement = { Sid?: string; Effect?: string; Action: unknown; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const actions = (st: Statement) => list(st.Action).map(String);
const text = (v: unknown) => JSON.stringify(v);

/** Every statement attached to a role: inline, separate policies and managed policies in the template. */
function statementsOf(t: Template, roleId: string): Statement[] {
  const out: Statement[] = [];
  const role = t.findResources('AWS::IAM::Role')[roleId] as any;
  for (const p of role.Properties.Policies ?? []) out.push(...p.PolicyDocument.Statement);
  for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as any[]) {
    if ((p.Properties.Roles ?? []).some((r: any) => r.Ref === roleId)) out.push(...p.Properties.PolicyDocument.Statement);
  }
  return out;
}
const idOf = (t: Template, type: string, prefix: string): string => {
  const id = Object.keys(t.findResources(type)).find((k) => k.startsWith(prefix));
  if (!id) throw new Error(`no ${type} ${prefix}*`);
  return id;
};

describe('Identity, with a guest issuer', () => {
  const t = identityTemplate(CONTEXT);

  it('holds one P-256 signing key, aliased per generation, deleted on a dev teardown', () => {
    const keys = Object.values(t.findResources('AWS::KMS::Key')) as any[];
    expect(keys).toHaveLength(1);
    expect(keys[0].Properties).toMatchObject({ KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY', PendingWindowInDays: 7 });
    expect(keys[0].DeletionPolicy).toBe('Delete');
    expect((Object.values(t.findResources('AWS::KMS::Alias')) as any[]).map((a) => a.Properties.AliasName)).toEqual([expect.stringMatching(/-guest-guest-g1$/)]);
  });

  it('alarms on a throttled Sign and on a control that could not answer', () => {
    const alarms = (Object.values(t.findResources('AWS::CloudWatch::Alarm')) as any[]).map((a) => a.Properties);
    expect(alarms).toEqual(expect.arrayContaining([
      expect.objectContaining({ MetricName: 'GuestSigningThrottled', Namespace: 'AgentEchelon/Guest', Threshold: 0 }),
      expect.objectContaining({ MetricName: 'GuestRefused', Dimensions: expect.arrayContaining([{ Name: 'Reason', Value: 'unavailable' }]) }),
    ]));
  });

  it('creates the kill switch off, under SSM_ROOT, and a generated address salt', () => {
    const p = (Object.values(t.findResources('AWS::SSM::Parameter')) as any[]).find((x) => x.Properties.Name === `${SSM_ROOT}/guest/guest/paused`);
    expect(JSON.parse(p.Properties.Value)).toMatchObject({ paused: false });
    expect(Object.keys(t.findResources('AWS::SecretsManager::Secret')).some((k) => k.startsWith('GuestIssuerAddressSalt'))).toBe(true);
  });

  it('lets the exchange sign with the guest key alone, and nothing else may', () => {
    const exchange = statementsOf(t, idOf(t, 'AWS::IAM::Role', 'CredentialExchangeRole'));
    const sign = exchange.filter((s) => actions(s).includes('kms:Sign'));
    expect(sign).toHaveLength(1);
    expect(text(sign[0].Resource)).toContain('GuestIssuerSigningKeyG1');
    for (const roleId of Object.keys(t.findResources('AWS::IAM::Role'))) {
      if (roleId.startsWith('CredentialExchangeRole')) continue;
      expect({ roleId, signs: statementsOf(t, roleId).some((s) => actions(s).some((a) => a === 'kms:Sign' || a === 'kms:*')) }).toEqual({ roleId, signs: false });
    }
  });

  describe('the guest-session role, read as IAM reads it with no session policy', () => {
    const roleId = idOf(t, 'AWS::IAM::Role', 'GuestIssuerSessionRole');
    const role = t.findResources('AWS::IAM::Role')[roleId] as any;
    const boundaryId = idOf(t, 'AWS::IAM::ManagedPolicy', 'GuestIssuerSessionBoundary');
    const boundary = (t.findResources('AWS::IAM::ManagedPolicy')[boundaryId] as any).Properties.PolicyDocument.Statement as Statement[];
    const own = statementsOf(t, roleId);

    it('trusts only the exchange, and only with the person, channel and guest classification tags', () => {
      const trust = role.Properties.AssumeRolePolicyDocument.Statement as Array<Statement & { Principal: unknown }>;
      for (const st of trust) {
        expect(text(st.Principal)).toContain('CredentialExchangeRole');
        expect(st.Condition).toEqual({
          StringLike: { 'aws:RequestTag/person': '*', 'aws:RequestTag/channel': '*' },
          StringEquals: { 'aws:RequestTag/classification': 'guest' },
        });
      }
      expect(trust.map((s) => actions(s)).flat().sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    });

    it('sits under its boundary', () => {
      expect(text(role.Properties.PermissionsBoundary)).toContain(boundaryId);
    });

    it.each([['its own policy', () => own], ['its boundary', () => boundary]])('in %s, holds no CreateChannel, no CreateChannelMembership, and nothing outside the read-and-post set', (_l, of) => {
      const allowed = of().filter((s) => s.Effect !== 'Deny').flatMap(actions);
      expect(allowed).not.toEqual(expect.arrayContaining(['chime:CreateChannel']));
      expect(allowed).not.toEqual(expect.arrayContaining(['chime:CreateChannelMembership']));
      expect(allowed.some((a) => a.includes('*'))).toBe(false);
      expect([...new Set(allowed)].sort()).toEqual([
        'chime:Connect', 'chime:DescribeChannel', 'chime:GetChannelMessage', 'chime:GetMessagingSessionEndpoint',
        'chime:ListChannelMemberships', 'chime:ListChannelMessages', 'chime:SendChannelMessage', 'chime:UpdateChannelReadMarker',
      ]);
    });

    it.each([['its own policy', () => own], ['its boundary', () => boundary]])('in %s, names one channel (its session tag, at the guest classification) and one person', (_l, of) => {
      for (const st of of().filter((s) => s.Effect !== 'Deny')) {
        const resources = list(st.Resource).map(text);
        if (actions(st).includes('chime:GetMessagingSessionEndpoint')) { expect(resources).toEqual(['"*"']); continue; }
        for (const r of resources) {
          expect(r.includes('/channel/${aws:PrincipalTag/channel}') || r.includes('/user/${aws:PrincipalTag/person}')).toBe(true);
        }
        if (resources.some((r) => r.includes('/channel/'))) {
          expect(st.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/classification': 'guest' } });
        }
      }
    });
  });

  it('serves guest start and refresh with no authorizer and a route throttle each, on the exchange', () => {
    // The routes are on PersonApi; their declaration is Identity's, as data.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { identityStacks } = require('./helpers/synth') as typeof import('./helpers/synth');
    const routes = identityStacks(CONTEXT).identity.routes.map((r) => ({ key: `${r.method} ${r.path}`, auth: r.auth ?? 'person', throttle: r.throttle }));
    expect(routes).toEqual([
      { key: 'POST /exchange-credentials', auth: 'person', throttle: undefined },
      { key: 'POST /guest/start', auth: 'none', throttle: GUEST_START_THROTTLE },
      { key: 'POST /guest/refresh', auth: 'none', throttle: GUEST_REFRESH_THROTTLE },
      // The invitation landing page's read, on the same exchange (M-5).
      { key: 'POST /invitations/peek', auth: 'none', throttle: { rate: 10, burst: 20 } },
    ]);
    const fns = identityStacks(CONTEXT).identity.routes.map((r) => r.handler);
    expect(new Set(fns).size).toBe(1);
  });

  it('builds none of it without a guest issuer', () => {
    const plain = identityTemplate({});
    expect(Object.keys(plain.findResources('AWS::KMS::Key'))).toEqual([]);
    expect(Object.keys(plain.findResources('AWS::IAM::Role')).some((k) => k.startsWith('GuestIssuer'))).toBe(false);
    expect((Object.values(plain.findResources('AWS::Lambda::Function')) as any[]).some((f) => text(f).includes('GUEST_CONFIG'))).toBe(false);
  });

  it('mints no classification role for the outside classification', () => {
    expect(Object.keys(t.findResources('AWS::IAM::Role')).some((k) => /^ExchangeRoleGuest/.test(k))).toBe(false);
  });
});

describe('Conversations: the token store and its grants', () => {
  const t = conversationsTemplate(CONTEXT);

  it('keys Tokens by `pk`, with TTL on `reclaimAt`, and one index, which only an invitation record is on', () => {
    const [table] = Object.entries(t.findResources('AWS::DynamoDB::Table')).filter(([k]) => k.startsWith('TokensTable')).map(([, v]) => v as any);
    expect(table.Properties.KeySchema).toEqual([{ AttributeName: 'pk', KeyType: 'HASH' }]);
    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'reclaimAt', Enabled: true });
    // A token is found by its hash and nothing else; the one index lists a conversation's invitations (M-10).
    expect(table.Properties.GlobalSecondaryIndexes.map((g: { IndexName: string }) => g.IndexName)).toEqual(['invitationsByChannel']);
  });

  it('grants every Tokens write only under the writer\'s own kinds', () => {
    const statements = (Object.values(t.findResources('AWS::IAM::Policy')) as any[]).flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
    const writes = /^(dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem|\*)|\*)$/;
    const onTokens = statements.filter((s) => text(s.Resource).includes('TokensTable') && [].concat(s.Action as never).some((a) => writes.test(String(a))));
    expect(onTokens.length).toBeGreaterThan(0);
    // Each writer's own kinds: the exchange's three guest kinds (the refresh, its family and the sign-in hand-off) and the invitation it consumes, path B's
    // registration and claim, offboarding's deletes of a person's tokens and a registration record, and the apply
    // endpoint's consume of a proposal. No write on Tokens is unconditioned.
    const kindsOf = (st: Statement) => st.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'];
    for (const st of onTokens) {
      expect([['guest-refresh#*', 'guest-family#*', 'guest-bind#*'], ['invitation#*'], ['registration#*', 'claim#*'], ['registration#*'], ['reply#*', 'unsubscribe#*', 'claim#*', 'invitation#*'], ['proposal#*']])
        .toContainEqual(kindsOf(st));
    }
    // The apply endpoint writes proposals and no other kind.
    const proposals = (Object.values(t.findResources('AWS::IAM::Policy')) as any[])
      .filter((p) => text(p.Properties.Roles).includes('ProposalsFunctionServiceRole'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[])
      .filter((s) => onTokens.includes(s));
    expect(proposals.map(kindsOf)).toEqual([['proposal#*']]);
    expect(onTokens.filter((s) => text(kindsOf(s)) === text(['proposal#*']))).toEqual(proposals);
    const exchange = (Object.values(t.findResources('AWS::IAM::Policy')) as any[])
      .filter((p) => text(p.Properties.Roles).includes('CredentialExchangeRole'))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[])
      .filter((s) => text(s.Resource).includes('TokensTable'));
    // The registration kind is a READ: a bind seeds its continuation from the visit's registration.
    expect(exchange.map(kindsOf)).toEqual([['guest-refresh#*', 'guest-family#*', 'guest-bind#*'], ['registration#*'], ['invitation#*']]);
    expect(exchange.find((s) => text(kindsOf(s)) === text(['registration#*']))!.Action).toEqual('dynamodb:GetItem');
  });

  it('lets the exchange count an address under `guest-ip#` alone, and invoke the guest creator, which the person API cannot', () => {
    const policies = Object.values(t.findResources('AWS::IAM::Policy')) as any[];
    const imported = policies.filter((p) => text(p.Properties.Roles).includes('CredentialExchangeRole'));
    const st = imported.flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
    expect(st.find((s) => s.Sid === 'GuestAddressLimit')?.Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['guest-ip#*'] } });
    // The guest classification's creator, by the creators' name pattern and its own classification tag.
    const creator = st.find((s) => s.Sid === 'GuestConversationCreate')!;
    expect(text(creator.Resource)).toContain('Assistants-*-ConversationCreator');
    expect((creator.Condition as any).StringEquals['aws:ResourceTag/classification']).toBe('guest');
    // The person API reaches a member classification's creator alone, by the creator's audience tag.
    const api = t.findResources('AWS::IAM::Role')[idOf(t, 'AWS::IAM::Role', 'CreateConversationApiRole')] as any;
    const apiInvoke = (api.Properties.Policies as any[]).flatMap((p) => p.PolicyDocument.Statement).find((s: any) => s.Action === 'lambda:InvokeFunction');
    expect(apiInvoke.Condition.StringEquals['aws:ResourceTag/audience']).toBe('members');
    expect(text(api.Properties.Policies)).not.toContain('guest');
  });
});
