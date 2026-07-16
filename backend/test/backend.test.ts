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
    { path: 'create-conversation/index.js', exportName: 'handler' },
    { path: 'add-agent-to-conversation/index.js', exportName: 'handler' },
    { path: 'share-conversation/index.js', exportName: 'handler' },
  ];

  const tsHandlers = [
    // Single shared Lex-fulfillment handler for ALL tiers (deployed per-tier via TIER=<tier>).
    // The former per-tier {basic,standard,premium}-agent-handler.ts were divergent copies —
    // basic's was actually deployed (a bug: no tasks), the other two pure dead code. Retired.
    'src/router-agent-handler.ts',
    'src/basic-async-processor.ts',
    'src/standard-async-processor.ts',
    'src/premium-async-processor.ts',
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

    it.each(['001-initial.sql', '002-pgvector.sql', '003-materialized-views.sql'])(
      '%s exists',
      (file) => {
        expect(fs.existsSync(path.join(schemaDir, file))).toBe(true);
      }
    );
  });
});
