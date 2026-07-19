/**
 * Shared constants + thin helpers for the per-classification stacks
 * (BasicTierStack / StandardTierStack / PremiumTierStack).
 *
 * **Intentionally thin.** The per-classification ownership model (ADR-011) targets
 * independently-owned *code* per classification — a basic-team change must not
 * review-couple the standard or premium tiers. So this file holds only what
 * the tiers MUST agree on (the SSM contract keys, the shared bot key, and a
 * couple of pure helpers) and deliberately stops short of building any classification
 * stack's resources. Each classification's file owns its own IAM, Lambda, Lex bot, and
 * AppInstanceBot wiring even when those happen to look similar — that is
 * what "per-classification ownership" means.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import type { BackendModelDefinition, BackendModelKey } from '../config/model-strategy';
import { defaultProfileRegistry as profiles } from '../profile-registry';

export type Classification = 'basic' | 'standard' | 'premium';
export type ClassificationModelCatalog = Record<BackendModelKey, BackendModelDefinition>;

/** Classification ordering, lowest → highest. */

/**
 * Chime actions whose IAM resource is purely a CHANNEL (so it carries the
 * `classification` tag) and that must be classification-gated.
 *
 * EXCLUDES:
 * - app/user-scoped actions (CreateChannel, ListChannels, Connect,
 *   GetMessagingSessionEndpoint, ListChannelMembershipsForAppInstanceUser) — no
 *   channel tag; granted unconditionally.
 * - PER-MEMBER membership actions (CreateChannelMembership / DeleteChannelMembership
 *   / DescribeChannelMembership) — these authorize against the **AppInstanceUser**
 *   resource (`.../user/<id>`), which has NO classification tag, so a tag condition
 *   fails-closed and BREAKS them. They are governed instead by Chime's moderator
 *   model + the app-layer share/create gates. (ListChannelMemberships IS
 *   channel-scoped, so it stays here.)
 */
export const CLASSIFICATION_GATED_CHANNEL_ACTIONS = [
  'chime:SendChannelMessage',
  'chime:UpdateChannelMessage',
  'chime:RedactChannelMessage',
  'chime:GetChannelMessage',
  'chime:ListChannelMessages',
  'chime:DescribeChannel',
  'chime:UpdateChannel',
  'chime:DeleteChannel',
  'chime:UpdateChannelReadMarker',
  'chime:ListChannelMemberships',
];

/** The classification tag values a classification may act on: itself and every one below (by rank).
 *  Config-driven via the profile registry (SPEC-CAPABILITY-PROFILES) — the same at-or-below set the
 *  runtime uses for RAG scope, so the IAM boundary and retrieval scope can never drift. */
export function classificationsAllowedFor(classification: Classification): string[] {
  return profiles.scopeAtOrBelow(classification);
}

/**
 * SPEC-CONVERSATION-SECURITY Layer 1 — the channel-join boundary, **fail-closed**.
 *
 * Returns an IAM **Allow** that grants the channel-scoped Chime actions ONLY on
 * channels tagged `classification ∈ {this classification and every classification below}` (the
 * immutable tag create-conversation stamps). This is the FAIL-CLOSED inverse of a
 * deny-on-higher: an **untagged** channel, or one with an unexpected tag value,
 * carries no matching `aws:ResourceTag/classification`, so the condition is false,
 * no Allow applies, and the action is implicitly DENIED. (A deny-on-higher would
 * instead fail OPEN on untagged channels — a hole for any channel created before
 * tagging shipped.) Pure-IAM: evaluated before any app logic, so even a routing
 * bug can't make a basic identity act on a premium channel.
 *
 * Condition key is the GLOBAL `aws:ResourceTag/<key>`, NOT `chime:ResourceTag`:
 * Amazon Chime exposes **no service-specific condition keys** (AWS Service
 * Authorization Reference), so `chime:ResourceTag/...` never exists in the request
 * context — verified the hard way by a live deny-test (the `chime:` form let a
 * basic member send into a premium channel; the `aws:` form returns AccessDenied).
 *
 * Used for BOTH the per-classification assistant (async-processor) roles and the per-classification
 * Cognito user roles — the same boundary, one definition. Because it's fail-closed,
 * every legitimate channel MUST be tagged; new channels are tagged at creation and
 * existing ones are covered by `scripts/backfill-channel-classification-tags.mjs`.
 */
