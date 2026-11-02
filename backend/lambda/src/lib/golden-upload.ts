/**
 * A DEPLOYMENT'S OWN GOLDEN ENTRIES, READ FROM ITS FILE (ADR-065 decision 7, SPEC-EVALUATION FR29).
 *
 * An upload is a JSON Lines file, one entry per line, or a CSV file with a header row naming the same columns:
 *
 *   intent             an intent the assistant serves (its draft's pack or its active version's)
 *   request            what the person asks
 *   reference          optional: an answer a person judged good
 *   precedingTurns     optional: up to six turns before the request, `[{ "role": "user"|"assistant", "text" }]`
 *                      (a JSON array in a CSV cell)
 *   replyPreferences   optional: reply-preference keys and values from the registry (a JSON object in a CSV cell)
 *
 * The whole file is read before anything is stored, and one bad line refuses the file, naming each line and what is
 * wrong with it, so a corrected file is uploaded whole rather than a half of it standing in the set. The text read here
 * is not yet de-identified: the golden run's import does that before it writes (`golden-run.ts`). Pure, so the rules
 * are pinned by unit tests.
 */
import { REPLY_PREFERENCES } from '../../../lib/config/reply-preferences.js';
import { createHash } from 'crypto';
import { GOLDEN_PRECEDING_TURNS, type PrecedingTurn } from './golden-entry.js';

/**
 * The live entries one assistant's set holds: what one run answers at k = 3 inside the function's 15 minutes (ADR-065
 * Option A). An upload that would pass it is refused, naming the count.
 */
export const GOLDEN_SET_CAPACITY = 100;
/**
 * Where a golden-set hand-over is written for one assistant: an upload's checked entries, or a run's input, read once by
 * the classification's GoldenRun function and removed (tenet D15: the classification, then the assistant, name the owner).
 */
export const goldenUploadPrefix = (classification: string, assistant: string): string => `golden-uploads/${classification}/${assistant}/`;

/** One upload's bounds: no more entries than the set holds, and what one request carries. */
export const GOLDEN_UPLOAD_MAX_LINES = GOLDEN_SET_CAPACITY;
export const GOLDEN_UPLOAD_MAX_BYTES = 1_000_000;
/** The longest single text an entry carries: a request, a reference or one preceding turn. */
export const GOLDEN_UPLOAD_MAX_TEXT = 8000;
/** How many problems a refusal names; the count says how many there were. */
export const GOLDEN_UPLOAD_MAX_PROBLEMS = 50;

export type GoldenUploadFormat = 'jsonl' | 'csv';

const COLUMNS = ['intent', 'request', 'reference', 'precedingTurns', 'replyPreferences'] as const;
type Column = (typeof COLUMNS)[number];

export interface UploadedEntry {
  /** The line of the file the entry starts on, from 1. */
  line: number;
  intent: string;
  request: string;
  reference: string | null;
  precedingTurns: PrecedingTurn[];
  replyPreferences: Record<string, string> | null;
}

export type UploadProblemCode =
  | 'NOT_JSON'
  | 'NOT_AN_OBJECT'
  | 'UNKNOWN_FIELD'
  | 'MISSING_FIELD'
  | 'NOT_TEXT'
  | 'TOO_LONG'
  | 'UNKNOWN_INTENT'
  | 'BAD_TURNS'
  | 'UNKNOWN_PREFERENCE'
  | 'WRONG_CELL_COUNT'
  | 'DUPLICATE';

export interface UploadProblem {
  line: number;
  code: UploadProblemCode;
  /** The field or column the problem is in, where it is in one. */
  field?: string;
}

export type UploadRefusalCode = 'BAD_FORMAT' | 'EMPTY' | 'TOO_LARGE' | 'TOO_MANY_LINES' | 'BAD_HEADER' | 'INVALID_LINES';

export type GoldenUploadRead =
  | { ok: true; entries: UploadedEntry[] }
  | {
    ok: false;
    code: UploadRefusalCode;
    /** The values the console words the refusal with. */
    params: Record<string, string | number>;
    /** Each problem, up to `GOLDEN_UPLOAD_MAX_PROBLEMS`, on `INVALID_LINES`. */
    problems?: UploadProblem[];
  };

