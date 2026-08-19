/**
 * A task-shaped duel is dispatched with everything a placeholder-shaped one gets (ADR-026).
 *
 * WHY A RATCHET AND NOT A BEHAVIOURAL TEST. The defect was a SECOND COPY of a worker payload: the
 * `TASK_MULTI_STEP` branch was written before the round-1 handoff and never caught up, so it omitted
 * `battleContext`, `variantProfile`, `placeholderMessageId` and the attachment. Every one of those
 * omissions is silent - the duel still answers, nothing errors, no test fails - and the consequences
 * only show up as a duel that closes with "didn't finish in time" for both sides, or as an experiment
 * reporting "indistinguishable" because both arms quietly ran the profile's active version.
 *
 * A behavioural test would pin ONE payload field at a time and pass while the next one was dropped.
 * What actually prevents recurrence is that the payload has ONE definition, so this asserts the shape
 * of the code: defined once, spread into both dispatches, never inlined again.
 *
 * Same family as `flow-does-not-run-the-turn.test.ts`, `control-parity.test.ts` and
 * `single-entry-point.test.ts`.
 */
import { stripComments } from './helpers/strip-comments';
import * as fs from 'fs';
import * as path from 'path';

const ROUTER = path.join(__dirname, '..', 'lambda', 'src', 'router-agent-handler.ts');

/**
 * Source with comments stripped so the rationale cannot satisfy a check.
 *
 * `(^|\s)` before the block opener, not a bare `\/\*`: an IAM/ARN glob like `${appInstanceArn}/user/*`
 * ends in `/*`, which a bare pattern treats as a comment opener and then blanks everything up to the
 * next close-comment. That defeated a sibling scan in this repo, so the fixed form is used here.
 */
const code = stripComments(fs.readFileSync(ROUTER, 'utf8'));

/** Occurrences of a literal in the comment-stripped source. */
const count = (needle: string): number => code.split(needle).length - 1;

describe('the worker payload has one definition', () => {
  it('battleContext is built in exactly ONE place', () => {
    // Two builders is the defect. A second one drifts from the first without ever erroring, because
    // the side that gets the poorer payload still answers.
    expect(count('battleContext: {')).toBe(1);
  });

  it('both dispatches spread the shared battle fields', () => {
    // The router has two `invokeAsync` dispatches (TASK_MULTI_STEP and PLACEHOLDER_UPDATE). Each must
    // take the battle fields from the single definition rather than assembling its own.
    expect(count('...workerBattleFields')).toBe(2);
  });

  it('both dispatches spread the shared common fields', () => {
    // attachment + variantProfile + placeholderMessageId. `variantProfile` missing from the task branch
    // is why a profileRef experiment silently ran the active version on any task-shaped duel.
    expect(count('...workerCommonFields')).toBe(2);
  });

  it('variantProfile and placeholderMessageId are not re-inlined next to a dispatch', () => {
    // They live in `workerCommonFields` and nowhere else, so a new dispatch branch cannot be written
    // that happens to omit them.
    expect(count('variantProfile: resolvedVariantProfile')).toBe(1);
    expect(count('placeholderMessageId: event.requestAttributes[BYPASS_PLACEHOLDER_ATTR]')).toBe(1);
  });
});

