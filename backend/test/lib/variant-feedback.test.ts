/**
 * Per-variant thumbs aggregation (feedback join).
 *
 * Pure-function tests for the bucketing rules the analytics-query Lambda uses to
 * fold DynamoDB thumbs into the Aurora experiment_results rows: variant+intent
 * grain, date window, battle exclusion, and the null-when-no-signal contract.
 */

import {
  aggregateVariantFeedback,
  aggregateBattleWinsByVariant,
  flattenBattleOutcomeItem,
  feedbackColumnsFor,
  feedbackKey,
  battleWinKey,
  latestVotePerVoter,
  selectVariantFeedbackRecords,
  selectBattlePicks,
  type FeedbackItem,
  type FeedbackRecord,
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
    expect(map.get(feedbackKey('exp1', 'control', 'research'))).toEqual({
      thumbs_up: 2,
      thumbs_down: 1,
      feedback_count: 3,
    });
    expect(map.get(feedbackKey('exp1', 'treatment', 'research'))).toEqual({
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
    expect(map.get(feedbackKey('exp1', 'control', 'research'))?.feedback_count).toBe(1);
    expect(map.get(feedbackKey('exp1', 'control', 'action_item'))?.feedback_count).toBe(1);
  });

  it('treats missing/blank intent as "unknown"', () => {
    const map = aggregateVariantFeedback([item({ intent: null }), item({ intent: '' })], since(), false);
    expect(map.get(feedbackKey('exp1', 'control', 'unknown'))?.feedback_count).toBe(2);
  });

  it('drops records outside the date window', () => {
    const map = aggregateVariantFeedback(
      [item({ createdAt: ISO(1 * DAY) }), item({ createdAt: ISO(60 * DAY) })],
      since(),
      false,
    );
    expect(map.get(feedbackKey('exp1', 'control', 'research'))?.feedback_count).toBe(1);
  });

  it('excludes battle traffic by default, includes it when asked', () => {
    const rows = [item({ assignmentMode: 'probabilistic' }), item({ assignmentMode: 'battle' })];
    expect(aggregateVariantFeedback(rows, since(), false).get(feedbackKey('exp1', 'control', 'research'))?.feedback_count).toBe(1);
    expect(aggregateVariantFeedback(rows, since(), true).get(feedbackKey('exp1', 'control', 'research'))?.feedback_count).toBe(2);
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
    expect(map.get(feedbackKey('exp1', 'control', 'research'))?.feedback_count).toBe(1);
  });
});

describe('feedbackColumnsFor', () => {
  it('returns null approval_rate and zero counts when no feedback exists', () => {
    const cols = feedbackColumnsFor(new Map(), 'exp1', 'control', 'research');
    expect(cols).toEqual({ thumbs_up: 0, thumbs_down: 0, feedback_count: 0, approval_rate: null });
  });

  it('computes approval_rate as a rounded percent of thumbs_up', () => {
    const map = aggregateVariantFeedback(
      [item({ feedback: 'up' }), item({ feedback: 'up' }), item({ feedback: 'down' })],
      Date.now() - 30 * DAY,
      false,
    );
    const cols = feedbackColumnsFor(map, 'exp1', 'control', 'research');
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

describe('aggregateBattleWinsByVariant (battle-scoped effectiveness key)', () => {
  const since = () => Date.now() - 30 * DAY;

  it('sums wins per (experiment, variant) ACROSS intents (not split by intent)', () => {
    const map = aggregateBattleWinsByVariant(
      [
        pick({ variantId: 'control', intent: 'research' }),
        pick({ variantId: 'control', intent: 'action_item' }),
        pick({ variantId: 'treatment', intent: 'research' }),
      ],
      since(),
    );
    // Both control picks collapse into ONE bucket (unlike the (variant,intent)-grained A/B tally).
    expect(map.get(battleWinKey('exp1', 'control'))).toBe(2);
    expect(map.get(battleWinKey('exp1', 'treatment'))).toBe(1);
  });

  it('keeps experiments separate even when variantIds collide (control/treatment)', () => {
    const map = aggregateBattleWinsByVariant(
      [pick({ experimentId: 'exp1', variantId: 'control' }), pick({ experimentId: 'exp2', variantId: 'control' })],
      since(),
    );
    expect(map.get(battleWinKey('exp1', 'control'))).toBe(1);
    expect(map.get(battleWinKey('exp2', 'control'))).toBe(1);
  });

  it('drops ties (no variantId), picks without an experiment, and out-of-window picks', () => {
    const map = aggregateBattleWinsByVariant(
      [
        pick({ winner: 'tie', variantId: null }),
        pick({ experimentId: null }),
        pick({ chosenAt: ISO(90 * DAY) }),
        pick({ variantId: 'control' }),
      ],
      since(),
    );
    expect(map.get(battleWinKey('exp1', 'control'))).toBe(1);
    expect(map.size).toBe(1);
  });
});

describe('flattenBattleOutcomeItem (votes-map → per-pick)', () => {
  it('hoists every entry of a v2 per-user votes map into one pick each', () => {
    const picks = flattenBattleOutcomeItem({
      votes: {
        'sub-a': { winner: 'A', variantId: 'control', experimentId: 'exp1', intent: 'research', chosenAt: ISO(1 * DAY) },
        'sub-b': { winner: 'B', variantId: 'treatment', experimentId: 'exp1', intent: 'research', chosenAt: ISO(2 * DAY) },
      },
    });
    expect(picks).toHaveLength(2);
    // Feeds the aggregator directly: one win per credited side.
    const wins = aggregateBattleWinsByVariant(picks, Date.now() - 30 * DAY);
    expect(wins.get(battleWinKey('exp1', 'control'))).toBe(1);
    expect(wins.get(battleWinKey('exp1', 'treatment'))).toBe(1);
  });

  it('returns [] for an empty/absent votes map', () => {
    expect(flattenBattleOutcomeItem(null)).toEqual([]);
    expect(flattenBattleOutcomeItem({})).toEqual([]);
    expect(flattenBattleOutcomeItem({ votes: {} })).toEqual([]);
  });

  it('skips malformed vote entries but keeps valid siblings', () => {
    const picks = flattenBattleOutcomeItem({
      votes: { 'sub-a': null, 'sub-b': { winner: 'A', variantId: 'control', experimentId: 'exp1', chosenAt: ISO(1 * DAY) } },
    });
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ variantId: 'control', experimentId: 'exp1' });
  });

  it('tolerates a legacy v1 top-level single pick (no votes map)', () => {
    const picks = flattenBattleOutcomeItem({
      winner: 'B', variantId: 'treatment', experimentId: 'exp1', intent: 'research', chosenAt: ISO(1 * DAY),
    });
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ winner: 'B', variantId: 'treatment' });
  });

  it('does not double-count a sub present in both the map and a legacy field', () => {
    const picks = flattenBattleOutcomeItem({
      chosenByUserSub: 'sub-a',
      winner: 'A', variantId: 'control', experimentId: 'exp1', chosenAt: ISO(3 * DAY),
      votes: { 'sub-a': { winner: 'B', variantId: 'treatment', experimentId: 'exp1', chosenAt: ISO(1 * DAY) } },
    });
    expect(picks).toHaveLength(1);
    expect(picks[0].variantId).toBe('treatment'); // the votes-map entry wins
  });
});

