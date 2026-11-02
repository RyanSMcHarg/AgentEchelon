/**
 * BattleStack (`AgentEchelonBattle`) — the /battle head-to-head feature, an
 * independently-deployable stack created when the deployment declares the `battle` capability
 * (`lib/config/capabilities.ts`). Without it the assistant stacks and channel-flow are built with no
 * battle plumbing.
 *
 * Owns end-to-end:
 *   - Battle tables: `BattleState` (per-bot round state), `ChannelBattleConfig`
 *     (per-channel enable flag), `BattleOutcome` (the user's winner pick).
 *   - The battle orchestrator Lambda (drives round-2 fan-out through each
 *     classification's router, resolved at deploy from that router's published
 *     ARN; the router posts every line of the duel, so the orchestrator speaks as
 *     no assistant).
 *   - The channel-battle admin API (`/channels/battle` GET/enable/disable) and
 *     the battle-outcome API (`/channels/battle/outcome` GET/POST).
 *   - The grant on its tables held by the channel flow's role.
 *   - The shared SSM contract `<SSM root>/shared/tables/{battle-state-arn,battle-state-name,
 *     channel-battle-config-name, battle-outcome-*}` + `<SSM root>/shared/battle-orchestrator-arn`, for an
 *     operator and a script to find them.
 *
 * NOT A CLASSIFICATION'S PART. Each battle-capable classification's alt (its Amazon Lex bot, its
 * `AppInstanceBot`, its `(classification, role, alt)` assignment record and its name applier) and the
 * grants a duel runs on, on that classification's acting role and router role, are built by its own
 * `Assistants-<classification>` stack (`attachBattle`, `classification-capabilities.ts`), so this stack
 * names no classification and a classification is added or removed without it.
 *
 * DEPLOYED AFTER THE CHANNEL FLOW IT ATTACHES TO. The tables and the orchestrator carry fixed names
 * (`CAPABILITY_RESOURCES`), which the assistant stacks and the channel flow are told in their environment;
 * this stack attaches its grant to the channel flow's role, and each battle-capable classification's stack builds
 * its own part on the same names (STACKS.md, additivity). It reads (does not own) the experiments
 * table, by its fixed name. It names each classification's router (Battle Mode's notices, its marker clears,
 * and the orchestrator's rounds and notices) BY NAME at call time (`resolveRouterArn`).
 *
 * **Classification-configurable, premium by default.** Every caller asks `canRunBattle`
 * (`lambda/src/lib/battle-enablement.ts:98`), which answers two questions in order (ADR-049): whether
 * the deployment WIRED battle for this classification, then whether an operator TURNED IT ON. So
 * /battle can be opened to other classifications by config without code changes.
 *
 * It is not a single `battleEligible` flag on the assistant profile any more. That flag answered only
 * the policy half, and answered `true` for a classification whose stack wires no battle plumbing - so
 * the surface promised what the role could not back.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import { grantIssuerRegistry } from '../constructs/trusted-issuers';
import type { RouteSource, RouteSpec } from '../constructs/http-api';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { dataRemovalPolicy as dataRemovalPolicyOf } from '../config/environment';
import * as path from 'path';
import {
  SHARED_SSM, SSM_ROOT, CAPABILITY_RESOURCES, roomPrimaryReadStatements, sayThroughRouterWiring,
  membershipAsAssistantStatements, experimentsResourcesOf, battleResourcesOf,
  EVERY_CLASSIFICATION,
  anyClassificationTagged,
} from './agent-classification-common';
import { attachableRole } from './experiments-stack';

export interface BattleStackProps extends cdk.StackProps {
  /** Shared Chime AppInstance ARN (from AgentEchelonMessaging). */
  appInstanceArn: string;
  /** This deployment's own pool, or `''` when the registry declares none (L15). */
  selfPoolId: string;
  /** Frontend URL for CORS (defaults to the `appUrl` context / localhost). */
  appUrl?: string;
  /** The channel flow's processor role: it writes a duel's first rows and reads Battle Mode's flag. */
  channelFlowRole?: iam.IRole;
  /**
   * Offboarding's role (Identity): it removes an erased person's name from the battle settings they enabled
   * (`enabledBy`, SPEC-CREDENTIAL-EXCHANGE §5b). Absent for a stack built alone for a test.
   */
  offboardingRoleArn?: string;
}

