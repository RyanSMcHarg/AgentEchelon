/**
 * ONE WAY A TEST SYNTHESIZES THE STACKS IT READS.
 *
 * A test that asserts on Identity, Conversations or a classification builds the same chain the same
 * way: an Amazon Chime SDK app instance, the identity stack on it, and Conversations on both. Each builder
 * here is memoized per context within a test file, so a file that reads one template in several tests
 * synthesizes it once, and every file builds the stacks with the same props.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { MessagingStack } from '../../lib/stacks/messaging-stack';
import { IdentityStack } from '../../lib/stacks/identity-stack';
import { ConversationsStack } from '../../lib/stacks/conversations-stack';
import { ArchiveStack } from '../../lib/stacks/archive-stack';
import { ExperimentsStack } from '../../lib/stacks/experiments-stack';
import { AdminServicesStack } from '../../lib/stacks/admin-services-stack';
import { AdminApiStack } from '../../lib/stacks/admin-api-stack';
import { assistantsOf } from './assistants';

export const TEST_ENV = { account: '123456789012', region: 'us-east-1' };
export const TEST_APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';

/** The props every classification stack is built with in a test. */
export const CLASSIFICATION_TEST_PROPS = {
  env: TEST_ENV,
  appInstanceArn: TEST_APP_INSTANCE_ARN,
  attachmentsBucketName: 'test-bucket',
  attachmentsBucketArn: 'arn:aws:s3:::test-bucket',
  // The credential exchange's role, which the classification's vend role trusts (bin passes Identity's).
  credentialExchangeRoleArn: 'arn:aws:iam::123456789012:role/test-credential-exchange',
};

type Context = Record<string, unknown>;

function memo<T>(build: (context: Context) => T): (context?: Context) => T {
  const cache = new Map<string, T>();
  return (context: Context = {}) => {
    const key = JSON.stringify(context);
    if (!cache.has(key)) cache.set(key, build(context));
    return cache.get(key)!;
  };
}

/** The Amazon Chime SDK app instance and Identity on it, in one app. */
export const identityStacks = memo((context) => {
  const app = new cdk.App({ context });
  const messaging = new MessagingStack(app, 'Messaging', { env: TEST_ENV, appInstanceName: 'test' });
  const identity = new IdentityStack(app, 'Identity', { env: TEST_ENV, appInstanceArn: messaging.appInstanceArn });
  return { app, messaging, identity };
});

/** The Identity template. */
export const identityTemplate = memo((context) => Template.fromStack(identityStacks(context).identity));

/** Conversations on its own app instance and Identity. */
export const conversationsStacks = memo((context) => {
  const app = new cdk.App({ context });
  const messaging = new MessagingStack(app, 'Messaging', { env: TEST_ENV, appInstanceName: 'test' });
  const identity = new IdentityStack(app, 'Identity', { env: TEST_ENV, appInstanceArn: messaging.appInstanceArn });
  const conversations = new ConversationsStack(app, 'Conversations', {
    env: TEST_ENV,
    appInstanceArn: messaging.appInstanceArn,
    selfPoolId: 'us-east-1_TestPool',
    offboardingRoleArn: identity.offboardingRoleArn,
    credentialExchangeRoleArn: identity.credentialExchangeRoleArn,
  });
  return { app, messaging, identity, conversations };
});

/** The Conversations template. */
export const conversationsTemplate = memo((context) => Template.fromStack(conversationsStacks(context).conversations));

/**
 * The admin backend on the core it sits on: Messaging, Identity, Conversations, the Athena archive, and
 * (unless `noExperiments` is set in the context) the Experiments stack whose admin routes join it. No
 * Lambda is bundled: these tests read the templates, not the code.
 */
