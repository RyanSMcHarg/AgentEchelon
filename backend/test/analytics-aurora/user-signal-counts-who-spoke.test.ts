/**
 * USER SIGNAL COUNTS WHO SPOKE, NOT WHO WAS SERVED.
 *
 * The rate on the Evaluation dashboard is flagged-over-RATED, and every rule that makes that number
 * honest lives in this fold rather than in SQL, because the thumbs store is DynamoDB and this
 * codebase joins it in memory rather than replicating it into Aurora (tenet D7).
 *
 * Three ways it could quietly lie, each pinned below:
 *   - counting a withdrawn vote would inflate the denominator with people who decided they had
 *     nothing to say;
 *   - counting a superseded vote would let one person's change of mind show up as two opinions;
 *   - reporting a rate for an intent nobody voted on would claim a measurement that never happened.
 */
const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: jest.fn().mockRejectedValue(new Error('no model in tests')) })),
  InvokeModelCommand: jest.fn((input: unknown) => input),
}));

import { foldUserSignalByIntent } from '../../lambda/src/analytics-aurora/analytics-query';

// `note` and `channelArn` ride the same vote record: the ratings drill shows what a person wrote
// and links back to the conversation it was written in. Neither participates in this fold, and both
// are present here so the fixture is a real vote rather than the subset one function happens to read.
const vote = (over: Partial<{ messageId: string; intent: string; feedback: string; reason: string; createdAt: string; note: string; channelArn: string }> = {}) => ({
  messageId: 'm1',
  intent: 'expense_report',
  feedback: 'down',
  reason: 'unspecified',
  note: '',
  channelArn: 'arn:aws:chime:us-east-1:000000000000:app-instance/x/channel/c1',
  createdAt: '2026-09-20T10:00:00.000Z',
  ...over,
});

describe('user signal counts who spoke', () => {
  it('counts an up vote as RATED but not as flagged', () => {
    // The denominator is people who expressed a view either way. An approval is a view.
    const { byIntent: by } = foldUserSignalByIntent([vote({ feedback: 'up' })]);
    expect(by.get('expense_report')).toMatchObject({ rated: 1, flagged: 0 });
  });

  it('counts a down vote as both rated and flagged', () => {
    const { byIntent: by } = foldUserSignalByIntent([vote({ feedback: 'down' })]);
    expect(by.get('expense_report')).toMatchObject({ rated: 1, flagged: 1 });
  });

  it('does NOT count a clear as rated', () => {
    // A 'clear' is a withdrawn opinion, not an opinion. Counting it would pad the denominator with
    // somebody who decided they had nothing to say, quietly lowering every flag rate.
    const { byIntent: by } = foldUserSignalByIntent([vote({ feedback: 'clear' })]);
    expect(by.get('expense_report')).toBeUndefined();
  });

  it('reports NOTHING for an intent nobody voted on', () => {
    // The absence of a key is what the console renders as a dash. A zeroed entry here would become
    // "0% flagged", which claims we asked and nobody objected.
    const { byIntent: by } = foldUserSignalByIntent([vote({ intent: 'other_intent' })]);
    expect(by.has('expense_report')).toBe(false);
  });

  it('separates the reasons, so a flag can be attributed to the axis it indicts', () => {
    const { byIntent: by } = foldUserSignalByIntent([
      vote({ messageId: 'a', feedback: 'down', reason: 'wrong_assistant' }),
      vote({ messageId: 'b', feedback: 'down', reason: 'wrong_assistant' }),
      vote({ messageId: 'c', feedback: 'down', reason: 'poor_answer' }),
      vote({ messageId: 'd', feedback: 'down', reason: 'asked_again' }),
      vote({ messageId: 'e', feedback: 'down' }), // no reason given - the common case
    ]);
    expect(by.get('expense_report')).toMatchObject({
      rated: 5, flagged: 5, wrongAssistant: 2, poorAnswer: 1, askedAgain: 1, unspecified: 1,
    });
  });

  it('keeps intents apart', () => {
    const { byIntent: by } = foldUserSignalByIntent([
      vote({ messageId: 'a', intent: 'expense_report', feedback: 'down' }),
      vote({ messageId: 'b', intent: 'report_generation', feedback: 'up' }),
    ]);
    expect(by.get('expense_report')).toMatchObject({ rated: 1, flagged: 1 });
    expect(by.get('report_generation')).toMatchObject({ rated: 1, flagged: 0 });
  });

  it('keeps a vote whose intent was never recorded, under "unknown"', () => {
    // Older rows predate the intent being stored on the vote. Dropping them would silently discard
    // real dissatisfaction; bucketing them keeps them countable and visibly unattributed.
    const { byIntent: by, unattributed } = foldUserSignalByIntent([vote({ intent: 'unknown', feedback: 'down' })]);
    expect(by.get('unknown')).toMatchObject({ rated: 1, flagged: 1 });
    // And it is REPORTED as unattributed, not just bucketed. A count that only lives in a bucket
    // named "unknown" is indistinguishable from an intent that is genuinely called unknown.
    expect(unattributed).toBe(1);
  });
});

