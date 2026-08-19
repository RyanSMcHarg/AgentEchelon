/**
 * Strip comments from source before a ratchet scans it — ONE definition, because the naive form is wrong
 * in a way that silently disables the scan.
 *
 * WHAT GOES WRONG. The obvious pattern is `replace(/\/\*[\s\S]*?\*\//g, '')`. An IAM or ARN glob such as
 * `${appInstanceArn}/user/*` ENDS in `/*`, which that pattern reads as a comment opener - so everything
 * from there to the next close-comment is blanked. A source-scan guard passed with a raw
 * `PolicyStatement` planted in the stack for exactly this reason: the planted code sat inside a region
 * the stripper had erased.
 *
 * A guard that cannot see the thing it checks is not a weak guard, it is a silent pass. Requiring
 * whitespace (or start-of-input) before the opener fixes it: a glob's `/*` is preceded by a path
 * character, a real block comment is preceded by a newline or a space. The `$1` puts that character back
 * so token boundaries survive.
 *
 * SEVEN COPIES OF THIS REGEX EXISTED and four of them were the broken form, including one in a file
 * edited the same day the defect was found. That is why it lives here now: the fix has one home, and a
 * new ratchet inherits it instead of pasting whichever version it happened to copy.
 *
 * NOT A JEST TEST FILE (no `.test.`), so jest ignores it.
 */

/**
 * Source with block comments and line comments removed.
 *
 * Line comments are stripped only when they start a line, deliberately: a trailing `// …` after code
 * would take the code with it on a naive match, and no ratchet needs that.
 */
export function stripComments(src: string): string {
  return src
    .replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1')
    .replace(/^\s*\/\/.*$/gm, '');
}
