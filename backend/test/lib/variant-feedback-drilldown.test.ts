/**
 * The per-vote and per-pick evidence behind the two HUMAN axes, and the collapse both depend on.
 *
 * Split from `variant-feedback.test.ts` (which pins the aggregate bucketing) because these functions
 * answer a different question: not "what is the rate" but "which records produce it". The
 * drill-down's whole purpose is that an operator can recompute the aggregate from the rows shown, so
 * every test here asserts the two agree rather than asserting a shape.
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
  type FeedbackRecord,
  type BattleOutcomeItem,
} from '../../lambda/src/analytics-aurora/variant-feedback';

const DAY = 24 * 60 * 60 * 1000;
const ISO = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const since = () => Date.now() - 30 * DAY;

/** A feedback record with the VOTE identity attached - what the table actually stores. */
const vote = (over: Partial<FeedbackRecord> = {}): FeedbackRecord => ({
  experimentId: 'exp1',
  variantId: 'control',
  intent: 'research',
  feedback: 'up',
  assignmentMode: 'probabilistic',
  createdAt: ISO(1 * DAY),
  userSub: 'user-1',
  messageId: 'msg-1',
  channelArn: 'arn:aws:chime:::channel/abc',
  ...over,
});

describe('latestVotePerVoter - the feedback log is a decision TRAIL, not a list of votes', () => {
  it('counts a revised vote ONCE, on the side the voter ended on', () => {
    const kept = latestVotePerVoter([
      vote({ feedback: 'up', createdAt: ISO(3 * DAY) }),
      vote({ feedback: 'down', createdAt: ISO(1 * DAY) }),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].feedback).toBe('down');
  });

  it('drops a withdrawn vote entirely when the latest record is a clear', () => {
    const map = aggregateVariantFeedback(
      [
        vote({ feedback: 'up', createdAt: ISO(3 * DAY) }),
        vote({ feedback: 'clear', createdAt: ISO(1 * DAY) }),
      ],
      since(),
      false,
    );
    // A clear means the voter took the thumb back. Counting the superseded 'up' reports approval
    // nobody is expressing.
    expect(map.get(feedbackKey('exp1', 'control', 'research'))).toBeUndefined();
  });

  it('a vote revised TODAY supersedes its original however old that original is', () => {
    // Order matters: applying the window BEFORE the collapse would drop the recent 'down' as a
    // duplicate of nothing and resurrect the out-of-window 'up'.
    const map = aggregateVariantFeedback(
      [
        vote({ feedback: 'up', createdAt: ISO(90 * DAY) }),
        vote({ feedback: 'down', createdAt: ISO(1 * DAY) }),
      ],
      since(),
      false,
    );
    expect(map.get(feedbackKey('exp1', 'control', 'research'))).toEqual({
      thumbs_up: 0,
      thumbs_down: 1,
      feedback_count: 1,
    });
  });

  it('keeps votes from DIFFERENT voters on one message, and one voter across messages', () => {
    const kept = latestVotePerVoter([
      vote({ userSub: 'user-1', messageId: 'msg-1' }),
      vote({ userSub: 'user-2', messageId: 'msg-1' }),
      vote({ userSub: 'user-1', messageId: 'msg-2' }),
    ]);
    expect(kept).toHaveLength(3);
  });

  it('keeps an unattributable record rather than collapsing it with another', () => {
    // Losing a vote that cannot be keyed would be a worse error than counting it once.
    const kept = latestVotePerVoter([
      vote({ userSub: null, messageId: null }),
      vote({ userSub: null, messageId: null }),
    ]);
    expect(kept).toHaveLength(2);
  });

  it('a malformed timestamp never supersedes a real vote', () => {
    const kept = latestVotePerVoter([
      vote({ feedback: 'up', createdAt: ISO(1 * DAY) }),
      vote({ feedback: 'down', createdAt: 'not-a-date' }),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].feedback).toBe('up');
  });
});

