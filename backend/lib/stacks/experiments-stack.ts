/**
 * ExperimentsStack (`<prefix>Experiments`): the A/B experiments data, the `experiments` capability.
 *
 * Owns:
 *   - The `experiments` DynamoDB table (all-classification A/B DATA, shared, carrying no agent identity,
 *     so a shared table is consistent with the separation posture), under its fixed name
 *     (`CAPABILITY_RESOURCES.experimentsTable`), which the per-classification processors and routers and the
 *     channel flow are told in their environment.
 *   - The grant on it held by the channel flow's role. Each classification's acting role and router role are
 *     granted it by that classification's own stack (`attachExperiments`, `classification-capabilities.ts`),
 *     so this stack names no classification (STACKS.md, additivity).
 *   - The shared SSM contract `${SSM_ROOT}/shared/tables/experiments-{arn,name}`, for an operator and a
 *     script to find the table.
 *
 * NO ADMINISTRATION HERE. Creating, arming and deciding an experiment is an admin action, so its handler
 * and routes are the `AdminServices` stack's, built there only when this capability is declared, on this
 * table by reference. A deployment that declares `experiments` without `admin` serves its experiments'
 * variants and has nowhere to change them, which is the component rule (the core and its capabilities
 * never depend on the admin backend).
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { dataRemovalPolicy as dataRemovalPolicyOf } from '../config/environment';
import { CAPABILITY_RESOURCES, SHARED_SSM } from './agent-classification-common';

export interface ExperimentsStackProps extends cdk.StackProps {
  /** The channel flow's processor role: a duel's fan-out reads the table for its per-variant image models. */
  channelFlowRole?: iam.IRole;
}

/** The role, imported by name into `scope`, so a policy attached to it lives in `scope`'s stack. */
export function attachableRole(scope: Construct, id: string, role: iam.IRole): iam.IRole {
  return iam.Role.fromRoleName(scope, id, role.roleName);
}

export class ExperimentsStack extends cdk.Stack {
  public readonly experimentsTable: dynamodb.ITable;
  public readonly experimentsTableName: string;
  public readonly experimentsTableArn: string;

  constructor(scope: Construct, id: string, props: ExperimentsStackProps) {
    super(scope, id, props);

    const experimentsTable = new dynamodb.Table(this, 'ExperimentsTable', {
      tableName: CAPABILITY_RESOURCES.experimentsTable,
      partitionKey: { name: 'experimentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: dataRemovalPolicyOf(this),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.experimentsTable = experimentsTable;
    this.experimentsTableName = experimentsTable.tableName;
    this.experimentsTableArn = experimentsTable.tableArn;

    // ── THE GRANT ON THE CHANNEL FLOW, WHICH SERVES EVERY CLASSIFICATION ──────────────────────────
    // Each classification's acting role and router role are granted the table by its own stack
    // (`attachExperiments`, `classification-capabilities.ts`).
    // THE CHANNEL FLOW reads it for a duel's per-variant image models (loadExperiments does a Scan).
    if (props.channelFlowRole) {
      new iam.Policy(this, 'ExperimentsOnTheChannelFlow', {
        roles: [attachableRole(this, 'ChannelFlowRole', props.channelFlowRole)],
        statements: [new iam.PolicyStatement({ actions: ['dynamodb:Scan', 'dynamodb:GetItem'], resources: [experimentsTable.tableArn] })],
      });
    }

    // Shared SSM contract: where an operator or a script finds the table.
    new ssm.StringParameter(this, 'SharedExperimentsArnParam', {
      parameterName: SHARED_SSM.experimentsArn,
      stringValue: experimentsTable.tableArn,
    });
    new ssm.StringParameter(this, 'SharedExperimentsNameParam', {
      parameterName: SHARED_SSM.experimentsName,
      stringValue: experimentsTable.tableName,
    });

    new cdk.CfnOutput(this, 'ExperimentsTableName', {
      value: experimentsTable.tableName,
      description: 'DynamoDB table for A/B test experiments',
    });

    cdk.Tags.of(this).add('Component', 'Experiments');
  }
}
