/**
 * Schema Init Lambda - CDK Custom Resource Handler
 *
 * Runs during CDK deployment to initialize the Aurora PostgreSQL schema.
 * Uses password auth from Secrets Manager (not IAM, since this runs before
 * IAM auth setup).
 *
 * Responsibilities:
 * - Enable uuid-ossp extension
 * - Read and execute all .sql files from schema/ directory in order
 * - Track applied migrations in a _migrations table
 * - Return success/failure to CloudFormation
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
import * as fs from 'fs';
import * as path from 'path';
import { rdsClusterSsl } from './rds-ssl';

const secretsClient = new SecretsManagerClient({});

interface ResourceProperties {
  ServiceToken: string;
  SecretArn: string;
  DbHost: string;
  DbPort: string;
  DbName: string;
  DbUser: string;
  Timestamp?: string; // Force update on each deploy
}

export async function handler(
  event: CloudFormationCustomResourceEvent,
  context: Context
): Promise<CloudFormationCustomResourceResponse> {
  console.log('Event:', JSON.stringify(event, null, 2));

  const props = event.ResourceProperties as ResourceProperties;
  const physicalResourceId = `schema-init-${props.DbHost}`;

  try {
    if (event.RequestType === 'Delete') {
      return sendResponse(event, context, 'SUCCESS', physicalResourceId, {
        Message: 'Delete: No action needed',
      });
    }

    // Schema is bootstrapped once, on Create (with password auth). On every
    // later deploy this fires as an Update — but by then IamAuthSetup has
    // granted `rds_iam` to evaladmin, which DISABLES password auth in RDS
    // PostgreSQL (login fails with "PAM authentication failed"). So a re-run
    // can't connect and would (correctly, fail-loud) break the deploy. Bootstrap
    // is one-time: no-op on Update. New migrations need a fresh bootstrap or an
    // IAM-auth upgrade to this Lambda — see the matching note in iam-auth-setup.ts.
    if (event.RequestType === 'Update') {
      console.log('Update: schema already bootstrapped at Create — no-op.');
      return sendResponse(event, context, 'SUCCESS', physicalResourceId, {
        Message: 'no-op on Update (schema bootstrapped at Create)',
      });
    }

    // Fetch database credentials from Secrets Manager
    console.log('Fetching database credentials from Secrets Manager...');
    const secretResponse = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: props.SecretArn })
    );

    if (!secretResponse.SecretString) {
      throw new Error('Secret value is empty');
    }

    const secret = JSON.parse(secretResponse.SecretString);

    // Connect to Aurora using password auth
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

    // Enable uuid-ossp extension
    console.log('Enabling uuid-ossp extension...');
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(256) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT NOW(),
        checksum VARCHAR(64)
      )
    `);

    // Read and execute schema files in order
    const schemaDir = path.join(__dirname, 'schema');
    let appliedCount = 0;
    const failures: string[] = [];

    if (fs.existsSync(schemaDir)) {
      const files = fs.readdirSync(schemaDir)
        .filter((f: string) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        // Check if already applied
        const existing = await client.query(
          'SELECT 1 FROM _migrations WHERE filename = $1',
          [file]
        );

        if (existing.rows.length > 0) {
          // Skip already-applied migrations (standard forward-only behavior).
          // Re-running every file each deploy is unsafe once a migration is
          // destructive — e.g. 006 drops drift_detection, which a re-run of 003
          // (matview FROM drift_detection) would then fail to recreate.
          console.log(`Migration already applied, skipping: ${file}`);
          continue;
        }

        const filePath = path.join(schemaDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');

        console.log(`Executing migration: ${file} (${sql.length} bytes)`);

        try {
          await client.query(sql);

          // Track migration
          await client.query(
            `INSERT INTO _migrations (filename, checksum)
             VALUES ($1, $2)
             ON CONFLICT (filename) DO UPDATE SET applied_at = NOW(), checksum = $2`,
            [file, simpleChecksum(sql)]
          );

          appliedCount++;
          console.log(`Migration complete: ${file}`);
        } catch (error) {
          // Migrations are written idempotently (IF NOT EXISTS), so a failure
          // here is a real problem — record it and fail the deploy below rather
          // than silently shipping a half-built schema.
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`Migration failed: ${file}`, error);
          failures.push(`${file}: ${msg}`);
        }
      }
    } else {
      throw new Error(`Schema directory not found: ${schemaDir}`);
    }

    await client.end();

    if (failures.length > 0) {
      throw new Error(`Schema init failed (${failures.length} migration(s)): ${failures.join('; ')}`);
    }

    console.log(`Schema init complete. Applied ${appliedCount} migrations.`);
    return sendResponse(event, context, 'SUCCESS', physicalResourceId, {
      Message: `Schema initialized: ${appliedCount} migrations applied`,
    });
  } catch (error) {
    // Fail loud: THROW so the CDK Provider framework reports FAILED to
    // CloudFormation. (Returning a {Status:'FAILED'} object is treated as
    // success by the framework — the bug that hid the TLS connect failure.)
    console.error('Schema init error:', error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Simple string checksum for tracking migration file changes
 */
function simpleChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16);
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
