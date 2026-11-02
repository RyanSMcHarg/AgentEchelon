/**
 * EVERY `alias.column` READ FROM A SUBQUERY, LATERAL OR CTE NAMES A COLUMN THAT RELATION EXPOSES.
 *
 * THE OUTAGE THIS WOULD HAVE CAUGHT. Converting a join in `analytics-query.ts` to a LATERAL, the
 * LATERAL selected `ex.conversation_id` alone while the query still read `e.id`, `e.e2e_ms`,
 * `e.inbound_ms`, `e.paired_by` and `e.delivery_option`. Postgres answered `column e.id does not
 * exist` (42703) and the analytics API errored for every caller of that queryType from the morning
 * deploy until the afternoon. Thousands of backend tests passed: none of them executes SQL, and a
 * template literal is only a string to `tsc`.
 *
 * THE SECOND OUTAGE, WHICH THE FIRST VERSION OF THIS GUARD SAID IT COULD NOT CATCH. Its header read
 * "it knows no table schema, so `m.nonexistent` against a real table is not checked". The archival
 * query then read `COALESCE(am_upd.intent, am.intent)` from `messages`, which has no `intent` column -
 * intent rides in `metadata`, and `exchanges` is the table that has a column by that name, which is
 * where the expression came from. Postgres answered 42703 on EVERY invoke, the whole archival
 * transaction rolled back, and nothing reached the analytics tables for 21 hours. So the schema is now
 * supplied: the migrations are folded in order into the columns each table really has.
 *
 * WHAT THIS CHECKS, AND WHAT IT DOES NOT. `helpers/sql-alias-columns.ts` tokenizes each SQL literal
 * (comments and strings are ignored), finds the derived relations and the columns their SELECT lists
 * expose, reads real tables from the folded schema, and flags a read of a column neither exposes. A
 * SELECT list with `*` or a `${...}` interpolation exposes an unknown set and is not checked; an alias
 * defined twice in one block is ambiguous and skipped; a VIEW is not in the schema map, so reads through
 * one stay unchecked. Whatever it does not recognize is treated as unknown rather than as a violation.
 * The helper's header states the limits in full. It reads the files as they are on disk, parsed, so it
 * follows the queries wherever they move.
 */
import * as fs from 'fs';
import * as path from 'path';
import { checkSqlAliasColumns, sqlLiteralsIn, tableColumnsFromSchemaDir } from '../helpers/sql-alias-columns';

const AURORA = path.join(__dirname, '../../lambda/src/analytics-aurora');
const ANALYTICS_QUERY = path.join(AURORA, 'analytics-query.ts');
const SCHEMA_DIR = path.join(AURORA, 'schema');

