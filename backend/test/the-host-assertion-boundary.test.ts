/**
 * THE HOST-ASSERTION BOUNDARY, AT SYNTH (A9, A8, P-13; the boundary rows "Edge authorizer" and
 * "`host-assertion` session").
 *
 * With a `host-assertion` issuer declared, and the `admin` and `connectors` callers present:
 *
 *  - the edge authorizer may write `Tokens` under `assertion-jti#*` and no other kind, and only `PutItem`
 *    (it records a `jti`, never consumes one);
 *  - the credential exchange may `GetItem` and `UpdateItem` `assertion-jti#*` and never `PutItem` it (it
 *    consumes the record the edge wrote, and cannot write one the edge did not), and may `UpdateItem`
 *    `Identities` only under the provisioned-only issuers' keys (the bind);
 *  - each subject provisioner is its own function, with its caller fixed in its environment, and its role
 *    may `PutItem` `Identities` only under its own issuers' keys, with a `pending` row's attributes, and
 *    holds no `UpdateItem` or `DeleteItem`; only the administrator's may ask whether a person exists;
 *  - only user management (AdminServices) and the webhook receiver (Connectors) are granted the invoke,
 *    each of its own provisioner.
 *
 * Without one, none of it is built. The live half is `backend/scripts/deny-test-host-assertion.mjs` and
 * `backend/scripts/deny-test-pending-identities.mjs`.
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
import { PENDING_ROW_ATTRIBUTES, provisionerIssuers } from '../lib/constructs/subject-provisioner';
import { issuersOf } from '../lib/constructs/trusted-issuers';
import { connectorsOf } from '../lib/constructs/connectors';

const env = { account: '111122223333', region: 'us-east-1' };
const KEY = (generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
const DEPLOYMENT = { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true };
const HOST = {
  id: 'salesforce-org', kind: 'host-assertion', issuer: 'https://example.my.salesforce.com', allowedOrigins: ['https://example.lightning.force.com'],
  hostAssertion: { publicKeys: { k1: KEY } }, clearance: { mapping: { claim: 'permsets', values: { AE_Sales: 'standard' } }, classifications: ['basic', 'standard'] },
};
const CONNECTORS = [
  { id: 'pagerduty', vendor: 'pagerduty', subscribes: ['incident.trigger'], classification: 'standard', eventSource: 'aws.partner/pagerduty.com/example-oncall' },
  { id: 'sfdc', vendor: 'salesforce', subscribes: ['Lead_Assigned__e'], classification: 'standard', personIssuer: 'salesforce-org', eventSource: 'aws.partner/salesforce.com/00D5e000000AbCdEAF/0YL5e000000XyZaGAK' },
];

type Statement = { Effect?: string; Action: unknown; Resource: unknown; Condition?: Record<string, Record<string, unknown>>; Sid?: string };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

function synth(issuers: unknown[], connectors: unknown[] = CONNECTORS) {
  const app = new cdk.App({ context: { issuers, connectors, capabilities: ['chat', 'admin', 'connectors'], [cxapi.BUNDLING_STACKS]: [] } });
  const messaging = new MessagingStack(app, 'Messaging', { env, appInstanceName: 'test' });
  const registry = issuersOf(messaging);
  const identity = new IdentityStack(app, 'Identity', {
    env,
    appInstanceArn: messaging.appInstanceArn,
    subjectProvisioners: provisionerIssuers(registry, connectorsOf(messaging), new Set(['chat', 'admin', 'connectors'])),
  });
  const conversations = new ConversationsStack(app, 'Conversations', {
    env, appInstanceArn: messaging.appInstanceArn, selfPoolId: identity.selfPoolId,
    offboardingRoleArn: identity.offboardingRoleArn, credentialExchangeRoleArn: identity.credentialExchangeRoleArn,
  });
  const personApi = new PersonApiStack(app, 'PersonApi', {
    env, routes: identity.routes.filter((r) => r.api === 'person'), appInstanceArn: messaging.appInstanceArn,
    selfPoolId: identity.selfPoolId, selfClientIds: identity.selfClientIds, identities: identity.identitiesTable, tokens: conversations.tokensTable,
  });
  const connectorsStack = new ConnectorsStack(app, 'Connectors', {
    env, appInstanceArn: messaging.appInstanceArn, selfPoolId: identity.selfPoolId,
    identities: { tableName: identity.identitiesTable.tableName, tableArn: identity.identitiesTable.tableArn },
    offboardingRoleArn: identity.offboardingRoleArn, subjectProvisioner: identity.subjectProvisioners.connectors,
  });
  return {
    identity: Template.fromStack(identity), conversations: Template.fromStack(conversations),
    personApi: Template.fromStack(personApi), connectors: Template.fromStack(connectorsStack), stacks: { identity },
  };
}

/** Every (owner logical id, statement) in a template: managed-by-CDK policies and inline role policies. */
function grantsOf(t: Template): Array<[string, Statement]> {
  const out: Array<[string, Statement]> = [];
  for (const [id, p] of Object.entries(t.findResources('AWS::IAM::Policy')) as Array<[string, any]>) {
    const owners = (p.Properties.Roles || []).map((r: any) => JSON.stringify(r));
    for (const st of p.Properties.PolicyDocument.Statement) out.push([owners.join(',') || id, st]);
  }
  for (const [id, role] of Object.entries(t.findResources('AWS::IAM::Role')) as Array<[string, any]>) {
    for (const pol of role.Properties.Policies || []) for (const st of pol.PolicyDocument.Statement) out.push([id, st]);
  }
  return out;
}
const leadingKeys = (st: Statement) => st.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'];