export function classificationChannelScopedAllow(
  classification: Classification,
  appInstanceArn: string,
  actions: string[] = CLASSIFICATION_GATED_CHANNEL_ACTIONS,
  opts?: {
    /**
     * Override the BEARER resources (statement 2). Default is the unconditioned
     * `…/user/*` + `…/bot/*`. The credential-exchange USER roles
     * pass `[`${appInstanceArn}/user/${'${aws:PrincipalTag/sub}'}`]` to pin the
     * bearer to the caller's OWN AppInstanceUser — closing the impersonation
     * vector (docs/SPEC-CREDENTIAL-EXCHANGE.md §5).
     * Assistant/handler roles keep the default (they legitimately bear a bot).
     */
    bearerResources?: string[];
  },
): iam.PolicyStatement[] {
  const bearerResources = opts?.bearerResources ?? [
    `${appInstanceArn}/user/*`,
    `${appInstanceArn}/bot/*`,
  ];
  // Chime channel-message actions authorize against BOTH the channel resource
  // AND the caller's bearer identity resource (the AWS messaging IAM example
  // policy lists `.../user/<id>` AND `.../channel/*`). So we need two grants:
  //
  // (1) CHANNEL resource — tag-gated. THIS is the classification boundary: the channel
  //     is only granted when its `classification` tag ∈ {this classification and below}.
  //     An untagged / higher-classification channel → no grant → implicit deny (fail-closed).
  // (2) BEARER resource (`/user/*` + `/bot/*`) — UNCONDITIONED. The bearer has no
  //     classification tag, and Chime restricts the ChimeBearer to the caller's
  //     own authenticated identity, so this grants nothing cross-identity and
  //     never widens channel access (channels are `/channel/*`, gated by (1)).
  const statements = [
    new iam.PolicyStatement({
      sid: 'AllowOwnAndLowerClassificationChannelActions',
      effect: iam.Effect.ALLOW,
      actions,
      resources: [`${appInstanceArn}/channel/*`],
      conditions: {
        StringEquals: { 'aws:ResourceTag/classification': classificationsAllowedFor(classification) },
      },
    }),
    new iam.PolicyStatement({
      sid: 'AllowChannelActionsAsBearerIdentity',
      effect: iam.Effect.ALLOW,
      actions,
      resources: bearerResources,
    }),
  ];
  // SPEC-CONVERSATION-ARCHIVE (ADR-017): if this grant includes a message
  // write, layer the archived-channel read-only Deny on top. A Deny overrides
  // the Allow above, so once a channel is tagged `archived=true` neither the
  // per-classification assistant nor a classification user can send/edit — the channel is read-only
  // by IAM. Callers that grant only reads (e.g. DescribeChannel) get no Deny.
  if (actions.some((a) => ARCHIVE_DENIED_ACTIONS.has(a))) {
    statements.push(archivedChannelReadOnlyDeny(appInstanceArn));
  }
  return statements;
}

/** Message-write actions blocked on an archived channel (read-only enforcement). */
export const ARCHIVE_DENIED_ACTIONS = new Set<string>([
  'chime:SendChannelMessage',
  'chime:UpdateChannelMessage',
]);

