/**
 * THE PROVISIONER: ONE PRINCIPAL BUILDS AND RETIRES EVERY ASSISTANT (ADR-048, amended 2026-10-24).
 *
 * Every assistant's identity (an `AppInstanceBot`) and its Amazon Lex bot are built and removed by one function,
 * `assistant-provisioner-function.ts`, on a session of one role, `RuntimeAssistantProvisionerRole`, tagged with the
 * classification the work is at. That role holds the provisioner's grant (`runtimeAssistantProvisioningAllow`,
 * written as the session's `classification` tag) and is the only role in the app that does: no stack's seed, no
 * console function and no other role holds an identity or Amazon Lex write. Only the function's own role may
 * assume it.
 *
 * IN THE CORE, BESIDE THE APP INSTANCE (`Messaging`): every deployment has assistants, a deployment need not declare
 * `admin`, and every stack that declares assistants (each `Assistants-<classification>`, and `AdminServices` for the
 * admin assistant) deploys after `Messaging`, so the provisioner exists before any seed asks it. Its name is fixed
 * (`ASSISTANT_PROVISIONER_FUNCTION_NAME`), so a caller's grant names it without a reference to this stack.
 *
 * WHO MAY INVOKE IT is granted on the callers' roles, never here: `manage-assistants` (the console's create and
 * retire) and each stack's seed (`DeclaredAssistantsSeed`). No route targets it. WHO ASKED is proven by a claim
 * the caller writes where only it may write (`claimWriteFor`): a seed under its own classification's path, granted
 * in its own stack, and `manage-assistants` under the console's. The function reads and spends the claim, and
 * checks what was asked for against the directory and the registry.
 *
 * ONE AMAZON LEX BOT ROLE AND ONE CONVERSATION LOG GROUP for every assistant's bot, declared or created in the
 * console: the role grants nothing a turn needs (Amazon Lex invokes the fulfillment through the function's own
 * resource policy), and the log group holds one record per Amazon Lex invocation.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import * as path from 'path';
import { permissionsBoundary } from './permissions-boundary';
import { PROVISIONER_CLAIMS } from '../../lambda/src/lib/provisioner-claim';
import {
  SSM_ROOT, STACK_PREFIX, RES_PREFIX, ASSISTANT_OWNERSHIP_FUNCTION_NAME, ASSISTANT_PROVISIONER_FUNCTION_NAME,
  runtimeAssistantProvisioningAllow, SESSION_CLASSIFICATION,
} from '../stacks/agent-classification-common';

/** The provisioner function's ARN in `scope`'s account and region, by its fixed name. */
export function assistantProvisionerArn(scope: Construct): string {
  const { region, account } = cdk.Stack.of(scope);
  return `arn:aws:lambda:${region}:${account}:function:${ASSISTANT_PROVISIONER_FUNCTION_NAME}`;
}

/** The one statement a caller of the provisioner holds: invoking it, by its fixed name. */
export function invokeTheProvisioner(scope: Construct, sid = 'AskTheProvisioner'): iam.PolicyStatement {
  return new iam.PolicyStatement({ sid, actions: ['lambda:InvokeFunction'], resources: [assistantProvisionerArn(scope)] });
}

/**
 * THE ONE CLAIM PATH A CALLER MAY WRITE (`lambda/src/lib/provisioner-claim.ts`): a seed's under its own
 * classification, the console's under `console`. Write and delete only, on that path alone, so a caller that may
 * invoke the provisioner cannot prove itself to be another.
 */
export function claimWriteFor(scope: Construct, caller: { seedOf: string } | 'console', sid = 'ProveWhoAsksTheProvisioner'): iam.PolicyStatement {
  const { region, account } = cdk.Stack.of(scope);
  const path = caller === 'console' ? `${PROVISIONER_CLAIMS}/console` : `${PROVISIONER_CLAIMS}/seed/${caller.seedOf}`;
  return new iam.PolicyStatement({
    sid,
    actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
    resources: [`arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/${path}/*`],
  });
}

export interface AssistantProvisionerProps {
  appInstanceArn: string;
}

