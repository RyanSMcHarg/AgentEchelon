/**
 * A narrow static check over SQL held in TypeScript string literals: every `alias.column` read from a
 * DERIVED relation (a subquery or LATERAL in FROM/JOIN, or a CTE) names a column that relation exposes.
 *
 * WHY IT EXISTS. A query in a template literal is opaque to `tsc`, and no unit test executes SQL. A
 * LATERAL rewritten to select `ex.conversation_id` alone, while the query still read `e.id`,
 * `e.e2e_ms` and three more, shipped and returned `column e.id does not exist` (42703) for every
 * caller of that queryType for six hours. The defect is mechanical: the set of columns a derived
 * relation exposes is written in its own SELECT list, and every read of it is `alias.column`.
 *
 * WHAT IT DOES. Tokenizes each literal (strings and comments are not code, so `e.id` inside a comment
 * or `'<!--corr:%'` is ignored), matches parentheses, and records per query block:
 *   - CTEs: `WITH name [(cols)] AS (body)` - exposes `cols`, else the body's SELECT list.
 *   - FROM/JOIN items: `(body) [AS] alias [(cols)]`, `table [AS] alias`, `fn(...) [AS] alias [(cols)]`.
 *     A table that names a visible CTE exposes that CTE's columns; any other table is UNKNOWN.
 * An `alias.col` is resolved to the nearest enclosing block that defines `alias`, and flagged when that
 * definition has a KNOWN column set that does not include `col`.
 *
 * REAL TABLES TOO, when a schema is supplied. `tableColumnsFromSchemaDir` folds the migration files in
 * order - `CREATE TABLE`, `ADD COLUMN`, `DROP COLUMN` - into the column set each table actually has, and
 * a FROM item naming one of those tables exposes that set. This half exists because the limit below was
 * not hypothetical: `COALESCE(am_upd.intent, am.intent)` against `messages`, which carries intent inside
 * `metadata` and has no such column, failed 42703 on every archival invoke for 21 hours. A VIEW is never
 * in the map, so reads through one stay unchecked rather than wrongly flagged.
 *
 * ITS LIMITS, stated so a pass is read for what it is:
 *   - Without a schema it knows no table. `m.nonexistent` against a real table is then not checked.
 *   - A SELECT list containing `*`, `alias.*` or a `${...}` interpolation exposes an UNKNOWN set, and
 *     reads from it are not checked.
 *   - An alias defined twice in the same block (UNION branches reusing `e`) is ambiguous and skipped.
 *   - An unaliased expression is named the way Postgres names it for the common shapes (a column's
 *     own name, a function's name, `case`), and `?column?` otherwise. A read of such a column by that
 *     implicit name would be flagged only if the naming here were wrong - so prefer explicit `AS`.
 *   - Comma-joined FROM items are recognized only in a block that starts with SELECT/WITH (or at the
 *     statement root); UPDATE ... SET targets are not aliases here.
 *   - It is not a parser. A construct it does not recognize yields UNKNOWN, never a violation - the
 *     design direction is "miss a defect" rather than "flag valid SQL".
 *
 * NOT A JEST TEST FILE (no `.test.`), so jest ignores it.
 */
import * as ts from 'typescript';

type TokKind = 'ident' | 'num' | 'str' | 'op' | 'param' | 'interp';
interface Tok { kind: TokKind; v: string; quoted?: boolean }

const INTERP = '__interp__';

export function tokenizeSql(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j++;
      }
      out.push({ kind: 'str', v: sql.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const end = sql.indexOf('"', i + 1);
      const j = end === -1 ? n : end;
      out.push({ kind: 'ident', v: sql.slice(i + 1, j), quoted: true });
      i = j + 1;
      continue;
    }
    if (c === '$' && /[0-9]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j])) j++;
      out.push({ kind: 'param', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      const word = sql.slice(i, j);
      out.push(word === INTERP ? { kind: 'interp', v: word } : { kind: 'ident', v: word.toLowerCase() });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.eE]/.test(sql[j])) {
        // `1.5` is a number; `1..` or `x.1` shapes are not in this codebase's SQL.
        j++;
      }
      out.push({ kind: 'num', v: sql.slice(i, j) });
      i = j;
      continue;
    }
    const three = sql.slice(i, i + 3);
    const two = sql.slice(i, i + 2);
    if (['->>', '#>>'].includes(three)) { out.push({ kind: 'op', v: three }); i += 3; continue; }
    if (['::', '->', '#>', '<=', '>=', '<>', '!=', '||', '?|', '?&', '@>', '<@'].includes(two)) {
      out.push({ kind: 'op', v: two }); i += 2; continue;
    }
    out.push({ kind: 'op', v: c });
    i++;
  }
  return out;
}

