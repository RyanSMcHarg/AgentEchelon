import { describe, it, expect } from 'vitest';
import { computeAlerts } from './alerts';

describe('computeAlerts', () => {
  it('is empty when every metric is within target', () => {
    const alerts = computeAlerts({
      intentEffectiveness: [
        { intent: 'general', direct_count: 10, task_count: 0, direct_relevance: 90, avg_confidence: 95, tool_calls: 0 },
      ],
      latency: [{ delivery_option: 'DIRECT', exchange_count: 100, avg_ttff_ms: 600, p95_total_ms: 8000 }],
      modelEffectiveness: [{ model: 'haiku', avg_score: 88 }],
      flagged: [],
      errorRate: [{ error_count: 0, total_count: 1000 }],
    });
    expect(alerts).toEqual([]);
  });

  it('flags a latency SLA breach (TTFF over target), traffic-weighted and task-excluded', () => {
    const alerts = computeAlerts({
      // A slow TASK row must NOT drag the perceived TTFF; only the direct rows count.
      latency: [
        { delivery_option: 'DIRECT', exchange_count: 100, avg_ttff_ms: 3200, p95_total_ms: 9000 },
        { delivery_option: 'TASK_MULTI_STEP', exchange_count: 100, avg_ttff_ms: 90000, p95_total_ms: 120000 },
      ],
    });
    const ttff = alerts.find((a) => a.id === 'lat-ttff');
    expect(ttff?.severity).toBe('error');       // 3.2s vs target 1s -> bad
    expect(ttff?.category).toBe('latency');
    expect(ttff?.tab).toBe('latency');
    // P95 9000ms is within target (<=15000) -> no P95 alert.
    expect(alerts.find((a) => a.id === 'lat-p95')).toBeUndefined();
  });

  it('flags a per-intent quality breach and a tool-error runtime alert', () => {
    const alerts = computeAlerts({
      intentEffectiveness: [
        // direct relevance 40 (< warn 50) -> error; tool error rate 20% (> warn 15) with calls -> error.
        { intent: 'report_generation', direct_count: 5, task_count: 0, direct_relevance: 40, avg_confidence: 90, tool_calls: 10, tool_error_rate: 20 },
      ],
    });
    const exec = alerts.find((a) => a.id === 'q-exec-report_generation');
    expect(exec?.category).toBe('quality');
    expect(exec?.intent).toBe('report_generation');
    expect(exec?.tab).toBe('effectiveness');
    const tool = alerts.find((a) => a.id === 'r-tool-report_generation');
    expect(tool?.category).toBe('runtime');
    expect(tool?.severity).toBe('error');
  });

  it('does not raise a tool alert when the intent made no tool calls', () => {
    const alerts = computeAlerts({
      intentEffectiveness: [
        { intent: 'greeting', direct_count: 5, task_count: 0, direct_relevance: 90, avg_confidence: 90, tool_calls: 0, tool_error_rate: 99 },
      ],
    });
    expect(alerts.find((a) => a.id === 'r-tool-greeting')).toBeUndefined();
  });

  it('raises a runtime alert for error-response replies and sorts errors before warnings', () => {
    const alerts = computeAlerts({
      // A warn-tier latency + an error-tier runtime alert; error must sort first.
      latency: [{ delivery_option: 'DIRECT', exchange_count: 10, avg_ttff_ms: 1500, p95_total_ms: 9000 }], // 1.5s -> warn
      flagged: [{ classification: 'error_response' }, { classification: 'poor' }, { classification: 'error_response' }],
    });
    expect(alerts[0].severity).toBe('error');
    const err = alerts.find((a) => a.id === 'r-error-responses');
    expect(err?.title).toContain('2 error-response replies');
    expect(err?.tab).toBe('flagged');
  });

  it('uses completion rate for a task-dominant intent', () => {
    const alerts = computeAlerts({
      intentEffectiveness: [
        { intent: 'data_extraction', task_count: 8, direct_count: 1, task_completion_rate: 55, avg_confidence: 90, tool_calls: 0 },
      ],
    });
    const exec = alerts.find((a) => a.id === 'q-exec-data_extraction');
    expect(exec).toBeDefined();               // 55% completion < warn 60 -> alert
    expect(exec?.title).toContain('completion');
  });
});
