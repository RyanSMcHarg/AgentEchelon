/**
 * A BACKTICK INSIDE A SQL TEMPLATE LITERAL TERMINATES THE LITERAL.
 *
 * Every query in this codebase is a template literal, and SQL comments inside them are the natural
 * place to explain a join. Writing `exchanges` in one of those comments - the way every other comment
 * in the repo names an identifier - ends the string, and TypeScript then reports a cascade of
 * `TS1005: ',' expected` at a line that has nothing to do with the cause.
 *
 * It happened FOUR times in one session. `tsc` catches it every time, so it has never shipped, but it
 * is pure friction and entirely mechanical - which is what a test is for. This fails with the file
 * and the line rather than with a parser error twenty lines away.
 *
 * NOT A STYLE RULE. Outside a template literal a backtick is ordinary and correct; this only looks
 * inside the SQL strings, and only at their comment lines.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'lambda', 'src');

/** Every .ts file under lambda/src, which is where the queries live. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('SQL comments inside template literals carry no backtick', () => {
  const files = sourceFiles(SRC);

  it('scans a realistic number of files (the guard is wired to the tree)', () => {
    // An empty scan would pass this file for free, which is the failure mode it exists to catch
    // elsewhere.
    expect(files.length).toBeGreaterThan(50);
  });

  it('no `--` comment line inside a template literal contains a backtick', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      // Track whether we are inside a template literal by counting unescaped backticks per line. A
      // SQL comment line is one whose first non-space characters are `--`, which is unambiguous:
      // TypeScript has no such comment, so the line can only be inside a string.
      let inTemplate = false;
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        const isSqlComment = trimmed.startsWith('--');
        if (isSqlComment && inTemplate && line.includes('`')) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${trimmed.slice(0, 80)}`);
        }
        // Count after the check, so a comment line that itself closes the literal is still reported.
        const ticks = (line.match(/(?<!\\)`/g) || []).length;
        if (ticks % 2 === 1) inTemplate = !inTemplate;
      });
    }

    // Compared as an array so the diff names every offender by file and line. A backtick here ends
    // the template literal, and TypeScript then reports the failure somewhere else entirely - name
    // the identifier without one.
    expect(offenders).toEqual([]);
  });
});
