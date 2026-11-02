/**
 * A CLASSIFICATION'S TWO FUNCTIONS IN THE ARCHIVE'S VPC (Aurora mode), built by its own
 * `Assistants-<classification>` stack, so declaring a classification adds them with its own stack and changes
 * no other (the classification-independence plan, step 4):
 *
 *   - its TURN DATA PLANE: the retrieval and drift data plane's code on its own role, pinned to the
 *     classification (`DATA_PLANE_CLASSIFICATION`), serving a turn only when its routing record is in the
 *     classification's table and names the same conversation. Its router is granted the invoke on it alone, so
 *     IAM rather than a payload field decides which classification a call runs at (tenet D12, ADR-054);
 *   - its CLASSIFIER REPLAY: the classification shadow gate's batch job (DESIGN-EXPERIMENTS-BATTLE §5.2), on a
 *     role that invokes only the classification's models and pinned to it (`REPLAY_CLASSIFICATION`). The
 *     admin backend's starter finds it by the key published here and invokes it by name pattern;
 *   - its GOLDEN RUN: a draft version answering the classification's golden set before it is activated (ADR-065), on a
 *     role that invokes only the classification's models and guardrails, reads the assistants' version bodies and
 *     nothing that speaks, pinned to it (`GOLDEN_RUN_CLASSIFICATION`). `manage-profiles` finds it the same way.
 *
 * WHAT THE ARCHIVE PUBLISHES FOR THEM, read at deploy: the data plane's subnets and security group (which has
 * the database ingress rule), the database host, and the cluster's (and the proxy's, where one runs) IAM-auth
 * resource id. No reference to the archive stack, which deploys first; the IAM-auth users exist by then.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaDestinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';
import { Construct } from 'constructs';
import {
  SHARED_SSM, SSM_ROOT, STACK_PREFIX, INSTANCE_NAME, modelArnsForClassification, turnRoutingTableName, type Classification,
} from '../stacks/agent-classification-common';
import { dbLambdaCommandHooks } from '../stacks/archive-stack-aurora';
import { getModelCatalog, utilityModelArns } from '../config/model-strategy';
import { INSTANCE_TAG } from '../tagging';

/** The SSM key a classification's classifier replay ARN is published under, beside its router's. */
export function classifierReplayArnKey(classification: string): string {
  return `${SSM_ROOT}/assistant/${classification}/classifier-replay-arn`;
}
/** The SSM root the replay starter reads a classification's replay function under (`CLASSIFIER_REPLAY_PARAM_ROOT`). */
export const CLASSIFIER_REPLAY_PARAM_ROOT = `${SSM_ROOT}/assistant`;

const fixedName = (classification: string, what: string): string => {
  const name = `${STACK_PREFIX}Assistants-${classification}-${what}`;
  if (name.length > 64) throw new Error(`"${name}" is longer than Lambda's 64 characters`);
  return name;
};
/** A classification's turn data plane's fixed function name. */
export const turnDataPlaneName = (classification: string): string => fixedName(classification, 'TurnDataPlane');
/** A classification's classifier replay's fixed function name. */
export const classifierReplayName = (classification: string): string => fixedName(classification, 'ClassifierReplay');
/** A classification's golden run's fixed function name. */
export const goldenRunName = (classification: string): string => fixedName(classification, 'GoldenRun');
/** The SSM key a classification's golden run ARN is published under, beside its replay's. */
export function goldenRunArnKey(classification: string): string {
  return `${SSM_ROOT}/assistant/${classification}/golden-run-arn`;
}

/**
 * START OR READ A CLASSIFICATION'S GOLDEN RUN, found by name at call time (ADR-065): `manage-profiles` reaches every
 * classification's, with no list, exactly as the replay starter reaches the replays.
 */
export function goldenRunInvoke(stack: cdk.Stack): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: 'StartOrReadAClassificationsGoldenRun',
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${STACK_PREFIX}Assistants-*-GoldenRun`],
      conditions: {
        StringEquals: { [`aws:ResourceTag/${INSTANCE_TAG}`]: INSTANCE_NAME },
        Null: { 'aws:ResourceTag/classification': 'false' },
      },
    }),
    new iam.PolicyStatement({
      sid: 'FindAClassificationsGoldenRunByName',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter${goldenRunArnKey('*')}`],
    }),
  ];
}

/**
 * INVOKE A CLASSIFICATION'S REPLAY, FOUND BY NAME AT CALL TIME: read its key, and invoke a function of the
 * replays' name pattern carrying this instance's `Instance` tag and a `classification` tag. The admin plane's
 * starter reaches every classification's, with no list.
 */
