#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MessagingStack } from '../lib/stacks/messaging-stack';
import { IdentityStack } from '../lib/stacks/identity-stack';
import { ConversationsStack } from '../lib/stacks/conversations-stack';
import { ArchiveStack } from '../lib/stacks/archive-stack';
import { ArchiveStackAurora } from '../lib/stacks/archive-stack-aurora';
import { IArchiveStackOutputs } from '../lib/interfaces/archive-stack-interface';
import { TestInboxStack, testInboxStackProps } from '../lib/stacks/test-inbox-stack';
import { IMAGE_GEN_MODELS } from '../lambda/src/lib/image-gen-models';
import { RES_PREFIX, SSM_ROOT } from '../lib/stacks/agent-classification-common';
import { ImageGuardrailStack } from '../lib/stacks/image-guardrail-stack';
import { AssistantsStack, assistantsStackName } from '../lib/stacks/assistant-profile-stack';
import { ChannelFlowStack } from '../lib/stacks/channel-flow-stack';
import { PostProcessingStack } from '../lib/stacks/post-processing-stack';
import { PersonApiStack } from '../lib/stacks/person-api-stack';
import { isRouteSource, routesFor } from '../lib/constructs/http-api';
import { describeGap, typeCapabilityGaps } from '../lib/config/type-capabilities';
import {
  STACK_PREFIX,
  APP_INSTANCE_NAME,
  INSTANCE_NAME,
} from '../lib/stacks/agent-classification-common';
import { deployedAssistantClassifications, resolveDeploymentProfiles } from '../lib/config/profiles';
import { defaultProfileRegistry, useDeploymentProfiles } from '../lib/profile-registry';
import { assertClassificationsDeclared } from '../lib/config/declared-classifications';
import { ProfileRegistryReaders } from '../lib/constructs/profile-registry-readers';
import { DeploymentLanguagesEnv } from '../lib/constructs/deployment-languages-env';
import { resolveDeploymentLanguages } from '../lib/config/languages';
import { assertNoRetiredContext } from '../lib/config/deploy-context';
import { parseEnvironment } from '../lib/config/environment';
import { declaresWidgetHost, directoryOf, issuerRegistry, parseIssuersContext } from '../lib/config/issuers';
import { provisionerIssuers } from '../lib/constructs/subject-provisioner';
import { splitTestFixtures } from '../lib/config/test-issuers';
import { TestIssuerStack } from '../lib/stacks/test-issuer-stack';
import { WidgetHostStack } from '../lib/stacks/widget-host-stack';
import { buildCapabilities, resolveCapabilities, type CoreStacks, type DeploymentSettings } from '../lib/config/capabilities';
import { applyStandardTags } from '../lib/tagging';
import { enforceInlinePolicyBudget } from '../lib/constructs/inline-policy-budget';
import { publishAlarmNames } from '../lib/constructs/alarm-names';
import { ExcludeOwnerTeamTag } from '../lib/constructs/exclude-owner-team-tag';
import { stackIdOf } from '../lib/config/stack-names';
import { connectorRegistry } from '../lib/config/connectors';
import { connectorContextOf } from '../lib/constructs/connectors';
import { connectorGrantsFunctionName } from '../lib/stacks/connectors-stack';

/** A stack id under this instance's prefix, for a name `lib/config/stack-names.json` lists (the one name source). */
const stackId = (name: string): string => stackIdOf(STACK_PREFIX, name);

/**
 * Parse the `wafAllowedIps` context into a CIDR list. Accepts a JSON array
 * (`["1.2.3.4/32"]`), a comma-separated string (`1.2.3.4/32, 5.6.7.8/32`), or
 * an already-parsed array. Anything falsy → [] (no WAF).
 */
function parseWafAllowedIps(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean);
      } catch {
        // fall through to comma-split
      }
    }
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

const app = new cdk.App();
// Only the ownership function may write an assistant's `owner-team` tag: every other tag grant in
// the app is rendered with that key excluded (SPEC-ADMIN-CONSOLE FR47).
cdk.Aspects.of(app).add(new ExcludeOwnerTeamTag());

// THE DEPLOYMENT'S CLASSIFICATIONS AND PROFILES (`profiles` in deploy.config.json, `resolveDeploymentProfiles`
// in lib/config/profiles.ts): a selection of the shipped catalog, a fully custom set, or, declared as
// nothing, the shipped catalog minus its outside classifications (`guest`, `customer`). The admin plane is
// in every set. Refused at synth when malformed (`validateProfilesConfig`: every classification declares
// grants, grants itself, and declares a set no other classification declares; profile refs resolve; no
// alias collisions). Installed as the registry every stack reads. Each classification's stack publishes its own
// row of it, and Identity the admin plane's, and every function the app builds reads those rows at runtime
// (`ProfileRegistryReaders`), so the stacks and the handlers read one set and no stack carries another's.
const deploymentProfiles = resolveDeploymentProfiles(app.node.tryGetContext('profiles'));
useDeploymentProfiles(deploymentProfiles);
cdk.Aspects.of(app).add(new ProfileRegistryReaders(SSM_ROOT, RES_PREFIX));

