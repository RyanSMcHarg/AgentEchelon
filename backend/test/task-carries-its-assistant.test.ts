/**
 * Every task the router opens says WHOSE WORK IT IS.
 *
 * THE DEFECT THIS PINS (found live 2026-08-18, by task-answer.spec.ts against a deployment). The
 * battle branch named an assistant owner, from which `assistantId` derives; the ordinary branch named
 * neither. So every non-duel task's mirror row shipped with `assistantId` ABSENT - 17 of the 20 rows
 * on the live table - and the composer's "Answering..." affordance, which resolves its ADDRESSEE from
 * that field, could never render for them. In a shared conversation the person's answer then goes
 * unaddressed, and only the stream-side repair can save the turn; the affordance-first design
 * (ADR-032) was unreachable on exactly the tasks people actually open.
 *
 * WHY A SOURCE SCAN AND NOT A DRIVEN TURN. Reaching the ordinary `createTask` call through the router
 * needs the whole turn apparatus mocked, and a test that heavy gets skipped or stubbed until it
 * guards nothing. What went wrong here was one CALL SITE omitting one option, so the guard is at the
 * call-site level: every `createTask(` in the router must state the assistant, either directly
 * (`assistantId:`) or through an assistant owner. The e2e that caught it (task-answer.spec.ts:117)
 * remains the behavioural check; this is the cheap ratchet that fails in the same commit that
 * reintroduces the omission.
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripComments } from './helpers/strip-comments';

const ROUTER = path.join(__dirname, '../lambda/src/router-agent-handler.ts');

/** Each `createTask(...)` call's argument text, brace-balanced from the call to its close. */
function createTaskCalls(src: string): string[] {
  const calls: string[] = [];
  let i = src.indexOf('createTask(');
  while (i !== -1) {
    let depth = 0;
    let j = i + 'createTask'.length;
    do {
      const c = src[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      j++;
    } while (depth > 0 && j < src.length);
    calls.push(src.slice(i, j));
    i = src.indexOf('createTask(', j);
  }
  return calls;
}

describe('every task the router opens carries its assistant', () => {
  const src = stripComments(fs.readFileSync(ROUTER, 'utf8'));
  const calls = createTaskCalls(src);

  it('finds the call sites, so the sweep cannot pass vacuously', () => {
    // Two today: the duel branch and the ordinary branch. A third task-opening path is a new entry in
    // this count, not a silent omission - update it WITH the assistant stated.
    expect(calls.length).toBe(2);
  });

  it.each(calls.map((c, n) => [n, c] as const))(
    'call site %i states whose work the task is',
    (_n, call) => {
      const statesAssistant =
        /\bassistantId\s*:/.test(call) || /type:\s*'assistant'/.test(call);
      expect(statesAssistant).toBe(true);
    },
  );
});
