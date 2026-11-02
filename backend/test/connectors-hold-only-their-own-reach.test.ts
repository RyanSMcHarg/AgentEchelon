/**
 * THE CONNECTOR RUNTIME HOLDS ONLY ITS OWN REACH (the boundary row: E13, K3), RECEIVES ONLY ITS DECLARED
 * SOURCES' EVENTS (K5), AND IS DECLARED ONLY WITH WHAT IT NEEDS.
 *
 * Synthesized in process (`ConnectorsStack`), with bundling off:
 *
 *  - no connector role holds an Amazon Chime SDK action but `DescribeAppInstanceUser` (the `Identities`
 *    resolver checks the person still exists): no post, no membership, no channel;
 *  - no connector role writes `Identities`; the receiver reads it, through the directory grant;
 *  - the receiver reads no secret; the grant functions read only their own connectors' OAuth clients;
 *  - the grants key is used only through DynamoDB or under the grant encryption context;
 *  - `events:PutEvents` is conditioned on the one source each role publishes;
 *  - the grants table is encrypted with the grants key; offboarding's only grant here is the revoker's invoke;
 *  - each subscribing connector has one rule, on its partner event bus, whose pattern is its declared source
 *    and its subscribed events, and whose one target is the receiver with a retry policy and the
 *    dead-letter queue; the receiver may be invoked by those rules and nothing else; no route serves a vendor;
 *  - the registry refuses a declaration that is malformed, not built, or missing what it needs.
 *
 * The deployed roles are checked by `scripts/deny-test-connector-boundary.mjs`, and the deployed rules and
 * receiver policy by `scripts/deny-test-connector-events.mjs`.
 */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BUNDLING_STACKS } from 'aws-cdk-lib/cx-api';
import { ConnectorsStack, CONNECTOR_EVENT_RETRY } from '../lib/stacks/connectors-stack';
import { connectorErrors, connectorEventPattern, connectorRegistry, parseConnectorsContext } from '../lib/config/connectors';
import { connectorContextOf } from '../lib/constructs/connectors';

const ENV = { account: '111122223333', region: 'us-east-1' };
const APP_INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const IDENTITIES = { tableName: 'Identities', tableArn: 'arn:aws:dynamodb:us-east-1:111122223333:table/Identities' };
const OFFBOARDING_ROLE = 'arn:aws:iam::111122223333:role/offboarding';
const PD_SOURCE = 'aws.partner/pagerduty.com/example-oncall';
const SF_SOURCE = 'aws.partner/salesforce.com/00D5e000000AbCdEAF/0YL5e000000XyZaGAK';

const CONNECTORS = [
  { id: 'pagerduty', vendor: 'pagerduty', subscribes: ['incident.trigger', 'incident.resolve'], classification: 'standard', eventSource: PD_SOURCE },
  { id: 'crm', vendor: 'salesforce', subscribes: ['LeadChangeEvent', 'Lead_Assigned__e'], classification: 'standard', eventSource: SF_SOURCE, grants: { redirectUris: ['https://app.example.com/cb'] } },
  { id: 'quiet', vendor: 'pagerduty', grants: { redirectUris: ['https://app.example.com/cb'] } },
];

function build(connectors: unknown[] = CONNECTORS) {
  const app = new cdk.App({ context: { [BUNDLING_STACKS]: [], capabilities: ['connectors'], connectors } });
  const stack = new ConnectorsStack(app, 'Connectors', {
    env: ENV, appInstanceArn: APP_INSTANCE, selfPoolId: 'us-east-1_Self', identities: IDENTITIES, offboardingRoleArn: OFFBOARDING_ROLE,
  });
  return { stack, t: Template.fromStack(stack) };
}

type Statement = { Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>>; Effect: string };
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

/** Every statement each role holds: its inline policies and every `AWS::IAM::Policy` attached to it. */
function statementsByRole(t: Template): Record<string, Statement[]> {
  const res = t.toJSON().Resources as Record<string, { Type: string; Properties: any }>;
  const out: Record<string, Statement[]> = {};
  for (const [id, r] of Object.entries(res)) {
    if (r.Type !== 'AWS::IAM::Role') continue;
    out[id] = (r.Properties.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement);
  }
  for (const r of Object.values(res)) {
    if (r.Type !== 'AWS::IAM::Policy') continue;
    for (const role of r.Properties.Roles ?? []) {
      const ref = role.Ref ?? JSON.stringify(role);
      (out[ref] ??= []).push(...r.Properties.PolicyDocument.Statement);
    }
  }
  return out;
}

const roleId = (t: Template, prefix: string) => Object.keys(statementsByRole(t)).find((k) => k.startsWith(prefix))!;

