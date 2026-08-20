/**
 * WHAT THE PERSON ANSWERED IS RECORDED ON THE TASK, not left in the transcript.
 *
 * `requires` named what a step needs and nothing ever captured the answers: `advance_task_state` took
 * `to_state` and a free-text `reason`, so "I have all the data I need" satisfied it completely, and
 * `Task.details` - the field whose comment says "state-specific data collected during the task" - had
 * no writer at all.
 *
 * That gap is why a delivered report could not be checked against anything: the length the person
 * asked for existed only as prose in a conversation, so any consumer wanting it had to re-derive an
 * agreement from a sentence. Recorded once, at the moment the person confirms it, it is readable by
 * every later consumer - the delivering check, the revision branch, an audit of why a document looks
 * the way it does.
 */
import {
  ADVANCE_TASK_STATE_TOOL_SPEC,
  collectedRequirements,
  taskToolSpecsFor,
} from '../../lambda/src/lib/task-tools';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';

/** The report machine's collecting step is the one that declares needs, and it ships. */
const REPORT_REQUIRES = DEFAULT_TASK_STATE_MACHINES.report_generation.states.collecting_requirements.requires!;

describe('the tool carries the needs of the step it is called from', () => {
  it('the shipped machine still declares them, so this test is about something real', () => {
    expect(REPORT_REQUIRES).toEqual(['the subject', 'the audience', 'the length or format']);
  });

  it('names each requirement in the description and requires an accounting for it', () => {
    const [spec] = taskToolSpecsFor('report_generation', DEFAULT_TASK_STATE_MACHINES, 'collecting_requirements');
    const json = spec.toolSpec.inputSchema.json as unknown as {
      properties: Record<string, unknown>; required: string[];
    };
    for (const need of REPORT_REQUIRES) {
      expect(spec.toolSpec.description).toContain(need);
    }
    expect(json.properties.collected).toBeDefined();
    expect(json.required).toContain('collected');
    // The original inputs survive: this ADDS an accounting, it does not replace the contract.
    expect(json.required).toEqual(expect.arrayContaining(['to_state', 'reason']));
  });

  // A step with no declared needs gets the plain tool. Every task turn pays for the tool schema in
  // tokens, so a step that needs nothing must not carry an empty checklist.
  it('is the unchanged spec for a state that declares no requirements', () => {
    const [spec] = taskToolSpecsFor('report_generation', DEFAULT_TASK_STATE_MACHINES, 'generating');
    expect(spec).toBe(ADVANCE_TASK_STATE_TOOL_SPEC);
  });

  it('is the unchanged spec when the caller names no state at all', () => {
    const [spec] = taskToolSpecsFor('report_generation', DEFAULT_TASK_STATE_MACHINES);
    expect(spec).toBe(ADVANCE_TASK_STATE_TOOL_SPEC);
  });

  it('offers nothing for a task type with no machine', () => {
    expect(taskToolSpecsFor('not_a_machine', DEFAULT_TASK_STATE_MACHINES, 'anything')).toEqual([]);
  });
});

describe('the answers are read tolerantly, because a model supplies them', () => {
  it('maps requirement to value', () => {
    expect(collectedRequirements([
      { requirement: 'the audience', value: 'engineering leadership' },
      { requirement: 'the length or format', value: '1-2 pages' },
    ])).toEqual({
      'the audience': 'engineering leadership',
      'the length or format': '1-2 pages',
    });
  });

  // A malformed accounting is worth less than a correct one and MORE than a rejected transition: the
  // step still advanced for real reasons, and refusing it over bookkeeping would strand the task.
  it.each([
    ['not an array', 'a string'],
    ['an empty array', []],
    ['entries missing a value', [{ requirement: 'the audience' }]],
    ['entries with blank text', [{ requirement: '  ', value: '  ' }]],
    ['null entries', [null, undefined]],
  ])('drops %s rather than writing it', (_label: string, input: unknown) => {
    expect(collectedRequirements(input)).toBeUndefined();
  });

  it('keeps the good entries beside a bad one', () => {
    expect(collectedRequirements([
      { requirement: 'the audience', value: 'the board' },
      { requirement: 'the subject', value: 42 },
    ])).toEqual({ 'the audience': 'the board' });
  });

  it('trims, so a copied requirement with stray whitespace still matches its declaration', () => {
    expect(collectedRequirements([{ requirement: '  the audience  ', value: '  the board  ' }]))
      .toEqual({ 'the audience': 'the board' });
  });
});
