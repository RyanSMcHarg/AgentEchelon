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
import { useTranslation } from 'react-i18next';
import { queryAnalytics } from '../../services/analyticsService';
import { useCan } from '../../capabilities';
import { MODEL_STRATEGY_MODELS, classificationName, memberConversationalClassifications } from '@ae/shared';
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
  /** The classification the run read and ran in. Null on a run from before runs named one. */
  classification?: string | null;
  /** The assistant whose classifier was compared. */
  assistant?: string | null;
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
  /** Conversations the informative disagreements came from: McNemar's interval is computed per conversation. */
  informativeConversations?: number;
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

/**
 * What a verdict MEANS, and what it is called.
 *
 * `labelKey` rather than a label: this map is module scope, so it has no hook, and resolving at load time
 * would freeze the language. `tone` and `authorises` are behavior and stay here - `authorises` in
 * particular decides whether a traffic split is allowed, which must never depend on a display string.
 */
export const VERDICT_META: Record<GateVerdict, { labelKey: string; tone: string; authorises: boolean }> = {
  challenger_better: { labelKey: 'admin.classifierGate.verdict.challengerBetter', tone: 'win', authorises: true },
  non_inferior: { labelKey: 'admin.classifierGate.verdict.nonInferior', tone: 'hold', authorises: true },
  worse: { labelKey: 'admin.classifierGate.verdict.worse', tone: 'bad', authorises: false },
  indistinguishable: { labelKey: 'admin.classifierGate.verdict.indistinguishable', tone: 'wait', authorises: false },
  insufficient: { labelKey: 'admin.classifierGate.verdict.insufficient', tone: 'wait', authorises: false },
};

/** A gate result only authorizes a traffic split when the run FINISHED and its verdict clears. */
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

/**
 * The classification a replay runs in, from the same list the experiment form offers: the deployment's
 * declared member conversational classifications (`memberConversationalClassifications`). A replay reads one
 * classification's traffic with that classification's models only (tenet D12), so it is evidence about that
 * classification, and the experiment form looks for a passing run per classification its split covers.
 */

