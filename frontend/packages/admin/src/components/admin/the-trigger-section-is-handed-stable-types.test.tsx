/**
 * THE TRIGGER SECTION IS HANDED ONE `typesFor` WHILE THE CLASSIFICATION STAYS THE SAME.
 *
 * What it proves: a workflow's settings re-rendered with the same classification hand the trigger section the same
 * function, so the targets it memoizes on that function are computed once rather than on every render; a new
 * classification hands a new one.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';

const seen = vi.hoisted(() => ({ typesFor: [] as unknown[] }));
vi.mock('./EventTriggerPanel', () => ({
  default: (props: { typesFor: unknown }) => { seen.typesFor.push(props.typesFor); return null; },
}));

import { WorkflowSettings } from './EventWorkflowEditor';

const WF = { on: 'event-received', types: ['ops-team'], initial: 'done', states: { done: { disposition: 'success' } } } as unknown as EventWorkflow;

describe('the trigger section\'s typesFor', () => {
  it('is the same function across renders with one classification, and a new one for another', () => {
    const onPut = vi.fn();
    const { rerender } = render(<WorkflowSettings name="w" wf={WF} onPut={onPut} classification="premium" />);
    rerender(<WorkflowSettings name="w" wf={{ ...WF }} onPut={onPut} classification="premium" />);
    expect(seen.typesFor.length).toBeGreaterThanOrEqual(2);
    expect(seen.typesFor.at(-1)).toBe(seen.typesFor[0]);
    rerender(<WorkflowSettings name="w" wf={WF} onPut={onPut} classification="standard" />);
    expect(seen.typesFor.at(-1)).not.toBe(seen.typesFor[0]);
  });
});