export class BattleStack extends cdk.Stack implements RouteSource {
  /** The channel-battle and battle-outcome routes, on `PersonApi`. */
  public readonly routes: RouteSpec[] = [];
  /** Battle table name/ARN — passed to ChannelFlow for INVOKED row writes + config reads. */
  public readonly battleStateTableName: string;
  public readonly battleStateTableArn: string;
  public readonly channelBattleConfigTableName: string;
  public readonly channelBattleConfigTableArn: string;
  public readonly battleOrchestratorFunctionArn: string;

  constructor(scope: Construct, id: string, props: BattleStackProps) {
    super(scope, id, props);

    const dataRemovalPolicy = dataRemovalPolicyOf(this);
    const appUrl = this.node.tryGetContext('appUrl') || props.appUrl || 'http://localhost:5173';

    // The experiments table, owned by `Experiments` (which `battle` requires), by its fixed name.
    const { experimentsArn: experimentsTableArn, experimentsName: experimentsTableName } = experimentsResourcesOf(this);
    const names = battleResourcesOf(this);

    // ============================================================
    // DynamoDB Tables for /battle (SPEC-BATTLE.md)
    // ============================================================
    //
    // BattleStateTable: per-bot state-machine rows for in-flight battles.
    // PK battleId (sha256(channelArn + ':' + userMessageId)[:16]) groups rows by
    // battle invocation. SK botArn distinguishes the per-bot row. The `ttl`
    // attribute ages out stale rows from crashed invocations; the writers set
    // it (`battleRowTtl`, battle-state.ts) to outlive the whole duel, because a
    // row deleted while a SIBLING side is still legitimately in flight makes a
    // half-read set look like a finished battle.
    const battleStateTable = new dynamodb.Table(this, 'BattleStateTable', {
      tableName: CAPABILITY_RESOURCES.battleStateTable,
      partitionKey: { name: 'battleId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'botArn', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // ChannelBattleConfigTable: per-channel feature state. Drift detection reads
    // this via lib/battle-state.ts to suppress live drift in battle-enabled channels.
    const channelBattleConfigTable = new dynamodb.Table(this, 'ChannelBattleConfigTable', {
      tableName: CAPABILITY_RESOURCES.channelBattleConfigTable,
      partitionKey: { name: 'channelArn', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // BattleOutcomeTable: every channel member's explicit head-to-head pick per
    // battle (SPEC-BATTLE.md §"Battle Scoring & Per-Step Telemetry", decision 3;
    // DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md §3.4 B3 + A.4). PK battleId, ONE
    // item per battle holding a per-person `votes` MAP keyed by the chooser's
    // AppInstanceUser id (see lib/battle-outcome.ts). Each member's pick is retained (re-picking
    // overwrites only that person's map entry via an atomic `SET votes.<personId>`), and
    // the winner is a TALLY of decisive picks, not the last click. No TTL — the
    // pick is the durable scorecard record. Descriptive only; never read back into
    // variant selection.
    //
    // The per-user map lives INSIDE the item under the SAME PK (battleId), so this
    // is a purely ADDITIVE, item-level change — no sort key, no table re-key, no
    // destructive replacement, and deployed rows keep working (INV-2). The reader
    // (extractPicks) is versioned and tolerates a legacy v1 single-pick row during
    // cutover, so no backfill is required.
    const battleOutcomeTable = new dynamodb.Table(this, 'BattleOutcomeTable', {
      tableName: CAPABILITY_RESOURCES.battleOutcomeTable,
      partitionKey: { name: 'battleId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.battleStateTableName = battleStateTable.tableName;
    this.battleStateTableArn = battleStateTable.tableArn;
    this.channelBattleConfigTableName = channelBattleConfigTable.tableName;
    this.channelBattleConfigTableArn = channelBattleConfigTable.tableArn;

    // OFFBOARDING REMOVES THE PERSON WHO ENABLED A BATTLE SETTING FROM IT (lib/offboarding.ts): the rows naming
    // them are found by a scan, and `enabledBy` is removed from each; the setting is the conversation's and
    // stays. The grant sits with the table, on the role Identity owns, as Conversations grants it on its own.
    if (props.offboardingRoleArn) {
      const offboarding = iam.Role.fromRoleArn(this, 'ImportedOffboardingRole', props.offboardingRoleArn, { mutable: true });
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:Scan'],
        resources: [channelBattleConfigTable.tableArn],
      }));
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [channelBattleConfigTable.tableArn],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['channelArn', 'enabledBy'] } },
      }));
    }

    // ============================================================
    // Battle Orchestrator Lambda (SPEC-BATTLE.md)
    // ============================================================
    //
    // Coordinates round-2 fan-out after both bots reach round-1 terminal state.
    // Invoked async from the duel classification's processor on the last transition.
    // Hands each rebuttal round to the duel classification's router, which posts the side's round-2
    // placeholder, and names the duel's closing lines to that router as notices. It speaks as no
    // assistant: no vend, no routing record, no Amazon Chime SDK send.
    //
    // Each conversational classification's router, read by name at call time (`resolveRouterArn`): the
    // classification stacks that publish the `router-arn` parameters deploy after this one.
    const orchestratorRouters = sayThroughRouterWiring(this, EVERY_CLASSIFICATION, { resolvesPrimary: false });
    const battleOrchestratorRole = new iam.Role(this, 'BattleOrchestratorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        // NO CHIME GRANT AND NO VEND. Every line of a duel outside a turn - a rebuttal placeholder, "didn't
        // finish in time", the close notice, an ended duel's marker clears - is said by the duel
        // classification's router as that side's assistant, on a speak route of the router's own.
        BattleStatePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
              resources: [battleStateTable.tableArn],
            }),
            // RELEASING THE CHANNEL is part of finishing a duel. `emitBattleComplete` clears the
            // `activeBattleId` pointer, which lives on the CONFIG table - a table this Lambda had no
            // reason to touch until the pointer stopped being released by a clock.
            //
            // GetItem as well: round 2 resolves both sides' variants from the experiment the
            // conversation bound at enable (`loadChannelBattleConfig(channelArn).experimentId`), a single
            // read by the table's key, so no index. Never replaces or deletes the row.
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
              resources: [channelBattleConfigTable.tableArn],
            }),
          ],
        }),
        // Resolve-once (DESIGN-MULTI-ASSISTANT-TURN-ENGINE): the orchestrator now
        // resolves each side's experiment variant once for the round-2 fan-out
        // (loadExperiments does a Scan), so the worker runs a normal request with
        // no second resolution. Without this read grant the resolvers fall back
        // to null and the worker resolves normally (degraded, not broken).
        ExperimentsReadPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:Scan', 'dynamodb:GetItem'],
              resources: [experimentsTableArn],
            }),
          ],
        }),
        LambdaInvokePolicy: new iam.PolicyDocument({
          // THE ROUTERS, AND ONLY THE ROUTERS: a rebuttal round is validated, its placeholder posted, and
          // the round recorded and dispatched by the duel classification's router, and the duel's closing
          // lines are notices that router says (`sayThroughRouter`). Granted by the router's construct id
          // on this instance's classification functions (`ownInstanceFunctions`), with the read of each
          // classification's `router-arn` parameter. A pattern over a whole assistant stack also reaches every
          // classification's processor, which the orchestrator never invokes.
          statements: orchestratorRouters.statements,
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            // THE VERSION EACH DUEL SIDE SERVES (ADR-050). A rebuttal round carries its side's variant,
            // and the vend narrows that round's session to the variant's definition: the alt has no
            // other version to serve. Without this read the pin resolved to nothing, round 2 went out
            // with no variant, and the vend refused the alt's rebuttal on every duel (measured live
            // 2026-10-13, `profileRef alt-primary-premium@32 unresolved`). Any assistant's definition, under the
            // path wildcard, read only: a duel fields a classification's live assistant and its alt, whichever
            // classification it runs in, so the read names none and declaring one changes nothing here.
            new iam.PolicyStatement({
              sid: 'ReadTheDuelSidesVersions',
              actions: ['ssm:GetParameter'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/definition`],
            }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    // A duel's closing line is said by the room's primary (§3.8): the room's tags and the assignment records.
    for (const stmt of roomPrimaryReadStatements(this, EVERY_CLASSIFICATION)) battleOrchestratorRole.addToPolicy(stmt);

    // Deterministic name so the ARN can be published to SSM as a constructed
    // string (the classification processors resolve it via /agent-echelon/shared/
    // battle-orchestrator-arn). The orchestrator itself invokes the premium classification
    // processor via an SSM dynamic ref, so there is no GetAtt cycle to break.
    const battleOrchestratorName = names.battleOrchestratorName;
    const battleOrchestratorArn = names.battleOrchestratorArn;

    const battleOrchestrator = new lambdaNodeJs.NodejsFunction(this, 'BattleOrchestrator', {
      entry: path.join(__dirname, '../../lambda/src/battle-orchestrator.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      functionName: battleOrchestratorName,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      role: battleOrchestratorRole,
      environment: {
        BATTLE_STATE_TABLE: battleStateTable.tableName,
        // The pointer this Lambda now RELEASES when a duel finishes. Absent, `clearActiveBattle`
        // returns at its first line and the release silently never happens - the whole point of the
        // change, inert, with no error to notice. The env var and the grant above go together.
        CHANNEL_BATTLE_CONFIG_TABLE: channelBattleConfigTable.tableName,
        // Resolve-once round-2 variant resolution (loadExperiments reads this table).
        EXPERIMENTS_TABLE: experimentsTableName,
        // Each classification's router: the rebuttal round and the duel's notices go to it.
        ...orchestratorRouters.env,
        SSM_ROOT,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    this.battleOrchestratorFunctionArn = battleOrchestrator.functionArn;

    // ============================================================
    // Shared SSM contract for the per-classification stacks (SPEC-PER-PROFILE-OWNERSHIP.md).
    // The battle-capable assistant stacks resolve these at DEPLOY time via
    // valueForStringParameter (dynamic ref, NOT Fn::importValue), and only when the
    // deployment declares `battle`, so an assistant stack deploys without this stack.
    // ============================================================
    const sharedParams: Array<[string, string, string]> = [
      ['SharedBattleStateArnParam', SHARED_SSM.battleStateArn, battleStateTable.tableArn],
      ['SharedBattleStateNameParam', SHARED_SSM.battleStateName, battleStateTable.tableName],
      ['SharedChannelBattleConfigNameParam', SHARED_SSM.channelBattleConfigName, channelBattleConfigTable.tableName],
      // Battle-outcome table for the analytics battle-wins join.
      ['SharedBattleOutcomeNameParam', SHARED_SSM.battleOutcomeName, battleOutcomeTable.tableName],
      ['SharedBattleOutcomeArnParam', SHARED_SSM.battleOutcomeArn, battleOutcomeTable.tableArn],
      ['SharedBattleOrchestratorArnParam', SHARED_SSM.battleOrchestratorArn, battleOrchestratorArn],
    ];
    for (const [paramId, parameterName, stringValue] of sharedParams) {
      new ssm.StringParameter(this, paramId, { parameterName, stringValue });
    }

    // ============================================================
    // The channel-battle and battle-outcome routes
    // ============================================================

    // Battle Mode's lines are named to the router of the conversation's classification, read by name at
    // call time because the classification stacks that publish the router ARNs deploy after this one.
    const battleNotices = sayThroughRouterWiring(this, EVERY_CLASSIFICATION);
    const channelBattleRole = new iam.Role(this, 'ChannelBattleRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            // ── CHANNEL ACTIONS, FAIL-CLOSED ON THE CLASSIFICATION TAG ──────────────────────────
            //
            // This role serves EVERY classification - a duel runs in whatever room it was called in -
            // so unlike an assistant role it cannot be pinned to one value. What it can do, and did
            // not, is refuse an UNTAGGED channel. Ungated on `${appInstanceArn}/*` this role could
            // send into any channel in the app instance including one carrying no classification at
            // all, which is the one shape every other boundary in the platform treats as the failure
            // case (ADR-042; SPEC-CONVERSATION-SECURITY Layer 1 is fail-closed for exactly this).
            //
            // Conditioning on the declared set keeps every legitimate duel working and removes the
            // untagged channel from reach, so the boundary fails the same way here as everywhere else.
            //
            // DescribeChannel: caller-scoped access check (is the caller a member).
            // ListTagsForResource: the classification gate reads the IMMUTABLE `classification` tag,
            // not mutable metadata, so a tampered modelTier cannot open battles.
            new iam.PolicyStatement({
              sid: 'BattleChannelActionsOnClassifiedChannels',
              actions: [
                'chime:DescribeChannel',
                'chime:ListTagsForResource',
                'chime:ListChannelModerators',
              ],
              resources: [`${props.appInstanceArn}/channel/*`],
              conditions: {
                // ADR-045 DECISION 7 SAYS THIS BECOMES EXACTLY-OWN. IT MUST NOT, AND THE RECORD IS
                // WRONG ABOUT WHICH PRINCIPAL THIS IS (verified 2026-09-17).
                //
                // This is not an alt assistant's grant. It is the role of `channel-battle.ts`, the
                // ADMINISTRATIVE API a channel moderator calls to turn Battle Mode on or off in their
                // own conversation - ONE function serving every classification, which acts as the
                // room's own per-classification bot through `ChimeBearer`. The IAM principal is this
                // single shared role, so there is no "own" classification to pin it to:
                // `aws:PrincipalTag` would need one tag per classification on one role, and a literal
                // would break every other classification's moderators.
                //
                // Administration is cross-channel by definition; moderation is channel-scoped. The
                // narrowing decision 7 asks for belongs to the alt ASSISTANTS' identities, and that is
                // where it went: each alt bot is now tagged at creation, so the exactly-own boundary
                // is enforced on the identity that answers the turn rather than on the API that
                // enables the feature. Splitting this into one role per classification would buy
                // nothing: the caller is already authorized as the channel's moderator above.
                ...anyClassificationTagged(),
              },
            }),
            // ── AND THE SAME ACTIONS AGAINST THE BEARER IDENTITY ────────────────────────────────
            //
            // Amazon Chime SDK authorizes a channel action against BOTH resources: the channel, and
            // the `ChimeBearer` the call is made as. The statement above covers only the channel, so
            // without this one every action in it is denied on the bearer leg and Battle Mode cannot
            // be turned on or off at all - `channel-battle.ts`'s first `DescribeChannel` fails. The
            // stack deploys green and the feature is dead, which is exactly how this was missed.
            //
            // READS ONLY. Amazon Chime SDK does not bind the `ChimeBearer` to the caller, so this role
            // could once post as any user or assistant through this leg. The ON/OFF notices now go out on
            // the room assistant's vended session, so no send is granted here at all. The caller's own
            // `/user/*` leg serves the moderator check; the `/bot/*` leg is pinned to classified
            // assistants by the identity tag every bot now carries.
            new iam.PolicyStatement({
              sid: 'BattleChannelReadsAsTheCaller',
              effect: iam.Effect.ALLOW,
              actions: ['chime:DescribeChannel', 'chime:ListTagsForResource', 'chime:ListChannelModerators'],
              resources: [`${props.appInstanceArn}/user/*`],
            }),
            new iam.PolicyStatement({
              sid: 'BattleChannelReadsAsTheRoomAssistant',
              effect: iam.Effect.ALLOW,
              actions: ['chime:DescribeChannel', 'chime:ListTagsForResource', 'chime:ListChannelModerators'],
              resources: [`${props.appInstanceArn}/bot/*`],
              conditions: anyClassificationTagged(),
            }),
            // NO SPEAKING: Battle Mode's lines are named to the router (`sayThroughRouter`).
            ...battleNotices.statements,
            // ── ADDING AND REMOVING THE ALT, AS THE ROOM'S ASSISTANT, IN A CLASSIFIED CONVERSATION ──
            //
            // Conditioned on the conversation's classification and on a bearer carrying one (step 24).
            // The alt being added or removed is `MemberArn`, a parameter IAM never sees, so which
            // assistant joins is decided by `channel-battle.ts`'s experiment check against the room's alt
            // assignment record (read under `battleNotices`' assignment grant) and seen by the membership audit.
            ...membershipAsAssistantStatements('BattleAltMembership', props.appInstanceArn, EVERY_CLASSIFICATION),
            // The caller's own membership, read as the caller to confirm they are in the room. A read,
            // and the caller's `/user/*` bearer, so it keeps its app-instance scope.
            new iam.PolicyStatement({
              sid: 'BattleMembershipReadAsTheCaller',
              actions: ['chime:DescribeChannelMembership'],
              resources: [`${props.appInstanceArn}/*`],
            }),
          ],
        }),
        BattleConfigDdb: new iam.PolicyDocument({
          statements: [
            // TURNING BATTLE MODE OFF NOW ENDS THE RUNNING DUEL, which needs two things this policy
            // did not grant. `UpdateItem` because releasing the `activeBattleId` pointer is an UPDATE,
            // not the Put/Delete this handler previously used - without it the release AccessDenies
            // into a caught warning and the pointer survives a disable.
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
              resources: [channelBattleConfigTable.tableArn],
            }),
            // And the duel's own rows, because ending it is not only releasing the pointer: the sides
            // are marked ABANDONED (UpdateItem), the round-2 fire is poisoned by claiming the
            // orchestrator sentinel (PutItem), and both need the partition read first (Query). Missing,
            // every one of those fails soft - `readBattleRows` returns [], the transitions return false
            // - so Battle Mode off would release the channel while leaving a duel's sides live and its
            // rebuttal unsuppressed.
            new iam.PolicyStatement({
              actions: ['dynamodb:Query', 'dynamodb:UpdateItem', 'dynamodb:PutItem'],
              resources: [battleStateTable.tableArn],
            }),
          ],
        }),
        ExperimentsDdb: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem', 'dynamodb:Scan'],
              resources: [experimentsTableArn],
            }),
          ],
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [
                // The per-classification bot keys channel-battle.ts resolves (resolvePrimaryBotArn).
                // Every classification owns its own bot; there is no shared /agent-echelon/bot-arn.
                `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/bot-arn`,
                // WHETHER BATTLE IS TURNED ON for a classification (ADR-049): the policy half of
                // `canRunBattle`, which this handler asks on both the enable path and the composer's
                // status read. WITHOUT THIS THE READ FAILS CLOSED AND BATTLE IS OFF EVERYWHERE - the
                // safe direction, and a silent one, so it is granted rather than left to be diagnosed
                // as a product fault. Scoped to the leaf; the capability half needs no read at all.
                `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/battle/*/enabled`,
              ],
            }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    const channelBattleFn = new lambdaNodeJs.NodejsFunction(this, 'ChannelBattleFunction', {
      entry: path.join(__dirname, '../../lambda/src/channel-battle.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(20),
      memorySize: 256,
      role: channelBattleRole,
      environment: {
        ...battleNotices.env,
        APP_INSTANCE_ARN: props.appInstanceArn,
        CHANNEL_BATTLE_CONFIG_TABLE: channelBattleConfigTable.tableName,
        // Turning Battle Mode off ends the duel that is running, and every helper that does so returns
        // early when this is unset. The disable would still report success while the duel it claimed to
        // end carried on.
        BATTLE_STATE_TABLE: battleStateTable.tableName,
        EXPERIMENTS_TABLE: experimentsTableName,
        ALLOWED_ORIGIN: appUrl,
        // Turning Battle Mode off names the duel's waiting markers to the conversation's router, which takes
        // them down as each side's assistant (`battle-marker-clear.ts`): the router is read by name and the
        // invoke granted under `battleNotices`, since this API speaks as no assistant for an ending.
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    // Battle-outcome (pick-the-winner) API — separate least-privilege Lambda:
    // RW on BattleOutcomeTable ONLY (no Chime send, SSM, or experiments).
    const battleOutcomeRole = new iam.Role(this, 'BattleOutcomeRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        BattleOutcomeDdb: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              // UpdateItem: recordBattleOutcome writes the per-user votes map with nested-path
              // UpdateExpressions (`SET votes = if_not_exists(...)` then `SET votes.<sub> = ...`), not a
              // whole-item Put - so the outcome Lambda needs UpdateItem or the pick write AccessDenies (503).
              actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
              resources: [battleOutcomeTable.tableArn],
            }),
            // READ-ONLY on the duel's rows, so a pick can be refused for a duel that was ABANDONED.
            // Without it `readBattleRows` returns [], the `rows.length > 0` guard is never satisfied,
            // and the refusal never fires - a pick on a comparison nobody finished would be recorded
            // and counted, which is the one outcome that rule exists to prevent. Query only: this
            // Lambda reads the duel's state and never writes it.
            new iam.PolicyStatement({
              actions: ['dynamodb:Query'],
              resources: [battleStateTable.tableArn],
            }),
            // READ-ONLY on the experiment row, so a pick records the two versions that fought: the
            // configIds pinned on the experiment's control and treatment (DESIGN-EXPERIMENTS-BATTLE-
            // DECISION-LOOP §3.5). Without it a pick is recorded without them, as before.
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem'],
              resources: [experimentsTableArn],
            }),
          ],
        }),
        BattleOutcomeChime: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['chime:DescribeChannelMembership'],
              resources: [`${props.appInstanceArn}/*`],
            }),
          ],
        }),
        // Read-only on the channel battle config: the outcome handler resolves the pick's
        // experimentId from the channel server-side rather than trusting the client to send it.
        // Without this grant the lookup fails open and every pick records UNATTRIBUTED, which
        // reads downstream as "no battle wins" rather than as an error.
        BattleOutcomeChannelConfig: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem'],
              resources: [channelBattleConfigTable.tableArn],
            }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    const battleOutcomeFn = new lambdaNodeJs.NodejsFunction(this, 'BattleOutcomeFunction', {
      entry: path.join(__dirname, '../../lambda/src/battle-outcome-api.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      role: battleOutcomeRole,
      environment: {
        APP_INSTANCE_ARN: props.appInstanceArn,
        BATTLE_OUTCOME_TABLE: battleOutcomeTable.tableName,
        CHANNEL_BATTLE_CONFIG_TABLE: channelBattleConfigTable.tableName,
        // The experiment row, for the configIds of the two versions a pick judges.
        EXPERIMENTS_TABLE: experimentsTableName,
        // The duel's rows, read to refuse a pick on an ABANDONED battle. Unset, `readBattleRows`
        // returns [] and the refusal is unreachable - the check would look present and do nothing.
        BATTLE_STATE_TABLE: battleStateTable.tableName,
        ALLOWED_ORIGIN: appUrl,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    // Who called is the edge authorizer's context, read through the registry (callerPersonId).
    grantIssuerRegistry(channelBattleFn, props.selfPoolId);
    grantIssuerRegistry(battleOutcomeFn, props.selfPoolId);
    channelBattleFn.addEnvironment('APP_INSTANCE_ARN', props.appInstanceArn);
    battleOutcomeFn.addEnvironment('APP_INSTANCE_ARN', props.appInstanceArn);
    const battleThrottle = { rate: 10, burst: 20 };
    this.routes.push(
      { api: 'person', method: 'GET', path: '/channels/battle', handler: channelBattleFn, capability: 'battle', throttle: battleThrottle },
      { api: 'person', method: 'POST', path: '/channels/battle/enable', handler: channelBattleFn, capability: 'battle', throttle: battleThrottle },
      { api: 'person', method: 'POST', path: '/channels/battle/disable', handler: channelBattleFn, capability: 'battle', throttle: battleThrottle },
      // /channels/battle/outcome: POST a pick, GET the recorded pick.
      { api: 'person', method: 'POST', path: '/channels/battle/outcome', handler: battleOutcomeFn, capability: 'battle', throttle: battleThrottle },
      { api: 'person', method: 'GET', path: '/channels/battle/outcome', handler: battleOutcomeFn, capability: 'battle', throttle: battleThrottle },
    );

    // THE CHANNEL FLOW writes a duel's first INVOKED rows, reads Battle Mode's flag, and reads whether an operator
    // turned battle on for the conversation's classification (ADR-049, `canRunBattle`), the policy half of its
    // `/battle` gate.
    if (props.channelFlowRole) new iam.Policy(this, 'BattleOnTheChannelFlow', {
      roles: [attachableRole(this, 'ChannelFlowRole', props.channelFlowRole)],
      statements: [
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'],
          resources: [battleStateTable.tableArn, channelBattleConfigTable.tableArn],
        }),
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/battle/*/enabled`],
        }),
      ],
    });

    cdk.Tags.of(this).add('Component', 'Battle');
  }
}