describe('the checker catches the defect it exists for', () => {
  it('flags a LATERAL that narrowed its columns while the query still reads the others (the outage shape)', () => {
    const sql = `
      SELECT COUNT(*) FILTER (WHERE e.id IS NOT NULL AND e.e2e_ms IS NULL) AS unclosed_count
        FROM messages m
        LEFT JOIN LATERAL (
          SELECT ex.conversation_id
            FROM exchanges ex
           WHERE ex.agent_message_id = m.id
           LIMIT 1
        ) e ON true
        LEFT JOIN conversations c ON e.conversation_id = c.id`;
    const { violations } = checkSqlAliasColumns(sql);
    expect(violations.map((v) => `${v.alias}.${v.column}`).sort()).toEqual(['e.e2e_ms', 'e.id']);
  });

  it('does not flag the fixed shape, which selects the whole row', () => {
    const sql = `
      SELECT e.id, e.e2e_ms FROM messages m
        LEFT JOIN LATERAL (SELECT ex.* FROM exchanges ex WHERE ex.agent_message_id = m.id LIMIT 1) e ON true`;
    expect(checkSqlAliasColumns(sql).violations).toEqual([]);
  });

  it('checks a CTE read through a table alias', () => {
    const sql = `
      WITH resp_ledger AS (SELECT response_id, channel_arn, MAX(outcome) AS outcome FROM turn_events GROUP BY 1, 2)
      SELECT l.outcome, l.final_at FROM messages m LEFT JOIN resp_ledger l ON l.response_id = m.message_id`;
    expect(checkSqlAliasColumns(sql).violations).toEqual([
      { alias: 'l', column: 'final_at', exposes: ['channel_arn', 'outcome', 'response_id'] },
    ]);
  });

  it('checks a CTE read by its own name, and honors a declared column list', () => {
    const sql = `
      WITH client (corr, ms) AS (SELECT a, b FROM client_events)
      SELECT client.corr, client.a FROM client`;
    expect(checkSqlAliasColumns(sql).violations.map((v) => v.column)).toEqual(['a']);
  });

  it('names unaliased items the way Postgres does for the common shapes', () => {
    const sql = `
      SELECT d.channel_arn, d.count, d.created_at, d.coalesce, d.case, d.dominant_model
        FROM (SELECT m.channel_arn, COUNT(*), m.created_at::date, COALESCE(a, b),
                     CASE WHEN x THEN 1 END,
                     MODE() WITHIN GROUP (ORDER BY m.bedrock_model) AS dominant_model
                FROM messages m GROUP BY 1) d`;
    expect(checkSqlAliasColumns(sql).violations).toEqual([]);
  });

  it('ignores comments and string contents', () => {
    const sql = `
      -- e.id was read here once
      SELECT e.conversation_id, '<!--corr:%' AS marker, 'e.nope' AS s
        FROM (SELECT conversation_id FROM exchanges) e /* e.missing */`;
    expect(checkSqlAliasColumns(sql).violations).toEqual([]);
  });

  it('resolves an alias to the nearest block that defines it', () => {
    // The inner `e` is a real table; its reads are not checked against the outer derived `e`.
    const sql = `
      SELECT e.total, (SELECT MAX(e.created_at) FROM exchanges e) AS latest
        FROM (SELECT COUNT(*) AS total FROM exchanges) e`;
    expect(checkSqlAliasColumns(sql).violations).toEqual([]);
  });

  it('skips an alias defined twice in one block rather than guessing', () => {
    const sql = `
      SELECT e.id FROM (SELECT a FROM t) e
      UNION ALL
      SELECT e.id FROM (SELECT id FROM u) e`;
    expect(checkSqlAliasColumns(sql).violations).toEqual([]);
  });

  it('treats an interpolated SELECT list as unknown', () => {
    const [lit] = sqlLiteralsIn('const q = `SELECT e.anything FROM (SELECT ${cols} FROM t) e`;');
    expect(checkSqlAliasColumns(lit.text).violations).toEqual([]);
  });
});

describe('the folded schema, and the real-table half of the checker', () => {
  const tables = tableColumnsFromSchemaDir(SCHEMA_DIR);

  it('folds the migrations into the columns each table really has', () => {
    expect(tables.size).toBeGreaterThan(20);
    const messages = tables.get('messages');
    // The column the outage read. It is not on this table and never has been.
    expect(messages!.has('intent')).toBe(false);
    // Where intent actually lives, and the table that does own a column by that name.
    expect(messages!.has('metadata')).toBe(true);
    expect(tables.get('exchanges')!.has('intent')).toBe(true);
    // A column added by a later migration is folded in, so the map is not just 001-initial.
    expect(messages!.has('turn_entry')).toBe(true);
    // ...and one dropped by a later migration is folded out (015 drops these three).
    for (const dropped of ['name', 'participant_count', 'message_count']) {
      expect(tables.get('conversation_summaries')!.has(dropped)).toBe(false);
    }
  });

  it('flags a column read from a real table that the table does not have (the archival outage shape)', () => {
    const sql = `
      SELECT COALESCE(am_upd.intent, am.intent) AS intent, am.metadata->>'intent' AS ok
        FROM messages am
        LEFT JOIN messages am_upd ON am_upd.message_id = am.message_id || '-UPD'`;
    expect(checkSqlAliasColumns(sql, tables).violations.map((v) => `${v.alias}.${v.column}`).sort())
      .toEqual(['am.intent', 'am_upd.intent']);
    // Without the schema this is exactly what shipped: the old guard saw nothing to judge.
    expect(checkSqlAliasColumns(sql).violations).toEqual([]);
  });

  it('does not flag a read through a VIEW, whose columns it deliberately does not know', () => {
    const sql = 'SELECT v.anything_at_all FROM v_turn_latency v';
    expect(checkSqlAliasColumns(sql, tables).violations).toEqual([]);
  });

  it('lets a CTE shadow a real table of the same name', () => {
    const sql = `WITH messages AS (SELECT 1 AS only_col)
                 SELECT m.only_col, m.channel_arn FROM messages m`;
    // `channel_arn` is a real `messages` column, but the CTE in scope is what `m` names.
    expect(checkSqlAliasColumns(sql, tables).violations.map((v) => v.column)).toEqual(['channel_arn']);
  });

  it('allows PostgreSQL system columns, which are on every table without being declared', () => {
    expect(checkSqlAliasColumns('SELECT m.ctid, m.xmin FROM messages m', tables).violations).toEqual([]);
  });
});