/**
 * SPEC-CONVERSATION-ARCHIVE (ADR-017) read-only enforcement — a Deny on message
 * writes for any channel tagged `archived=true`. A Deny overrides the tag-gated
 * Allow, making an archived channel read-only by IAM (the AWS-documented
 * read-only-channel pattern, applied with the `archived` tag).
 *
 * NEVER attach this to the admin plane / app-instance-admin bearer: that
 * principal posts the archive system message and must stay exempt. A Deny is
 * global for the principal, so it is scoped to `archived=true` channels only and
 * affects no other channel. `classificationChannelScopedAllow` attaches it automatically
 * for any send/update grant; the admin rung does not go through that function,
 * so it is exempt by construction.
 */
export function archivedChannelReadOnlyDeny(appInstanceArn: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'DenyWriteOnArchivedChannel',
    effect: iam.Effect.DENY,
    actions: [...ARCHIVE_DENIED_ACTIONS],
    resources: [`${appInstanceArn}/channel/*`],
    conditions: {
      StringEquals: { 'aws:ResourceTag/archived': 'true' },
    },
  });
}

/**
 * Instance namespace — lets MULTIPLE AgentEchelon deployments coexist in ONE
 * AWS account (e.g. upstream `agent-echelon` + a host's instance like `acme`)
 * without colliding on stack names, SSM paths, the AppInstance, buckets, etc.
 *
 * Sourced from the `AE_INSTANCE_NAME` **env var** (NOT CDK context) because this
 * module's constants are evaluated at import time, before bin's context reads run.
 * Default `agent-echelon` keeps the upstream/original names unchanged. Set
 * `AE_INSTANCE_NAME=acme` (+ the matching `instanceName` context in bin, which
 * derives the stack-ID prefix + AppInstance name + tags from the same value).
 */
export const INSTANCE_NAME = (process.env.AE_INSTANCE_NAME || 'agent-echelon').trim();
/** SSM root for this instance, e.g. `/agent-echelon` or `/acme`. */
export const SSM_ROOT = `/${INSTANCE_NAME}`;

/** Whether this is the upstream/default instance (names preserved unchanged). */
export const IS_DEFAULT_INSTANCE = INSTANCE_NAME === 'agent-echelon';

