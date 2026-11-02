/**
 * A PERSON IS THEIR APPINSTANCEUSER, AND ONE FUNCTION SAYS WHICH ONE CALLED.
 *
 * The credential exchange mints each person an opaque AppInstanceUser id, once per (issuer, subject),
 * and that id is never the token's `sub` (`lib/person-identity.ts`). So a handler that reads the
 * caller off its token - `claims.sub`, `cognito:username`, an email, a decoded JWT - names somebody who
 * does not exist in the app instance, and does it without failing: the read returns a string, the
 * string builds an ARN, and the ARN is simply nobody.
 *
 * Who called is answered by `callerPersonId` in `backend/lambda/src/lib/auth.ts`, the one resolver.
 * This guard refuses, in code lines (comments explain the shape and are not read):
 *
 *  - a read of `requestContext.authorizer` (the claims, or anything else the authorizer attached),
 *  - `claims.sub` / `claims['sub']`, `claims.email` / `claims['email']`,
 *  - `cognito:username` and `cognito:groups`,
 *  - a JWT decode: `jwtDecode`, the `jwt-decode` package, `atob(`, or a decoded `payload.sub`,
 *
 * anywhere outside the resolver and the credential exchanges. Every person route is behind the edge
 * authorizer (`lambda/src/edge-authorizer.ts`), which verifies the token through `aws-jwt-verify`, reads
 * claims only by the names the registry declares, and hands the gateway a context naming the issuer, the
 * subject and the person; it holds none of these shapes and is scanned too. The resolver (`lib/auth.ts`)
 * is the one reader of that context, and the person exchange (with the token half it shares with the
 * admin exchange, `lib/vend.ts`) reads the display claims a first sign-in mints a person with.
 *
 * A KEY SAYS WHAT IT HOLDS. A person is stored and passed as `personId` (`person_id` in SQL), because
 * what it holds is their AppInstanceUser id. `userSub` named a Cognito `sub`, which no person key holds,
 * so a new `userSub` identifier is refused too, here and in `backend/lib` and `backend/bin`. The files
 * that still carry one are listed with an exact count of code lines, and the count only goes down.
 *
 * It scans `backend/lambda`, `backend/scripts`, `scripts` and `frontend/packages`. Test files are not
 * scanned: a fixture claim is data the test asserts against. The allowlist is per file with an exact
 * count, so a new read fails and so does a stale entry, and each canonical file must still hold a read,
 * so a moved resolver cannot leave this guard passing over nothing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripComments } from './helpers/strip-comments';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SCAN_ROOTS = ['backend/lambda', 'backend/scripts', 'scripts', 'frontend/packages'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'test-results', 'cdk.out']);

/**
 * The resolver, which reads the edge authorizer's context, and the person exchange: the only code that
 * reads what a verified token says about a person. One person exchange serves every issuer; the admin
 * exchange reads the person it minted and turns no token into one.
 */
const CANONICAL = new Set([
  'backend/lambda/src/lib/auth.ts',
  'backend/lambda/src/credential-exchange.ts',
  // The token half the two exchanges share (the caller, the display name a first sign-in carries).
  'backend/lambda/src/lib/vend.ts',
]);

/** What legitimately remains, by file, with the exact number of offending lines. */
const ALLOWLIST: Record<string, { count: number; why: string }> = {
  'backend/lambda/src/lib/trusted-issuers.ts': {
    count: 1,
    why: 'the registry a function with no TRUSTED_ISSUERS reads names its pool\'s default groups claim; it reads no token',
  },
  'frontend/packages/shared/src/services/idTokenClaims.ts': {
    count: 1,
    why: "the client's one token decode, for the email and name it shows, the classification it gates UI on, and the expiry it refreshes by; who the person is comes from the exchange",
  },
  'backend/scripts/deny-test-offboarded-sign-in.mjs': {
    count: 1,
    why: 'the deny-test re-admits its own host-pool fixture after offboarding it, which is keyed by the issuer and subject of that fixture\'s token; it resolves nobody',
  },
};

