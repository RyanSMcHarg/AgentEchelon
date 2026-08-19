/**
 * ONE TURN, AUDITED AGAINST THE LEDGER (LATENCY-TARGETS).
 *
 * Everything else on the Latency tab is an aggregate, and AN AGGREGATE CANNOT BE AUDITED. If the
 * average TTFF looks wrong, or a band flips a health indicator, the only useful next question is
 * "show me the turns and how each number was reached" - and until this view existed the ledger that
 * can answer it had no reader in the console at all. That is the whole reason the ledger was built,
 * so shipping it without this leaves the work invisible to the person it was for.
 *
 * WHAT AN OPERATOR IS MEANT TO DO HERE. Take a conversation, list its turns, and reconcile: the
 * instants (t0 user message, t2 placeholder, t3 final) are what the message stream shows, and the
 * durations are arithmetic over them. If the arithmetic disagrees with the stream, the ledger is
 * wrong; if it agrees and the aggregate still looks wrong, the aggregate's population is wrong.
 *
 * THE RESIDUALS ARE THE POINT OF INTEREST, not the headline durations. `unattributed_ms` is what the
 * turn's own steps could not account for, and a NEGATIVE value means compute was attributed to the
 * wrong turn - the defect class this design exists to expose. It is surfaced, never judged: this view
 * states what was measured and leaves the verdict to the person reading it.
 *
 * SCOPED TO A CHANNEL, deliberately, because the backend query is: an unbounded read of the ledger is
 * a table scan, and the auditing workflow always begins from a conversation someone is already
 * looking at.
 */
import { useCallback, useEffect, useState } from 'react';
import DataTable from './DataTable';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange, AnalyticsResult } from '@ae/shared';

interface Props {
  /** The tab's range. The ledger read is scoped by channel, not by date; passed for API shape. */
  dateRange: AnalyticsDateRange;
  /** Prefilled when the operator arrived from a conversation; otherwise they paste one. */
  initialChannelArn?: string;
}

/** A turn row as `v_turn_latency` returns it. Every field is nullable: an unclosed turn has no t3. */
interface AuditRow extends Record<string, unknown> {
  turn_id: string | null;
  response_id: string | null;
  turn_id_source: string | null;
  trigger_kind: string | null;
  battle_round: number | null;
  responder: string | null;
  t0_user_at: string | null;
  t2_placeholder_at: string | null;
  t3_final_at: string | null;
  ttff_ms: number | null;
  e2e_ms: number | null;
  answer_ms: number | null;
  unattributed_ms: number | null;
  overhead_ms: number | null;
  status: string | null;
  progress_update_count: number | null;
  task_id: string | null;
}

const fmtMs = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}ms` : '—';

const fmtAt = (v: unknown): string =>
  typeof v === 'string' && v ? new Date(v).toISOString().replace('T', ' ').slice(0, 23) : '—';

export function TurnLatencyAudit({ dateRange, initialChannelArn }: Props) {
  const [channelArn, setChannelArn] = useState(initialChannelArn ?? '');
  const [submitted, setSubmitted] = useState(initialChannelArn ?? '');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);

  const load = useCallback(async (arn: string, range: AnalyticsDateRange) => {
    if (!arn.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res: AnalyticsResult = await queryAnalytics('turn_latency_audit', range, {
        channelArn: arn.trim(),
        limit: '50',
      });
      // The backend answers a missing/unusable channel with an `error` INSIDE the payload rather than
      // by failing, so an empty table never has to stand in for "you did not give me enough to look at".
      const payloadError = (res as unknown as { error?: string }).error;
      if (payloadError) setError(payloadError);
      setRows(((res.data ?? []) as unknown as AuditRow[]));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The audit query failed.');
      setRows([]);
    } finally {
      setLoading(false);
      setRan(true);
    }
  }, []);

  useEffect(() => {
    if (submitted) void load(submitted, dateRange);
  }, [submitted, dateRange, load]);

  return (
    <section className="turn-latency-audit" aria-label="Audit one turn">
      <h3>Audit a turn</h3>
      <p className="admin-help-text">
        The calculation behind the averages, one row per turn, so a number can be checked against the
        message stream rather than trusted. A negative <code>unattributed_ms</code> means compute was
        attributed to the wrong turn.
      </p>

      <form
        className="turn-latency-audit-form"
        onSubmit={(e) => { e.preventDefault(); setSubmitted(channelArn); }}
      >
        <label htmlFor="audit-channel-arn">Conversation ARN</label>
        <input
          id="audit-channel-arn"
          type="text"
          value={channelArn}
          placeholder="arn:aws:chime:...:app-instance/.../channel/..."
          onChange={(e) => setChannelArn(e.target.value)}
        />
        <button type="submit" disabled={!channelArn.trim() || loading}>
          {loading ? 'Reading the ledger…' : 'Audit'}
        </button>
      </form>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {!error && ran && !loading && rows.length === 0 && (
        // An empty ledger for a real conversation is a finding, not a blank state: the turns happened,
        // so their absence here means the archival path did not record them.
        <p className="admin-help-text">
          No ledger rows for this conversation. Turns are recorded from the archival batch, so this is
          empty either because the conversation has no turns yet or because they were not archived.
        </p>
      )}

      {rows.length > 0 && (
        <>
          <DataTable<AuditRow>
            columns={[
              { key: 'turn_id', label: 'Turn' },
              { key: 'responder', label: 'Responder' },
              { key: 'trigger_kind', label: 'Trigger' },
              { key: 't0_user_at', label: 'User at', render: (v) => fmtAt(v) },
              { key: 't2_placeholder_at', label: 'Placeholder at', render: (v) => fmtAt(v) },
              { key: 't3_final_at', label: 'Final at', render: (v) => fmtAt(v) },
              { key: 'ttff_ms', label: 'TTFF', render: (v) => fmtMs(v) },
              { key: 'e2e_ms', label: 'End to end', render: (v) => fmtMs(v) },
              { key: 'answer_ms', label: 'Answer', render: (v) => fmtMs(v) },
              {
                key: 'unattributed_ms',
                label: 'Unattributed',
                render: (v) => (
                  <span className={typeof v === 'number' && v < 0 ? 'status-bad' : undefined}>
                    {fmtMs(v)}
                  </span>
                ),
              },
              { key: 'status', label: 'Status' },
            ]}
            data={rows}
          />
          <p className="admin-help-text">
            Showing {rows.length} turn{rows.length === 1 ? '' : 's'}, newest first, capped at 50. An
            unclosed turn has no final instant and therefore no end-to-end figure — that is a recorded
            state, not a gap in the measurement.
          </p>
        </>
      )}
    </section>
  );
}

export default TurnLatencyAudit;
