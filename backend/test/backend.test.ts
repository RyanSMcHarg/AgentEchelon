/**
 * Backend Stack Integration Smoke Tests
 *
 * Verifies that all Lambda handler entry points exist and export a handler function.
 * Does not test Lambda logic (covered by individual test files).
 */

import * as fs from 'fs';
import * as path from 'path';

describe('Lambda handler entry points', () => {
  const lambdaRoot = path.join(__dirname, '..', 'lambda');

  const jsHandlers = [
    { path: 'cognito-triggers/post-confirmation.js', exportName: 'handler' },
    { path: 'cognito-triggers/pre-authentication.js', exportName: 'handler' },
    { path: 'presigned-url/index.js', exportName: 'handler' },
    { path: 'share-conversation/index.js', exportName: 'handler' },
  ];

  const tsHandlers = [
    // The person-facing create path. Was `create-conversation/index.js`, raw JS deployed with
    // `Code.fromAsset`; bundled now so it can import the registry and the canonical creator (ADR-053).
    'src/create-conversation.ts',
    // Single shared Lex-fulfillment handler for ALL tiers (deployed per-tier via TIER=<tier>).
    // The former per-tier {basic,standard,premium}-agent-handler.ts were divergent copies —
    // basic's was actually deployed (a bug: no tasks), the other two pure dead code. Retired.
    'src/router-agent-handler.ts',
    // One config-driven async processor for every profile (SPEC-CAPABILITY-PROFILES). The former
    // per-tier {basic,standard,premium}-async-processor.ts were a divergent union — collapsed here,
    // with /battle gated by profile.battleEligible and the task loop wired for every profile.
    'src/assistant-async-processor.ts',
    'src/analytics-aurora/analytics-query.ts',
    'src/analytics-aurora/kinesis-archival.ts',
    'src/analytics-aurora/schema-init.ts',
    'src/analytics-aurora/iam-auth-setup.ts',
    'src/evaluation/evaluation-runner.ts',
    // Bedrock-Agent action-groups are not part of the codebase; the
    // per-tier async-processor self-hosted Converse loop is the response path.
    'src/channel-flow-processor.ts',
  ];

  const tsLibs = [
    'src/lib/intent-classifier.ts',
    'src/lib/delivery-options.ts',
    'src/lib/async-processor-core.ts',
    'src/lib/task-tracking.ts',
  ];

  describe('JavaScript handlers exist on disk', () => {
    it.each(jsHandlers)('$path exists', ({ path: handlerPath }) => {
      const fullPath = path.join(lambdaRoot, handlerPath);
      expect(fs.existsSync(fullPath)).toBe(true);
    });
  });

  describe('TypeScript handlers exist on disk', () => {
    it.each(tsHandlers)('%s exists', (handlerPath) => {
      const fullPath = path.join(lambdaRoot, handlerPath);
      expect(fs.existsSync(fullPath)).toBe(true);
    });
  });

  describe('Shared library modules exist on disk', () => {
    it.each(tsLibs)('%s exists', (libPath) => {
      const fullPath = path.join(lambdaRoot, libPath);
      expect(fs.existsSync(fullPath)).toBe(true);
    });
  });

  describe('JavaScript handlers are not empty', () => {
    it.each(jsHandlers)('$path has content', ({ path: handlerPath }) => {
      const fullPath = path.join(lambdaRoot, handlerPath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      // Must have at least 10 lines (not a stub)
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(10);
    });
  });

  describe('JavaScript handlers export handler function', () => {
    it.each(jsHandlers)('$path exports handler', ({ path: handlerPath }) => {
      const fullPath = path.join(lambdaRoot, handlerPath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      expect(content).toMatch(/exports\.handler\s*=|module\.exports.*handler/);
    });
  });

  describe('TypeScript handlers export handler function', () => {
    it.each(tsHandlers)('%s exports handler', (handlerPath) => {
      const fullPath = path.join(lambdaRoot, handlerPath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      expect(content).toMatch(/export\s+(async\s+)?function\s+handler|export\s+const\s+handler/);
    });
  });

  describe('Aurora schema files exist', () => {
    const schemaDir = path.join(lambdaRoot, 'src/analytics-aurora/schema');

    it('schema directory exists', () => {
      expect(fs.existsSync(schemaDir)).toBe(true);
    });

    it.each(['001-initial.sql', '002-pgvector.sql'])(
      '%s exists',
      (file) => {
        expect(fs.existsSync(path.join(schemaDir, file))).toBe(true);
      }
    );

    // SPEC-AURORA-VPC-MODE FR24 (declined): every dashboard figure is a live query, so the schema holds
    // no materialized rollup with a second definition of the same number.
    describe('no materialized rollups (FR24)', () => {
      const sqlOnly = (s: string): string => s.replace(/--[^\n]*/g, '');
      const schemaFiles = (): string[] => fs.readdirSync(schemaDir).filter((f) => f.endsWith('.sql')).sort();

      it('072-no-materialized-rollups.sql drops daily_metrics, agent_performance and drift_summary', () => {
        const file = path.join(schemaDir, '072-no-materialized-rollups.sql');
        expect(fs.existsSync(file)).toBe(true);
        const sql = sqlOnly(fs.readFileSync(file, 'utf8'));
        for (const view of ['daily_metrics', 'agent_performance', 'drift_summary']) {
          expect(sql).toMatch(new RegExp(`DROP\\s+MATERIALIZED\\s+VIEW\\s+IF\\s+EXISTS\\s+${view}\\s*;`, 'i'));
        }
      });

      it('no schema file creates a materialized view', () => {
        const files = schemaFiles();
        // A check that scans nothing passes forever.
        expect(files.length).toBeGreaterThan(60);
        const creators = files.filter((f) =>
          /CREATE\s+(?:OR\s+REPLACE\s+)?MATERIALIZED\s+VIEW/i.test(sqlOnly(fs.readFileSync(path.join(schemaDir, f), 'utf8'))));
        expect(creators).toEqual([]);
      });

      it('detects a materialized view when one is created, proving the check can fail', () => {
        expect(/CREATE\s+(?:OR\s+REPLACE\s+)?MATERIALIZED\s+VIEW/i.test(sqlOnly('CREATE MATERIALIZED VIEW IF NOT EXISTS x AS SELECT 1;'))).toBe(true);
        expect(/CREATE\s+(?:OR\s+REPLACE\s+)?MATERIALIZED\s+VIEW/i.test(sqlOnly('-- CREATE MATERIALIZED VIEW x\n'))).toBe(false);
      });
    });
  });
});
