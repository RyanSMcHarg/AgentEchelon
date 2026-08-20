/**
 * A `CREATE OR REPLACE VIEW` CANNOT CHANGE A COLUMN'S TYPE, and an aggregate silently changes one.
 *
 * THE LIVE FAILURE THIS GUARDS. Migration 026 defined `v_turn_latency` with a bare `turn_id`, so the
 * deployed column is `varchar(64)`. Migration 027 redefined the same view with `MAX(turn_id)`, and
 * `max(varchar)` returns TEXT. Postgres refused:
 *
 *     cannot change data type of view column "turn_id" from character varying(64) to text
 *
 * Every pending migration applies inside ONE transaction, so that single refusal rolled back 028 and
 * 029 as well, left `schemaInitialized` false, and made `ensureSchema` rethrow on EVERY data-plane
 * invocation. The whole data plane errored on every turn until the cast was restored. 026 already
 * carried this exact trap for `channel_arn` and had already fixed it with `::text`; 027 reintroduced
 * it one column over, which is what a comment alone buys you.
 *
 * WHY A STATIC GUARD RATHER THAN A DATABASE TEST. The suite has no Postgres, so nothing here can
 * actually apply a migration - which is precisely why this class reached a deployment. It fails at
 * the commit instead of on a cold start in production.
 *
 * THE RULE, and it is deliberately narrow: an alias that a view produced as a PLAIN COLUMN must not
 * later be produced by an UNCAST AGGREGATE. That is the shape of the failure, and it is the shape a
 * file can be checked for without knowing any column's declared type. "Every aggregate must carry a
 * cast" was tried first and is wrong: most of these columns are aggregates in every definition of the
 * view, so their type never changes and a cast would be noise.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody trusts it further than it goes: a cast to the WRONG type
 * (`MAX(turn_id)::text` would satisfy this and still fail against a `varchar(64)` column), and any
 * type change that does not involve an aggregate. Closing those needs the column types from the
 * `CREATE TABLE`, which is a bigger guard than the defect currently justifies.
 */
import * as fs from 'fs';
import * as path from 'path';

const SCHEMA_DIR = path.join(__dirname, '../../lambda/src/analytics-aurora/schema');

/** Aggregates that return `text` when applied to a `varchar` column. `count()` returns bigint. */
const STRING_AGGREGATES = ['min', 'max', 'string_agg'];

interface ViewDefinition {
  file: string;
  view: string;
  body: string;
  /** alias -> the aggregate expression producing it, for every `<agg>(...) [FILTER ...] AS <alias>`. */
  aggregated: Map<string, string>;
}

/** Every `CREATE OR REPLACE VIEW` in the schema directory, in migration order. */
function replacedViewDefinitions(): ViewDefinition[] {
  const out: ViewDefinition[] = [];
  for (const file of fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
    // Strip comments so a `--` explanation of the trap is not mistaken for the trap itself.
    const code = sql.replace(/--[^\n]*/g, '');
    const viewMatch = /CREATE\s+OR\s+REPLACE\s+VIEW\s+([a-z0-9_]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = viewMatch.exec(code)) !== null) {
      const end = code.indexOf(';', m.index);
      const body = code.slice(m.index, end === -1 ? undefined : end);
      const aggregated = new Map<string, string>();
      for (const agg of STRING_AGGREGATES) {
        const re = new RegExp(`\\b${agg}\\s*\\(([^)]*)\\)([^,\\n]*?)\\s+AS\\s+([a-z0-9_]+)`, 'gi');
        let c: RegExpExecArray | null;
        while ((c = re.exec(body)) !== null) aggregated.set(c[3], `${agg}(${c[1]})${c[2]}`);
      }
      out.push({ file, view: m[1], body, aggregated });
    }
  }
  return out;
}

/** Does this definition's body mention `alias` at all (as a whole word)? */
function mentions(body: string, alias: string): boolean {
  return new RegExp(`\\b${alias}\\b`).test(body);
}

const DEFINITIONS = replacedViewDefinitions();

/** One case per (definition, uncast aggregate alias) that an earlier definition also produced. */
const CASES = DEFINITIONS.flatMap((def, i) =>
  [...def.aggregated.entries()]
    .filter(([, expr]) => !/::\s*[a-z0-9_]+(\s*\(\s*\d+\s*\))?/i.test(expr))
    .flatMap(([alias, expr]) =>
      DEFINITIONS.slice(0, i)
        .filter((earlier) => earlier.view === def.view && mentions(earlier.body, alias))
        .map((earlier) => ({ def, earlier, alias, expr })),
    ),
);

describe('a replaced view does not turn a plain column into an uncast aggregate', () => {
  it('reads the view definitions, and sees the pair the outage came from', () => {
    // Vacuity check with teeth: the guard is worthless unless it is actually looking at 026 and 027,
    // the two definitions whose disagreement took the data plane down.
    const turnLatency = DEFINITIONS.filter((d) => d.view === 'v_turn_latency').map((d) => d.file);
    expect(turnLatency.some((f) => f.startsWith('026'))).toBe(true);
    expect(turnLatency.some((f) => f.startsWith('027'))).toBe(true);
  });

  it('027 produces turn_id with an explicit type, which is what the outage was', () => {
    // Pinned by name, because this is the exact regression: `MAX(turn_id)` returns text against a
    // `varchar(64)` column, and the general rule below cannot see the column's declared type.
    const def = DEFINITIONS.find((d) => d.file.startsWith('027') && d.view === 'v_turn_latency')!;
    expect(def.body).toMatch(/MAX\s*\(\s*turn_id\s*\)\s*::\s*VARCHAR\s*\(\s*64\s*\)/i);
  });

  it.each(CASES.map((c) => [`${c.def.file} ${c.def.view}.${c.alias} (vs ${c.earlier.file})`, c]))(
    '%s was already an aggregate in the earlier definition',
    (_label: string, c: (typeof CASES)[number]) => {
      // Aggregate in both ⇒ the column was already text and its type does not move. Plain column in
      // the earlier definition and an uncast aggregate here ⇒ varchar(64) becomes text, and
      // CREATE OR REPLACE VIEW refuses it.
      if (!c.earlier.aggregated.has(c.alias)) {
        throw new Error(
          `${c.def.file}: ${c.def.view}.${c.alias} is "${c.expr.trim()}", but ${c.earlier.file} `
            + 'produced that column plainly. An aggregate over a string column returns text, and '
            + 'CREATE OR REPLACE VIEW cannot change a column type - the migration fails on every '
            + 'existing deployment, taking every later migration in the same transaction with it. '
            + 'Relabel it (see 026 channel_arn::text, 027 turn_id::VARCHAR(64)).',
        );
      }
      expect(c.earlier.aggregated.has(c.alias)).toBe(true);
    },
  );
});