// ---------------------------------------------------------------------------
// Cross-experiment collision — the defect this key shape exists to prevent.
//
// `control` and `treatment` are PER-EXPERIMENT labels, not global ones. Keyed on variant+intent alone,
// two experiments sharing both shared one bucket, and on the all-experiments view (which scans every
// experiment's feedback at once) each row reported the other's votes. The sibling `battleWinKey`
// already carried the experiment for exactly this reason; the feedback key did not.
// ---------------------------------------------------------------------------
describe('feedback attribution across experiments', () => {
  const since = () => Date.now() - 30 * DAY;

  it('does NOT mix two experiments that share a variant id and intent', () => {
    const map = aggregateVariantFeedback(
      [
        // exp1/control: 2 up
        item({ experimentId: 'exp1', variantId: 'control', feedback: 'up' }),
        item({ experimentId: 'exp1', variantId: 'control', feedback: 'up' }),
        // exp2/control: 1 down — same variant id, same intent, different experiment
        item({ experimentId: 'exp2', variantId: 'control', feedback: 'down' }),
      ],
      since(),
      false,
    );

    expect(map.get(feedbackKey('exp1', 'control', 'research'))).toEqual({
      thumbs_up: 2, thumbs_down: 0, feedback_count: 2,
    });
    expect(map.get(feedbackKey('exp2', 'control', 'research'))).toEqual({
      thumbs_up: 0, thumbs_down: 1, feedback_count: 1,
    });
    // Two distinct buckets. Keyed on variant+intent this was ONE bucket of 3 votes,
    // and both experiments reported a 67% approval rate that neither had earned.
    expect(map.size).toBe(2);
  });

  it('reports each experiment its own approval rate, not the pooled one', () => {
    const map = aggregateVariantFeedback(
      [
        item({ experimentId: 'exp1', variantId: 'control', feedback: 'up' }),
        item({ experimentId: 'exp2', variantId: 'control', feedback: 'down' }),
      ],
      since(),
      false,
    );
    expect(feedbackColumnsFor(map, 'exp1', 'control', 'research').approval_rate).toBe(100);
    expect(feedbackColumnsFor(map, 'exp2', 'control', 'research').approval_rate).toBe(0);
  });

  it('an experiment with no votes stays honestly empty even when a SIBLING experiment has votes', () => {
    // The failure this guards: exp3 borrowing exp1's votes and rendering a rate it never earned.
    const map = aggregateVariantFeedback(
      [item({ experimentId: 'exp1', variantId: 'control', feedback: 'up' })],
      since(),
      false,
    );
    const cols = feedbackColumnsFor(map, 'exp3', 'control', 'research');
    expect(cols.feedback_count).toBe(0);
    expect(cols.approval_rate).toBeNull();
  });
});
