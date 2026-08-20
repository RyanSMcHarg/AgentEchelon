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
      requirements: {
        'the audience': 'engineering leadership',
        'the length or format': '1-2 pages',
      },
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
    ])).toEqual({ requirements: { 'the audience': 'the board' } });
  });

  it('trims, so a copied requirement with stray whitespace still matches its declaration', () => {
    expect(collectedRequirements([{ requirement: '  the audience  ', value: '  the board  ' }]))
      .toEqual({ requirements: { 'the audience': 'the board' } });
  });
});

/**
 * THE SIZE IS RECORDED AS NUMBERS, BY THE COMPONENT THAT UNDERSTANDS THE SENTENCE.
 *
 * The first version stored the person's words ("1-2 pages") and had the delivering check regex them
 * into a range at read time. That is the same defect one layer down from the one this whole row fixed:
 * an agreement moved out of the transcript, then written back as prose and re-interpreted by a pattern.
 * A person says "a page or two", "keep it short", "two pages max" - turning any of those into a number
 * is language work, and the model recording the requirement is the only component that saw the
 * sentence in context. It resolves the range once; every reader afterwards gets numbers.
 */
describe('a size is recorded as a range, not as a sentence to be parsed later', () => {
  it('carries the model-resolved bounds alongside what the person said', () => {
    expect(collectedRequirements([
      { requirement: 'the audience', value: 'engineering leadership' },
      { requirement: 'the length or format', value: '1-2 pages', minWords: 600, maxWords: 900 },
    ])).toEqual({
      requirements: {
        'the audience': 'engineering leadership',
        'the length or format': '1-2 pages',
      },
      lengthTarget: { minWords: 600, maxWords: 900, source: '1-2 pages' },
    });
  });

  it('records no size when the answer named none, which is a real answer', () => {
    const out = collectedRequirements([{ requirement: 'the length or format', value: 'as a table' }]);
    expect(out?.requirements).toEqual({ 'the length or format': 'as a table' });
    expect(out?.lengthTarget).toBeUndefined();
  });

  // HALF AN AGREEMENT IS NOT AN AGREEMENT: a minimum alone admits a document ten times the size asked
  // for, a maximum alone admits an empty one, and a reversed pair is noise a model produced.
  it.each([
    ['a minimum only', { minWords: 600 }],
    ['a maximum only', { maxWords: 900 }],
    ['a reversed pair', { minWords: 900, maxWords: 600 }],
    ['a zero minimum', { minWords: 0, maxWords: 900 }],
    ['non-numeric bounds', { minWords: '600', maxWords: '900' }],
  ])('discards %s rather than half-enforcing it', (_label: string, bounds: object) => {
    const out = collectedRequirements([{ requirement: 'the length or format', value: 'x', ...bounds }]);
    expect(out?.lengthTarget).toBeUndefined();
    // The VALUE still records: what the person said is worth keeping even when the numbers are not.
    expect(out?.requirements).toEqual({ 'the length or format': 'x' });
  });

  it('takes the FIRST size when a model marks two, rather than picking by an undeclared rule', () => {
    const out = collectedRequirements([
      { requirement: 'the length or format', value: '1-2 pages', minWords: 600, maxWords: 900 },
      { requirement: 'the summary length', value: 'half a page', minWords: 150, maxWords: 450 },
    ]);
    expect(out?.lengthTarget).toEqual({ minWords: 600, maxWords: 900, source: '1-2 pages' });
  });

  it('rounds a fractional bound rather than storing it', () => {
    const out = collectedRequirements([
      { requirement: 'the length', value: 'about a page', minWords: 299.6, maxWords: 900.4 },
    ]);
    expect(out?.lengthTarget).toEqual({ minWords: 300, maxWords: 900, source: 'about a page' });
  });

  // The tool has to ASK for the numbers, or the model has no reason to supply them.
  it('the tool schema asks the model for the bounds, and does not require them', () => {
    const [spec] = taskToolSpecsFor('report_generation', DEFAULT_TASK_STATE_MACHINES, 'collecting_requirements');
    const items = (spec.toolSpec.inputSchema.json as unknown as {
      properties: { collected: { items: { properties: Record<string, { description?: string }>; required: string[] } } };
    }).properties.collected.items;

    expect(items.properties.minWords).toBeDefined();
    expect(items.properties.maxWords).toBeDefined();
    expect(items.properties.minWords.description).toMatch(/only when this requirement fixes a SIZE/i);
    // Optional: a requirement that names no size must not force the model to invent one.
    expect(items.required).toEqual(['requirement', 'value']);
  });
});
