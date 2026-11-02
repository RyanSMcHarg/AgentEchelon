/**
 * TWO TASKS OPEN AT ONCE IN ONE CONVERSATION, and the turn that touches one must not move the other.
 *
 * WHY THIS IS WORTH A LIVE TEST. Every task spec in this suite drives ONE task, so every invariant
 * about tasks has been measured against a population of one. The failures that only appear with two
 * are the ones nothing here would catch:
 *
 *   - a turn resolving its own task machines rather than carrying the turn's, so one task is advanced
 *     against a graph the other task's state was read from (ADR-047);
 *   - the referent problem - which task does "yes, go ahead" answer - where the assistant has to pick
 *     and a wrong pick silently advances work the person was not talking about;
 *   - a completion door that closes the wrong task, or closes both.
 *
 * WHAT IT ASSERTS AND WHAT IT DELIBERATELY DOES NOT. It asserts that two tasks of DIFFERENT types can
 * be open at once, that each carries its own state, and that a turn aimed at one leaves the other's
 * state and history untouched. It does not assert which one an ambiguous answer resolves to: that is
 * the referent ranking, it has its own spec (`task-reference.spec.ts`), and pinning a ranking here
 * would duplicate it and fight it on every change.
 *
 * Gated like its siblings: it drives real model turns against a deployment and is opted into.
 */
import { test, expect } from './helpers/fixtures';
import { signIn, createConversation, sendAndWaitForResponse, idTokenOf } from './helpers/agent-helpers';
import { getAdminUser, missingUserReason } from './helpers/test-credentials';
import { personIdFromIdToken } from './helpers/person';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import { resolveTaskTable, readUserTasks, historyOf, type TaskRow } from './helpers/task-backend';

const RUN = process.env.CONCURRENT_TASKS_E2E === '1';
const suite = RUN ? test.describe.serial : test.describe.skip;

guardBackendErrors('concurrent-tasks');
guardConsoleErrors();

/** Poll a read that only becomes true once archival/task writes have settled. */
async function until<T>(read: () => T | undefined, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for the task write to settle');
    await new Promise((r) => setTimeout(r, 3000));
  }
}

suite('two tasks in one conversation stay separate', () => {
  test('a turn that advances one task leaves the other untouched', async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const admin = await getAdminUser();
    test.skip(!admin.password, missingUserReason('testAdmin'));

    const userTable = resolveTaskTable('user-tasks');
    test.skip(!userTable, 'the user-tasks table could not be resolved from the deployment');

    await signIn(page, admin.email, admin.password);
    const idToken = await idTokenOf(page);
    const personId = await personIdFromIdToken(idToken);
    const since = Date.now() - 60_000;

    // (title, classification): a single argument is the TITLE, and the room then opens at the default classification,
    // where a report is refused with "You have access to conversations that do" and no task ever opens.
    await createConversation(page, 'E2E concurrent tasks', 'Premium');

    // ── OPEN TWO TASKS OF DIFFERENT TYPES ───────────────────────────────────────────────────────
    //
    // Different TYPES on purpose: two tasks of one type share a graph, so a turn that moved the wrong
    // one would land on a legal state and look correct. Different graphs make a crossed advance
    // visible as a state that cannot exist on the task it was written to.
    await sendAndWaitForResponse(page, 'Draft a short report on our onboarding process.', 180_000);
    const secondReply = await sendAndWaitForResponse(page, 'Separately, walk me through diagnosing a failed deployment.', 180_000);
    // A SECOND SUBJECT IS DRIFT, and offering to split it out is the product working. Keeping it here is
    // the person's answer to the offer, and the declined offer's question is then answered in this
    // conversation (SPEC-DRIFT-CONVERGENCE), which is what opens the second task.
    if (/shifting topics/i.test(secondReply.text)) {
      await sendAndWaitForResponse(page, 'No, keep it in this conversation.', 180_000);
    }

    const openTasks = await until<TaskRow[]>(() => {
      const rows = readUserTasks(userTable!, personId)
        .filter((r) => new Date(r.createdAt || 0).getTime() >= since)
        .filter((r) => r.taskState && r.taskState !== 'completed');
      return rows.length >= 2 ? rows : undefined;
    });

    const types = new Set(openTasks.map((r) => String(r.taskType)));
    expect(types.size, `two tasks of DIFFERENT types should be open, saw: ${[...types].join(', ')}`)
      .toBeGreaterThanOrEqual(2);

    // THE TWO THIS TEST WATCHES MUST BE OF DIFFERENT TYPES, chosen rather than taken in row order.
    // `types.size >= 2` is true across ALL open rows, so with three open the first two can share a
    // type - and this file's own reasoning says a crossed advance between same-type tasks lands on a
    // legal state and looks correct. Taken in DynamoDB order, that is a test that passes by luck.
    const first = openTasks[0];
    const second = openTasks.find((r) => r.taskType !== first.taskType);
    expect(second, 'a task of a DIFFERENT type than the first must be open').toBeTruthy();

    // SETTLE BEFORE SNAPSHOTTING. `until` returns the instant two open rows exist, which can precede
    // the history write for the turn that opened the second one. A lagging entry would then land after
    // the snapshot and fail the "gained no history" assertion with no crossed advance having happened -
    // the archival-lag flake this suite has been bitten by before.
    let settled = historyOf(second).length;
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const again = readUserTasks(userTable!, personId).find((r) => r.taskId === second!.taskId);
      const len = historyOf(again).length;
      if (len === settled) break;
      settled = len;
    }
    const beforeSecond = { state: second!.taskState, history: settled };

    // ── A TURN AIMED AT ONE OF THEM ─────────────────────────────────────────────────────────────
    //
    // Named explicitly rather than answered with "yes": an ambiguous answer is the referent problem,
    // which belongs to its own spec. This test is about ISOLATION, so it removes the ambiguity and
    // asks only whether the other task moved.
    await sendAndWaitForResponse(
      page,
      `About the ${String(first.taskType).replace(/_/g, ' ')} - go ahead with the next step.`,
      180_000,
    );

    const afterSecond = await until<TaskRow>(() => {
      const rows = readUserTasks(userTable!, personId).filter((r) => r.taskId === second!.taskId);
      return rows[0];
    });

    // THE ASSERTION THIS TEST EXISTS FOR. The untouched task's state and its transition log are both
    // checked: a crossed advance that happened to land on the same state name would still show in the
    // history, and a history entry with no state change is still work attributed to the wrong task.
    expect(afterSecond.taskState, 'the task the turn did not address must not change state')
      .toBe(beforeSecond.state);
    expect(historyOf(afterSecond).length, 'the task the turn did not address must gain no history')
      .toBe(beforeSecond.history);

    // And it is still open - "untouched" must not be satisfied by the task having been closed.
    expect(afterSecond.taskState, 'the untouched task must still be open').not.toBe('completed');
  });
});
