/**
 * Task-state analytics stamping (SPEC-TASK-STATE-TRANSITIONS §6). buildAnalyticsMetadata carries
 * taskState + taskTransition so exchanges are sliceable by machine state and transitions are
 * countable; both are analytics-only and must NOT leak into the slim frontend Metadata.
 */
import { buildAnalyticsMetadata, pickFrontendMetadata } from '../lambda/src/lib/analytics-metadata.js';

describe('task-state analytics metadata', () => {
  it('stamps taskState and taskTransition when provided', () => {
    const m = buildAnalyticsMetadata({
      messageNumber: 3,
      userType: 'standard',
      role: 'assistant',
      taskState: 'diagnosing',
      taskTransition: { from: 'collecting_symptoms', to: 'diagnosing' },
    });
    expect(m.taskState).toBe('diagnosing');
    expect(m.taskTransition).toEqual({ from: 'collecting_symptoms', to: 'diagnosing' });
  });

  it('omits taskTransition on a turn that did not transition', () => {
    const m = buildAnalyticsMetadata({
      messageNumber: 4,
      userType: 'standard',
      role: 'assistant',
      taskState: 'diagnosing',
    });
    expect(m.taskState).toBe('diagnosing');
    expect(m.taskTransition).toBeUndefined();
  });

  it('keeps task-state fields out of the frontend Metadata (analytics-only)', () => {
    const m = buildAnalyticsMetadata({
      messageNumber: 3,
      userType: 'standard',
      role: 'assistant',
      taskState: 'diagnosing',
      taskTransition: { from: 'collecting_symptoms', to: 'diagnosing' },
    });
    const slim = pickFrontendMetadata(m as unknown as Record<string, unknown>);
    expect(slim.taskState).toBeUndefined();
    expect(slim.taskTransition).toBeUndefined();
  });
});
