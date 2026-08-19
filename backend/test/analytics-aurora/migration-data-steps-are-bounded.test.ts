/**
 * A migration's DATA step must have a ceiling, and a migration that cannot finish in one go must be
 * able to resume.
 *
 * THE DEFECT THIS PINS. `applyPendingMigrations` runs every pending `schema/*.sql` file AND the
 * classification-boundary bootstrap inside ONE transaction, in ONE Lambda invocation, and `ensureSchema`
 * rethrows with `schemaInitialized` still false if any of it fails. So a statement that outruns the
 * invocation commits NOTHING: `_migrations` records nothing, and the next cold start begins the same
 * work from zero. That is not a slow upgrade, it is one that can never converge.
 *
 * Migration 020 was exactly that shape - a single unbounded `UPDATE embeddings` moving the isolation key
 * on every row of an existing corpus. A fresh deployment never noticed (empty table); an existing one
 * would have retried the whole rewrite on every cold start while retrieval, which already filters on the
 * new key, returned honest-empty for every classification.
 *
 * DDL is exempt by nature: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and `CREATE INDEX` are fixed work
 * that no amount of batching removes. What this guard covers is the writes whose cost scales with how
 * much data a deployment already has.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BOUNDED_TABLES } from '../../lambda/src/analytics-aurora/classification-boundary-sql';

const SCHEMA_DIR = path.join(__dirname, '../../lambda/src/analytics-aurora/schema');

/** The resumable backfill that converges whatever 020's bounded batch left behind. */
const BACKFILL = '029-embeddings-classification-key-backfill.sql';

/**
 * Statements whose row count scales with the deployment's existing data. A bare `INSERT ... VALUES` is
 * fixed-size and not interesting; an `UPDATE`/`DELETE` over a table that has been accumulating rows
 * since the cluster was created is.
 */
const SCALING_WRITE = /\b(UPDATE|DELETE\s+FROM)\s+(?:public\.)?([a-z_]+)/gi;

/**
 * Unbounded writes that are bounded by something the regex cannot see. Each entry has to carry the
 * argument, so that widening the statement means answering for the exemption rather than inheriting it.
 */
const EXEMPT: Record<string, string> = {
  '021-embeddings-classification-column.sql':
    'Its predicate requires the `classification` key AND a NULL column. The only producer of that pair '
    + 'is 020, which is bounded to one batch and runs immediately before it in the same transaction; '
    + 'document-ingestion writes the key and the column together and produces none. The ceiling is '
    + "020's batch.",
};

function sqlFiles(): string[] {
  return fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.sql')).sort();
}

/** Strip `--` comments so prose ABOUT a whole-table update is not mistaken for one. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/**
 * Statement-at-a-time. Splitting on `;` is correct even inside a `DO $$ ... $$` block here: the
 * statements this guard cares about are single statements either way, and a fragment that contains the
 * whole `UPDATE` also contains its `LIMIT`.
 */
function statementsOf(sql: string): string[] {
  return stripComments(sql).split(';');
}

function unboundedWrites(sql: string): string[] {
  const offenders: string[] = [];
  for (const statement of statementsOf(sql)) {
    for (const [, verb, table] of statement.matchAll(SCALING_WRITE)) {
      if (!(BOUNDED_TABLES as readonly string[]).includes(table.toLowerCase())) continue;
      if (/\bLIMIT\b/i.test(statement)) continue;
      offenders.push(`${verb.toUpperCase()} ${table.toLowerCase()}`);
    }
  }
  return offenders;
}

