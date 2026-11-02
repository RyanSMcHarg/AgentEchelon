/**
 * Operator scripts and e2e helpers name this deployment's stacks through ONE resolver.
 *
 * Every stack id in `bin/backend.ts` is `${STACK_PREFIX}<Name>`, and `resolveStackPrefix` in
 * scripts/lib/stack-lookup.cjs is the one place outside the CDK app that works out the prefix. A
 * script that writes `AgentEchelonIdentity` works only on the default instance: on any other
 * instance it names a stack the deployer never created, and the failure reads as a broken
 * deployment rather than a broken lookup. The same holds for a second resolver that reads
 * `AE_STACK_PREFIX` itself and falls back to its own default, because it ignores the instance-name
 * variables the stacks and the e2e harness actually set.
 *
 * The instance name has the same failure: `/agent-echelon/...` is the default instance's SSM root,
 * and `resolveInstanceName` in the same file is the one place that works out this deployment's. And a
 * resource whose name CloudFormation generates is found by asking its stack
 * (scripts/lib/stack-resources.cjs, tests/e2e/helpers/stack-prefix.ts), never by a name filter on
 * `'AgentEchelon'`: the generated name is cut to fit, and another instance can share any prefix.
 *
 * So this guard refuses, in operator code and e2e code:
 *  - an `AgentEchelon<Name>` literal anywhere but the comments listed in COMMENT_ALLOWLIST,
 *  - reading `AE_STACK_PREFIX` or `STACK_PREFIX` from the environment anywhere but the resolver,
 *  - a `/agent-echelon` SSM-root literal or an `'agent-echelon'` instance default in code, and
 *  - a bare `'AgentEchelon'` string in code (the shape of a name filter), outside CODE_ALLOWLIST.
 *
 * A comment may name the default instance's stacks as an example; code never does. The allowlist
 * is per file with an exact count, so a new occurrence fails, and so does a stale entry. The last two
 * rules read code lines only: a comment that names the default root explains it, and resolves nothing.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Operator scripts and the e2e tree. A root that does not exist in this checkout is skipped. */
