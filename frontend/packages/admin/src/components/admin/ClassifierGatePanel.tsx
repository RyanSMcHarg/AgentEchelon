/**
 * The classification shadow gate (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §5).
 *
 * A `classification` experiment changes which model LABELS a message. Scored the ordinary way it is
 * judged on the evaluator's opinion of the ANSWER, which is a downstream shadow of the change while
 * real users are already routed by the candidate. This surface replaces that with the question
 * actually being asked: both candidates label the same archived messages, a human rules on the pairs
 * where they disagree, and McNemar runs on those.
 *
 * Two things this view refuses to do, because both would quietly manufacture confidence:
 *  - It never shows a verdict from a run that did not finish, or one whose queue is unworked.
 *  - It never asks a human to rule on a pair the models AGREED on. Those carry no comparative signal
 *    whatever the truth, and putting them in a queue is the cost this whole design avoids.
 */
import { useCallback, useEffect, useState } from 'react';
import { queryAnalytics } from '../../services/analyticsService';
import { MODEL_STRATEGY_MODELS } from '@ae/shared';
import type { AnalyticsDateRange } from '@ae/shared';

/** The gate verdicts the backend can return. */
type GateVerdict =
  | 'challenger_better'
  | 'non_inferior'
  | 'worse'
  | 'indistinguishable'
  | 'insufficient';

interface ReplayRun {
  runId: string;
  experimentId: string | null;
  incumbentModel: string;
  challengerModel: string;
  windowStart: string;
  windowEnd: string;
  messagesConsidered: number;
  messagesReplayed: number;
  messagesRetracted: number;
  messagesFastPath: number;
  status: 'running' | 'complete' | 'failed';
  error?: string | null;
}

interface GateResult {
  verdict: GateVerdict;
  rationale: string;
  marginPct: number;
  accuracyDelta: number | null;
  accuracyDeltaCi: [number, number] | null;
  summary: {
    total: number;
    concordant: number;
    discordant: number;
    adjudicated: number;
    pending: number;
    challengerOnlyRight: number;
    incumbentOnlyRight: number;
    bothWrong: number;
  };
}

interface QueueRow {
  id: string;
  exchangeId: string;
  messageId: string | null;
  incumbentLabel: string;
  challengerLabel: string;
  proposedLabel: string | null;
}

export const VERDICT_META: Record<GateVerdict, { label: string; tone: string; authorises: boolean }> = {
  challenger_better: { label: 'Challenger is better', tone: 'win', authorises: true },
  non_inferior: { label: 'Not worse (within margin)', tone: 'hold', authorises: true },
  worse: { label: 'Worse, or cannot rule out worse', tone: 'bad', authorises: false },
  indistinguishable: { label: 'Indistinguishable on this corpus', tone: 'wait', authorises: false },
  insufficient: { label: 'Not enough evidence', tone: 'wait', authorises: false },
};

/** A gate result only authorises a traffic split when the run FINISHED and its verdict clears. */
export function gateAuthorisesSplit(run: ReplayRun | null, gate: GateResult | null): boolean {
  if (!run || !gate) return false;
  if (run.status !== 'complete') return false;
  return VERDICT_META[gate.verdict]?.authorises === true;
}

/**
 * How much of the corpus the two models disagreed on.
 *
 * §5.4 uses this to SIZE the split before it runs: if they agree on 99.5% of traffic, no online
 * experiment can detect a difference and the split should not be run at all. Reported as a share of
 * the messages actually replayed, which excludes the ones no model was asked about.
 */
