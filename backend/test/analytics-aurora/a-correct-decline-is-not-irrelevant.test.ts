/**
 * A CORRECT DECLINE IS NOT AN IRRELEVANT ANSWER.
 *
 * Observed live: a question outside the assistant's domain was declined - correctly, and in the
 * words its own configuration calls for - and the judge returned `irrelevant` for relevance while
 * returning NO breach of `scope.stayed-in-remit`, the rule requiring the assistant to "decline
 * rather than improvise when a request falls outside it". ONE model call, in ONE response, scored
 * the same turn as obeying a rule and as having failed.
 *
 * The old 0-24 band was literally true about the reply - a decline does not address the question
 * asked - which is precisely why it survived: it was right about the ANSWER and wrong about what was
 * being MEASURED. The cost is not cosmetic. `irrelevant` folds into `poor_count` alongside `poor`
 * and `error_response`, so every correct refusal dragged the Effectiveness quality rate down, and a
 * deployment whose assistants police their own scope well scored worst for doing it.
 *
 * ASSERTED ON THE PROMPT TEXT, because the prompt IS the behavior here. There is no branch to
 * exercise: what the judge does is decided by the wording it is handed, so the wording is the thing
 * a regression would change. Same family as `the-judge-is-not-told-the-intent.test.ts`, and the same
 * limitation - this pins what the judge is ASKED, not what it answers.
 */
import * as fs from 'fs';
import * as path from 'path';

const RUNNER = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'evaluation-runner.ts');
const runner = fs.readFileSync(RUNNER, 'utf8');

/**
 * The prompt template only, with the surrounding rationale removed.
 *
 * The explanation above the constant names the defect in detail, and a scan that read it would pass
 * on the comment while the rubric said the opposite - the exact vacuity this file exists to avoid.
 */
const prompt = (() => {
  const start = runner.indexOf('const RELEVANCE_PROMPT = `');
  const end = runner.indexOf('`;', start);
  if (start < 0 || end < 0) throw new Error('RELEVANCE_PROMPT not found in the runner');
  return runner.slice(start, end);
})();

describe('the rubric distinguishes a correct decline from a failure to answer', () => {
  it('reaches Appropriate Refusal for an out-of-remit decline, not only for a jailbreak', () => {
    // The band existed and was gated on the USER being adversarial, so a benign question the
    // assistant is simply not for could never reach it - by construction, whatever the reply said.
    const refusalBand = prompt.slice(prompt.indexOf('Appropriate Refusal'));
    expect(refusalBand).toMatch(/OUTSIDE WHAT THIS ASSISTANT IS FOR/i);
    // And the gate is explicitly lifted, so a reader cannot conclude the adversarial case is still
    // the only way in.
    expect(refusalBand).toMatch(/Do not require the refusal to be\s*\n?\s*adversarial/i);
  });

  it('still covers the adversarial case it already covered', () => {
    // Widening a band must not drop what it had. A jailbreak refusal scoring `irrelevant` would be
    // the same defect pointing the other way.
    expect(prompt).toMatch(/adversarial, jailbreak or social-engineering/i);
  });

  it('tells the judge that Irrelevant is not where a declined request goes', () => {
    // The band the defect landed in has to say so itself. Fixing only the refusal band leaves two
    // readings that both fit, and the judge picked the wrong one for months.
    const irrelevantBand = prompt.slice(prompt.indexOf('(Irrelevant)'));
    expect(irrelevantBand).toMatch(/A correct decline is NOT irrelevant/i);
  });

  it('points the judge at the compliance rules as the statement of what the assistant is for', () => {
    // The rules are already rendered into this same prompt, which is why no new context had to be
    // plumbed in: the judge knew what the assistant must decline and was never told that obeying
    // that is not irrelevance.
    expect(prompt).toMatch(/an obedient decline is an Appropriate Refusal, never Irrelevant/i);
  });

  it('does not reach the refusal band by naming the assistant\'s domain', () => {
    // A rubric that hardcoded "Stratum" would score the demo well and every other deployment badly.
    // The remit has to be read from the assistant's own configuration, never from this file.
    expect(prompt).not.toMatch(/stratum/i);
  });
});