describe('a duel side keeps its state transitions', () => {
  it('the DIRECT greeting/acknowledgment short-circuit is battle-guarded', () => {
    // `DIRECT` answers from the handler and dispatches no worker, so a battle side taking it never
    // reports completion and the orchestrator declares it stalled. Reachable: the flow strips the
    // command, so `/battle hello` classifies as a greeting, and a continuation answered "thanks" is an
    // acknowledgment.
    expect(code).toMatch(/if\s*\(\s*!battleCtx\s*\r?\n?\s*&&\s*\(classification\.intent === IntentType\.GREETING/);
  });

  it('a duel side is looked up for an active task regardless of intent', () => {
    // The greeting/ack skip is right for an ordinary turn and wrong for a duel side answering its own
    // clarifying question with "ok" - that turn CONTINUES a chain the side already owns.
    expect(code).toMatch(/if\s*\(battleCtx\s*\r?\n?\s*\|\|\s*\(classification\.intent !== IntentType\.GREETING/);
  });

  it('an existing chain is continued BEFORE a new battle task is created', () => {
    // Ordering is the whole defect: with the battle branch first, a resumed side created a fresh task
    // every turn and restarted its state machine from state 0.
    // Anchored on the assistant-owner option, which appears only in the battle creation call. A
    // multi-line anchor would not survive comment stripping.
    const continueAt = code.indexOf('if (activeTask) {');
    const createAt = code.indexOf("type: 'assistant' as const");
    expect(continueAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(continueAt).toBeLessThan(createAt);
  });

  it('there is ONE task-creation call, not a battle-specific second one', () => {
    // `createBattleTask` was a near-duplicate of `createTask`. Being a separate door is what put it
    // ahead of the continue check; collapsing it is what keeps the ordering honest (ADR-026).
    expect(code).not.toContain('createBattleTask');
    expect(count('await createTask(')).toBe(2); // the battle side, and the ordinary path
  });

  it('isTaskContinuation is not forced false for a battle turn', () => {
    // `battleCtx ? false : …` told the worker a resumed side was starting fresh, so it re-opened work
    // already in flight.
    expect(code).not.toMatch(/isTaskContinuation:\s*battleCtx\s*\?/);
    expect(code).toContain('isTaskContinuation: !isNewTaskForBattle && !!activeTask');
  });

  it('a task-shaped duel side returns a placeholder carrying the battle marker', () => {
    // Without the marker the frontend does not render the turn as a duel side, so a task-shaped duel
    // showed two ordinary task placeholders and no scorecard. Both return paths compose it through the
    // one helper.
    expect(count('battlePlaceholderContent({')).toBe(2);
    expect(code).toContain('lead: getTaskPlaceholder(');
  });
});

describe('a task-shaped side waits for its chain before the next round', () => {
  const CORE = stripComments(
    fs.readFileSync(path.join(__dirname, '..', 'lambda', 'src', 'lib', 'async-processor-core.ts'), 'utf8'),
  );

  it('the WAITING branch is checked BEFORE the round-1 terminal transition', () => {
    // Ordering is the behaviour: reaching `recordBattleTerminalAndFireOrchestrator` first would complete
    // the side and fire round 2 against a half-finished chain, which is the rebuttal-of-a-half-report
    // case ADR-026 exists to stop.
    //
    // The LAST occurrence is the round-1 one. There are two call sites, and the earlier is guarded by
    // `round === 2 && isNoRebuttal` - a round-2 opt-out, which has no next leg to wait for and must stay
    // terminal. Anchoring on the first would compare against a site this rule does not govern.
    const waitAt = CORE.indexOf("reason: 'task-step'");
    const round1TerminalAt = CORE.lastIndexOf('recordBattleTerminalAndFireOrchestrator({');
    expect(waitAt).toBeGreaterThan(-1);
    expect(round1TerminalAt).toBeGreaterThan(-1);
    expect(waitAt).toBeLessThan(round1TerminalAt);
  });

  it('the round-2 opt-out path is NOT made to wait', () => {
    // Two call sites, and only one of them is governed by the wait. If the round-2 NO_REBUTTAL path ever
    // started waiting, a duel where a side declines to rebut would never finish.
    const optOut = CORE.slice(
      CORE.indexOf('isNoRebuttal(response)'),
      CORE.indexOf('recordBattleTerminalAndFireOrchestrator({') + 200,
    );
    expect(optOut).not.toContain('task-step');
  });

  it('it gates on task terminality WITHOUT a battle-specific predicate', () => {
    // ADR-023's separation stands: no `isBattleRound1Complete`. The signal is the ordinary task rule
    // (`shouldMarkTaskCompleted`), read once and reused, so a duel's task progresses like any other.
    expect(CORE).toContain('taskStillRunning');
    expect(CORE).not.toContain('isBattleRound1Complete');
    expect(CORE).toMatch(/round === 1 && taskStillRunning/);
  });

  it('only round 1 waits — a round-2 rebuttal is terminal either way', () => {
    // Round 2 has no next leg to wait for; suspending it would leave the duel permanently unfinished.
    expect(CORE).toMatch(/event\.battleContext\.round === 1 && taskStillRunning/);
  });
});

describe('silence is only safe when something else will finish', () => {
  it('the handed-over-placeholder silence is gated on an actual dispatch', () => {
    // This returned silence unconditionally, so a continuation that failed before dispatching posted
    // nothing at all and left the side's waiting marker uncleared forever.
    expect(code).toMatch(/BYPASS_PLACEHOLDER_ATTR\]\s*&&\s*spoke\.dispatched/);
  });

  it('every dispatch records that it dispatched', () => {
    // One per `invokeAsync`. A dispatch that forgets makes the entry post a duplicate message.
    expect(count('spoke.dispatched = true')).toBe(2);
    expect(count('await invokeAsync(asyncProcessorArn, {')).toBe(2);
  });
});

describe('a waiting duel side resumes on every path that can answer it', () => {
  it('resumeDuelSideIfWaiting has THREE call sites: person-owed, assistant-held, and taskless', () => {
    // A round-1 clarification asked before any chain exists parks the side in WAITING_FOR_USER with
    // NO task row - the wait lives on the battle row alone. A resume reachable only behind a found
    // task can never fire for it: the person's answer is consumed as an ordinary turn, the
    // battlewaiting marker never clears, and the duel strands to TTL with nothing erroring.
    expect(count('await resumeDuelSideIfWaiting(')).toBe(3);
  });

  it('the taskless resume is guarded on the ABSENCE of a task, and keeps the owner rule', () => {
    // Reachable without a task by construction, and it still answers only to whoever started the
    // duel (fail-open when unrecorded), same as the chain branch above it.
    expect(code).toMatch(/if \(!activeTask && !battleCtx && channelArn\) \{/);
    expect(code).toMatch(/const waitingOn = duel\?\.initiatorUserSub;/);
  });
});
