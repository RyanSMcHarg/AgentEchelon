/**
 * A CLASSIFICATION IS DECLARED CONFIGURATION, AND NO CODE NAMES THE SAMPLE'S. Each
 * classification is independent of the others.
 *
 * The shipped sample declares `basic`, `standard` and `premium`. A deployment declares its own set
 * (`profiles` in deploy.config.json), which may share no name with the sample, so runtime code, the CDK app,
 * the operator scripts and the frontends read which classifications exist from the registry
 * (`ProfileRegistry`, the `Classifications` output on the client) and never from a literal. A literal is a
 * classification frozen into code: a union narrows a value the registry has not checked, a map keyed by the
 * sample's names misses every other deployment's, and a default of `basic` answers for a classification
 * nobody chose.
 *
 * WHAT IS SCANNED: the source under the roots below, with comments removed, for a string literal that IS one
 * of the sample's names, an object key named after one, or a member access on one. Text that merely mentions
 * a name inside a longer string is not a classification value and is not flagged.
 *
 * WHAT IS EXEMPT, and the only way to silence this: a file in `EXEMPT` with its reason. Each one is the sample
 * itself: its configuration, its seed data, and the checks and fixtures that exercise it. The model catalog
 * names no classification, so it is not exempt (each classification selects its own models).
 *
 * The companion proof that the paths these literals used to sit on work for a deployment of other names is
 * `a-deployment-of-other-names-runs-on-its-own-classifications.test.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { excludeIgnored } from './helpers/shipped-files';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SAMPLE_NAMES = ['basic', 'standard', 'premium'] as const;

const SCAN_ROOTS = [
  'backend/lambda/src',
  'backend/lambda/share-conversation',
  'backend/lambda/cognito-triggers',
  'backend/lib',
  'backend/bin',
  'backend/scripts',
  ...fs.readdirSync(path.join(REPO_ROOT, 'frontend', 'packages')).map((p) => `frontend/packages/${p}/src`),
];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

/** Repo-relative path -> why it may name the sample's classifications. */
const EXEMPT: Record<string, string> = {
  'backend/lib/config/profiles.ts': 'THE SAMPLE CONFIGURATION: the shipped catalog declares its classifications here.',
  'backend/lib/config/conversation-types.ts':
    'The shipped conversation-type catalog, sample configuration: a type naming a classification a deployment does not declare is served nowhere (`typeIsServed`).',
  'frontend/packages/shared/src/config/sampleClassifications.ts': 'A test fixture: the sample deployment as the backend publishes it.',
  'backend/lib/docs/api-contract.ts': 'Synthesizes the sample deployment to generate the published API contract.',
  'backend/scripts/seed-demo.ts': 'SEED DATA: the sample deployment\'s demo content and assistants.',
  'backend/scripts/sync-project-knowledge.mjs': 'SEED DATA: writes the sample\'s platform knowledge under its classifications.',
  'backend/scripts/lib/demo-cast.cjs': 'The sample deployment\'s demo cast, each person at a sample classification.',
  'backend/scripts/provision-test-users.mjs': 'The sample deployment\'s test identities, one per sample classification.',
  'backend/scripts/validate-tier-context.ts': 'A deployed check of the sample: what each sample classification may read.',
};
/** Deployed deny checks: each exercises the sample deployment's boundary with its classifications. */
const EXEMPT_PREFIXES: Array<{ prefix: string; why: string }> = [
  { prefix: 'backend/scripts/deny-test-', why: 'A deployed deny check of the sample deployment\'s classification boundary.' },
];

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__' || entry.name === 'test') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name)) && !/\.test\.|\.spec\.|\.d\.ts$/.test(entry.name)) out.push(full);
  }
}

/** The tracked source files under the scan roots: a compiled `.js` beside its `.ts` is gitignored and dropped. */
function sourceFiles(): string[] {
  const all: string[] = [];
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root), all);
  return excludeIgnored(all, REPO_ROOT);
}

/**
 * The source as code and string literals, comments removed. A small lexer rather than a regex, because a
 * classification can sit in a string that holds `//` or `/*` and a regex stripper would erase it.
 */
