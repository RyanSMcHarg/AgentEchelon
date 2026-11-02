/**
 * THE GUARDRAIL SCREENS WHAT A PERSON WROTE, NOT THE PROMPT WE WRAPPED AROUND IT.
 *
 * A stop evaluation's `userMessage` is an assembled CONTRACT: instructions telling the model what to
 * work out, wrapped around the person's own words and the labels of the work that was cancelled. That
 * is the shape of a prompt-injection attempt, so the input guardrail's prompt-attack filter fires on
 * our own scaffolding and blocks the turn before the model is ever called.
 *
 * The consequence is invisible until somebody needs it: `/stop` suppresses the answer and cancels the
 * work - both of which happen in the ROUTER and keep working - and then the evaluation that asks how
 * they want to proceed never runs. The person is told nothing about what happens next.
 *
 * Observed live 2026-09-09 on a sweep: `[AsyncProcessor] input guardrail intervened; blocking turn
 * before model call`, a stop-evaluation turn that went from Invoked to released in under a second
 * having judged nothing, and a `report_generation` row that never left its open status.
 *
 * ── THIS IS THE SECOND TIME, WHICH IS WHY IT IS A TEST AND NOT A COMMENT ────────────────────────
 *
 * `turn-triage.ts` carries the identical fix for the READING turn, with the identical reasoning
 * written above it: "the guardrail's prompt-attack filter fired on our own scaffolding and blocked
 * every triage turn before the model was ever called - which is why the judged reading never once
 * succeeded and every drain fell back to the derived floor." The stop path assembles its prompt the
 * same way and never got the same treatment.
 *
 * The answer is not to stop screening. It is to screen the part that is actually untrusted.
 */

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseStopEvaluationContext } = require('../../lambda/src/lib/stop-evaluation');

describe('a stop evaluation carries the untrusted text apart from the contract', () => {
  it('round-trips the person`s words through the request attribute', () => {
    const ctx = parseStopEvaluationContext(
      JSON.stringify({ heldCount: 2, userContent: 'stop the Q2 report\n\nQ2 ARR report' }),
    );
    expect(ctx.heldCount).toBe(2);
    expect(ctx.userContent).toBe('stop the Q2 report\n\nQ2 ARR report');
  });

  it('still parses a context written before the field existed', () => {
    // A stop dispatched by the previous version carries no `userContent`. It must not become
    // unreadable - that would turn a missing screen into a missing evaluation.
    const ctx = parseStopEvaluationContext(JSON.stringify({ heldCount: 1 }));
    expect(ctx.heldCount).toBe(1);
    expect(ctx.userContent).toBeUndefined();
  });

  it('refuses a malformed context rather than guessing', () => {
    expect(parseStopEvaluationContext('not json')).toBeUndefined();
    expect(parseStopEvaluationContext(JSON.stringify({ heldCount: -1 }))).toBeUndefined();
  });

  it('the dispatcher sends the person`s message and the cancelled labels, not the prompt', () => {
    const src = read('lambda/src/lib/stop-evaluation.ts');
    // The contract is built for `userMessage`; the untrusted half travels beside it.
    expect(src).toContain('userMessage: buildStopEvaluationPrompt(');
    expect(src).toContain('userContent: [precedingMessage ?? \'\', ...cancelledLabels]');
  });
});

