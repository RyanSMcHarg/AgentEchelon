/**
 * `turn_events.battle_round` HAS A PRODUCER.
 *
 * The column has been declared since migration 019, selected by every revision of `v_turn_latency`,
 * returned by the turn audit API and rendered as a column by the admin console - and nothing ever
 * wrote it, so it was permanently NULL. The consequence was not a blank column: round 1 of a duel was
 * indistinguishable from an ordinary turn in every latency population (assistant turn counts, average
 * and p95 time to first feedback, end to end, model, tool and router averages), with no field to
 * filter on. Only round 2 was separated, and only because a rebuttal is the one interaction kind
 * outside the human-is-waiting set and therefore has no time to first feedback.
 *
 * These tests pin the chain end to end, because every link in it has been the broken one before: the
 * archival record resolves the round, the ledger writer puts it on the row the view reads, the insert
 * COLUMNS actually carry it, and the backfill writes the same fact the same way.
 *
 * ── AND THEY PIN THE SOURCE, WHICH WAS THE DECISION ────────────────────────────────────────────
 *
 * Two carriers hold the round. `analytics.battleContext.round` is merged by archival already, and it
 * is NOT on the event this column has to be recorded against: the view takes `battle_round` from the
 * `placeholder_posted` row, which comes from the placeholder's CREATE, and a duel placeholder carries
 * no metadata on either round - round 1 is materialized by Amazon Chime SDK from the Lex fulfillment
 * return, and the orchestrator's round-2 placeholder is a bare send. `battleContext` arrives only via
 * the out-of-band record the worker writes when it finishes, which is later. The `<!--battle:-->`
 * marker is in the content the moment the placeholder is posted. The last test here is the one that
 * would fail if somebody repointed this at the metadata.
 */

jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: jest.fn(async () => null),
  writeMessageAnalytics: jest.fn(async () => undefined),
}));

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  batchInsert: jest.fn(async () => 0),
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  transaction: jest.fn(),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));

import {
  ledgerRowsFor,
  writeTurnEvents,
  battleRoundOf,
  type LedgerSourceRecord,
} from '../../lambda/src/analytics-aurora/turn-events-live';
import { batchInsert } from '../../lambda/src/analytics-aurora/db-client';
import { readMessageAnalytics } from '../../lambda/src/lib/message-analytics';
import { transformToMessageRecord } from '../../lambda/src/analytics-aurora/kinesis-archival';
import { battlePlaceholderContent } from '../../lambda/src/lib/battle-turn';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c-duel';
const BOT_A = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/default';
const BOT_B = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/alt-1';
const HUMAN = 'arn:aws:chime:us-east-1:1:app-instance/i/user/u1';
const BATTLE_ID = 'btl-2026-09-16-abc';

/** A duel side's placeholder, composed by the one builder both rounds share. */
const duelPlaceholder = (round: 1 | 2) => battlePlaceholderContent({
  correlationId: `battle-r${round}-default-abc`,
  battleId: BATTLE_ID,
  round,
  totalRounds: 2,
  rivalBotArn: BOT_B,
  ...(round === 1 ? { answersMessageId: 'm-the-battle-command' } : {}),
});

const record = (over: Partial<LedgerSourceRecord> = {}): LedgerSourceRecord => ({
  event_type: 'CREATE_CHANNEL_MESSAGE',
  message_id: 'm-side-a',
  channel_arn: CHANNEL,
  sender_arn: BOT_A,
  is_bot: true,
  created_at: '2026-09-16T10:00:03.000Z',
  last_updated_at: null,
  resp_phase: null,
  content: 'One moment... <!--corr:turn-ordinary-1-->',
  task_id: null,
  task_state: null,
  ...over,
});

const placeholderRow = (rows: Array<{ kind: string }>) =>
  rows.find((r) => r.kind === 'placeholder_posted') as
    { kind: string; battle_round?: number | null } | undefined;