export function classifierReplayInvoke(stack: cdk.Stack): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: 'StartAClassificationsReplay',
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${STACK_PREFIX}Assistants-*-ClassifierReplay`],
      conditions: {
        StringEquals: { [`aws:ResourceTag/${INSTANCE_TAG}`]: INSTANCE_NAME },
        Null: { 'aws:ResourceTag/classification': 'false' },
      },
    }),
    new iam.PolicyStatement({
      sid: 'FindAClassificationsReplayByName',
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${stack.region}:${stack.account}:parameter${classifierReplayArnKey('*')}`],
    }),
  ];
}

export interface ClassificationArchiveFunctionsProps {
  classification: string;
  /** Whether the archive connects through its optional RDS Proxy (`enableRdsProxy`). */
  rdsProxy: boolean;
  /**
   * The classification's guardrails and the bucket its version bodies live in, which its golden run reads (ADR-065).
   * Absent, no golden run is built.
   */
  goldenRun?: {
    defaultGuardrailId: string;
    defaultGuardrailVersion: string;
    guardrailArns: string[];
    bodyBucketName: string;
    bodyBucketArn: string;
  };
}

export class ClassificationArchiveFunctions extends Construct {
  public readonly turnDataPlane: lambda.IFunction;
  public readonly classifierReplay: lambda.IFunction;
  public readonly goldenRun?: lambda.IFunction;

