/**
 * A REBUTTAL OPENS NO WORK, AND THAT IS ENFORCED RATHER THAN OBSERVED.
 *
 * The workflow selection gates what an assistant may OPEN, and it is applied at the two doors that
 * open work: the ordinary intent path and the round-1 duel side (ADR-047). Round 2 has no gate.
 *
 * THAT IS SAFE ONLY BECAUSE ROUND 2 CANNOT REACH A DOOR. The orchestrator dispatches the rebuttal
 * with a fixed non-task delivery option and calls no task-creating function, so there is nothing for
 * a selection to gate. It was recorded as an open question for exactly that reason - "consistent
 * today, but a second door if that ever changes" - and an open question that depends on a literal
 * staying put is one refactor away from being wrong.
 *
 * So this is the refusal. If someone resolves a delivery option for round 2, forwards round 1's, or
 * calls `createTask` from the orchestrator, this fails and they have to decide deliberately: either
 * gate the new door with the serving version's selection, or do not open one. Without it the change
 * would ship green, because a duel that opens an ungated task still answers - nothing errors, which
 * is the failure mode every defect in this area has had.
 *
 * SOURCE-LEVEL ON PURPOSE. What is being pinned is the ABSENCE of a call and the presence of a
 * literal; a behavioural test over a correctly-wired fixture cannot see a door that was never built,
 * which is the same reasoning `an-assistant-is-assigned-one-classification.test.ts` records for its
 * own wiring assertions.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ORCHESTRATOR = join(__dirname, '../lambda/src/battle-orchestrator.ts');

/** Source with block and line comments stripped, so a comment mentioning a symbol is not a use. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('round 2 cannot open work, so it needs no gate', () => {
  it('dispatches the rebuttal with a fixed NON-TASK delivery option', () => {
    const code = codeOf(ORCHESTRATOR);

    // The literal is what makes round 2 unreachable from a task door. A resolved or forwarded
    // option would make the delivery depend on the intent, and a task-shaped intent would then open
    // a chain nobody gated.
    expect(code).toMatch(/deliveryOption:\s*'PLACEHOLDER_UPDATE'/);

    // No TASK_* delivery reaches this dispatcher, by any spelling.
    expect(code).not.toMatch(/deliveryOption:\s*[^,\n]*TASK_/);
    // ...and the option is not computed from the intent it now forwards.
    expect(code).not.toMatch(/deliveryOption:\s*(intentToDeliveryOption|planBattleTaskDelivery|selfRow\.deliveryOption)/);
  });

  it('opens no task: the orchestrator calls no task-creating function', () => {
    const code = codeOf(ORCHESTRATOR);
    for (const opener of ['createTask', 'createBattleTask', 'advanceTaskStateTo', 'applyUserResponseToTask']) {
      expect(code).not.toMatch(new RegExp(`\\b${opener}\\s*\\(`));
    }
  });

  it('the decision is written where the change would be made, not only in a design doc', () => {
    // A guard that fails with no explanation at the call site sends the next person to the test file
    // to find out why. The reason a rebuttal opens no work - it is commentary, nobody is waiting on
    // it, so there is nothing to track - belongs beside the literal it constrains.
    const raw = readFileSync(ORCHESTRATOR, 'utf8');
    expect(raw).toMatch(/REBUTTAL OPENS NO WORK/);
    expect(raw).toMatch(/ADR-047/);
  });
});
