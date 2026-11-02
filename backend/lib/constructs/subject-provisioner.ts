/**
 * THE SUBJECT PROVISIONERS (P-13): one function per caller that may pre-assign a `provisioned-only`
 * issuer's subject, and the grants that hold each to its own issuers.
 *
 * `provisionSubject` writes a `pending` row in `Identities`, which the credential exchange binds once at
 * the subject's first sign-in (`lambda/src/lib/person-identity.ts`). Two callers may ask for one, and
 * nobody else (`PROVISIONERS`):
 *
 *  - `admin`: the admin backend's user management (`POST /users/provision`), present with the `admin`
 *    capability, for every `provisioned-only` issuer the registry declares.
 *  - `connectors`: the connector event receiver, present with the `connectors` capability, for the
 *    `provisioned-only` issuers a subscribing connector names as its `personIssuer` (V8).
 *
 * A direct invoke attests nothing about its caller, so each caller gets its own function with the caller
 * fixed in its environment (`PROVISION_CALLER`), and the caller's role is granted the invoke of its own
 * provisioner alone. Each provisioner's role reaches `Identities` with:
 *
 *  - `GetItem`, to read the subject's row and its revoked marker;
 *  - `PutItem` only under its issuers' keys (`dynamodb:LeadingKeys` `<issuer id>|*`, so never a revoked
 *    marker and never another issuer's subject) and only with the attributes a `pending` row carries
 *    (`dynamodb:Attributes`). It holds no `UpdateItem` and no `DeleteItem`, so a row it did not write is
 *    out of its reach, and a row it wrote can only be bound by the exchange.
 *
 * Built in `Identity`, beside the table, so the writers of `Identities` are all in one stack. A caller with
 * no issuer to provision for gets no provisioner.
 */
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodeJs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import type { ConnectorRegistry } from '../config/connectors';
import { isProvisionedOnly, type IssuerRegistry } from '../config/issuers';

/** The two callers that may provision a subject. */
export const PROVISIONERS = ['admin', 'connectors'] as const;
export type ProvisionerCaller = (typeof PROVISIONERS)[number];

/** The attributes a `pending` row carries, and the only ones a provisioner may write. */
export const PENDING_ROW_ATTRIBUTES = ['issuerSubject', 'personArn', 'issuer', 'status', 'createdAt', 'provisionedBy'] as const;

/** The issuers each caller may provision for. A caller absent from the result gets no provisioner. */
export function provisionerIssuers(
  issuers: Pick<IssuerRegistry, 'provisionedOnly' | 'byId'>,
  connectors: Pick<ConnectorRegistry, 'subscribing'> | null,
  capabilities: { has(name: string): boolean },
): Partial<Record<ProvisionerCaller, string[]>> {
  const out: Partial<Record<ProvisionerCaller, string[]>> = {};
  const all = issuers.provisionedOnly().map((e) => e.id);
  if (capabilities.has('admin') && all.length) out.admin = all;
  if (capabilities.has('connectors') && connectors) {
    const named = [...new Set(connectors.subscribing()
      .map((c) => c.personIssuer)
      .filter((id): id is string => !!id && isProvisionedOnly(issuers.byId(id))))];
    if (named.length) out.connectors = named;
  }
  return out;
}

export interface SubjectProvisionerProps {
  caller: ProvisionerCaller;
  /** The `provisioned-only` issuers this caller may provision for. Never empty. */
  issuerIds: readonly string[];
  identities: dynamodb.ITable;
  accessLog: dynamodb.ITable;
  appInstanceArn: string;
  /** The registry's travelling form (`TRUSTED_ISSUERS`), which the handler checks each issuer against. */
  trustedIssuersJson: string;
}

export class SubjectProvisioner extends Construct {
  readonly fn: lambdaNodeJs.NodejsFunction;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: SubjectProvisionerProps) {
    super(scope, id);
    if (!props.issuerIds.length) throw new Error(`SubjectProvisioner (${props.caller}): a provisioner names the issuers it provisions for`);
    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      description: `Writes pending Identities rows for ${props.issuerIds.join(', ')}, for the ${props.caller} caller alone`,
      inlinePolicies: {
        PendingRows: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({ sid: 'ReadRowAndMarker', actions: ['dynamodb:GetItem'], resources: [props.identities.tableArn] }),
            new iam.PolicyStatement({
              sid: 'WritePendingRow',
              actions: ['dynamodb:PutItem'],
              resources: [props.identities.tableArn],
              conditions: {
                'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': props.issuerIds.map((i) => `${i}|*`) },
                'ForAllValues:StringEquals': { 'dynamodb:Attributes': [...PENDING_ROW_ATTRIBUTES] },
              },
            }),
            // The audit record of each row, added and never read.
            new iam.PolicyStatement({ sid: 'AuditRecord', actions: ['dynamodb:PutItem'], resources: [props.accessLog.tableArn] }),
            // An administrator links a subject only to a person who exists.
            ...(props.caller === 'admin' ? [new iam.PolicyStatement({
              sid: 'PersonExists',
              actions: ['chime:DescribeAppInstanceUser'],
              resources: [`${props.appInstanceArn}/user/*`],
            })] : []),
          ],
        }),
      },
    });
    this.fn = new lambdaNodeJs.NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, '../../lambda/src/provision-subject.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      role: this.role,
      description: `provisionSubject for the ${props.caller} caller`,
      environment: {
        PROVISION_CALLER: props.caller,
        PROVISION_ISSUERS: JSON.stringify([...props.issuerIds]),
        IDENTITIES_TABLE: props.identities.tableName,
        ACCESS_LOG_TABLE: props.accessLog.tableName,
        APP_INSTANCE_ARN: props.appInstanceArn,
        TRUSTED_ISSUERS: props.trustedIssuersJson,
      },
      bundling: { minify: false, forceDockerBundling: false, externalModules: ['@aws-sdk/*'] },
    });
  }
}
