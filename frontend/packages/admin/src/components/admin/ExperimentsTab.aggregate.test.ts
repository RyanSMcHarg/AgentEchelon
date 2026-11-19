import { describe, it, expect } from 'vitest';
import type { ExperimentResultRow } from '@ae/shared';
import { aggregateVariant } from './ExperimentsTab';

// A VARIANT'S LATENCY AND COST ARE MEANS OVER THE TURNS THAT MEASURED THEM. Combining its rows weights each
// row's mean by the turns behind it, so a row whose telemetry is mostly missing counts for what it measured.

const row = (over: Partial<ExperimentResultRow>): ExperimentResultRow => ({
  experiment_id: 'e', variant_id: 'b', model_name: 'm', intent: 'general', assistant: 'a',
  exchange_count: 10, scored_count: 0, avg_score: null as unknown as number,
  avg_total_ms: 0, avg_cost_usd: null, ...over,
} as ExperimentResultRow);

describe('aggregateVariant', () => {
  it('weights latency by the turns that recorded one', () => {
    const agg = aggregateVariant([
      row({ exchange_count: 100, timed_count: 1, avg_total_ms: 9000 }),
      row({ exchange_count: 10, timed_count: 10, avg_total_ms: 1000 }),
    ]);
    // (9000*1 + 1000*10) / 11, not (9000*100 + 1000*10) / 110.
    expect(agg.avg_total_ms).toBe(1727);
  });

  it('weights cost by the turns that could be priced, and skips a row that priced none', () => {
    const agg = aggregateVariant([
      row({ exchange_count: 50, priced_count: 0, avg_cost_usd: null }),
      row({ exchange_count: 10, priced_count: 5, avg_cost_usd: 0.002 }),
      row({ exchange_count: 10, priced_count: 15, avg_cost_usd: 0.004 }),
    ]);
    expect(agg.avg_cost_usd).toBe(0.0035);
  });

  it('weights by exchanges when a row carries no counts', () => {
    const agg = aggregateVariant([
      row({ exchange_count: 30, avg_total_ms: 2000 }),
      row({ exchange_count: 10, avg_total_ms: 1000 }),
    ]);
    expect(agg.avg_total_ms).toBe(1750);
  });
});
