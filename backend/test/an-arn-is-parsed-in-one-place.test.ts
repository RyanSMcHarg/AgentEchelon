/**
 * An app-instance principal ARN is read and built in ONE place per runtime.
 *
 * A person's ARN is `<appInstanceArn>/user/<id>` and an assistant's is `<appInstanceArn>/bot/<id>`.
 * Parsing that inline (`arn.split('/user/').pop()`) gave each call site its own answer for a bot ARN or
 * a malformed one: one returned the whole ARN as the "id", one returned undefined, one returned ''.
 * Building it inline (`${appInstanceArn}/user/${sub}`) spread the choice of WHAT the id is across every
 * handler, so changing it meant finding every copy. The helpers are:
 *
 *  - `backend/lambda/src/lib/person-arn.ts` for the Lambdas, the CDK app and the TypeScript scripts,
 *  - `backend/scripts/lib/person-arn.cjs` for the `.mjs`/`.cjs` operator scripts,
 *  - `frontend/packages/shared/src/utils/principalArn.ts` for the frontend packages.
 *
 * This guard refuses, in code lines (comments explain the shape and are not read):
 *  - `.split('/user/')` or `.split('/bot/')`,
 *  - a template or concatenation that builds a `/user/` or `/bot/` ARN (`}/user/`, `+ '/user/'`),
 *  - a whole `'/user/'` or `'/bot/'` string anywhere but an `.includes(...)` kind test, which is the
 *    shape of a hand-rolled `indexOf` parser.
 *
 * Test files are not scanned: a fixture ARN is data the test asserts against, not a parser. The
 * allowlist is per file with an exact count, so a new occurrence fails, and so does a stale entry.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SCAN_ROOTS = ['backend/lambda', 'backend/scripts', 'frontend/packages'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'test-results', 'cdk.out']);

/** The helpers themselves: the one place in each runtime that holds the segment strings. */
const HELPERS = new Set([
  'backend/lambda/src/lib/person-arn.ts',
  'backend/scripts/lib/person-arn.cjs',
  'frontend/packages/shared/src/utils/principalArn.ts',
]);

/** What legitimately remains, by file, with the exact number of offending lines. */
const ALLOWLIST: Record<string, { count: number; why: string }> = {
  // Empty: SQL that reads stored ARNs builds its parse from personIdSql / botIdSql in the helper.
};

const SPLIT = /\.split\(\s*['"`]\/(?:user|bot)\/['"`]\s*\)/;
const TEMPLATE_BUILD = /\}\/(?:user|bot)\//;
const CONCAT_BUILD = /\+\s*['"`]\/(?:user|bot)\/|['"`]\/(?:user|bot)\/['"`]\s*\+/;
const WHOLE_LITERAL = /['"`]\/(?:user|bot)\/['"`]/g;
const INCLUDES_LITERAL = /\.includes\(\s*['"`]\/(?:user|bot)\/['"`]\s*\)/g;

const isComment = (line: string): boolean => /^(\*|\/\/|\/\*)/.test(line.trim());
const isTestFile = (rel: string): boolean => /\.test\.[cm]?[jt]sx?$/.test(rel) || rel.includes('/__tests__/') || rel.includes('/test/');

function listFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) listFiles(path.join(dir, entry.name), out);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!SCAN_EXTENSIONS.has(ext) || entry.name.endsWith('.d.ts')) continue;
    const full = path.join(dir, entry.name);
    // A `.js` beside its `.ts` is the compiler's output, not a source file.
    if (ext === '.js' && fs.existsSync(full.slice(0, -3) + '.ts')) continue;
    out.push(full);
  }
  return out;
}

/** The code lines of a file that parse or build a principal ARN inline. */
export function offendingLines(source: string): string[] {
  const hits: string[] = [];
  for (const line of source.split('\n')) {
    if (isComment(line)) continue;
    const literals = (line.match(WHOLE_LITERAL) || []).length - (line.match(INCLUDES_LITERAL) || []).length;
    if (SPLIT.test(line) || TEMPLATE_BUILD.test(line) || CONCAT_BUILD.test(line) || literals > 0) hits.push(line.trim());
  }
  return hits;
}

function scan(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const root of SCAN_ROOTS) {
    for (const file of listFiles(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      if (HELPERS.has(rel) || isTestFile(rel)) continue;
      const hits = offendingLines(fs.readFileSync(file, 'utf8'));
      if (hits.length) found.set(rel, hits);
    }
  }
  return found;
}

describe('an app-instance principal ARN is parsed and built in one place', () => {
  const found = scan();

  it('no source file outside the helpers splits or builds a /user/ or /bot/ ARN inline', () => {
    const unexpected: string[] = [];
    for (const [rel, hits] of found) {
      const allowed = ALLOWLIST[rel];
      if (!allowed || hits.length !== allowed.count) {
        unexpected.push(`${rel} (${hits.length}${allowed ? `, allowlisted ${allowed.count}` : ''}):\n    ${hits.join('\n    ')}`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it('every allowlist entry still matches, so a stale one is removed', () => {
    const stale = Object.keys(ALLOWLIST).filter((rel) => !found.has(rel));
    expect(stale).toEqual([]);
  });

  it('the helpers exist where this guard says they do', () => {
    for (const rel of HELPERS) expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
  });

  it('recognizes each refused shape and lets a kind test through', () => {
    expect(offendingLines("const id = arn.split('/user/').pop() || '';")).toHaveLength(1);
    expect(offendingLines("const id = arn.split('/bot/')[1];")).toHaveLength(1);
    expect(offendingLines('const arn = `${APP_INSTANCE_ARN}/user/${sub}`;')).toHaveLength(1);
    expect(offendingLines("const arn = APP_INSTANCE_ARN + '/user/' + sub;")).toHaveLength(1);
    expect(offendingLines("const marker = '/user/';")).toHaveLength(1);
    expect(offendingLines("if (arn.includes('/bot/')) return;")).toHaveLength(0);
    expect(offendingLines(' * the ARN is `${appInstanceArn}/user/${id}`')).toHaveLength(0);
  });
});
