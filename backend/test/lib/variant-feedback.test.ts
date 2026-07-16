/**
 * Per-variant thumbs aggregation (feedback join).
 *
 * Pure-function tests for the bucketing rules the analytics-query Lambda uses to
 * fold DynamoDB thumbs into the Aurora experiment_results rows: variant+intent
 * grain, date window, battle exclusion, and the null-when-no-signal contract.
 */

import {
  aggregateVariantFeedback,
  aggregateBattleWins,
  feedbackColumnsFor,
  battleColumnsFor,
  feedbackKey,
  type FeedbackItem,
  type BattleOutcomeItem,
} from '../../lambda/src/analytics-aurora/variant-feedback';

const ISO = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const DAY = 24 * 60 * 60 * 1000;

const item = (over: Partial<FeedbackItem> = {}): FeedbackItem => ({
  experimentId: 'exp1',
  variantId: 'control',
  intent: 'research',
  feedback: 'up',
  assignmentMode: 'probabilistic',
  createdAt: ISO(1 * DAY),
  ...over,
});

describe('aggregateVariantFeedback', () => {
  const since = () => Date.now() - 30 * DAY;

  it('buckets up/down votes by variant+intent', () => {
    const map = aggregateVariantFeedback(
      [
        item({ feedback: 'up' }),
        item({ feedback: 'up' }),
        item({ feedback: 'down' }),
        item({ variantId: 'treatment', feedback: 'up' }),
      ],
      since(),
      false,
    );
    expect(map.get(feedbackKey('control', 'research'))).toEqual({
      thumbs_up: 2,
      thumbs_down: 1,
      feedback_count: 3,
    });
    expect(map.get(feedbackKey('treatment', 'research'))).toEqual({
      thumbs_up: 1,
      thumbs_down: 0,
      feedback_count: 1,
    });
  });

  it('separates buckets by intent', () => {
    const map = aggregateVariantFeedback(
      [item({ intent: 'research' }), item({ intent: 'action_item' })],
      since(),
      false,
    );
    expect(map.get(feedbackKey('control', 'research'))?.feedback_count).toBe(1);
    expect(map.get(feedbackKey('control', 'action_item'))?.feedback_count).toBe(1);
  });

  it('treats missing/blank intent as "unknown"', () => {
    const map = aggregateVariantFeedback([item({ intent: null }), item({ intent: '' })], since(), false);
    expect(map.get(feedbackKey('control', 'unknown'))?.feedback_count).toBe(2);
  });

  it('drops records outside the date window', () => {
    const map = aggregateVariantFeedback(
      [item({ createdAt: ISO(1 * DAY) }), item({ createdAt: ISO(60 * DAY) })],
      since(),
      false,
    );
    expect(map.get(feedbackKey('control', 'research'))?.feedback_count).toBe(1);
  });

  it('excludes battle traffic by default, includes it when asked', () => {
    const rows = [item({ assignmentMode: 'probabilistic' }), item({ assignmentMode: 'battle' })];
    expect(aggregateVariantFeedback(rows, since(), false).get(feedbackKey('control', 'research'))?.feedback_count).toBe(1);
    expect(aggregateVariantFeedback(rows, since(), true).get(feedbackKey('control', 'research'))?.feedback_count).toBe(2);
  });

  it('skips records without experimentId or variantId, and non up/down votes', () => {
    const map = aggregateVariantFeedback(
      [
        item({ experimentId: null }),
        item({ variantId: '' }),
        item({ feedback: 'meh' }),
        item({ feedback: 'up' }),
      ],
      since(),
      false,
    );
    expect(map.get(feedbackKey('control', 'research'))?.feedback_count).toBe(1);
  });
});

describe('feedbackColumnsFor', () => {
  it('returns null approval_rate and zero counts when no feedback exists', () => {
    const cols = feedbackColumnsFor(new Map(), 'control', 'research');
    expect(cols).toEqual({ thumbs_up: 0, thumbs_down: 0, feedback_count: 0, approval_rate: null });
  });

  it('computes approval_rate as a rounded percent of thumbs_up', () => {
    const map = aggregateVariantFeedback(
      [item({ feedback: 'up' }), item({ feedback: 'up' }), item({ feedback: 'down' })],
      Date.now() - 30 * DAY,
      false,
    );
    const cols = feedbackColumnsFor(map, 'control', 'research');
    expect(cols.feedback_count).toBe(3);
    expect(cols.approval_rate).toBeCloseTo(66.7, 1);
  });
});

const pick = (over: Partial<BattleOutcomeItem> = {}): BattleOutcomeItem => ({
  experimentId: 'exp1',
  variantId: 'control',
  intent: 'research',
  winner: 'A',
  chosenAt: ISO(1 * DAY),
  ...over,
});

describe('aggregateBattleWins', () => {
  const since = () => Date.now() - 30 * DAY;

  it('counts wins per variant+intent for the credited side', () => {
    const map = aggregateBattleWins(
      [
        pick({ variantId: 'control' }),
        pick({ variantId: 'control' }),
        pick({ variantId: 'treatment' }),
      ],
      since(),
    );
    expect(map.get(feedbackKey('control', 'research'))).toBe(2);
    expect(map.get(feedbackKey('treatment', 'research'))).toBe(1);
  });

  it('drops ties (no variantId) and picks without an experiment', () => {
    const map = aggregateBattleWins(
      [
        pick({ winner: 'tie', variantId: null }),
        pick({ experimentId: null }),
        pick({ variantId: 'control' }),
      ],
      since(),
    );
    expect(map.get(feedbackKey('control', 'research'))).toBe(1);
    expect(map.size).toBe(1);
  });

  it('drops picks outside the date window', () => {
    const map = aggregateBattleWins(
      [pick({ chosenAt: ISO(1 * DAY) }), pick({ chosenAt: ISO(90 * DAY) })],
      since(),
    );
    expect(map.get(feedbackKey('control', 'research'))).toBe(1);
  });
});

describe('battleColumnsFor', () => {
  it('returns null battle_wins when no pick credits the variant', () => {
    expect(battleColumnsFor(new Map(), 'treatment', 'research')).toEqual({ battle_wins: null });
  });

  it('returns the win count when present', () => {
    const map = aggregateBattleWins([pick(), pick()], Date.now() - 30 * DAY);
    expect(battleColumnsFor(map, 'control', 'research')).toEqual({ battle_wins: 2 });
  });
});
