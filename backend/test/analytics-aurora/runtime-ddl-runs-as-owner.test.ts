/**
 * Runtime DDL must run as the OWNER, never on the runtime connection.
 *
 * WHY THIS GUARD EXISTS, AND WHAT IT COST TO LEARN. ADR-028 gives the Lambdas a dedicated runtime user
 * (`ae_app`) that deliberately holds no `CREATE` on schema `public`. Schema belongs in
 * `schema/NNN-*.sql`, applied by the owner - but `schema-init` is Create-only and can never reconnect,
 * so a handful of sites have historically ensured a table at RUNTIME with `CREATE TABLE IF NOT EXISTS`.
 *
 * The moment the runtime user shipped, every one of those sites started failing with
 * `permission denied for schema public`. That is the separation working exactly as intended; the bug is
 * issuing DDL on a connection that must not have it.
 *
 * **It shipped, and nothing caught it.** The unit suite was green, `tsc` was clean, and a 38-test live
 * e2e phase passed - because the affected op (`adminListMessages`, via `ensureModerationTable`) is
 * exercised by the `governance` phase, not the `user` phase. It surfaced only when someone queried the
 * archive directly. A failure that needs the right op to be called is exactly the kind that hides.
 *
 * So this test does not assert behaviour; it asserts SHAPE, over the whole source tree, because the
 * next such site will be added by someone who has never read ADR-028.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '../../lambda/src');

/** DDL that requires privileges the runtime user does not have. */
const DDL = /\b(CREATE\s+TABLE|CREATE\s+INDEX|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+OR\s+REPLACE\s+FUNCTION)\b/i;

/**
 * Files exempt, each for a stated reason rather than because it was inconvenient:
 *  - `schema/`            the migrations themselves, applied by the owner.
 *  - `db-client.ts`       owns `applyPendingMigrations` and the boundary bootstrap, both on the owner pool.
 *  - `schema-init.ts`     the CFN custom resource: password auth, separate connection, Create-only.
 *  - `classification-boundary-sql.ts` a pure string generator; it executes nothing.
 */
const EXEMPT = [
  `${path.sep}schema${path.sep}`,
  'db-client.ts',
  'schema-init.ts',
  'classification-boundary-sql.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { walk(full, out); continue; }
    if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Strip comments so prose ABOUT DDL is not mistaken for DDL. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

describe('runtime DDL', () => {
  it('is issued through ownerQuery, never on the runtime connection', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      if (EXEMPT.some((e) => file.includes(e))) continue;
      const body = stripComments(fs.readFileSync(file, 'utf-8'));
      if (!DDL.test(body)) continue;

      // The DDL is fine as long as this file routes it through the owner connection. Checked at file
      // granularity deliberately: a file that mixes `query()` and `ownerQuery()` DDL is exactly the
      // ambiguity worth a human look, and the list below is short enough to review by hand.
      if (!/\bownerQuery\s*\(/.test(body)) {
        const rel = path.relative(SRC, file).replace(/\\/g, '/');
        const stmt = (body.match(DDL) || [''])[0];
        offenders.push(
          `${rel} issues ${stmt.toUpperCase()} but never calls ownerQuery(). As \`ae_app\` this fails `
          + 'with "permission denied for schema public". Move it to a schema/NNN-*.sql migration, or '
          + 'run it via ownerQuery() if it must stay a runtime ensure.',
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('detects a violation — proving the guard can fail', () => {
    // The check above passes today, which is indistinguishable from a broken matcher. Run the same
    // logic over a synthetic file that has the defect, and over one that does not.
    const bad = stripComments(`
      import { query } from './db-client.js';
      await query(\`CREATE TABLE IF NOT EXISTS widgets (id UUID PRIMARY KEY)\`);
    `);
    expect(DDL.test(bad)).toBe(true);
    expect(/\bownerQuery\s*\(/.test(bad)).toBe(false);

    const good = stripComments(`
      import { ownerQuery } from './db-client.js';
      await ownerQuery(\`CREATE TABLE IF NOT EXISTS widgets (id UUID PRIMARY KEY)\`);
    `);
    expect(DDL.test(good)).toBe(true);
    expect(/\bownerQuery\s*\(/.test(good)).toBe(true);

    // And that a comment mentioning CREATE TABLE is not treated as DDL.
    expect(DDL.test(stripComments('// we used to CREATE TABLE here\nconst x = 1;'))).toBe(false);
  });

  it('is actually scanning the source tree', () => {
    // A guard that walks nothing passes forever.
    const files = walk(SRC).filter((f) => !EXEMPT.some((e) => f.includes(e)));
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('admin-conversations-aurora.ts'))).toBe(true);
  });
});