/** Stand up the provisioner in `scope` (the `Messaging` stack). */
export function assistantProvisioner(scope: Construct, props: AssistantProvisionerProps): lambda.IFunction {
  const { region, account } = cdk.Stack.of(scope);
  const ssmArn = (p: string) => `arn:aws:ssm:${region}:${account}:parameter${SSM_ROOT}/${p}`;

  // The role Amazon Lex runs every assistant's bot as, and the log group every bot writes.
  const lexBotRole = new iam.Role(scope, 'RuntimeAssistantLexBotRole', {
    assumedBy: new iam.ServicePrincipal('lexv2.amazonaws.com'),
    managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonLexRunBotsOnly')],
  });
  const lexConversationLogs = new logs.LogGroup(scope, 'AssistantLexConversationLogs', {
    retention: logs.RetentionDays.TWO_WEEKS,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  lexConversationLogs.grantWrite(lexBotRole);

  const fnRole = new iam.Role(scope, 'AssistantProvisionerRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    inlinePolicies: {
      TheDirectoryAndTheRecords: new iam.PolicyDocument({
        statements: [
          // THE DIRECTORY: a declared assistant's entry is its seed record, and a console build records its ids on
          // its entry as it goes. Listed by path to find who still fills a role a deploy withdraws.
          new iam.PolicyStatement({
            sid: 'TheDirectory',
            actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
            resources: [ssmArn('assistant-directory/*')],
          }),
          new iam.PolicyStatement({ sid: 'ListTheDirectory', actions: ['ssm:GetParametersByPath'], resources: [ssmArn('assistant-directory')] }),
          // THE ASSIGNMENT RECORDS a declared assistant answers through (its own, or its role's alt record), and the
          // record a removal checks the ids it is asked for against.
          new iam.PolicyStatement({
            sid: 'TheAssignmentRecords',
            actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
            resources: [ssmArn('assistant-assignments/*')],
          }),
          // THE CLAIMS ITS CALLERS WRITE (`lambda/src/lib/provisioner-claim.ts`): read to prove who asked, and deleted
          // once read so a claim answers one request. Never written here: only a claim's own caller may write it.
          new iam.PolicyStatement({
            sid: 'ReadAndSpendTheCallersClaims',
            actions: ['ssm:GetParameter', 'ssm:DeleteParameter'],
            resources: [ssmArn(`${PROVISIONER_CLAIMS}/*`)],
          }),
          // Each classification's router, which fulfills a console-created assistant's Amazon Lex turns. Read only.
          new iam.PolicyStatement({ sid: 'ReadEachClassificationsRouter', actions: ['ssm:GetParameter'], resources: [ssmArn('assistant/*/router-arn')] }),
          // A declared assistant's owner, seeded by the ownership function when the deployment has one (`admin`).
          new iam.PolicyStatement({
            sid: 'AskTheOwnershipFunction',
            actions: ['lambda:InvokeFunction'],
            resources: [`arn:aws:lambda:${region}:${account}:function:${ASSISTANT_OWNERSHIP_FUNCTION_NAME}`],
          }),
        ],
      }),
    },
  });

  // THE SESSION ROLE: assumable by the provisioner function's own role alone, and only with a `classification`
  // session tag, on the assume and on the tagging. A credential is minted on it, so it carries a permissions
  // boundary, its own statements (STACKS.md "Permissions boundaries").
  const sessionPin = { Null: { 'aws:RequestTag/classification': 'false' } };
  const provisionAtTheSession = () => runtimeAssistantProvisioningAllow({
    classifications: SESSION_CLASSIFICATION,
    appInstanceArn: props.appInstanceArn,
    region,
    account,
    lexBotRoleArn: lexBotRole.roleArn,
  });
  const sessionRole = new iam.Role(scope, 'RuntimeAssistantProvisionerRole', {
    assumedBy: new iam.PrincipalWithConditions(new iam.ArnPrincipal(fnRole.roleArn), sessionPin),
    inlinePolicies: { ProvisionAtTheSessionsClassification: new iam.PolicyDocument({ statements: provisionAtTheSession() }) },
    permissionsBoundary: permissionsBoundary(scope, 'RuntimeAssistantProvisionerBoundary',
      'The boundary of the assistant provisioner session: its own statements, at the session classification', provisionAtTheSession()),
  });
  sessionRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    principals: [new iam.ArnPrincipal(fnRole.roleArn)],
    actions: ['sts:TagSession'],
    conditions: sessionPin,
  }));
  // A policy of the role's own, apart from the role, so the role and the session role do not name each other.
  fnRole.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'WorkOnASessionOfTheClassification',
    actions: ['sts:AssumeRole', 'sts:TagSession'],
    resources: [sessionRole.roleArn],
  }));

  return new lambdaNodeJs.NodejsFunction(scope, 'AssistantProvisionerFunction', {
    functionName: ASSISTANT_PROVISIONER_FUNCTION_NAME,
    entry: path.join(__dirname, '../../lambda/src/assistant-provisioner-function.ts'),
    handler: 'handler',
    runtime: lambda.Runtime.NODEJS_20_X,
    role: fnRole,
    // Each Amazon Lex bot takes about a minute to build; a declaration names a few assistants, one after another.
    timeout: cdk.Duration.minutes(13),
    memorySize: 256,
    environment: {
      SSM_ROOT,
      AWS_ACCOUNT_ID: account,
      APP_INSTANCE_ARN: props.appInstanceArn,
      RUNTIME_LEX_BOT_ROLE_ARN: lexBotRole.roleArn,
      RUNTIME_PROVISIONER_ROLE_ARN: sessionRole.roleArn,
      LEX_CONVERSATION_LOG_GROUP_ARN: lexConversationLogs.logGroupArn,
      ROUTER_FUNCTION_PREFIX: STACK_PREFIX,
      LEX_BOT_NAME_PREFIX: RES_PREFIX,
      OWNERSHIP_FUNCTION_NAME: ASSISTANT_OWNERSHIP_FUNCTION_NAME,
    },
    bundling: { minify: false, forceDockerBundling: false },
  });
}
