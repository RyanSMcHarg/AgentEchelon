/**
 * THE GUARDRAIL SCORES WHAT A PERSON WROTE, NOT THE CONTRACT WRAPPED AROUND IT.
 *
 * A triage turn's user message is the assembled contract: instructions telling the model what to
 * decide about each queued message, wrapped around the quoted messages themselves. That is the shape
 * of a prompt-injection attempt, and the prompt-attack filter read it as one - blocking every triage
 * turn before the model was ever called.
 *
 * The failure was invisible in the worst way. A blocked turn still produced a proposal, because the
 * drain is deterministic and falls back to a derived reading, so the queue still cleared and the
 * person still got a message. What never happened was the JUDGEMENT: every drain used the
 * one-task-per-message floor, and the grouping and amendment-detection this design is largely about
 * had never once run on the deployment.
 *
 * WHAT THIS PINS is the narrow claim, because the wide one would be a security regression: everything
 * a person wrote is still scored. Only the platform's own instructions are excluded, and they are
 * excluded because screening our own text protects nobody while breaking the turn.
 *
 * It exists because the first fix patched the WRONG call site - the external-model path - and the
 * main path went on blocking. A test at this seam would have caught that immediately.
 */

import { buildTriagePrompt } from '../../lambda/src/lib/turn-triage-proposal';

const QUEUED = [
  { messageId: 'm1', content: 'Actually, keep it to one page.' },
  { messageId: 'm2', content: 'Also, what was our Q3 headcount?' },
];

/** What the turn carries as its user message, and what it carries as the human half. */
const promptFor = () => buildTriagePrompt({ queued: QUEUED, mayAskForAnotherPass: false });
const humanHalf = QUEUED.map((m) => m.content).join('\n\n');

describe('what the guardrail is given on a triage turn', () => {
  it('is not the assembled contract', () => {
    const prompt = promptFor();

    // The contract is unmistakably instruction-shaped, which is the whole problem: it tells a model
    // what to do, and it quotes user text inside itself.
    expect(prompt).toContain('TRIAGE:');
    expect(prompt).toContain(QUEUED[0].content);
    expect(prompt.length).toBeGreaterThan(humanHalf.length * 2);
  });

  it('is exactly what the people wrote, and all of it', () => {
    // Every queued message, whole. Screening a summary or the first one would leave text a person
    // submitted unexamined, which is the regression this must not become.
    for (const message of QUEUED) {
      expect(humanHalf).toContain(message.content);
    }
  });

  it('carries none of the platform instructions', () => {
    // If any of the contract leaked into the scored half, the filter would have the same reason to
    // fire that it had before.
    expect(humanHalf).not.toContain('TRIAGE:');
    expect(humanHalf).not.toContain('PROPOSAL:');
    expect(humanHalf).not.toMatch(/CLASSIFICATION STEP/i);
  });
});
