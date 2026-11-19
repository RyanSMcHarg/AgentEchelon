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
  coreAlarmNamePrefixes,
  deploymentAlarmNamePrefixes,
} from '../lib/stacks/agent-classification-common';
import { defaultProfileRegistry } from '../lib/profile-registry';

const APP_INSTANCE = 'arn:aws:chime:us-east-1:123456789012:app-instance/abc';
const ATTACHMENTS = 'arn:aws:s3:::attachments-bucket';
const COMPANY = 'arn:aws:s3:::company-bucket';
const PROFILE = 'arn:aws:s3:::profile-bucket';
const BUCKETS = { attachmentsBucketArn: ATTACHMENTS, companyBucketArn: COMPANY, profileBucketArn: PROFILE };

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
    buckets: BUCKETS,
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

  // ANY ALARM, READ BY NAME (SPEC-WORKFLOWS-AND-TASKS WT120): an incident is opened by whichever alarm its team attached, which
  // need not be this deployment's, and its first look reads that alarm. So the alarm read reaches the account's alarms, read by
  // name (`deployment-health.ts` names the published alarms and the one its conversation watches, and never lists), and it
  // stays an observability role's alone: the role condition here and the boundary's Deny below.
  it('grants DescribeAlarms on the account\'s alarms to an observability role alone, and nothing else on that statement', () => {
    const statements = actingStatements(synth().template);
    const metrics = statements.find((s) => s.Sid === 'RoleObservabilityRead');
    expect([].concat(metrics.Action)).not.toContain('cloudwatch:DescribeAlarms');
    const alarms = statements.filter((s) => ([] as string[]).concat(s.Action).includes('cloudwatch:DescribeAlarms'));
    expect(alarms).toHaveLength(1);
    expect(alarms[0].Sid).toBe('RoleObservabilityAlarmRead');
    expect([].concat(alarms[0].Action)).toEqual(['cloudwatch:DescribeAlarms']);
    expect(alarms[0].Condition.StringEquals['aws:PrincipalTag/role']).toEqual(['ops']);
    expect(JSON.stringify(alarms[0].Resource)).toContain(':cloudwatch:us-east-1:123456789012:alarm:*');
    expect(alarms[0].Resource).not.toContain('*');
  });

  it('holds one alarm read whatever capabilities are declared, and none without an observability role', () => {
    const capabilityPolicies = (template: Template) => Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.startsWith('AssistantAlarmRead'));
    expect(capabilityPolicies(synth(['primary', 'ops'], ['battle', 'notifications']).template)).toEqual([]);
    expect(actingStatements(synth(['primary'], ['battle']).template).some((s) => ([] as string[]).concat(s.Action).includes('cloudwatch:DescribeAlarms'))).toBe(false);
    // The published names the tool reads still name every stack this instance can create, and no look-alike's.
    expect(deploymentAlarmNamePrefixes()).toEqual(expect.arrayContaining(['AgentEchelon-', 'AgentEchelonArchive-', 'AgentEchelonAssistants-']));
    expect(deploymentAlarmNamePrefixes().every((p) => p.endsWith('-'))).toBe(true);
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
    // Premium acts in its own channels alone, so one statement refuses a channel and a bot outside it.
    const both = b.find((s) => s.Sid === 'BoundaryNoChannelOrBotOutsideThisClassification');
    expect(both.Effect).toBe('Deny');
    expect(both.Action).toEqual(CLASSIFICATION_GATED_CHANNEL_ACTIONS);
    const covered = JSON.stringify(both.Resource);
    expect(covered).toContain('/channel/*');
    expect(covered).toContain('/bot/*');
    // A negated operator also matches when the key is absent, so an untagged channel is refused.
    expect([].concat(both.Condition.StringNotEquals['aws:ResourceTag/classification'])).toEqual(['premium']);
    expect(b.some((s) => s.Sid === 'BoundaryNoChannelOutsideThisClassification' || s.Sid === 'BoundaryNoBotOutsideThisClassification')).toBe(false);
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
      sessionChannelActions: ASSISTANT_TURN_CHANNEL_ACTIONS, buckets: BUCKETS,
    });
    const managed = Template.fromStack(stack).findResources('AWS::IAM::ManagedPolicy');
    const statements = (Object.values(managed)[0] as any).Properties.PolicyDocument.Statement as any[];
    // No S3 on `*`: the services statement leaves it out, so S3 is only what the statements below allow.
    const services = statements.find((s) => s.Sid === 'BoundaryTheServicesATurnUses');
    expect(JSON.stringify(services.Action)).not.toContain('s3:');
    const s3 = statements.filter((s) => JSON.stringify(s.Action).includes('s3:'));
    expect(s3.every((s) => !JSON.stringify(s.Resource).includes('"*"'))).toBe(true);
    // The one Deny narrows a dashboard write to the roles a dashboard tool is offered to.
    expect(s3.filter((s) => s.Effect !== 'Allow').map((s) => s.Sid)).toEqual(['BoundaryDashboardsOnlyForDashboardRoles']);
    // WHAT CONVERSATIONS PRODUCE, read and written, in the attachments bucket and nowhere else.
    const objects = statements.find((s) => s.Sid === 'BoundaryObjectsATurnUses');
    // Its own classification's dashboards share the statement: the classification is in the key.
    expect([].concat(objects.Resource).sort()).toEqual([`${ATTACHMENTS}/attachments/*`, `${ATTACHMENTS}/battle-images/*`, `${ATTACHMENTS}/dashboards/basic/*`, `${ATTACHMENTS}/generated-docs/*`]);
    // WHAT THE ASSISTANT IS AND WHAT ITS CLASSIFICATION KNOWS, read only: profile bodies and its pack in the profile
    // bucket, its granted context and self-knowledge in the company bucket.
    const reads = statements.find((s) => s.Sid === 'BoundaryWhatATurnReads');
    const granted = defaultProfileRegistry.grantsFor('basic');
    expect([].concat(reads.Action)).toEqual(['s3:GetObject']);
    expect(reads.Resource).toEqual(expect.arrayContaining([
      `${PROFILE}/profiles/*`,
      ...granted.map((g) => `${COMPANY}/context/${g}/*`),
      ...granted.map((g) => `${COMPANY}/platform-knowledge/${g}/*`),
    ]));
    const listing = statements.find((s) => s.Sid === 'BoundaryListingItsOwnPrefixes');
    expect(listing.Resource).toBe(COMPANY);
    expect([].concat(listing.Condition.StringLike['s3:prefix']).sort())
      .toEqual([...granted.map((g) => `context/${g}/*`), ...granted.map((g) => `platform-knowledge/${g}/*`)].sort());
    // NAMES NO OTHER CLASSIFICATION: every classified prefix the boundary holds is one this classification
    // grants, so one declared later, or never, is outside it without being listed.
    const classified = JSON.stringify(s3).match(/(context|platform-knowledge)\/[^/*"]+\//g) ?? [];
    expect(classified.length).toBeGreaterThan(0);
    for (const p of classified) expect(granted).toContain(p.split('/')[1]);
    // ITS OWN INTENT-PACK BODIES and no other classification's, granted or not: a pack is the
    // classification's own configuration, not context it shares down.
    expect(reads.Resource).toContain(`${PROFILE}/classification-packs/basic/*`);
    expect(JSON.stringify(s3).match(/classification-packs\/[^"]*/g)).toEqual(['classification-packs/basic/*']);
    expect(statements.some((s) => /NoOtherClassificationsContext/.test(String(s.Sid)))).toBe(false);
  });

  it('admits a context source in another bucket only where the stack that grants it adds it', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'C', { env: { account: '123456789012', region: 'us-east-1' } });
    const vendRole = new iam.Role(stack, 'VendRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    const { boundary } = assistantActingRole(stack, {
      classification: 'basic', appInstanceArn: APP_INSTANCE, vendRole, roles: ['primary'],
      sessionChannelActions: ASSISTANT_TURN_CHANNEL_ACTIONS, buckets: BUCKETS,
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

  it('the telemetry edge reaches the account\'s alarms, as the acting role does, and nothing wider', () => {
    // The session edge only narrows the acting role, whose alarm read reaches the account's alarms by name
    // (WT120), so the edge names the same: an alarm ARN, never `*`.
    const { template } = catalogTemplate();
    const telemetry = policyNamed(template, 'AgentEchelonAssistantGrant-standard-telemetry');
    const alarms = telemetry.find((s) => [].concat(s.Action).includes('cloudwatch:DescribeAlarms' as never));
    expect([].concat(alarms.Action)).toEqual(['cloudwatch:DescribeAlarms']);
    expect(alarms.Resource).not.toContain('*');
    expect([].concat(alarms.Resource)).toHaveLength(1);
    expect(JSON.stringify(alarms.Resource)).toMatch(/:cloudwatch:us-east-1:123456789012:alarm:\*"/);
  });

  it('each model edge grants only its own model', () => {
    const { template } = catalogTemplate();
    const sonnet = policyNamed(template, 'AgentEchelonAssistantGrant-standard-models-sonnet');
    const resources = ([] as string[]).concat(...sonnet.map((s) => s.Resource));
    expect(resources.length).toBeGreaterThan(0);
    for (const r of resources) expect(r.toLowerCase()).toContain('sonnet');
  });
});