/** `acme` → `Acme`. Used to derive the CloudFormation stack-ID prefix. */
function pascal(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * CloudFormation stack-ID prefix — the PascalCase form of the instance name.
 * The default instance yields `AgentEchelon` (`AgentEchelonFoundations`,
 * `AgentEchelonTier-Basic`, …); a host instance gets its own PascalCase prefix
 * (`acme` → `Acme…`), so two instances never update each other's stacks.
 * Override with `AE_STACK_PREFIX`.
 */
export const STACK_PREFIX = process.env.AE_STACK_PREFIX || pascal(INSTANCE_NAME);

/**
 * Prefix for `agent-echelon-*` PHYSICAL resource names (guardrails, fixed-name
 * Lambdas/log-groups, pool/API display names). Equals the instance name, so the
 * default stays `agent-echelon-*` and a host instance becomes `${name}-*`.
 */
export const RES_PREFIX = INSTANCE_NAME;

/**
 * Prefix for the analytics data-plane physical names (Kinesis streams, Firehose
 * delivery streams + log groups, the S3 archive buckets, the Athena workgroup) —
 * all account/region- or globally-unique, so they MUST differ per instance.
 * Equals the instance name (`agent-echelon` by default), so two instances never
 * collide.
 */
export const ANALYTICS_PREFIX = INSTANCE_NAME;

/** The Chime AppInstance display name for this instance. */
export const APP_INSTANCE_NAME = INSTANCE_NAME;

/** The Athena workgroup name for this instance (account/region-unique). */
export const ATHENA_WORKGROUP_NAME = `${ANALYTICS_PREFIX}-analytics`;

/**
 * The Glue/Athena database name for this instance. Underscores (Athena/Glue
 * identifiers can't contain dashes), and account/region-scoped so two instances
 * never share a catalog database (a shared name would be a multi-deploy
 * collision). `agent-echelon` → `agent_echelon`; `acme` → `acme`.
 */
export const ANALYTICS_DB_NAME = ANALYTICS_PREFIX.replace(/-/g, '_');

/**
 * The platform's shared SSM contract — published by the feature stacks
 * (AgentEchelonFoundations, AgentEchelonExperiments, AgentEchelonBattle) and
 * resolved by Standard/Premium tiers at deploy time via
 * `valueForStringParameter` (a dynamic SSM ref, NOT Fn::importValue). Basic
 * does not need any of these — it has no tasks, no /battle.
 * **All paths derive from SSM_ROOT — never hardcode `/agent-echelon/...`.**
 */
export const SHARED_SSM = {
  agentTasksArn: `${SSM_ROOT}/shared/tables/agent-tasks-arn`,
  agentTasksName: `${SSM_ROOT}/shared/tables/agent-tasks-name`,
  userTasksArn: `${SSM_ROOT}/shared/tables/user-tasks-arn`,
  userTasksName: `${SSM_ROOT}/shared/tables/user-tasks-name`,
  // Abuse-controls control plane (dedup / spend budget / rate limit). SPEC-ABUSE-CONTROLS.
  abuseControlsArn: `${SSM_ROOT}/shared/tables/abuse-controls-arn`,
  abuseControlsName: `${SSM_ROOT}/shared/tables/abuse-controls-name`,
  battleStateArn: `${SSM_ROOT}/shared/tables/battle-state-arn`,
  battleStateName: `${SSM_ROOT}/shared/tables/battle-state-name`,
  experimentsArn: `${SSM_ROOT}/shared/tables/experiments-arn`,
  experimentsName: `${SSM_ROOT}/shared/tables/experiments-name`,
  channelBattleConfigName: `${SSM_ROOT}/shared/tables/channel-battle-config-name`,
  // BattleOutcome (user head-to-head picks). Published by AgentEchelonBattle; consumed
  // at deploy time by AgentEchelonAnalyticsAurora for the per-variant battle-wins
  // join. Only the name is needed (the analytics Lambda scans it); IAM is
  // name-pattern-scoped, so the ARN param is unused today.
  battleOutcomeName: `${SSM_ROOT}/shared/tables/battle-outcome-name`,
  battleOutcomeArn: `${SSM_ROOT}/shared/tables/battle-outcome-arn`,
  battleOrchestratorArn: `${SSM_ROOT}/shared/battle-orchestrator-arn`,
  // Cognito user-pool id — standard/premium tiers run the per-classification handler
  // (router code) which does per-message classification enforcement (min(senderTier,
  // channelClassification)) via AdminListGroupsForUser.
  cognitoUserPoolId: `${SSM_ROOT}/shared/cognito-user-pool-id`,
  // Aurora data-plane Lambda ARN. Published by AgentEchelonAnalyticsAurora;
  // consumed at RUNTIME (not deploy — that would be a circular stack dependency,
  // since the Aurora stack already depends on CognitoAuth's user pool) by the
  // admin-conversations handler to read conversations from Aurora instead of the
  // slow Athena archive (BUG #21). Absent in Athena mode.
  auroraDataPlaneArn: `${SSM_ROOT}/shared/analytics/data-plane-arn`,
} as const;

/** Per-instance SSM keys used across stacks (alt-bot slots, admin ARN, etc.). */
export const INSTANCE_SSM = {
  altBotSlotsRoster: `${SSM_ROOT}/alt-bot-slots/roster`,
  appInstanceAdminArn: `${SSM_ROOT}/app-instance-admin-arn`,
  altBotSlotBotArn: (slotId: string) => `${SSM_ROOT}/alt-bot-slots/${slotId}/bot-arn`,
} as const;

/**
 * Wire the async-processor admin error alert (CH parity; SPEC-ABUSE-CONTROLS follow-up).
 * Returns the processor env + an IAM grant. When no alert channel is configured the env stays
 * empty, so the processor is log-only (`sendProcessorErrorAlert` no-ops) and nothing is
 * granted. When set, the processor may post a failure to that one channel bearing the
 * app-instance-admin identity; the channel flow fans the message's `notify` directive out to
 * the admin roster over email. The admin ARN is resolved at deploy time (SSM dynamic ref) so
 * the processor needs no runtime SSM read.
 */
/**
 * Wire the abuse-controls plane (SPEC-ABUSE-CONTROLS) into a classification's handler + processor. Returns
 * the env + an IAM grant on the shared control table. Request DEDUP is active whenever the table
 * is present (which it always is here) - it fixes the duplicate-fulfillment task clobber and is
 * always safe. The spend BUDGET is opt-in: the ceilings default to 0 (off) and a deployment turns
 * them on with `-c bedrockUserHourlyBudget=N -c bedrockGlobalHourlyBudget=N`. Spread `env` on both
 * the handler (runs the budget check) and the processor (runs the dedup claim), and grant both.
 */
export function abuseControlsWiring(
  scope: Construct,
  abuseControlsArn: string,
  abuseControlsName: string,
  classification: Classification,
  region: string,
  account: string,
): { env: Record<string, string>; grant: (role: iam.IRole) => void } {
  const ctxNum = (k: string, dflt = '0'): string => {
    const v = scope.node.tryGetContext(k);
    return v === undefined || v === null ? dflt : String(v);
  };
  const cannedCtx = scope.node.tryGetContext('budgetCannedResponse');
  // Circuit-trip SSM param (edge-shedding signal). One shared per-instance param; flipped when the
  // global model-call count crosses the trip threshold. Wired only when a global budget is set
  // (the trip is meaningless otherwise); the grant + env follow the same condition.
  const globalBudget = ctxNum('bedrockGlobalHourlyBudget');
  const circuitParamName = `${SSM_ROOT}/abuse/circuit`;
  const wireCircuit = parseInt(globalBudget, 10) > 0;
  const env: Record<string, string> = {
    ABUSE_CONTROLS_TABLE: abuseControlsName,
    BEDROCK_USER_HOURLY_BUDGET: ctxNum('bedrockUserHourlyBudget'),
    BEDROCK_GLOBAL_HOURLY_BUDGET: globalBudget,
    // Rate-limit ceiling moved to the profile config (profiles.ts rateLimitPerHour), read at runtime
    // by the router — no longer a per-classification env var / -c rateLimit<Classification> knob.
    // Inbound length cap. Defaulted generously (16000 chars ~ 4k tokens) rather than CH's 2000:
    // CH is a portfolio widget, AE is an enterprise assistant where report/extraction prompts and
    // pasted content are legitimately long, so a 2000 cap would degrade real use (superset tenet).
    // Bounds egregious abuse; -c maxUserMessageLength overrides, 0 disables.
    MAX_USER_MESSAGE_LENGTH: ctxNum('maxUserMessageLength', '16000'),
    ...(wireCircuit
      ? { ABUSE_CIRCUIT_PARAM: circuitParamName, ABUSE_CIRCUIT_TRIP_THRESHOLD: ctxNum('bedrockCircuitTripThreshold', globalBudget) }
      : {}),
    ...(cannedCtx ? { BUDGET_CANNED_RESPONSE: String(cannedCtx) } : {}),
  };
  const grant = (role: iam.IRole): void => {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // dedup = conditional PutItem; budget + rate-limit counters = UpdateItem. GetItem reserved.
        actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'],
        resources: [abuseControlsArn],
      }),
    );
    if (wireCircuit) {
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['ssm:PutParameter'],
          resources: [`arn:aws:ssm:${region}:${account}:parameter${circuitParamName}`],
        }),
      );
    }
  };
  return { env, grant };
}

