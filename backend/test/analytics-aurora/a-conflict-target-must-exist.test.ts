/**
 * A NAMED `ON CONFLICT` TARGET MUST MATCH AN ARBITER THAT EXISTS.
 *
 * Postgres does not treat a conflict target it cannot match as a no-op. It raises 42P10 and the whole
 * statement fails, so the write does not merely skip its dedup - it does not happen at all.
 *
 * THIS SHIPPED. Migration 041 dropped `turn_events_event_kind_key` and replaced it with an expression
 * index carrying `COALESCE(step_name, '')`, while `turn-events-backfill.ts` went on naming the old
 * four-column key. Because migrations apply at runtime on cold start, the deploy that added 041 broke
 * the backfill in the same motion: it errored on every run, no live-archived user_message row was ever
 * bound to its turn, and `turn_id` stayed NULL - which the ledger's ttff and e2e are derived from. The
 * unit suite was green throughout, because nothing here talks to a database.
 *
 * So this reads both sides as TEXT and compares them. It cannot prove a query runs; it can prove the
 * arbiter a query names is one the schema creates, which is the half that went wrong.
 */
import * as fs from 'fs';
import * as path from 'path';

const AURORA = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora');
const SCHEMA = path.join(AURORA, 'schema');
const NL = String.fromCharCode(10);

