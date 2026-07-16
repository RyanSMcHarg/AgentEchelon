import { describe, it, expect } from 'vitest';
import { evaluateObjective } from './ExperimentsTab';

// Minimal VariantAgg shape — evaluateObjective only reads these metric fields.
type Agg = Parameters<typeof evaluateObjective>[1];
const agg = (over: Partial<Agg>): Agg =>
  ({
    variant_id: 'control',
    model_name: 'm',
    exchange_count: 100,
    task_count: 0,
    avg_score: null,
    avg_total_ms: null,
    avg_cost_usd: null,
    compliance_rate: null,
    fallback_rate: null,
    task_completion_rate: null,
    ...over,
  }) as Agg;

describe('evaluateObjective', () => {
  it('cost: met when treatment is cheaper than control by >= target', () => {
    const p = evaluateObjective(
      { metric: 'cost', target: 20 },
      agg({ avg_cost_usd: 0.01 }),
      agg({ avg_cost_usd: 0.007 }), // 30% cheaper
    );
    expect(p.status).toBe('met');
    expect(p.currentText).toContain('−30%');
  });

  it('cost: not_met when the decrease is below target', () => {
    const p = evaluateObjective(
      { metric: 'cost', target: 20 },
      agg({ avg_cost_usd: 0.01 }),
      agg({ avg_cost_usd: 0.009 }), // 10% cheaper
    );
    expect(p.status).toBe('not_met');
  });

  it('cost: pending when an estimate is missing', () => {
    const p = evaluateObjective({ metric: 'cost', target: 20 }, agg({ avg_cost_usd: null }), agg({ avg_cost_usd: 0.005 }));
    expect(p.status).toBe('pending');
  });

  it('latency: a slower treatment shows a + delta and not_met', () => {
    const p = evaluateObjective(
      { metric: 'latency', target: 10 },
      agg({ avg_total_ms: 1000 }),
      agg({ avg_total_ms: 1200 }), // 20% slower
    );
    expect(p.status).toBe('not_met');
    expect(p.currentText).toContain('+20%');
  });

  it('quality: met when treatment score >= target', () => {
    const p = evaluateObjective({ metric: 'quality', target: 80 }, agg({ avg_score: 70 }), agg({ avg_score: 85 }));
    expect(p.status).toBe('met');
  });

  it('quality: pending when no evaluator score yet', () => {
    const p = evaluateObjective({ metric: 'quality', target: 80 }, agg({}), agg({ avg_score: null }));
    expect(p.status).toBe('pending');
  });

  it('accuracy: always pending until the classifier-accuracy eval exists', () => {
    const p = evaluateObjective({ metric: 'accuracy', target: 90 }, agg({ avg_score: 95 }), agg({ avg_score: 99 }));
    expect(p.status).toBe('pending');
    expect(p.note).toMatch(/classifier-accuracy/);
  });
});