describe('migration data steps are bounded', () => {
  it('no migration rewrites a whole accumulating table in one statement', () => {
    const offenders: string[] = [];

    for (const file of sqlFiles()) {
      const found = unboundedWrites(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf-8'));
      if (found.length === 0) continue;
      if (EXEMPT[file]) continue;
      offenders.push(
        `${file}: ${found.join(', ')} has no LIMIT. Every pending migration shares one transaction in `
        + 'one Lambda invocation, so an overrun commits nothing and the next cold start repeats it.',
      );
    }

    expect(offenders).toEqual([]);
  });

  it('is looking at the real schema directory, and every exemption still applies to a real file', () => {
    // A guard that scans nothing passes forever, and a stale exemption silently covers a file that no
    // longer exists while leaving the one that replaced it unchecked.
    const files = sqlFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('020-embeddings-classification-key.sql');
    expect(files).toContain(BACKFILL);
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(files).toContain(file);
      expect(reason.length).toBeGreaterThan(40);
      // An exemption is only honest while the statement it excuses is still unbounded. Once it gains a
      // LIMIT the entry is dead weight pretending to be a decision.
      expect(unboundedWrites(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf-8')).length)
        .toBeGreaterThan(0);
    }
  });

  it('detects an unbounded whole-table write — proving the guard can fail', () => {
    // 020 as it was written: one statement, every row of an existing corpus.
    const before = `
      UPDATE embeddings
         SET metadata = jsonb_set(metadata - 'tier', '{classification}', metadata -> 'tier')
       WHERE metadata ? 'tier' AND NOT (metadata ? 'classification');
    `;
    expect(unboundedWrites(before)).toEqual(['UPDATE embeddings']);

    // ...and the bounded form it became.
    const after = `
      UPDATE embeddings
         SET metadata = jsonb_set(metadata - 'tier', '{classification}', metadata -> 'tier')
       WHERE ctid IN (
         SELECT ctid FROM embeddings
          WHERE metadata ? 'tier' AND NOT (metadata ? 'classification')
          LIMIT 5000
       );
    `;
    expect(unboundedWrites(after)).toEqual([]);

    // A comment describing a whole-table update is not one.
    expect(unboundedWrites('-- UPDATE embeddings SET classification = NULL;\n')).toEqual([]);
  });
});

describe('the resumable key backfill', () => {
  const sql = () => fs.readFileSync(path.join(SCHEMA_DIR, BACKFILL), 'utf-8');
  const body = () => stripComments(sql());

  it('reports what it has left, so applyPendingMigrations can leave it pending', () => {
    // Without this the runner records the file as applied after its first batch and the remaining rows
    // are stranded: a migration marked done whose effect is partial, which is indistinguishable from a
    // corpus that never had those rows.
    const code = body();
    expect(code).toMatch(/INSERT\s+INTO\s+_migration_progress/i);
    expect(code).toContain(BACKFILL);
    expect(code).toMatch(/ON\s+CONFLICT\s*\(\s*filename\s*\)\s*DO\s+UPDATE/i);
    // It has to create the table too: `schema-init` bootstraps a fresh cluster by applying these files
    // directly and knows nothing about resumable migrations.
    expect(code).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+_migration_progress/i);
  });

  it('keys on the surviving old value, not on the column being NULL', () => {
    // The boundary bootstrap stamps every NULL `classification` with the MOST RESTRICTIVE value on each
    // cold start. A backfill keyed on `classification IS NULL` would therefore find nothing left to do
    // after that stamp and leave the row misclassified forever - fail-closed, but permanently wrong.
    // Keying on the `tier` key the row still carries corrects the stamp instead.
    const code = body();
    expect(code).toMatch(/metadata \? 'tier'/);
    expect(code).not.toMatch(/classification IS NULL/i);
  });

  it('moves the JSONB key and the enforcement column in the same statement', () => {
    // Retrieval filters on `metadata->>'classification'`; the ADR-028 policy enforces on the
    // `classification` COLUMN. A row that moved one and not the other is either invisible or
    // misclassified, so both move together or neither does.
    const code = body();
    const update = statementsOf(sql()).find((s) => /UPDATE\s+embeddings/i.test(s)) ?? '';
    expect(update).toMatch(/jsonb_set\(\s*metadata - 'tier'/);
    expect(update).toMatch(/classification = metadata ->> 'tier'/);
  });

  it('writes the bounded table through the write role, and lets it go again', () => {
    // ADR-028: the owner has no write policy on `embeddings`, so an unroled UPDATE reports success
    // having touched zero rows - AND the COUNT that decides whether this file is finished would come
    // back zero, so it would declare itself done having done nothing. The role is guarded because it
    // does not exist yet on a fresh cluster, where `schema-init` applies this file before any boundary
    // bootstrap has run.
    const code = body();
    expect(code).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'ae_writer'\)/);
    expect(code).toMatch(/SET LOCAL ROLE ae_writer;/);
    expect(code).toMatch(/RESET ROLE;/);
    // The bookkeeping write happens AFTER the role is released: `ae_writer` holds nothing on
    // `_migration_progress`, and a SET LOCAL left standing is inherited by the rest of the transaction.
    expect(code.indexOf('RESET ROLE;')).toBeLessThan(code.search(/INSERT\s+INTO\s+_migration_progress/i));
  });
});
