#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ChimeMessagingStack } from '../lib/stacks/chime-messaging-stack';
import { FoundationsStack } from '../lib/stacks/foundations-stack';
import { S3StorageStack } from '../lib/stacks/s3-storage-stack';
import { CognitoAuthStack } from '../lib/stacks/cognito-auth-stack';
import { AdminNotificationStack } from '../lib/stacks/admin-notification-stack';
import { AnalyticsStack } from '../lib/stacks/analytics-stack';
import { AnalyticsStackAurora } from '../lib/stacks/analytics-stack-aurora';
import { IAnalyticsStackOutputs } from '../lib/interfaces/analytics-stack-interface';
import { NotificationStack } from '../lib/stacks/notification-stack';
import { BasicClassificationStack } from '../lib/stacks/basic-classification-stack';
import { StandardClassificationStack } from '../lib/stacks/standard-classification-stack';
import { PremiumClassificationStack } from '../lib/stacks/premium-classification-stack';
import { ChannelFlowStack } from '../lib/stacks/channel-flow-stack';
import { BattleStack } from '../lib/stacks/battle-stack';
import { ExperimentsStack } from '../lib/stacks/experiments-stack';
import { FrontendStack } from '../lib/stacks/frontend-stack';
import {
  STACK_PREFIX,
  APP_INSTANCE_NAME,
  INSTANCE_NAME,
} from '../lib/stacks/agent-classification-common';
import { getModelCatalog, parseProfileModelSelection } from '../lib/config/model-strategy';
import { DEFAULT_PROFILES_CONFIG, validateProfilesConfig } from '../lib/config/profiles';
import { applyStandardTags } from '../lib/tagging';

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

// SPEC-CAPABILITY-PROFILES Phase 0: fail the synth loudly on a malformed classifications/profiles
// config (unique ranks, failClosedTo is the floor, profile refs resolve, no alias collisions).
// Validates the shipped default today; the per-deployment config source replaces it in a later phase.
validateProfilesConfig(DEFAULT_PROFILES_CONFIG);

// Environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Analytics mode: 'athena' (default) or 'aurora' (opt-in VPC + PostgreSQL)
const analyticsMode: 'athena' | 'aurora' =
  app.node.tryGetContext('analyticsMode') || 'athena';

// /battle feature. The battle infrastructure (alt-slots, orchestrator,
// channel-battle API) lives in its own AgentEchelonBattle stack. Defaults to ON;
// deploy with `-c enableBattle=false` to leave /battle out entirely (the tier
// processors + channel-flow then carry no battle plumbing and fail open).
// Battle eligibility is per-profile config now (AssistantProfile.battleEligible), not a context knob.
const enableBattle: boolean =
  (app.node.tryGetContext('enableBattle') ?? true) !== false
    && app.node.tryGetContext('enableBattle') !== 'false';

// Live drift detection (SPEC-DRIFT-CONVERGENCE.md + ADR-013): conversation-level
// + ALL-tier (basic/standard/premium). **OPT-IN, default OFF** — matches
// docs/AURORA-MODE-GUIDE.md ("Default false ships the analytics-only post-hoc
// path"). It REQUIRES analyticsMode=aurora; in Athena mode there is no Aurora to
// query, so drift is inert regardless.
//
// WHY default OFF: the current live path runs a synchronous pgvector query inside
// the reply handler, which forces a VPC attachment (`auroraDriftWiring`) onto
// PRIVATE_ISOLATED subnets — and that severs the handler's egress to Chime (no
// Chime PrivateLink, no NAT), so every agent reply times out. ADR-013 fixes this
// (retrieval via RDS Data API / async, decision via a reasoning gate, handler
// stays out of the VPC); until that lands, opting in with `-c enableLiveDrift=true`
// re-enables the broken VPC path — do not enable it in Aurora mode until ADR-013
// ships.
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
// Single source for the deploy environment. Historically this had TWO defaults (the
// Aurora prop defaulted 'dev' while the standard tag defaulted 'Production'); collapsed here.
const environment = (app.node.tryGetContext('environment') || 'dev') as 'dev' | 'prod';
// Set true when senderEmail is already a verified SES identity (or domain-verified
// / externally managed) — skips creating the per-address EmailIdentity, which CFN
// cannot do for an identity that already exists.
const senderEmailPreVerified =
  app.node.tryGetContext('senderEmailPreVerified') === 'true'
  || app.node.tryGetContext('senderEmailPreVerified') === true
  || process.env.SENDER_EMAIL_PRE_VERIFIED === 'true';

