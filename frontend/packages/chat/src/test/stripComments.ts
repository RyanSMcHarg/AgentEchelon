/**
 * Remove comments from TypeScript source, WITHOUT treating `/*` inside a string as a comment.
 *
 * The obvious one-liner - `src.replace(/\/\*[\s\S]*?\*\//g, '')` - is wrong on this codebase and wrong in a way
 * that hides itself. A stack that writes an IAM wildcard as `'/*'` opens a "comment"
 * that runs to the next `*\/` hundreds of lines later: in one stack file 76,663 of 88,020 characters disappeared, 87% of the
 * file, including both of its REST API declarations. A source-level guard using that stripper reported the file
 * as having no APIs at all and passed, which is the exact failure mode - a green test that checked nothing -
 * that several guards in this repo exist to prevent.
 *
 * So this scans instead, tracking whether it is inside a single-quoted, double-quoted or template string. It is
 * not a parser: it does not handle a regex literal containing an unbalanced quote, and it does not need to.
 * What it guarantees is that a quoted `/*` never starts a comment.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    // A string: copy it verbatim, honouring backslash escapes, and never look for comments inside.
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }

    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;                                  // the newline itself is copied by the next iteration
    }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';                                // a space, so two tokens either side do not fuse
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}
