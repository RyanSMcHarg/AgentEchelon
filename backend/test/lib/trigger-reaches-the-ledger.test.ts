/**
 * What caused a turn reaches the measurement (tracker row 50, the `trigger` wiring).
 *
 * `TurnRequest.trigger` was declared, written into a request attribute, and read by NOTHING. Its own
 * doc comment claimed it kept battle rebuttals out of the TTFF average - and that exclusion was real
 * but STRUCTURAL: a rebuttal pairs to no user message, so it never entered the average anyway. The
 * field was carrying a claim it did not implement, which is the same shape as a view with no writer.
 *
 * Wiring it matters for the case the structural accident does not cover: a REPAIRED turn, re-driven
 * by the platform after a failure. It pairs like a user turn and would be measured as one very slow
 * answer, because "how long did this take" means something different when nobody is waiting.
 *
 * These tests pin the two ends that made it inert - the analytics record carries what the producer
 * declared, and the ledger records it rather than inferring it - and, deliberately, that an absent
 * declaration changes nothing.
 */
import { buildAnalyticsMetadata } from '../../lambda/src/lib/analytics-metadata';
import { ledgerRowsFor, type LedgerSourceRecord } from '../../lambda/src/analytics-aurora/turn-events-live';

const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/default';

const placeholder = (over: Partial<LedgerSourceRecord> = {}): LedgerSourceRecord => ({
  event_type: 'CREATE_CHANNEL_MESSAGE',
  message_id: 'm1',
  channel_arn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c',
  sender_arn: BOT,
  is_bot: true,
  created_at: '2026-08-17T10:00:00.000Z',
  last_updated_at: null,
  resp_phase: null,
  content: 'One moment... <!--corr:abc123def4567890-->',
  task_id: null,
  task_state: null,
  ...over,
});

describe('the analytics record carries what the producer declared', () => {
  it('keeps an orchestrator trigger', () => {
    const md = buildAnalyticsMetadata({
      messageNumber: 2,
      userType: 'premium',
      role: 'assistant',
      trigger: 'orchestrator',
    });
    expect(md.trigger).toBe('orchestrator');
  });

  it('omits it entirely when nothing declared one - it is never defaulted here', () => {
    // A default invented at the carrier layer is indistinguishable from a declaration, and the whole
    // value of this field is that it was DECLARED by the path that knows.
    const md = buildAnalyticsMetadata({ messageNumber: 1, userType: 'standard', role: 'assistant' });
    expect(md.trigger).toBeUndefined();
  });
});

describe('the ledger records the declared cause rather than inferring it', () => {
  it('stamps trigger_kind on the placeholder row - the row a TTFF is measured from', () => {
    const rows = ledgerRowsFor([placeholder({ trigger_kind: 'orchestrator' })]);
    const ph = rows.find((r) => r.kind === 'placeholder_posted');
    expect(ph?.trigger_kind).toBe('orchestrator');
  });

  it('leaves it null when the producer declared nothing, exactly as before', () => {
    // The backfill derives it from whether an exchange paired - a join this path cannot do, because
    // pairing has not happened when the placeholder is archived. Absent a declaration, that inference
    // is still the answer, so this path must not invent one.
    const rows = ledgerRowsFor([placeholder()]);
    const ph = rows.find((r) => r.kind === 'placeholder_posted');
    expect(ph?.trigger_kind).toBeNull();
  });

  it('a user message is still trigger_kind user, whatever a bot declared', () => {
    const rows = ledgerRowsFor([placeholder({
      is_bot: false,
      sender_arn: 'arn:aws:chime:us-east-1:1:app-instance/i/user/u1',
      content: 'what is the rollback plan?',
      trigger_kind: 'orchestrator',
    })]);
    const um = rows.find((r) => r.kind === 'user_message');
    // A person typed it. That is not something a declaration gets to override.
    expect(um?.trigger_kind).toBe('user');
  });
});