  constructor(scope: Construct, id: string, props: ClassificationArchiveFunctionsProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const { classification: c } = props;
    const read = (name: string) => ssm.StringParameter.valueForStringParameter(this, name);
    const subnetIds = cdk.Fn.split(',', read(SHARED_SSM.auroraDataPlaneSubnetIds));
    const securityGroupId = read(SHARED_SSM.auroraDataPlaneSecurityGroupId);
    const dbuser = (resourceId: string) => `arn:aws:rds-db:${stack.region}:${stack.account}:dbuser:${resourceId}/*`;
    // The IAM-auth users it connects as: the cluster's, and the proxy's where the archive runs one.
    const connect = new iam.PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [
        dbuser(read(SHARED_SSM.auroraDbClusterResourceId)),
        ...(props.rdsProxy ? [dbuser(read(SHARED_SSM.auroraDbProxyResourceId))] : []),
      ],
    });
    // The archive's connection settings, as every function that talks to the database is given them.
    const dbEnvironment = {
      DB_HOST: read(SHARED_SSM.auroraDbHost),
      DB_PORT: '5432',
      DB_NAME: 'evaluation',
      DB_USER: 'evaladmin',
      DB_APP_USER: 'ae_app',
      DB_REGION: stack.region,
      USE_IAM_AUTH: 'true',
    };
    const bundling: lambdaNodeJs.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
      minify: true,
      sourceMap: true,
      commandHooks: dbLambdaCommandHooks(),
    };
    // In the archive's VPC by its published subnets and security group, which carries the database ingress.
    const inTheArchivesVpc = (fn: lambda.Function) => {
      (fn.node.defaultChild as lambda.CfnFunction).vpcConfig = { subnetIds, securityGroupIds: [securityGroupId] };
    };
    const vpcRole = (roleId: string, statements: iam.PolicyStatement[]) => new iam.Role(this, roleId, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],
      inlinePolicies: { RdsIamAuth: new iam.PolicyDocument({ statements: [connect] }), Models: new iam.PolicyDocument({ statements }) },
    });

    // ── THE TURN DATA PLANE ──────────────────────────────────────────────────────────────────────
    const turnRole = vpcRole('TurnDataPlaneRole', [
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        // Titan embed for the drift and retrieval vectors; the utility models and Haiku for the first-turn
        // summary seed, the same reach the shared data plane holds.
        resources: [
          'arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2*',
          ...utilityModelArns(stack.region, stack.account),
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-haiku-*',
        ],
      }),
    ]);
    // A turn data plane reads its own classification's routing table and no other, so the routing-record
    // check is IAM's as well as the function's.
    turnRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ReadTheTurnsRoutingRecord',
      actions: ['dynamodb:GetItem'],
      resources: [`arn:aws:dynamodb:${stack.region}:${stack.account}:table/${turnRoutingTableName(c)}`],
    }));
    const turnDataPlane = new lambdaNodeJs.NodejsFunction(this, 'TurnDataPlane', {
      functionName: turnDataPlaneName(c),
      entry: path.join(__dirname, '../../lambda/src/analytics-aurora/data-plane-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 1024,
      role: turnRole,
      environment: {
        ...dbEnvironment,
        DRIFT_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
        DATA_PLANE_CLASSIFICATION: c,
        TURN_ROUTING_TABLE: turnRoutingTableName(c),
      },
      bundling,
    });
    inTheArchivesVpc(turnDataPlane);
    this.turnDataPlane = turnDataPlane;

    // ── THE CLASSIFIER REPLAY ────────────────────────────────────────────────────────────────────
    // A replay reads one classification's exchanges and invokes two of its models, so its role invokes only
    // that classification's models, derived from the catalog like every other grant of them.
    const replayRole = vpcRole('ClassifierReplayRole', [
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: Array.from(new Set(modelArnsForClassification(c as Classification, getModelCatalog(stack.region, stack.account)))),
      }),
    ]);
    const classifierReplay = new lambdaNodeJs.NodejsFunction(this, 'ClassifierReplay', {
      functionName: classifierReplayName(c),
      entry: path.join(__dirname, '../../lambda/src/analytics-aurora/classifier-replay-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // A batch job, invoked as an Event. The cap is a backstop against a runaway window, not a budget.
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      role: replayRole,
      // AWS_ACCOUNT_ID IS REQUIRED: the replay builds the model catalog from it, and an empty account yields
      // inference-profile ARNs Converse rejects, which falls back to the keyword classifier silently.
      environment: { ...dbEnvironment, AWS_ACCOUNT_ID: stack.account, REPLAY_CLASSIFICATION: c },
      bundling,
    });
    inTheArchivesVpc(classifierReplay);
    this.classifierReplay = classifierReplay;
    new ssm.StringParameter(this, 'ClassifierReplayArn', {
      parameterName: classifierReplayArnKey(c),
      stringValue: classifierReplay.functionArn,
      description: `The ${c} classification's classifier replay, which the admin replay starter finds by name`,
    });

    // ── THE GOLDEN RUN (ADR-065) ─────────────────────────────────────────────────────────────────
    // A draft answers the set beside the active version, posting nothing. Its role invokes the classification's models
    // (and the utility model the relevance judge runs on), applies the classification's provisioned guardrails, and reads
    // version bodies under `profiles/`. No Amazon Chime SDK action, no vend, no routing table: it is not a speaker.
    if (props.goldenRun) {
      const g = props.goldenRun;
      const goldenRole = vpcRole('GoldenRunRole', [
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: Array.from(new Set([
            ...modelArnsForClassification(c as Classification, getModelCatalog(stack.region, stack.account)),
            ...utilityModelArns(stack.region, stack.account),
          ])),
        }),
        new iam.PolicyStatement({ actions: ['bedrock:ApplyGuardrail'], resources: g.guardrailArns }),
        // The clean copy's detector, which de-identifies an uploaded entry before it is written (ADR-065 decision 7).
        new iam.PolicyStatement({ actions: ['bedrock:ApplyGuardrail'], resources: [read(SHARED_SSM.deidentifyGuardrailArn)] }),
        new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`${g.bodyBucketArn}/profiles/*`] }),
        // An upload's checked entries, handed over by `manage-profiles` under this classification's prefix, read once and
        // removed with the version written, so the text is not kept as a noncurrent version (ADR-065 decision 7).
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:DeleteObject', 's3:DeleteObjectVersion'],
          resources: [`${g.bodyBucketArn}/golden-uploads/${c}/*`],
        }),
      ]);
      const goldenRun = new lambdaNodeJs.NodejsFunction(this, 'GoldenRun', {
        functionName: goldenRunName(c),
        entry: path.join(__dirname, '../../lambda/src/analytics-aurora/golden-run-handler.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        // A batch job, invoked as an Event; the gate read is RequestResponse and returns in one query.
        timeout: cdk.Duration.minutes(15),
        memorySize: 1024,
        role: goldenRole,
        environment: {
          ...dbEnvironment,
          AWS_ACCOUNT_ID: stack.account,
          GOLDEN_RUN_CLASSIFICATION: c,
          GUARDRAIL_ID: g.defaultGuardrailId,
          GUARDRAIL_VERSION: g.defaultGuardrailVersion,
          PROFILE_BODY_BUCKET: g.bodyBucketName,
          DEIDENTIFY_GUARDRAIL_ID: read(SHARED_SSM.deidentifyGuardrailId),
          DEIDENTIFY_GUARDRAIL_VERSION: read(SHARED_SSM.deidentifyGuardrailVersion),
        },
        bundling,
      });
      inTheArchivesVpc(goldenRun);
      // One attempt: a retried run would answer the whole set again under the same id. How each Event ended goes to the
      // default EventBridge bus, which tells the console (`consoleEvents` in `admin-services-stack.ts`): the Lambda service
      // delivers it, so the VPC needs no route to EventBridge.
      goldenRun.configureAsyncInvoke({
        retryAttempts: 0,
        onSuccess: new lambdaDestinations.EventBridgeDestination(),
        onFailure: new lambdaDestinations.EventBridgeDestination(),
      });
      this.goldenRun = goldenRun;
      new ssm.StringParameter(this, 'GoldenRunArn', {
        parameterName: goldenRunArnKey(c),
        stringValue: goldenRun.functionArn,
        description: `The ${c} classification's golden run, which manage-profiles finds by name`,
      });
    }
  }
}