describe('with a host-assertion issuer', () => {
  const t = synth([DEPLOYMENT, HOST]);

  it('the edge records a jti, on assertion-jti# alone, and nothing else in Tokens', () => {
    const onTokens = grantsOf(t.personApi).filter(([, st]) => JSON.stringify(st.Resource).includes('TokensTable'));
    expect(onTokens).toHaveLength(1);
    const [, st] = onTokens[0];
    expect(list(st.Action)).toEqual(['dynamodb:PutItem']);
    expect(leadingKeys(st)).toEqual(['assertion-jti#*']);
    const edgeFn = Object.values(t.personApi.findResources('AWS::Lambda::Function')).find((f: any) => f.Properties.Environment?.Variables?.EDGE_ROUTES) as any;
    expect(edgeFn.Properties.Environment.Variables.TOKENS_TABLE).toBeDefined();
  });

  it('the exchange consumes a jti and never writes one: GetItem and UpdateItem on assertion-jti# alone', () => {
    const jti = grantsOf(t.conversations).filter(([, st]) => (leadingKeys(st) as unknown[] | undefined)?.includes('assertion-jti#*'));
    expect(jti).toHaveLength(1);
    expect(list(jti[0][1].Action).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    expect(leadingKeys(jti[0][1])).toEqual(['assertion-jti#*']);
  });

  it('the exchange binds a provisioned subject only under the provisioned-only issuers\' keys, and reads the Tokens name', () => {
    const exchange = grantsOf(t.identity).filter(([owner]) => /CredentialExchangeRole/.test(owner));
    const bind = exchange.find(([, st]) => st.Sid === 'BindProvisionedSubject')![1];
    expect(list(bind.Action)).toEqual(['dynamodb:UpdateItem']);
    expect(leadingKeys(bind)).toEqual(['salesforce-org|*']);
    expect(exchange.some(([, st]) => st.Sid === 'HostAssertionTokensName')).toBe(true);
    const fn = Object.values(t.identity.findResources('AWS::Lambda::Function')).find((f: any) => /CredentialExchangeRole/.test(JSON.stringify(f.Properties.Role))) as any;
    expect(fn.Properties.Environment.Variables.TOKENS_TABLE_PARAMETER).toMatch(/tokens-name$/);
  });

  it('builds one provisioner per caller, its caller fixed, holding a pending-row write under its own issuers alone', () => {
    const fns = Object.values(t.identity.findResources('AWS::Lambda::Function')).filter((f: any) => f.Properties.Environment?.Variables?.PROVISION_CALLER) as any[];
    expect(fns.map((f) => f.Properties.Environment.Variables.PROVISION_CALLER).sort()).toEqual(['admin', 'connectors']);
    for (const f of fns) expect(JSON.parse(f.Properties.Environment.Variables.PROVISION_ISSUERS)).toEqual(['salesforce-org']);
    const roles = Object.entries(t.identity.findResources('AWS::IAM::Role')).filter(([id]) => /^SubjectProvisioner/.test(id)) as Array<[string, any]>;
    expect(roles).toHaveLength(2);
    for (const [id, role] of roles) {
      const statements: Statement[] = role.Properties.Policies.flatMap((p: any) => p.PolicyDocument.Statement);
      const onIdentities = statements.filter((st) => JSON.stringify(st.Resource).includes('IdentitiesTable'));
      const actions = onIdentities.flatMap((st) => list(st.Action)).sort();
      expect([id, actions]).toEqual([id, ['dynamodb:GetItem', 'dynamodb:PutItem']]);
      const put = onIdentities.find((st) => list(st.Action).includes('dynamodb:PutItem'))!;
      expect(leadingKeys(put)).toEqual(['salesforce-org|*']);
      expect(put.Condition?.['ForAllValues:StringEquals']?.['dynamodb:Attributes']).toEqual([...PENDING_ROW_ATTRIBUTES]);
      const asksExistence = statements.some((st) => list(st.Action).includes('chime:DescribeAppInstanceUser'));
      expect([id, asksExistence]).toEqual([id, /Admin/.test(id)]);
      expect(statements.flatMap((st) => list(st.Action)).filter((a) => /^chime:Create|^dynamodb:(Update|Delete|BatchWrite)/.test(String(a)))).toEqual([]);
    }
  });

  it('grants the event receiver the invoke of the connectors provisioner alone, and no Identities write', () => {
    const receiver = grantsOf(t.connectors).filter(([owner]) => /ConnectorEventReceiver/.test(owner));
    const invokes = receiver.filter(([, st]) => list(st.Action).includes('lambda:InvokeFunction'));
    expect(invokes).toHaveLength(1);
    expect(JSON.stringify(invokes[0][1].Resource)).toMatch(/SubjectProvisionerConnectors/);
    expect(JSON.stringify(invokes[0][1].Resource)).not.toMatch(/SubjectProvisionerAdmin/);
    const writes = receiver.filter(([, st]) => JSON.stringify(st.Resource).includes('IdentitiesTable')
      && list(st.Action).some((a) => /PutItem|UpdateItem|DeleteItem|BatchWrite/.test(String(a))));
    expect(writes).toEqual([]);
    const fn = Object.values(t.connectors.findResources('AWS::Lambda::Function')).find((f: any) => f.Properties.Environment?.Variables?.REPLAY_TABLE) as any;
    expect(JSON.parse(fn.Properties.Environment.Variables.PROVISION_NAMESPACES)).toEqual(['salesforce-org']);
  });
});

describe('without one', () => {
  const t = synth([DEPLOYMENT], [CONNECTORS[0]]);

  it('builds no provisioner, no jti grant and no bind', () => {
    expect(Object.values(t.identity.findResources('AWS::Lambda::Function')).filter((f: any) => f.Properties.Environment?.Variables?.PROVISION_CALLER)).toEqual([]);
    expect(t.stacks.identity.subjectProvisioners).toEqual({});
    for (const tpl of [t.identity, t.conversations, t.personApi, t.connectors]) {
      expect(grantsOf(tpl).filter(([, st]) => JSON.stringify(st).includes('assertion-jti') || st.Sid === 'BindProvisionedSubject')).toEqual([]);
    }
    const edgeFn = Object.values(t.personApi.findResources('AWS::Lambda::Function')).find((f: any) => f.Properties.Environment?.Variables?.EDGE_ROUTES) as any;
    expect(edgeFn.Properties.Environment.Variables.TOKENS_TABLE).toBeUndefined();
  });
});
