/**
 * ConverseStep structured tool outcome (SPEC-ADMIN-CONSOLE-EFFECTIVENESS P2). Tool identity + success
 * + a BOUNDED error class land on the step so tool-error rate is queryable per tool — never the raw
 * error text or any payload (decision D3). Covers the classifier's vocabulary and that makeConverseStep
 * carries tools only when present.
 */
import { classifyToolError, makeConverseStep } from '../lambda/src/lib/analytics-metadata.js';

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
