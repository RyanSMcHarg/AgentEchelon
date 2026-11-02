/**
 * A BACKTICK INSIDE A TEMPLATE LITERAL ENDS IT.
 *
 * SQL in this codebase is written in template literals, and the house style quotes identifiers in
 * prose with backticks. Put those two together inside a SQL comment and the string terminates in the
 * middle of a query: the module stops parsing, and because it fails at LOAD the Lambda never starts.
 * Not a slow query, not a wrong answer - nothing runs at all.
 *
 * THIS HAS HAPPENED THREE TIMES IN ONE DAY, each time while writing an explanatory SQL comment, and
 * each time it was caught only because somebody happened to run `tsc` before deploying. `tsc` is the
 * real check; this test exists because the failure is silent to a reader, trivially reintroduced by
 * the repo's own commenting habit, and catastrophic rather than degrading.
 *
 * It scans the files that actually carry SQL template literals for a backtick inside one.
 */
import * as fs from 'fs';
import * as path from 'path';

const AURORA = path.join(__dirname, '..', 'lambda', 'src', 'analytics-aurora');
const LIB = path.join(__dirname, '..', 'lambda', 'src', 'lib');

/** Files whose bodies are mostly SQL template literals. */
function sqlBearingFiles(): string[] {
  const out: string[] = [];
  for (const dir of [AURORA, LIB]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
      const full = path.join(dir, name);
      const text = fs.readFileSync(full, 'utf8');
      if (/\bSELECT\b[\s\S]{0,200}\bFROM\b/i.test(text)) out.push(full);
    }
  }
  return out;
}

const TICK = String.fromCharCode(96);

/**
 * Every backtick-delimited region of a source file, as [start, end) offsets.
 *
 * Deliberately simple: it walks the text tracking whether it is inside a template literal, skipping
 * escaped backticks. It does not try to understand `${}` interpolation, because a nested literal is
 * still a literal for this purpose - the question is only whether a SQL COMMENT line inside one
 * contains a raw backtick.
 */
function templateRegions(text: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] !== TICK) continue;
    if (open < 0) open = i;
    else { regions.push([open, i]); open = -1; }
  }
  return regions;
}

describe('SQL comments do not carry backticks', () => {
  const files = sqlBearingFiles();

  it('finds the files it is supposed to be checking', () => {
    // A scan that silently matches nothing passes forever. Name the one file that must be in it.
    expect(files.length).toBeGreaterThan(3);
    expect(files.some((f) => f.endsWith('analytics-query.ts'))).toBe(true);
  });

  it.each(sqlBearingFiles().map((f) => [path.basename(f), f]))(
    '%s: no SQL comment inside a template literal contains a backtick',
    (_name, full) => {
      const text = fs.readFileSync(full as string, 'utf8');
      const offenders: string[] = [];

      // ── SCANNED BY LINE, NOT BY TEMPLATE REGION, AND THAT IS THE WHOLE CORRECTION ─────────────
      //
      // This used to pair backticks to find template literals and then check only the lines inside
      // them. That cannot work, and it failed in exactly the way the defect predicts: a stray
      // backtick ENDS the literal, so from the pairing scanner's point of view the offending comment
      // is no longer inside one and never gets checked. The bug defeats the parser looking for it.
      //
      // Missed a real instance on 2026-09-23 - a SQL comment carrying a column name in backticks -
      // which typecheck caught instead. A guard that only fires when the damage is small is worse
      // than none, because it is trusted.
      //
      // A line starting with -- is a SQL comment wherever it appears: TypeScript's comments are //
      // and /* */, so there is no false-positive class to trade away here. Checking every such line
      // in a SQL-bearing file needs no parse at all and cannot be defeated by the thing it looks for.
      text.split(String.fromCharCode(10)).forEach((line, idx) => {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith('--')) return;
        if (!line.includes(TICK)) return;
        offenders.push(`  line ${idx + 1}: ${trimmed.slice(0, 100)}`);
      });

      // The guidance rides IN the expected value, because jest's expect takes no message argument:
      // a failure then prints the fix beside the offending lines rather than a bare array diff.
      if (offenders.length) {
        expect([
          'A backtick in a SQL comment ENDS the template literal it sits in, so the module stops',
          'parsing and the Lambda fails at LOAD. Use "double quotes" for identifiers in SQL comments.',
          ...offenders,
        ]).toEqual([]);
      }
      expect(offenders).toEqual([]);
    },
  );
});
