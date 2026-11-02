/**
 * CONNECTORS (`<prefix>Connectors`, capability `connectors`, Interaction): the connector runtime.
 *
 * What is built here follows from the declared connectors (`connectors` in `deploy.config.json`,
 * `lib/config/connectors.ts`), and nothing else is:
 *
 *  - THE EVENT RECEIVER, when a connector subscribes to vendor events (K5): one function, its replay
 *    table, its dead-letter queue, and one EventBridge rule per subscribing connector on the partner event
 *    bus of the source the connector declares (`eventSource`, referenced by name: the bus exists once the
 *    operator associates the vendor's partner event source with it, before the deploy). Each rule's
 *    pattern is the declared source and the subscribed event types (`connectorEventPattern`), and its one
 *    target is the receiver, with a retry policy and the dead-letter queue. The receiver's resource policy
 *    admits those rules alone (`SourceArn`). The function checks the source again, records each vendor
 *    event id once, resolves the people an event names through `Identities` (never by email, K2), admits
 *    them at the connector's classification (K4), and publishes the event as an `ae.connector` fact on the
 *    default bus. No vendor reaches an HTTP route.
 *  - PER-PERSON GRANTS, when a connector takes them (K3): the grants key (a customer managed KMS key), the
 *    grants table keyed by person id, the person's own link and revoke routes on `PersonApi`, and the
 *    revoker, which offboarding invokes for a person's grants and a daily schedule runs as the backstop.
 *
 * ── WHAT EACH FUNCTION HOLDS, AND NOTHING MORE (the boundary row: E13, K3) ──────────────────────
 *
 *  - The receiver: `PutItem`, `GetItem`, `UpdateItem` and `DeleteItem` on its replay table; `SendMessage`
 *    on its dead-letter queue; no secret; `events:PutEvents` for the `ae.connector` source only; the directory
 *    reads a clearance needs (`Identities` `GetItem`/`Query`, `DescribeAppInstanceUser`, the pools' groups);
 *    and, when a subscribing connector's `personIssuer` is `provisioned-only`, `lambda:InvokeFunction` on
 *    the connector subject provisioner (Identity) alone, which pre-assigns a person it names (P-13). It
 *    holds no write on `Identities` itself.
 *  - The grant routes: their table's item reads and writes; `kms:Encrypt`/`kms:Decrypt` on the grants key
 *    for the grant encryption context only; the OAuth client secret of each connector that takes grants.
 *  - The revoker: the same table and key, `Decrypt` only; the OAuth client secrets; `events:PutEvents` for
 *    `ae.alert` only.
 *
 * None of them holds any `chime:*` action: a connector posts nothing and changes no membership. Opening
 * a conversation for an event is **NOT BUILT**. `test/connectors-hold-only-their-own-reach.test.ts` pins
 * this, and `scripts/deny-test-connector-boundary.mjs` checks it against the deployed roles.
 *
 * Secrets are created by the operator, never by this stack, so a teardown never deletes a vendor
 * credential (`connectorSecretNames`).
 */
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { functionLogsBoundary, permissionsBoundary } from '../constructs/permissions-boundary';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { connectorEventPattern, connectorSecretNames } from '../config/connectors';
import { dataRemovalPolicy } from '../config/environment';
import { sharedOriginsEnv } from '../config/app-origins';
import { connectorsOf } from '../constructs/connectors';
import { grantAccountStateRead, grantDirectoryRead } from '../constructs/directory-access';
import { grantIssuerRegistry, issuersOf } from '../constructs/trusted-issuers';
import { isProvisionedOnly } from '../config/issuers';
import type { RouteSource, RouteSpec } from '../constructs/http-api';
import { INSTANCE_NAME, RES_PREFIX, alertEmitterWiring } from './agent-classification-common';

/** The source the receiver publishes vendor events under. Mirrors `CONNECTOR_SOURCE` in the handler. */
export const CONNECTOR_EVENT_SOURCE = 'ae.connector';

/**
 * How the receiver is retried. EventBridge retries a delivery the Lambda service refuses (throttling, a
 * service error) for up to a day; Lambda retries an invocation the function fails (it throws) twice. What
 * neither delivers lands in the dead-letter queue, kept for fourteen days.
 */
export const CONNECTOR_EVENT_RETRY = { targetRetryAttempts: 8, maxEventAgeHours: 24, functionRetryAttempts: 2, dlqRetentionDays: 14 } as const;

/** The grant revoker's function name: named, because offboarding (Identity) invokes it and deploys first. */
export function connectorGrantsFunctionName(resourcePrefix: string = RES_PREFIX): string {
  return `${resourcePrefix}-connector-grant-revoker`;
}