// Frontend WAF (AgentEchelonFrontend / CloudFront).
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
// Standalone admin console hosting (SPEC-SEPARATE-ADMIN-APP.md). OPT-IN: a
// deployment may run headless or host its own console, so the AgentEchelonAdminFrontend
// stack (its own S3 + CloudFront origin, serving admin.html) is only created with
// `--context enableAdminApp=true`. The chat SPA never carries admin code either way.
const enableAdminApp = app.node.tryGetContext('enableAdminApp') === true
  || app.node.tryGetContext('enableAdminApp') === 'true';
const modelCatalog = getModelCatalog(env.region, env.account ?? '');
const profileModelSelection = parseProfileModelSelection({
  basic: app.node.tryGetContext('basicModelKey') || process.env.BASIC_MODEL_KEY,
  standard: app.node.tryGetContext('standardModelKey') || process.env.STANDARD_MODEL_KEY,
  premium: app.node.tryGetContext('premiumModelKey') || process.env.PREMIUM_MODEL_KEY,
}, modelCatalog);

// Fail fast if deploying NotificationStack with the placeholder email.
// SES rejects unverified identities, so the share-conversation Lambda would
// swallow every SendEmail call at runtime. Require an explicit value.
if (senderEmail === PLACEHOLDER_SENDER) {
  console.warn(
    '\n⚠️  SES_SENDER_EMAIL is unset — using placeholder "noreply@example.com".\n' +
    '   Share-conversation email delivery WILL fail at runtime.\n' +
    '   Set via: cdk deploy --context senderEmail=you@example.com (or SES_SENDER_EMAIL env var)\n'
  );
}

// 1. Chime SDK Messaging Stack - Foundation
const chimeStack = new ChimeMessagingStack(app, `${STACK_PREFIX}ChimeMessaging`, {
  env,
  appInstanceName: APP_INSTANCE_NAME,
  description: 'Chime SDK Messaging for AgentEchelon',
});

// 2. Cognito Auth Stack - Authentication & Authorization
const cognitoStack = new CognitoAuthStack(app, `${STACK_PREFIX}CognitoAuth`, {
  env,
  appInstanceArn: chimeStack.appInstanceArn,
  description: 'Cognito authentication with SAML/OIDC support',
});

// Admin notification channel (A6): auto-provision a dedicated admin channel that the membership-audit
// (Layer 6) and admin-error alert paths post to (in-app message + email fan-out). OPT-IN; when off,
// those alerts stay log-only unless an operator hand-passes `-c membershipAuditAlertChannelArn`. When
// on, a custom resource creates the channel as the app-instance-admin, adds the `admins` group as
// members, and stamps them into the participant roster (the email fan-out reads the roster).
const enableAdminNotificationChannel: boolean =
  app.node.tryGetContext('enableAdminNotificationChannel') === true ||
  app.node.tryGetContext('enableAdminNotificationChannel') === 'true';