/** Read an upload. `intents` is every intent the assistant serves; an entry naming another is refused. */
export function readGoldenUpload(format: unknown, content: unknown, intents: ReadonlySet<string>): GoldenUploadRead {
  if (format !== 'jsonl' && format !== 'csv') return { ok: false, code: 'BAD_FORMAT', params: { formats: 'jsonl, csv' } };
  if (typeof content !== 'string') return { ok: false, code: 'EMPTY', params: {} };
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > GOLDEN_UPLOAD_MAX_BYTES) return { ok: false, code: 'TOO_LARGE', params: { bytes, max: GOLDEN_UPLOAD_MAX_BYTES } };
  const text = content.replace(/^﻿/, '');
  const records = format === 'jsonl' ? jsonlRecords(text) : csvRecords(text);
  if ('refusal' in records) return records.refusal;
  if (!records.rows.length) return { ok: false, code: 'EMPTY', params: {} };
  if (records.rows.length > GOLDEN_UPLOAD_MAX_LINES) {
    return { ok: false, code: 'TOO_MANY_LINES', params: { lines: records.rows.length, max: GOLDEN_UPLOAD_MAX_LINES } };
  }
  const problems: UploadProblem[] = [];
  const entries: UploadedEntry[] = [];
  const seen = new Set<string>();
  for (const row of records.rows) {
    if ('problem' in row) {
      problems.push(row.problem);
      continue;
    }
    const before = problems.length;
    const entry = entryOf(row.line, row.fields, intents, problems);
    if (problems.length > before || !entry) continue;
    const key = `${entry.intent}\n${entry.request.trim().toLowerCase()}`;
    if (seen.has(key)) {
      problems.push({ line: row.line, code: 'DUPLICATE', field: 'request' });
      continue;
    }
    seen.add(key);
    entries.push(entry);
  }
  if (problems.length) {
    return {
      ok: false,
      code: 'INVALID_LINES',
      params: { count: new Set(problems.map((p) => p.line)).size, lines: records.rows.length },
      problems: problems.slice(0, GOLDEN_UPLOAD_MAX_PROBLEMS),
    };
  }
  return { ok: true, entries };
}

type Row = { line: number; fields: Partial<Record<Column, unknown>> } | { problem: UploadProblem };
type Records = { rows: Row[] } | { refusal: GoldenUploadRead & { ok: false } };

function jsonlRecords(text: string): Records {
  const rows: Row[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      rows.push({ problem: { line, code: 'NOT_JSON' } });
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      rows.push({ problem: { line, code: 'NOT_AN_OBJECT' } });
      return;
    }
    const unknown = Object.keys(parsed).find((k) => !(COLUMNS as readonly string[]).includes(k));
    if (unknown) {
      rows.push({ problem: { line, code: 'UNKNOWN_FIELD', field: unknown } });
      return;
    }
    rows.push({ line, fields: parsed as Partial<Record<Column, unknown>> });
  });
  return { rows };
}

function csvRecords(text: string): Records {
  const records = parseCsv(text).filter((r) => !(r.cells.length === 1 && !r.cells[0].trim()));
  const header = records.shift();
  if (!header) return { rows: [] };
  const names = header.cells.map((c) => c.trim());
  const unknown = names.find((n) => !(COLUMNS as readonly string[]).includes(n));
  const missing = (['intent', 'request'] as const).find((n) => !names.includes(n));
  if (unknown !== undefined || missing || new Set(names).size !== names.length) {
    return {
      refusal: {
        ok: false,
        code: 'BAD_HEADER',
        params: { columns: COLUMNS.join(', '), found: names.join(', ') },
      },
    };
  }
  const rows: Row[] = records.map((r) => {
    if (r.cells.length !== names.length) return { problem: { line: r.line, code: 'WRONG_CELL_COUNT' } };
    const fields: Partial<Record<Column, unknown>> = {};
    names.forEach((n, i) => {
      const cell = r.cells[i];
      if (cell === '') return;
      // A JSON cell that does not parse is kept as text, so the entry's own check names the field.
      if (n === 'precedingTurns' || n === 'replyPreferences') {
        try {
          fields[n as Column] = JSON.parse(cell);
        } catch {
          fields[n as Column] = cell;
        }
      } else {
        fields[n as Column] = cell;
      }
    });
    return { line: r.line, fields };
  });
  return { rows };
}