// THE LANGUAGES THIS DEPLOYMENT SPEAKS (`languages` in deploy.config.json, `lib/config/languages.ts`): a closed list
// of catalog tags, its own language first. Refused at synth when a tag is one the platform cannot name. Every function
// is told the list when it is not the default, so every reader holds one set.
cdk.Aspects.of(app).add(new DeploymentLanguagesEnv(resolveDeploymentLanguages(app.node.tryGetContext('languages'))));

// A retired context key fails the synth with the name of what replaced it, so nobody deploys
// believing a removed switch still works (`RETIRED_CONTEXT_KEYS`).
assertNoRetiredContext((key) => app.node.tryGetContext(key));

// THE DECLARED CAPABILITIES (`lib/config/capabilities.ts`). The required core is always built; every
// other stack exists because its capability is named here. Refused at synth when a name is unknown, is
// not built yet, or lacks a capability it requires.
const capabilities = resolveCapabilities(app.node.tryGetContext('capabilities'));

// THE CLASSIFICATIONS THAT GET AN ASSISTANT STACK: every one the profile registry declares with a
// topology. Refused when a conversational classification declares none, since no stack would serve it.
const assistantClassificationValues = deployedAssistantClassifications(deploymentProfiles);

// THE TRUSTED-ISSUER REGISTRY (`lib/config/issuers.ts`): which issuers a person may sign in through, and
// what each one's people reach. Refused at synth when an entry declares no clearance source, a kind or
// mode is not built, `admin: true` sits on a kind outside the staff, or the admin capability has no
// issuer that is not the guest (L18). Absent, the deployment trusts its own pool alone.
//
// TEST-FIXTURE ENTRIES (`owner: "test-fixture"`, `lib/config/test-issuers.ts`) are split out first: each
// gets a pool in the opt-in TestIssuer stack, and joins the registry only once it names that pool. Refused
// in production.
const testFixtures = splitTestFixtures(
  parseIssuersContext(app.node.tryGetContext('issuers')),
  parseEnvironment(app.node.tryGetContext('environment')),
);
if (testFixtures?.pending.length) {
  console.warn(`\n⚠️  test-fixture issuers ${testFixtures.pending.join(', ')} name no pool yet: TestIssuer creates their pools, `
    + 'and each is trusted once its entry carries the ids that stack outputs.\n');
}
// AN ISSUER OR CONVERSATION TYPE NAMING A CLASSIFICATION THE DEPLOYMENT DOES NOT DECLARE IS REFUSED, naming
// the classification to declare: the guest issuer needs `guest` and its path B `customer`, an
// invitation-link issuer every classification a type's link classifications name (lib/config/declared-classifications.ts).
assertClassificationsDeclared(testFixtures?.trusted, defaultProfileRegistry);
// In production it also refuses the guest issuer's captcha test keys, any setting its block does not know
// (there is no bypass) and a per-address limit of 0 (L16).
const issuers = issuerRegistry(testFixtures?.trusted, defaultProfileRegistry, {
  capabilities: capabilities.names,
  environment: parseEnvironment(app.node.tryGetContext('environment')),
});
// THE CONNECTOR REGISTRY (`lib/config/connectors.ts`): the vendors this deployment integrates with, beside
// the `connectors` capability. Refused at synth when an entry is malformed, names a vendor or capability not
// built, or names an issuer the registry does not declare; and when either is declared without the other.
const connectors = connectorRegistry(app.node.tryGetContext('connectors'), connectorContextOf(issuers), capabilities.names);
{
  // THE GUEST'S PER-PERSON MESSAGE LIMIT IS A LIMIT IN PRODUCTION (L16): a 0 there would limit nothing.
  const guest = issuers.guest();
  if (guest && parseEnvironment(app.node.tryGetContext('environment')) === 'production') {
    for (const c of (guest.clearance as { fixed?: string[] }).fixed ?? []) {
      if (defaultProfileRegistry.profileFor(c)?.rateLimitPerHour === 0) {
        throw new Error(`issuers: the guest issuer's classification "${c}" has a message limit of 0, which production refuses`);
      }
    }
  }
  // A HOST'S CONTEXT CONVERSATIONS ARE CREATED BY THEIR CLASSIFICATION'S CREATOR, which exists for a
  // classification with an assistant stack only.
  const context = issuers.contextClassification();
  if (context && !assistantClassificationValues.includes(context)) {
    throw new Error(`issuers: oneChannel names "${context}", which this deployment creates no assistant stack for`);
  }
}

// Environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Analytics mode: 'athena' (default) or 'aurora' (opt-in VPC + PostgreSQL)
const analyticsMode: 'athena' | 'aurora' =
  app.node.tryGetContext('analyticsMode') || 'athena';