const SCAN_ROOTS = ['backend/scripts', 'scripts', 'tests/e2e'];
const SCAN_FILES = ['quickstart.sh'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.sh']);
const SKIP_DIRS = new Set(['node_modules', 'test-results', 'playwright-report']);

/** The resolver itself: the one file that reads the prefix variables and explains the default. */
const RESOLVER = 'backend/scripts/lib/stack-lookup.cjs';

/** `AgentEchelon` followed by a stack name (or a CloudFormation-truncated one). */
const STACK_LITERAL = /AgentEchelon[A-Z][A-Za-z0-9-]*/g;

/** The default instance's SSM root as a literal: `/agent-echelon` then `/`, a quote or the end. Not `/agent-echelon-deny-test`. */
const SSM_ROOT_LITERAL = /\/agent-echelon(?=[/'"`]|$)/;

/** The default instance's name as a whole string, the shape of an `|| 'agent-echelon'` fallback. */
const INSTANCE_DEFAULT = /['"`]agent-echelon['"`]/;

/** `'AgentEchelon'` as a whole string, the shape of a `contains(FunctionName,'AgentEchelon')` filter. */
const BARE_PREFIX = /['"`]AgentEchelon['"`]/;

/** Code that may carry a bare `'AgentEchelon'`, by file, with the exact number of lines. */
const CODE_ALLOWLIST: Record<string, { count: number; why: string }> = {
  'backend/scripts/sync-project-knowledge.mjs': { count: 1, why: 'the product name a knowledge project is labelled with, not a stack prefix' },
};

/** A direct read of the prefix variables, which only the resolver may make. */
const DIRECT_PREFIX_READ = /process\.env(?:\.(?:AE_)?STACK_PREFIX\b|\[\s*['"`](?:AE_)?STACK_PREFIX['"`]\s*\])/;

/**
 * Comments that name the default instance's stacks, by file, with the exact number of occurrences.
 * Each is prose describing what a stack is or does; none is read by code.
 */
const COMMENT_ALLOWLIST: Record<string, { count: number; why: string }> = {
  'backend/scripts/deploy-frontend.mjs': { count: 5, why: 'the header names the two frontend stacks it publishes to' },
  'backend/scripts/gen-frontend-env.mjs': { count: 2, why: 'explains which stack the admin console URL comes from' },
  'backend/scripts/sync-context.mjs': { count: 1, why: 'names the archive stack whose output it reads' },
  'tests/e2e/battle.spec.ts': { count: 1, why: 'the header names the stacks battle mode needs deployed' },
  'tests/e2e/credential-exchange.spec.ts': { count: 1, why: 'the header names the output it reads' },
  'tests/e2e/helpers/battle-setup.ts': { count: 2, why: 'the header and a comment name the battle stack' },
  'backend/scripts/lib/stack-resources.cjs': {
    count: 1,
    why: 'the truncated generated name it quotes is the evidence for reading physical ids from the stack',
  },
};

const isComment = (line: string): boolean => /^(\*|\/\/|\/\*|#)/.test(line.trim());

function scannedFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(child);
      } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(child);
      }
    }
  };
  SCAN_ROOTS.forEach(walk);
  for (const f of SCAN_FILES) if (fs.existsSync(path.join(REPO_ROOT, f))) out.push(f);
  return out;
}

function linesOf(rel: string): string[] {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split(/\r?\n/);
}

describe('stack names come from the one resolver', () => {
  const files = scannedFiles();

  it('scans the operator scripts, the e2e tree and the quickstart', () => {
    // A guard that scans nothing passes everything.
    expect(files).toEqual(expect.arrayContaining([RESOLVER, 'quickstart.sh', 'tests/e2e/helpers/stack-prefix.ts']));
    expect(files.length).toBeGreaterThan(50);
  });

  it('writes no AgentEchelon<Stack> literal outside the allowlisted comments', () => {
    const violations: string[] = [];
    const counts: Record<string, number> = {};
    for (const rel of files) {
      if (rel === RESOLVER) continue;
      linesOf(rel).forEach((line, i) => {
        const hits = line.match(STACK_LITERAL);
        if (!hits) return;
        if (COMMENT_ALLOWLIST[rel] && isComment(line)) {
          counts[rel] = (counts[rel] || 0) + hits.length;
        } else {
          violations.push(`${rel}:${i + 1}: ${hits.join(', ')}`);
        }
      });
    }
    expect(violations).toEqual([]);
    // Exact counts both ways: a new comment occurrence is reviewed, and a fixed one leaves the list.
    const expected = Object.fromEntries(Object.entries(COMMENT_ALLOWLIST).map(([f, v]) => [f, v.count]));
    expect(counts).toEqual(expected);
  });

  it('reads the prefix variables only in the resolver', () => {
    const readers = files.filter((rel) => rel !== RESOLVER)
      .flatMap((rel) => linesOf(rel)
        .map((line, i) => ({ line, at: `${rel}:${i + 1}` }))
        .filter(({ line }) => !isComment(line) && DIRECT_PREFIX_READ.test(line))
        .map(({ at }) => at));
    expect(readers).toEqual([]);
  });

  it('names no SSM root and no instance default in code: both come from resolveInstanceName', () => {
    const found = files.filter((rel) => rel !== RESOLVER)
      .flatMap((rel) => linesOf(rel)
        .map((line, i) => ({ line, at: `${rel}:${i + 1}` }))
        .filter(({ line }) => !isComment(line) && (SSM_ROOT_LITERAL.test(line) || INSTANCE_DEFAULT.test(line)))
        .map(({ at, line }) => `${at}: ${line.trim()}`));
    expect(found).toEqual([]);
  });

  it('filters no resource by a bare AgentEchelon string: resources are read from their stacks', () => {
    const violations: string[] = [];
    const counts: Record<string, number> = {};
    for (const rel of files) {
      if (rel === RESOLVER) continue;
      linesOf(rel).forEach((line, i) => {
        if (isComment(line) || !BARE_PREFIX.test(line)) return;
        if (CODE_ALLOWLIST[rel]) counts[rel] = (counts[rel] || 0) + 1;
        else violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
    expect(counts).toEqual(Object.fromEntries(Object.entries(CODE_ALLOWLIST).map(([f, v]) => [f, v.count])));
  });

  it('every allowlist entry says why', () => {
    for (const [file, entry] of [...Object.entries(COMMENT_ALLOWLIST), ...Object.entries(CODE_ALLOWLIST)]) {
      expect({ file, why: entry.why.trim().length > 10 }).toEqual({ file, why: true });
    }
  });

  it('recognises the shapes it refuses', () => {
    expect('aws cloudformation describe-stacks --stack-name AgentEchelonAdminServices'.match(STACK_LITERAL))
      .toEqual(['AgentEchelonAdminServices']);
    expect("starts_with(RoleName,'AgentEchelonAssistants-p-TypedConversationFromEve')".match(STACK_LITERAL))
      .toEqual(['AgentEchelonAssistants-p-TypedConversationFromEve']);
    expect(DIRECT_PREFIX_READ.test("const P = process.env.AE_STACK_PREFIX || 'AgentEchelon';")).toBe(true);
    expect(DIRECT_PREFIX_READ.test("const P = process.env['STACK_PREFIX'];")).toBe(true);
    expect(DIRECT_PREFIX_READ.test("const P = process.env.AE_DEPLOY_STACK_PREFIX;")).toBe(false);
    expect('`${prefix}Identity`'.match(STACK_LITERAL)).toBeNull();
    expect(SSM_ROOT_LITERAL.test("getParam('/agent-echelon/channel-flow-arn')")).toBe(true);
    expect(SSM_ROOT_LITERAL.test("process.env.SSM_ROOT || '/agent-echelon'")).toBe(true);
    expect(SSM_ROOT_LITERAL.test("const PARAM_PREFIX = '/agent-echelon-deny-test/tag-key-case';")).toBe(false);
    expect(INSTANCE_DEFAULT.test("process.env.AE_INSTANCE_NAME || 'agent-echelon'")).toBe(true);
    expect(INSTANCE_DEFAULT.test("DENY_TEST_SERVICE_ADMIN_ID || 'agent-echelon-admin'")).toBe(false);
    expect(BARE_PREFIX.test("if (!name.includes('AgentEchelon')) continue;")).toBe(true);
    expect(BARE_PREFIX.test("contains(FunctionName,'AgentEchelon')")).toBe(true);
  });
});
