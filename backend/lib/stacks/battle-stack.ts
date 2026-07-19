/**
 * BattleStack (`AgentEchelonBattle`) — the /battle head-to-head feature, an
 * independently-deployable, **opt-in** stack. A deployer who doesn't want
 * /battle simply doesn't deploy this stack (and sets `-c enableBattle=false`);
 * the classification processors + channel-flow then run with no battle plumbing and fail
 * open.
 *
 * Owns end-to-end:
 *   - Battle tables: `BattleState` (per-bot round state), `ChannelBattleConfig`
 *     (per-channel enable flag), `BattleOutcome` (the user's winner pick).
 *   - A battle-OWNED Lex bot + a silent alt-slot fulfillment handler
 *     (`battle-alt-slot-handler.ts`). The alt-slots run on THIS Lex, which keeps
 *     battle self-contained. Real battle replies come from the channel-flow
 *     processor direct-invoking the premium async-processor; this Lex is only
 *     the alt-slots' formal `InvokedBy` handle.
 *   - The alt-bot slot pool (AppInstanceBots with no static persona; the
 *     model/prompt each serves is read at runtime from the bound experiment
 *     variant) + per-slot + roster SSM.
 *   - The battle orchestrator Lambda (drives round-2 fan-out; invokes the
 *     premium classification processor resolved at runtime from SSM).
 *   - The channel-battle admin API (`/channels/battle` GET/enable/disable) and
 *     the battle-outcome API (`/channels/battle/outcome` GET/POST).
 *   - Publishes the shared SSM contract the per-classification processors/handlers
 *     resolve: `/agent-echelon/shared/tables/{battle-state-arn,battle-state-name,
 *     channel-battle-config-name}` + `/agent-echelon/shared/battle-orchestrator-arn`.
 *
 * Reads (does not own) the experiments table via the shared SSM contract that
 * AgentEchelonExperiments publishes, so this stack deploys AFTER the experiments
 * owner and BEFORE the per-classification stacks (which consume the battle SSM this stack
 * publishes). The dependency graph is acyclic — the alt-slots' own-Lex is what
 * avoids a battle↔premium deploy cycle.
 *
 * **Classification-configurable, premium by default.** A profile's `battleEligible`
 * flag (default true only for premium) is what channel-battle.ts checks, so /battle
 * can be opened to other classifications by config without code changes.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';
import { apiAccessLogConfig } from '../constructs/api-access-logging';
import { SHARED_SSM, SSM_ROOT, STACK_PREFIX, INSTANCE_SSM, processorArnKey } from './agent-classification-common';

export interface BattleStackProps extends cdk.StackProps {
  /** Shared Chime AppInstance ARN (from AgentEchelonChimeMessaging). */
  appInstanceArn: string;
  /** User Pool ID for the channel-battle + battle-outcome API authorizer. */
  userPoolId: string;
  /** Frontend URL for CORS (defaults to the `appUrl` context / localhost). */
  appUrl?: string;
}

export class BattleStack extends cdk.Stack {
  /** Battle table name/ARN — passed to ChannelFlow for INVOKED row writes + config reads. */
  public readonly battleStateTableName: string;
  public readonly battleStateTableArn: string;
  public readonly channelBattleConfigTableName: string;
  public readonly channelBattleConfigTableArn: string;
  public readonly battleOrchestratorFunctionArn: string;

  constructor(scope: Construct, id: string, props: BattleStackProps) {
    super(scope, id, props);

    const isProduction = this.node.tryGetContext('environment') === 'production';
    const dataRemovalPolicy = isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const appUrl = this.node.tryGetContext('appUrl') || props.appUrl || 'http://localhost:5173';

    // Experiments table lives in the always-deployed experiments owner
    // (AgentEchelonExperiments). Resolve it via the shared SSM contract at deploy
    // time (dynamic ref, NOT Fn::importValue), so this stack deploys decoupled
    // from the experiments owner.
    const experimentsTableArn = ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.experimentsArn);
    const experimentsTableName = ssm.StringParameter.valueForStringParameter(this, SHARED_SSM.experimentsName);