// Live drift detection (SPEC-DRIFT-CONVERGENCE.md + ADR-013): conversation-level
// + ALL-tier (basic/standard/premium). **OPT-IN, default OFF** — matches
// docs/guides/admin/AURORA-MODE-GUIDE.md §"Drift detection (Aurora-only)": "Default `false` ships the analytics-only post-hoc
// path". It REQUIRES analyticsMode=aurora; in Athena mode there is no Aurora to
// query, so drift is inert regardless.
//
// WHY default OFF: it is the documented contract (docs/guides/admin/AURORA-MODE-GUIDE.md, ADR-013
// decision 4) — a plain `cdk deploy -c analyticsMode=aurora` ships the
// analytics-only post-hoc path, and the live user-facing suggestion is an
// explicit opt-in. It is NOT off because the live path is broken: the original
// reason (ADR-013 §"the live-drift re-homing broke agent replies") was that
// `auroraDriftWiring` VPC-attached each agent handler to PRIVATE_ISOLATED
// subnets, severing its egress to Amazon Chime SDK Messaging so every reply hung
// to the 30s timeout. That is FIXED: retrieval and drift now run in a dedicated
// VPC-attached data-plane Lambda and the handler stays non-VPC, invoking it
// (ADR-013; see docs/guides/user/TROUBLESHOOTING.md §16 "Live drift returns `{"Code":429}`").
// Opting in with `-c enableLiveDrift=true` is therefore safe on the current build.
const enableLiveDrift: boolean =
  analyticsMode === 'aurora'
  && (app.node.tryGetContext('enableLiveDrift') === true
    || app.node.tryGetContext('enableLiveDrift') === 'true');

if (app.node.tryGetContext('enableLiveDrift') && analyticsMode !== 'aurora') {
  console.warn(
    '\n⚠️  enableLiveDrift requires analyticsMode=aurora (drift needs Aurora pgvector).\n'
      + '   In Athena mode it is inert. Deploy with --context analyticsMode=aurora.\n',
  );
}

// BYO existing-VPC for Aurora mode. `analyticsVpcId`
// imports an existing VPC (via fromLookup) instead of creating a dedicated one,
// so an Aurora deploy can share a VPC already in the account and avoid a second
// VPC + endpoint footprint. `analyticsVpcSubnetType` (isolated|private|public,
// default isolated) picks which subnet tier of the imported VPC hosts the data
// plane. `createVpcEndpoints` (default true) can be set false when the imported
// VPC already provides AWS-API egress (its own endpoints or a NAT), to avoid
// duplicate-endpoint CREATE failures and redundant cost.
const analyticsVpcId: string | undefined =
  app.node.tryGetContext('analyticsVpcId') || undefined;
const analyticsVpcSubnetType = (
  app.node.tryGetContext('analyticsVpcSubnetType') || 'isolated'
) as 'isolated' | 'private' | 'public';
const createVpcEndpoints: boolean =
  app.node.tryGetContext('createVpcEndpoints') !== false
  && app.node.tryGetContext('createVpcEndpoints') !== 'false';

// RDS Proxy is OFF by default. On Aurora Serverless v2 the proxy bills a fixed
// 8-ACU minimum (~$86/mo) regardless of load, so for a low-traffic cluster it
// costs more than the database it fronts. By default the analytics Lambdas connect
// directly to the Aurora writer endpoint with IAM auth. Enable the proxy only for
// high Lambda-concurrency workloads that need connection pooling: `-c enableRdsProxy=true`.
const enableRdsProxy: boolean =
  app.node.tryGetContext('enableRdsProxy') === true
  || app.node.tryGetContext('enableRdsProxy') === 'true';

if (analyticsVpcId && analyticsMode !== 'aurora') {
  console.warn(
    '\n⚠️  analyticsVpcId only applies in Aurora mode (it imports the VPC the\n'
      + '   Aurora pipeline runs in). Athena mode has no VPC. Ignoring.\n',
  );
}

// Configurable via environment variables or CDK context
const PLACEHOLDER_SENDER = 'noreply@example.com';
const senderEmail = app.node.tryGetContext('senderEmail')
  || process.env.SES_SENDER_EMAIL
  || PLACEHOLDER_SENDER;
const appUrl = app.node.tryGetContext('appUrl')
  || process.env.APP_URL
  || 'http://localhost:5173';
// THE DEPLOYMENT ENVIRONMENT, one value (`lib/config/environment.ts`): `dev` or `production`, refused
// at synth when it is anything else. Every stack reads the same value through the same module, so
// production's RETAIN applies wherever a stack keeps data.
const environment = parseEnvironment(app.node.tryGetContext('environment'));
// Set true when senderEmail is already a verified SES identity (or domain-verified
// / externally managed) — skips creating the per-address EmailIdentity, which CFN
// cannot do for an identity that already exists.
const senderEmailPreVerified =
  app.node.tryGetContext('senderEmailPreVerified') === 'true'
  || app.node.tryGetContext('senderEmailPreVerified') === true
  || process.env.SENDER_EMAIL_PRE_VERIFIED === 'true';

