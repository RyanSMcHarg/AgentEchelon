/**
 * The shared comment stripper does not blank code that merely LOOKS like a comment opener.
 *
 * WHY THIS DESERVES ITS OWN TEST. Seven ratchets in this repo strip comments before scanning source, and
 * four of them carried the naive pattern `replace(/\/\*[\s\S]*?\*\//g, '')`. An IAM or ARN glob such as
 * `${appInstanceArn}/user/*` ENDS in `/*`, which that pattern reads as a comment opener - so everything
 * from the glob to the next close-comment is erased. A source-scan guard then passed with a raw
 * `PolicyStatement` deliberately planted in the stack, because the plant sat inside the erased region.
 *
 * That is the worst failure a guard can have: not a wrong answer, but no answer, reported as a pass. The
 * defect was found by mutation in one file and fixed there; the other four kept the broken form until the
 * stripper was given one home. These cases are what "one home" is worth - the fix is now asserted rather
 * than remembered, so a future edit that reaches for the obvious regex fails here.
 */
import { stripComments } from './helpers/strip-comments';

describe('a `/*`-terminated glob is not a comment opener', () => {
  it('keeps code following an ARN glob — the exact case that defeated a real guard', () => {
    // A LATER `*/` IS ESSENTIAL TO THIS FIXTURE. The naive pattern is lazy, so a glob with no
    // close-comment after it never matches and nothing is blanked - a fixture without one passes under
    // BOTH forms and proves nothing. A real stack file always has both: ARN globs and block comments
    // after them, which is precisely why the defect was reachable there and invisible in a small test.
    const src = [
      "const p = new PolicyStatement({ resources: [`${appInstanceArn}/user/*`] });",
      "const planted = new PolicyStatement({ actions: ['chime:SendChannelMessage'] });",
      '/* an ordinary block comment further down the file */',
      'const after = 1;',
    ].join('\n');

    const out = stripComments(src);
    // Under the naive form everything from the glob to that later `*/` is erased, so a scan for a raw
    // grant finds nothing and reports the file clean.
    expect(out).toContain('planted');
    expect(out).toContain('SendChannelMessage');
    expect(out).toContain('const after = 1;');
  });

  it('keeps a symbol that a FORBIDDEN_ANYWHERE list would need to see', () => {
    // The direction that matters for a zero-expected assertion: blanking turns red into green.
    const src = [
      "resources: [`${arn}/bot/*`],",
      'const x = classifyIntent(content);',
      '/* a real block comment mentioning classifyIntent */',
    ].join('\n');

    const out = stripComments(src);
    expect((out.match(/\bclassifyIntent\b/g) || []).length).toBe(1); // the call, not the prose
  });
});

describe('it still strips what it is supposed to strip', () => {
  it('removes a real block comment', () => {
    const out = stripComments('const a = 1;\n/* secretSymbol lives here */\nconst b = 2;');
    expect(out).not.toContain('secretSymbol');
    expect(out).toContain('const a = 1;');
    expect(out).toContain('const b = 2;');
  });

  it('removes a block comment at the very start of the input', () => {
    // `(^|\s)` has to accept start-of-string, not only whitespace, or a file-leading docstring survives
    // and its prose satisfies the very checks it explains.
    const out = stripComments('/* leadingProse */\nconst a = 1;');
    expect(out).not.toContain('leadingProse');
  });

  it('removes a multi-line block comment', () => {
    const out = stripComments('const a = 1;\n/**\n * multiLineProse\n */\nconst b = 2;');
    expect(out).not.toContain('multiLineProse');
    expect(out).toContain('const b = 2;');
  });

  it('removes a whole-line // comment but leaves code intact', () => {
    const out = stripComments('  // lineProse mentions createTask\nconst a = createTask();');
    expect(out).not.toContain('lineProse');
    expect((out.match(/\bcreateTask\b/g) || []).length).toBe(1);
  });

  it('leaves a TRAILING // comment alone, deliberately', () => {
    // Stripping it naively takes the code on the same line with it. No ratchet needs that, and losing a
    // line of real code is a worse failure than counting a trailing note.
    const out = stripComments('const a = createTask(); // trailing note');
    expect(out).toContain('createTask()');
  });
});
