/**
 * The CloudWatch contract between the runtime and the stack.
 *
 * The Lambda bundle and the CDK app are separate compilation units; neither imports the other, so the
 * metric namespace, names and dimension keys are declared in two places. A divergence is invisible in
 * the worst way: the runtime keeps emitting, the dashboard keeps rendering, every widget is empty, and
 * nothing anywhere says why. That is precisely the "guard that passes having checked nothing" shape
 * this repo keeps getting caught by, so it is pinned here.
 */
import { CONTEXT_SOURCE_METRIC_NAMESPACE } from '../../lib/config/context-sources';
import {
  CONTEXT_SOURCE_NAMESPACE,
  emitContextSourceOutcome,
} from '../../lambda/src/lib/context-source-outcomes';

describe('context source metric contract', () => {
  it('the stack and the runtime name the SAME namespace', () => {
    expect(CONTEXT_SOURCE_METRIC_NAMESPACE).toBe(CONTEXT_SOURCE_NAMESPACE);
  });

  describe('the dimension sets the dashboard and alarm depend on', () => {
    let emitted: Record<string, unknown>;
    let spy: jest.SpyInstance;

    beforeEach(() => {
      spy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
        emitted = JSON.parse(line);
      });
      emitContextSourceOutcome({ classification: 'standard', sourceKey: 'company-docs', outcome: 'denied' });
    });
    afterEach(() => spy.mockRestore());

    it('emits a Classification-ONLY rollup, which is what the rate alarm divides', () => {
      // The alarm computes failed/(failed+resolved) for a classification. Without this dimension set
      // that is a SUM over one series per outcome - which silently under-counts the day an outcome is
      // added and the expression is not updated with it.
      const dims = (emitted._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][] }> })
        .CloudWatchMetrics[0].Dimensions;
      expect(dims).toContainEqual(['Classification']);
    });

    it('emits the Outcome and SourceKey breakdowns the dashboard widgets read', () => {
      const dims = (emitted._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][] }> })
        .CloudWatchMetrics[0].Dimensions;
      expect(dims).toContainEqual(['Classification', 'Outcome']);
      expect(dims).toContainEqual(['Classification', 'Outcome', 'SourceKey']);
    });

    it('names the dimension KEYS the stack uses verbatim', () => {
      // dimensionsMap in the stack is { Classification, Outcome, SourceKey }. A rename on either side
      // yields a metric that exists and is never graphed.
      expect(emitted).toHaveProperty('Classification');
      expect(emitted).toHaveProperty('Outcome');
      expect(emitted).toHaveProperty('SourceKey');
    });

    it('names the metrics the alarm and dashboard reference', () => {
      const names = new Set<string>();
      for (const outcome of ['resolved', 'denied', 'not-in-catalog'] as const) {
        emitContextSourceOutcome({ classification: 'standard', sourceKey: 'k', outcome });
        names.add((emitted._aws as { CloudWatchMetrics: Array<{ Metrics: Array<{ Name: string }> }> })
          .CloudWatchMetrics[0].Metrics[0].Name);
      }
      expect(names).toEqual(new Set([
        'ContextSourceResolved', 'ContextSourceFailed', 'ContextSourceSkipped',
      ]));
    });
  });
});