export function adminErrorAlertWiring(
  scope: Construct,
  appInstanceArn: string,
  alertChannelArn: string | undefined,
): { env: Record<string, string>; grant: (role: iam.IRole) => void } {
  const env: Record<string, string> = {
    ADMIN_ERROR_ALERT_CHANNEL_ARN: alertChannelArn || '',
    ADMIN_ALERT_BEARER_ARN: ssm.StringParameter.valueForStringParameter(scope, INSTANCE_SSM.appInstanceAdminArn),
  };
  const grant = (role: iam.IRole): void => {
    if (!alertChannelArn) return; // log-only; nothing to authorize
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // Post the alert to the one admin channel, bearing the app-instance-admin identity
        // (the `/user/*` bearer resource, matching the membership-audit alert grant).
        actions: ['chime:SendChannelMessage'],
        resources: [alertChannelArn, `${appInstanceArn}/user/*`],
      }),
    );
  };
  return { env, grant };
}

/**
 * SSM keys this classification PUBLISHES — read by create-conversation (per-classification bot member)
 * and the classification's own handler/processor. There is no shared-bot key; every classification
 * owns its own bot.
 */
export function botArnKey(classification: Classification): string {
  return `${SSM_ROOT}/assistant/${classification}/bot-arn`;
}
export function processorArnKey(classification: Classification): string {
  return `${SSM_ROOT}/assistant/${classification}/processor-arn`;
}