export default function ClassifierGatePanel({ dateRange }: { dateRange: AnalyticsDateRange }) {
  const { t } = useTranslation();
  // Each control renders only for a role holding its capability (SPEC-ADMIN-CONSOLE FR0f, FR36).
  const can = useCan();
  const [runs, setRuns] = useState<ReplayRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ run: ReplayRun; gate: GateResult } | null>(null);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const classificationOptions = memberConversationalClassifications().map((c) => c.value);
  const [form, setForm] = useState({ classification: classificationOptions[0] ?? '', incumbentModel: '', challengerModel: '', windowDays: '30', limit: '200' });
  const [otherLabel, setOtherLabel] = useState<Record<string, string>>({});

  const loadRuns = useCallback(async () => {
    try {
      const res = await queryAnalytics('classifier_replays', dateRange, {});
      setRuns(((res.data as unknown) as ReplayRun[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.classifierGate.couldNotLoadReplayRuns'));
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
      setError(e instanceof Error ? e.message : t('admin.classifierGate.couldNotLoadTheReplay'));
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
        classification: form.classification,
        incumbentModel: form.incumbentModel.trim(),
        challengerModel: form.challengerModel.trim(),
        windowDays: form.windowDays,
        limit: form.limit,
      })) as unknown as { run: ReplayRun };
      const runId = res?.run?.runId;
      if (!runId) {
        setError(t('admin.classifierGate.theReplayWasAcceptedBut'));
        return;
      }
      const opened = await waitForRun(runId);
      await loadRuns();
      if (opened) {
        setSelected(runId);
      } else {
        setError(
          t('admin.classifierGate.theReplayWasAcceptedBut2') +
            t('admin.classifierGate.replayFunctionSLogsBefore'),
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.classifierGate.couldNotStartTheReplay'));
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
      setError(e instanceof Error ? e.message : t('admin.classifierGate.couldNotRecordTheRuling'));
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
      <h4>{t('admin.classifierGate.classifierAccuracyGate')}</h4>
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
          className="select input"
          aria-label={t('admin.classifierGate.classificationField')}
          value={form.classification}
          onChange={(e) => setForm({ ...form, classification: e.target.value })}
        >
          {classificationOptions.map((c) => <option key={c} value={c}>{classificationName(c)}</option>)}
        </select>
        <select
          className="select input"
          aria-label={t('admin.classifierGate.incumbentModelField')}
          value={form.incumbentModel}
          onChange={(e) => setForm({ ...form, incumbentModel: e.target.value })}
        >
          <option value="">{t('admin.classifierGate.incumbentModel')}</option>
          {MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          className="select input"
          aria-label={t('admin.classifierGate.challengerModelField')}
          value={form.challengerModel}
          onChange={(e) => setForm({ ...form, challengerModel: e.target.value })}
        >
          <option value="">{t('admin.classifierGate.challengerModel')}</option>
          {MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input
          className="input"
          aria-label={t('admin.classifierGate.windowDays')}
          type="number"
          value={form.windowDays}
          onChange={(e) => setForm({ ...form, windowDays: e.target.value })}
        />
        <input
          className="input"
          aria-label={t('admin.classifierGate.messages')}
          type="number"
          value={form.limit}
          onChange={(e) => setForm({ ...form, limit: e.target.value })}
        />
        <button
          className="btn-secondary"
          disabled={busy || !form.incumbentModel.trim() || !form.challengerModel.trim() || !can('run-classifier-replay')}
          title={can('run-classifier-replay') ? undefined : t('admin.refusal.lacksCapability', { capability: 'run-classifier-replay' })}
          onClick={startReplay}
        >
          Run replay
        </button>
      </div>

      {runs.length === 0 ? (
        <p className="admin-tab-description">
          {t('admin.classifierGate.noReplayHasBeenRun')}
        </p>
      ) : (
        <ul className="cgate-runs">
          {runs.map((r) => (
            <li key={r.runId}>
              <button
                className="btn-link"
                aria-pressed={selected === r.runId}
                onClick={() => setSelected(r.runId)}
              >
                {r.incumbentModel} vs {r.challengerModel}
              </button>
              <span className="cgate-run-meta">
                {r.classification ?? t('admin.classifierGate.everyClassification')} · {shortDate(r.windowStart)}–{shortDate(r.windowEnd)} · {r.status}
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
            <span className="cgate-verdict-label">{meta ? t(meta.labelKey) : null}</span>
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
            {run.messagesRetracted > 0 && t('admin.classifierGate.wereRetractedByARedaction', { messagesRetracted: run.messagesRetracted.toLocaleString() })}
            {run.messagesFastPath > 0 && t('admin.classifierGate.areAnsweredWithoutAModel', { messagesFastPath: run.messagesFastPath.toLocaleString() })}
          </p>

          <div className="cgate-cells">
            <span>{t('admin.classifierGate.agreed')} <strong>{gate.summary.concordant.toLocaleString()}</strong></span>
            <span>{t('admin.classifierGate.disagreed')} <strong>{gate.summary.discordant.toLocaleString()}</strong></span>
            <span>{t('admin.classifierGate.challengerRight')} <strong>{gate.summary.challengerOnlyRight.toLocaleString()}</strong></span>
            <span>{t('admin.classifierGate.incumbentRight')} <strong>{gate.summary.incumbentOnlyRight.toLocaleString()}</strong></span>
            <span>{t('admin.classifierGate.bothWrong')} <strong>{gate.summary.bothWrong.toLocaleString()}</strong></span>
            {gate.informativeConversations != null && (
              <span>{t('admin.classifierGate.informativeConversations')} <strong>{gate.informativeConversations.toLocaleString()}</strong></span>
            )}
          </div>

          {/* §5.4: the gate sizes the split before it runs. */}
          {disagreement != null && (
            <p className="cgate-sizing">
              The two models disagreed on {pct(disagreement)} of the replayed messages.
              {disagreement < 0.01 && t('admin.classifierGate.atThatRateAnOnline')}
            </p>
          )}

          {gate.summary.pending > 0 ? (
            <>
              <h5 className="cgate-queue-title">
                Adjudication queue · {gate.summary.pending.toLocaleString()} pending
                {queueTotal > queue.length && t('admin.classifierGate.showingOf', { queue: queue.length, queueTotal: queueTotal.toLocaleString() })}
              </h5>
              <p className="admin-tab-description">
                {t('admin.classifierGate.onlyTheDisagreementsAreHere')}
              </p>
              <table className="cgate-queue">
                <thead>
                  <tr><th>{t('admin.classifierGate.incumbentSaid')}</th><th>{t('admin.classifierGate.challengerSaid')}</th><th>{t('admin.classifierGate.correctLabel')}</th></tr>
                </thead>
                <tbody>
                  {queue.map((row) => (
                    <tr key={row.id}>
                      <td><code>{row.incumbentLabel}</code></td>
                      <td><code>{row.challengerLabel}</code></td>
                      <td className="cgate-queue-actions">
                        <button className="btn-secondary" disabled={busy || !can('label-ground-truth')} onClick={() => adjudicate(row.id, row.incumbentLabel)}>
                          {row.incumbentLabel}
                        </button>
                        <button className="btn-secondary" disabled={busy || !can('label-ground-truth')} onClick={() => adjudicate(row.id, row.challengerLabel)}>
                          {row.challengerLabel}
                        </button>
                        {/* 'Neither' is a real outcome. Forcing a choice between the two predictions
                            would manufacture a winner from a pair that has none. */}
                        <input
                          className="input"
                          aria-label={t('admin.classifierGate.neitherForPair', { id: row.id })}
                          placeholder={t('admin.classifierGate.neitherCorrectLabel')}
                          value={otherLabel[row.id] ?? ''}
                          onChange={(e) => setOtherLabel({ ...otherLabel, [row.id]: e.target.value })}
                        />
                        <button
                          className="btn-secondary"
                          disabled={busy || !(otherLabel[row.id] ?? '').trim() || !can('label-ground-truth')}
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
                ? t('admin.classifierGate.theModelsAgreedOnEvery')
                : t('admin.classifierGate.everyDisagreementHasBeenRuled')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