describe('the connector runtime\'s reach', () => {
  const { t } = build();
  const roles = statementsByRole(t);
  const own = ['ConnectorEventReceiverRole', 'ConnectorGrantRoutesRole', 'ConnectorGrantRevokerRole'].map((p) => roleId(t, p));

  it('builds the three roles (a scan over none passes vacuously)', () => {
    expect(own.every(Boolean)).toBe(true);
    for (const id of own) expect(roles[id].length).toBeGreaterThan(1);
  });

  it('holds no Amazon Chime SDK action but the person existence check', () => {
    for (const id of own) {
      const chime = roles[id].flatMap(actions).filter((a) => a.startsWith('chime:'));
      expect({ id, chime: chime.filter((a) => a !== 'chime:DescribeAppInstanceUser') }).toEqual({ id, chime: [] });
    }
  });

  it('never writes Identities: the receiver reads it, and nothing else touches it', () => {
    for (const id of own) {
      for (const s of roles[id]) {
        if (!JSON.stringify(s.Resource ?? '').includes('table/Identities')) continue;
        expect({ id, actions: actions(s).filter((a) => !['dynamodb:GetItem', 'dynamodb:Query'].includes(a)) }).toEqual({ id, actions: [] });
      }
    }
    const receiverReads = roles[roleId(t, 'ConnectorEventReceiverRole')].filter((s) => JSON.stringify(s.Resource ?? '').includes('table/Identities'));
    expect(receiverReads.length).toBe(1);
  });

  it('asks the trusted pools whether a named person may still sign in, and nothing more of them (SPEC-CREDENTIAL-EXCHANGE §4b)', () => {
    const asking = roles[roleId(t, 'ConnectorEventReceiverRole')].filter((s) => (s as { Sid?: string }).Sid === 'AskTheIssuerWhetherTheAccountIsActive');
    expect(asking).toHaveLength(1);
    expect(asking[0].Action).toEqual(['cognito-idp:AdminGetUser', 'cognito-idp:ListUsers']);
    expect([asking[0].Resource].flat()).toEqual(['arn:aws:cognito-idp:us-east-1:111122223333:userpool/us-east-1_Self']);
  });

  it('reads no secret to receive events, and only its own connectors\' OAuth clients to act for a person', () => {
    const secrets = (id: string) => roles[id].filter((s) => actions(s).includes('secretsmanager:GetSecretValue'))
      .flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource])).map((r) => JSON.stringify(r));
    expect(secrets(roleId(t, 'ConnectorEventReceiverRole'))).toEqual([]);
    for (const p of ['ConnectorGrantRoutesRole', 'ConnectorGrantRevokerRole']) {
      const grants = secrets(roleId(t, p));
      expect(grants.length).toBe(2);
      expect(grants.every((r) => /connector\/(crm|quiet)\/oauth-client-\?\?\?\?\?\?/.test(r))).toBe(true);
    }
    for (const id of own) for (const r of secrets(id)) expect(r).not.toMatch(/\*/);
  });

  it('writes only its own replay table and dead-letter queue', () => {
    const receiver = roles[roleId(t, 'ConnectorEventReceiverRole')];
    const dynamo = receiver.filter((s) => actions(s).some((a) => a.startsWith('dynamodb:')) && !JSON.stringify(s.Resource).includes('table/Identities'));
    expect(dynamo).toHaveLength(1);
    expect(actions(dynamo[0]).sort()).toEqual(['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
    expect(JSON.stringify(dynamo[0].Resource)).toMatch(/ConnectorReplayTable/);
    const sqsWrites = receiver.filter((s) => actions(s).some((a) => a.startsWith('sqs:')));
    expect(sqsWrites).toHaveLength(1);
    expect(actions(sqsWrites[0])).toEqual(['sqs:SendMessage']);
    expect(JSON.stringify(sqsWrites[0].Resource)).toMatch(/ConnectorEventsDlq/);
  });

  it('uses the grants key only through DynamoDB or under the grant encryption context', () => {
    for (const id of own) {
      for (const s of roles[id].filter((x) => actions(x).some((a) => a.startsWith('kms:')))) {
        const c = s.Condition?.StringEquals ?? {};
        const via = String(c['kms:ViaService'] ?? '');
        const purpose = c['kms:EncryptionContext:purpose'];
        expect({ id, bounded: via.startsWith('dynamodb.') || purpose === 'connector-grant' }).toEqual({ id, bounded: true });
      }
    }
    // The revoker never seals: Decrypt only under the grant context.
    const revokerSeal = roles[roleId(t, 'ConnectorGrantRevokerRole')].filter((s) => s.Condition?.StringEquals?.['kms:EncryptionContext:purpose']);
    expect(revokerSeal.flatMap(actions)).toEqual(['kms:Decrypt']);
  });

  it('publishes only its own source on the default bus', () => {
    const sources = (id: string) => roles[id].filter((s) => actions(s).includes('events:PutEvents')).map((s) => s.Condition?.StringEquals?.['events:source']);
    expect(sources(roleId(t, 'ConnectorEventReceiverRole'))).toEqual([['ae.connector']]);
    expect(sources(roleId(t, 'ConnectorGrantRevokerRole'))).toEqual([['ae.alert']]);
    expect(sources(roleId(t, 'ConnectorGrantRoutesRole'))).toEqual([]);
  });

  it('encrypts the grants table with the grants key, keyed by person and connector', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'personId', KeyType: 'HASH' }, { AttributeName: 'connectorId', KeyType: 'RANGE' }],
      SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ConnectorGrantsKey'), 'Arn'] } },
    });
    t.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('grants offboarding the revoker\'s invoke, and nothing else', () => {
    const imported = Object.entries(roles).filter(([k]) => !own.includes(k)).flatMap(([, s]) => s);
    expect(imported.flatMap(actions)).toEqual(['lambda:InvokeFunction']);
    expect(JSON.stringify(imported[0].Resource)).toMatch(/ConnectorGrantRevoker/);
  });

  it('names the revoker so offboarding, in a stack deployed first, can invoke it', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'agent-echelon-connector-grant-revoker' });
  });
});