export const adminServicesStacks = memo((context) => {
  const { noExperiments, ...rest } = context as { noExperiments?: boolean };
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], ...rest } });
  const messaging = new MessagingStack(app, 'Messaging', { env: TEST_ENV, appInstanceName: 'test' });
  const identity = new IdentityStack(app, 'Identity', { env: TEST_ENV, appInstanceArn: messaging.appInstanceArn, adminConsoleClient: true });
  const conversations = new ConversationsStack(app, 'Conversations', {
    env: TEST_ENV,
    appInstanceArn: messaging.appInstanceArn,
    selfPoolId: identity.selfPoolId,
    offboardingRoleArn: identity.offboardingRoleArn,
  });
  const archive = new ArchiveStack(app, 'Archive', {
    env: TEST_ENV, appInstanceArn: messaging.appInstanceArn, messageStream: messaging.messageStream, userPool: identity.userPool,
  });
  const experiments = noExperiments ? undefined : new ExperimentsStack(app, 'Experiments', { env: TEST_ENV });
  const adminServices = new AdminServicesStack(app, 'AdminServices', {
    env: TEST_ENV,
    appInstanceArn: messaging.appInstanceArn,
    appInstanceAdminArn: messaging.appInstanceAdminArn,
    userPool: identity.userPool,
    selfPoolId: identity.selfPoolId,
    conversationManagementFunction: conversations.conversationManagementFunction,
    identitiesTable: identity.identitiesTable,
    accessLogTable: identity.accessLogTable,
    offboardingFunction: identity.offboardingFunction,
    
    attachmentsBucketArn: conversations.attachmentsBucket.bucketArn,
    feedbackTable: { tableName: conversations.feedbackTable.tableName, tableArn: conversations.feedbackTable.tableArn },
    archiveBucketArn: archive.archiveBucketArn,
    experimentsTable: experiments?.experimentsTable,
    battle: false,
  });
  const adminApi = new AdminApiStack(app, 'AdminApi', {
    env: TEST_ENV,
    routes: adminServices.routes,
    consoleRoles: adminServices.consoleRoles,
    appInstanceArn: messaging.appInstanceArn,
    selfPoolId: identity.selfPoolId,
    selfClientIds: identity.selfClientIds,
    identities: identity.identitiesTable,
  });
  return { app, messaging, identity, conversations, archive, experiments, adminServices, adminApi };
});

/**
 * The admin backend alone, on literal core references (the test app instance, an imported pool, tables
 * and offboarding function), for a test that compares a grant to the app instance's literal ARNs.
 */
export const adminServicesOnLiterals = memo((context) => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], ...context } });
  const host = new cdk.Stack(app, 'Core', { env: TEST_ENV });
  const table = (id: string, name: string) => dynamodb.Table.fromTableName(host, id, name);
  const stack = new AdminServicesStack(app, 'AdminServices', {
    env: TEST_ENV,
    appInstanceArn: TEST_APP_INSTANCE_ARN,
    appInstanceAdminArn: TEST_APP_INSTANCE_ARN + '/user/agent-echelon-admin',
    userPool: cognito.UserPool.fromUserPoolId(host, 'Pool', 'us-east-1_TestPool'),
    selfPoolId: 'us-east-1_TestPool',
    conversationManagementFunction: lambda.Function.fromFunctionArn(host, 'ConversationManagement', 'arn:aws:lambda:us-east-1:123456789012:function:test-conversation-management'),
    identitiesTable: table('Identities', 'test-identities'),
    accessLogTable: table('AccessLog', 'test-access-log'),
    offboardingFunction: lambda.Function.fromFunctionArn(host, 'Offboarding', 'arn:aws:lambda:us-east-1:123456789012:function:test-offboarding'),

    attachmentsBucketArn: 'arn:aws:s3:::test-attachments',
    feedbackTable: { tableName: 'test-feedback', tableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/test-feedback' },
    archiveBucketArn: 'arn:aws:s3:::test-archive',
    battle: false,
  });
  return stack;
});