/**
 * Resolve the platform's ALWAYS-PRESENT shared SSM contract at deploy time
 * (tasks tables + experiments table + Cognito pool id). Published by
 * AgentEchelonFoundations/AgentEchelonExperiments, which deploy regardless of whether
 * /battle is enabled. Returns the dynamic SSM refs the classification's role and
 * processor env use. Only used by the Standard + Premium tiers; Basic
 * doesn't call this.
 *
 * The /battle-specific params (battle-state, channel-battle-config,
 * battle-orchestrator) are resolved SEPARATELY via `resolveBattleSSM`, and
 * only when the classification wires battle — because AgentEchelonBattle is opt-in, those
 * params may not exist, and `valueForStringParameter` fails the deploy on a
 * missing param. Keeping them out of here lets a classification deploy with battle off.
 */
export function resolveSharedSSM(scope: Construct): {
  agentTasksArn: string;
  agentTasksName: string;
  userTasksArn: string;
  userTasksName: string;
  abuseControlsArn: string;
  abuseControlsName: string;
  experimentsArn: string;
  experimentsName: string;
  cognitoUserPoolId: string;
} {
  const v = (name: string) => ssm.StringParameter.valueForStringParameter(scope, name);
  return {
    agentTasksArn: v(SHARED_SSM.agentTasksArn),
    agentTasksName: v(SHARED_SSM.agentTasksName),
    userTasksArn: v(SHARED_SSM.userTasksArn),
    userTasksName: v(SHARED_SSM.userTasksName),
    abuseControlsArn: v(SHARED_SSM.abuseControlsArn),
    abuseControlsName: v(SHARED_SSM.abuseControlsName),
    experimentsArn: v(SHARED_SSM.experimentsArn),
    experimentsName: v(SHARED_SSM.experimentsName),
    cognitoUserPoolId: v(SHARED_SSM.cognitoUserPoolId),
  };
}

/**
 * Resolve the /battle-only shared SSM contract (published by the opt-in
 * AgentEchelonBattle stack). Call ONLY when the classification actually wires battle
 * (`enableBattle` true) — otherwise the params may be absent and the deploy
 * would fail on the dynamic SSM ref. Keyed by the SHARED_SSM names that
 * AgentEchelonBattle publishes, so a battle-enabled classification resolves the same
 * plumbing.
 */
export function resolveBattleSSM(scope: Construct): {
  battleStateArn: string;
  battleStateName: string;
  channelBattleConfigName: string;
  battleOrchestratorArn: string;
} {
  const v = (name: string) => ssm.StringParameter.valueForStringParameter(scope, name);
  return {
    battleStateArn: v(SHARED_SSM.battleStateArn),
    battleStateName: v(SHARED_SSM.battleStateName),
    channelBattleConfigName: v(SHARED_SSM.channelBattleConfigName),
    battleOrchestratorArn: v(SHARED_SSM.battleOrchestratorArn),
  };
}

