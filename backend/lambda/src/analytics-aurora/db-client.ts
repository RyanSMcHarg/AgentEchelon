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
// The PURE generator only — it imports nothing but the profile registry. Importing the runtime
// helpers instead would be a cycle, since those are built on `transaction()` below.
import { boundaryStatements } from './classification-boundary-sql.js';

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

/**
 * TWO IDENTITIES, TWO POOLS (ADR-028).
 *
 * `DB_OWNER_USER` owns the tables, runs migrations and applies the classification boundary.
 * `DB_APP_USER` is what every runtime query connects as: no ownership, no DDL, and therefore subject
 * to row-level security through the ordinary path rather than depending on FORCE and owner-exemption
 * semantics. When the runtime connected as the owner, the live verification's owner-defeat check
 * failed with no explanation the catalog could account for.
 *
 * The fallback is deliberate: with `DB_APP_USER` unset, both resolve to the owner and behaviour is
 * exactly what it was before this split. That matters for the deploy ORDER. The boundary bootstrap is
 * what CREATES the runtime role, and it runs as the owner, so the first cold start after this ships
 * must be able to connect before the role it will later use exists.
 */
const DB_OWNER_USER = DB_USER;
const DB_APP_USER = process.env.DB_APP_USER || DB_OWNER_USER;

const tokenCaches = new Map<string, TokenCache>();
const pools = new Map<string, Pool>();
let cachedPassword: string | null = null;

/**
 * Clear cached connection state (pool and token) for one identity, or all of them.
 * Called when auth fails to force fresh token generation.
 */