describe('the vendor event rules', () => {
  const { t, stack } = build();
  const rules = Object.entries(t.findResources('AWS::Events::Rule')).filter(([, r]) => r.Properties.EventPattern) as Array<[string, any]>;
  const receiverId = Object.keys(t.findResources('AWS::Lambda::Function')).find((k) => k.startsWith('ConnectorEventReceiver'))!;

  it('builds one rule per subscribing connector, on its partner event bus by name', () => {
    expect(receiverId).toBeDefined();
    expect(rules.map(([, r]) => r.Properties.EventBusName).sort()).toEqual([PD_SOURCE, SF_SOURCE].sort());
    expect(stack.eventRules).toHaveLength(2);
  });

  it('pins each pattern to the declared source and exactly the subscribed events', () => {
    const byBus = Object.fromEntries(rules.map(([, r]) => [r.Properties.EventBusName, r.Properties.EventPattern]));
    expect(byBus[PD_SOURCE]).toEqual({ source: [PD_SOURCE], 'detail-type': ['PagerDuty Webhook'], detail: { event: ['incident.resolve', 'incident.trigger'] } });
    expect(byBus[SF_SOURCE]).toEqual({ source: [SF_SOURCE], 'detail-type': ['LeadChangeEvent', 'Lead_Assigned__e'] });
    // The rule is built from the one function the live deny-test compares the deployed rule against.
    expect(byBus[PD_SOURCE]).toEqual(connectorEventPattern(CONNECTORS[0]));
    expect(byBus[SF_SOURCE]).toEqual(connectorEventPattern(CONNECTORS[1]));
  });

  it('targets the receiver alone, with a retry policy and the dead-letter queue', () => {
    for (const [id, r] of rules) {
      const targets = r.Properties.Targets as any[];
      expect({ id, targets: targets.length }).toEqual({ id, targets: 1 });
      expect(targets[0].Arn).toEqual({ 'Fn::GetAtt': [receiverId, 'Arn'] });
      expect(targets[0].RetryPolicy).toEqual({ MaximumRetryAttempts: CONNECTOR_EVENT_RETRY.targetRetryAttempts, MaximumEventAgeInSeconds: CONNECTOR_EVENT_RETRY.maxEventAgeHours * 3600 });
      expect(JSON.stringify(targets[0].DeadLetterConfig)).toMatch(/ConnectorEventsDlq/);
    }
    // A failed invocation is retried by Lambda and then kept in the same queue.
    t.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: CONNECTOR_EVENT_RETRY.functionRetryAttempts });
    const fn = t.findResources('AWS::Lambda::Function')[receiverId];
    expect(JSON.stringify(fn.Properties.DeadLetterConfig)).toMatch(/ConnectorEventsDlq/);
    t.hasResourceProperties('AWS::SQS::Queue', { SqsManagedSseEnabled: true, MessageRetentionPeriod: CONNECTOR_EVENT_RETRY.dlqRetentionDays * 86400 });
  });

  it('lets only those rules invoke the receiver', () => {
    const permissions = Object.values(t.findResources('AWS::Lambda::Permission')).map((p) => p.Properties)
      .filter((p) => JSON.stringify(p.FunctionName).includes(receiverId));
    expect(permissions).toHaveLength(rules.length);
    const ruleIds = rules.map(([id]) => id).sort();
    for (const p of permissions) {
      expect(p.Principal).toBe('events.amazonaws.com');
      expect(p.Action).toBe('lambda:InvokeFunction');
    }
    expect(permissions.map((p) => p.SourceArn['Fn::GetAtt'][0]).sort()).toEqual(ruleIds);
  });

  it('serves no route to a vendor: the only routes are a person\'s own grant routes, on PersonApi', () => {
    expect(stack.routes.map((r) => `${r.api} ${r.method} ${r.path}`).sort())
      .toEqual(['person DELETE /connectors/{connectorId}/grant', 'person POST /connectors/{connectorId}/grant']);
    expect(Object.keys(t.findResources('AWS::ApiGatewayV2::Api'))).toEqual([]);
    expect(stack.routes.some((r) => r.auth === 'none')).toBe(false);
  });

  it('alarms when an event lands in the dead-letter queue', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'ApproximateNumberOfMessagesVisible', Threshold: 0, Namespace: 'AWS/SQS' });
  });

  it('builds no receiver, rule or queue when no connector subscribes', () => {
    const quiet = build([{ id: 'quiet', vendor: 'pagerduty', grants: { redirectUris: ['https://app.example.com/cb'] } }]);
    expect(Object.keys(quiet.t.findResources('AWS::DynamoDB::Table')).some((k) => k.startsWith('ConnectorReplay'))).toBe(false);
    expect(Object.keys(quiet.t.findResources('AWS::SQS::Queue'))).toEqual([]);
    expect(Object.values(quiet.t.findResources('AWS::Events::Rule')).filter((r) => r.Properties.EventPattern)).toEqual([]);
    expect(quiet.stack.ingestFunction).toBeUndefined();
  });

  it('builds no grants key, table or grant routes when no connector takes grants', () => {
    const only = build([CONNECTORS[0]]);
    expect(Object.keys(only.t.findResources('AWS::KMS::Key'))).toEqual([]);
    expect(only.stack.routes).toEqual([]);
    expect(only.stack.grantRevoker).toBeUndefined();
  });
});