/** Normalize a column list so spacing and quoting cannot make two equal lists look different. */
const key = (columns: string): string => columns
  .replace(/\s+/g, ' ')
  .replace(/\s*,\s*/g, ',')
  .replace(/"/g, '')
  .trim()
  .toLowerCase();

/** Source with its comment lines removed: a comment quoting a column list is not an arbiter. */
const statementsOnly = (source: string): string => source
  .split(NL)
  .filter((l) => {
    const t = l.trimStart();
    return !t.startsWith('--') && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join(NL);

const dotTs = '.ts';
const dotSql = '.sql';
const dotDts = '.d.ts';

/**
 * Every arbiter that EXISTS once the migrations have run, as table -> set of normalized column lists.
 *
 * IN MIGRATION ORDER, AND DROPS COUNT. The first version read every file as though all of it were
 * still in force, so migration 024 kept vouching for a constraint migration 041 deletes - and the
 * test passed against the very defect it was written for. A schema is a sequence, not a pile.
 */
function arbitersFromSchema(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  /** Constraint and index names, so a DROP can find what it removes. */
  const byName = new Map<string, { table: string; columns: string }>();

  const add = (table: string, columns: string, name?: string) => {
    const t = table.toLowerCase();
    if (!found.has(t)) found.set(t, new Set());
    found.get(t)!.add(key(columns));
    if (name) byName.set(name.toLowerCase(), { table: t, columns: key(columns) });
  };
  const drop = (name: string) => {
    const gone = byName.get(name.toLowerCase());
    if (!gone) return;
    found.get(gone.table)?.delete(gone.columns);
    byName.delete(name.toLowerCase());
  };

  for (const file of fs.readdirSync(SCHEMA).filter((f) => f.endsWith(dotSql)).sort()) {
    const sql = statementsOnly(fs.readFileSync(path.join(SCHEMA, file), 'utf8'));

    // Read in statement order within the file too, so a drop-then-add in one migration lands the
    // right way round. 024 does exactly that.
    for (const m of sql.matchAll(/(?:DROP\s+CONSTRAINT|DROP\s+INDEX)(?:\s+IF\s+EXISTS)?\s+(\w+)|CREATE\s+UNIQUE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)\s+ON\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:WHERE[^;]*?)?;|ALTER\s+TABLE\s+(\w+)\s+ADD\s+CONSTRAINT\s+(\w+)\s+UNIQUE\s*\(([^)]*)\)/gi)) {
      if (m[1]) { drop(m[1]); continue; }
      if (m[2]) { add(m[3], m[4], m[2]); continue; }
      if (m[6]) { add(m[5], m[7], m[6]); }
    }

    // Everything declared inside a CREATE TABLE, which is where most single-column arbiters live.
    for (const t of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\)\s*;/gi)) {
      for (const c of t[2].matchAll(/\b(?:PRIMARY\s+KEY|UNIQUE)\s*\(([^)]*)\)/gi)) add(t[1], c[1]);
      for (const line of t[2].split(',')) {
        const inline = /^\s*(\w+)\s+[^,]*?\b(?:PRIMARY\s+KEY|UNIQUE)\b/i.exec(line);
        if (inline && !/^\s*(?:PRIMARY|UNIQUE|CONSTRAINT|FOREIGN)\b/i.test(line)) add(t[1], inline[1]);
      }
    }

    // A RENAMED COLUMN carries its arbiters with it (079 renames `user_sub` to `person_id`).
    for (const r of sql.matchAll(/ALTER\s+TABLE\s+(\w+)\s+RENAME\s+COLUMN\s+(\w+)\s+TO\s+(\w+)/gi)) {
      const t = r[1].toLowerCase();
      const from = r[2].toLowerCase();
      const to = r[3].toLowerCase();
      const renamed = (cols: string) => key(cols.split(',').map((c) => (c.trim() === from ? to : c)).join(','));
      const set = found.get(t);
      if (set) found.set(t, new Set([...set].map(renamed)));
      for (const [name, entry] of byName) {
        if (entry.table === t) byName.set(name, { table: t, columns: renamed(entry.columns) });
      }
    }
  }

  // AND THE ONES DECLARED IN TYPESCRIPT. The migrations table bootstraps itself before any .sql file
  // can run, so its arbiter lives in code. Anchored on the template literal close rather than the
  // first bracket: a column type carries its own parentheses, and VARCHAR(256) ended the body
  // mid-column and hid every arbiter after it.
  for (const file of fs.readdirSync(AURORA).filter((f) => f.endsWith(dotTs) && !f.endsWith(dotDts))) {
    const src = statementsOnly(fs.readFileSync(path.join(AURORA, file), 'utf8'));
    for (const t of src.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\)\s*`/gi)) {
      for (const line of t[2].split(',')) {
        const inline = /^\s*(\w+)\s+[^,]*?\b(?:PRIMARY\s+KEY|UNIQUE)\b/i.exec(line);
        if (inline && !/^\s*(?:PRIMARY|UNIQUE|CONSTRAINT|FOREIGN)\b/i.test(line)) add(t[1], inline[1]);
      }
    }
  }
  return found;
}

/** Every named ON CONFLICT target in the Aurora TypeScript, with the table it writes to. */
function namedTargets(): { file: string; table: string; columns: string }[] {
  const out: { file: string; table: string; columns: string }[] = [];
  for (const file of fs.readdirSync(AURORA).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
    // COMMENTS ARE NOT STATEMENTS, and this codebase explains its conflict targets in prose right
    // above them, so a scan that reads comments finds every target twice - once real, once quoted
    // with no INSERT in front of it.
    const src = statementsOnly(fs.readFileSync(path.join(AURORA, file), 'utf8'));
    // The column list may itself contain a parenthesised expression, so one level of nesting is allowed.
    for (const m of src.matchAll(/ON\s+CONFLICT\s*\(((?:[^()]|\([^()]*\))*)\)/gi)) {
      const before = src.slice(0, m.index ?? 0);
      const ins = [...before.matchAll(/INSERT\s+INTO\s+(\w+)/gi)].pop();
      const batch = [...before.matchAll(/batchInsert\(\s*'(\w+)'/gi)].pop();
      out.push({ file, table: (ins?.[1] ?? batch?.[1] ?? '').toLowerCase(), columns: m[1] });
    }
  }
  return out;
}

describe('every named ON CONFLICT target is an arbiter the schema creates', () => {
  const arbiters = arbitersFromSchema();
  const targets = namedTargets();

  it('finds both sides (guards against a silently empty scan)', () => {
    // Without this, a moved schema directory would make the assertion below pass over nothing, which
    // is the "green having checked nothing" shape this repo has been bitten by before.
    expect(arbiters.size).toBeGreaterThan(3);
    expect(targets.length).toBeGreaterThan(0);
  });

  it('matches every one of them', () => {
    const orphans = targets.filter((t) => !arbiters.get(t.table)?.has(key(t.columns)));
    expect(orphans.map((o) => `${o.file}: ON CONFLICT (${key(o.columns)}) on ${o.table}`)).toEqual([]);
  });
});