describe('the processor screens that, and not the assembled prompt', () => {
  const handler = read('lambda/src/assistant-async-processor.ts');

  it('prefers the untrusted text for the input guardrail', () => {
    // THE ONE LINE THE DEFECT LIVED IN. Falling through to `userMessage` screens our own contract.
    expect(handler).toContain('event.stopEvaluation?.userContent');
    const at = handler.indexOf('const guardedInput = event.triage?.userContent');
    expect(at).toBeGreaterThan(-1);
    expect(handler.slice(at, at + 220)).toContain('event.stopEvaluation?.userContent');
  });

  it('attributes the turn to the same text', () => {
    // `userTurnText` is what the turn is recorded as having been asked. It read the contract too,
    // so a stop was archived as though the person had sent the platform's instructions.
    expect(handler).toContain(
      'userTurnText: event.triage?.userContent ?? event.stopEvaluation?.userContent',
    );
  });

  it('still falls back to userMessage for an ORDINARY turn', () => {
    // The fallback is what screens a real person's message on every normal turn, and removing it
    // would stop screening the thing the guardrail exists for.
    const at = handler.indexOf('const guardedInput = event.triage?.userContent');
    expect(handler.slice(at, at + 220)).toContain('event.userMessage');
  });
});

/**
 * ── AND THE THIRD PATH THAT ASSEMBLES A PROMPT: THE AMENDMENT FOLD (live evidence, 2026-09-09) ───
 *
 * A fold rewrites `userMessage` into the original request plus instructions about how to treat what
 * follows - "answer the request AS AMENDED", "do not mention that a revision happened". Screened as a
 * person's message that is a prompt-injection attempt in shape, and the filter fired on it.
 *
 * What it cost is worse than the stop path's silence. The answering turn had already produced the
 * report; the fold re-dispatched it to include the amendment; the guardrail blocked the re-run before
 * the model was called, and the notice written in its place went onto the placeholder the finished
 * report was going to land on. The person asked for a report, added one line to it, and got a refusal
 * instead of either. From the sweep: `input guardrail intervened; blocking turn before model call`
 * with `scoredIsWholePrompt: true` and 856 characters scored, on a turn that lived 578ms.
 *
 * Three assemblers, three separate discoveries, one line that decides. That line is the test.
 */
describe('an amendment fold screens the person, not the instructions wrapped around them', () => {
  const triage = read('lambda/src/lib/turn-triage.ts');
  const handler = read('lambda/src/assistant-async-processor.ts');
  const router = read('lambda/src/router-agent-handler.ts');

  it('sends the person`s words beside the contract, not instead of it', () => {
    // `userMessage` stays the assembled prompt: it is what the model must actually read.
    expect(triage).toContain('userMessage: amended,');
    expect(triage).toContain(
      'userContent: [args.userMessage, ...amendments.map((m) => m.content)].filter(Boolean)',
    );
  });

  it('carries it across the hop the fold count already crosses', () => {
    // Same seam, not a new one: the fold is dispatched at the router, so anything the turn must know
    // about itself travels as a request attribute or not at all.
    expect(router).toContain("const BYPASS_USER_CONTENT_ATTR = 'AE.turn.userContent';");
    expect(router).toContain('...(req.userContent ? { [BYPASS_USER_CONTENT_ATTR]: req.userContent } : {}),');
    expect(router).toContain('? { userContent: String(event.requestAttributes[BYPASS_USER_CONTENT_ATTR]) }');
  });

  it('is read by the SAME line the other two are', () => {
    const at = handler.indexOf('const guardedInput = event.triage?.userContent');
    expect(at).toBeGreaterThan(-1);
    const block = handler.slice(at, at + 260);
    expect(block).toContain('event.stopEvaluation?.userContent');
    expect(block).toContain('event.userContent');
    // And an ordinary turn is still screened, which is the thing the guardrail is actually for.
    expect(block).toContain('event.userMessage');
  });

  it('attributes the turn to it too', () => {
    expect(handler).toContain('?? event.userContent ?? event.userMessage,');
  });

  it('leaves a turn dispatched without it screening userMessage', () => {
    // A fold dispatched by the previous version carries no `userContent`, and must not become
    // unscreened. Absence falls through to `userMessage`, which is where it started.
    const at = router.indexOf('? { userContent: String(event.requestAttributes[BYPASS_USER_CONTENT_ATTR]) }');
    expect(router.slice(at, at + 120)).toContain(': {}');
  });
});