export interface ConnectorsStackProps extends cdk.StackProps {
  appInstanceArn: string;
  /** This deployment's own pool, or `''` when the registry declares none. */
  selfPoolId: string;
  /** `Identities` (Identity): read, never written. */
  identities: { tableName: string; tableArn: string };
  /** The role offboarding runs on (Identity), granted the revoker's invoke here, beside the function. */
  offboardingRoleArn: string;
  /**
   * The connector subject provisioner (Identity), when a subscribing connector names a `provisioned-only`
   * `personIssuer` (P-13, V8): the receiver invokes it to pre-assign a person it names.
   */
  subjectProvisioner?: lambda.IFunction;
}

export class ConnectorsStack extends cdk.Stack implements RouteSource {
  readonly routes: RouteSpec[] = [];
  /** The receiver, present when a connector subscribes to events. */
  readonly ingestFunction?: lambda.IFunction;
  /** One rule per subscribing connector, on its partner event bus. */
  readonly eventRules: events.Rule[] = [];
  /** The grant revoker, present when a connector takes per-person grants. */
  readonly grantRevoker?: lambda.IFunction;

  constructor(scope: Construct, id: string, props: ConnectorsStackProps) {
    super(scope, id, props);
    const registry = connectorsOf(this);
    const runtime = JSON.stringify(registry.runtime());
    const removalPolicy = dataRemovalPolicy(this);
    const secretArn = (name: string) => `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${name}-??????`;
    const basic = iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole');
    const bundling = { minify: false, forceDockerBundling: false };

    // ── THE CONNECTOR RUNTIME'S BOUNDARY (STACKS.md "Permissions boundaries") ──────────────────────────
    //
    // One boundary over the receiver, the grant routes and the revoker. It allows the services the runtime
    // uses, and whatever their grants grow to, it denies: every Amazon Chime SDK action but reading whether a
    // person exists (no connector holds a conversation's channel actions); every secret but this deployment's
    // connectors' own; and every write to `Identities`, which only the exchange and offboarding write.
    let runtimeBoundaryPolicy: iam.ManagedPolicy | undefined;
    const runtimeBoundary = (): iam.ManagedPolicy => runtimeBoundaryPolicy ??= (() => {
      const ownSecrets = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${RES_PREFIX}/connector/*`;
      return permissionsBoundary(this, 'ConnectorRuntimeBoundary',
        'The boundary of the connector runtime: its own secrets and grants, no conversation, and no Identities write', [
          functionLogsBoundary(),
          new iam.PolicyStatement({
            sid: 'BoundaryTheServicesTheRuntimeUses',
            actions: [
              'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem',
              'kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey',
              'secretsmanager:GetSecretValue', 'events:PutEvents', 'sqs:SendMessage', 'lambda:InvokeFunction',
              'cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser', 'cognito-idp:ListUsers',
              'chime:DescribeAppInstanceUser',
            ],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'BoundaryOnlyItsOwnConnectorsSecrets',
            effect: iam.Effect.DENY,
            actions: ['secretsmanager:GetSecretValue'],
            notResources: [ownSecrets],
          }),
          new iam.PolicyStatement({
            sid: 'BoundaryNeverWritesIdentities',
            effect: iam.Effect.DENY,
            actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'],
            resources: [props.identities.tableArn],
          }),
        ]);
    })();

    // ── THE EVENT RECEIVER ──────────────────────────────────────────────────────────────────────
    const subscribing = registry.subscribing();
    if (subscribing.length) {
      // ONE ITEM PER VENDOR EVENT ID, expiring after the replay window (`REPLAY_WINDOW_SECONDS`).
      const replayTable = new dynamodb.Table(this, 'ConnectorReplayTable', {
        partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: 'ttl',
        removalPolicy,
      });
      // WHAT NO RETRY DELIVERED: the rule's undeliverable events and the function's failed invocations.
      const dlq = new sqs.Queue(this, 'ConnectorEventsDlq', {
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        retentionPeriod: cdk.Duration.days(CONNECTOR_EVENT_RETRY.dlqRetentionDays),
      });
      const ingestRole = new iam.Role(this, 'ConnectorEventReceiverRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        permissionsBoundary: runtimeBoundary(),
        managedPolicies: [basic],
        inlinePolicies: {
          ReplayRecord: new iam.PolicyDocument({
            statements: [new iam.PolicyStatement({
              actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
              resources: [replayTable.tableArn],
            })],
          }),
          ConnectorEvents: new iam.PolicyDocument({
            statements: [new iam.PolicyStatement({
              actions: ['events:PutEvents'],
              resources: [`arn:aws:events:${this.region}:${this.account}:event-bus/default`],
              conditions: { StringEquals: { 'events:source': [CONNECTOR_EVENT_SOURCE] } },
            })],
          }),
        },
      });
      const ingest = new lambdaNodeJs.NodejsFunction(this, 'ConnectorEventReceiver', {
        entry: path.join(__dirname, '../../lambda/src/connector-ingest.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        role: ingestRole,
        // A thrown invocation (the replay store or the bus did not answer) is retried, then kept here.
        retryAttempts: CONNECTOR_EVENT_RETRY.functionRetryAttempts,
        deadLetterQueue: dlq,
        environment: {
          CONNECTORS: runtime,
          REPLAY_TABLE: replayTable.tableName,
          ALERT_INSTANCE: INSTANCE_NAME,
        },
        bundling,
      });
      // A named person's clearance, through the directory: `Identities` read-only, and each issuer's groups.
      grantDirectoryRead(ingest, {
        appInstanceArn: props.appInstanceArn,
        userPoolId: props.selfPoolId,
        poolReads: ['cognito-idp:AdminListGroupsForUser'],
        identities: props.identities,
      });
      // WHETHER A NAMED PERSON MAY STILL SIGN IN, asked of their issuers' pools before they are admitted
      // (`accountStateOfPerson`; SPEC-CREDENTIAL-EXCHANGE §4b).
      grantAccountStateRead(this, ingest, props.selfPoolId);
      // A NAMED PERSON OF A PROVISIONED-ONLY ISSUER IS PRE-ASSIGNED, through the one provisioner this role may invoke.
      if (props.subjectProvisioner) {
        const namespaces = [...new Set(subscribing.map((c) => c.personIssuer).filter((i): i is string => !!i && isProvisionedOnly(issuersOf(this).byId(i))))];
        props.subjectProvisioner.grantInvoke(ingest);
        ingest.addEnvironment('PROVISION_FUNCTION_NAME', props.subjectProvisioner.functionName);
        ingest.addEnvironment('PROVISION_NAMESPACES', JSON.stringify(namespaces));
      }
      this.ingestFunction = ingest;

      // ONE RULE PER SUBSCRIBING CONNECTOR, on its vendor's partner event bus, pinned to its declared source.
      // `targets.LambdaFunction` adds the receiver's resource policy for this rule's ARN alone.
      for (const c of subscribing) {
        const bus = events.EventBus.fromEventBusName(this, `PartnerBus-${c.id}`, c.eventSource as string);
        const pattern = connectorEventPattern(c);
        const rule = new events.Rule(this, `ConnectorEvents-${c.id}`, {
          description: `The ${c.vendor} events connector ${c.id} subscribes to, from its partner event source`,
          eventBus: bus,
          eventPattern: {
            source: pattern.source,
            detailType: pattern['detail-type'],
            ...(pattern.detail ? { detail: pattern.detail } : {}),
          },
        });
        rule.addTarget(new targets.LambdaFunction(ingest, {
          deadLetterQueue: dlq,
          retryAttempts: CONNECTOR_EVENT_RETRY.targetRetryAttempts,
          maxEventAge: cdk.Duration.hours(CONNECTOR_EVENT_RETRY.maxEventAgeHours),
        }));
        this.eventRules.push(rule);
      }

      // AN EVENT NO RETRY DELIVERED is an operator's to read: the queue holds it, and this alarm says so.
      new cloudwatch.Alarm(this, 'ConnectorEventsDlqAlarm', {
        alarmName: `${this.stackName}-connector-events-undelivered`,
        alarmDescription: 'A vendor event reached its connector rule and was not processed after every retry; it is kept in the '
          + 'connector events dead-letter queue. See docs/specs/communication/SPEC-CONNECTORS.md.',
        metric: dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5), statistic: 'Maximum' }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

    // ── PER-PERSON GRANTS ───────────────────────────────────────────────────────────────────────
    const withGrants = registry.withGrants();
    if (withGrants.length) {
      const key = new kms.Key(this, 'ConnectorGrantsKey', {
        description: 'Encrypts the per-person connector grants and their table',
        enableKeyRotation: true,
        removalPolicy,
      });
      const grantsTable = new dynamodb.Table(this, 'ConnectorGrantsTable', {
        partitionKey: { name: 'personId', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'connectorId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
        encryptionKey: key,
        removalPolicy,
      });
      const oauthSecrets = withGrants.map((c) => secretArn(connectorSecretNames(RES_PREFIX, c.id).oauthClient));
      /** The table's own encryption, used by DynamoDB on the caller's behalf, and only through DynamoDB. */
      const tableKeyUse = new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: [key.keyArn],
        conditions: { StringEquals: { 'kms:ViaService': `dynamodb.${this.region}.amazonaws.com` } },
      });
      /** The grant's own ciphertext: only under the grant encryption context (`lib/connector-grants.ts`). */
      const grantSeal = (actions: string[]) => new iam.PolicyStatement({
        actions,
        resources: [key.keyArn],
        conditions: { StringEquals: { 'kms:EncryptionContext:purpose': 'connector-grant' } },
      });

      const routesRole = new iam.Role(this, 'ConnectorGrantRoutesRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        permissionsBoundary: runtimeBoundary(),
        managedPolicies: [basic],
        inlinePolicies: {
          Grants: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem'],
                resources: [grantsTable.tableArn],
              }),
              tableKeyUse,
              grantSeal(['kms:Encrypt', 'kms:Decrypt']),
              new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: oauthSecrets }),
            ],
          }),
        },
      });
      const routesFn = new lambdaNodeJs.NodejsFunction(this, 'ConnectorGrantRoutes', {
        entry: path.join(__dirname, '../../lambda/src/connector-grant-routes.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(20),
        memorySize: 256,
        role: routesRole,
        environment: {
          CONNECTORS: runtime,
          GRANTS_TABLE: grantsTable.tableName,
          GRANTS_KEY_ARN: key.keyArn,
          CONNECTOR_SECRET_PREFIX: RES_PREFIX,
          APP_INSTANCE_ARN: props.appInstanceArn,
          ALLOWED_ORIGIN: sharedOriginsEnv(this),
        },
        bundling,
      });
      // The caller is the person the edge resolved, read through the registry.
      grantIssuerRegistry(routesFn, props.selfPoolId);

      const alerts = alertEmitterWiring(this);
      const revokerRole = new iam.Role(this, 'ConnectorGrantRevokerRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        permissionsBoundary: runtimeBoundary(),
        managedPolicies: [basic],
        inlinePolicies: {
          Grants: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                actions: ['dynamodb:Query', 'dynamodb:Scan', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem'],
                resources: [grantsTable.tableArn],
              }),
              tableKeyUse,
              grantSeal(['kms:Decrypt']),
              new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: oauthSecrets }),
            ],
          }),
        },
      });
      alerts.grant(revokerRole);
      const revoker = new lambdaNodeJs.NodejsFunction(this, 'ConnectorGrantRevoker', {
        entry: path.join(__dirname, '../../lambda/src/connector-grant-revoker.ts'),
        handler: 'handler',
        functionName: connectorGrantsFunctionName(),
        runtime: lambda.Runtime.NODEJS_20_X,
        // Each grant is up to three vendor calls with backoff; a person holds one per connector.
        timeout: cdk.Duration.minutes(2),
        memorySize: 256,
        role: revokerRole,
        environment: {
          ...alerts.env,
          CONNECTORS: runtime,
          GRANTS_TABLE: grantsTable.tableName,
          GRANTS_KEY_ARN: key.keyArn,
          CONNECTOR_SECRET_PREFIX: RES_PREFIX,
        },
        bundling,
      });
      this.grantRevoker = revoker;
      // THE BACKSTOP (tenet D6): offboarding's call is primary; the sweep retries what the vendor refused.
      new events.Rule(this, 'ConnectorGrantRevokeSweep', {
        description: 'Backstop: retry every connector grant whose revocation at the vendor has not succeeded',
        schedule: events.Schedule.rate(cdk.Duration.days(1)),
        targets: [new targets.LambdaFunction(revoker)],
      });
      // OFFBOARDING'S INVOKE, on this one function, granted here beside it.
      const offboarding = iam.Role.fromRoleArn(this, 'ImportedOffboardingRole', props.offboardingRoleArn, { mutable: true });
      offboarding.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [revoker.functionArn] }));

      const grantThrottle = { rate: 5, burst: 10 };
      this.routes.push(
        { api: 'person', method: 'POST', path: '/connectors/{connectorId}/grant', handler: routesFn, capability: 'connectors', throttle: grantThrottle },
        { api: 'person', method: 'DELETE', path: '/connectors/{connectorId}/grant', handler: routesFn, capability: 'connectors', throttle: grantThrottle },
      );
    }

    cdk.Tags.of(this).add('Component', 'Connectors');
  }
}
