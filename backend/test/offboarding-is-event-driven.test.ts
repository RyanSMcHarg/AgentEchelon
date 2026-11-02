/**
 * OFFBOARDING IS EVENT-DRIVEN, ON THE PLATFORM TRAIL, WITH A SWEEP BEHIND IT (synth).
 *
 * An EventBridge rule on the CloudTrail record of a pool account deleted, for this deployment's pools only,
 * runs the offboarding handler; a daily schedule runs it as the backstop. A disable or an enable is not on
 * the rule, and the offboarding role changes no `Identities` row: the exchange asks the pool at every vend
 * (SPEC-CREDENTIAL-EXCHANGE §4b). The
 * console's delete asks the same function (AdminServices' user management invokes it), so both run on
 * the one offboarding role, which the admin backend never holds. The CloudTrail record comes from the platform trail, which
 * the Identity stack keeps beside the roles whose use it records, so there is one trail. The stores a
 * person's records live in grant that role, each on its own resource.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MessagingStack } from '../lib/stacks/messaging-stack';
import { IdentityStack } from '../lib/stacks/identity-stack';
import { ConversationsStack } from '../lib/stacks/conversations-stack';
import { BattleStack } from '../lib/stacks/battle-stack';
import { COGNITO_LIFECYCLE_EVENTS } from '../lambda/src/lib/issuer-lifecycle';
import { adminServicesTemplate } from './helpers/synth';

const env = { account: '123456789012', region: 'us-east-1' };
const HOST_POOL = 'us-east-1_HostPool';

// A host app's pool in the trusted-issuer registry: its lifecycle events offboard too (lifecycle
// `cloudtrail-cognito`, the default for a Cognito pool).
const app = new cdk.App({ context: { issuers: [
  { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
  { id: 'host', kind: 'cognito-pool', pool: HOST_POOL, clearance: { oneChannel: 'basic', classifications: ['basic'] } },
] } });
const messaging = new MessagingStack(app, 'TestMessagingOffboarding', { env, appInstanceName: 'test-instance' });
const cog = new IdentityStack(app, 'TestIdentityOffboarding', { env, appInstanceArn: messaging.appInstanceArn, battle: true });
const conversations = new ConversationsStack(app, 'TestConversationsOffboarding', {
  env, appInstanceArn: messaging.appInstanceArn, selfPoolId: 'us-east-1_TestPool',
  offboardingRoleArn: cog.offboardingRoleArn,
});
const battle = new BattleStack(app, 'TestBattleOffboarding', {
  env, appInstanceArn: messaging.appInstanceArn, selfPoolId: 'us-east-1_TestPool', offboardingRoleArn: cog.offboardingRoleArn,
});
const cogT = Template.fromStack(cog);
const battleT = Template.fromStack(battle);
const convT = Template.fromStack(conversations);

const fnByEntry = (t: Template, idPrefix: string) =>
  Object.entries(t.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith(idPrefix))!;

describe('the offboarding rule', () => {
  const rules = Object.values(cogT.findResources('AWS::Events::Rule')) as any[];
  const [offboardingId, offboardingFn] = fnByEntry(cogT, 'OffboardingFunction');
  const targetsHandler = (r: any) => (r.Properties.Targets || []).some((t: any) => JSON.stringify(t.Arn).includes(offboardingId));

  it('matches the delete calls for this deployment\'s pools, and nothing else', () => {
    const rule = rules.find((r) => targetsHandler(r) && r.Properties.EventPattern);
    expect(rule).toBeDefined();
    const pattern = rule.Properties.EventPattern;
    expect(pattern.source).toEqual(['aws.cognito-idp']);
    expect(pattern['detail-type']).toEqual(['AWS API Call via CloudTrail']);
    expect(pattern.detail.eventSource).toEqual(['cognito-idp.amazonaws.com']);
    expect(pattern.detail.eventName).toEqual([...COGNITO_LIFECYCLE_EVENTS]);
    expect(pattern.detail.eventName).toEqual(['AdminDeleteUser', 'DeleteUser']);
    const pools = pattern.detail.requestParameters.userPoolId;
    expect(pools).toHaveLength(2);
    expect(JSON.stringify(pools[0])).toContain('UserPool');
    expect(pools[1]).toBe(HOST_POOL);
  });

  it('runs a daily sweep as the backstop', () => {
    const sweep = rules.find((r) => targetsHandler(r) && r.Properties.ScheduleExpression);
    expect(sweep.Properties.ScheduleExpression).toBe('rate(1 day)');
  });

  it('changes no Identities row: it deletes rows and writes markers, and holds no update there', () => {
    const role = Object.entries(cogT.findResources('AWS::IAM::Role')).find(([id]) => id.startsWith('OffboardingRole'))![1] as any;
    const identities = (role.Properties.Policies as any[]).find((p) => p.PolicyName === 'IdentitiesOffboarding');
    const actions = identities.PolicyDocument.Statement.flatMap((s: any) => [].concat(s.Action));
    expect(actions).not.toContain('dynamodb:UpdateItem');
    expect([...new Set(actions)].sort()).toEqual(['dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:Scan']);
  });

  it('runs on its own offboarding role, with the stores named by the SSM contract', () => {
    expect(JSON.stringify(offboardingFn.Properties.Role)).toMatch(/OffboardingRole/);
    const vars = offboardingFn.Properties.Environment.Variables;
    for (const key of ['USER_PROFILE_NAME_PARAM', 'USER_TASKS_NAME_PARAM', 'AGENT_TASKS_NAME_PARAM', 'TURN_STATE_NAME_PARAM',
      'CHANNEL_CONTEXT_NAME_PARAM', 'CHANNEL_BATTLE_CONFIG_NAME_PARAM', 'ABUSE_CONTROLS_NAME_PARAM',
      'ATTACHMENTS_BUCKET_ARN_PARAM', 'ACCESS_LOG_TABLE', 'CLIENT_EVENTS_DELIVERY_STREAM', 'AURORA_DATA_PLANE_ARN_PARAM']) {
      expect(vars[key]).toBeDefined();
    }
    expect(vars.OFFBOARDING_OTHER_POOL_IDS).toBe(HOST_POOL);
  });

  it('is what the console delete asks: user management invokes it, and holds none of its grants', () => {
    const admin = adminServicesTemplate();
    const [, userMgmtFn] = fnByEntry(admin, 'UserManagementFunction');
    expect(JSON.stringify(userMgmtFn.Properties.Environment.Variables.OFFBOARDING_FUNCTION_NAME)).toMatch(/OffboardingFunction/);
    const roleId = (userMgmtFn.Properties.Role as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0];
    const statements = (Object.values(admin.findResources('AWS::IAM::Policy')) as any[])
      .filter((p) => JSON.stringify(p.Properties.Roles).includes(roleId))
      .flatMap((p) => p.Properties.PolicyDocument.Statement);
    const actions = statements.flatMap((st: any) => [].concat(st.Action)) as string[];
    const invoke = statements.find((st: any) => [].concat(st.Action).includes('lambda:InvokeFunction' as never) && JSON.stringify(st.Resource).includes('OffboardingFunction'));
    expect(invoke).toBeDefined();
    // The erasure grants are the offboarding role's alone.
    for (const a of ['cognito-idp:AdminDeleteUser', 'cognito-idp:AdminUserGlobalSignOut', 'chime:DeleteAppInstanceUser', 'dynamodb:DeleteItem', 'firehose:PutRecordBatch']) {
      expect([a, actions.includes(a)]).toEqual([a, false]);
    }
  });

  it('reads the platform trail, which Identity keeps and Conversations does not, recording every management event', () => {
    convT.resourceCountIs('AWS::CloudTrail::Trail', 0);
    const trails = Object.values(cogT.findResources('AWS::CloudTrail::Trail')) as any[];
    expect(trails).toHaveLength(1);
    expect(trails[0].Properties.AdvancedEventSelectors).toEqual(expect.arrayContaining([
      { Name: 'All management events', FieldSelectors: [{ Field: 'eventCategory', Equals: ['Management'] }] },
    ]));
  });
});

describe('the grants a person\'s records hold for offboarding', () => {
  const policies = (t: Template) => Object.values(t.findResources('AWS::IAM::Policy')) as any[];
  const imported = (t: Template) => policies(t).filter((p) => JSON.stringify(p.Properties.Roles).includes('OffboardingRole'));

  it('Conversations: each table holds exactly what erasing and exporting a person needs there', () => {
    const statements = imported(convT).flatMap((p) => p.Properties.PolicyDocument.Statement);
    // The actions granted on a table, by its construct id, with the condition each carries.
    const on = (table: string) => statements.filter((s: any) => JSON.stringify(s.Resource).includes(table));
    const actionsOn = (table: string, unconditioned = false) => [...new Set(on(table)
      .filter((s: any) => !unconditioned || !s.Condition)
      .flatMap((s: any) => [].concat(s.Action)))].sort();
    expect(actionsOn('UserProfileTable')).toEqual(['dynamodb:DeleteItem', 'dynamodb:GetItem']);
    expect(actionsOn('UserTasksTable')).toEqual(['dynamodb:DeleteItem', 'dynamodb:Query']);
    // The person's partition, and the rows they own in an assistant's.
    expect(JSON.stringify(on('UserTasksTable').filter((s: any) => [].concat(s.Action).includes('dynamodb:Query' as never)))).toContain('/index/ownerPersonId-index');
    expect(actionsOn('TurnStateTable')).toEqual(['dynamodb:DeleteItem', 'dynamodb:Scan']);
    expect(actionsOn('AbuseControlsTable')).toEqual(['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:Scan']);
    // The task records naming the person: found by a scan, deleted by key.
    expect(actionsOn('AgentTasksTable')).toEqual(['dynamodb:DeleteItem', 'dynamodb:Scan']);
    // A conversation's context row: read, and rewritten in the member identity lookup and the intake only.
    expect(actionsOn('ChannelContextTable', true)).toEqual(['dynamodb:GetItem', 'dynamodb:Scan']);
    const contextWrite = on('ChannelContextTable').filter((s: any) => [].concat(s.Action).includes('dynamodb:UpdateItem' as never));
    expect(contextWrite).toHaveLength(1);
    expect([].concat(contextWrite[0].Action)).toEqual(['dynamodb:UpdateItem']);
    expect(contextWrite[0].Condition).toEqual({ 'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['channelArn', 'memberIdentities', 'onboardingIntake'] } });
    // The person's own tokens, those kinds only, found by a scan.
    const tokenDelete = on('TokensTable').filter((s: any) => [].concat(s.Action).includes('dynamodb:DeleteItem' as never));
    expect(tokenDelete).toHaveLength(1);
    expect(tokenDelete[0].Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['reply#*', 'unsubscribe#*', 'claim#*', 'invitation#*'] } });
    expect(actionsOn('TokensTable', true)).toEqual(['dynamodb:Scan']);
    // NOTHING ELSE THAT WRITES: no put anywhere, and the one update is the context row's.
    expect(statements.some((s: any) => [].concat(s.Action).some((a: string) => /PutItem|BatchWrite/.test(a)))).toBe(false);
    expect(statements.filter((s: any) => [].concat(s.Action).includes('dynamodb:UpdateItem' as never))).toEqual(contextWrite);
  });

  it('Conversations: the person\'s uploads under attachments/, every version, and no read', () => {
    const statements = imported(convT).flatMap((p) => p.Properties.PolicyDocument.Statement);
    const list = statements.find((s: any) => [].concat(s.Action).includes('s3:ListBucketVersions' as never));
    expect(list.Condition).toEqual({ StringLike: { 's3:prefix': ['attachments/*'] } });
    const del = statements.find((s: any) => [].concat(s.Action).includes('s3:DeleteObjectVersion' as never));
    expect(JSON.stringify(del.Resource)).toContain('/attachments/*');
    expect(statements.some((s: any) => [].concat(s.Action).includes('s3:GetObject' as never))).toBe(false);
  });
});

it('keeps the role inside IAM\'s inline policy limit, across every stack that grants it', () => {
  // IAM counts every inline policy on a role toward one 10,240-byte cap (whitespace excluded), including
  // the policies other stacks attach to an imported role.
  const roleInline = Object.entries(cogT.findResources('AWS::IAM::Role'))
    .filter(([id]) => id.startsWith('OffboardingRole'))
    .flatMap(([, r]: [string, any]) => (r.Properties.Policies || []).map((p: any) => p.PolicyDocument));
  const attached = [cogT, convT].flatMap((t) => (Object.values(t.findResources('AWS::IAM::Policy')) as any[])
    .filter((p) => JSON.stringify(p.Properties.Roles).includes('OffboardingRole'))
    .map((p) => p.Properties.PolicyDocument));
  const bytes = [...roleInline, ...attached].reduce((n, doc) => n + JSON.stringify(doc).length, 0);
  expect(bytes).toBeLessThan(10_240);
});

describe('the battle setting names who enabled it, and offboarding removes that name', () => {
  const statements = (Object.values(battleT.findResources('AWS::IAM::Policy')) as any[])
    .filter((p) => JSON.stringify(p.Properties.Roles).includes('OffboardingRole'))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);

  it('a scan of the battle settings, and an update of `enabledBy` alone, on that table only', () => {
    const scan = statements.filter((s: any) => [].concat(s.Action).includes('dynamodb:Scan' as never));
    const update = statements.filter((s: any) => [].concat(s.Action).includes('dynamodb:UpdateItem' as never));
    expect(scan).toHaveLength(1);
    expect(update).toHaveLength(1);
    for (const s of [...scan, ...update]) expect(JSON.stringify(s.Resource)).toContain('ChannelBattleConfigTable');
    expect(update[0].Condition).toEqual({ 'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['channelArn', 'enabledBy'] } });
    expect(statements.flatMap((s: any) => [].concat(s.Action)).sort()).toEqual(['dynamodb:Scan', 'dynamodb:UpdateItem']);
  });
});

describe('the stop marker names a person and declares its own expiry', () => {
  it('the turn-state table reclaims an expired record through its `ttl` attribute', () => {
    const turnState = Object.entries(convT.findResources('AWS::DynamoDB::Table')).find(([id]) => id.startsWith('TurnStateTable'))!;
    expect(turnState[1].Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'ttl', Enabled: true });
  });
});