    // ============================================================
    // DynamoDB Tables for /battle (SPEC-BATTLE.md)
    // ============================================================
    //
    // BattleStateTable: per-bot state-machine rows for in-flight battles.
    // PK battleId (sha256(channelArn + ':' + userMessageId)[:16]) groups rows by
    // battle invocation. SK botArn distinguishes the per-bot row. TTL 10 min
    // ages out stale rows from crashed invocations.
    const battleStateTable = new dynamodb.Table(this, 'BattleStateTable', {
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
      partitionKey: { name: 'channelArn', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // BattleOutcomeTable: the user's explicit head-to-head pick per battle
    // (SPEC-BATTLE.md §"Battle Scoring & Per-Step Telemetry", decision 3). PK
    // battleId, one row, last-write-wins. No TTL — the pick is the durable
    // scorecard record. Descriptive only; never read back into variant selection.
    const battleOutcomeTable = new dynamodb.Table(this, 'BattleOutcomeTable', {
      partitionKey: { name: 'battleId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemovalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.battleStateTableName = battleStateTable.tableName;
    this.battleStateTableArn = battleStateTable.tableArn;
    this.channelBattleConfigTableName = channelBattleConfigTable.tableName;
    this.channelBattleConfigTableArn = channelBattleConfigTable.tableArn;

    // ============================================================
    // Battle-owned Lex bot + silent alt-slot fulfillment handler
    // ============================================================
    //
    // The alt-slots need a valid Lex `InvokedBy`. We mint a battle-owned Lex
    // (NOT a per-classification one) so battle stays self-contained and we avoid a
    // battle↔premium deploy cycle (premium consumes battle SSM at deploy; if
    // battle consumed premium's Lex at deploy, neither could go first). The
    // handler is intentionally silent — battle replies are driven by
    // channel-flow → premium async-processor.
    const altSlotHandler = new lambdaNodeJs.NodejsFunction(this, 'AltSlotHandler', {
      entry: path.join(__dirname, '../../lambda/src/battle-alt-slot-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      bundling: { minify: false, forceDockerBundling: false },
    });
    new lambda.CfnPermission(this, 'AltSlotHandlerLexInvoke', {
      action: 'lambda:InvokeFunction',
      functionName: altSlotHandler.functionName,
      principal: 'lexv2.amazonaws.com',
    });
    const altSlotHandlerArn = altSlotHandler.functionArn;

    const lexBotRole = new iam.Role(this, 'LexBotRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lexv2.amazonaws.com'),
        new iam.ServicePrincipal('chime.amazonaws.com'),
      ),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonLexRunBotsOnly')],
      inlinePolicies: {
        LambdaInvokePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [altSlotHandlerArn] }),
          ],
        }),
      },
    });

    const createLexBotRole = new iam.Role(this, 'CreateLexBotRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        LexBotPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'lex:CreateBot', 'lex:CreateBotLocale', 'lex:CreateIntent', 'lex:CreateSlotType',
                'lex:BuildBotLocale', 'lex:CreateBotVersion', 'lex:CreateBotAlias',
                'lex:DescribeBotLocale', 'lex:DeleteBot', 'lex:ListBots', 'lex:ListBotAliases',
                'lex:ListIntents', 'lex:ListBotLocales', 'lex:UpdateIntent', 'lex:UpdateBotAlias',
                'lex:CreateResourcePolicy', 'lex:UpdateResourcePolicy',
              ],
              resources: [`arn:aws:lex:${this.region}:${this.account}:*`],
            }),
            new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [lexBotRole.roleArn] }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    const createLexBotFn = new lambdaNodeJs.NodejsFunction(this, 'CreateLexBotFunction', {
      entry: path.join(__dirname, '../../lambda/lex-bot/create-lex-bot.ts'),
      environment: {
        LEX_BOT_ROLE_ARN: lexBotRole.roleArn,
        AWS_ACCOUNT_ID: this.account,
        BOT_HANDLER_LAMBDA_ARN: altSlotHandlerArn,
        APP_INSTANCE_ARN: props.appInstanceArn,
      },
      handler: 'handler',
      role: createLexBotRole,
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(10),
      bundling: { minify: false, forceDockerBundling: false },
    });

    const lexProvider = new cdk.custom_resources.Provider(this, 'CreateLexBotProvider', {
      onEventHandler: createLexBotFn,
    });
    const lexResource = new cdk.CustomResource(this, 'CreateLexBotResource', {
      serviceToken: lexProvider.serviceToken,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      properties: { botName: 'AltSlotBattle' },
    });
    const lexBotAliasArn = lexResource.getAtt('LexBotAliasArn').toString();

    // ============================================================
    // Alt-Bot Slot Pool (SPEC-BATTLE.md)
    // ============================================================
    //
    // Pre-provisioned pool of additional AppInstanceBots. Each slot has no
    // static persona — the model + system-prompt addendum it serves is read at
    // runtime from the bound experiment variant. v0.2.0 ships ALT_BOT_SLOT_COUNT
    // = 2; raise via CDK context. Bots accumulate (RETAIN) — don't shrink
    // without manual cleanup.
    const createBotRole = new iam.Role(this, 'CreateBotRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        CreateBotPolicy: new iam.PolicyDocument({
          statements: [
            // Create for new slots; Update so a redeploy can re-apply config (e.g. drop
            // WelcomeIntent) to the existing RETAINed alt-slot bots via UpdateAppInstanceBot.
            new iam.PolicyStatement({ actions: ['chime:CreateAppInstanceBot', 'chime:UpdateAppInstanceBot'], resources: [props.appInstanceArn, `${props.appInstanceArn}/bot/*`] }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    const altBotSlotCountContext = this.node.tryGetContext('altBotSlotCount');
    const altBotSlotCount = Number.isFinite(Number(altBotSlotCountContext))
      ? Number(altBotSlotCountContext)
      : 2;

    const altBotSlotArns: string[] = [];
    for (let i = 0; i < altBotSlotCount; i++) {
      const slotId = `slot-${i}`;
      const slotBotName = `AltSlot${i}`;
      const slotHandler = new lambdaNodeJs.NodejsFunction(this, `CreateAltBotFunction${i}`, {
        entry: path.join(__dirname, '../../lambda/lex-bot/create-bot.ts'),
        environment: {
          APP_INSTANCE_ARN: props.appInstanceArn,
          BOT_HANDLER_LAMBDA_ARN: altSlotHandlerArn,
          LEX_BOT_ALIAS_ARN: lexBotAliasArn,
          BOT_NAME: slotBotName,
          // Alt-slots must stay SILENT on join: omit the Chime Lex WelcomeIntent so Chime
          // does not invoke the (message-less) alt-slot fulfillment on channel-add, which
          // posted `{"Code":500}`. Real battle replies come from the channel-flow →
          // premium async-processor, not this Lex. (Default bots leave this unset.)
          WELCOME_INTENT: '',
        },
        handler: 'handler',
        role: createBotRole,
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        bundling: { minify: false, forceDockerBundling: false },
      });

      const slotProvider = new cdk.custom_resources.Provider(this, `CreateAltBotProvider${i}`, {
        onEventHandler: slotHandler,
      });
      const slotResource = new cdk.CustomResource(this, `CreateAltBotResource${i}`, {
        serviceToken: slotProvider.serviceToken,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        // Bump to trigger a CustomResource Update so the config change (omitting the
        // WelcomeIntent that 500'd on join) is re-applied to the existing RETAINed bot
        // via UpdateAppInstanceBot — a Create-only resource would otherwise skip it.
        properties: { configVersion: 'v3-altslot-no-welcome-intent' },
      });
      // Slots depend on the battle Lex existing first.
      slotResource.node.addDependency(lexResource);

      const slotArn = slotResource.getAtt('AppInstanceBotArn').toString();
      altBotSlotArns.push(slotArn);

      new ssm.StringParameter(this, `AltBotSlot${i}Parameter`, {
        parameterName: INSTANCE_SSM.altBotSlotBotArn(slotId),
        stringValue: slotArn,
        description: `AppInstanceBot ARN for alt-bot slot ${slotId} (battle feature)`,
      });
    }

    // Roster JSON for one-call lookup: [{ slotId: "slot-0", botArn: "arn:..." }, ...]
    // Built lazily so the CFN tokens resolve at deploy time.
    const rosterValue = cdk.Fn.join('', [
      '[',
      ...altBotSlotArns.flatMap((arn, idx) => {
        const entry = cdk.Fn.join('', [`{"slotId":"slot-${idx}","botArn":"`, arn, '"}']);
        return idx === 0 ? [entry] : [',', entry];
      }),
      ']',
    ]);
    new ssm.StringParameter(this, 'AltBotSlotRosterParameter', {
      parameterName: INSTANCE_SSM.altBotSlotsRoster,
      stringValue: rosterValue,
      description: 'JSON roster of alt-bot slots: [{slotId, botArn}, ...]',
    });

    // ============================================================
    // Battle Orchestrator Lambda (SPEC-BATTLE.md)
    // ============================================================
    //
    // Coordinates round-2 fan-out after both bots reach round-1 terminal state.
    // Invoked async from the premium async processor on the last transition.
    // Sends per-bot round-2 placeholders, invokes the premium classification processor
    // (AgentEchelonClassification-Premium) — resolved at RUNTIME from SSM (param NAME passed in
    // env) so there is no deploy-time ordering cycle with the premium stack.
    const battleOrchestratorRole = new iam.Role(this, 'BattleOrchestratorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['chime:SendChannelMessage'],
              resources: [`${props.appInstanceArn}/*`],
            }),
          ],
        }),
        BattleStatePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
              resources: [battleStateTable.tableArn],
            }),
          ],
        }),
        LambdaInvokePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              // Invokes the premium classification processor (AgentEchelonClassification-Premium) for round-2.
              resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${STACK_PREFIX}Classification-*`],
            }),
          ],
        }),
        SSMPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['ssm:GetParameter'],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${processorArnKey('premium')}`],
            }),
          ],
        }),
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    // Deterministic name so the ARN can be published to SSM as a constructed
    // string (the classification processors resolve it via /agent-echelon/shared/
    // battle-orchestrator-arn). The orchestrator itself invokes the premium classification
    // processor via an SSM dynamic ref, so there is no GetAtt cycle to break.
    const battleOrchestratorName = `${this.stackName}-BattleOrchestrator`;
    const battleOrchestratorArn = `arn:aws:lambda:${this.region}:${this.account}:function:${battleOrchestratorName}`;

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
        PREMIUM_PROCESSOR_ARN_PARAM: processorArnKey('premium'),
      },
      bundling: { minify: false, forceDockerBundling: false },
    });
    this.battleOrchestratorFunctionArn = battleOrchestrator.functionArn;

    // ============================================================
    // Shared SSM contract for the per-classification stacks (SPEC-PER-TIER-OWNERSHIP.md).
    // AgentEchelonClassification-{Standard,Premium} resolve these at DEPLOY time via
    // valueForStringParameter (dynamic ref, NOT Fn::importValue) — but ONLY when
    // their own `enableBattle` is set, so a classification can deploy with battle off.
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
    // Channel Battle Admin API + Battle-Outcome API
    // ============================================================
    const importedUserPool = cognito.UserPool.fromUserPoolId(this, 'ImportedUserPool', props.userPoolId);

    const channelBattleRole = new iam.Role(this, 'ChannelBattleRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ChimePolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'chime:CreateChannelMembership',
                'chime:DeleteChannelMembership',
                // DescribeChannel: caller-scoped access check (is the caller a member).
                // ListTagsForResource: the classification gate reads the IMMUTABLE `classification`
                // tag, not mutable metadata, so a tampered modelTier cannot open battles.
                'chime:DescribeChannel',
                'chime:ListTagsForResource',
                'chime:DescribeChannelMembership',
                'chime:ListChannelModerators',
                'chime:SendChannelMessage',
              ],
              resources: [`${props.appInstanceArn}/*`],
            }),
          ],
        }),
        BattleConfigDdb: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
              resources: [channelBattleConfigTable.tableArn],
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
                // The per-classification bot keys channel-battle.ts resolves (resolveBotArn).
                // Every classification owns its own bot; there is no shared /agent-echelon/bot-arn.
                `arn:aws:ssm:${this.region}:${this.account}:parameter${SSM_ROOT}/assistant/*/bot-arn`,
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
        SSM_ROOT,
        APP_INSTANCE_ARN: props.appInstanceArn,
        CHANNEL_BATTLE_CONFIG_TABLE: channelBattleConfigTable.tableName,
        EXPERIMENTS_TABLE: experimentsTableName,
        ALLOWED_ORIGIN: appUrl,
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
              actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
              resources: [battleOutcomeTable.tableArn],
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
        ALLOWED_ORIGIN: appUrl,
      },
      bundling: { minify: false, forceDockerBundling: false },
    });

    const channelBattleAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'ChannelBattleAuthorizer', {
      cognitoUserPools: [importedUserPool],
    });

    const channelBattleApi = new apigateway.RestApi(this, 'ChannelBattleApi', {
      restApiName: 'Agent Echelon Channel Battle',
      defaultCorsPreflightOptions: {
        allowOrigins: [appUrl],
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10,
        ...apiAccessLogConfig(this, 'ChannelBattleApiAccessLogs'),
      },
    });

    const channelBattleIntegration = new apigateway.LambdaIntegration(channelBattleFn);
    const channelsResource = channelBattleApi.root.addResource('channels');
    const battleResource = channelsResource.addResource('battle');
    battleResource.addMethod('GET', channelBattleIntegration, {
      authorizer: channelBattleAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    battleResource.addResource('enable').addMethod('POST', channelBattleIntegration, {
      authorizer: channelBattleAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    battleResource.addResource('disable').addMethod('POST', channelBattleIntegration, {
      authorizer: channelBattleAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    // /channels/battle/outcome — POST a pick, GET the recorded pick.
    const battleOutcomeIntegration = new apigateway.LambdaIntegration(battleOutcomeFn);
    const outcomeResource = battleResource.addResource('outcome');
    outcomeResource.addMethod('POST', battleOutcomeIntegration, {
      authorizer: channelBattleAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });
    outcomeResource.addMethod('GET', battleOutcomeIntegration, {
      authorizer: channelBattleAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    });

    new cdk.CfnOutput(this, 'ChannelBattleApiUrl', {
      value: `${channelBattleApi.url}channels/battle`,
      description: 'Channel battle admin API URL (frontend reads this for Battle Mode toggle)',
      exportName: `${this.stackName}-ChannelBattleApiUrl`,
    });
    new cdk.CfnOutput(this, 'BattleOutcomeApiUrl', {
      value: `${channelBattleApi.url}channels/battle/outcome`,
      description: 'Battle outcome (pick-the-winner) API URL (frontend scorecard reads/writes this)',
      exportName: `${this.stackName}-BattleOutcomeApiUrl`,
    });

    cdk.Tags.of(this).add('Component', 'Battle');
  }
}