/** Words that end a FROM item, so they are never read as its alias. */
const NOT_AN_ALIAS = new Set([
  'on', 'using', 'where', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'natural', 'lateral',
  'group', 'order', 'limit', 'offset', 'having', 'window', 'union', 'intersect', 'except', 'set',
  'returning', 'with', 'as', 'tablesample', 'for', 'into', 'values', 'select', 'from', 'and', 'or', 'not',
  'when', 'then', 'else', 'end', 'case', 'is', 'null', 'in', 'between', 'like', 'ilike', 'do', 'conflict',
  'ordinality', 'fetch', 'asc', 'desc', 'nulls', 'true', 'false', 'default', 'filter', 'over',
]);
const SELECT_LIST_END = new Set([
  'from', 'where', 'group', 'having', 'order', 'limit', 'offset', 'union', 'intersect', 'except', 'window',
  'into', 'for', 'returning',
]);
const FROM_END = new Set([
  'where', 'group', 'having', 'order', 'limit', 'offset', 'window', 'union', 'intersect', 'except',
  'select', 'returning', 'on', 'set', 'values', 'do',
]);

/** A known column set, or null when it cannot be determined. */
type Columns = Set<string> | null;
interface AliasDef { name: string; columns: Columns }

export interface AliasViolation { alias: string; column: string; exposes: string[] }
export interface AliasCheckResult { violations: AliasViolation[]; checkedReads: number }

/**
 * Columns PostgreSQL exposes on every table without them being declared. Reading one is valid SQL, so
 * they are never a violation.
 */
const SYSTEM_COLUMNS = ['ctid', 'tableoid', 'xmin', 'xmax', 'cmin', 'cmax'];

export type TableColumns = Map<string, Set<string>>;