// Frontend WAF (AgentEchelonChatApp / CloudFront).
// - Managed-rules protection is ON BY DEFAULT (AWS Managed Common +
//   Known-Bad-Inputs + IP-reputation + per-IP rate limit). Opt out with
//   `--context frontendWaf=false`; tune the rate with `--context wafRateLimit=N`.
// - `wafAllowedIps` optionally locks the distribution to specific IPv4 CIDRs
//   (private deployments), on top of the managed rules. Accepts a JSON array or
//   comma-separated string, e.g.
//   `--context wafAllowedIps='["203.0.113.4/32"]'` or `...=203.0.113.4/32,198.51.100.0/24`.
const enableManagedWaf = app.node.tryGetContext('frontendWaf') !== false
  && app.node.tryGetContext('frontendWaf') !== 'false';
const wafRateLimitCtx = app.node.tryGetContext('wafRateLimit');
const wafRateLimit = wafRateLimitCtx ? Number(wafRateLimitCtx) : undefined;
const wafAllowedIps = parseWafAllowedIps(app.node.tryGetContext('wafAllowedIps'));

// Warn when the sender is the placeholder email (the notifications capability, the post-delivery bridge and the alerts send from it).
// SES rejects unverified identities, so the share-conversation Lambda would
// swallow every SendEmail call at runtime. Require an explicit value.
if (senderEmail === PLACEHOLDER_SENDER) {
  console.warn(
    '\n⚠️  SES_SENDER_EMAIL is unset — using placeholder "noreply@example.com".\n' +
    '   Share-conversation email delivery WILL fail at runtime.\n' +
    '   Set via: cdk deploy --context senderEmail=you@example.com (or SES_SENDER_EMAIL env var)\n'
  );
}

// ── THE REQUIRED CORE ──────────────────────────────────────────────────────────────────────────────
//
// Every deployment stands these up. What else exists is the declared capability list (`capabilities`,
// resolved above): each capability's stacks come from its registry entry (`lib/config/capabilities.ts`),
// and a capability that is not declared leaves no stack behind.

// 1. Messaging: the Amazon Chime SDK app instance, and the message stream it publishes to.
const messagingStack = new MessagingStack(app, stackId('Messaging'), {
  env,
  appInstanceName: APP_INSTANCE_NAME,
  description: 'The Amazon Chime SDK app instance, its service admin and retention, and the message stream',
});

// 2. Identity: the credential exchange and its roles, Identities, offboarding, the trail, and this
// deployment's own user pool when the registry declares an issuer on it (L15). Nothing in it is
// administration but the admin console's app client on that pool, with `admin`.
const identityStack = new IdentityStack(app, stackId('Identity'), {
  env,
  appInstanceArn: messagingStack.appInstanceArn,
  adminConsoleClient: capabilities.has('admin'),
  // Offboarding revokes a person's connector grants (K3) when a declared connector takes them.
  connectorGrantsFunction: connectors.withGrants().length ? connectorGrantsFunctionName() : undefined,
  // Who may pre-assign a provisioned-only issuer's subject (P-13): the admin backend, and the connector receiver.
  subjectProvisioners: provisionerIssuers(issuers, connectors, capabilities),
  // Replies by email (M-8): the reply poster posts on the one-conversation role, so its role is created here.
  emailReplies: capabilities.has('notifications') && Boolean(String(app.node.tryGetContext('replyDomain') || '').trim()),
  // Offboarding erases the person named on a conversation's battle setting (the Battle stack's table) with `battle`.
  battle: capabilities.has('battle'),
  description: 'Identity: the credential exchange, Identities, offboarding, the platform trail and the user pool',
});

// Test inbox: a mailbox the e2e suite reads, so a notification test asserts delivery (SPEC-NOTIFICATION-BRIDGE).
// OPT-IN with `-c testInboxDomain=<a domain used only for tests>`. A deployer who already receives mail into S3
// declares that bucket beside the domain (`testInboxBucket`, `testInboxPrefix`), and no stack is created: the
// domain's receipt rule is not this deployment's (README, "Test inbox").
const testInbox = testInboxStackProps({
  testInboxDomain: app.node.tryGetContext('testInboxDomain'),
  testInboxBucket: app.node.tryGetContext('testInboxBucket'),
  testInboxPrefix: app.node.tryGetContext('testInboxPrefix'),
  testInboxRuleSet: app.node.tryGetContext('testInboxRuleSet'),
  testInboxDomainVerified: app.node.tryGetContext('testInboxDomainVerified'),
  testInboxHostedZoneId: app.node.tryGetContext('testInboxHostedZoneId'),
  testInboxHostedZoneName: app.node.tryGetContext('testInboxHostedZoneName'),
});
if (testInbox) {
  new TestInboxStack(app, stackId('TestInbox'), {
    env,
    ...testInbox,
    description: 'AgentEchelon e2e test inbox (SES receipt rule into S3)',
  });
}

// Test issuer: the non-pool people the e2e suite signs in as (D16, the H1 fixture), one pool per registry
// entry whose owner is `test-fixture`. OPT-IN by declaring such an entry; refused in production
// (`lib/config/test-issuers.ts`). Nothing depends on it: a fixture entry names its pool by id once this
// stack has deployed.
if (testFixtures?.fixtures.length) {
  new TestIssuerStack(app, stackId('TestIssuer'), {
    env,
    fixtures: testFixtures.fixtures,
    appUrl: String(app.node.tryGetContext('appUrl') || '').trim() || undefined,
    description: 'AgentEchelon e2e test issuers (one Cognito pool per test-fixture registry entry)',
  });
}

