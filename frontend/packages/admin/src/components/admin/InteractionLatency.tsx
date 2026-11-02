/**
 * LATENCY PER KIND OF INTERACTION (LATENCY-TARGETS.md G13).
 *
 * WHY THIS IS NOT ANOTHER ROW ON THE MAIN TABLE. A person waiting on a reply, a rebuttal answering a
 * rival, and a turn re-driven after nobody routed it are three different questions. Averaged into one
 * headline the answer describes none of them: a duel-heavy day drags the number toward turns nobody
 * was waiting for, and a quiet day hides a repair backlog inside a healthy-looking mean.
 *
 * ACK IS THE COLUMN THAT SPANS THEM ALL. Time-to-first-feedback is blank for anything nobody asked
 * for - correctly, since no one was waiting - so a table showing only TTFF renders every proactive
 * interaction as a dash and reads as "unmeasured" rather than "measured differently". Ack is shown
 * first for that reason, with TTFF beside it: on the kinds where a person IS waiting the two agree,
 * and a divergence between them is itself a finding.
 *
 * THE ANCHOR MIX IS PART OF THE READING, not a footnote. A row whose latency is mostly DERIVED is a
 * weaker measurement than one that is mostly DECLARED, and presenting them with equal confidence is
 * how a reconstruction quietly becomes a fact.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import { InfoTooltip } from './AdminHelp';
import { queryAnalytics } from '../../services/analyticsService';
import type { AnalyticsDateRange, AnalyticsResult } from '@ae/shared';

interface Props {
  dateRange: AnalyticsDateRange;
}

interface InteractionRow extends Record<string, unknown> {
  interaction: string;
  turn_count: number | string;
  measured_count: number | string;
  avg_ack_ms: number | string | null;
  p95_ack_ms: number | string | null;
  avg_ttff_ms: number | string | null;
  avg_e2e_ms: number | string | null;
  avg_total_ms: number | string | null;
  declared_count: number | string;
  derived_count: number | string;
  unanchored_count: number | string;
}

/**
 * What each interaction IS, in the operator's terms - now `admin.interactionLatency.help.*` in en.json.
 *
 * THE FALLBACK IS THE SECOND KEY rather than an `??` at the call site: i18next resolves an array of
 * keys to the first that exists, so an unknown interaction lands on `help.fallback` through the same
 * lookup instead of a branch somebody has to remember.
 *
 * The handover entry names BOTH producers deliberately. A task handover and a roommate delegation write
 * the same `trigger_kind`, so this row merges them; describing only one is what made this copy wrong
 * about half its rows when the second producer shipped.
 */
const interactionHelpKeys = (kind: string): string[] => [
  `admin.interactionLatency.help.${kind}`,
  'admin.interactionLatency.help.fallback',
];

const fmtMs = (v: unknown): string => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
};

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

const humanize = (s: string): string => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/**
 * The row's name: `admin.interactionLatency.label.<kind>` where one exists, else the kind humanized.
 * A rebuttal is labeled as battle round 2, because that is what an operator reading a duel calls it and
 * its End to end is that round's own, measured from the instant round two was triggered.
 */
const interactionLabelKey = (kind: string): string => `admin.interactionLatency.label.${kind}`;