export function lex(src: string): { code: string; strings: string[] } {
  let code = '';
  const strings: string[] = [];
  let i = 0;
  const n = src.length;
  const readQuoted = (q: string): string => {
    let s = '';
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') { s += src[i + 1] ?? ''; i += 2; continue; }
      if (src[i] === '\n') break;
      s += src[i++];
    }
    i++;
    return s;
  };
  const readTemplate = (): string => {
    let s = '';
    i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { s += src[i + 1] ?? ''; i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') {
        let depth = 1;
        i += 2;
        let expr = '';
        while (i < n && depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') { depth--; if (depth === 0) break; }
          expr += src[i++];
        }
        i++;
        const inner = lex(expr);
        code += ` ${inner.code} `;
        strings.push(...inner.strings);
        s += '\u0000';
        continue;
      }
      s += src[i++];
    }
    i++;
    return s;
  };
  // A `/` starts a regex literal after these (or at the start); after anything else it is division.
  const regexMayFollow = (): boolean => /(^|[=(,:;!&|?{}[\]+\-*%<>~^]|\breturn|\btypeof|\bcase)\s*$/.test(code.slice(-20));
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; code += ' '; continue; }
    if (c === '\'' || c === '"') { strings.push(readQuoted(c)); code += ' "" '; continue; }
    if (c === '`') { strings.push(readTemplate()); code += ' "" '; continue; }
    if (c === '/' && regexMayFollow()) {
      i++;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        i++;
      }
      i++;
      code += ' /re/ ';
      continue;
    }
    code += c;
    i++;
  }
  return { code, strings };
}

const NAME = SAMPLE_NAMES.join('|');
const KEY = new RegExp(`(?:^|[{,\\s])(${NAME})\\??\\s*:(?!:)`, 'm');
const MEMBER = new RegExp(`\\.(${NAME})\\b`);

/** Every way a file's code names a sample classification, as short findings. */
function findings(src: string): string[] {
  const { code, strings } = lex(src);
  const found: string[] = [];
  for (const s of strings) if ((SAMPLE_NAMES as readonly string[]).includes(s)) found.push(`'${s}'`);
  for (const line of code.split('\n')) {
    const key = line.match(KEY);
    if (key) found.push(`key ${key[1]}:`);
    const member = line.match(MEMBER);
    if (member) found.push(`.${member[1]}`);
  }
  return found;
}

function exemption(rel: string): string | undefined {
  return EXEMPT[rel] ?? EXEMPT_PREFIXES.find((e) => rel.startsWith(e.prefix))?.why;
}

describe('no runtime, CDK, script or frontend code names a sample classification', () => {
  const files = sourceFiles();

  it('scans the source it means to', () => {
    // A scan that found nothing to read would pass vacuously.
    expect(files.length).toBeGreaterThan(300);
    const rels = files.map((f) => path.relative(REPO_ROOT, f).replace(/\\/g, '/'));
    for (const must of ['backend/lambda/src/router-agent-handler.ts', 'backend/lambda/src/lib/company-context.ts', 'frontend/packages/chat/src/utils/greeting.ts', 'backend/lambda/cognito-triggers/post-confirmation.js']) {
      expect(rels).toContain(must);
    }
  });

  it('finds none outside the sample configuration, its seeds and the checks that exercise it', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      if (exemption(rel)) continue;
      const found = findings(fs.readFileSync(file, 'utf8'));
      if (found.length) offenders.push(`${rel}: ${[...new Set(found)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('exempts only files that exist and still name one', () => {
    // An exemption whose file no longer names a sample classification is a hole waiting for the next one.
    for (const rel of Object.keys(EXEMPT)) {
      const full = path.join(REPO_ROOT, rel);
      expect({ rel, exists: fs.existsSync(full) }).toEqual({ rel, exists: true });
      expect({ rel, names: findings(fs.readFileSync(full, 'utf8')).length > 0 }).toEqual({ rel, names: true });
    }
  });

  it('sees a literal in a string, a key and a member access, and not a word in prose or a comment', () => {
    expect(findings('const a = \'premium\';')).toEqual(['\'premium\'']);
    expect(findings('type T = "basic" | "standard";')).toEqual(['\'basic\'', '\'standard\'']);
    expect(findings('const m = { basic: 1 };')).toEqual(['key basic:']);
    expect(findings('x = sel.premium;')).toEqual(['.premium']);
    expect(findings('const u = `context/${c}/`;')).toEqual([]);
    expect(findings('// a basic room\nconst s = \'a basic room\';\n/* premium */')).toEqual([]);
    expect(findings('const r = /premium/; const s = "http://x"; const t = \'basic\';')).toEqual(['\'basic\'']);
  });
});