let adminNotificationChannelArn: string | undefined;
if (enableAdminNotificationChannel) {
  const adminNotificationStack = new AdminNotificationStack(app, `${STACK_PREFIX}AdminNotification`, {
    env,
    appInstanceArn: chimeStack.appInstanceArn,
    appInstanceAdminArn: chimeStack.appInstanceAdminArn,
    userPoolId: cognitoStack.userPool.userPoolId,
    userPoolArn: cognitoStack.userPool.userPoolArn,
    // Honor a host-owned admin group name (ADMIN-INTEGRATION-GUIDE `adminGroupNames`); default 'admins'.
    adminGroupName:
      ((app.node.tryGetContext('adminGroupNames') as string | undefined) || '').split(',')[0].trim() || undefined,
    description: 'AgentEchelon admin notification channel (membership-audit + admin-error alerts)',
  });
  adminNotificationStack.addDependency(chimeStack);
  adminNotificationStack.addDependency(cognitoStack);
  adminNotificationChannelArn = adminNotificationStack.channelArn;
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

// Layer 6 membership audit (SPEC-CONVERSATION-SECURITY): opt-in near-real-time backstop
// that flags (and, when enforcing, revokes) over-tier channel memberships. Runs in both
// analytics modes; report-only unless `-c membershipAuditEnforce=true`.
const enableMembershipAudit: boolean =
  app.node.tryGetContext('enableMembershipAudit') === true ||
  app.node.tryGetContext('enableMembershipAudit') === 'true';
const membershipAuditEnforce: boolean =
  app.node.tryGetContext('membershipAuditEnforce') === true ||
  app.node.tryGetContext('membershipAuditEnforce') === 'true';
// Prefer an explicitly-passed channel ARN; otherwise use the auto-provisioned admin notification
// channel (A6, above). Both alert paths (membership-audit + admin-error) share this one ARN, so this
// single value flows to the analytics stack (membership-audit) and the tier stacks (adminErrorAlertWiring).
const membershipAuditAlertChannelArn =
  (app.node.tryGetContext('membershipAuditAlertChannelArn') as string | undefined)
  || adminNotificationChannelArn;

// 3. Analytics Stack - conditionally Athena or Aurora mode
let analyticsStack: IAnalyticsStackOutputs & cdk.Stack;
let auroraStackForDrift: AnalyticsStackAurora | undefined;

if (analyticsMode === 'aurora') {
  const auroraStack = new AnalyticsStackAurora(app, `${STACK_PREFIX}AnalyticsAurora`, {
    env,
    appInstanceArn: chimeStack.appInstanceArn,
    userPoolId: cognitoStack.userPool.userPoolId,
    // A14: the admins sign-on role that gets execute-api teeth on the analytics
    // read plane when adminIamEnforcement is on, plus the opt-in persona roles.
    adminSignOnRoleArn: cognitoStack.adminSignOnRoleArn,
    adminPersonaRoleArns: cognitoStack.adminPersonaRoleArns,
    // Thumbs per-variant join: the analytics Lambda scans the feedback table at
    // read time over the VPC DynamoDB endpoint.
    feedbackTableName: cognitoStack.feedbackTable.tableName,
    feedbackTableArn: cognitoStack.feedbackTable.tableArn,
    // Battle-wins join: fold /battle picks in too when /battle is on.
    // The BattleOutcome table name is resolved at deploy via the battle SSM
    // contract; bin adds the battle-stack dependency below so it exists first.
    userPoolArn: cognitoStack.userPool.userPoolArn,
    enableBattleJoin: enableBattle,
    enableMembershipAudit,
    membershipAuditEnforce,
    membershipAuditAlertChannelArn,
    senderEmail: app.node.tryGetContext('senderEmail') as string | undefined,
    // Cost sleep mode (opt-in): auto-pause Aurora after inactivity + admin wake.
    sleepMode,
    sleepAfterIdle,
    sleepCheckRate,
    sleepRecipients,
    environment,
    vpcId: analyticsVpcId,
    vpcSubnetType: analyticsVpcSubnetType,
    createVpcEndpoints,
    enableRdsProxy,
    description: 'Analytics pipeline: Kinesis → Aurora PostgreSQL (VPC)',
  });
  analyticsStack = auroraStack;
  auroraStackForDrift = auroraStack;
} else {
  const athenaStack = new AnalyticsStack(app, `${STACK_PREFIX}Analytics`, {
    env,
    appInstanceArn: chimeStack.appInstanceArn,
    userPool: cognitoStack.userPool,
    adminSignOnRoleArn: cognitoStack.adminSignOnRoleArn,
    enableMembershipAudit,
    membershipAuditEnforce,
    membershipAuditAlertChannelArn,
    senderEmail: app.node.tryGetContext('senderEmail') as string | undefined,
    description: 'Analytics pipeline: Kinesis → S3 → Athena',
  });
  analyticsStack = athenaStack as unknown as IAnalyticsStackOutputs & cdk.Stack;
}

// The Aurora-drift hookup passed to EVERY per-tier stack when drift is on (Aurora
// mode). Each tier grants its agent handler invoke access to the retrieval +
// drift data-plane Lambda via `auroraDriftWiring`; the handler stays non-VPC
// (project decision 018).
const auroraDriftHookup = enableLiveDrift && auroraStackForDrift
  ? {
      dataPlaneArn: auroraStackForDrift.dataPlaneLambdaArn,
    }
  : undefined;

// 4. S3 Storage Stack - File Attachments
const s3Stack = new S3StorageStack(app, `${STACK_PREFIX}S3Storage`, {
  env,
  appInstanceArn: chimeStack.appInstanceArn,
  userPool: cognitoStack.userPool,
  description: 'S3 storage for file attachments with Cognito-authorized API',
});

// 5. Foundations Stack — the shared task data plane + create-conversation/add-agent.
// It hosts no bot; the assistants live in the per-tier AgentEchelonClassification-* stacks,
// /battle in AgentEchelonBattle, and experiments in AgentEchelonExperiments.
//
// NOTE: live-drift (Aurora pgvector) runs in the per-tier user-message path for
// ALL tiers (conversation-level, on-by-default — NOT premium-only). See
// docs/SPEC-DRIFT-CONVERGENCE.md.
const foundationsStack = new FoundationsStack(app, `${STACK_PREFIX}Foundations`, {
  env,
  appInstanceArn: chimeStack.appInstanceArn,
  userPoolId: cognitoStack.userPool.userPoolId,
  description: 'Shared foundation: task tables + create-conversation/add-agent',
});

// 5b. Experiments Stack — A/B experiments table + admin-experiments API.
// Always deployed (cheap: one on-demand table + one Lambda). Publishes the
// experiments SSM contract the per-tier processors/handlers + AgentEchelonBattle
// resolve.
const experimentsStack = new ExperimentsStack(app, `${STACK_PREFIX}Experiments`, {
  env,
  appInstanceArn: chimeStack.appInstanceArn,
  userPoolId: cognitoStack.userPool.userPoolId,
  appUrl,
  adminSignOnRoleArn: cognitoStack.adminSignOnRoleArn,
  adminPersonaRoleArns: cognitoStack.adminPersonaRoleArns,
  description: 'A/B experiments table + admin-experiments API (VITE_EXPERIMENTS_API_URL)',
});
experimentsStack.addDependency(chimeStack);
experimentsStack.addDependency(cognitoStack);

// 6. Notification Stack - SES email identity + conversation sharing
const notificationStack = new NotificationStack(app, `${STACK_PREFIX}Notifications`, {
  env,
  appInstanceArn: chimeStack.appInstanceArn,
  userPoolId: cognitoStack.userPool.userPoolId,
  senderEmail,
  senderEmailPreVerified,
  appUrl,
  description: 'Email notifications for conversation sharing',
});

// 7. (removed) The per-tier IAMPolicies stack was inert scaffolding — its policies gated on
// aws:PrincipalTag/tier (never populated) with a non-IAM `chime-sdk-messaging:` action prefix, and
// were attached to no principal. The LIVE Layer-1 boundary is aws:ResourceTag/classification on the
// per-tier processor + credential-exchange roles (agent-classification-common.classificationChannelScopedAllow); the
// model allowlist is the processor role's own Bedrock grant. Deleted per SPEC-CAPABILITY-PROFILES §D-2.

// 8b. Per-tier stacks (docs/SPEC-PER-TIER-OWNERSHIP.md, ADR-011) — each tier is
// an independently-deployable stack a separate team can own end-to-end: the
// async-processor (the assistant — a self-hosted Converse tool loop, no Bedrock
// Agent) + its tier-scoped context S3 IAM + content guardrail + Lex bot
// (WelcomeIntent + FallbackIntent → shared router) + AppInstanceBot. SSM
// publishes /agent-echelon/tier/{tier}/{processor-arn, bot-arn}; the shared
// router dispatches to the processor and create-conversation adds the right tier
// bot to a new channel.
//
// standard/premium resolve the shared task/battle/experiment tables + battle
// orchestrator from the /agent-echelon/shared/* SSM contract (each tier stack
// self-resolves at deploy via valueForStringParameter — an SSM dynamic ref, NOT
// Fn::importValue), so each tier deploys decoupled.
//
// Classification-as-class, not classification-as-parameter — each classification is its own file
// (basic-classification-stack.ts / standard-classification-stack.ts / premium-classification-stack.ts),
// so a classification-team change reviews + ships only that classification. Shared constants live in
// lib/stacks/agent-classification-common.ts.
const classificationSharedProps = {
  env,
  appInstanceArn: chimeStack.appInstanceArn,
  attachmentsBucketName: s3Stack.attachmentsBucket.bucketName,
  attachmentsBucketArn: s3Stack.attachmentsBucket.bucketArn,
  profileModelSelection,
  // Admin error-alert channel (CH parity): the async processor posts a failure here and the
  // channel flow emails the admin roster. Reuses the same admin conversation as the membership
  // audit. Undefined/empty ⇒ processor error alerting is log-only.
  adminErrorAlertChannelArn: membershipAuditAlertChannelArn,
  // standard/premium resolve the battle SSM contract AgentEchelonBattle publishes
  // ONLY when /battle is deployed; basic ignores this. False ⇒ no battle plumbing.
  enableBattle,
  // Live drift (Aurora mode, on-by-default, all-classification). Undefined in Athena mode ⇒
  // the classification wires no drift. Each classification VPC-attaches its handler to Aurora.
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
};

const classificationBasicStack = new BasicClassificationStack(app, `${STACK_PREFIX}Classification-Basic`, {
  ...classificationSharedProps,
  description: 'AgentEchelon basic-classification assistant — async-processor + Lex bot + classification context IAM + guardrail',
});
const classificationStandardStack = new StandardClassificationStack(app, `${STACK_PREFIX}Classification-Standard`, {
  ...classificationSharedProps,
  description: 'AgentEchelon standard-classification assistant — async-processor + Lex bot + classification context IAM + guardrail',
});
const classificationPremiumStack = new PremiumClassificationStack(app, `${STACK_PREFIX}Classification-Premium`, {
  ...classificationSharedProps,
  description: 'AgentEchelon premium-classification assistant — async-processor (+/battle) + Lex bot + classification context IAM + guardrails',
});

// Deploy-ordering only: standard/premium consume the shared /agent-echelon/
// shared/* SSM params — TASK tables from AgentEchelonFoundations, experiments from
// AgentEchelonExperiments — so both must deploy first. No Fn::importValue on the
// shared params; these explicit dependencies just guarantee they exist at deploy.
for (const classificationStack of [classificationBasicStack, classificationStandardStack, classificationPremiumStack]) {
  classificationStack.addDependency(foundationsStack);
  classificationStack.addDependency(experimentsStack);
}

// 8c. Battle Stack (opt-in) — /battle alt-slots, orchestrator, tables, APIs.
// Deploys AFTER AgentEchelonExperiments (channel-battle reads the experiments SSM it
// publishes) and BEFORE the per-tier stacks (which consume the battle SSM this publishes).
const battleStack = enableBattle
  ? new BattleStack(app, `${STACK_PREFIX}Battle`, {
      env,
      appInstanceArn: chimeStack.appInstanceArn,
      userPoolId: cognitoStack.userPool.userPoolId,
      appUrl,
      description: 'AgentEchelon /battle — alt-slots + orchestrator + tables + channel-battle API (opt-in)',
    })
  : undefined;
if (battleStack) {
  battleStack.addDependency(chimeStack);
  battleStack.addDependency(cognitoStack); // channel-battle API authorizer
  battleStack.addDependency(experimentsStack); // channel-battle resolves experiments SSM at deploy
  // Per-tier stacks consume the battle SSM this stack publishes.
  classificationStandardStack.addDependency(battleStack);
  classificationPremiumStack.addDependency(battleStack);
  // Aurora analytics resolves the BattleOutcome table NAME from the battle SSM
  // contract at DEPLOY time for the battle-wins join — so battle must deploy
  // first. (No cycle: battle depends only on chime/cognito/experiments, none of
  // which depend on Aurora.)
  if (auroraStackForDrift) {
    auroraStackForDrift.addDependency(battleStack);
  }
}

// 9. Channel Flow Stack — @all + /battle routing and message filtering
const channelFlowStack = new ChannelFlowStack(app, `${STACK_PREFIX}ChannelFlow`, {
  env,
  appInstanceArn: chimeStack.appInstanceArn,
  // @all + /battle fan-out target the per-tier processors, which ChannelFlow
  // self-resolves from /agent-echelon/tier/{standard,premium}/processor-arn
  // (SSM). The battle tables come from the opt-in AgentEchelonBattle stack; when
  // /battle is off these are undefined and channel-flow runs without battle.
  battleStateTableName: battleStack?.battleStateTableName,
  battleStateTableArn: battleStack?.battleStateTableArn,
  channelBattleConfigTableName: battleStack?.channelBattleConfigTableName,
  channelBattleConfigTableArn: battleStack?.channelBattleConfigTableArn,
  // Notification bridge (SPEC-NOTIFICATION-BRIDGE P1, outbound): the processor resolves
  // participant emails from the IDP by sub and fans a notify-tagged message out over SES.
  // Federated users live in the HOST pool (federatedUserPoolId), not the AE platform pool —
  // a notify-tagged bot message carries host-pool subs, so AdminGetUser must target that pool.
  // Absent (non-federated deployment) ⇒ bridge stays inert (no env, no IAM).
  userPoolId: app.node.tryGetContext('federatedUserPoolId') as string | undefined,
  // Multi-IDP: extra trusted pools whose issuers a notify target may resolve to. Comma-separated
  // context value; empty for a single-IDP deployment.
  additionalUserPoolIds: ((app.node.tryGetContext('notifyAdditionalUserPoolIds') as string | undefined) || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  senderEmail,
  description: 'Channel Flow Processor for @all and /battle routing',
});

// Frontend hosting — the DEFAULT production path for the SPA (CloudFront + S3).
// Independent of every other stack: it provisions an empty bucket + CloudFront
// distribution only. The Vite build is synced out-of-band after the rest of
// the app deploys (it bakes in this app's CDK outputs) via
// `backend/scripts/deploy-frontend.mjs`. See docs/FRONTEND-DEPLOY.md.
const frontendStack = new FrontendStack(app, `${STACK_PREFIX}Frontend`, {
  env,
  enableManagedWaf,
  wafRateLimit,
  wafAllowedIps,
  description: 'CloudFront + S3 hosting for the AgentEchelon SPA',
});
void frontendStack;

// Admin console hosting — the separate operator-interface origin (layer 4 of the
// four-layer deploy ordering; SPEC-SEPARATE-ADMIN-APP.md). Opt-in and independent:
// its own S3 + CloudFront serving admin.html (dist-admin/), 'Admin*'-prefixed
// outputs so they don't collide with the chat stack's. The admin UI is synced
// separately (deploy-frontend.mjs, admin target); after it deploys, redeploy the
// backend with `--context adminAppUrl=<AdminDistributionUrl>` so the admin APIs'
// CORS trusts the admin origin.
const adminFrontendStack = enableAdminApp
  ? new FrontendStack(app, `${STACK_PREFIX}AdminFrontend`, {
      env,
      enableManagedWaf,
      wafRateLimit,
      wafAllowedIps,
      // The admin app is its own workspace package (@ae/admin) and builds a
      // standard index.html, so the default root document applies.
      outputPrefix: 'Admin',
      description: 'CloudFront + S3 hosting for the standalone AgentEchelon admin console',
    })
  : undefined;
void adminFrontendStack;

// Add stack dependencies
analyticsStack.addDependency(chimeStack);
cognitoStack.addDependency(chimeStack);
s3Stack.addDependency(chimeStack);
foundationsStack.addDependency(chimeStack);
foundationsStack.addDependency(analyticsStack);
foundationsStack.addDependency(cognitoStack); // create-conversation reads user groups for tier gate
channelFlowStack.addDependency(chimeStack);
channelFlowStack.addDependency(foundationsStack); // create-conversation channel-flow ARN + bot ARN in SSM
// @all + /battle fan-out resolve the standard/premium tier processor ARNs from
// SSM at deploy, so those tier stacks must publish first.
channelFlowStack.addDependency(classificationStandardStack);
channelFlowStack.addDependency(classificationPremiumStack);
// The battle tables ChannelFlow reads come from AgentEchelonBattle (cross-stack token
// reference already implies this edge; explicit for clarity).
if (battleStack) {
  channelFlowStack.addDependency(battleStack);
}
notificationStack.addDependency(chimeStack);
notificationStack.addDependency(cognitoStack);

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

app.synth();