export function InteractionLatency({ dateRange }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<InteractionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (range: AnalyticsDateRange) => {
    setLoading(true);
    setError(null);
    try {
      const res: AnalyticsResult = await queryAnalytics('latency_by_interaction', range);
      setRows(((res.data ?? []) as unknown as InteractionRow[]));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.interactionLatency.loadFailed'));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(dateRange); }, [dateRange, load]);

  return (
    <section className="admin-section" aria-label={t('admin.interactionLatency.aria.panel')}>
      <div className="admin-tab-banner-label" style={{ marginBottom: 'var(--space-1)' }}>
        <span className="admin-tab-banner-label-text">{t('admin.interactionLatency.title')}</span>
        <InfoTooltip
          label={t('admin.interactionLatency.about.label')}
          content={t('admin.interactionLatency.about.body')}
        />
      </div>

      {/* ── THIS PANEL IS OVER EVERY TURN, AND THE HEADLINE IS NOT ──────────
          Reported as TTFF reading 2.0s in the headline and 2.3s here. Both were right: the cards
          above exclude multi-step task turns by default and honour the tier, assistant, role and
          version pills, while this reads the turn ledger over the whole window. Two populations, one
          metric name, and nothing saying so - which is the same fault the cost column was corrected
          for twice.

          SAID RATHER THAN FIXED, for now. The ledger view carries no assistant or tier dimension, so
          narrowing this the same way needs those columns joined through it; until then the honest
          move is to name the population rather than let a reader assume it matches. */}
      <p className="admin-tab-description" role="note">
        {t('admin.interactionLatency.population')}
      </p>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {!error && !loading && rows.length === 0 && (
        <p className="admin-help-text">{t('admin.interactionLatency.empty')}</p>
      )}

      {rows.length > 0 && (
        <>
          <DataTable<InteractionRow>
            columns={[
              {
                key: 'interaction',
                label: t('admin.interactionLatency.columns.interaction'),
                render: (v) => {
                  const key = String(v);
                  return (
                    <span title={t(interactionHelpKeys(key))}>
                      {t(interactionLabelKey(key), { defaultValue: humanize(key) })}
                    </span>
                  );
                },
              },
              { key: 'turn_count', label: t('admin.interactionLatency.columns.turns') },
              {
                key: 'avg_ack_ms',
                label: t('admin.interactionLatency.columns.ack'),
                render: (v, row) => (
                  <span title={t('admin.interactionLatency.cell.ackTitle', { measured: num(row.measured_count), total: num(row.turn_count) })}>
                    {fmtMs(v)}
                  </span>
                ),
              },
              { key: 'p95_ack_ms', label: t('admin.interactionLatency.columns.p95Ack'), render: (v) => fmtMs(v) },
              {
                key: 'avg_ttff_ms',
                label: t('admin.interactionLatency.columns.ttff'),
                // A dash here is CORRECT for a proactive kind, so the tooltip says so rather than
                // leaving it to read as missing data.
                render: (v, row) => (
                  <span title={num(v) > 0
                    ? t('admin.interactionLatency.cell.ttffWaiting')
                    : t('admin.interactionLatency.cell.ttffBlank', { interaction: humanize(String(row.interaction)).toLowerCase() })}>
                    {fmtMs(v)}
                  </span>
                ),
              },
              { key: 'avg_e2e_ms', label: t('admin.interactionLatency.columns.e2e'), render: (v) => fmtMs(v) },
              { key: 'avg_total_ms', label: t('admin.interactionLatency.columns.worker'), render: (v) => fmtMs(v) },
              {
                key: 'declared_count',
                label: t('admin.interactionLatency.columns.anchor'),
                // THREE NUMBERS IN ONE CELL, deliberately: they are one fact - how this row's latency
                // was obtained - and splitting them into three columns invites reading each alone.
                render: (_v, row) => {
                  const declared = num(row.declared_count);
                  const derived = num(row.derived_count);
                  const none = num(row.unanchored_count);
                  return (
                    <span title={t('admin.interactionLatency.cell.anchorTitle')}>
                      {declared > 0 && <span>{t('admin.interactionLatency.cell.declared', { count: declared })}</span>}
                      {derived > 0 && <span className="status-warn">{declared > 0 ? ', ' : ''}{t('admin.interactionLatency.cell.derived', { count: derived })}</span>}
                      {none > 0 && <span className="status-bad">{(declared > 0 || derived > 0) ? ', ' : ''}{t('admin.interactionLatency.cell.none', { count: none })}</span>}
                      {declared + derived + none === 0 && '—'}
                    </span>
                  );
                },
              },
            ]}
            data={rows}
          />
          <p className="admin-help-text">{t('admin.interactionLatency.anchorNote')}</p>
        </>
      )}
    </section>
  );
}

export default InteractionLatency;

interface ClientServerRow extends Record<string, unknown> {
  correlation_id: string;
  client_ttff_ms: number | string | null;
  server_ttff_ms: number | string | null;
  delivery_gap_ms: number | string | null;
  channel_arn: string;
  created_at: string;
}

/**
 * ONE TURN, BOTH CLOCKS (G5).
 *
 * The aggregate comparison on the cards above narrows a slow reply to a population. This narrows it
 * to a turn: the browser's own wait beside the server's, joined by the correlation marker that both
 * sides hold. The difference is WebSocket delivery plus render - the part of the perceived wait
 * neither side could attribute alone.
 *
 * A NEGATIVE gap is shown, not clamped. It means the two clocks disagree or the client timed from a
 * send the server paired to a different turn, and both are findings.
 */
export function ClientServerLatency({ dateRange }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ClientServerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (range: AnalyticsDateRange) => {
    setLoading(true);
    setError(null);
    try {
      const res: AnalyticsResult = await queryAnalytics('client_server_latency', range);
      setRows(((res.data ?? []) as unknown as ClientServerRow[]));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.interactionLatency.theClientServerJoinFailed'));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(dateRange); }, [dateRange, load]);

  return (
    <section className="admin-section" aria-label={t('admin.interactionLatency.aria.joinPanel')}>
      <div className="admin-tab-banner-label" style={{ marginBottom: 'var(--space-1)' }}>
        <span className="admin-tab-banner-label-text">{t('admin.interactionLatency.joinTitle')}</span>
        <InfoTooltip
          label={t('admin.interactionLatency.join.label')}
          content={t('admin.interactionLatency.join.body')}
        />
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}

      {!error && !loading && rows.length === 0 && (
        <p className="admin-help-text">
          {t('admin.interactionLatency.noCorrelatedTurnsInThis')}
        </p>
      )}

      {rows.length > 0 && (
        <DataTable<ClientServerRow>
          columns={[
            { key: 'created_at', label: 'When', render: (v) => (typeof v === 'string' ? v.replace('T', ' ').slice(0, 19) : '—') },
            { key: 'client_ttff_ms', label: 'Browser', render: (v) => fmtMs(v) },
            { key: 'server_ttff_ms', label: 'Server', render: (v) => fmtMs(v) },
            {
              key: 'delivery_gap_ms',
              label: 'Delivery + render',
              render: (v) => {
                const n = Number(v);
                if (!Number.isFinite(n)) return '—';
                // Negative is deliberately NOT clamped: it is the disagreement, which is the finding.
                return (
                  <span className={n < 0 ? 'status-bad' : undefined}>
                    {n < 0 ? '-' : ''}{fmtMs(Math.abs(n))}
                  </span>
                );
              },
            },
            { key: 'correlation_id', label: 'Turn' },
          ]}
          data={rows}
        />
      )}
    </section>
  );
}
