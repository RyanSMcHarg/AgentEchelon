/**
 * EVERY ROLE A CREDENTIAL IS MINTED ON, OR THAT SITS ON A PERSON'S REQUEST PATH, CARRIES A PERMISSIONS BOUNDARY
 * (tenet D3, two layers; docs/overview/STACKS.md "Permissions boundaries"). Synthesized, no bundling.
 *
 *  - each person vend role (`ExchangeRole` in each `Assistants-<classification>`, and the admin plane's and
 *    `ExchangeRoleRestricted` in Identity), which a host assertion's session is vended on too: its boundary is its
 *    own bearer-pinned messaging set, statement for statement;
 *  - the admin exchange's roles: the admin plane (its own statements), the console roles (an admin route and
 *    nothing else) and the team attachment read (assistant deliverables alone);
 *  - the edge authorizer, on both APIs: reads of `Identities`, a person's existence, the guest keys' public
 *    halves and an assertion's `jti` under its own kind, never a write to `Identities`;
 *  - the connector runtime's three roles: the services it uses, with every Amazon Chime SDK action but
 *    `DescribeAppInstanceUser` left out, every secret but its connectors' denied, and every `Identities` write
 *    denied.
 *
 * The live half is `backend/scripts/deny-test-permission-boundaries.mjs`.
 */
import * as cdk from 'aws-cdk-lib';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { Template } from 'aws-cdk-lib/assertions';
import { generateKeyPairSync } from 'crypto';
import { MessagingStack } from '../lib/stacks/messaging-stack';
import { IdentityStack } from '../lib/stacks/identity-stack';
import { ConversationsStack } from '../lib/stacks/conversations-stack';
import { PersonApiStack } from '../lib/stacks/person-api-stack';
import { ConnectorsStack } from '../lib/stacks/connectors-stack';
import { provisionerIssuers } from '../lib/constructs/subject-provisioner';
import { issuersOf } from '../lib/constructs/trusted-issuers';
import { connectorsOf } from '../lib/constructs/connectors';
import { adminServicesStacks, CLASSIFICATION_TEST_PROPS } from './helpers/synth';
import { assistantsOf } from './helpers/assistants';

