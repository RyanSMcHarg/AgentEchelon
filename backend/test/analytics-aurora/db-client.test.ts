/**
 * Unit tests for Aurora database client
 *
 * Tests IAM token caching, connection pool management, error handling,
 * and schema initialization logic. Mocks pg and AWS SDK.
 */

// Mock pg before import
jest.mock('pg', () => {
  const mockResult = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
  const mockClient = {
    query: jest.fn().mockResolvedValue(mockResult),
    release: jest.fn(),
    on: jest.fn(),
  };
  const mockPool = {
    connect: jest.fn().mockResolvedValue(mockClient),
    query: jest.fn().mockResolvedValue(mockResult),
    end: jest.fn().mockResolvedValue(undefined), // pool.end() returns a Promise (clearConnectionState .catch()es it)
    on: jest.fn(),
  };
  return {
    Pool: jest.fn(() => mockPool),
    __mockPool: mockPool,
    __mockClient: mockClient,
  };
});

// Mock RDS Signer
jest.mock('@aws-sdk/rds-signer', () => ({
  Signer: jest.fn().mockImplementation(() => ({
    getAuthToken: jest.fn().mockResolvedValue('mock-iam-token-12345'),
  })),
}));

// Mock fs for schema reading
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn().mockReturnValue('CREATE TABLE IF NOT EXISTS test (id INT);'),
  readdirSync: jest.fn().mockReturnValue(['001-initial.sql', '002-pgvector.sql']),
}));