function clearConnectionState(user?: string): void {
  const users = user ? [user] : [...pools.keys(), ...tokenCaches.keys()];
  for (const u of new Set(users)) {
    tokenCaches.delete(u);
    const p = pools.get(u);
    if (p) {
      p.end().catch(() => {});
      pools.delete(u);
    }
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
async function getAuthToken(user: string): Promise<string> {
  const now = Date.now();

  const cached = tokenCaches.get(user);
  if (cached && cached.expiresAt > now) {
    return cached.token;
  }

  const signer = new Signer({
    hostname: DB_HOST,
    port: DB_PORT,
    username: user,
    region: DB_REGION,
  });

  const token = await signer.getAuthToken();

  tokenCaches.set(user, { token, expiresAt: now + 10 * 60 * 1000 });

  console.log(`Generated new IAM auth token for RDS (${user})`);
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
async function getPool(user: string = DB_APP_USER): Promise<Pool> {
  const existing = pools.get(user);
  if (existing) {
    return existing;
  }

  try {
    const password = USE_IAM_AUTH
      ? await getAuthToken(user)
      : await getPasswordFromSecrets();

    const created = new Pool({
      host: DB_HOST,
      port: DB_PORT,
      database: DB_NAME,
      user,
      password,
      ssl: { rejectUnauthorized: true, ca: RDS_CA_BUNDLE },
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    created.on('error', (err: any) => {
      console.error('Unexpected pool error:', err);
      clearConnectionState(user);
    });
    pools.set(user, created);

    console.log(`Database pool created for ${user}@${DB_HOST}:${DB_PORT}/${DB_NAME}`);
    return created;
  } catch (error: any) {
    if (isAuthError(error)) {
      console.error(`Authentication failure during pool creation for ${user}, clearing state`);
      clearConnectionState(user);
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
  // Which identity to run as. Defaults to the RUNTIME user (ADR-028); only migrations and the
  // boundary bootstrap pass the owner.
  user: string = DB_APP_USER,
): Promise<QueryResult<T>> {
  const p = await getPool(user);
  const start = Date.now();

  try {
    const result = await p.query<T>(text, params);
    const duration = Date.now() - start;

    if (duration > 500) {
      console.warn(`Slow query (${duration}ms):`, text.substring(0, 100));
    }

    return result;
  } catch (error: any) {
    // An IAM token expiring on a pooled connection is EXPECTED (RDS signs them for ~15 minutes) and
    // fully recovered below by re-authenticating and retrying once. Logging that at ERROR made a
    // routine, self-healing event indistinguishable from a real failure: it trains operators to
    // ignore ERROR in this log group, and it fails e2e runs through `guardBackendErrors`, which
    // counts handler ERROR lines. Verified against the live data-plane log group - every occurrence
    // was followed by "Generated new IAM auth token" and a successful retry, never a second failure.
    // The FIRST attempt of a retryable auth expiry is therefore a warning; anything else stays an error.
    const retryableAuthExpiry = isAuthError(error) && !retried;
    if (retryableAuthExpiry) {
      console.warn('Query hit an expired IAM connection; re-authenticating and retrying once:', error?.code);
    } else {
      console.error('Query error:', error);
      console.error('Query text:', text.substring(0, 200));
    }

    if (isAuthError(error)) {
      // IAM/PAM token expired on a pooled connection. Clear the pool + cached token so the
      // next getPool() re-authenticates, then retry the query ONCE. Without this retry the
      // expiry surfaces to the caller as a hard 500 even though the very next call succeeds
      // (the intermittent analytics 500s were exactly this). Retry once only.
      console.warn(`Authentication failure detected for ${user}, clearing connection state`);
      clearConnectionState(user);
      if (!retried) {
        console.warn('Retrying query once with a fresh IAM-authenticated connection');
        return query<T>(text, params, true, user);
      }
    }

    throw error;
  }
}

/**
 * Run a statement as the OWNER rather than as the runtime user.
 *
 * FOR RUNTIME DDL ONLY, and there should be almost none. `ae_app` deliberately holds no `CREATE` on
 * schema `public` (ADR-028), so a `CREATE TABLE IF NOT EXISTS` issued on the ordinary path fails with
 * `permission denied for schema public` - which is the runtime user's separation working, not a bug in
 * it. The statement still has to run somewhere, so it runs here, on the owner pool, exactly like
 * migrations do.
 *
 * WHY THIS EXISTS AT ALL, since schema belongs in `schema/NNN-*.sql`: `schema-init` is Create-only and
 * can never reconnect, so a table added after the initial bootstrap has historically been ensured at
 * runtime. Prefer a migration for anything new; this is for the sites that already do it.
 *
 * Every caller is enforced by `test/analytics-aurora/runtime-ddl-runs-as-owner.test.ts`, because the
 * failure mode is invisible until the specific op that needs the table is called: the regression that
 * prompted this shipped, passed a 38-test e2e phase, and only surfaced when an admin read was tried.
 */
export async function ownerQuery<T extends Record<string, any> = any>(
  text: string,
  params?: any[],
): Promise<QueryResult<T>> {
  return query<T>(text, params, false, DB_OWNER_USER);
}

/**
 * Get a client from the pool for transaction support.
 * IMPORTANT: Always release the client in a finally block.
 */
export async function getClient(user: string = DB_APP_USER): Promise<PoolClient> {
  const p = await getPool(user);
  return p.connect();
}

/**
 * Execute multiple queries in a transaction
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  // Defaults to the runtime identity, exactly like query().
  user: string = DB_APP_USER,
): Promise<T> {
  const client = await getClient(user);

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
 * Ensure the database schema is up to date by applying any PENDING migrations.
 *
 * Incremental + idempotent: reads `schema/*.sql` in order and applies only the files not yet recorded
 * in the `_migrations` table, recording each as it applies. Crucially this runs on the RUNTIME (IAM-auth)
 * connection, so unlike the CDK `schema-init` Custom Resource - which bootstraps on Create with PASSWORD
 * auth and then can never reconnect (IamAuthSetup grants rds_iam, which disables password auth) - it DOES
 * pick up a migration added AFTER the initial bootstrap on an already-running cluster. So a new migration
 * file auto-applies on the next deploy for every deployment, fresh or existing, with no manual step.
 *
 * Memoized per Lambda instance. A transaction-scoped advisory lock serializes concurrent cold starts so
 * two instances cannot both apply the same file. Runtime-applied migrations MUST be idempotent
 * (IF NOT EXISTS) and transaction-safe (no CREATE INDEX CONCURRENTLY etc.), since they run in one
 * transaction here; the initial bootstrap of the base schema still happens via `schema-init` on Create.
 */
let schemaInitialized = false;

// Fixed key for the pg advisory lock that serializes migration application across Lambda instances.
const MIGRATION_ADVISORY_LOCK_KEY = 4242042013;

export async function ensureSchema(): Promise<void> {
  if (schemaInitialized) return;
  try {
    await applyPendingMigrations();
    schemaInitialized = true;
  } catch (error) {
    console.error('Schema migration failed:', error);
    throw error;
  }
}

/**
 * Apply any `schema/*.sql` files not yet in `_migrations`, in order, under an advisory lock so
 * concurrent Lambda cold starts cannot double-apply. No-op when nothing is pending (the common case).
 */
async function applyPendingMigrations(): Promise<void> {
  const schemaDir = path.join(__dirname, 'schema');
  if (!fs.existsSync(schemaDir)) {
    console.warn('Schema directory not found:', schemaDir);
    return;
  }
  const files = fs.readdirSync(schemaDir).filter((f: string) => f.endsWith('.sql')).sort();

  // AS THE OWNER, explicitly (ADR-028). Migrations issue DDL and the boundary bootstrap issues
  // CREATE ROLE and GRANT, none of which the runtime identity has or should have. This is also what
  // creates the runtime role in the first place, so it cannot itself depend on that role existing.
  await transaction(async (client) => {
    // Serialize the whole check-then-apply so two cold-starting Lambdas do not both apply the same file.
    // The xact-scoped lock releases automatically on COMMIT/ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(256) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT NOW(),
        checksum VARCHAR(64)
      )
    `);

    const appliedRows = await client.query('SELECT filename FROM _migrations');
    const applied = new Set<string>(appliedRows.rows.map((r: { filename: string }) => r.filename));

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(schemaDir, file), 'utf-8');
      console.log(`Applying migration: ${file} (${sql.length} bytes)`);
      await client.query(sql);
      await client.query(
        `INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)
         ON CONFLICT (filename) DO UPDATE SET applied_at = NOW(), checksum = $2`,
        [file, migrationChecksum(sql)],
      );
      console.log(`Migration complete: ${file}`);
    }

    // ADR-028: the classification boundary — per-classification reader roles, a write role, and
    // FORCE ROW LEVEL SECURITY over the vector tables.
    //
    // IN THIS TRANSACTION, AND AFTER THE MIGRATIONS, both deliberately. After, because it references
    // columns the migrations add. In the same transaction, because the alternative is a window in
    // which the tables exist and the boundary does not.
    //
    // IN `ensureSchema` RATHER THAN AT EACH CALLER, because `withReaderRole`/`withWriterRole` issue
    // `SET LOCAL ROLE`, which ERRORS if the role has not been created. Every Lambda that reads or
    // writes a bounded table already calls `ensureSchema()` on its cold path, so establishing it here
    // means no Lambda can reach a role assumption before the role exists. A per-caller bootstrap would
    // have to be added to all ten call sites and would be missing from the eleventh.
    //
    // It is NOT recorded in `_migrations`: it is generated from deployment config (the classification
    // ladder), so unlike a fixed `.sql` file its content legitimately changes between deploys and must
    // re-apply. Every statement is idempotent for exactly that reason.
    const statements = boundaryStatements();
    for (const sql of statements) {
      await client.query(sql);
    }
    console.log(`[classification-boundary] applied (${statements.length} statements)`);
  }, DB_OWNER_USER);
}

/** Small non-crypto checksum for tracking migration file content (parity with schema-init.ts). */
function migrationChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16);
}
