/**
 * Database Client for Aurora PostgreSQL
 *
 * Provides connection pooling with IAM database authentication via RDS Proxy.
 * Used by all Aurora-mode analytics Lambdas.
 *
 * Features:
 * - IAM token generation with 10-minute cache (tokens valid 15 min)
 * - Connection pooling (max 5 per Lambda instance)
 * - Auto-reconnect on auth errors
 * - Schema migration tracking
 */

import { Signer } from '@aws-sdk/rds-signer';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool, PoolClient, QueryResult } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// Environment variables (set by CDK)
const DB_HOST = process.env.DB_HOST!;
const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
const DB_NAME = process.env.DB_NAME || 'evaluation';
const DB_USER = process.env.DB_USER || 'evaladmin';
const DB_REGION = process.env.DB_REGION || 'us-east-1';
const USE_IAM_AUTH = process.env.USE_IAM_AUTH === 'true';
const DB_SECRET_ARN = process.env.DB_SECRET_ARN;

const secretsClient = new SecretsManagerClient({ region: DB_REGION });

// RDS enforces TLS. On a DIRECT cluster connection the server presents an
// Amazon-RDS-CA-signed cert that is NOT in Node's default trust store, so
// `rejectUnauthorized: true` fails with "unable to get local issuer certificate".
// (RDS Proxy happened to validate against the default store; the cluster does
// not.) Load the RDS CA bundle shipped alongside this Lambda — `certs/rds-bundle.pem`,
// copied into the bundle by the cert commandHook in analytics-stack-aurora.ts —
// so the direct connection verifies properly. Defensive: absent (e.g. unit
// tests, non-DB contexts) → undefined, i.e. fall back to the default store.
const RDS_CA_BUNDLE: string | undefined = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'certs', 'rds-bundle.pem'), 'utf8');
  } catch {
    return undefined;
  }
})();

// IAM auth token cache (tokens valid for 15 minutes, refresh at 10)
interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;
let pool: Pool | null = null;
let cachedPassword: string | null = null;

/**
 * Clear cached connection state (pool and token).
 * Called when auth fails to force fresh token generation.
 */
function clearConnectionState(): void {
  tokenCache = null;
  if (pool) {
    pool.end().catch(() => {});
    pool = null;
  }
  console.log('Cleared connection state (pool and token cache)');
}

/**
 * Check if an error is an authentication failure
 */
export function isAuthError(error: any): boolean {
  const code = error?.code;
  const msg: string = error?.message || '';
  return (
    code === '28P01' || // invalid_password
    // RDS IAM authentication expires the signed token (~15 min). When a pooled connection's
    // token lapses, Postgres rejects re-auth with SQLSTATE 28000 and "PAM authentication
    // failed" (PAM is how RDS enforces IAM auth). This is the common expiry signature, distinct
    // from 28P01, and MUST be treated as an auth error so the pool is cleared + the query retried.
    code === '28000' || // invalid_authorization_specification
    msg.includes('IAM authentication failed') ||
    msg.includes('PAM authentication failed')
  );
}

/**
 * Reset connection state - exported for retry logic in callers
 */
export function resetConnection(): void {
  clearConnectionState();
}

/**
 * Get IAM authentication token for RDS.
 * Tokens are cached for 10 minutes (valid for 15).
 */
async function getAuthToken(): Promise<string> {
  const now = Date.now();

  if (tokenCache && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  const signer = new Signer({
    hostname: DB_HOST,
    port: DB_PORT,
    username: DB_USER,
    region: DB_REGION,
  });

  const token = await signer.getAuthToken();

  tokenCache = {
    token,
    expiresAt: now + 10 * 60 * 1000, // 10 minutes
  };

  console.log('Generated new IAM auth token for RDS');
  return token;
}

/**
 * Get password from Secrets Manager (fallback for non-IAM auth)
 */
async function getPasswordFromSecrets(): Promise<string> {
  if (cachedPassword) {
    return cachedPassword;
  }

  if (!DB_SECRET_ARN) {
    throw new Error('DB_SECRET_ARN not configured for password auth');
  }

  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: DB_SECRET_ARN })
  );

  if (!response.SecretString) {
    throw new Error('Secret value is empty');
  }

  const secret = JSON.parse(response.SecretString);
  cachedPassword = secret.password;
  console.log('Retrieved database password from Secrets Manager');
  return cachedPassword!;
}

/**
 * Get or create the connection pool.
 * Pool is reused across Lambda invocations (warm starts).
 */
