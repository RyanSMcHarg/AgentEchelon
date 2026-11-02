/**
 * ConverseStep structured tool outcome (SPEC-ADMIN-CONSOLE-EFFECTIVENESS P2). Tool identity + success
 * + a BOUNDED error class land on the step so tool-error rate is queryable per tool — never the raw
 * error text or any payload (decision D3). Covers the classifier's vocabulary and that makeConverseStep
 * carries tools only when present.
 */
import { classifyToolError, makeConverseStep, toolStepOutcome } from '../lambda/src/lib/analytics-metadata.js';

describe('classifyToolError — bounded vocabulary, no raw text', () => {
  it('maps recognizable messages to their class', () => {
    expect(classifyToolError('Request timed out after 30s')).toBe('timeout');
    expect(classifyToolError('connection timeout')).toBe('timeout');
    expect(classifyToolError('document not found')).toBe('not_found');
    expect(classifyToolError('no such object')).toBe('not_found');
    expect(classifyToolError('Access denied for this tier')).toBe('unauthorized');
    expect(classifyToolError('unauthorized')).toBe('unauthorized');
    expect(classifyToolError('invalid arguments')).toBe('bad_input');
    expect(classifyToolError('field is required')).toBe('bad_input');
    expect(classifyToolError('unknown tool: frobnicate')).toBe('bad_input');
  });

  it('falls back to "error" for unrecognized or empty input', () => {
    expect(classifyToolError('something exploded')).toBe('error');
    expect(classifyToolError('')).toBe('error');
    expect(classifyToolError(undefined)).toBe('error');
    expect(classifyToolError(42 as unknown as string)).toBe('error');
  });
});

describe('a workflow refusal is its own class, decided by the structured marker', () => {
  it('the marker decides the class, whatever the message says', () => {
    // `requirement_unsourced` contains "required"-like text and `document_required` contains
    // "required": the message heuristic would call both bad input. The marker is what decides.
    expect(classifyToolError('document_required', 'document_required')).toBe('workflow_refusal');
    expect(classifyToolError('illegal_transition', 'illegal_transition')).toBe('workflow_refusal');
  });

  it('message text alone never yields a refusal', () => {
    expect(classifyToolError('illegal_transition')).toBe('error');
    expect(classifyToolError('workflow_refusal')).toBe('error');
    expect(classifyToolError('document_required')).toBe('bad_input');
  });

  it('a malformed marker is ignored rather than persisted', () => {
    expect(classifyToolError('document_required', 'Please add the document')).toBe('bad_input');
    expect(classifyToolError('x', 42)).toBe('error');
    expect(toolStepOutcome('advance_task_state', { error: 'x', refusal: 'Free Text!' }))
      .toEqual({ name: 'advance_task_state', ok: false, errorClass: 'error' });
  });

  it('toolStepOutcome records ok, a failure, and a refusal with its code', () => {
    expect(toolStepOutcome('load_company_context', { documents: [] }))
      .toEqual({ name: 'load_company_context', ok: true });
    expect(toolStepOutcome('read_deployment_health', { error: 'request timed out' }))
      .toEqual({ name: 'read_deployment_health', ok: false, errorClass: 'timeout' });
    // ok stays false: the move did not happen. The class is what tells it from a failure.
    expect(toolStepOutcome('advance_task_state', { ok: false, error: 'requirement_unsourced', refusal: 'requirement_unsourced', missing: ['source'] }))
      .toEqual({ name: 'advance_task_state', ok: false, errorClass: 'workflow_refusal', refusal: 'requirement_unsourced' });
    // A refusal marker on a payload with no error is not an outcome to record.
    expect(toolStepOutcome('advance_task_state', { ok: true, refusal: 'illegal_transition' }))
      .toEqual({ name: 'advance_task_state', ok: true });
  });
});

describe('makeConverseStep — tools ride only when present', () => {
  const base = { stepLabel: 'x', modelId: 'anthropic.claude', startedAt: 'a', endedAt: 'b' };

  it('omits tools on a pure generation step', () => {
    expect(makeConverseStep(base)).not.toHaveProperty('tools');
    expect(makeConverseStep({ ...base, tools: [] })).not.toHaveProperty('tools');
  });

  it('carries per-tool outcomes when tools ran', () => {
    const step = makeConverseStep({
      ...base,
      stepLabel: 'tool:load_company_context+advance_task_state',
      tools: [
        { name: 'load_company_context', ok: true },
        { name: 'advance_task_state', ok: false, errorClass: 'bad_input' },
      ],
    });
    expect(step.tools).toEqual([
      { name: 'load_company_context', ok: true },
      { name: 'advance_task_state', ok: false, errorClass: 'bad_input' },
    ]);
    // stepLabel is kept for display alongside the structured field.
    expect(step.stepLabel).toBe('tool:load_company_context+advance_task_state');
  });
});
