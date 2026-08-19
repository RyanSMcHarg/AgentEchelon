/**
 * THE LEDGER'S LIVE WRITER (tracker row 50 step 3).
 *
 * `turn_events` existed from migration 019 with NO runtime writer - only a hand-run backfill - so
 * `v_turn_latency` and `v_task_resolution` were built, documented and empty. Every claim resting on
 * them was unprovable, which is the inert-mechanism shape this repo keeps finding.
 *
 * The mapping tested here IS the finality decision on this path, so it is a pure function and the
 * tests exercise it directly. A decision that can only be reached through Postgres does not get
 * exercised, and this one decides whether a turn is closed at all.
 */
import { ledgerRowsFor, kindForPhase, declaredTurnId } from '../../lambda/src/analytics-aurora/turn-events-live';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/premium';
const HUMAN = 'arn:aws:chime:us-east-1:111:app-instance/i/user/alice';

const rec = (over: Record<string, unknown> = {}) => ({
  event_type: 'CREATE_CHANNEL_MESSAGE',
  message_id: 'm-1',
  channel_arn: CHANNEL,
  sender_arn: BOT,
  is_bot: true,
  created_at: '2026-08-15T00:00:01.000Z',
  last_updated_at: null,
  resp_phase: null,
  content: 'One moment<!--corr:turn-abc-->',
  task_id: null,
  task_state: null,
  ...over,
} as any);

describe('only a declared final closes a turn', () => {
  it('maps the declared phase to a kind', () => {
    expect(kindForPhase('final')).toBe('final_response');
    expect(kindForPhase('interim')).toBe('progress_update');
    expect(kindForPhase('error')).toBe('error_response');
    expect(kindForPhase('notice')).toBe('notice_posted');
  });

  it('FAILS CLOSED on a phase it has never heard of', () => {
    // The forward-looking guarantee. A phase invented later by a component that has not been taught
    // about latency must not be able to close a turn early - the defect the declared marker replaced
    // was exactly an unstated rule deciding finality by accident.
    expect(kindForPhase('some_future_kind')).toBe('progress_update');
    expect(kindForPhase(null)).toBe('progress_update');
  });

  it('does not let an ERROR close the turn', () => {
    // A failure is not a completion. Folding its duration into time-to-answer would make a broken turn
    // read as a fast one - and under the old total_ms proxy it did exactly that.
    const [row] = ledgerRowsFor([rec({ event_type: 'UPDATE_CHANNEL_MESSAGE', resp_phase: 'error', last_updated_at: '2026-08-15T00:00:09.000Z' })]);
    expect(row.kind).toBe('error_response');
    expect(row.kind).not.toBe('final_response');
  });
});