/**
 * Collect every Bedrock model ARN this classification is allowed to invoke (text
 * models only — image-gen ARNs are hardcoded inline in Premium since they
 * are premium-exclusive).
 */
export function modelArnsForClassification(classification: Classification, catalog: ClassificationModelCatalog): string[] {
  const arns: string[] = [];
  for (const model of Object.values(catalog)) {
    if (model.allowedClassifications.includes(classification)) {
      arns.push(...model.foundationModelArns);
      if (model.inferenceProfileArns) arns.push(...model.inferenceProfileArns);
    }
  }
  return arns;
}

/**
 * SSM key the ChannelFlow stack publishes the channel-flow ARN under. The
 * live-drift confirm path reads it to associate the standard channel flow onto
 * the channel it creates (so @all routing works there too). Literal-shared with
 * `channel-flow-stack.CHANNEL_FLOW_ARN_SSM_KEY` + foundations-stack — keep in sync.
 */
export const CHANNEL_FLOW_ARN_SSM_KEY = `${SSM_ROOT}/channel-flow-arn`;

/**
 * IAM the per-classification agent handler needs so the LIVE-drift confirm path can
 * create a follow-up channel (`createConversationFromDrift`). Attached ONLY in
 * Aurora mode (when drift is wired) — keeps the handler read-only on Chime
 * otherwise.
 *
 * Security split:
 * - Create-time actions (CreateChannel/TagResource/membership/moderator/
 *   AssociateChannelFlow) are app-scoped, mirroring the proven create-conversation
 *   role — they either target a not-yet-existing channel or authorize against the
 *   user resource, so they can't be channel-tag-gated.
 * - `SendChannelMessage` is granted SEPARATELY and TAG-GATED via
 *   `classificationChannelScopedAllow`, so the handler can message the new (own-classification)
 *   channel but NEVER a higher-classification one. The deny-tested Layer-1 send boundary
 *   stays intact even though the handler can now create channels.
 */
