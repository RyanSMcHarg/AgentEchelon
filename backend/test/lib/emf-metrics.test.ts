/**
 * emf-metrics — pins the EMF JSON shape Lambdas write to stdout for
 * CloudWatch to ingest. A drift in the shape silently breaks every drift
 * metric without breaking the Lambdas themselves, so the contract needs a
 * test even though it's "just JSON.stringify into console.log".
 *
 * Also pins UUIDv7 generation: ordering by timestamp segment matters for
 * the eval-suite SLO logic ("can we sort drift events by correlationId
 * and recover chronological order").
 */

import {
  emitEmfMetric,
  emitDriftTiming,
  emitDriftCounter,
  newCorrelationId,
} from '../../lambda/src/lib/emf-metrics';

describe('emf-metrics', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function lastLog(): Record<string, unknown> {
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1];
    return JSON.parse(lastCall[0]);
  }

  describe('emitEmfMetric', () => {
    it('emits the CloudWatch-required _aws wrapper around a single log line', () => {
      emitEmfMetric({
        namespace: 'AgentEchelon/Test',
        metrics: [{ name: 'TestCounter', unit: 'Count' }],
        dimensionSets: [['SomeDim']],
        properties: { SomeDim: 'a', TestCounter: 1 },
      });

      const out = lastLog();
      expect(out._aws).toBeDefined();
      const aws = out._aws as { Timestamp: number; CloudWatchMetrics: unknown[] };
      expect(typeof aws.Timestamp).toBe('number');
      expect(aws.CloudWatchMetrics).toHaveLength(1);
      expect(aws.CloudWatchMetrics[0]).toEqual({
        Namespace: 'AgentEchelon/Test',
        Dimensions: [['SomeDim']],
        Metrics: [{ name: 'TestCounter', unit: 'Count' }],
      });
      expect(out.SomeDim).toBe('a');
      expect(out.TestCounter).toBe(1);
    });

    it('supports multiple dimension sets (one metric, several dimension combos)', () => {
      emitEmfMetric({
        namespace: 'AgentEchelon/Test',
        metrics: [{ name: 'Latency', unit: 'Milliseconds' }],
        dimensionSets: [['Stage'], ['Stage', 'UserClearance']],
        properties: { Stage: 'embed', UserClearance: 'premium', Latency: 42 },
      });

      const aws = lastLog()._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][] }> };
      expect(aws.CloudWatchMetrics[0].Dimensions).toEqual([['Stage'], ['Stage', 'UserClearance']]);
    });
  });

  describe('emitDriftTiming', () => {
    it('writes a DriftStageLatency metric with the AgentEchelon/Drift namespace', () => {
      emitDriftTiming('message_embed', 123, 'corr-1');
      const out = lastLog();
      const aws = out._aws as { CloudWatchMetrics: Array<{ Namespace: string; Metrics: unknown[] }> };
      expect(aws.CloudWatchMetrics[0].Namespace).toBe('AgentEchelon/Drift');
      expect(aws.CloudWatchMetrics[0].Metrics).toEqual([
        { name: 'DriftStageLatency', unit: 'Milliseconds' },
      ]);
      expect(out.Stage).toBe('message_embed');
      expect(out.DriftStageLatency).toBe(123);
      expect(out.CorrelationId).toBe('corr-1');
    });

    it('adds UserClearance dimension when supplied', () => {
      emitDriftTiming('total', 99, 'c2', { userClearance: 'premium' });
      const out = lastLog();
      const aws = out._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][] }> };
      expect(aws.CloudWatchMetrics[0].Dimensions).toContainEqual(['Stage', 'UserClearance']);
      expect(out.UserClearance).toBe('premium');
    });

    it('adds Intent dimension when supplied', () => {
      emitDriftTiming('total', 99, 'c3', { intent: 'GENERAL' });
      const out = lastLog();
      const aws = out._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][] }> };
      expect(aws.CloudWatchMetrics[0].Dimensions).toContainEqual(['Stage', 'Intent']);
      expect(out.Intent).toBe('GENERAL');
    });

    it('omits optional dimensions when not provided (keeps cardinality tight)', () => {
      emitDriftTiming('summary_fetch', 10, 'c4');
      const out = lastLog();
      const aws = out._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][] }> };
      expect(aws.CloudWatchMetrics[0].Dimensions).toEqual([['Stage']]);
      expect(out.UserClearance).toBeUndefined();
      expect(out.Intent).toBeUndefined();
    });
  });

  describe('emitDriftCounter', () => {
    it('emits a counter with value 1 keyed by the counter name', () => {
      emitDriftCounter('drift_fired', 'c5');
      const out = lastLog();
      const aws = out._aws as { CloudWatchMetrics: Array<{ Metrics: unknown[] }> };
      expect(aws.CloudWatchMetrics[0].Metrics).toEqual([
        { name: 'drift_fired', unit: 'Count' },
      ]);
      expect(out.Counter).toBe('drift_fired');
      expect(out.drift_fired).toBe(1);
    });

    it('does NOT emit timing fields on counter calls (separate metric type)', () => {
      emitDriftCounter('drift_skipped_unavailable', 'c6');
      const out = lastLog();
      expect(out.DriftStageLatency).toBeUndefined();
    });
  });

  describe('newCorrelationId (UUIDv7)', () => {
    it('produces 36-char canonical UUID string', () => {
      const id = newCorrelationId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('sets the version nibble to 7', () => {
      const id = newCorrelationId();
      // version is the 13th hex char (after "xxxxxxxx-xxxx-")
      expect(id[14]).toBe('7');
    });

    it('sets the variant bits to 10xx (RFC 4122 IETF variant)', () => {
      const id = newCorrelationId();
      // variant is the 17th hex char (after "xxxxxxxx-xxxx-xxxx-")
      // High two bits must be 10 → first nibble is 8, 9, a, or b
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
    });

    it('is time-ordered: later-generated IDs sort lexicographically after earlier ones', async () => {
      const a = newCorrelationId();
      // Force a millisecond gap so the timestamp portion changes.
      await new Promise((r) => setTimeout(r, 5));
      const b = newCorrelationId();
      expect(b > a).toBe(true);
    });

    it('produces unique IDs across many invocations in the same millisecond', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) ids.add(newCorrelationId());
      expect(ids.size).toBe(100);
    });
  });
});