async function getPool(): Promise<Pool> {
  if (pool) {
    return pool;
  }

  try {
    const password = USE_IAM_AUTH
      ? await getAuthToken()
      : await getPasswordFromSecrets();

    pool = new Pool({
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user: DB_USER,
      password,
      ssl: { rejectUnauthorized: true, ca: RDS_CA_BUNDLE },
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err: any) => {
      console.error('Unexpected pool error:', err);
      clearConnectionState();
    });

    console.log(`Database pool created for ${DB_HOST}:${DB_PORT}/${DB_NAME}`);
    return pool;
  } catch (error: any) {
    if (isAuthError(error)) {
      console.error('Authentication failure during pool creation, clearing state');
      clearConnectionState();
    }
    throw error;
  }
}

/**
 * Execute a query with automatic connection management
 */
export async function query<T extends Record<string, any> = any>(
  text: string,
  params?: any[],
  // Internal: set once we have already cleared state + retried, so an auth failure that
  // persists after a fresh IAM token throws instead of looping.
  retried = false,
): Promise<QueryResult<T>> {
  const p = await getPool();
  const start = Date.now();

  try {
    const result = await p.query<T>(text, params);
    const duration = Date.now() - start;

    if (duration > 500) {
      console.warn(`Slow query (${duration}ms):`, text.substring(0, 100));
    }

    return result;
  } catch (error: any) {
    console.error('Query error:', error);
    console.error('Query text:', text.substring(0, 200));

    if (isAuthError(error)) {
      // IAM/PAM token expired on a pooled connection. Clear the pool + cached token so the
      // next getPool() re-authenticates, then retry the query ONCE. Without this retry the
      // expiry surfaces to the caller as a hard 500 even though the very next call succeeds
      // (the intermittent analytics 500s were exactly this). Retry once only.
      console.error('Authentication failure detected, clearing connection state');
      clearConnectionState();
      if (!retried) {
        console.warn('Retrying query once with a fresh IAM-authenticated connection');
        return query<T>(text, params, true);
      }
    }

    throw error;
  }
}

/**
 * Get a client from the pool for transaction support.
 * IMPORTANT: Always release the client in a finally block.
 */
export async function getClient(): Promise<PoolClient> {
  const p = await getPool();
  return p.connect();
}

/**
 * Execute multiple queries in a transaction
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Validate a SQL identifier (table or column name) to prevent injection.
 */
const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateIdentifier(name: string, kind: string): void {
  if (!VALID_IDENTIFIER.test(name)) {
    throw new Error(`Invalid ${kind} identifier: ${name}`);
  }
}

/**
 * Batch insert helper using multi-value INSERT.
 * More efficient than individual inserts.
 */
export async function batchInsert<T extends Record<string, any>>(
  tableName: string,
  columns: string[],
  rows: T[],
  onConflict?: string
): Promise<number> {
  if (rows.length === 0) return 0;

  validateIdentifier(tableName, 'table');
  columns.forEach((col) => validateIdentifier(col, 'column'));

  const values: any[] = [];
  const valueClauses: string[] = [];

  rows.forEach((row, rowIndex) => {
    const rowParams: string[] = [];
    columns.forEach((col, colIndex) => {
      const paramIndex = rowIndex * columns.length + colIndex + 1;
      rowParams.push(`$${paramIndex}`);
      values.push(row[col] ?? null);
    });
    valueClauses.push(`(${rowParams.join(', ')})`);
  });

  let sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${valueClauses.join(', ')}`;

  if (onConflict) {
    sql += ` ${onConflict}`;
  }

  const result = await query(sql, values);
  return result.rowCount || 0;
}

/**
 * Ensure database schema is initialized.
 * Reads and executes SQL files from the schema directory in order.
 * Uses a _migrations table to track which files have been applied.
 */
let schemaInitialized = false;

export async function ensureSchema(): Promise<void> {
  if (schemaInitialized) return;

  try {
    // Check if messages table exists (quick check for initialized state)
    const tableResult = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'messages'
      ) as has_messages
    `);

    if (tableResult.rows[0].has_messages) {
      schemaInitialized = true;
      return;
    }

    // Schema not initialized -- run migration files
    console.log('Schema not found, running migrations...');
    await runMigrations();
    schemaInitialized = true;
  } catch (error) {
    console.error('Schema check failed:', error);
    throw error;
  }
}

/**
 * Run all SQL migration files from the schema directory in order.
 */
async function runMigrations(): Promise<void> {
  const schemaDir = path.join(__dirname, 'schema');

  if (!fs.existsSync(schemaDir)) {
    console.warn('Schema directory not found:', schemaDir);
    return;
  }

  const files = fs.readdirSync(schemaDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const filePath = path.join(schemaDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');
    console.log(`Executing migration: ${file}`);

    try {
      await query(sql);
      console.log(`Migration complete: ${file}`);
    } catch (error) {
      console.error(`Migration failed: ${file}`, error);
      throw error;
    }
  }
}
