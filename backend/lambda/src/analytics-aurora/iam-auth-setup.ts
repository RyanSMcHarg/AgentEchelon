/**
 * IAM Auth Setup - CDK Custom Resource Handler
 *
 * Runs once during CDK deployment to grant rds_iam role to the database user,
 * enabling IAM authentication for subsequent Lambda connections.
 *
 * This solves the chicken-and-egg problem:
 * - IAM auth requires rds_iam role granted to user
 * - But we cannot connect via IAM auth until it is granted
 * - Solution: This Lambda uses password auth (from Secrets Manager) to grant the role
 */

import {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
  Context,
} from 'aws-lambda';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';
import { rdsClusterSsl } from './rds-ssl';

const secretsClient = new SecretsManagerClient({});

interface ResourceProperties {
  ServiceToken: string;
  SecretArn: string;
  DbHost: string;
  DbPort: string;
  DbName: string;
  DbUser: string;
}

export async function handler(
  event: CloudFormationCustomResourceEvent,
  context: Context
): Promise<CloudFormationCustomResourceResponse> {
  console.log('Event:', JSON.stringify(event, null, 2));

  const props = event.ResourceProperties as ResourceProperties;
  const physicalResourceId = `iam-auth-setup-${props.DbHost}`;

  try {
    if (event.RequestType === 'Delete') {
      return sendResponse(event, context, 'SUCCESS', physicalResourceId, {
        Message: 'Delete: No action needed',
      });
    }

    // rds_iam is granted once, on Create (with password auth). Granting it
    // DISABLES password auth for evaladmin, so a re-run on a later deploy
    // (Update) can no longer connect ("PAM authentication failed"). The grant is
    // idempotent and one-time — no-op on Update. See schema-init.ts.
    if (event.RequestType === 'Update') {
      console.log('Update: rds_iam already granted at Create — no-op.');
      return sendResponse(event, context, 'SUCCESS', physicalResourceId, {
        Message: 'no-op on Update (rds_iam granted at Create)',
      });
    }

    // Create or Update: Grant rds_iam role
    console.log('Fetching database credentials from Secrets Manager...');
    const secretResponse = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: props.SecretArn })
    );

    if (!secretResponse.SecretString) {
      throw new Error('Secret value is empty');
    }

    const secret = JSON.parse(secretResponse.SecretString);

    console.log(
      `Connecting to ${props.DbHost}:${props.DbPort}/${props.DbName}...`
    );
    const client = new Client({
      host: props.DbHost,
      port: parseInt(props.DbPort, 10),
      database: props.DbName,
      user: secret.username,
      password: secret.password,
      ssl: rdsClusterSsl(),
      connectionTimeoutMillis: 10000,
    });

    await client.connect();
    console.log('Connected successfully');

    // Grant rds_iam role to enable IAM authentication
    const dbUser = props.DbUser;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbUser)) {
      throw new Error(`Invalid database user identifier: ${dbUser}`);
    }
    console.log(`Granting rds_iam role to ${dbUser}...`);
    await client.query(`GRANT rds_iam TO ${dbUser}`);
    console.log('rds_iam role granted successfully');

    // Ensure uuid-ossp extension is enabled
    console.log('Enabling uuid-ossp extension...');
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    await client.end();
    console.log('Setup complete');

    return sendResponse(event, context, 'SUCCESS', physicalResourceId, {
      Message: `IAM auth enabled for user ${dbUser}`,
    });
  } catch (error) {
    // Fail loud: THROW so the Provider framework reports FAILED to CFN.
    // (Returning a {Status:'FAILED'} object is treated as success.)
    console.error('IAM auth setup error:', error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function sendResponse(
  event: CloudFormationCustomResourceEvent,
  context: Context,
  status: 'SUCCESS' | 'FAILED',
  physicalResourceId: string,
  data: Record<string, string>
): CloudFormationCustomResourceResponse {
  return {
    Status: status,
    Reason: `See CloudWatch Log Stream: ${context.logStreamName}`,
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  };
}