export function disagreementRate(gate: GateResult | null): number | null {
  if (!gate || !gate.summary.total) return null;
  return gate.summary.discordant / gate.summary.total;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const shortDate = (s: string) => (s ? new Date(s).toLocaleDateString() : '—');

/**
 * The model list, from the SAME source the experiment form uses.
 *
 * Both surfaces must offer the identical vocabulary or the console cannot tell whether a gate covers the
 * models an experiment is about. Shared rather than duplicated for that reason.
 */
const MODEL_OPTIONS = MODEL_STRATEGY_MODELS.map((m) => ({ value: m.key, label: m.displayName }));

export default function ClassifierGatePanel({ dateRange }: { dateRange: AnalyticsDateRange }) {
  const [runs, setRuns] = useState<ReplayRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ run: ReplayRun; gate: GateResult } | null>(null);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ incumbentModel: '', challengerModel: '', windowDays: '30', limit: '200' });
  const [otherLabel, setOtherLabel] = useState<Record<string, string>>({});

  const loadRuns = useCallback(async () => {
    try {
      const res = await queryAnalytics('classifier_replays', dateRange, {});
      setRuns(((res.data as unknown) as ReplayRun[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load replay runs');
    }
  }, [dateRange]);

  const loadDetail = useCallback(async (runId: string) => {
    setError(null);
    try {
      const res = (await queryAnalytics('classifier_replay', dateRange, { runId })) as unknown as {
        run: ReplayRun; gate: GateResult;
      };
      setDetail({ run: res.run, gate: res.gate });
      const q = await queryAnalytics('classifier_replay_labels', dateRange, {
        runId, pendingOnly: 'true', limit: '25',
      });
      setQueue(((q.data as unknown) as QueueRow[]) ?? []);
      setQueueTotal(Number(q.total ?? 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the replay');
    }
  }, [dateRange]);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { if (selected) loadDetail(selected); }, [selected, loadDetail]);

  /**
   * Wait for a just-started run's ROW to exist.
   *
   * The start call answers from outside the VPC and cannot write to the database; the batch Lambda
   * inside the VPC opens the row a moment later under the id the start returned. So there is a short
   * window where the id is real and the row is not. Selecting immediately would read that window as
   * "No such replay run" and report a failure for a replay that is starting normally.
   *
   * Returns false if it never appears, which is the honest signal that the run did not open at all —
   * the caller says so rather than leaving a selected id with no run behind it.
   */
  const waitForRun = useCallback(async (runId: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const res = (await queryAnalytics('classifier_replay', dateRange, { runId })) as unknown as {
          run?: ReplayRun;
        };
        if (res?.run?.runId) return true;
      } catch {
        // A 404 here means "not yet", which is the expected state for the first second or two.
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }, [dateRange]);

  async function startReplay() {
    setBusy(true);
    setError(null);
    try {
      const res = (await queryAnalytics('classifier_replay_start', dateRange, {
        incumbentModel: form.incumbentModel.trim(),
        challengerModel: form.challengerModel.trim(),
        windowDays: form.windowDays,
        limit: form.limit,
      })) as unknown as { run: ReplayRun };
      const runId = res?.run?.runId;
      if (!runId) {
        setError('The replay was accepted but no run id came back');
        return;
      }
      const opened = await waitForRun(runId);
      await loadRuns();
      if (opened) {
        setSelected(runId);
      } else {
        setError(
          'The replay was accepted but its run never opened. Nothing was replayed — check the ' +
            'replay function’s logs before reading any earlier run as current.',
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the replay');
    } finally {
      setBusy(false);
    }
  }

  async function adjudicate(labelId: string, trueLabel: string) {
    if (!trueLabel.trim() || !selected) return;
    setBusy(true);
    try {
      await queryAnalytics('classifier_replay_adjudicate', dateRange, { labelId, trueLabel: trueLabel.trim() });
      await loadDetail(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record the ruling');
    } finally {
      setBusy(false);
    }
  }

  const gate = detail?.gate ?? null;
  const run = detail?.run ?? null;
  const meta = gate ? VERDICT_META[gate.verdict] : null;
  const disagreement = disagreementRate(gate);

  return (
    <div className="admin-section cgate">
      <h4>Classifier accuracy gate</h4>
      <p className="admin-tab-description">
        Replays archived messages through two classifier candidates and compares them on the pairs
        where they disagree. No user is exposed: nothing here runs on a live turn. A passing gate
        authorises an online split; it does not replace one.
      </p>

      {error && <div className="admin-error"><span>{error}</span></div>}

      <div className="cgate-start">
        {/*
          CATALOG KEYS, chosen rather than typed.
          These were free-text "model id" fields, and that made the gate unusable for the thing it
          gates. A run only succeeded if the operator typed a real Bedrock model id, while the
          experiment form next to it holds a catalog KEY ('sonnet'); the console compared the two and
          never found a match, so the gate block never cleared and every classification experiment was
          refused. Selecting from the same list the experiment uses makes them comparable by
          construction, and makes an out-of-catalog model unselectable instead of a run that
          AccessDenies at the model call.
        */}
        <select
          aria-label="Incumbent model"
          value={form.incumbentModel}
          onChange={(e) => setForm({ ...form, incumbentModel: e.target.value })}
        >
          <option value="">incumbent model…</option>
          {MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          aria-label="Challenger model"
          value={form.challengerModel}
          onChange={(e) => setForm({ ...form, challengerModel: e.target.value })}
        >
          <option value="">challenger model…</option>
          {MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input
          aria-label="Window (days)"
          type="number"
          value={form.windowDays}
          onChange={(e) => setForm({ ...form, windowDays: e.target.value })}
        />
        <input
          aria-label="Messages"
          type="number"
          value={form.limit}
          onChange={(e) => setForm({ ...form, limit: e.target.value })}
        />
        <button
          className="admin-inline-btn"
          disabled={busy || !form.incumbentModel.trim() || !form.challengerModel.trim()}
          onClick={startReplay}
        >
          Run replay
        </button>
      </div>

      {runs.length === 0 ? (
        <p className="admin-tab-description">
          No replay has been run. A classification experiment measured without one is judged on the
          answer rather than on the labelling it actually changed.
        </p>
      ) : (
        <ul className="cgate-runs">
          {runs.map((r) => (
            <li key={r.runId}>
              <button
                className="admin-link-btn"
                aria-pressed={selected === r.runId}
                onClick={() => setSelected(r.runId)}
              >
                {r.incumbentModel} vs {r.challengerModel}
              </button>
              <span className="cgate-run-meta">
                {shortDate(r.windowStart)}–{shortDate(r.windowEnd)} · {r.status}
                {r.status === 'running' && ' (replaying…)'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {run && gate && (
        <div className="cgate-detail">
          {/* A run that did not finish is not a measurement of its window, whatever its labels say. */}
          {run.status !== 'complete' && (
            <div className="cgate-incomplete">
              This run is <strong>{run.status}</strong>
              {run.error ? `: ${run.error}` : ''}. Its numbers describe only what it managed to
              replay, so they are not a reading of the window above.
            </div>
          )}

          <div className="cgate-verdict" data-tone={meta?.tone}>
            <span className="cgate-verdict-label">{meta?.label}</span>
            <span className="cgate-verdict-margin">margin {gate.marginPct} points</span>
            {gate.accuracyDelta != null && gate.accuracyDeltaCi && (
              <span className="cgate-verdict-detail">
                accuracy {gate.accuracyDelta >= 0 ? '+' : ''}{pct(gate.accuracyDelta)} · 95% CI{' '}
                {pct(gate.accuracyDeltaCi[0])} to {pct(gate.accuracyDeltaCi[1])}
              </span>
            )}
          </div>
          <p className="cgate-rationale">{gate.rationale}</p>

          {/* The corpus, stated. A replay you cannot describe is not evidence about anything. */}
          <p className="cgate-corpus">
            Replayed {run.messagesReplayed.toLocaleString()} of {run.messagesConsidered.toLocaleString()} messages
            from {shortDate(run.windowStart)} to {shortDate(run.windowEnd)}.
            {run.messagesRetracted > 0 && ` ${run.messagesRetracted.toLocaleString()} were retracted by a redaction or deletion and were never replayed.`}
            {run.messagesFastPath > 0 && ` ${run.messagesFastPath.toLocaleString()} are answered without a model (greetings and acknowledgements) and are excluded.`}
          </p>

          <div className="cgate-cells">
            <span>Agreed: <strong>{gate.summary.concordant.toLocaleString()}</strong></span>
            <span>Disagreed: <strong>{gate.summary.discordant.toLocaleString()}</strong></span>
            <span>Challenger right: <strong>{gate.summary.challengerOnlyRight.toLocaleString()}</strong></span>
            <span>Incumbent right: <strong>{gate.summary.incumbentOnlyRight.toLocaleString()}</strong></span>
            <span>Both wrong: <strong>{gate.summary.bothWrong.toLocaleString()}</strong></span>
          </div>

          {/* §5.4: the gate sizes the split before it runs. */}
          {disagreement != null && (
            <p className="cgate-sizing">
              The two models disagreed on {pct(disagreement)} of the replayed messages.
              {disagreement < 0.01 && ' At that rate an online split has almost nothing to detect, and is probably not worth running.'}
            </p>
          )}

          {gate.summary.pending > 0 ? (
            <>
              <h5 className="cgate-queue-title">
                Adjudication queue · {gate.summary.pending.toLocaleString()} pending
                {queueTotal > queue.length && ` (showing ${queue.length} of ${queueTotal.toLocaleString()})`}
              </h5>
              <p className="admin-tab-description">
                Only the disagreements are here. Where both models said the same thing the pair cannot
                favour either, so it is never queued. Rule for whichever is correct, or for neither.
              </p>
              <table className="cgate-queue">
                <thead>
                  <tr><th>Incumbent said</th><th>Challenger said</th><th>Correct label</th></tr>
                </thead>
                <tbody>
                  {queue.map((row) => (
                    <tr key={row.id}>
                      <td><code>{row.incumbentLabel}</code></td>
                      <td><code>{row.challengerLabel}</code></td>
                      <td className="cgate-queue-actions">
                        <button className="admin-inline-btn" disabled={busy} onClick={() => adjudicate(row.id, row.incumbentLabel)}>
                          {row.incumbentLabel}
                        </button>
                        <button className="admin-inline-btn" disabled={busy} onClick={() => adjudicate(row.id, row.challengerLabel)}>
                          {row.challengerLabel}
                        </button>
                        {/* 'Neither' is a real outcome. Forcing a choice between the two predictions
                            would manufacture a winner from a pair that has none. */}
                        <input
                          aria-label={`Neither, for pair ${row.id}`}
                          placeholder="neither — correct label"
                          value={otherLabel[row.id] ?? ''}
                          onChange={(e) => setOtherLabel({ ...otherLabel, [row.id]: e.target.value })}
                        />
                        <button
                          className="admin-inline-btn"
                          disabled={busy || !(otherLabel[row.id] ?? '').trim()}
                          onClick={() => adjudicate(row.id, otherLabel[row.id] ?? '')}
                        >
                          Neither
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="admin-tab-description">
              {gate.summary.discordant === 0
                ? 'The models agreed on every replayed message, so there is nothing to adjudicate.'
                : 'Every disagreement has been ruled on.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