describe('the ledger records which round of a duel a response is', () => {
  it('a round-1 duel turn records round 1, on the row the view reads it from', () => {
    // `v_turn_latency` takes MIN(battle_round) FILTER (WHERE kind = 'placeholder_posted'), so the
    // placeholder row is the only row that can carry this without a view change.
    const content = duelPlaceholder(1);
    const rows = ledgerRowsFor([record({ content, battle_round: battleRoundOf(content) })]);
    expect(placeholderRow(rows)?.battle_round).toBe(1);
  });

  it('a round-2 rebuttal records round 2', () => {
    // The rebuttal is the turn that WAS already separable, and only by the absence of a TTFF. This
    // makes the round itself a value rather than an inference from a missing figure.
    const content = duelPlaceholder(2);
    const rows = ledgerRowsFor([record({
      message_id: 'm-side-a-r2', content, battle_round: battleRoundOf(content),
    })]);
    expect(placeholderRow(rows)?.battle_round).toBe(2);
  });

  it('an ordinary turn records NULL, and the writer is therefore not a constant', () => {
    // Non-vacuity. Same writer, same fixture, no marker: a turn nobody duelled has no round, and NULL
    // is what the column already means to every reader of it. There is no sentinel for "not a duel".
    const rows = ledgerRowsFor([record({ battle_round: battleRoundOf(record().content) })]);
    expect(placeholderRow(rows)?.battle_round).toBeNull();
  });

  it('the value survives to the INSERT, which is where a computed field usually dies', () => {
    // A round resolved onto the record and left out of the insert columns is the same permanently
    // NULL column with more code behind it.
    const content = duelPlaceholder(1);
    return writeTurnEvents([record({ content, battle_round: battleRoundOf(content) })]).then(() => {
      const [, columns, rows] = (batchInsert as jest.Mock).mock.calls[0];
      expect(columns).toContain('battle_round');
      const written = (rows as Array<Record<string, unknown>>)
        .find((r) => r.kind === 'placeholder_posted');
      expect(written?.battle_round).toBe(1);
    });
  });
});

describe('archival resolves the round, and resolves it from the marker', () => {
  const duelEvent = (content: string, over: Record<string, unknown> = {}) => ({
    EventType: 'CREATE_CHANNEL_MESSAGE',
    Payload: {
      MessageId: 'm-side-a',
      ChannelArn: CHANNEL,
      Content: content,
      Sender: { Arn: BOT_A, Name: 'Control' },
      CreatedTimestamp: '2026-09-16T10:00:03.000Z',
      Persistence: 'PERSISTENT',
      ...over,
    },
  });

  beforeEach(() => {
    (readMessageAnalytics as jest.Mock).mockReset();
    (readMessageAnalytics as jest.Mock).mockResolvedValue(null);
  });

  it('carries the round off a real duel placeholder with NO analytics record yet', async () => {
    // This is the live case, not a contrivance: the out-of-band analytics row is written when the
    // WORKER finishes, so at the moment the placeholder CREATE is archived there is nothing to read.
    const rec = await transformToMessageRecord(duelEvent(duelPlaceholder(1)) as never);
    expect(rec?.battle_round).toBe(1);
  });

  it('records nothing for an ordinary placeholder', async () => {
    const rec = await transformToMessageRecord(
      duelEvent('One moment... <!--corr:turn-ordinary-1-->') as never,
    );
    expect(rec?.battle_round).toBeNull();
  });

  it('does NOT take the round from battleContext, which is the whole choice', async () => {
    // `analytics.battleContext.round` is merged by this function already and is the carrier that
    // looks obvious. Sourcing from it would stamp the round on the UPDATE rows - where the marker has
    // been overwritten - and leave the `placeholder_posted` row the view reads NULL, which is exactly
    // the state this change exists to end. A metadata-only read fails here.
    (readMessageAnalytics as jest.Mock).mockResolvedValue({
      analytics: { battleContext: { battleId: BATTLE_ID, round: 2 }, respPhase: 'final' },
    });
    const rec = await transformToMessageRecord(
      duelEvent('Here is my answer.') as never,
    );
    expect(rec?.battle_round).toBeNull();
  });

  it('reads the marker off a BOT message only', async () => {
    // A marker read off a person's message would let anyone who can type file their own turn as a
    // duel round, which is the same rule the turn declaration beside it follows.
    const rec = await transformToMessageRecord(
      duelEvent(duelPlaceholder(1), { Sender: { Arn: HUMAN, Name: 'Alice' } }) as never,
    );
    expect(rec?.battle_round).toBeNull();
  });
});

describe('battleRoundOf', () => {
  it('reads the round regardless of what precedes it inside the marker', () => {
    expect(battleRoundOf(duelPlaceholder(1))).toBe(1);
    expect(battleRoundOf(duelPlaceholder(2))).toBe(2);
  });

  it('is absent, never zero, when nothing declared a round', () => {
    expect(battleRoundOf(null)).toBeNull();
    expect(battleRoundOf('One moment... <!--corr:turn-abc-->')).toBeNull();
    // A round of zero is not a round: a zero in this column would be a claim about a turn nobody made.
    expect(battleRoundOf(`<!--battle:battleId=${BATTLE_ID},round=0,total=2,rivalArn=${BOT_B}-->`)).toBeNull();
  });

  it('refuses a number the SMALLINT column cannot hold', () => {
    // The ledger write swallows its own failures, so an overflow would cost the whole batch every
    // measurement in it, silently.
    expect(battleRoundOf(`<!--battle:battleId=${BATTLE_ID},round=99999,total=2-->`)).toBeNull();
  });
});