// Widget host: the sample page that embeds the widget (`examples/widget-host/`), on its own private bucket
// and CloudFront distribution. OPT-IN by the guest issuer listing `"widget-host"` in its `allowedOrigins`
// (`WIDGET_HOST_ORIGIN`), refused in production by the registry and here without the `widget` capability,
// since there would be nothing to embed. The widget's `frame-ancestors` names this stack's origin by
// reference, so the domain is never typed into a configuration.
let widgetHostStack: WidgetHostStack | undefined;
if (declaresWidgetHost(issuers.entries)) {
  if (!capabilities.has('widget')) {
    throw new Error('issuers: an allowedOrigins entry "widget-host" asks for the sample host page, which embeds the widget; '
      + 'declare "widget" in capabilities, or remove "widget-host"');
  }
  widgetHostStack = new WidgetHostStack(app, stackId('WidgetHost'), {
    env,
    enableManagedWaf,
    wafRateLimit,
    wafAllowedIps,
    description: 'AgentEchelon sample widget host page (CloudFront + private S3), an origin other than the widget\'s',
  });
}

// Cost sleep mode (docs/SPEC-COST-SLEEP-MODE.md): auto-pause Aurora Serverless
// v2 after configurable inactivity, with an admin wake + app maintenance flag.
// Opt-in and Aurora-mode only (that is where the idle cost lives). Warns + is
// inert in Athena mode (nothing meaningful to shed there).
const sleepMode: boolean =
  analyticsMode === 'aurora'
  && (app.node.tryGetContext('sleepMode') === true
    || app.node.tryGetContext('sleepMode') === 'true');
const sleepAfterIdle: string = app.node.tryGetContext('sleepAfterIdle') || '2h';
const sleepCheckRate: string = app.node.tryGetContext('sleepCheckRate') || 'rate(15 minutes)';
let sleepRecipients: Array<{ email: string; name?: string }> = [];
try {
  const raw = app.node.tryGetContext('sleepRecipients');
  if (raw) sleepRecipients = typeof raw === 'string' ? JSON.parse(raw) : raw;
} catch {
  console.warn('⚠️  sleepRecipients is not valid JSON — ignoring (expected [{email,name}]).');
}

if (app.node.tryGetContext('sleepMode') && analyticsMode !== 'aurora') {
  console.warn(
    '\n⚠️  sleepMode requires analyticsMode=aurora (the idle cost it pauses is Aurora\n'
      + '   Serverless v2). In Athena mode it is inert. Deploy with --context analyticsMode=aurora.\n',
  );
}

// Layer 6 membership audit (SPEC-CONVERSATION-SECURITY): an ALWAYS-ON near-real-time backstop that
// flags uncleared channel memberships for review - a standing security guarantee, deployed in
// both analytics modes. It is NOT opt-in; the only knob is enforcement mode: report-only (flag for
// review, the default) unless `-c membershipAuditEnforce=true` (auto-revoke the uncleared membership).
const membershipAuditEnforce: boolean =
  app.node.tryGetContext('membershipAuditEnforce') === true ||
  app.node.tryGetContext('membershipAuditEnforce') === 'true';
// Every platform alert, the membership audit's findings included, is an `ae.alert` event on the default
// EventBridge bus (`lambda/src/lib/admin-notice.ts`). No core stack names the admin channel: the
// `AdminServices` stack, present with the `admin` capability, owns the one rule that posts alerts into it.

// 3. Conversations: the shared conversation state, the attachments bucket and the feedback table, and
// the routes that create and change them. It takes the roles it grants on its own resources from
// Identity by reference, so the grants sit with the resources and Identity takes nothing back.
const conversationsStack = new ConversationsStack(app, stackId('Conversations'), {
  env,
  appInstanceArn: messagingStack.appInstanceArn,
  selfPoolId: identityStack.selfPoolId,
  offboardingRoleArn: identityStack.offboardingRoleArn,
  // The guest issuer's grants on this stack's resources (its token kinds, its address rows, its creator).
  credentialExchangeRoleArn: identityStack.credentialExchangeRoleArn,
  // Invitations (M-10): the exchange mints each invitee, a declared invitation-link issuer names where a
  // link session may be vended, and the invitation email comes from the deployment's one sender.
  credentialExchangeFunctionArn: identityStack.credentialExchangeFunction.functionArn,
  invitationLinkReach: identityStack.invitationLinkReach,
  // The invitation and claim emails are sent by Notifications, named to the functions that issue them with `notifications`.
  transactionalMail: capabilities.has('notifications'),
  description: 'Conversations: task, profile, context, turn and feedback tables, attachments, and their routes',
});

// 4. Archive: the conversation archive, Athena or Aurora (`analyticsMode`), under one stack name. It
// consumes the Messaging stack's stream and emits an `AnalyticsMode` output naming which it is.
let archiveStack: IArchiveStackOutputs & cdk.Stack;
let auroraStackForDrift: ArchiveStackAurora | undefined;

