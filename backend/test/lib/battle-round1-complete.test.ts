/**
 * A battle round ends on a BATTLE condition, never a task one (ADR-023, DESIGN-BATTLE §2a).
 *
 * WHAT THIS FILE USED TO TEST, AND WHY IT IS GONE. `isBattleRound1Complete` decided a duel side had
 * finished round 1 by asking whether its TASK had reached a terminal state. That made a duel whose
 * intent happened to be task-shaped obey a completely different completion rule from one whose intent
 * was not: a side that had already produced its answer sat un-terminal for as long as its task chain
 * ran, holding round 2 back, while an identical duel on a `general` intent rebutted immediately.
 *
 * A battle is not a task. Certain INTENTS are tasks; battle is a state outside that concept, and a
 * side's round is complete when it has produced its response for that round. If the side also left a
 * task running, that belongs in what the rebuttal is told, not in whether the round ended.
 *
 * This file now pins the SEPARATION rather than the old rule, because deleting a test with the code
 * it covered would leave nothing asserting that the coupling stays gone.
 */
import { stripComments } from '../helpers/strip-comments';
import * as fs from 'fs';
import * as path from 'path';

const CORE = path.join(__dirname, '..', '..', 'lambda', 'src', 'lib', 'async-processor-core.ts');
const src = fs.readFileSync(CORE, 'utf8');

/** Source with comments stripped, so the rationale above cannot satisfy a check. */
const code = stripComments(src);

describe('battle round completion is not defined by task state', () => {
  it('the task-terminality gate is gone', () => {
    // Its return removed the whole question of when a duel's round ends from task state. If it comes
    // back, a task-shaped duel silently gets a different completion rule again.
    expect(code).not.toContain('isBattleRound1Complete');
    expect(code).not.toContain('roundComplete');
  });

  it('recording a side terminal does not consult a task', () => {
    // The battle terminal write must not read task state to decide whether the round is over. Grab
    // the function body and assert it asks no task questions.
    const start = code.indexOf('async function recordBattleTerminalAndFireOrchestrator');
    expect(start).toBeGreaterThan(-1);
    const body = code.slice(start, start + 3000);

    expect(body).not.toContain('getTask');
    expect(body).not.toContain('taskState');
    expect(body).not.toContain('taskStatus');
    expect(body).not.toContain('TASK_MULTI_STEP');
  });

  it('the task status update is no longer gated on being a battle turn', () => {
    // The update used to be skipped entirely mid-chain on a battle turn, so a duel's task progressed
    // differently from an identical non-duel task. `shouldMarkTaskCompleted` already refuses to
    // force-complete a machine-backed task, so the ordinary rule is the only one needed.
    expect(code).toContain('shouldMarkTaskCompleted');
    expect(code).not.toContain('isBattleTaskInvocation');
  });
});
