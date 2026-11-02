/**
 * AN OPEN TRACKER ROW MUST CITE CODE THAT STILL EXISTS.
 *
 * THE FAILURE THIS EXISTS FOR, measured 2026-09-28: of eleven rows checked by hand in one session,
 * SIX were stale or asserting something false. Four described work that had since been built (339,
 * 333b, 302, 216) and two were wrong on their face - one claimed "nothing ever writes
 * `drift_events.outcome`" when three writers exist, and one recorded an expected 403 as a defect.
 * The owner's words for what that costs: "These have all been seen and discussed before so I am
 * going in circles."
 *
 * THE CAUSE IS STRUCTURAL, NOT CLERICAL. A row is written when a defect is FOUND and nothing ever
 * revisits it when the defect is FIXED, so the file only ever accumulates. This test cannot judge
 * whether a defect still matters - that needs a person reading code - but it can catch the cheapest
 * and most common form of rot: a row still claiming to be open while pointing at a file that no
 * longer exists. A citation that has evaporated is a row nobody can act on and nobody can trust.
 *
 * WHAT IT DOES NOT CLAIM. That a row's cited file still CONTAINS what the row says - only that the
 * file is there. Checking the claim itself is the `Verified` column's job, filled by a person or an
 * agent that actually read the code, and this test only insists the column exists to be filled.
 *
 * IT SKIPS WHEN THE TRACKER IS ABSENT, which is the normal case. `private/` is gitignored, so this
 * file does not exist in a fresh checkout or in CI for anyone but the owner. Failing there would
 * break the build for every contributor over a file they cannot see, so absence is a skip and never
 * a failure.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.join(__dirname, '..', '..');
const TRACKER = path.join(REPO, 'private', 'TRACKER-OPEN-WORK.md');
const HAVE_TRACKER = fs.existsSync(TRACKER);

/** The row id, in either shape the file uses. Never split a row on `|`: many carry escaped pipes. */
function idOf(line: string): string | null {
  const linked = line.match(/^\|\s*\[\[TRACKER-DETAIL#.*?\\?\|\s*(\d+[a-z]?)\s*\]\]/);
  if (linked) return linked[1];
  const plain = line.match(/^\|\s*(\d+[a-z]?)\s*\|/);
  return plain ? plain[1] : null;
}

interface Row { id: string; line: string; n: number }

/**
 * OPEN ENDS AT THE FIRST SECTION OF SETTLED ROWS. "Verified and retired" sits above "Closed", and a
 * retired row is history: it describes the code it was about, often exactly the code that was removed,
 * so reading it as open fails it for being finished.
 */
const isSettledSection = (l: string): boolean => l.startsWith('## Closed') || l.startsWith('## Verified and retired');

function openRows(): Row[] {
  // EMPTY RATHER THAN A THROW WHEN THE FILE IS ABSENT. `describe.skip` still EXECUTES its callback -
  // it only skips the `it`s inside - so a read at describe-body level runs even when the whole block
  // is skipped, and threw at collection time for anyone without `private/`. That turned a guard over
  // a gitignored file into a failing suite for every contributor, which is the one outcome this must
  // never have. Verified by hiding the tracker and re-running.
  if (!HAVE_TRACKER) return [];
  const lines = fs.readFileSync(TRACKER, 'utf8').split('\n');
  const closedAt = lines.findIndex(isSettledSection);
  const out: Row[] = [];
  for (let i = 0; i < (closedAt < 0 ? lines.length : closedAt); i++) {
    const id = idOf(lines[i]);
    if (id) out.push({ id, line: lines[i], n: i + 1 });
  }
  return out;
}

/**
 * Repo-relative source paths a row cites in backticks. Deliberately narrow: only paths under the
 * source trees, only with a known code extension, so prose like `manage-membership` or a bare
 * `drift_events` is never mistaken for a file.
 */
function citedFiles(line: string): string[] {
  const found = new Set<string>();
  for (const [, p] of line.matchAll(/`((?:backend|frontend|tests|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|css))(?::\d+(?:-\d+)?)?`/g)) {
    found.add(p);
  }
  return [...found];
}

const describeIfTracker = HAVE_TRACKER ? describe : describe.skip;

describeIfTracker('every open tracker row', () => {
  const rows = openRows();

  it('is found at all, so a parsing change cannot silently empty this guard', () => {
    // 427 open rows on 2026-09-28. A naive parse of this file reports about half that, because 225
    // rows carry their id inside a wiki-link - a mistake made twice here already. A floor well under
    // the real count still catches the parser breaking entirely.
    //
    // About 246 on 2026-10-09, once the retired table stopped being read as open (the 427 counted
    // its 275 settled rows). The floor stays well under the real count, so it still only catches a
    // parser that has broken outright.
    expect(rows.length).toBeGreaterThan(150);
  });

  it('cites source files that still exist', () => {
    const dead: string[] = [];
    for (const row of rows) {
      for (const file of citedFiles(row.line)) {
        if (!fs.existsSync(path.join(REPO, file))) dead.push(`  row ${row.id} (line ${row.n}) cites ${file}`);
      }
    }
    if (dead.length) {
      throw new Error(
        'Open tracker rows cite files that no longer exist:\n'
        + `${dead.join('\n')}\n\n`
        + 'A citation that has evaporated usually means the work landed and the row was never '
        + 'retired - which is how this file grew a backlog of settled questions. Re-read the row: '
        + 'close it, or repoint it at the code that replaced the file, and fill its `Verified` cell '
        + 'with the date and what you checked.',
      );
    }
  });

  it('has a Verified column to fill, in every open section', () => {
    // The column is the half a test cannot do: whether the row's CLAIM is still true. This only
    // insists the place to record that exists, so a row can be marked checked without a rewrite.
    const lines = HAVE_TRACKER ? fs.readFileSync(TRACKER, 'utf8').split('\n') : [];
    const closedAt = lines.findIndex(isSettledSection);
    const headers = lines
      .slice(0, closedAt < 0 ? lines.length : closedAt)
      .filter((l) => /^\|\s*#\s*\|.*What it is, and why it matters/.test(l));
    expect(headers.length).toBeGreaterThan(0);
    const missing = headers.filter((h) => !/\bVerified\b/.test(h));
    expect(missing).toEqual([]);
  });

  it('gives every row six cells, so the Verified column is the one being read', () => {
    /**
     * WITHOUT THIS, THE CHECK BELOW READS THE WRONG COLUMN AND PASSES.
     *
     * The table is `# | What it is | Status | Design doc | /doc-review | Verified`, and the undated-note
     * check takes `cells[length - 2]`, which is `Verified` only when the row has six cells. Nineteen rows
     * did not: fifteen had lost their Status cell entirely, so that index landed on `/doc-review` - usually
     * `-` - and their real Verified notes were never examined. Four more carried a raw `|` inside quoted
     * code (`days < 1 || days > 5475`, `down|clear`), which Markdown reads as a cell boundary, so those rows
     * also rendered with phantom empty columns.
     *
     * All nineteen were repaired on 2026-10-02, which is why this asserts the shape outright instead of
     * holding a shrinking allowlist: there is nothing left to except, and an allowlist with no entries is
     * just a weaker version of this.
     *
     * A pipe inside prose must be written `\|`.
     */
    const wrong = rows
      .map((row) => ({ id: row.id, cells: row.line.split(/(?<!\\)\|/).length - 2 }))
      .filter((r) => r.cells !== 6)
      .map((r) => `  row ${r.id}: ${r.cells} cells`);
    if (wrong.length) {
      throw new Error(
        'Every open tracker row needs exactly six cells '
        + '(# | What it is | Status | Design doc | /doc-review | Verified).\n'
        + 'A row with the wrong count is read positionally by the checks below, so a missing column makes '
        + 'them inspect the wrong one and pass. An unescaped `|` inside prose counts as a cell boundary - '
        + 'write it `\\|`.\n\n'
        + wrong.join('\n'),
      );
    }
  });

  it('dates a Verified note, so "checked" says when', () => {
    // A note with no date ages into the same uselessness as no note: the value of the column is
    // knowing whether the check predates the change you are looking at.
    const undated: string[] = [];
    for (const row of rows) {
      const cells = row.line.split(/(?<!\\)\|/);
      const verified = (cells[cells.length - 2] || '').trim();
      // Skip the wiki-link rows whose unescaped pipe makes a cell split unreliable.
      if (/\[\[/.test(row.line) && !/\\\|/.test(row.line)) continue;
      // `-` is this table's marker for "nothing here", used the same way in Design doc and
      // /doc-review. It is not an undated note, it is the absence of one, so it reads as empty.
      if (!verified || /^[-–—]+$/.test(verified)) continue;
      if (!/\d{4}-\d{2}-\d{2}/.test(verified)) undated.push(`  row ${row.id}: "${verified.slice(0, 60)}"`);
    }
    if (undated.length) {
      throw new Error(`A \`Verified\` note must carry the date it was checked:\n${undated.join('\n')}`);
    }
  });
});

// Absence is the normal case for everyone but the owner, and saying so beats a silent skip.
(HAVE_TRACKER ? it.skip : it)('is skipped because private/TRACKER-OPEN-WORK.md is not present', () => {
  expect(HAVE_TRACKER).toBe(false);
});