/**
 * RFC 4180: a quoted cell may hold commas, line breaks and doubled quotes. Each record carries the line it starts on,
 * so a problem is named where a person finds it in the file.
 */
export function parseCsv(text: string): Array<{ line: number; cells: string[] }> {
  const out: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      out.push({ line: start, cells });
      cells = [];
      cell = '';
      line++;
      start = line;
    } else cell += ch;
  }
  if (cell !== '' || cells.length) {
    cells.push(cell);
    out.push({ line: start, cells });
  }
  return out;
}

function textField(line: number, field: Column, value: unknown, required: boolean, problems: UploadProblem[]): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    if (required) problems.push({ line, code: 'MISSING_FIELD', field });
    return null;
  }
  if (typeof value !== 'string') {
    problems.push({ line, code: 'NOT_TEXT', field });
    return null;
  }
  if (value.length > GOLDEN_UPLOAD_MAX_TEXT) {
    problems.push({ line, code: 'TOO_LONG', field });
    return null;
  }
  return value.trim();
}

function entryOf(line: number, f: Partial<Record<Column, unknown>>, intents: ReadonlySet<string>, problems: UploadProblem[]): UploadedEntry | null {
  const intent = textField(line, 'intent', f.intent, true, problems);
  if (intent && !intents.has(intent)) problems.push({ line, code: 'UNKNOWN_INTENT', field: 'intent' });
  const request = textField(line, 'request', f.request, true, problems);
  const reference = textField(line, 'reference', f.reference, false, problems);

  let precedingTurns: PrecedingTurn[] = [];
  if (f.precedingTurns !== undefined && f.precedingTurns !== null) {
    const turns = f.precedingTurns;
    const valid = Array.isArray(turns) && turns.length <= GOLDEN_PRECEDING_TURNS && turns.every((t) =>
      t && typeof t === 'object' && ((t as PrecedingTurn).role === 'user' || (t as PrecedingTurn).role === 'assistant')
      && typeof (t as PrecedingTurn).text === 'string' && !!(t as PrecedingTurn).text.trim()
      && (t as PrecedingTurn).text.length <= GOLDEN_UPLOAD_MAX_TEXT
      && Object.keys(t).every((k) => k === 'role' || k === 'text'));
    if (!valid) problems.push({ line, code: 'BAD_TURNS', field: 'precedingTurns' });
    else precedingTurns = (turns as PrecedingTurn[]).map((t) => ({ role: t.role, text: t.text.trim() }));
  }

  let replyPreferences: Record<string, string> | null = null;
  if (f.replyPreferences !== undefined && f.replyPreferences !== null) {
    const prefs = f.replyPreferences;
    const valid = !!prefs && typeof prefs === 'object' && !Array.isArray(prefs)
      && Object.entries(prefs).every(([k, v]) => typeof v === 'string' && !!REPLY_PREFERENCES[k]?.values[v]);
    if (!valid) problems.push({ line, code: 'UNKNOWN_PREFERENCE', field: 'replyPreferences' });
    else if (Object.keys(prefs as object).length) replyPreferences = { ...(prefs as Record<string, string>) };
  }

  if (!intent || !request) return null;
  return { line, intent, request, reference, precedingTurns, replyPreferences };
}

/** Every text of an entry, in a fixed order, as the import sends them to the detector. */
export function textsOf(e: UploadedEntry): string[] {
  return [e.request, ...(e.reference ? [e.reference] : []), ...e.precedingTurns.map((t) => t.text)];
}

/** The entry with its texts replaced, in the order `textsOf` gave them. */
export function withTexts(e: UploadedEntry, texts: string[]): UploadedEntry {
  let i = 0;
  const request = texts[i++];
  const reference = e.reference ? texts[i++] : null;
  const precedingTurns = e.precedingTurns.map((t) => ({ role: t.role, text: texts[i++] }));
  return { ...e, request, reference, precedingTurns };
}

/**
 * AN UPLOAD'S ID IS ITS CONTENT'S, so the same file sent again for the same assistant is the same upload: while it runs a
 * second send starts nothing, and once written it writes nothing again. UUID-shaped, for the column.
 */
export function uploadIdFor(assistant: string, format: unknown, content: unknown): string {
  const h = createHash('sha256').update(`${assistant}\n${String(format)}\n${String(content)}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
