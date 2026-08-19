/**
 * A migration that writes a classification-bounded table must assume the write role.
 *
 * WHY THIS GUARD EXISTS. ADR-028 puts `FORCE ROW LEVEL SECURITY` on `embeddings` and
 * `summary_embeddings`, and deliberately gives the connecting/owning identity NO write policy - an
 * owner write policy is one edit away from an owner read policy, which is the `ENABLE`-without-`FORCE`
 * hole this whole design exists to close.
 *
 * The consequence lands somewhere non-obvious. Migrations run as that owner, so from migration 023
 * onward an `UPDATE embeddings SET ...` written the ordinary way **succeeds and changes zero rows**.
 * No error, no warning; `applyPendingMigrations` records the file as applied and moves on. The next
 * person to look finds a migration marked applied whose effect is absent - which is exactly the
 * silent-degradation shape this repo has been bitten by before (a retrieval that returns nothing is
 * indistinguishable from a corpus with nothing relevant in it).
 *
 * So: name the role, or don't write the table. And having named it, RESET it - `applyPendingMigrations`
 * applies every pending file inside ONE transaction, so a `SET LOCAL ROLE` left standing at the end of
 * 023 is still in force for 024.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BOUNDED_TABLES, WRITER_ROLE } from '../../lambda/src/analytics-aurora/classification-boundary-sql';

const SCHEMA_DIR = path.join(__dirname, '../../lambda/src/analytics-aurora/schema');

/**
 * Files that predate the boundary. They ran (or run, on a fresh cluster) BEFORE
 * `ensureClassificationBoundary` has enabled RLS, as the owner with nothing in the way, so they are
 * correct as written and rewriting them would change applied history for no gain.
 *
 * The cutoff is the boundary itself: 022 is the last file that lands before RLS exists. Anything
 * numbered above it runs on a cluster where the policies are already live.
 */
const PRE_BOUNDARY_CUTOFF = 22;

/** Statements that MUTATE a table. A plain SELECT is unaffected by the write policy. */
const WRITE_STATEMENT = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|COPY)\s+(?:public\.)?([a-z_]+)/gi;

function sqlFiles(): string[] {
  return fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/** Strip `--` comments so the prose ABOUT a write is not mistaken for one. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

describe('migrations that write a bounded table', () => {
  it('assume the write role, and reset it before the file ends', () => {
    const offenders: string[] = [];

    for (const file of sqlFiles()) {
      const num = Number(file.slice(0, 3));
      if (num <= PRE_BOUNDARY_CUTOFF) continue;

      const body = stripComments(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf-8'));
      const written = new Set<string>();
      for (const [, , table] of body.matchAll(WRITE_STATEMENT)) {
        if ((BOUNDED_TABLES as readonly string[]).includes(table.toLowerCase())) {
          written.add(table.toLowerCase());
        }
      }
      if (written.size === 0) continue;

      const tables = [...written].join(', ');
      if (!new RegExp(`SET\\s+LOCAL\\s+ROLE\\s+${WRITER_ROLE}\\b`, 'i').test(body)) {
        offenders.push(
          `${file} writes ${tables} but never does SET LOCAL ROLE ${WRITER_ROLE} — `
          + 'as the owner under FORCE RLS this statement affects ZERO rows and reports success.',
        );
      } else if (!/RESET\s+ROLE\s*;/i.test(body)) {
        offenders.push(
          `${file} assumes ${WRITER_ROLE} but never RESETs it — every pending migration shares one `
          + 'transaction, so the next file would run as the write role too.',
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  it('is looking at the real schema directory, and at files above the cutoff', () => {
    // A guard that scans nothing passes forever. Pin that the directory resolves, that it holds the
    // migrations this repo actually ships, and that the cutoff has not drifted past the end of the
    // series (which would silently exempt every file there is).
    const files = sqlFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('022-summary-embeddings-classification.sql');
    const highest = Math.max(...files.map((f) => Number(f.slice(0, 3))));
    expect(highest).toBeGreaterThanOrEqual(PRE_BOUNDARY_CUTOFF);
  });

  it('detects a write that skips the role — proving the guard can fail', () => {
    // The check above passes today because no migration above the cutoff writes a bounded table.
    // That is indistinguishable from a broken matcher, so run the same logic over a synthetic file.
    const bad = stripComments(`
      -- 099-oops.sql
      UPDATE embeddings SET classification = 'basic' WHERE source_type = 'wiki';
    `);
    const written = [...bad.matchAll(WRITE_STATEMENT)]
      .map(([, , t]) => t.toLowerCase())
      .filter((t) => (BOUNDED_TABLES as readonly string[]).includes(t));
    expect(written).toEqual(['embeddings']);
    expect(new RegExp(`SET\\s+LOCAL\\s+ROLE\\s+${WRITER_ROLE}\\b`, 'i').test(bad)).toBe(false);

    // ...and that a correctly written one passes.
    const good = stripComments(`
      SET LOCAL ROLE ${WRITER_ROLE};
      UPDATE summary_embeddings SET classification = 'premium' WHERE classification IS NULL;
      RESET ROLE;
    `);
    expect(new RegExp(`SET\\s+LOCAL\\s+ROLE\\s+${WRITER_ROLE}\\b`, 'i').test(good)).toBe(true);
    expect(/RESET\s+ROLE\s*;/i.test(good)).toBe(true);
  });
});