export function checkSqlAliasColumns(sql: string, tables?: TableColumns): AliasCheckResult {
  const toks = tokenizeSql(sql);
  const n = toks.length;
  const isOp = (i: number, v: string) => toks[i]?.kind === 'op' && toks[i].v === v;
  const isWord = (i: number, v: string) => toks[i]?.kind === 'ident' && !toks[i].quoted && toks[i].v === v;

  // ── parentheses: the matching close for each open, and each token's innermost enclosing open ──
  const match = new Array<number>(n).fill(-1);
  const blockOf = new Array<number>(n).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    blockOf[i] = stack.length ? stack[stack.length - 1] : -1;
    if (isOp(i, '(')) stack.push(i);
    else if (isOp(i, ')') && stack.length) {
      const open = stack.pop()!;
      match[open] = i;
      blockOf[i] = open; // the close belongs to its own group
    }
  }
  if (stack.length) return { violations: [], checkedReads: 0 }; // unbalanced: not something to judge

  const parentOf = (block: number) => (block === -1 ? null : blockOf[block]);
  /** Direct children of a block, in order, skipping nested groups. */
  const childrenOf = (block: number): number[] => {
    const start = block === -1 ? 0 : block + 1;
    const end = block === -1 ? n : match[block];
    const out: number[] = [];
    for (let i = start; i < end; i++) {
      out.push(i);
      if (isOp(i, '(')) i = match[i];
    }
    return out;
  };
  const firstChildIs = (block: number, ...words: string[]) => {
    const first = block === -1 ? 0 : block + 1;
    return words.some((w) => isWord(first, w));
  };

  const aliases = new Map<number, AliasDef[]>();
  const ctes = new Map<number, AliasDef[]>();
  const add = (m: Map<number, AliasDef[]>, block: number, def: AliasDef) => {
    if (!m.has(block)) m.set(block, []);
    m.get(block)!.push(def);
  };

  /** The column list `(a, b)` opening at `open`, or null when it is not a plain identifier list. */
  const columnList = (open: number): Set<string> | null => {
    const cols = new Set<string>();
    for (let i = open + 1; i < match[open]; i++) {
      if (toks[i].kind === 'ident') cols.add(toks[i].v);
      else if (!isOp(i, ',')) return null;
    }
    return cols;
  };

  /** The name Postgres gives one SELECT-list item, or null when it cannot be told (star, interpolation). */
  const itemName = (item: number[]): string | null | '?' => {
    if (!item.length) return '?';
    if (item.some((i) => toks[i].kind === 'interp')) return null;
    const last = item[item.length - 1];
    if (isOp(last, '*')) return null;
    if (item.length >= 2 && isWord(item[item.length - 2], 'as') && toks[last].kind === 'ident') return toks[last].v;
    // Strip a trailing cast: `x::numeric`, `x::numeric(10,2)`, `x::text[]`.
    let body = item;
    for (let k = body.length - 1; k >= 0; k--) {
      if (isOp(body[k], '::')) {
        const tail = body.slice(k + 1);
        if (tail.every((i) => toks[i].kind === 'ident' || toks[i].kind === 'num' || ['(', ')', '[', ']', ','].some((p) => isOp(i, p)))) {
          body = body.slice(0, k);
        }
        break;
      }
    }
    if (!body.length) return '?';
    const bl = body[body.length - 1];
    if (body.length === 1 && toks[bl].kind === 'ident') return toks[bl].v;
    if (toks[bl].kind === 'ident' && body.length >= 2 && isOp(body[body.length - 2], '.')) return toks[bl].v;
    if (isWord(bl, 'end') && isWord(body[0], 'case')) return 'case';
    if (isOp(bl, ')') && toks[body[0]].kind === 'ident' && isOp(body[1], '(')) {
      // `count(*) FILTER (WHERE ...)` and `x OVER (...)` keep the function's name.
      return toks[body[0]].v;
    }
    if (toks[bl].kind === 'ident' && !NOT_AN_ALIAS.has(toks[bl].v) && body.length >= 2) {
      const prev = body[body.length - 2];
      if (isOp(prev, ')') || toks[prev].kind === 'ident' || toks[prev].kind === 'str' || toks[prev].kind === 'num') {
        return toks[bl].v; // implicit alias: `count(*) total`
      }
    }
    return '?column?';
  };

  /** The columns a query body (the group opening at `open`) exposes. */
  const exposedBy = (open: number): Columns => {
    const kids = childrenOf(open);
    const sel = kids.find((i) => isWord(i, 'select'));
    if (sel === undefined) return null;
    const cols = new Set<string>();
    let item: number[] = [];
    let k = kids.indexOf(sel) + 1;
    if (isWord(kids[k], 'distinct') || isWord(kids[k], 'all')) {
      k++;
      if (isWord(kids[k - 1], 'distinct') && isWord(kids[k], 'on')) k += 2; // `ON (...)` is one child
    }
    const flush = (): boolean => {
      const name = itemName(item);
      if (name === null) return false;
      cols.add(name === '?' ? '?column?' : name);
      item = [];
      return true;
    };
    for (; k < kids.length; k++) {
      const i = kids[k];
      // `MODE() WITHIN GROUP (ORDER BY ...)` is an aggregate, not a GROUP BY clause.
      const withinGroup = isWord(i, 'group') && isWord(kids[k - 1], 'within');
      if (toks[i].kind === 'ident' && !toks[i].quoted && SELECT_LIST_END.has(toks[i].v) && !withinGroup) break;
      if (isOp(i, ',')) { if (!flush()) return null; continue; }
      item.push(i);
      if (isOp(i, '(')) item.push(match[i]);
    }
    if (item.length && !flush()) return null;
    return cols;
  };

  const lookup = (m: Map<number, AliasDef[]>, fromBlock: number, name: string): AliasDef[] | undefined => {
    for (let b: number | null = fromBlock; b !== null; b = parentOf(b)) {
      const defs = m.get(b)?.filter((d) => d.name === name);
      if (defs?.length) return defs;
    }
    return undefined;
  };

  // ── pass 1: CTEs, in every block ──
  for (let i = 0; i < n; i++) {
    if (toks[i].kind !== 'ident' || NOT_AN_ALIAS.has(toks[i].v)) continue;
    const prev = i - 1;
    if (!(isWord(prev, 'with') || isWord(prev, 'recursive') || isOp(prev, ','))) continue;
    let j = i + 1;
    let declared: Set<string> | null = null;
    if (isOp(j, '(')) { declared = columnList(j); j = match[j] + 1; }
    if (!isWord(j, 'as')) continue;
    j++;
    if (isWord(j, 'not')) j++;
    if (isWord(j, 'materialized')) j++;
    if (!isOp(j, '(')) continue;
    if (!isWord(j + 1, 'select') && !isWord(j + 1, 'with') && !isWord(j + 1, 'values')) {
      add(ctes, blockOf[i], { name: toks[i].v, columns: declared });
      continue;
    }
    add(ctes, blockOf[i], { name: toks[i].v, columns: declared ?? exposedBy(j) });
  }

  // ── pass 2: FROM items, in query blocks ──
  const queryBlocks = [-1, ...toks.map((_, i) => i).filter((i) => isOp(i, '(') && (isWord(i + 1, 'select') || isWord(i + 1, 'with')))];
  for (const block of queryBlocks) {
    const kids = childrenOf(block);
    let inFrom = false;
    for (let k = 0; k < kids.length; k++) {
      const i = kids[k];
      const t = toks[i];
      // `a IS DISTINCT FROM b` is a comparison, not a FROM clause.
      const fromClause = isWord(i, 'from') && !isWord(kids[k - 1], 'distinct');
      if (fromClause) inFrom = true;
      else if (t.kind === 'ident' && !t.quoted && FROM_END.has(t.v)) inFrom = false;
      const startsItem = fromClause || isWord(i, 'join') || isWord(i, 'lateral') || (inFrom && isOp(i, ','));
      if (!startsItem) continue;
      let p = k + 1;
      if (isWord(kids[p], 'lateral')) continue; // the LATERAL child starts the item itself
      if (isWord(kids[p], 'only')) p++;
      const head = kids[p];
      if (head === undefined) continue;

      let columns: Columns = null;
      let implicitName: string | null = null;
      if (isOp(head, '(')) {
        if (isWord(head + 1, 'select') || isWord(head + 1, 'with')) columns = exposedBy(head);
        p++;
      } else if (toks[head].kind === 'ident' && !NOT_AN_ALIAS.has(toks[head].v)) {
        // `schema.table`, keeping the last part.
        let name = toks[head].v;
        while (isOp(kids[p + 1], '.') && toks[kids[p + 2]]?.kind === 'ident') { p += 2; name = toks[kids[p]].v; }
        p++;
        if (isOp(kids[p], '(')) {
          p++; // a set-returning function: its columns are not known without a column list
          if (isWord(kids[p], 'with') && isWord(kids[p + 1], 'ordinality')) p += 2;
        } else {
          implicitName = name;
          const cte = lookup(ctes, block, name);
          if (cte) columns = cte.length === 1 ? cte[0].columns : null;
          // A CTE of the same name shadows the table, so the real schema is consulted only when no CTE
          // is visible. A name absent from the map (a view, an unmigrated table) stays UNKNOWN.
          else {
            const real = tables?.get(name);
            columns = real ? new Set([...real, ...SYSTEM_COLUMNS]) : null;
          }
        }
      } else {
        continue;
      }

      if (isWord(kids[p], 'as')) p++;
      const aliasTok = kids[p];
      let alias = implicitName;
      if (aliasTok !== undefined && toks[aliasTok].kind === 'ident' && !NOT_AN_ALIAS.has(toks[aliasTok].v)) {
        alias = toks[aliasTok].v;
        if (isOp(kids[p + 1], '(')) columns = columnList(kids[p + 1]);
      }
      if (alias) add(aliases, block, { name: alias, columns });
    }
  }

  // ── pass 3: every `alias.column` read ──
  const violations: AliasViolation[] = [];
  let checkedReads = 0;
  for (let i = 0; i + 2 < n; i++) {
    if (toks[i].kind !== 'ident' || !isOp(i + 1, '.') || toks[i + 2].kind !== 'ident') continue;
    if (isOp(i - 1, '.')) continue; // the middle of `schema.table.column`
    if (isOp(i + 3, '(')) continue; // `schema.function(`
    const defs = lookup(aliases, blockOf[i], toks[i].v);
    if (!defs || defs.length !== 1) continue; // undefined here, or ambiguous
    const cols = defs[0].columns;
    if (!cols) continue;
    checkedReads++;
    const col = toks[i + 2].v;
    if (!cols.has(col)) violations.push({ alias: toks[i].v, column: col, exposes: [...cols].sort() });
  }
  return { violations, checkedReads };
}

