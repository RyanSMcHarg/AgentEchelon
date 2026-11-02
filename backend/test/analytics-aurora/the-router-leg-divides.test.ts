/**
 * THE ROUTER LEG DIVIDES, AND THE LEDGER IS WHERE IT DIVIDES.
 *
 * `router_ms` sits in front of the placeholder, so all of it is inside TTFF, and it broke down
 * exactly once: `classifier_ms` out, everything else as one derived residual covering the channel
 * reads, the SSM reads, the task lookup, the drift check, the ADR-033 claim and the grounding fetch
 * together. When that residual moved by 865 ms the finest statement the data supported was "the
 * router got slower", and a fix measured against a number that cannot be decomposed cannot be shown
 * to have worked.
 *
 * The boundaries are INSTANTS, written as ledger rows, with the durations derived at read
 * (LATENCY-TARGETS G12). What is asserted here is the writer's half of that: the instants arrive as
 * rows a reader can subtract, they say honestly which clock they are on, and a payload that has been
 * mangled crossing a Lambda boundary does not become a row nothing can interpret.
 */
import { ledgerRowsFor } from '../../lambda/src/analytics-aurora/turn-events-live';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/premium';
const HUMAN = 'arn:aws:chime:us-east-1:111:app-instance/i/user/alice';

const T0 = Date.parse('2026-09-08T00:00:01.000Z');

const rec = (over: Record<string, unknown> = {}) => ({
  event_type: 'CREATE_CHANNEL_MESSAGE',
  message_id: 'm-1',
  channel_arn: CHANNEL,
  sender_arn: BOT,
  is_bot: true,
  created_at: '2026-09-08T00:00:01.000Z',
  last_updated_at: null,
  resp_phase: null,
  content: 'One moment<!--corr:turn-abc-->',
  task_id: null,
  task_state: null,
  router_steps: [
    { step: 'entry', at: T0 },
    { step: 'channel_resolved', at: T0 + 140 },
    { step: 'classified', at: T0 + 610 },
    { step: 'turn_claimed', at: T0 + 900 },
    { step: 'dispatched', at: T0 + 1035 },
  ],
  ...over,
} as any);

const stepRows = (over: Record<string, unknown> = {}) =>
  ledgerRowsFor([rec(over)]).filter((r) => r.kind === 'router_step');

describe('the boundaries reach the ledger as instants', () => {
  it('writes one row per boundary, naming which one it is', () => {
    expect(stepRows().map((r) => r.step_name))
      .toEqual(['entry', 'channel_resolved', 'classified', 'turn_claimed', 'dispatched']);
  });

  it('the instants are the ones the router took, so the deltas are the durations', () => {
    const at = stepRows().map((r) => Date.parse(r.occurred_at));
    // Derived at read, exactly as v_router_steps does it: this instant less the previous one.
    const deltas = at.slice(1).map((t, i) => t - at[i]);
    expect(deltas).toEqual([140, 470, 290, 135]);
    // And the whole log spans what routerMs reports for the same turn.
    expect(at[at.length - 1] - at[0]).toBe(1035);
  });

  it('attaches them to the response whose wait they are part of', () => {
    // Same response_id and turn_id as the placeholder_posted row from the same record, which is what
    // lets a reader put the breakdown beside that turn's TTFF.
    const all = ledgerRowsFor([rec()]);
    const placeholder = all.find((r) => r.kind === 'placeholder_posted')!;
    for (const row of stepRows()) {
      expect(row.response_id).toBe(placeholder.response_id);
      expect(row.turn_id).toBe(placeholder.turn_id);
    }
  });

  it('the answer update carries them too, because which event archives first is a race', () => {
    // The analytics record is written when the PROCESSOR finishes, so the CREATE may be archived
    // before it exists. Both are admitted and the database arbitrates, exactly as the task kinds do.
    const rows = stepRows({
      event_type: 'UPDATE_CHANNEL_MESSAGE',
      message_id: 'm-1-UPD',
      last_updated_at: '2026-09-08T00:00:09.000Z',
      resp_phase: 'final',
    });
    expect(rows.map((r) => r.step_name)).toContain('turn_claimed');
    // Attached to the same response the CREATE's rows would be, so whichever wins is right.
    expect(rows.every((r) => r.response_id === 'm-1')).toBe(true);
  });

  it('says on every row that it is server-clock and unprovable against the stream', () => {
    // The instants were taken inside the router and never appeared in the message stream. A row that
    // did not say so would let a dashboard imply these are auditable the way the outer bracket is.
    for (const row of stepRows()) {
      expect(row.clock).toBe('server');
      expect(row.auditable).toBe(false);
    }
  });
});

