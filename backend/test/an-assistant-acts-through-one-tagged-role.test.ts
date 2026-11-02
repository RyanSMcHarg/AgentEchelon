/**
 * EVERY ASSISTANT OF A CLASSIFICATION ACTS THROUGH ONE TAGGED ROLE (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
 *
 * A classification holds any number of assistants, so nothing about a particular assistant is written
 * into IAM. One acting role per classification is assumed per turn by the vend and tagged with the
 * assistant, its assistant role and its bot, and every statement compares those tags.
 *
 * These assert the properties whose absence is silent: a role something other than the vend could
 * assume, a session that could bear any bot, a boundary that lets a session act outside its
 * classification, and per-role reach that does not depend on the role tag.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import {
  allowContextSourceObjects,
  assistantActingRole,
  assistantRolePath,
  ASSISTANT_TURN_CHANNEL_ACTIONS,
  CLASSIFICATION_GATED_CHANNEL_ACTIONS,
  capabilityAlarmNamePrefixes,
  coreAlarmNamePrefixes,
  deploymentAlarmNamePrefixes,
} from '../lib/stacks/agent-classification-common';
import { defaultProfileRegistry } from '../lib/profile-registry';

const APP_INSTANCE = 'arn:aws:chime:us-east-1:123456789012:app-instance/abc';
const BUCKET = 'arn:aws:s3:::context-bucket';

function synth(roles: string[] = ['primary', 'ops'], capabilities?: string[]) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'T', { env: { account: '123456789012', region: 'us-east-1' } });
  const vendRole = new iam.Role(stack, 'VendRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  const turnRole = new iam.Role(stack, 'TurnRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  assistantActingRole(stack, {
    classification: 'premium',
    appInstanceArn: APP_INSTANCE,
    vendRole,
    roles,
    sessionChannelActions: ASSISTANT_TURN_CHANNEL_ACTIONS,
    contextBucketArn: BUCKET,
    capabilities,
  });
  return { template: Template.fromStack(stack), stack, vendRole, turnRole };
}

function actingRole(template: Template): { id: string; props: Record<string, any> } {
  const roles = template.findResources('AWS::IAM::Role', { Properties: { Path: assistantRolePath() } });
  const ids = Object.keys(roles);
  expect(ids).toHaveLength(1);
  return { id: ids[0], props: roles[ids[0]].Properties };
}

function actingStatements(template: Template): any[] {
  const { id } = actingRole(template);
  // Everything the role holds: its inline policies and the managed policies attached to it.
  const policies = { ...template.findResources('AWS::IAM::Policy'), ...template.findResources('AWS::IAM::ManagedPolicy') };
  return Object.values(policies)
    .filter((p: any) => JSON.stringify(p.Properties.Roles ?? []).includes(id))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

function boundaryStatements(template: Template): any[] {
  const managed = template.findResources('AWS::IAM::ManagedPolicy', {
    Properties: { ManagedPolicyName: Match.stringLikeRegexp('AssistantActingBoundary-premium$') },
  });
  const docs = Object.values(managed);
  expect(docs).toHaveLength(1);
  return (docs[0] as any).Properties.PolicyDocument.Statement;
}

describe('an assistant acts through one tagged role', () => {
  it('creates ONE acting role for the classification, however many assistant roles it declares', () => {
    actingRole(synth(['primary']).template);
    actingRole(synth(['primary', 'ops', 'reporting']).template);
  });

  it('is trusted by the vend and nothing else, and only with the session tags pinned', () => {
    const { template } = synth();
    const trust = actingRole(template).props.AssumeRolePolicyDocument.Statement;
    const assume = trust.find((s: any) => s.Action === 'sts:AssumeRole');
    expect(JSON.stringify(assume.Principal)).toContain('VendRole');
    expect(JSON.stringify(assume.Principal)).not.toContain('TurnRole');
    expect(assume.Condition.StringEquals['aws:RequestTag/classification']).toBe('premium');
    expect(assume.Condition.StringEquals['aws:RequestTag/role']).toEqual(['primary', 'ops']);
    expect(assume.Condition.StringLike['aws:RequestTag/assistant']).toBe('*');
    expect(assume.Condition.StringLike['aws:RequestTag/bot']).toBe('*');
    // The same pin on the tag call, so a tagged assume cannot be split into an untagged one.
    const tag = trust.find((s: any) => s.Action === 'sts:TagSession');
    expect(tag.Condition).toEqual(assume.Condition);
  });

  it('bears ONLY the bot named by the session, as an ARN variable', () => {
    const bearer = actingStatements(synth().template).find((s) => s.Sid === 'ActOnlyAsTheSessionsOwnBot');
    expect(bearer.Resource).toBe(`${APP_INSTANCE}/bot/\${aws:PrincipalTag/bot}`);
    expect(bearer.Condition.StringEquals['aws:ResourceTag/classification']).toBe('premium');
  });

  it('acts only in its own classification\'s channels, with the turn actions and no moderation verbs', () => {
    const channel = actingStatements(synth().template).find((s) => s.Sid === 'ActOnlyInThisClassificationsChannels');
    expect(channel.Resource).toBe(`${APP_INSTANCE}/channel/*`);
    expect(channel.Condition.StringEquals['aws:ResourceTag/classification']).toEqual(['premium']);
    expect(channel.Action).toEqual(ASSISTANT_TURN_CHANNEL_ACTIONS);
    for (const verb of ['chime:RedactChannelMessage', 'chime:UpdateChannel', 'chime:DeleteChannel']) {
      expect(channel.Action).not.toContain(verb);
    }
  });

  it('reads company context per assistant role, conditioned on the role tag', () => {
    const reads = actingStatements(synth().template).filter((s) => String(s.Sid).startsWith('RoleContextRead'));
    expect(reads.length).toBeGreaterThan(0);
    for (const s of reads) expect(s.Condition.StringEquals['aws:PrincipalTag/role']).toBeDefined();
    const premium = reads.find((s) => JSON.stringify(s.Resource).includes('context/premium/'));
    expect(premium.Condition.StringEquals['aws:PrincipalTag/role']).toEqual(['primary']);
  });

  it('holds no delete or batch write on the battle and experiments tables, and no bot-arn read', () => {
    // Nothing on the turn path issues them; the only deletes on these tables run on admin roles.
    const actions = actingStatements(synth().template).flatMap((s) => ([] as string[]).concat(s.Action ?? []));
    for (const a of ['dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:BatchGetItem']) expect(actions).not.toContain(a);
    expect(JSON.stringify(actingStatements(synth().template))).not.toContain('assistant/premium/bot-arn');
  });

  it('gives telemetry reads only to an observability role, and not at all when none is declared', () => {
    const withOps = actingStatements(synth().template).find((s) => s.Sid === 'RoleObservabilityRead');
    expect(withOps.Condition.StringEquals['aws:PrincipalTag/role']).toEqual(['ops']);
    expect(actingStatements(synth(['primary']).template).find((s) => s.Sid === 'RoleObservabilityRead')).toBeUndefined();
    expect(actingStatements(synth(['primary']).template).find((s) => s.Sid === 'RoleObservabilityAlarmRead')).toBeUndefined();
  });

  it('grants DescribeAlarms on this deployment\'s alarm ARNs only, never on `*`', () => {
    const statements = actingStatements(synth().template);
    const metrics = statements.find((s) => s.Sid === 'RoleObservabilityRead');
    expect([].concat(metrics.Action)).not.toContain('cloudwatch:DescribeAlarms');
    const alarms = statements.find((s) => s.Sid === 'RoleObservabilityAlarmRead');
    expect([].concat(alarms.Action)).toEqual(['cloudwatch:DescribeAlarms']);
    expect(alarms.Condition.StringEquals['aws:PrincipalTag/role']).toEqual(['ops']);
    const resources = JSON.stringify(alarms.Resource);
    expect(alarms.Resource).not.toContain('*');
    // One ARN per prefix of the core, from the one function the tool reads too. No optional capability's stack is
    // named in a deployment that declares none.
    expect(alarms.Resource).toHaveLength(coreAlarmNamePrefixes().length);
    for (const p of coreAlarmNamePrefixes()) {
      expect(resources).toContain(`:cloudwatch:us-east-1:123456789012:alarm:${p}*`);
    }
    for (const capability of ['battle', 'experiments', 'notifications']) {
      for (const p of capabilityAlarmNamePrefixes(capability)) expect(resources).not.toContain(`alarm:${p}`);
    }
    // The prefixes name this instance's stacks, so a look-alike instance's alarms are outside the grant.
    expect(deploymentAlarmNamePrefixes()).toEqual(expect.arrayContaining(['AgentEchelon-', 'AgentEchelonArchive-', 'AgentEchelonAssistants-']));
    expect(deploymentAlarmNamePrefixes().every((p) => p.endsWith('-'))).toBe(true);
  });

  it('reads a declared capability\'s alarms through a policy of its own, and an undeclared one\'s not at all', () => {
    const capabilityPolicies = (template: Template) => Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.startsWith('AssistantAlarmRead'));
    // Declared: one policy per capability, on its stacks' alarms, for the observability role alone.
    const declared = capabilityPolicies(synth(['primary', 'ops'], ['battle', 'notifications']).template);
    expect(declared).toHaveLength(2);
    for (const [capability, prefix] of [['battle', 'AgentEchelonBattle-'], ['notifications', 'AgentEchelonNotifications-']]) {
      const [, policy] = declared.find(([id]) => id.startsWith(`AssistantAlarmRead${capability}`)) as [string, any];
      const [statement] = policy.Properties.PolicyDocument.Statement;
      expect([].concat(statement.Action)).toEqual(['cloudwatch:DescribeAlarms']);
      expect(JSON.stringify(statement.Resource)).toContain(`:alarm:${prefix}*`);
      expect(statement.Condition.StringEquals['aws:PrincipalTag/role']).toEqual(['ops']);
    }
    // Undeclared, or no observability role: none.
    expect(capabilityPolicies(synth().template)).toEqual([]);
    expect(capabilityPolicies(synth(['primary'], ['battle']).template)).toEqual([]);
    // Every capability's stacks together with the core's are every alarm the deployment can declare.
    expect(deploymentAlarmNamePrefixes().length).toBeGreaterThan(coreAlarmNamePrefixes().length);
  });

  it('lets an observability role read the published alarm names, on that path alone', () => {
    const names = actingStatements(synth().template).find((s) => s.Sid === 'RoleObservabilityAlarmNames');
    expect([].concat(names.Action)).toEqual(['ssm:GetParametersByPath']);
    expect(JSON.stringify(names.Resource)).toMatch(/:parameter\/agent-echelon\/alarms"/);
    expect(names.Condition.StringEquals['aws:PrincipalTag/role']).toEqual(['ops']);
    expect(actingStatements(synth(['primary']).template).find((s) => s.Sid === 'RoleObservabilityAlarmNames')).toBeUndefined();
  });

  it('caps every session with a boundary that denies IAM, chaining and retagging', () => {
    const { template } = synth();
    expect(actingRole(template).props.PermissionsBoundary).toBeDefined();
    const deny = boundaryStatements(template).find((s) => s.Sid === 'AnAssistantNeverEditsIdentityOrChains');
    expect(deny.Effect).toBe('Deny');
    for (const a of ['iam:*', 'sts:AssumeRole', 'chime:TagResource', 'chime:UntagResource']) expect(deny.Action).toContain(a);
  });

  it('denies, in the boundary, acting in a channel or as a bot outside this classification', () => {
    const b = boundaryStatements(synth().template);
    const channel = b.find((s) => s.Sid === 'BoundaryNoChannelOutsideThisClassification');
    expect(channel.Effect).toBe('Deny');
    expect(channel.Action).toEqual(CLASSIFICATION_GATED_CHANNEL_ACTIONS);
    // A negated operator also matches when the key is absent, so an untagged channel is refused.
    expect(channel.Condition.StringNotEquals['aws:ResourceTag/classification']).toEqual(['premium']);
    const bot = b.find((s) => s.Sid === 'BoundaryNoBotOutsideThisClassification');
    expect(bot.Condition.StringNotEquals['aws:ResourceTag/classification']).toBe('premium');
  });

  it('denies telemetry to every session that is not an observability role, in the boundary too', () => {
    const withOps = boundaryStatements(synth().template).find((s) => s.Sid === 'BoundaryTelemetryOnlyForObservabilityRoles');
    expect(withOps.Condition.StringNotEquals['aws:PrincipalTag/role']).toEqual(['ops']);
    const none = boundaryStatements(synth(['primary']).template).find((s) => s.Sid === 'BoundaryTelemetryOnlyForObservabilityRoles');
    expect(none.Condition).toBeUndefined();
  });

  it('allows S3, in the boundary, only on the objects a turn uses and the context the classification grants, naming no other classification', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S', { env: { account: '123456789012', region: 'us-east-1' } });
    const vendRole = new iam.Role(stack, 'VendRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    assistantActingRole(stack, {
      classification: 'basic', appInstanceArn: APP_INSTANCE, vendRole, roles: ['primary'],
      sessionChannelActions: ASSISTANT_TURN_CHANNEL_ACTIONS, contextBucketArn: BUCKET,
    });
    const managed = Template.fromStack(stack).findResources('AWS::IAM::ManagedPolicy');
    const statements = (Object.values(managed)[0] as any).Properties.PolicyDocument.Statement as any[];
    // No S3 on `*`: the services statement leaves it out, so S3 is only what the statements below allow.
    const services = statements.find((s) => s.Sid === 'BoundaryTheServicesATurnUses');
    expect(JSON.stringify(services.Action)).not.toContain('s3:');
    const s3 = statements.filter((s) => JSON.stringify(s.Action).includes('s3:'));
    expect(s3.every((s) => s.Effect === 'Allow' && !JSON.stringify(s.Resource).includes('"*"'))).toBe(true);
    const objects = statements.find((s) => s.Sid === 'BoundaryObjectsATurnUses');
    const granted = defaultProfileRegistry.grantsFor('basic');
    expect(objects.Resource).toEqual(expect.arrayContaining([
      `${BUCKET}/attachments/*`, `${BUCKET}/generated-docs/*`, `${BUCKET}/profiles/*`,
      ...granted.map((g) => `${BUCKET}/context/${g}/*`),
      ...granted.map((g) => `${BUCKET}/platform-knowledge/${g}/*`),
    ]));
    const listing = statements.find((s) => s.Sid === 'BoundaryListingItsOwnPrefixes');
    expect(listing.Resource).toBe(BUCKET);
    expect([].concat(listing.Condition.StringLike['s3:prefix']).sort())
      .toEqual([...granted.map((g) => `context/${g}/*`), ...granted.map((g) => `platform-knowledge/${g}/*`)].sort());
    // NAMES NO OTHER CLASSIFICATION: every classified prefix the boundary holds is one this classification
    // grants, so one declared later, or never, is outside it without being listed.
    const classified = JSON.stringify(s3).match(/(context|platform-knowledge)\/[^/*"]+\//g) ?? [];
    expect(classified.length).toBeGreaterThan(0);
    for (const p of classified) expect(granted).toContain(p.split('/')[1]);
    // ITS OWN INTENT-PACK BODIES and no other classification's, granted or not: a pack is the
    // classification's own configuration, not context it shares down.
    expect(objects.Resource).toContain(`${BUCKET}/classification-packs/basic/*`);
    expect(JSON.stringify(s3).match(/classification-packs\/[^"]*/g)).toEqual(['classification-packs/basic/*']);
    expect(statements.some((s) => /NoOtherClassificationsContext/.test(String(s.Sid)))).toBe(false);
  });

  it('admits a context source in another bucket only where the stack that grants it adds it', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'C', { env: { account: '123456789012', region: 'us-east-1' } });
    const vendRole = new iam.Role(stack, 'VendRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    const { boundary } = assistantActingRole(stack, {
      classification: 'basic', appInstanceArn: APP_INSTANCE, vendRole, roles: ['primary'],
      sessionChannelActions: ASSISTANT_TURN_CHANNEL_ACTIONS, contextBucketArn: BUCKET,
    });
    allowContextSourceObjects(boundary, ['arn:aws:s3:::catalog-bucket/digests/*']);
    const statements = (Object.values(Template.fromStack(stack).findResources('AWS::IAM::ManagedPolicy'))[0] as any).Properties.PolicyDocument.Statement as any[];
    expect(statements.find((s) => s.Sid === 'BoundaryContextSourceObjects')).toEqual(expect.objectContaining({
      Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::catalog-bucket/digests/*',
    }));
  });

  it('holds no per-assistant grant: no statement names a literal bot', () => {
    const json = JSON.stringify(actingStatements(synth().template));
    expect(json).not.toMatch(/\/bot\/[0-9a-f-]{8,}/);
  });
});

describe('the catalog of session policies a vended session is narrowed to', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { assistantGrantCatalog } = require('../lib/stacks/agent-classification-common');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getModelCatalog } = require('../lib/config/model-strategy');

  function catalogTemplate() {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'G', { env: { account: '123456789012', region: 'us-east-1' } });
    const out = assistantGrantCatalog(stack, {
      classification: 'standard',
      modelCatalog: getModelCatalog('us-east-1', '123456789012'),
      classificationModelArns: ['arn:aws:bedrock:us-east-1::foundation-model/m'],
      contextRoutingArns: [],
      imageModelArns: { stability_image_core: 'arn:aws:bedrock:*::foundation-model/stability.stable-image-core-v1:1' },
      streaming: false,
    });
    return { template: Template.fromStack(stack), out };
  }
  const policyNamed = (template: Template, name: string) => {
    const hit = Object.values(template.findResources('AWS::IAM::ManagedPolicy'))
      .find((p: any) => p.Properties.ManagedPolicyName === name) as any;
    expect(hit).toBeTruthy();
    return hit.Properties.PolicyDocument.Statement as any[];
  };

  it('publishes base and one policy per narrowable edge, under a name the vend can build', () => {
    const { out } = catalogTemplate();
    expect(out.edges).toEqual(expect.arrayContaining(['base', 'context', 'platform', 'telemetry', 'models-all', 'image-stability_image_core']));
    expect(out.edges).not.toContain('models-opus'); // standard is denied Opus, so there is no edge to select it
    expect(out.policyArnPrefix).toContain(':policy/AgentEchelonAssistantGrant-standard-');
  });

  it('base reaches nothing a definition can leave out: no model, no context or platform object, no telemetry', () => {
    const { template } = catalogTemplate();
    const base = policyNamed(template, 'AgentEchelonAssistantGrant-standard-base');
    const everything = base.find((s) => s.NotAction);
    for (const a of ['bedrock:InvokeModel', 's3:GetObject', 's3:ListBucket', 'cloudwatch:GetMetricData', 'cloudwatch:DescribeAlarms']) {
      expect(everything.NotAction).toContain(a);
    }
    const objects = base.find((s) => s.NotResource);
    expect(objects.NotResource).toEqual(expect.arrayContaining(['arn:aws:s3:::*/context/*', 'arn:aws:s3:::*/platform-knowledge/*']));
    expect(base.some((s) => s.Effect !== 'Allow')).toBe(false);
  });

  it('the telemetry edge narrows DescribeAlarms to this instance\'s alarm ARNs, naming no capability', () => {
    // The session edge only narrows the acting role, whose grant names each declared stack's alarms, so the edge
    // names the instance's stack-name family and stays the same whatever a deployment declares.
    const { template } = catalogTemplate();
    const telemetry = policyNamed(template, 'AgentEchelonAssistantGrant-standard-telemetry');
    const alarms = telemetry.find((s) => [].concat(s.Action).includes('cloudwatch:DescribeAlarms' as never));
    expect([].concat(alarms.Action)).toEqual(['cloudwatch:DescribeAlarms']);
    expect(alarms.Resource).not.toContain('*');
    expect([].concat(alarms.Resource)).toHaveLength(1);
    expect(JSON.stringify(alarms.Resource)).toMatch(/:cloudwatch:us-east-1:123456789012:alarm:AgentEchelon\*"/);
  });

  it('each model edge grants only its own model', () => {
    const { template } = catalogTemplate();
    const sonnet = policyNamed(template, 'AgentEchelonAssistantGrant-standard-models-sonnet');
    const resources = ([] as string[]).concat(...sonnet.map((s) => s.Resource));
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) expect(r.toLowerCase()).toContain('sonnet');
  });
});
