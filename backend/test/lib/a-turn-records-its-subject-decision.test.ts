/**
 * EACH TURN RECORDS WHAT ITS SUBJECT COMPARISON DECIDED.
 *
 * Drift compares every turn with the conversation's subjects. The decision rides the turn's existing
 * analytics record rather than a write of its own, so the conversation record shows when a subject
 * changed, and `general` or `off_topic` turns can be grouped by subject to find intents worth adding.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildAnalyticsMetadata } from '../../lambda/src/lib/analytics-metadata';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '../../lambda/src', rel), 'utf8');

describe('a turn records its subject decision', () => {
  it('the analytics record carries it when the turn has one, and nothing when it does not', () => {
    const base = { messageNumber: 2, classification: 'premium', role: 'assistant' } as never;
    const withDecision = buildAnalyticsMetadata({ ...(base as object), subjectDecision: { decision: 'new', distance: 0.512 } } as never);
    expect(withDecision.subjectDecision).toEqual({ decision: 'new', distance: 0.512 });
    expect(buildAnalyticsMetadata(base).subjectDecision).toBeUndefined();
  });

  it('drift reports it on every turn it compares, and an observer cannot affect the turn', () => {
    const flow = read('lib/live-drift-flow.ts');
    expect(flow).toMatch(/input\.onDecision\?\.\(\{/);
    expect(flow).toMatch(/decision: driftResult\.isDrift \? 'new' : Number\.isFinite\(driftResult\.driftScore\) \? 'same' : 'skipped'/);
    expect(flow).toMatch(/catch \{ \/\* an observer never affects the turn \*\/ \}/);
  });

  it('the router carries it on the dispatch, reset per event so one turn never carries another\'s', () => {
    const router = read('router-agent-handler.ts');
    expect(router).toMatch(/onDecision: \(d\) => \{ turnSubjectDecision = d; \}/);
    expect(router).toMatch(/payload = \{ \.\.\.payload, subjectDecision: turnSubjectDecision \}/);
    expect(router).toMatch(/turnPreferenceOutcome = undefined;\n {2}turnSubjectDecision = undefined;/);
    const core = read('lib/async-processor-core.ts');
    expect(core).toMatch(/\.\.\.\(event\.subjectDecision && \{ subjectDecision: event\.subjectDecision \}\)/);
  });
});