/** One refused shape, named so a failure says which rule a line broke. */
export const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'authorizer read', re: /requestContext\s*\??\.\s*authorizer\b/ },
  { name: 'claims.sub', re: /\bclaims\s*\??\.\s*sub\b|\bclaims\s*\??\.?\s*\[\s*['"`]sub['"`]\s*\]/ },
  { name: 'claims.email', re: /\bclaims\s*\??\.\s*email\b|\bclaims\s*\??\.?\s*\[\s*['"`]email['"`]\s*\]/ },
  { name: 'cognito:username', re: /cognito:username/ },
  { name: 'cognito:groups', re: /cognito:groups/ },
  { name: 'JWT decode', re: /\bjwtDecode\b|['"`]jwt-decode['"`]|\batob\s*\(|\bpayload\s*\??\.\s*sub\b/ },
];

const isTestFile = (rel: string): boolean =>
  /\.test\.[cm]?[jt]sx?$/.test(rel) || /\.spec\.[cm]?[jt]sx?$/.test(rel) || rel.includes('/__tests__/') || rel.includes('/test/');

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

/** The code lines of a source that read a caller's identity off a token, each with the rule it broke. */
export function offendingLines(source: string): string[] {
  const hits: string[] = [];
  for (const line of stripComments(source).split('\n')) {
    // A comment line whose block opener sits on an earlier line is still a comment.
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
    const broken = PATTERNS.filter((p) => p.re.test(line)).map((p) => p.name);
    if (broken.length) hits.push(`[${broken.join(', ')}] ${line.trim()}`);
  }
  return hits;
}

function scan(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const root of SCAN_ROOTS) {
    for (const file of listFiles(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      if (isTestFile(rel)) continue;
      const hits = offendingLines(fs.readFileSync(file, 'utf8'));
      if (hits.length) found.set(rel, hits);
    }
  }
  return found;
}

/** Where a `userSub` identifier still stands, by file, with the exact number of code lines. */
const USER_SUB_ALLOWLIST: Record<string, { count: number; why: string }> = {
  'backend/lambda/src/user-feedback.ts': { count: 7, why: 'the feedback record\'s `userSub` attribute; feedback is kept when a person is offboarded' },
  'backend/lambda/src/analytics-aurora/variant-feedback.ts': { count: 7, why: 'reads the feedback record\'s `userSub` attribute' },
  'backend/lambda/src/analytics-aurora/analytics-query.ts': { count: 3, why: 'reads the feedback record\'s `userSub` attribute' },
};

const USER_SUB_ROOTS = [...SCAN_ROOTS, 'backend/lib', 'backend/bin'];
const USER_SUB = /\buserSub\b/;

/** The code lines of a source that name `userSub`. */
export function userSubLines(source: string): string[] {
  return stripComments(source).split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line) && USER_SUB.test(line))
    .map((line) => line.trim());
}

describe('a person key says it is a person', () => {
  const found = new Map<string, string[]>();
  for (const root of USER_SUB_ROOTS) {
    for (const file of listFiles(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      if (isTestFile(rel)) continue;
      const hits = userSubLines(fs.readFileSync(file, 'utf8'));
      if (hits.length) found.set(rel, hits);
    }
  }

  it('no new `userSub` identifier: a person key is `personId`', () => {
    const unexpected: string[] = [];
    for (const [rel, hits] of found) {
      const allowed = USER_SUB_ALLOWLIST[rel];
      if (!allowed || hits.length !== allowed.count) {
        unexpected.push(`${rel} (${hits.length}${allowed ? `, allowlisted ${allowed.count}` : ''}):\n    ${hits.join('\n    ')}`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it('every `userSub` allowlist entry still matches, so a stale one is removed', () => {
    expect(Object.keys(USER_SUB_ALLOWLIST).filter((rel) => !found.has(rel))).toEqual([]);
  });

  it('recognizes the name and not a longer one', () => {
    expect(userSubLines('const userSub = personIdFromArn(arn);')).toHaveLength(1);
    expect(userSubLines('  userSub: string;')).toHaveLength(1);
    expect(userSubLines('const initiatorUserSub = x; const personId = y;')).toEqual([]);
    expect(userSubLines(' * the key used to be `userSub`')).toEqual([]);
  });
});

describe('a person is their AppInstanceUser, resolved in one place', () => {
  const found = scan();

  it('no source outside the resolver and the exchanges reads a caller off their token', () => {
    const unexpected: string[] = [];
    for (const [rel, hits] of found) {
      if (CANONICAL.has(rel)) continue;
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

  it('the resolver and the exchanges are where this guard says they are, and still read the token', () => {
    for (const rel of CANONICAL) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
      expect(found.get(rel)?.length ?? 0).toBeGreaterThan(0);
    }
    const resolver = fs.readFileSync(path.join(REPO_ROOT, 'backend/lambda/src/lib/auth.ts'), 'utf8');
    expect(resolver).toMatch(/export async function callerPersonId\(/);
  });

  describe('recognizes each refused shape', () => {
    const fixtures: Array<[string, string]> = [
      ['authorizer read', 'const claims = event.requestContext?.authorizer?.claims || {};'],
      ['authorizer read', 'const ctx = event.requestContext.authorizer;'],
      ['claims.sub', 'const sub = claims.sub;'],
      ['claims.sub', "const sub = claims?.['sub'];"],
      ['claims.sub', 'const actor = auth.claims.sub || null;'],
      ['claims.email', 'const email = claims.email ?? null;'],
      ['claims.email', "const email = claims['email'];"],
      ['cognito:username', "const u = c['cognito:username'];"],
      ['cognito:groups', "const g = parseGroups(c['cognito:groups']);"],
      ['JWT decode', "import { jwtDecode } from 'jwt-decode';"],
      ['JWT decode', "const payload = JSON.parse(atob(token.split('.')[1]));"],
      ['JWT decode', 'const id = payload?.sub;'],
    ];
    it.each(fixtures)('%s: %s', (rule, line) => {
      const hits = offendingLines(line);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain(rule);
    });
  });

  it('lets the resolver call, a type declaration and a comment through', () => {
    expect(offendingLines('const personId = await callerPersonId(event);')).toEqual([]);
    expect(offendingLines('  requestContext?: { authorizer?: { claims?: Record<string, unknown> } };')).toEqual([]);
    expect(offendingLines(' * the caller used to be `claims.sub` from `requestContext.authorizer`')).toEqual([]);
    expect(offendingLines('// cognito:groups is read by the resolver')).toEqual([]);
    expect(offendingLines('if (payload.subjectDecision === undefined) return;')).toEqual([]);
  });
});