if (analyticsMode === 'aurora') {
  const auroraStack = new ArchiveStackAurora(app, stackId('Archive'), {
    env,
    appInstanceArn: messagingStack.appInstanceArn,
    messageStream: messagingStack.messageStream,
    userPoolId: identityStack.userPool?.userPoolId,
    userPoolArn: identityStack.userPool?.userPoolArn,
    // Eval runner scores image turns by fetching the generated image from the attachments bucket.
    attachmentsBucketArn: conversationsStack.attachmentsBucket.bucketArn,
    membershipAuditEnforce,
    senderEmail: app.node.tryGetContext('senderEmail') as string | undefined,
    // Cost sleep mode (opt-in): auto-pause Aurora after inactivity + admin wake.
    sleepMode,
    sleepAfterIdle,
    sleepCheckRate,
    sleepRecipients,
    vpcId: analyticsVpcId,
    vpcSubnetType: analyticsVpcSubnetType,
    createVpcEndpoints,
    enableRdsProxy,
    description: 'The conversation archive, Aurora mode: the message stream into Aurora PostgreSQL (VPC)',
  });
  archiveStack = auroraStack;
  auroraStackForDrift = auroraStack;
} else {
  archiveStack = new ArchiveStack(app, stackId('Archive'), {
    env,
    appInstanceArn: messagingStack.appInstanceArn,
    messageStream: messagingStack.messageStream,
    userPool: identityStack.userPool,
    // The evaluation runner copies a delivered document from the conversation's deliverables into the
    // archive before grading it (SPEC-EVALUATION FR22).
    attachmentsBucketArn: conversationsStack.attachmentsBucket.bucketArn,
    membershipAuditEnforce,
    senderEmail: app.node.tryGetContext('senderEmail') as string | undefined,
    description: 'The conversation archive, Athena mode: the message stream through Firehose into S3 and Athena',
  });
}

// The archive in Aurora mode, passed to EVERY assistant stack: each builds its own turn data plane and classifier
// replay in the archive's VPC, and with live drift grants its agent handler invoke access to its own turn data
// plane (`auroraDriftWiring`); the handler stays non-VPC (ADR-013).
const auroraDriftHookup = auroraStackForDrift
  ? { rdsProxy: enableRdsProxy, liveDrift: enableLiveDrift }
  : undefined;

// THE CORE'S DEPLOY ORDER: Messaging, Identity, Conversations, Archive. Every edge but the last is
// already a construct reference (the app instance, the stream, the pool, the roles); each is declared
// as well, so the order reads here.
identityStack.addDependency(messagingStack);
conversationsStack.addDependency(messagingStack);
conversationsStack.addDependency(identityStack); // the roles it grants on its resources
archiveStack.addDependency(messagingStack); // the stream it consumes
archiveStack.addDependency(identityStack); // the pool the membership audit reads
// DECLARED, NOT A REFERENCE, IN ATHENA MODE. The Aurora archive references the attachments bucket; the
// Athena archive reads nothing of Conversations. The edge is declared in both
// modes so the core deploys in one order whichever archive runs, and a failed first install names the
// same first stack in either mode.
archiveStack.addDependency(conversationsStack);

const settings: DeploymentSettings = {
  appUrl,
  senderEmail,
  senderEmailPreVerified,
  enableManagedWaf,
  wafRateLimit,
  wafAllowedIps,
  // THE EMAIL BRIDGE'S POOLS COME FROM THE TRUSTED-ISSUER REGISTRY: a recipient's contact is resolved in
  // directory of the issuer they signed in through (C5). The bridge exists with the notifications
  // capability, when some trusted issuer's directory holds contacts (a pool, or the claims copy).
  notifyBridge: issuers.entries.some((e) => directoryOf(e) !== 'none'),
  notifyAdditionalUserPoolIds: issuers.otherPoolIds(),
  // The group that marks an admin of this deployment's own pool: the registry's `deployment` entry's
  // `adminGroups` (ADMIN-INTEGRATION-GUIDE); default 'admins'.
  adminGroupName: issuers.deploymentAdminGroups()?.[0],
  widgetHostOrigin: widgetHostStack?.origin,
};
const core: CoreStacks = {
  messaging: messagingStack,
  identity: identityStack,
  conversations: conversationsStack,
  archive: archiveStack,
  aurora: auroraStackForDrift,
};
const capabilityStacks = new Map<string, cdk.Stack>();