describe('every analytics-aurora query, against the real schema', () => {
  const tables = tableColumnsFromSchemaDir(SCHEMA_DIR);
  const files = fs.readdirSync(AURORA).filter((f) => f.endsWith('.ts')).sort();
  const scanned = files.map((f) => {
    const literals = sqlLiteralsIn(fs.readFileSync(path.join(AURORA, f), 'utf8'), f);
    return { file: f, results: literals.map((lit) => ({ lit, ...checkSqlAliasColumns(lit.text, tables) })) };
  });

  it('scans the whole directory, not just the one file the first outage was in', () => {
    // The archival outage was in kinesis-archival.ts, which the original guard never looked at.
    expect(files).toContain('kinesis-archival.ts');
    const reads = scanned.reduce((s, f) => s + f.results.reduce((t, r) => t + r.checkedReads, 0), 0);
    // Over twelve hundred reads are checked today. A collapse here means the extraction broke.
    expect(reads).toBeGreaterThan(800);
  });

  it('reads no column that neither a derived relation nor the real table has', () => {
    const offenders = scanned.flatMap(({ file, results }) => results.flatMap(({ lit, violations }) =>
      violations.map((v) => `${file}:${lit.line}: ${v.alias}.${v.column} does not exist `
        + `(${v.alias} has: ${v.exposes.slice(0, 12).join(', ')}${v.exposes.length > 12 ? ', ...' : ''})`)));
    // Postgres answers 42703 for each of these, at runtime, on every invoke.
    expect(offenders).toEqual([]);
  });
});

describe('analytics-query.ts', () => {
  const literals = sqlLiteralsIn(fs.readFileSync(ANALYTICS_QUERY, 'utf8'), ANALYTICS_QUERY);
  const results = literals.map((lit) => ({ lit, ...checkSqlAliasColumns(lit.text) }));

  it('finds its queries, and checks real reads in them (the guard is wired to the file)', () => {
    // An empty scan passes for free. The file holds dozens of queries and several derived relations
    // whose columns are read by alias; if either count collapses, the extraction broke, not the SQL.
    expect(literals.length).toBeGreaterThan(20);
    // Well over a hundred reads are checked today; re-narrowing the outage LATERAL to
    // `SELECT ex.conversation_id` in a copy of the file flags e.id, e.paired_by, e.delivery_option and more.
    expect(results.reduce((s, r) => s + r.checkedReads, 0)).toBeGreaterThan(50);
  });

  it('reads no column a subquery, LATERAL or CTE does not expose', () => {
    const offenders = results.flatMap(({ lit, violations }) => violations.map((v) =>
      `query at analytics-query.ts:${lit.line}: ${v.alias}.${v.column} is not exposed by ${v.alias} `
      + `(exposes: ${v.exposes.join(', ') || 'nothing'})`));
    // Postgres would answer 42703 "column does not exist" for each of these, at request time.
    expect(offenders).toEqual([]);
  });
});