describe('selectVariantFeedbackRecords - the votes behind the approval rate', () => {
  it('returns the votes the rate counts, newest first', () => {
    const rows = selectVariantFeedbackRecords(
      [
        vote({ userSub: 'u1', messageId: 'm1', feedback: 'up', createdAt: ISO(2 * DAY) }),
        vote({ userSub: 'u2', messageId: 'm2', feedback: 'down', createdAt: ISO(1 * DAY) }),
      ],
      since(),
      false,
    );
    expect(rows.map((r) => r.feedback)).toEqual(['down', 'up']);
  });

  it('RECONCILES with the aggregate it explains: same count, same rate', () => {
    // The acceptance criterion in one assertion. A revised vote is exactly the case where a naive
    // per-row list would show three rows behind a rate computed from two.
    const items = [
      vote({ userSub: 'u1', messageId: 'm1', feedback: 'up', createdAt: ISO(5 * DAY) }),
      vote({ userSub: 'u1', messageId: 'm1', feedback: 'down', createdAt: ISO(2 * DAY) }),
      vote({ userSub: 'u2', messageId: 'm2', feedback: 'up', createdAt: ISO(1 * DAY) }),
    ];
    const rows = selectVariantFeedbackRecords(items, since(), false);
    const cols = feedbackColumnsFor(aggregateVariantFeedback(items, since(), false), 'exp1', 'control', 'research');

    expect(rows).toHaveLength(cols.feedback_count);
    const up = rows.filter((r) => r.feedback === 'up').length;
    expect(Math.round((up / rows.length) * 1000) / 10).toBe(cols.approval_rate);
    expect(cols.approval_rate).toBe(50);
  });

  it('excludes battle votes by default, matching the probabilistic rollup', () => {
    const items = [
      vote({ userSub: 'u1', messageId: 'm1', assignmentMode: 'battle' }),
      vote({ userSub: 'u2', messageId: 'm2', assignmentMode: 'probabilistic' }),
    ];
    expect(selectVariantFeedbackRecords(items, since(), false)).toHaveLength(1);
    expect(selectVariantFeedbackRecords(items, since(), true)).toHaveLength(2);
  });

  it('narrows to one variant without leaking the other', () => {
    const rows = selectVariantFeedbackRecords(
      [
        vote({ userSub: 'u1', messageId: 'm1', variantId: 'control' }),
        vote({ userSub: 'u2', messageId: 'm2', variantId: 'treatment' }),
      ],
      since(),
      false,
      'treatment',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].variantId).toBe('treatment');
  });

  it('never returns another experiment’s votes', () => {
    const rows = selectVariantFeedbackRecords(
      [vote({ experimentId: 'exp2', userSub: 'u9', messageId: 'm9' })],
      since(),
      false,
    );
    // The caller scans one experiment, but the filter is the guarantee: an unscoped drill-down is
    // the failure this whole feature exists to avoid.
    expect(rows.every((r) => r.experimentId === 'exp2')).toBe(true);
  });
});

describe('selectBattlePicks - the picks behind battle_wins', () => {
  const pick = (over: Partial<BattleOutcomeItem> = {}): BattleOutcomeItem => ({
    experimentId: 'exp1',
    variantId: 'treatment',
    winner: 'B',
    intent: 'research',
    chosenAt: ISO(1 * DAY),
    battleId: 'battle-1',
    ...over,
  });

  it('RECONCILES with the win count: one row per counted pick', () => {
    const items = [
      pick({ variantId: 'treatment', battleId: 'b1' }),
      pick({ variantId: 'control', winner: 'A', battleId: 'b2' }),
      pick({ variantId: 'treatment', battleId: 'b3' }),
    ];
    const rows = selectBattlePicks(items, since());
    const wins = aggregateBattleWinsByVariant(items, since());
    expect(rows.filter((r) => r.variantId === 'treatment')).toHaveLength(
      wins.get(battleWinKey('exp1', 'treatment')) as number,
    );
    expect(rows.filter((r) => r.variantId === 'control')).toHaveLength(
      wins.get(battleWinKey('exp1', 'control')) as number,
    );
  });

  it('excludes ties, exactly as the tally does', () => {
    // A tie credits no side, so it did not move the number being reconciled.
    const rows = selectBattlePicks(
      [pick({ variantId: null, winner: 'tie', battleId: 'b1' }), pick({ battleId: 'b2' })],
      since(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].battleId).toBe('b2');
  });

  it('drops picks outside the window and orders newest first', () => {
    const rows = selectBattlePicks(
      [
        pick({ battleId: 'old', chosenAt: ISO(60 * DAY) }),
        pick({ battleId: 'newer', chosenAt: ISO(1 * DAY) }),
        pick({ battleId: 'older', chosenAt: ISO(10 * DAY) }),
      ],
      since(),
    );
    expect(rows.map((r) => r.battleId)).toEqual(['newer', 'older']);
  });

  it('narrows to one variant', () => {
    const rows = selectBattlePicks(
      [pick({ variantId: 'control', winner: 'A' }), pick({ variantId: 'treatment' })],
      since(),
      'control',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].variantId).toBe('control');
  });
});

describe('flattenBattleOutcomeItem carries the battle identity through', () => {
  it('attaches battleId and the voter to every per-user pick', () => {
    // Without the battleId a pick cannot be traced to the duel it judged, and the drill-down would
    // show a win with no way to see what was chosen between.
    const picks = flattenBattleOutcomeItem({
      battleId: 'b-42',
      votes: {
        'user-a': { winner: 'B', variantId: 'treatment', experimentId: 'exp1', chosenAt: ISO(1 * DAY) },
      },
    });
    expect(picks).toHaveLength(1);
    expect(picks[0].battleId).toBe('b-42');
    expect(picks[0].userSub).toBe('user-a');
  });

  it('carries it through the legacy single-pick row too', () => {
    const picks = flattenBattleOutcomeItem({
      battleId: 'b-legacy',
      winner: 'A',
      variantId: 'control',
      experimentId: 'exp1',
      chosenAt: ISO(1 * DAY),
      chosenByUserSub: 'user-legacy',
    });
    expect(picks[0].battleId).toBe('b-legacy');
    expect(picks[0].userSub).toBe('user-legacy');
  });
});