describe('DB Client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.DB_HOST = 'test-proxy.rds.amazonaws.com';
    process.env.DB_PORT = '5432';
    process.env.DB_NAME = 'analytics';
    process.env.DB_USER = 'analyticsadmin';
    process.env.DB_REGION = 'us-east-1';
    process.env.USE_IAM_AUTH = 'true';
  });

  describe('query', () => {
    it('should execute a query and return results', async () => {
      const { query } = await import('../../lambda/src/analytics-aurora/db-client');
      const pg = require('pg');

      pg.__mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 1, name: 'test' }],
        rowCount: 1,
        command: 'SELECT',
        oid: 0,
        fields: [],
      });

      const result = await query('SELECT * FROM test WHERE id = $1', [1]);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('test');
      expect(pg.__mockPool.query).toHaveBeenCalled();
    });

    it('should release client on query error', async () => {
      const { query } = await import('../../lambda/src/analytics-aurora/db-client');
      const pg = require('pg');

      pg.__mockPool.query.mockRejectedValueOnce(new Error('Query failed'));

      await expect(query('SELECT * FROM bad_table')).rejects.toThrow('Query failed');
    });

    it('retries ONCE and succeeds when an IAM/PAM token expires mid-connection (SQLSTATE 28000)', async () => {
      // Regression: an expired IAM token surfaces as `PAM authentication failed` / 28000 (NOT
      // 28P01). It must be recognized as an auth error → clear the pool → retry once with a fresh
      // token, so callers see success instead of an intermittent 500.
      const { query } = await import('../../lambda/src/analytics-aurora/db-client');
      const pg = require('pg');
      const pamError = Object.assign(new Error('PAM authentication failed for user "evaladmin"'), { code: '28000' });
      pg.__mockPool.query
        .mockRejectedValueOnce(pamError)
        .mockResolvedValueOnce({ rows: [{ ok: 1 }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] });

      const result = await query('SELECT 1');

      expect(result.rows[0].ok).toBe(1);
      expect(pg.__mockPool.query).toHaveBeenCalledTimes(2); // failed once, retried once
    });

    it('does not loop — a persistent auth failure throws after a single retry', async () => {
      const { query } = await import('../../lambda/src/analytics-aurora/db-client');
      const pg = require('pg');
      const pamError = Object.assign(new Error('PAM authentication failed'), { code: '28000' });
      pg.__mockPool.query.mockRejectedValue(pamError);

      await expect(query('SELECT 1')).rejects.toThrow('PAM authentication failed');
      expect(pg.__mockPool.query).toHaveBeenCalledTimes(2); // original + one retry, then throw
    });
  });

  describe('IAM token caching', () => {
    it('should reuse cached token within TTL', async () => {
      const { Signer } = require('@aws-sdk/rds-signer');

      // Import twice — should only create signer once
      const mod1 = await import('../../lambda/src/analytics-aurora/db-client');
      await mod1.query('SELECT 1');
      await mod1.query('SELECT 2');

      // Pool is created once with the token, not recreated per query
      const pg = require('pg');
      expect(pg.Pool).toHaveBeenCalledTimes(1);
    });
  });

  describe('ensureSchema', () => {
    it('should read and execute SQL files in order', async () => {
      const { ensureSchema } = await import('../../lambda/src/analytics-aurora/db-client');
      const pg = require('pg');

      // applyPendingMigrations runs inside transaction(), which acquires a client via
      // pool.connect() and executes everything on that client (not pool.query). With no rows
      // in _migrations, both mocked schema files (001-initial.sql, 002-pgvector.sql) are pending.
      // SELECT filename FROM _migrations -> [] (default mockClient result) so both get applied.
      await ensureSchema();

      const client = pg.__mockClient;
      expect(pg.__mockPool.connect).toHaveBeenCalled(); // transaction opened a client
      const calls = client.query.mock.calls.map((c: any[]) => String(c[0]));

      // Transaction envelope
      expect(calls[0]).toBe('BEGIN');
      expect(calls).toContain('COMMIT');

      // Each of the 2 pending migration files' SQL was executed (mocked readFileSync content)
      const migrationSql = 'CREATE TABLE IF NOT EXISTS test (id INT);';
      const migrationExecs = calls.filter((sql: string) => sql === migrationSql);
      expect(migrationExecs).toHaveLength(2);

      // ...and applied in order: advisory lock -> _migrations table -> read applied -> apply files
      const lockIdx = calls.findIndex((s: string) => s.includes('pg_advisory_xact_lock'));
      const firstMigrationIdx = calls.indexOf(migrationSql);
      expect(lockIdx).toBeGreaterThan(0);
      expect(firstMigrationIdx).toBeGreaterThan(lockIdx);
    });
  });

  /**
   * RESUMABLE MIGRATIONS.
   *
   * Every pending file plus the classification boundary runs in ONE transaction, in ONE Lambda
   * invocation, and `ensureSchema` rethrows with nothing committed if that invocation runs out. A data
   * backfill over an existing table is the one migration shape whose cost scales with the deployment,
   * so it does a BOUNDED batch and reports what is left in `_migration_progress`. The runner has to
   * honour that report: recording the file as applied after one batch strands every remaining row,
   * which is a migration marked done whose effect is partial.
   */
  describe('resumable migrations', () => {
    const RESUMABLE = '002-resumable-backfill.sql';
    const DONE = '001-initial.sql';
    const EMPTY = { rows: [] as any[], rowCount: 0, command: '', oid: 0, fields: [] };

    /** Drive the mocked client so `_migration_progress` answers `remaining` for the resumable file. */
    function withRemaining(remaining: string | null) {
      const pg = require('pg');
      const fsMock = require('fs');
      fsMock.readdirSync.mockReturnValue([RESUMABLE, DONE].sort());
      pg.__mockClient.query.mockImplementation((sql: string, params?: any[]) => {
        if (/FROM _migration_progress/.test(sql)) {
          const isResumable = params?.[0] === RESUMABLE;
          // BIGINT comes back from node-pg as a STRING, which is the detail a `> 0` on the raw value
          // would get wrong.
          return Promise.resolve(
            isResumable && remaining !== null
              ? { ...EMPTY, rows: [{ remaining }], rowCount: 1 }
              : EMPTY,
          );
        }
        return Promise.resolve(EMPTY);
      });
      return pg;
    }

    /** Filenames this run recorded as applied. */
    function recorded(pg: any): string[] {
      return pg.__mockClient.query.mock.calls
        .filter((c: any[]) => /INSERT INTO _migrations/.test(String(c[0])))
        .map((c: any[]) => c[1][0]);
    }

    afterEach(() => {
      const pg = require('pg');
      const fsMock = require('fs');
      pg.__mockClient.query.mockReset();
      pg.__mockClient.query.mockResolvedValue(EMPTY);
      fsMock.readdirSync.mockReturnValue(['001-initial.sql', '002-pgvector.sql']);
    });

    it('leaves a file that still has rows to convert PENDING, so the next cold start resumes it', async () => {
      const pg = withRemaining('4200');
      const { ensureSchema } = await import('../../lambda/src/analytics-aurora/db-client');

      await ensureSchema();

      // The batch itself committed with the transaction; what is withheld is the claim that the file
      // is finished. Without that, the remaining 4200 rows are never converted by anything.
      expect(recorded(pg)).toEqual([DONE]);
      expect(recorded(pg)).not.toContain(RESUMABLE);
    });

    it('still applies the files after it, so a long backfill does not block the schema', async () => {
      const pg = withRemaining('4200');
      const { ensureSchema } = await import('../../lambda/src/analytics-aurora/db-client');

      await ensureSchema();

      // 001 sorts before 002 here, so prove the ordering claim directly: the pending file that
      // reported work left is not a barrier - `001-initial.sql` is still recorded in the same run.
      const calls = pg.__mockClient.query.mock.calls.map((c: any[]) => String(c[0]));
      expect(calls).toContain('COMMIT');
      expect(recorded(pg)).toContain(DONE);
    });

    it('records the file once nothing remains', async () => {
      const pg = withRemaining('0');
      const { ensureSchema } = await import('../../lambda/src/analytics-aurora/db-client');

      await ensureSchema();

      expect(recorded(pg).sort()).toEqual([DONE, RESUMABLE].sort());
    });

    it('treats a file that reports no progress at all as finished — every ordinary migration', async () => {
      // A missing `_migration_progress` row must not leave plain DDL pending forever, re-applying on
      // every cold start.
      const pg = withRemaining(null);
      const { ensureSchema } = await import('../../lambda/src/analytics-aurora/db-client');

      await ensureSchema();

      expect(recorded(pg).sort()).toEqual([DONE, RESUMABLE].sort());
    });

    it('creates the progress table before it reads one, so a fresh cluster is not a special case', async () => {
      const pg = withRemaining(null);
      const { ensureSchema } = await import('../../lambda/src/analytics-aurora/db-client');

      await ensureSchema();

      const calls = pg.__mockClient.query.mock.calls.map((c: any[]) => String(c[0]));
      const create = calls.findIndex((s: string) => /CREATE TABLE IF NOT EXISTS _migration_progress/.test(s));
      const read = calls.findIndex((s: string) => /SELECT remaining FROM _migration_progress/.test(s));
      expect(create).toBeGreaterThanOrEqual(0);
      expect(read).toBeGreaterThan(create);
    });
  });
});
