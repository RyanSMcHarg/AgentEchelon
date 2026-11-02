/**
 * ONLY THE CREDENTIAL EXCHANGE MAPS A SUBJECT TO A PERSON IN `Identities`, AND ONLY IT CREATES A PERSON.
 *
 * The Identities table maps (issuer, subject) to the person's AppInstanceUser, and a row is what makes
 * a subject that person: a role that could write one could sign anyone in as anyone. So the grant is
 * checked at synth, over every IAM policy in the stack that owns it, and in the admin backend that reads it.
 * Offboarding (its own role) may delete a row, put a `revoked` marker and change a row's `status`, and the conditions on its grant hold it
 * to exactly those. The same goes for
 * `chime:CreateAppInstanceUser`: no other role in this stack may create a person, so the post-confirmation
 * trigger and user approval hold no such grant.
 */
import { SHARED_SSM } from '../lib/stacks/agent-classification-common';
import { adminServicesTemplate, identityTemplate } from './helpers/synth';

const WRITES = new Set(['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:*', '*']);

type Statement = { Effect?: string; Action: unknown; Resource: unknown };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

describe('the Identities table', () => {
  const template = identityTemplate({ issuers: [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
  { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostPool', clearance: { oneChannel: 'basic', classifications: ['basic'] } },
] });
  const tables = template.findResources('AWS::DynamoDB::Table');
  const [tableId, table] = Object.entries(tables).find(([id]) => id.startsWith('IdentitiesTable'))!;

  /** Every (role logical id, statement) granted in this stack, from policies and inline role policies. */
  const grants: Array<[string, Statement]> = [];
  for (const p of Object.values(template.findResources('AWS::IAM::Policy')) as any[]) {
    for (const r of p.Properties.Roles || []) for (const st of p.Properties.PolicyDocument.Statement) grants.push([r.Ref, st]);
  }
  for (const [id, role] of Object.entries(template.findResources('AWS::IAM::Role')) as Array<[string, any]>) {
    for (const pol of role.Properties.Policies || []) for (const st of pol.PolicyDocument.Statement) grants.push([id, st]);
  }
  const reachesTable = (st: Statement) => list(st.Resource).some((r) => r === '*' || JSON.stringify(r).includes(tableId));

  it('is keyed by issuer and subject, with the byPerson index, and retained', () => {
    expect(table.Properties.KeySchema).toEqual([{ AttributeName: 'issuerSubject', KeyType: 'HASH' }]);
    expect(table.Properties.GlobalSecondaryIndexes).toEqual([
      expect.objectContaining({ IndexName: 'byPerson', KeySchema: [{ AttributeName: 'personArn', KeyType: 'HASH' }] }),
    ]);
    expect(table.DeletionPolicy).toBe('Retain');
    expect(table.Properties.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
  });

  it('maps a subject to a person only through the exchange: offboarding removes and marks, and writes nothing else', () => {
    const writes = grants.filter(([, st]) => st.Effect !== 'Deny' && reachesTable(st) && list(st.Action).some((a) => WRITES.has(String(a))));
    const writers = new Set(writes.map(([role]) => role));
    expect([...writers].sort().map((r) => r.replace(/[0-9A-F]{8}$/, ''))).toEqual(['CredentialExchangeRole', 'OffboardingRole']);

    // Only the exchange writes a row unconditioned.
    for (const [role, st] of writes) {
      if (/^CredentialExchangeRole/.test(role)) continue;
      const actions = list(st.Action).map(String);
      const cond = (st as Statement & { Condition?: Record<string, Record<string, unknown>> }).Condition;
      if (actions.includes('dynamodb:PutItem')) {
        // A marker: its key starts `revoked#`, and it holds nothing but its key.
        expect(actions).toEqual(['dynamodb:PutItem']);
        expect(cond?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']).toEqual(['revoked#*']);
        expect(cond?.['ForAllValues:StringEquals']?.['dynamodb:Attributes']).toEqual(['issuerSubject']);
      } else {
        // No update: no row records an identity provider's state, so offboarding never changes one.
        expect(actions).not.toContain('dynamodb:UpdateItem');
        expect(actions.filter((a) => WRITES.has(a))).toEqual(['dynamodb:DeleteItem']);
      }
    }
  });

  it('is named to the one exchange, and published for the resolver', () => {
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
    const withTable = fns.filter((f) => JSON.stringify(f.Properties?.Environment?.Variables?.IDENTITIES_TABLE ?? '').includes(tableId));
    // The one exchange every issuer shares writes it, and records the write to the access log. The other readers in this stack read people BY PERSON through the directory (user management,
    // for the list of people and the identity tag a clearance change re-stamps; the offboarding handler,
    // on the same role; the admin-conversation sync, for the admins group's people); the test above holds
    // the user-management role to offboarding's writes.
    const writers = withTable.filter((f) => /CredentialExchangeRole/.test(JSON.stringify(f.Properties.Role)));
    const readers = withTable.filter((f) => !writers.includes(f)).map((f) => JSON.stringify(f.Properties.Role));
    expect(writers).toHaveLength(1);
    for (const f of writers) expect(f.Properties.Environment.Variables.ACCESS_LOG_TABLE).toBeDefined();
    // The one reader in this stack is offboarding; user management and the admin-conversation sync read
    // it from the admin backend (AdminServices), below.
    expect(readers).toHaveLength(1);
    expect(readers.some((r) => /OffboardingRole/.test(r))).toBe(true);
    const params = (Object.values(template.findResources('AWS::SSM::Parameter')) as any[]).map((p) => p.Properties.Name);
    expect(params).toEqual(expect.arrayContaining([SHARED_SSM.identitiesName, SHARED_SSM.identitiesArn]));
  });

  it('lets the exchange update a row only to record its clearance decision (C3)', () => {
    const updates = grants.filter(([role, st]) => /^CredentialExchangeRole/.test(role) && st.Effect !== 'Deny' && reachesTable(st)
      && list(st.Action).some((a) => a === 'dynamodb:UpdateItem' || a === 'dynamodb:*' || a === '*'));
    expect(updates).toHaveLength(1);
    const [, st] = updates[0];
    expect(list(st.Action)).toEqual(['dynamodb:UpdateItem']);
    const cond = (st as Statement & { Condition?: Record<string, Record<string, unknown>> }).Condition;
    expect(cond?.['ForAllValues:StringEquals']?.['dynamodb:Attributes']).toEqual(['issuerSubject', 'clearanceDecision']);
  });

  it('is only read by the admin backend: no AdminServices role writes it', () => {
    const admin = adminServicesTemplate();
    const statements: Statement[] = (Object.values(admin.findResources('AWS::IAM::Policy')) as any[])
      .flatMap((p) => p.Properties.PolicyDocument.Statement);
    const onTable = statements.filter((st) => JSON.stringify(st.Resource).includes('IdentitiesTable'));
    // Non-vacuity: user management, the sync, the channel provisioner and the admin exchange read it.
    expect(onTable.length).toBeGreaterThanOrEqual(4);
    for (const st of onTable) expect(list(st.Action).filter((a) => WRITES.has(String(a)))).toEqual([]);
  });

  it('leaves creating a person to the exchange: no other role here holds chime:CreateAppInstanceUser', () => {
    const creators = new Set(grants
      .filter(([, st]) => st.Effect !== 'Deny' && list(st.Action).some((a) => a === 'chime:CreateAppInstanceUser' || a === 'chime:*'))
      .map(([role]) => role));
    expect([...creators].every((r) => /^CredentialExchangeRole/.test(r))).toBe(true);
    expect(creators.size).toBe(1);
  });
});

/**
 * THE SECOND WRITER, REGISTERED WITH ITS REASON (P-13). A `provisioned-only` issuer (a host that signs its
 * own users' assertions) is never minted for, so its subjects are pre-assigned ahead of their first sign-in
 * by the subject provisioners (`lib/constructs/subject-provisioner.ts`), one per caller. Each is held, by the
 * conditions on its own grant, to a `pending` row of its own issuers and nothing else; the exchange alone
 * binds that row. The guard above is unchanged for every deployment that declares no such issuer.
 */
describe('the Identities table, with a provisioned-only issuer', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cdk = require('aws-cdk-lib') as typeof import('aws-cdk-lib');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Template } = require('aws-cdk-lib/assertions') as typeof import('aws-cdk-lib/assertions');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MessagingStack } = require('../lib/stacks/messaging-stack') as typeof import('../lib/stacks/messaging-stack');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { IdentityStack } = require('../lib/stacks/identity-stack') as typeof import('../lib/stacks/identity-stack');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { generateKeyPairSync } = require('crypto') as typeof import('crypto');
  const key = (generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], issuers: [
    { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
    { id: 'salesforce-org', kind: 'host-assertion', issuer: 'https://example.my.salesforce.com', allowedOrigins: ['https://example.lightning.force.com'],
      hostAssertion: { publicKeys: { k1: key } }, clearance: { fixed: ['basic'], classifications: ['basic'] } },
  ] } });
  const messaging = new MessagingStack(app, 'Messaging', { env: { account: '123456789012', region: 'us-east-1' }, appInstanceName: 'test' });
  const identity = new IdentityStack(app, 'Identity', {
    env: { account: '123456789012', region: 'us-east-1' }, appInstanceArn: messaging.appInstanceArn,
    subjectProvisioners: { admin: ['salesforce-org'], connectors: ['salesforce-org'] },
  });
  const template = Template.fromStack(identity);
  const tableId = Object.keys(template.findResources('AWS::DynamoDB::Table')).find((id) => id.startsWith('IdentitiesTable'))!;
  const grants: Array<[string, Statement & { Condition?: Record<string, Record<string, unknown>> }]> = [];
  for (const p of Object.values(template.findResources('AWS::IAM::Policy')) as any[]) {
    for (const r of p.Properties.Roles || []) for (const st of p.Properties.PolicyDocument.Statement) grants.push([r.Ref, st]);
  }
  for (const [id, role] of Object.entries(template.findResources('AWS::IAM::Role')) as Array<[string, any]>) {
    for (const pol of role.Properties.Policies || []) for (const st of pol.PolicyDocument.Statement) grants.push([id, st]);
  }
  const writes = grants.filter(([, st]) => st.Effect !== 'Deny' && list(st.Resource).some((r) => JSON.stringify(r).includes(tableId))
    && list(st.Action).some((a) => WRITES.has(String(a))));

  it('is written by the exchange, offboarding and the two provisioners, and by no other role', () => {
    expect([...new Set(writes.map(([role]) => role.replace(/[0-9A-F]{8}$/, '')))].sort())
      .toEqual(['CredentialExchangeRole', 'OffboardingRole', 'SubjectProvisionerAdminRole', 'SubjectProvisionerConnectorsRole']);
  });

  it('holds each provisioner to a pending row of its own issuers: PutItem alone, under their keys, with a pending row\'s attributes', () => {
    const provisioners = writes.filter(([role]) => /^SubjectProvisioner/.test(role));
    expect(provisioners).toHaveLength(2);
    for (const [, st] of provisioners) {
      expect(list(st.Action)).toEqual(['dynamodb:PutItem']);
      expect(st.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']).toEqual(['salesforce-org|*']);
      expect(st.Condition?.['ForAllValues:StringEquals']?.['dynamodb:Attributes']).toEqual(['issuerSubject', 'personArn', 'issuer', 'status', 'createdAt', 'provisionedBy']);
    }
  });

  it('still leaves creating a person to the exchange', () => {
    const creators = grants.filter(([, st]) => st.Effect !== 'Deny' && list(st.Action).some((a) => a === 'chime:CreateAppInstanceUser' || a === 'chime:*'));
    expect([...new Set(creators.map(([role]) => role))].every((r) => /^CredentialExchangeRole/.test(r))).toBe(true);
  });
});
