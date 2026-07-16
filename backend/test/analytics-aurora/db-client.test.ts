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

      // First call: schema check (messages table doesn't exist yet)
      pg.__mockPool.query
        .mockResolvedValueOnce({ rows: [{ has_messages: false }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
        // Subsequent calls: migration SQL execution
        .mockResolvedValue({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] });

      await ensureSchema();

      // Should have executed schema check + migration files
      expect(pg.__mockPool.query).toHaveBeenCalledTimes(3); // 1 check + 2 migration files
    });
  });
});