// ── THE ASSISTANT STACKS, ONE PER DECLARED CLASSIFICATION ─────────────────────────────────────────
//
// Each classification the profile registry declares with a `topology` gets one
// `Assistants-<classification>` stack (ADR-057), so the set comes from `lib/config/profiles.ts` and is
// never listed here. Each owns its async processor (a self-hosted Converse tool loop, no Bedrock
// Agent), its context IAM, content guardrail, Lex bot (WelcomeIntent + FallbackIntent → the router)
// and AppInstanceBot, and publishes ${SSM_ROOT}/assistant/{classification}/{processor-arn, bot-arn, ...}.
//
// ── Image-generation guardrails in the regions the MODELS live in ──────────────
//
// Bedrock guardrails are REGIONAL and Bedrock does not offer every image model in every region:
// the Stability generators are us-west-2-only, so a us-east-1 deployment invokes them cross-region.
// A guardrail in the deploy region cannot be attached to that call - it fails as
// "The guardrail identifier or version provided in the request does not exist", which reads like a
// bad id rather than a wrong region. Derived from the registry (not hardcoded) so adding a
// region-pinned model provisions its guardrail automatically, exactly as the image-gen IAM ARNs are
// already derived.
const imageModelRegions = [...new Set(
  Object.values(IMAGE_GEN_MODELS)
    .filter((m) => m.lifecycle === 'active' && m.hosting === 'aws-bedrock' && m.region)
    .map((m) => m.region as string),
)].filter((r) => r !== env.region);

const imageGuardrailStacks = imageModelRegions.map((region) => new ImageGuardrailStack(
  app,
  stackId(`ImageGuardrail-${region}`),
  {
    env: { account: env.account, region },
    // The assistant stacks read this stack's outputs across regions; CDK needs this on BOTH
    // sides to generate the SSM-backed cross-region export.
    crossRegionReferences: true,
    guardrailName: `${RES_PREFIX}-image-guardrail-${region}`,
    description: `AgentEchelon image-generation content guardrail in ${region} (models pinned there)`,
  },
));

/** region -> {id, version}, for every region an active pinned image model lives in. */
const imageGuardrailByRegion: Record<string, { id: string; version: string }> = {};
imageModelRegions.forEach((region, i) => {
  imageGuardrailByRegion[region] = {
    id: imageGuardrailStacks[i].guardrailId,
    version: imageGuardrailStacks[i].guardrailVersion,
  };
});

const assistantsSharedProps = {
  env,
  crossRegionReferences: true,
  imageGuardrailByRegion,
  appInstanceArn: messagingStack.appInstanceArn,
  attachmentsBucketName: conversationsStack.attachmentsBucket.bucketName,
  attachmentsBucketArn: conversationsStack.attachmentsBucket.bucketArn,
  // The battle and experiments tables are NAMED to the functions that use them when those capabilities are
  // declared (`CAPABILITY_RESOURCES`); their stacks deploy after this one and attach the grants.
  battle: capabilities.has('battle'),
  experiments: capabilities.has('experiments'),
  // An observability role reads the alarms of the declared capabilities' stacks beside the core's.
  capabilities: capabilities.names,
  // Live drift (Aurora mode, all-classification). Undefined in Athena mode ⇒ no drift wiring.
  auroraDriftHookup,
  // Out-of-band per-message analytics (SPEC-MESSAGE-METADATA-CODEBOOK.md Phase 1).
  // Aurora mode only — the table lives in the Aurora stack (its archival Lambda is
  // the sole consumer); each classification's async processor writes the full analytics blob
  // there keyed by message id and slims the Chime Metadata. Undefined in Athena
  // mode ⇒ the processor keeps the full inline metadata (no consumer for these
  // fields there) plus the Phase-0 shedding backstop.
  messageAnalytics: auroraStackForDrift
    ? {
        tableName: auroraStackForDrift.messageAnalyticsTableName,
        tableArn: auroraStackForDrift.messageAnalyticsTableArn,
      }
    : undefined,
  // Each classification's vend role trusts the credential exchange's own role, and nothing else.
  credentialExchangeRoleArn: identityStack.credentialExchangeRoleArn,
};

const assistantStacks = assistantClassificationValues.map((classification) => {
  const stack = new AssistantsStack(app, stackId(assistantsStackName(classification)), {
    ...assistantsSharedProps,
    classification,
    description: `AgentEchelon ${classification}-classification assistants — async-processor + Lex bot + classification context IAM + guardrail`,
  });
  // Deploy ordering: the assistant stacks resolve the shared ${SSM_ROOT}/shared/* parameters at deploy
  // (the task tables from Conversations), so their publisher deploys first. The experiments and battle
  // stacks deploy AFTER this one: they attach to it.
  stack.addDependency(conversationsStack);
  // Its seed asks the provisioner, in Messaging, for its declared assistants at deploy (by the provisioner's fixed
  // name, so no value crosses): the provisioner exists before any classification deploys.
  stack.addDependency(messagingStack);
  return stack;
});

