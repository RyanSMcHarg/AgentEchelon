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
import { Trans, useTranslation } from 'react-i18next';
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
  /** Which source supplied the turn anchor: 'ledger' (recorded) | 'exchange' (paired) | null. */
  anchor_source: string | null;
  trigger_kind: string | null;
  battle_round: number | null;
  responder: string | null;
  t0_user_at: string | null;
  t2_placeholder_at: string | null;
  t3_final_at: string | null;
  ttff_ms: number | null;
  /** Trigger -> first signal, for EVERY response. Equals ttff_ms on a user turn by construction. */
  ack_ms: number | null;
  /** 'declared' (a real user message) | 'derived' (the rule found the cause) | null (nothing did). */
  ack_source: string | null;
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
  const { t } = useTranslation();
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
      setError(e instanceof Error ? e.message : t('admin.turnLatencyAudit.theAuditQueryFailed'));
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
    <section className="turn-latency-audit" aria-label={t('admin.turnLatencyAudit.auditOneTurn')}>
      <h3>{t('admin.turnLatencyAudit.auditATurn')}</h3>
      <p className="admin-help-text">
        <Trans i18nKey="admin.turnLatencyAudit.lead" components={{ c: <code /> }} />
      </p>
      <p className="admin-help-text">
        <Trans i18nKey="admin.turnLatencyAudit.columns" components={{ b: <strong />, c: <code /> }} />
      </p>

      <form
        className="turn-latency-audit-form"
        onSubmit={(e) => { e.preventDefault(); setSubmitted(channelArn); }}
      >
        <label className="label" htmlFor="audit-channel-arn">{t('admin.turnLatencyAudit.conversationArn')}</label>
        <input
          id="audit-channel-arn"
          className="input"
          type="text"
          value={channelArn}
          placeholder={t('admin.turnLatencyAudit.arnAwsChimeAppInstance')}
          onChange={(e) => setChannelArn(e.target.value)}
        />
        <button className="btn-primary" type="submit" disabled={!channelArn.trim() || loading}>
          {loading ? t('admin.turnLatencyAudit.readingTheLedger') : 'Audit'}
        </button>
      </form>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {!error && ran && !loading && rows.length === 0 && (
        // An empty ledger for a real conversation is a finding, not a blank state: the turns happened,
        // so their absence here means the archival path did not record them.
        <p className="admin-help-text">
          {t('admin.turnLatencyAudit.noLedgerRowsForThis')}
        </p>
      )}

      {rows.length > 0 && (
        <>
          <DataTable<AuditRow>
            columns={[
              { key: 'turn_id', label: 'Turn' },
              { key: 'responder', label: 'Responder' },
              {
                key: 'trigger_kind',
                label: 'Trigger',
                // A NULL trigger is not a missing value, it is the ordinary case: only the paths that
                // are NOT a user message declare one, so an undeclared trigger means a user turn.
                render: (v) => (typeof v === 'string' && v ? v : 'user'),
              },
              {
                key: 'battle_round',
                label: 'Battle',
                // THE COLUMN WAS TYPED ON THE ROW AND NEVER RENDERED, so an operator reading this
                // audit could not tell a duel turn from an ordinary one - while the Experiments tab
                // was answering "how many battle turns" from a different fact entirely. Rendering it
                // does not reconcile the two definitions (that is a product decision), but it stops
                // this surface being unable to state which population a row belongs to.
                //
                // NULL IS THE ORDINARY TURN, not a missing value, so it reads as a dash rather than
                // as an unmeasured duel.
                render: (v) => (typeof v === 'number'
                  ? <span title={t('admin.turnLatencyAudit.roundOfABattle', { v: v })}>R{v}</span>
                  : '—'),
              },
              {
                key: 'anchor_source',
                label: 'Anchor',
                // WHY A TURN HAS NO LATENCY IS A DIFFERENT FINDING FROM BEING SLOW, and without this
                // the two are indistinguishable: a blank TTFF could mean the turn was proactive, or
                // that nothing anchored it. 'exchange' is a live turn, 'ledger' a backfilled one.
                render: (v) => (typeof v === 'string' && v
                  ? v
                  : <span className="status-warn" title={t('admin.turnLatencyAudit.nothingAnchoredThisTurnSo')}>none</span>),
              },
              { key: 't0_user_at', label: 'User at', render: (v) => fmtAt(v) },
              { key: 't2_placeholder_at', label: t('admin.latency.shadowDiff.columns.when'), render: (v) => fmtAt(v) },
              { key: 't3_final_at', label: 'Final at', render: (v) => fmtAt(v) },
              // TTFF and ACK SIT SIDE BY SIDE ON PURPOSE. On a user turn they are the same two
              // instants and read identically; on a proactive turn TTFF is blank by construction -
              // nobody was waiting - and Ack is the only latency that exists. Showing only TTFF is
              // what made a rebuttal, a welcome and a notice look unmeasured rather than differently
              // measured.
              { key: 'ttff_ms', label: 'TTFF', render: (v) => fmtMs(v) },
              {
                key: 'ack_ms',
                label: 'Ack',
                // The provenance rides the value, because a derived anchor and an observed one are
                // not the same evidence and a column of bare numbers hides which is which.
                render: (v, row) => {
                  const src = row.ack_source;
                  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
                  return (
                    <span title={src === 'derived'
                      ? t('admin.turnLatencyAudit.anchorDerivedTheMostRecent')
                      : t('admin.turnLatencyAudit.anchorDeclaredThisTurnAnswered')}>
                      {fmtMs(v)}
                      {src === 'derived' && <span className="status-warn"> ~</span>}
                    </span>
                  );
                },
              },
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