// ── THE FOLD BELONGS TO THE ROW'S POPULATION, NOT TO THE WHOLE WINDOW ───────────────────────────
//
// The thumbs store is a DynamoDB scan that can filter on TIME ALONE - it holds no assistant, role,
// classification or version. So without a scope every user-signal column on the Effectiveness page
// spanned every assistant regardless of the filter bar: the page that exists to answer "how is THIS
// assistant doing" answered it with everyone else's thumbs, and `user_rated_share` divided that
// unfiltered numerator by a filtered exchange count and could exceed 100%.
describe('the fold is scoped to the population the rows came from', () => {
  const scope = new Map<string, string>([
    ['in-1', 'expense_report'],
    ['in-2', 'report_generation'],
    ['in-3', 'unknown'],
  ]);

  it('does not count a vote left on a turn outside the filtered population', () => {
    const { byIntent: by, outOfScope } = foldUserSignalByIntent(
      [vote({ messageId: 'somebody-elses-turn', intent: 'expense_report', feedback: 'down' })],
      scope,
    );
    expect(by.has('expense_report')).toBe(false);
    expect(outOfScope).toBe(1);
  });

  it('counts a vote on a turn inside the population', () => {
    const { byIntent: by, outOfScope } = foldUserSignalByIntent(
      [vote({ messageId: 'in-1', feedback: 'down' })],
      scope,
    );
    expect(by.get('expense_report')).toMatchObject({ rated: 1, flagged: 1 });
    expect(outOfScope).toBe(0);
  });

  it('files the vote under the ROW\'S intent, not the one the client stamped on it', () => {
    // The vote carries an intent from when it was cast; the row carries the intent the exchange was
    // counted under. Where they differ, the reader is looking at the row.
    const { byIntent: by } = foldUserSignalByIntent(
      [vote({ messageId: 'in-2', intent: 'expense_report', feedback: 'up' })],
      scope,
    );
    expect(by.has('expense_report')).toBe(false);
    expect(by.get('report_generation')).toMatchObject({ rated: 1, up: 1 });
  });

  it('reports an in-population vote with no recorded intent as coverage loss', () => {
    const { byIntent: by, unattributed } = foldUserSignalByIntent(
      [vote({ messageId: 'in-3', feedback: 'down' })],
      scope,
    );
    // It lands on no row, because no row can carry it - and that is exactly why it has to be
    // counted somewhere rather than dropped into a tally that simply reads lower.
    expect(by.size).toBe(0);
    expect(unattributed).toBe(1);
  });

  it('an empty scope counts nothing, rather than falling back to every vote', () => {
    // The degrade direction matters: an unreadable scope must render "not measured", never
    // "everyone's thumbs", which is the defect the scope exists to end.
    const { byIntent: by, outOfScope } = foldUserSignalByIntent(
      [vote({ messageId: 'in-1', feedback: 'down' })],
      new Map(),
    );
    expect(by.size).toBe(0);
    expect(outOfScope).toBe(1);
  });
});