describe('the connector registry refuses what it cannot build', () => {
  const ctx = connectorContextOf({ entries: [{ id: 'deployment', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] } }] });
  const errs = (list: unknown[] | undefined, caps: string[] = ['connectors']) => connectorErrors(list, ctx, caps).join('\n');
  const pd = (over: Record<string, unknown> = {}) => ({ id: 'pd', vendor: 'pagerduty', subscribes: ['incident.trigger'], classification: 'standard', eventSource: PD_SOURCE, ...over });
  const sf = (over: Record<string, unknown> = {}) => ({ id: 'sf', vendor: 'salesforce', subscribes: ['LeadChangeEvent'], classification: 'standard', eventSource: SF_SOURCE, ...over });

  it('declares the capability and the connectors together, or neither', () => {
    expect(errs([{ id: 'pd', vendor: 'pagerduty' }], [])).toMatch(/the connectors capability is not/);
    expect(errs([], ['connectors'])).toMatch(/declared with no connector/);
    expect(errs(undefined, [])).toBe('');
  });

  it('refuses a vendor not built, an unknown vendor, and an entry with subscribes and no vendor', () => {
    expect(errs([{ id: 'phone', vendor: 'twilio' }])).toMatch(/vendor "twilio" cannot be declared: the Twilio connector is NOT BUILT/);
    expect(errs([{ id: 'x', vendor: 'acme' }])).toMatch(/vendor "acme" is not a connector vendor/);
    expect(errs([{ id: 'x', subscribes: ['incident.trigger'] }])).toMatch(/declares no vendor/);
  });

  it('accepts a subscribing connector of each vendor with its partner event source', () => {
    expect(errs([pd(), sf()])).toBe('');
    expect(errs([sf({ subscribes: ['Invoice__ChangeEvent', 'Case_Escalated__e'], eventSource: 'aws.partner/salesforce.com/00D5e000000AbCd/0YL5e000000XyZa' })])).toBe('');
  });

  it('refuses a subscribing connector with no eventSource, a malformed one, and one of another vendor', () => {
    expect(errs([pd({ eventSource: undefined })])).toMatch(/subscribes needs eventSource, the pagerduty partner event source/);
    expect(errs([pd({ eventSource: SF_SOURCE })])).toMatch(/is not a pagerduty partner event source; it starts with aws\.partner\/pagerduty\.com\//);
    expect(errs([sf({ eventSource: PD_SOURCE })])).toMatch(/is not a salesforce partner event source/);
    expect(errs([sf({ eventSource: 'aws.partner/salesforce.com/00D5e000000AbCdEAF' })])).toMatch(/is malformed; a salesforce partner event source is/);
    expect(errs([sf({ eventSource: 'aws.partner/salesforce.com/005e0000000AbCdEAF/0YL5e000000XyZaGAK' })])).toMatch(/is malformed/);
    expect(errs([pd({ eventSource: 'aws.partner/pagerduty.com/' })])).toMatch(/is malformed/);
    expect(errs([pd({ eventSource: 'aws.partner/pagerduty.com/a b' })])).toMatch(/is malformed/);
    expect(errs([pd(), pd({ id: 'pd2' })])).toMatch(/declared by another connector/);
    expect(errs([{ id: 'quiet', vendor: 'pagerduty', eventSource: PD_SOURCE }])).toMatch(/eventSource is read only for a connector that subscribes/);
  });

  it('refuses an event the vendor does not send, subscribes without a classification, and a capability not built', () => {
    // PagerDuty's EventBridge integration sends its webhook message types, not the V3 webhook names.
    expect(errs([pd({ subscribes: ['incident.triggered'] })])).toMatch(/subscribes names "incident.triggered", which is not a pagerduty event/);
    expect(errs([pd({ subscribes: ['lead.created'] })])).toMatch(/subscribes names "lead.created", which is not a pagerduty event/);
    expect(errs([sf({ subscribes: ['lead.assigned'] })])).toMatch(/subscribes names "lead.assigned", which is not a salesforce event \(the API name of a Platform Event/);
    expect(errs([sf({ subscribes: ['Lead'] })])).toMatch(/which is not a salesforce event/);
    expect(errs([pd({ subscribes: ['incident.trigger', 'incident.trigger'] })])).toMatch(/names an event twice/);
    expect(errs([pd({ classification: undefined })])).toMatch(/subscribes needs a classification/);
    expect(errs([pd({ classification: 'admin' })])).toMatch(/not a conversational classification/);
    expect(errs([{ id: 'pd', vendor: 'pagerduty', capabilities: ['syncRecord'] }])).toMatch(/syncRecord is NOT BUILT/);
    expect(errs([pd({ capabilities: ['resolveParticipant'] })])).toMatch(/subscribes needs the ingest capability/);
  });

  it('refuses grants without redirect URIs, a redirect that is not https or localhost, a webhook field, and an unknown field', () => {
    expect(errs([{ id: 'sf', vendor: 'salesforce', grants: {} }])).toMatch(/grants names its redirectUris/);
    expect(errs([{ id: 'sf', vendor: 'salesforce', grants: { redirectUris: ['http://app.example.com/cb'] } }])).toMatch(/is neither https nor a localhost address/);
    expect(errs([{ id: 'sf', vendor: 'salesforce', grants: { redirectUris: ['http://localhost:5173/cb'] } }])).toBe('');
    expect(errs([{ id: 'sf', vendor: 'salesforce', secret: 'inline' }])).toMatch(/"secret" is not a connector field/);
    // A webhook route's throttle no longer exists: no vendor reaches a route.
    expect(errs([pd({ throttle: { rate: 3, burst: 6 } })])).toMatch(/"throttle" is not a connector field/);
    expect(errs([{ id: 'pd', vendor: 'pagerduty' }, { id: 'pd', vendor: 'pagerduty' }])).toMatch(/declared twice/);
  });

  it('reads the forms deploy.mjs forwards, carries the source to the runtime, and resolves the Salesforce endpoints on the declared login URL', () => {
    const list = [{ id: 'sf', vendor: 'salesforce', loginUrl: 'https://acme.my.salesforce.com', grants: { redirectUris: ['https://app.example.com/cb'] } }];
    expect(parseConnectorsContext(`json64:${Buffer.from(JSON.stringify(list)).toString('base64url')}`)).toEqual(list);
    const [rt] = connectorRegistry(list, ctx, ['connectors']).runtime();
    expect(rt.grants).toEqual(expect.objectContaining({ tokenUrl: 'https://acme.my.salesforce.com/services/oauth2/token', revokeUrl: 'https://acme.my.salesforce.com/services/oauth2/revoke', revokeAuth: 'token-only' }));
    expect(connectorRegistry([pd()], ctx, ['connectors']).runtime()[0].eventSource).toBe(PD_SOURCE);
    expect(() => connectorRegistry([{ id: 'x', vendor: 'acme' }], ctx, ['connectors'])).toThrow(/connectors cannot be synthesized/);
  });
});