const env = { account: '111122223333', region: 'us-east-1' };
const KEY = (generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
const DEPLOYMENT = { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true };
const HOST = {
  id: 'salesforce-org', kind: 'host-assertion', issuer: 'https://example.my.salesforce.com', allowedOrigins: ['https://example.lightning.force.com'],
  hostAssertion: { publicKeys: { k1: KEY } }, clearance: { mapping: { claim: 'permsets', values: { AE_Sales: 'standard' } }, classifications: ['basic', 'standard'] },
};
const CONNECTORS = [
  { id: 'pagerduty', vendor: 'pagerduty', subscribes: ['incident.trigger'], classification: 'standard', eventSource: 'aws.partner/pagerduty.com/example-oncall' },
  { id: 'crm', vendor: 'salesforce', subscribes: ['Lead_Assigned__e'], classification: 'standard', eventSource: 'aws.partner/salesforce.com/00D5e000000AbCdEAF/0YL5e000000XyZaGAK', grants: { redirectUris: ['https://app.example.com/cb'] } },
];

const app = new cdk.App({ context: { issuers: [DEPLOYMENT, HOST], connectors: CONNECTORS, capabilities: ['chat', 'admin', 'connectors'], [cxapi.BUNDLING_STACKS]: [] } });
const messaging = new MessagingStack(app, 'Messaging', { env, appInstanceName: 'test' });
const identityStack = new IdentityStack(app, 'Identity', {
  env, appInstanceArn: messaging.appInstanceArn,
  subjectProvisioners: provisionerIssuers(issuersOf(messaging), connectorsOf(messaging), new Set(['chat', 'admin', 'connectors'])),
});
const conversations = new ConversationsStack(app, 'Conversations', {
  env, appInstanceArn: messaging.appInstanceArn, selfPoolId: identityStack.selfPoolId,
  offboardingRoleArn: identityStack.offboardingRoleArn, credentialExchangeRoleArn: identityStack.credentialExchangeRoleArn,
});
const personApiStack = new PersonApiStack(app, 'PersonApi', {
  env, routes: identityStack.routes.filter((r) => r.api === 'person'), appInstanceArn: messaging.appInstanceArn,
  selfPoolId: identityStack.selfPoolId, selfClientIds: identityStack.selfClientIds, identities: identityStack.identitiesTable, tokens: conversations.tokensTable,
});
const connectorsStack = new ConnectorsStack(app, 'Connectors', {
  env, appInstanceArn: messaging.appInstanceArn, selfPoolId: identityStack.selfPoolId,
  identities: { tableName: identityStack.identitiesTable.tableName, tableArn: identityStack.identitiesTable.tableArn },
  offboardingRoleArn: identityStack.offboardingRoleArn, subjectProvisioner: identityStack.subjectProvisioners.connectors,
});

// A conversational classification's vend role is its own stack's. Built before the first synthesis.
const basicAssistants = assistantsOf('basic')(app, 'Assistants-basic', {
  ...CLASSIFICATION_TEST_PROPS, env, appInstanceArn: messaging.appInstanceArn, credentialExchangeRoleArn: identityStack.credentialExchangeRoleArn,
} as never);
const identity = Template.fromStack(identityStack);
const basicStack = Template.fromStack(basicAssistants);
const personApi = Template.fromStack(personApiStack);
const connectors = Template.fromStack(connectorsStack);
const admin = adminServicesStacks({});
const adminServices = Template.fromStack(admin.adminServices);
const adminApi = Template.fromStack(admin.adminApi);

type Statement = { Effect: string; Action: string | string[]; Resource?: unknown; NotResource?: unknown; Condition?: unknown; Sid?: string };
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const actionsOf = (sts: Statement[], effect = 'Allow') => [...new Set(sts.filter((s) => s.Effect === effect).flatMap((s) => list(s.Action)))].sort();

/** Each role of a template whose logical id matches, with its boundary's logical id. */
function rolesMatching(t: Template, id: RegExp): Array<{ id: string; boundary: string | null; role: any }> {
  return (Object.entries(t.findResources('AWS::IAM::Role')) as Array<[string, any]>)
    .filter(([rid]) => id.test(rid))
    .map(([rid, role]) => ({ id: rid, role, boundary: role.Properties.PermissionsBoundary?.Ref ?? null }));
}
const boundaryStatements = (t: Template, policyId: string): Statement[] =>
  (t.findResources('AWS::IAM::ManagedPolicy')[policyId] as any).Properties.PolicyDocument.Statement;
/** Every statement a role's identity policies hold: inline, and each `AWS::IAM::Policy` naming it. */
function identityStatements(t: Template, roleId: string): Statement[] {
  const role = t.findResources('AWS::IAM::Role')[roleId] as any;
  const inline = (role.Properties.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement);
  const attached = (Object.values(t.findResources('AWS::IAM::Policy')) as any[])
    .filter((p) => (p.Properties.Roles ?? []).some((r: any) => r.Ref === roleId))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
  return [...inline, ...attached];
}
/** A statement with its Sid removed, for comparing a boundary to the identity policy it mirrors. */
const shape = (s: Statement) => JSON.stringify({ ...s, Sid: undefined });

describe('the person vend roles', () => {
  // Identity's two (the one-conversation role and the admin plane's chat identity), and a classification's own.
  const vend = [
    ...rolesMatching(identity, /^ExchangeRole/).map((r) => ({ ...r, t: identity })),
    ...rolesMatching(basicStack, /^ExchangeRole/).map((r) => ({ ...r, t: basicStack })),
  ];
  // The construct a role is built in (`ExchangeRole` <id>, its role `Role`): CDK drops the repeated `Role` of a
  // construct named `ExchangeRole`, so its role's logical id is the construct's.
  const construct = (id: string) => { const base = id.replace(/[0-9A-F]{8}$/, ''); return base === 'ExchangeRole' ? base : base.replace(/Role$/, ''); };

  it('every role carries a boundary, its own', () => {
    expect(rolesMatching(identity, /^ExchangeRole/).map((r) => construct(r.id)).sort()).toEqual(['ExchangeRoleAdmin', 'ExchangeRoleRestricted']);
    expect(rolesMatching(basicStack, /^ExchangeRole/).map((r) => construct(r.id))).toEqual(['ExchangeRole']);
    for (const r of vend) expect(r.boundary).toMatch(new RegExp(`^${construct(r.id)}Boundary`));
    expect(new Set(vend.map((r) => `${r.t === identity}:${r.boundary}`)).size).toBe(vend.length);
  });

  it('the boundary is the role\'s own reach, statement for statement: the Amazon Chime SDK and nothing else', () => {
    for (const r of vend) {
      const bounded = boundaryStatements(r.t, r.boundary!);
      expect(bounded.map(shape).sort()).toEqual(identityStatements(r.t, r.id).map(shape).sort());
      expect(actionsOf(bounded).every((a) => a.startsWith('chime:'))).toBe(true);
      for (const never of ['chime:CreateChannel', 'chime:CreateChannelMembership', 'chime:CreateAppInstanceUser', 'chime:RedactChannelMessage']) {
        expect(actionsOf(bounded)).not.toContain(never);
      }
    }
  });

  it('a classification role\'s boundary posts in a channel only by its classification tag', () => {
    const basic = rolesMatching(basicStack, /^ExchangeRole/)[0];
    const gated = boundaryStatements(basicStack, basic.boundary!)
      .filter((s) => s.Effect === 'Allow' && list(s.Action).includes('chime:SendChannelMessage')
        && list(s.Resource as string | string[]).some((x) => JSON.stringify(x).includes('/channel/*')));
    expect(gated.length).toBeGreaterThan(0);
    for (const s of gated) expect(JSON.stringify(s.Condition)).toContain('aws:ResourceTag/classification');
  });
});

describe('the admin exchange\'s roles', () => {
  const byId = (re: RegExp) => rolesMatching(adminServices, re)[0];

  it('the admin plane is bounded by its own statements', () => {
    const plane = byId(/^ExchangeRoleAdminPlane/);
    expect(plane.boundary).toMatch(/^ExchangeRoleAdminPlaneBoundary/);
    expect(boundaryStatements(adminServices, plane.boundary!).map(shape).sort())
      .toEqual(identityStatements(adminServices, plane.id).map(shape).sort());
    expect(actionsOf(boundaryStatements(adminServices, plane.boundary!))).not.toContain('chime:CreateAppInstanceUser');
  });

  it('both console roles share one boundary: an admin route and following console events, and nothing else', () => {
    const consoles = [byId(/^AdminConsoleRole/), byId(/^TeamConsoleRole/)];
    expect(new Set(consoles.map((r) => r.boundary))).toEqual(new Set([expect.stringMatching(/^ConsoleRoleBoundary/)]));
    const bounded = boundaryStatements(adminServices, consoles[0].boundary!);
    expect(actionsOf(bounded)).toEqual(['appsync:EventConnect', 'appsync:EventSubscribe', 'execute-api:Invoke']);
    // EVERY GRANT ON A CONSOLE ROLE FITS ITS BOUNDARY: a grant outside it is refused at runtime however the role reads,
    // which is how a subscribe grant once deployed and was refused. Publish stays out of both.
    for (const role of consoles) {
      const granted = actionsOf(identityStatements(adminServices, role.id));
      expect({ role: role.id, outside: granted.filter((a) => !actionsOf(bounded).includes(a)) }).toEqual({ role: role.id, outside: [] });
      expect(granted).not.toContain('appsync:EventPublish');
    }
    // What AdminApi grants each console role stays inside it.
    const grants = (Object.values(adminApi.findResources('AWS::IAM::ManagedPolicy')) as any[])
      .filter((p) => JSON.stringify(p.Properties.Roles ?? []).match(/ConsoleRole/))
      .flatMap((p) => p.Properties.PolicyDocument.Statement);
    expect(grants.length).toBeGreaterThan(0);
    expect(actionsOf(grants)).toEqual(['execute-api:Invoke']);
  });

  it('the team attachment read reaches assistant deliverables alone', () => {
    const team = byId(/^TeamAttachmentRole/);
    const bounded = boundaryStatements(adminServices, team.boundary!);
    expect(actionsOf(bounded)).toEqual(['s3:GetObject']);
    expect(JSON.stringify(bounded)).toContain('/generated-docs/*');
    expect(JSON.stringify(bounded)).not.toContain('/attachments/*');
  });
});

describe('the edge authorizer', () => {
  for (const [plane, t] of [['person', personApi], ['admin', adminApi]] as const) {
    it(`(${plane}) reads Identities and never writes them, whatever is attached to it`, () => {
      const roles = rolesMatching(t, /EdgeAuthorizerFnServiceRole/);
      expect(roles).toHaveLength(1);
      const bounded = boundaryStatements(t, roles[0].boundary!);
      const allowed = actionsOf(bounded);
      for (const a of allowed) expect(['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'dynamodb:GetItem', 'dynamodb:Query', 'chime:DescribeAppInstanceUser', 'kms:GetPublicKey', 'dynamodb:PutItem']).toContain(a);
      const onIdentities = bounded.filter((s) => JSON.stringify(s.Resource).includes('IdentitiesTable'));
      expect(actionsOf(onIdentities)).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
      // The one write: an assertion's jti, on the person plane where a host-assertion issuer is declared.
      const writes = bounded.filter((s) => list(s.Action).includes('dynamodb:PutItem'));
      if (plane === 'person') {
        expect(writes).toHaveLength(1);
        expect(JSON.stringify(writes[0].Resource)).toContain('TokensTable');
        expect(writes[0].Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['assertion-jti#*'] } });
      } else {
        expect(writes).toHaveLength(0);
      }
    });
  }
});

describe('the connector runtime', () => {
  const roles = rolesMatching(connectors, /^Connector(EventReceiver|GrantRoutes|GrantRevoker)Role/);

  it('all three roles carry the one runtime boundary', () => {
    expect(roles).toHaveLength(3);
    expect(new Set(roles.map((r) => r.boundary))).toEqual(new Set([expect.stringMatching(/^ConnectorRuntimeBoundary/)]));
  });

  it('no Amazon Chime SDK action but DescribeAppInstanceUser; no secret but its own connectors\'; no Identities write', () => {
    const bounded = boundaryStatements(connectors, roles[0].boundary!);
    expect(actionsOf(bounded).filter((a) => a.startsWith('chime:'))).toEqual(['chime:DescribeAppInstanceUser']);
    expect(actionsOf(bounded).some((a) => a.includes('*') && !a.startsWith('kms:GenerateDataKey'))).toBe(false);
    const secretDeny = bounded.find((s) => s.Effect === 'Deny' && list(s.Action).includes('secretsmanager:GetSecretValue'))!;
    expect(JSON.stringify(secretDeny.NotResource)).toContain('/connector/*');
    const identitiesDeny = bounded.find((s) => s.Effect === 'Deny' && list(s.Action).includes('dynamodb:PutItem'))!;
    expect(JSON.stringify(identitiesDeny.Resource)).toContain('IdentitiesTable');
    expect(list(identitiesDeny.Action).sort()).toEqual(['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
  });

  it('every action a runtime role is granted is inside the boundary', () => {
    const allowed = new Set(actionsOf(boundaryStatements(connectors, roles[0].boundary!)));
    const covers = (a: string) => allowed.has(a) || [...allowed].some((c) => c.endsWith('*') && a.startsWith(c.slice(0, -1)));
    for (const r of roles) {
      for (const a of actionsOf(identityStatements(connectors, r.id))) expect([r.id, a, covers(a)]).toEqual([r.id, a, true]);
    }
  });
});