// 9. Channel Flow Stack — @all + /battle routing and message filtering
const channelFlowStack = new ChannelFlowStack(app, stackId('ChannelFlow'), {
  env,
  appInstanceArn: messagingStack.appInstanceArn,
  // @all + /battle fan-out target the classifications' routers, which ChannelFlow finds by name at call
  // time. The battle tables, and the experiments table a duel's fan-out reads for its per-variant
  // image models, are named to it when declared; their stacks attach the grants to its role.
  battle: capabilities.has('battle'),
  experiments: capabilities.has('experiments'),
  // NO SENDER-CLEARANCE POOL (`userPoolId` absent). The /battle abuse gate meters at the channel's
  // classification (`channel-flow-processor.ts`), so the flow reads no sender's groups. The notification
  // fan-out runs on the message stream (ADR-041 decision 7), on the post-processing stack.
  // The flow resolves the active profile version for the copy of the notices it sends itself, and a
  // version's persona body lives under `profiles/*` in this bucket.
  attachmentsBucketName: conversationsStack.attachmentsBucket.bucketName,
  attachmentsBucketArn: conversationsStack.attachmentsBucket.bucketArn,
  description: 'Channel Flow Processor for @all and /battle routing',
});
channelFlowStack.addDependency(messagingStack);
channelFlowStack.addDependency(conversationsStack); // the shared tables it resolves at deploy (resolveSharedSSM)
// NOT AFTER THE ASSISTANT STACKS: @all, /battle and the task-service dispatch find each classification's
// router and task service by name at call time, so no deploy-time value comes from them and a classification
// is deployed or removed on its own.

// 9b. Post-processing — what the platform does with a message AFTER delivery (ADR-032 tenet 4): one
// consumer on the message stream, acting on messages delivery did not route. Deliberately NOT in the
// channel flow, which is synchronous and runs on every message: a correction for a state that should
// not exist must cost time only in the broken case. It goes AFTER the stack whose SSM contract it
// resolves at deploy (the tasks table from Conversations) and finds the routers by name at call time, so it
// deploys before, or without, any one classification's stack. Email is not here: the email bridge is the Notifications stack's own consumer on the same stream.
const postProcessingStack = new PostProcessingStack(app, stackId('PostProcessing'), {
  env,
  appInstanceArn: messagingStack.appInstanceArn,
  messageStream: messagingStack.messageStream,
  attachmentsBucketName: conversationsStack.attachmentsBucket.bucketName,
  attachmentsBucketArn: conversationsStack.attachmentsBucket.bucketArn,
  description: 'Post-processing on the message stream: the rules that act on messages delivery did not route',
});
postProcessingStack.addDependency(messagingStack); // the stream it consumes
postProcessingStack.addDependency(conversationsStack); // the tasks + abuse-controls tables (SSM, at deploy)
// Not after the assistant stacks: the routers it dispatches to are found by name at call time.

// ── CAPABILITIES ON THE CORE (`surface` stage) ──────────────────────────────────────────────────
//
// The chat app, the admin backend and console, and email, each wired to the core and the assistant
// stacks it reads, and the admin backend to the capabilities it administers. Nothing in the core depends
// on them.
buildCapabilities('surface', {
  app, env, prefix: STACK_PREFIX, declared: capabilities, classifications: assistantClassificationValues,
  settings, core, assistants: assistantStacks, channelFlow: channelFlowStack,
}, capabilityStacks);

// ── THE PERSON API (D11) ─────────────────────────────────────────────────────────────────────────────
//
// Every route a person calls, on one HTTP API behind the edge authorizer. Built last, on every stack that
// declares person routes: the core's and each declared capability's. A capability that is not declared
// has no stack, and so no route here.
const personRouteSources = [identityStack, conversationsStack, archiveStack, ...capabilityStacks.values()]
  .filter((s) => isRouteSource(s) && s.routes.some((r) => r.api === 'person'));
const personApiStack = new PersonApiStack(app, stackId('PersonApi'), {
  env,
  routes: routesFor('person', personRouteSources),
  appInstanceArn: messagingStack.appInstanceArn,
  selfPoolId: identityStack.selfPoolId,
  selfClientIds: identityStack.selfClientIds,
  identities: identityStack.identitiesTable,
  guestSigningKeys: identityStack.guestSigningKeys,
  tokens: conversationsStack.tokensTable,
  // Each conversation type's transports and capabilities against the declared list (T4): a gap degrades and is recorded.
  conversationTypeGaps: typeCapabilityGaps(capabilities.names).map(describeGap),
  description: 'The person API: every route a person calls, behind the edge authorizer',
});
for (const source of personRouteSources) personApiStack.addDependency(source);

// Standard cost-attribution tags, applied ONCE at the app root. Project is DERIVED from the
// deployment identity (STACK_PREFIX ← AE_INSTANCE_NAME) so the same platform code deployed as
// different instances self-tags per app (a new instance → its own prefix, no code change).
// Never hardcode a shared Project literal or override it per-stack — see lib/tagging.ts and the
// tagging.test.ts invariants (docs/TAGGING.md).
applyStandardTags(app, {
  project: STACK_PREFIX,
  codebase: 'AgentEchelon',
  instance: INSTANCE_NAME,
  environment,
});

// Every alarm the app declares is published by name in the stack that owns it, so the ops assistant reads
// alarm state by name under a grant scoped to this deployment's alarms (`lib/constructs/alarm-names.ts`).
publishAlarmNames(app, SSM_ROOT);

// Every role's inline policies stay under IAM's per-role limit, measured on this synth's own template
// (context, cross-stack tokens and the owner-team aspect included), so a deploy that would cross it fails
// here rather than mid-update in CloudFormation.
enforceInlinePolicyBudget(app);

app.synth();