/** The literal-reference AdminServices template, and its two nested stacks'. */
export const adminServicesOnLiteralsTemplate = memo((context) => Template.fromStack(adminServicesOnLiterals(context)));
export const nestedOnLiteralsTemplate = (child: 'AssistantAdministration' | 'Analytics', context: Context = {}) =>
  Template.fromStack(adminServicesOnLiterals(context).node.findChild(child) as cdk.Stack);

/** The AdminServices template. */
export const adminServicesTemplate = memo((context) => Template.fromStack(adminServicesStacks(context).adminServices));

/** The admin API that serves the admin backend's routes, and the console roles' grants on them. */
export const adminApiTemplate = memo((context) => Template.fromStack(adminServicesStacks(context).adminApi));

/** Assistant administration (profiles, ownership, the roster, experiments): a nested stack of AdminServices. */
export const assistantAdministrationTemplate = memo((context) =>
  Template.fromStack(adminServicesStacks(context).adminServices.node.findChild('AssistantAdministration') as cdk.Stack));

/** The admin analytics query: a nested stack of AdminServices. */
export const adminAnalyticsTemplate = memo((context) =>
  Template.fromStack(adminServicesStacks(context).adminServices.node.findChild('Analytics') as cdk.Stack));

/**
 * A message stream for a stack built on its own in a test: an imported stream with a literal ARN, so it
 * crosses no stack boundary and creates no export.
 */
export function testMessageStream(app: cdk.App): kinesis.IStream {
  const host = (app.node.tryFindChild('TestStreamHost') as cdk.Stack | undefined) ?? new cdk.Stack(app, 'TestStreamHost', { env: TEST_ENV });
  return (host.node.tryFindChild('MessageStream') as kinesis.IStream | undefined)
    ?? kinesis.Stream.fromStreamArn(host, 'MessageStream', `arn:aws:kinesis:${TEST_ENV.region}:${TEST_ENV.account}:stream/chime-messaging-test`);
}

/** The token store a stack that sends email requires, imported into the same host as the message stream. */
export function testTokensTable(app: cdk.App): dynamodb.ITable {
  const host = (app.node.tryFindChild('TestStreamHost') as cdk.Stack | undefined) ?? new cdk.Stack(app, 'TestStreamHost', { env: TEST_ENV });
  return (host.node.tryFindChild('Tokens') as dynamodb.ITable | undefined)
    ?? dynamodb.Table.fromTableArn(host, 'Tokens', `arn:aws:dynamodb:${TEST_ENV.region}:${TEST_ENV.account}:table/tokens-test`);
}

/** The Basic classification stack with the test props. */
export const basicClassificationStack = memo((context) =>
  assistantsOf('basic')(new cdk.App({ context }), 'AgentEchelonAssistants-basic', CLASSIFICATION_TEST_PROPS as never));

/** The Basic classification template. */
export const basicClassificationTemplate = memo((context) => Template.fromStack(basicClassificationStack(context)));

/**
 * The whole app in Aurora mode with every built capability and sleep mode, through the real CDK app
 * (`synthesizeApp`): its templates by stack name without the instance prefix, nested stacks included
 * (named `<Parent><Child><hash>.nested`). For a test that reads the admin backend on the Aurora archive.
 */
export const auroraAppTemplates = memo((context) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { synthesizeApp, SYNTH_CAPABILITIES } = require('../../lib/docs/api-contract') as typeof import('../../lib/docs/api-contract');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  const app = synthesizeApp(path.resolve(__dirname, '..', '..', '..'), {
    id: 'aurora-every-capability',
    context: { analyticsMode: 'aurora', capabilities: [...SYNTH_CAPABILITIES], sleepMode: true, ...context },
  });
  const prefix = Object.keys(app.dependencies).find((s) => s.endsWith('PostProcessing'))!.slice(0, -'PostProcessing'.length);
  return Object.fromEntries(Object.entries(app.templates).map(([name, t]) => [name.startsWith(prefix) ? name.slice(prefix.length) : name, Template.fromJSON(t as never)]));
});
