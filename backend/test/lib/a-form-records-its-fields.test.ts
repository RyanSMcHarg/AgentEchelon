/**
 * A FORM RECORDS ITS FIELDS (ADR-067 G16, G24, WT50).
 *
 * What it proves: `form` is a fixed platform machine a person answers or declines on its card; only a step that opens it
 * declares fields, each a name and a type, at most eight; the card carries the fields; and the answers are held to the
 * fields (known, of their type, text bounded, required ones present) before anything moves, then kept on the task.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DEFAULT_TASK_STATE_MACHINES, isPlatformMachineKey, validateTaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { formAnswersOf, taskStepErrors, MAX_FORM_FIELDS, MAX_FORM_TEXT } from '../../lambda/src/lib/task-step';
import { taskCardOf } from '../../lambda/src/lib/workflow-task';

const FIELDS = [{ name: 'reason', type: 'text' as const, required: true }, { name: 'rating', type: 'number' as const }, { name: 'again', type: 'yes-no' as const }];
const step = (extra: Record<string, unknown>) => ({ machine: 'form', for: 'subject', deadline: { afterMinutes: 60 }, ...extra });
const errs = (s: unknown) => taskStepErrors(s, 's', { personErrors: () => [] });

describe('the form machine', () => {
  it('is the platform\'s, fixed, answered or declined on its card', () => {
    expect(isPlatformMachineKey('form')).toBe(true);
    expect(() => validateTaskStateMachine('form', DEFAULT_TASK_STATE_MACHINES.form)).not.toThrow();
    expect(DEFAULT_TASK_STATE_MACHINES.form.states.asked.choices).toEqual(['answered', 'declined']);
  });

  it('only a step that opens it declares fields, one to eight, each named and typed', () => {
    expect(errs(step({ fields: FIELDS }))).toEqual([]);
    expect(errs(step({})).join()).toMatch(/fields is a list of 1 to 8 fields/);
    expect(errs(step({ fields: Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, i) => ({ name: `f${i}`, type: 'text' })) })).join()).toMatch(/1 to 8/);
    expect(errs(step({ fields: [{ name: 'Reason', type: 'text' }] })).join()).toMatch(/is \{ name, type/);
    expect(errs(step({ fields: [{ name: 'a', type: 'text' }, { name: 'a', type: 'number' }] })).join()).toMatch(/repeats the field a/);
    expect(errs({ machine: 'acknowledgement', for: 'subject', by: 'subject', deadline: { afterMinutes: 60 }, fields: FIELDS }).join()).toMatch(/belongs to a step that opens the form machine/);
  });

  it('holds the answers to the fields', () => {
    expect(formAnswersOf(FIELDS, { reason: ' slow ', rating: 4, again: true })).toEqual({ reason: 'slow', rating: 4, again: true });
    expect(formAnswersOf(FIELDS, { rating: 4 })).toBeNull();
    expect(formAnswersOf(FIELDS, { reason: 'x', rating: 'four' })).toBeNull();
    expect(formAnswersOf(FIELDS, { reason: 'x', other: 1 })).toBeNull();
    expect(formAnswersOf(FIELDS, { reason: 'x'.repeat(MAX_FORM_TEXT + 1) })).toBeNull();
  });

  it('the card carries the fields, and the service takes the answers only with the answer choice, onto the task', () => {
    const card = taskCardOf({ taskId: 't1', taskType: 'form', taskState: 'asked', workflowRun: { fields: FIELDS } as never }, DEFAULT_TASK_STATE_MACHINES);
    expect(card?.fields).toEqual(FIELDS);
    const service = readFileSync(resolve(__dirname, '../../lambda/src/task-service.ts'), 'utf8');
    expect(service).toMatch(/const answers = fields\?\.length && input\.choice === 'answered' \? formAnswersOf\(fields, input\.answers\) : undefined;/);
    expect(service).toMatch(/if \(fields\?\.length && input\.choice === 'answered' && !answers\) return \{ ok: false, error: 'REFUSED' \};/);
    expect(service).toMatch(/\.\.\.\(answers \? \{ details: \{ form: answers \} \} : \{\}\),/);
  });
});