describe('what each event becomes', () => {
  it('a bot message carrying the marker is the placeholder, and declares its turn', () => {
    const [row] = ledgerRowsFor([rec()]);
    expect(row.kind).toBe('placeholder_posted');
    expect(row.turn_id).toBe('turn-abc');
    expect(row.turn_id_source).toBe('declared');
    expect(row.response_id).toBe('m-1');
  });

  it('a bot message with NO marker is a chunk, not a response', () => {
    // It has no placeholder of its own. Counting it as a response is the "counted MESSAGES where it
    // meant RESPONSES" mistake that cost a drift investigation.
    const [row] = ledgerRowsFor([rec({ content: 'part two of the answer' })]);
    expect(row.kind).toBe('continuation_chunk');
    expect(row.response_id).toBeNull();
  });

  it("a person's message is the anchor, and admits its id is derived", () => {
    // The processor is never handed the user's Chime MessageId, so the binding is made later by
    // pairing. Recording `paired` with a null id states that rather than inventing a join key.
    const [row] = ledgerRowsFor([rec({ is_bot: false, sender_arn: HUMAN, content: 'do the thing' })]);
    expect(row.kind).toBe('user_message');
    expect(row.turn_id_source).toBe('paired');
    expect(row.trigger_kind).toBe('user');
  });

  it('an update is timed by its OWN instant, not the original message time', () => {
    // `created_at` prefers the original CreatedTimestamp. Using it would date the close to when the
    // placeholder was posted and report every turn as instantaneous.
    const [row] = ledgerRowsFor([rec({
      event_type: 'UPDATE_CHANNEL_MESSAGE', resp_phase: 'final',
      created_at: '2026-08-15T00:00:01.000Z', last_updated_at: '2026-08-15T00:00:09.000Z',
    })]);
    expect(row.kind).toBe('final_response');
    expect(row.occurred_at).toBe('2026-08-15T00:00:09.000Z');
  });

  it('strips the archival suffix so the ledger points at the real message', () => {
    // The ledger's provenance must resolve against the stream and S3, where no `-UPD` id exists.
    const [row] = ledgerRowsFor([rec({ event_type: 'UPDATE_CHANNEL_MESSAGE', message_id: 'm-1-UPD', resp_phase: 'final', last_updated_at: '2026-08-15T00:00:09.000Z' })]);
    expect(row.source_message_id).toBe('m-1');
  });

  it('records redactions and deletions without treating them as answers', () => {
    const rows = ledgerRowsFor([
      rec({ event_type: 'REDACT_CHANNEL_MESSAGE', message_id: 'm-1-RED', last_updated_at: '2026-08-15T00:01:00.000Z' }),
      rec({ event_type: 'DELETE_CHANNEL_MESSAGE', message_id: 'm-1-DEL', last_updated_at: '2026-08-15T00:02:00.000Z' }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['content_redacted', 'message_deleted']);
  });
});

describe('what it refuses to record', () => {
  it('drops a row with no instant rather than inventing one', () => {
    // A wrong timestamp in a ledger whose entire purpose is timing is worse than a missing row.
    expect(ledgerRowsFor([rec({ created_at: '' })])).toEqual([]);
  });

  it('stores no message content', () => {
    // Stated design constraint, enforced here rather than assumed: the ledger holds ids, timestamps,
    // kinds and provenance. A redaction then needs no ledger mutation, so the erasure path does not
    // grow a second place to get wrong.
    const [row] = ledgerRowsFor([rec({ content: 'the VP of Engineering is Priya Patel<!--corr:t-1-->' })]);
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain('Priya');
    expect(serialised).not.toContain('VP of Engineering');
    // The turn id IS derived from content, but only the id is kept.
    expect(row.turn_id).toBe('t-1');
  });

  it('does not guess a trigger it cannot know', () => {
    // The backfill derives `trigger_kind` from whether an exchange paired - a join this path cannot do,
    // because the pairing has not happened when the placeholder is archived. A guess here would be a
    // second, disagreeing source for the fact that decides whether a TTFF is meaningful.
    const [row] = ledgerRowsFor([rec()]);
    expect(row.trigger_kind).toBeNull();
  });
});

describe('the turn id', () => {
  it('is read from the correlation marker, or absent', () => {
    expect(declaredTurnId('hi<!--corr:abc-123_x-->')).toBe('abc-123_x');
    expect(declaredTurnId('no marker here')).toBeNull();
    expect(declaredTurnId(null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE READERS. A ledger with no reader is the same inertness one step along, so the two queryTypes
// that expose it are pinned here: they must be REGISTERED (an unregistered type returns `unsupported`
// and the dashboard banners "not available in Aurora mode"), and task resolution must stay OUT of the
// latency population.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('the ledger has readers', () => {
  const mockDbQuery = jest.fn();
  let handler: any;

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../../lambda/src/analytics-aurora/db-client', () => ({
      query: mockDbQuery, ensureSchema: jest.fn().mockResolvedValue(undefined), getClient: jest.fn(),
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    handler = require('../../lambda/src/analytics-aurora/analytics-query').handler;
  });

  const post = (body: unknown) => ({
    httpMethod: 'POST', path: '/query', body: JSON.stringify(body),
    requestContext: { authorizer: { claims: { sub: 'admin', 'cognito:groups': 'admins' } } },
  } as any);

  beforeEach(() => { mockDbQuery.mockReset(); mockDbQuery.mockResolvedValue({ rows: [] }); });

  it('serves turn_latency_audit natively rather than reporting it unsupported', async () => {
    const res = await handler(post({ queryType: 'turn_latency_audit', channelArn: CHANNEL }));
    const body = JSON.parse(res.body);
    expect(body.unsupported).toBeUndefined();
    expect(mockDbQuery.mock.calls[0][0]).toContain('FROM v_turn_latency');
    // The residuals are the reason to audit a turn at all: a negative one means compute was
    // attributed to the wrong turn.
    expect(body.columns).toEqual(expect.arrayContaining(['unattributed_ms', 'overhead_ms', 'ttff_ms', 'e2e_ms']));
  });

  it('requires a channel rather than scanning the ledger', async () => {
    const res = await handler(post({ queryType: 'turn_latency_audit' }));
    expect(JSON.parse(res.body).data).toEqual([]);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('serves task_resolution, and keeps it out of the latency population', async () => {
    const res = await handler(post({ queryType: 'task_resolution' }));
    const body = JSON.parse(res.body);
    expect(mockDbQuery.mock.calls[0][0]).toContain('FROM v_task_resolution');
    // resolve_ms decomposes into agent_ms plus human think time. Mixing it into latency would either
    // flatter the turn numbers or damn the workflow.
    expect(body.columns).toEqual(expect.arrayContaining(['resolve_ms', 'agent_ms', 'is_resolved']));
    expect(body.columns).not.toContain('avg_ttff_ms');
  });
});