export function driftChannelCreateStatements(
  classification: Classification,
  appInstanceArn: string,
  region: string,
  account: string,
): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: 'DriftCreateConversation',
      effect: iam.Effect.ALLOW,
      actions: [
        'chime:CreateChannel',
        'chime:TagResource',
        'chime:CreateChannelMembership',
        'chime:CreateChannelModerator',
        'chime:AssociateChannelFlow',
        // The spawned drift channel is given a TTL via PutChannelExpirationSettings; without this the
        // confirm ("yes") path throws AccessDenied after CreateChannel, is caught, and silently falls
        // back to a normal reply — so "yes" never creates/navigates to the channel (drift-confirm bug).
        'chime:PutChannelExpirationSettings',
      ],
      resources: [`${appInstanceArn}/*`],
    }),
    // SendChannelMessage to the freshly-created channel — tag-gated (own classification
    // and below), NOT app-wide, so the handler can't message a higher-classification channel.
    // Bearer pinned to bots only (the handler sends AS the classification bot, never as a
    // user).
    ...classificationChannelScopedAllow(classification, appInstanceArn, ['chime:SendChannelMessage'], {
      bearerResources: [`${appInstanceArn}/bot/*`],
    }),
    new iam.PolicyStatement({
      sid: 'DriftReadChannelFlowArn',
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter${CHANNEL_FLOW_ARN_SSM_KEY}`],
    }),
  ];
}

/**
 * Aurora hookup a per-classification agent handler needs to run LIVE drift detection
 * (SPEC-DRIFT-CONVERGENCE.md). Mirrors the fields AnalyticsStackAurora exports.
 * Only present in Aurora mode; in Athena mode the classification wires no drift.
 */
export interface AuroraDriftHookup {
  /**
   * ARN of the retrieval + drift data-plane Lambda exposed by
   * AnalyticsStackAurora (project decision 018). The classification's agent handler is
   * granted `lambda:InvokeFunction` on it and invokes it for retrieval + drift,
   * instead of being VPC-attached to Aurora itself. This keeps the Lex-facing
   * handler off the VPC path, where it would hang on SSM / Cognito /
   * Lambda-invoke calls that have no endpoint in the isolated subnets.
   */
  dataPlaneArn: string;
}

/**
 * Out-of-band per-message analytics table (SPEC-MESSAGE-METADATA-CODEBOOK.md
 * Phase 1; ADR-016). Passed from the Aurora stack (the consumer) to each classification
 * stack so the classification's async processor can WRITE the full analytics blob there
 * keyed by message id (and slim the Chime Metadata). Present in Aurora mode
 * only; undefined in Athena mode ⇒ the processor keeps full inline metadata.
 */
export interface MessageAnalyticsWiring {
  tableName: string;
  tableArn: string;
}

/**
 * Wire a classification async processor to the out-of-band analytics table: set the env
 * var the shared lib reads (`MESSAGE_ANALYTICS_TABLE`) and grant write-only
 * access scoped to that table. No-op when the wiring is absent (Athena mode).
 * Write-only: the processor never reads analytics back (only the Aurora archival
 * Lambda does).
 */
export function wireMessageAnalytics(
  fn: { addEnvironment(k: string, v: string): unknown; addToRolePolicy(s: iam.PolicyStatement): unknown },
  wiring?: MessageAnalyticsWiring,
): void {
  if (!wiring) return;
  fn.addEnvironment('MESSAGE_ANALYTICS_TABLE', wiring.tableName);
  fn.addToRolePolicy(
    new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [wiring.tableArn] }),
  );
}

/**
 * Wire LIVE drift detection + RAG retrieval onto a per-classification agent handler.
 * Returns the env + the IAM the handler role needs to INVOKE the retrieval +
 * drift data-plane Lambda (project decision 018). The handler is NOT
 * VPC-attached; the data-plane Lambda owns the Aurora + Titan-embed access.
 * Wired on EVERY classification (basic/standard/premium) so each can run drift + RAG.
 * Drift is conversation-level + all-classification + on-by-default in Aurora mode (NOT
 * premium-only — see docs/SPEC-DRIFT-CONVERGENCE.md §"runs on all AE tiers").
 *
 * Usage in a classification stack (only when `hookup` is provided, i.e. Aurora mode):
 *   const drift = auroraDriftWiring(this, classification, hookup);
 *   new lambdaNodeJs.NodejsFunction(this, 'AgentHandler', {
 *     environment: { ...baseEnv, ...drift.env },   // NO VPC props
 *     ...
 *   });
 *   drift.grantTo(handlerRole);
 */
export function auroraDriftWiring(
  scope: Construct,
  _tier: Classification,
  hookup: AuroraDriftHookup,
): {
  env: Record<string, string>;
  grantTo: (role: iam.IRole) => void;
} {
  // scope is retained for signature stability with the classification stacks; the
  // data-plane model needs no stack-scoped constructs here.
  void scope;

  return {
    // The handler reads HAS_AURORA = !!AURORA_DATA_PLANE_ARN and
    // ENABLE_LIVE_DRIFT === 'true'. Setting ENABLE_LIVE_DRIFT here makes drift ON
    // BY DEFAULT whenever Aurora is wired (the deployer opts OUT, not in). The
    // handler is NOT VPC-attached: it invokes the data-plane Lambda for the
    // Aurora + Bedrock work (project decision 018).
    env: {
      AURORA_DATA_PLANE_ARN: hookup.dataPlaneArn,
      ENABLE_LIVE_DRIFT: 'true',
    },
    grantTo: (role: iam.IRole) => {
      // The only privilege the classification handler needs for retrieval + drift: invoke
      // the data-plane Lambda. All DB / RDS-IAM / Titan-embed access lives on the
      // data-plane Lambda's own role in AnalyticsStackAurora.
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [hookup.dataPlaneArn],
        }),
      );
    },
  };
}
