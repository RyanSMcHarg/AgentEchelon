/**
 * A RETIRED STACK NAME IS NAMED NOWHERE BUT THE ONE LIST THAT RECORDS IT.
 *
 * The re-layout renamed every stack (`lib/config/stack-names.json` keeps the old names under `retired`).
 * A tool that still names one does not fail: `describe-stacks` on a stack that no longer exists reads as
 * "not deployed", a helper finds no output and skips, and a validation pass reports green over a check it
 * never made (R10). So a retired name is refused in `backend/` and `tests/` wherever it is used as a stack
 * name: after an interpolated instance prefix (`${prefix}Foundations`), after a literal instance prefix
 * (`AgentEchelonCognitoAuth`), or as the name a stack helper is given (`stackName('Frontend')`).
 *
 * Words that are also construct ids stay legal: `AdminPlane` in `ExchangeRoleAdminPlane` and `Analytics`
 * as the AdminServices nested stack are not stack names, and none of the shapes above matches them.
 * Teardown is the one reader of the retired names, and it reads them from the JSON, never as literals.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NAMES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'config', 'stack-names.json'), 'utf8')) as {
  current: string[];
  retired: string[];
  retiredPerClassification: string[];
};

const SCAN_ROOTS = ['backend/bin', 'backend/lib', 'backend/lambda', 'backend/scripts', 'backend/test', 'tests'];
const SCAN_FILES = ['quickstart.sh'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.sh']);
const SKIP_DIRS = new Set(['node_modules', 'cdk.out', 'test-results', 'playwright-report', 'dist', '.cache']);
/**
 * Files that name retired stacks on purpose: this guard's own recognizer cases, and the teardown's
 * fixture of an instance still on the earlier layout, which is what the teardown must find.
 */
const ALLOWED = new Set(['backend/test/retired-stack-names-are-refused.test.ts', 'backend/test/teardown-plan.test.ts']);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RETIRED = [
  ...NAMES.retired.map(escapeRe),
  ...NAMES.retiredPerClassification.map((f) => `${escapeRe(f)}[A-Za-z0-9]+`),
].join('|');
/** Instance prefixes the suite and the scripts write literally: the default instance, and the test ones. */
const LITERAL_PREFIXES = ['AgentEchelon', 'Acme', 'AeNext', 'AeScratch'];

const SHAPES: Array<{ name: string; re: RegExp }> = [
  { name: 'after an interpolated prefix', re: new RegExp(`\\$\\{[^}]*prefix[^}]*\\}(?:${RETIRED})(?![A-Za-z0-9])`, 'i') },
  { name: 'after a literal prefix', re: new RegExp(`(?:${LITERAL_PREFIXES.join('|')})(?:${RETIRED})(?![A-Za-z0-9])`) },
  { name: 'as a stack helper argument', re: new RegExp(`(?:stackName|stackId)\\(\\s*['"\`](?:${RETIRED})['"\`]`) },
];

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
        // Compiled output beside its TypeScript source says nothing the source does not.
        if (entry.name.endsWith('.js') && fs.existsSync(path.join(abs, entry.name.replace(/\.js$/, '.ts')))) continue;
        out.push(child);
      }
    }
  };
  SCAN_ROOTS.forEach(walk);
  for (const f of SCAN_FILES) if (fs.existsSync(path.join(REPO_ROOT, f))) out.push(f);
  return out.filter((f) => !ALLOWED.has(f));
}

describe('retired stack names are refused', () => {
  const files = scannedFiles();

  it('scans backend/ and tests/', () => {
    // A guard that scans nothing passes everything.
    expect(files).toEqual(expect.arrayContaining(['backend/bin/backend.ts', 'backend/scripts/teardown.mjs', 'tests/e2e/helpers/stack-prefix.ts']));
    expect(files.length).toBeGreaterThan(500);
  });

  it('names no retired stack in code, comments or tests', () => {
    const hits: string[] = [];
    for (const rel of files) {
      fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split(/\r?\n/).forEach((line, i) => {
        for (const shape of SHAPES) {
          const m = line.match(shape.re);
          if (m) hits.push(`${rel}:${i + 1} (${shape.name}): ${m[0]}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('recognizes the shapes it refuses, and leaves construct ids alone', () => {
    const refused = (line: string) => SHAPES.some((s) => s.re.test(line));
    expect(refused('aws cloudformation describe-stacks --stack-name ${STACK_PREFIX}Foundations')).toBe(true);
    expect(refused('const name = `${prefix}CognitoAuth`;')).toBe(true);
    expect(refused('describeStack(`${TARGETS.prefix}Frontend`)')).toBe(true);
    expect(refused('AgentEchelonAnalyticsAurora outputs')).toBe(true);
    expect(refused("isInstanceStack('AcmeClassification-Basic', 'Acme')")).toBe(true);
    expect(refused("stackName('AdminPlane')")).toBe(true);
    expect(refused('`${STACK_PREFIX}Tier-Premium`')).toBe(true);
    // Not stack names.
    expect(refused("new iam.Role(this, 'ExchangeRoleAdminPlane', {")).toBe(false);
    expect(refused("node.findChild('Analytics')")).toBe(false);
    expect(refused('`${prefix}AnalyticsMode`')).toBe(false);
    expect(refused('echo -e "  ${BOLD}Frontend:${NC}"')).toBe(false);
    expect(refused('`${STACK_PREFIX}Meetings`')).toBe(false);
  });

  it('keeps the retired list apart from the current one', () => {
    for (const r of NAMES.retired) expect({ r, current: NAMES.current.includes(r) }).toEqual({ r, current: false });
  });
});