describe('a turn that recorded nothing writes nothing', () => {
  it('no steps on the record means no step rows', () => {
    expect(stepRows({ router_steps: null })).toEqual([]);
    expect(stepRows({ router_steps: undefined })).toEqual([]);
    expect(stepRows({ router_steps: [] })).toEqual([]);
  });

  it('a mangled payload is discarded rather than written as an uninterpretable row', () => {
    // The log crosses a Lambda boundary as JSON before it reaches an append-only table.
    expect(stepRows({ router_steps: 'entry,dispatched' })).toEqual([]);
    expect(stepRows({ router_steps: [{ step: 'entry', at: 'soon' }] })).toEqual([]);
  });

  it('keeps the marks it understands and drops only the ones it does not', () => {
    const rows = stepRows({
      router_steps: [
        { step: 'entry', at: T0 },
        { step: 'a_step_from_a_newer_router', at: T0 + 10 },
        { step: 'dispatched', at: T0 + 20 },
      ],
    });
    expect(rows.map((r) => r.step_name)).toEqual(['entry', 'dispatched']);
  });

  it('a redaction carries no steps, even though it carries the same blob', () => {
    // The blob is merged onto every event of a bot message, redactions included. A redaction measured
    // nothing and its content is stripped, so it declares no turn - and if it were admitted and
    // happened to archive first, it would file the whole breakdown under a null turn id and lock the
    // real rows out of the per-(message, step) dedup.
    expect(stepRows({ event_type: 'REDACT_CHANNEL_MESSAGE', message_id: 'm-1-RED', content: null })).toEqual([]);
    expect(stepRows({ event_type: 'DELETE_CHANNEL_MESSAGE', message_id: 'm-1-DEL', content: null })).toEqual([]);
  });

  it('a bot post with no marker carries none, so no response is invented for the ledger', () => {
    // THE BROADCAST RESUME. The analytics record is keyed on `deliveryMessageId`, which on that path
    // is a message the processor posts itself with the content '...' - no correlation marker. Its
    // CREATE archives as a continuation_chunk with a NULL response_id, so step rows carrying one
    // would be the ONLY rows for that response.
    //
    // Both v_turn_latency and the unclosed split group turn_events by response_id, so that group
    // becomes a turn with no placeholder, no final and no progress update: 'unresolved' in the view
    // and 'silent' in the split - the bucket that means an answer went missing. The steps still land,
    // on the UPDATE that carries the answer.
    expect(stepRows({ content: '...' })).toEqual([]);
  });

  it('never leaves a response whose only rows are steps', () => {
    // The invariant behind the cases above, asserted directly rather than only through them: a step
    // row's response_id is always shared with a row that establishes the response.
    const cases = [
      {},
      { content: '...' },
      { is_bot: false, sender_arn: HUMAN },
      { event_type: 'UPDATE_CHANNEL_MESSAGE', message_id: 'm-1-UPD', last_updated_at: '2026-09-08T00:00:09.000Z', resp_phase: 'final' },
      { event_type: 'REDACT_CHANNEL_MESSAGE', message_id: 'm-1-RED', content: null },
    ];
    for (const over of cases) {
      const all = ledgerRowsFor([rec(over)]);
      const establishing = new Set(
        all.filter((r) => r.kind !== 'router_step' && r.response_id).map((r) => r.response_id),
      );
      for (const step of all.filter((r) => r.kind === 'router_step')) {
        expect(establishing.has(step.response_id)).toBe(true);
      }
    }
  });

  it('a person\'s own message carries no router steps, whatever the blob says', () => {
    // The blob is merged onto bot messages. A step row hung off a user message would give the turn
    // anchor a response-shaped breakdown it has no business having.
    expect(stepRows({ is_bot: false, sender_arn: HUMAN, content: 'do the thing' })).toEqual([]);
  });
});