/**
 * The columns each table has, folded from the migration files in the order they apply.
 *
 * Only the three statements that change a table's column set are read, and only in the plain forms this
 * schema uses: `CREATE TABLE IF NOT EXISTS t (...)`, `ALTER TABLE t ADD COLUMN [IF NOT EXISTS] c`, and
 * `ALTER TABLE t DROP COLUMN [IF EXISTS] c`. VIEWS ARE DELIBERATELY NOT COLLECTED - a view's columns
 * come from its own SELECT and are answered by the derived-relation half of this checker; putting a
 * half-parsed view in the map would turn a valid read into a false violation.
 */
export function tableColumnsFromSchemaDir(dir: string): TableColumns {
  const fs: typeof import('fs') = require('fs');
  const path: typeof import('path') = require('path');
  const tables: TableColumns = new Map();

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    // Comments can hold any of these statements as prose; strip them before matching.
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    for (const m of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi)) {
      const cols = tables.get(m[1].toLowerCase()) ?? new Set<string>();
      // One column per line at the body's top level: `name TYPE ...`. A trailing table constraint
      // (PRIMARY KEY, UNIQUE, CHECK, FOREIGN KEY) is not a column and is skipped by the keyword test.
      let depth = 0;
      for (const rawLine of m[2].split('\n')) {
        const atTopLevel = depth === 0;
        for (const ch of rawLine) {
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
        }
        if (!atTopLevel) continue;
        const c = /^\s+([a-z_][a-z0-9_]*)\s+[A-Za-z]/.exec(rawLine);
        if (c && !['primary', 'unique', 'check', 'foreign', 'constraint', 'exclude'].includes(c[1].toLowerCase())) {
          cols.add(c[1].toLowerCase());
        }
      }
      tables.set(m[1].toLowerCase(), cols);
    }

    // EVERY `ADD COLUMN` OF ONE STATEMENT, not only the first: 008 adds four columns to `embeddings` in
    // one ALTER, and reading the first alone left `title` out of the schema, so a correct read of it was
    // reported as a missing column.
    for (const m of sql.matchAll(/ALTER TABLE\s+(?:IF EXISTS\s+)?([a-z_][a-z0-9_]*)\s+((?:[^;'"]|'[^']*'|"[^"]*")*)/gi)) {
      const cols = tables.get(m[1].toLowerCase());
      for (const a of m[2].matchAll(/\bADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) cols?.add(a[1].toLowerCase());
    }
    for (const m of sql.matchAll(/ALTER TABLE\s+(?:IF EXISTS\s+)?([a-z_][a-z0-9_]*)\s+DROP COLUMN\s+(?:IF EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
      tables.get(m[1].toLowerCase())?.delete(m[2].toLowerCase());
    }
    // A rename moves the column to its new name (079 renames `user_sub` to `person_id`).
    for (const m of sql.matchAll(/ALTER TABLE\s+(?:IF EXISTS\s+)?([a-z_][a-z0-9_]*)\s+RENAME COLUMN\s+([a-z_][a-z0-9_]*)\s+TO\s+([a-z_][a-z0-9_]*)/gi)) {
      const cols = tables.get(m[1].toLowerCase());
      if (cols?.delete(m[2].toLowerCase())) cols.add(m[3].toLowerCase());
    }
  }
  return tables;
}

export interface SqlLiteral { text: string; line: number }

/**
 * Every string or template literal in a TypeScript source that reads as SQL (contains SELECT), with
 * each `${...}` replaced by a placeholder the checker treats as unknown.
 */
export function sqlLiteralsIn(source: string, fileName = 'source.ts'): SqlLiteral[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: SqlLiteral[] = [];
  const visit = (node: ts.Node) => {
    let text: string | undefined;
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) {
      text = node.head.text + node.templateSpans.map((s) => ` ${INTERP} ${s.literal.text}`).join('');
    }
    if (text !== undefined && /\bselect\b/i.test(text)) {
      out.push({ text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    if (!ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
    else node.templateSpans.forEach((s) => ts.forEachChild(s.expression, visit));
  };
  visit(sf);
  return out;
}
