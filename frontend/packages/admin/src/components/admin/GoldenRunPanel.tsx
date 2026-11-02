/**
 * THE DRAFT'S RUN AGAINST THE GOLDEN SET, BESIDE VALIDATE (ADR-065).
 *
 * Read when the draft opens and when its configId changes, when the run it started ends (its channel says so), and when
 * the person asks: the console never polls.
 * A run is started under `edit-profiles` because it spends model calls; the result is read under `view-profiles`. The
 * refusal itself is the server's, at Activate; this panel shows what that refusal will read.
 *
 * ACTIVATE ANYWAY (ADR-065 decision 5) is offered on a refusal to a session holding `activate-past-golden-gate`, which only
 * the admin role carries. It opens a confirmation naming the refusal shown, and needs a reason; the server checks that the
 * refusal still stands, records the reason on the version and announces it in the admin channel.
 *
 * COVERAGE PER INTENT (ADR-065 decision 6): what the set holds for each intent of the draft's pack and what the latest run
 * exercised, the active version's minimum where it declares one, and the intents a passing run checked nothing for, so
 * "passed" never stands for an intent the set does not reach.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { readGoldenGate, startGoldenRun, type GoldenGateReading, type GoldenFailure, type PastGateConfirmation } from '../../services/profileService';
import { useCan } from '../../capabilities';
import { followBatch } from '../../services/consoleEvents';
// The reason's bounds are the server's own, which refuses outside them too.
import { PAST_GATE_REASON_MIN as REASON_MIN, PAST_GATE_REASON_MAX as REASON_MAX } from '../../../../../../backend/lambda/src/lib/golden-gate.ts';

/** The refusals of a confirmation that mean the gate itself changed, so the panel reads it again. */
const GATE_MOVED = new Set(['GATE_CHANGED', 'GATE_NOT_REFUSING']);

/** What activating past the gate came to: activated, or refused with the server's code. */
export type PastGateOutcome = { activated: true } | { activated: false; code?: string };

interface Props {
  profileName: string;
  /** The draft's configId, so a saved edit reads the gate again (a run belongs to one configId). */
  draftConfigId: string | null | undefined;
  canRun: boolean;
  /** Activate the draft past the gate's refusal; the tab owns the write and what the page shows after it. */
  onActivatePastGate?: (confirm: PastGateConfirmation) => Promise<PastGateOutcome>;
}

export default function GoldenRunPanel({ profileName, draftConfigId, canRun, onActivatePastGate }: Props): React.ReactElement | null {
  const { t } = useTranslation();
  const can = useCan();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [pastGateRefused, setPastGateRefused] = useState<string | null>(null);
  // An interval end JSON carried as null (an unbounded end) reads as unbounded, in the locale's words.
  const fmt = (n: number | null | undefined): string => {
    if (n === null || n === undefined || !Number.isFinite(n)) return t('admin.assistantPage.golden.unbounded');
    return n > 0 ? `+${n}` : String(n);
  };
  const [reading, setReading] = useState<GoldenGateReading | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // THE RUN THIS PANEL STARTED, until a read shows it: the function opens its row a moment after the start answers, so
  // a read in between finds no run, and offering Run again there would start a second one.
  const [startedRun, setStartedRun] = useState<string | null>(null);
  // TOLD WHEN THE RUN ENDS: the run's channel, followed from the start until it says it ended, then the gate read once.
  const unfollow = useRef<() => void>(() => {});
  // Following stops when the page leaves this assistant, so another assistant's run never fills this panel.
  useEffect(() => () => unfollow.current(), [profileName]);
  // A run the channel says failed while its row still reads running ended without recording it (a timeout).
  const [endedFailed, setEndedFailed] = useState<string | null>(null);

  const read = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReading(await readGoldenGate(profileName));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [profileName]);

  useEffect(() => { if (draftConfigId) void read(); }, [draftConfigId, read]);

  // A confirmation belongs to a refusal: once the gate no longer refuses, it closes rather than waiting to reopen on a
  // later refusal with an old reason in it.
  const refusing = !!reading?.outcome && !reading.outcome.proceed;
  useEffect(() => {
    if (!refusing) {
      setConfirming(false);
      setReason('');
    }
  }, [refusing]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await startGoldenRun(profileName);
      setStartedRun(started.runId);
      unfollow.current();
      // Read when told it ended, once when the subscription stands (it may have ended first), and once if the channel is lost.
      unfollow.current = followBatch(started.runId, (ended) => {
        if (ended.status === 'failed') setEndedFailed(started.runId);
        void read();
      }, () => { void read(); }, () => { void read(); });
      setReading(await readGoldenGate(profileName));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Confirm the refusal shown (its code, values and run), with the reason. A refusal of the confirmation is worded beside
   * it; one that says the gate changed reads the gate afresh, so what is confirmed next is the refusal that stands.
   */
  const passGate = async (shown: Pick<PastGateConfirmation, 'code' | 'params' | 'runId'>) => {
    if (!onActivatePastGate || !draftConfigId) return;
    setBusy(true);
    setPastGateRefused(null);
    try {
      const out = await onActivatePastGate({ configId: draftConfigId, ...shown, reason: reason.trim() });
      if (out.activated) {
        setConfirming(false);
        setReason('');
        return;
      }
      if (!out.code) return;
      setPastGateRefused(out.code);
      if (GATE_MOVED.has(out.code)) setReading(await readGoldenGate(profileName));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!draftConfigId || (!reading && !error)) return null;
  const gate = reading?.gate;
  const run = gate?.run && gate.run.draftConfigId === draftConfigId ? gate.run : null;
  const starting = !!startedRun && run?.runId !== startedRun;
  // An editor may start a run unless one for this draft is going or was just started.
  const offerRun = canRun && run?.status !== 'running' && !starting;
  // THE REFUSAL ACTIVATE WILL READ, and whether this session may pass it: the capability, held by the admin role alone.
  const refusal = reading?.outcome && !reading.outcome.proceed ? reading.outcome : null;
  const offerPastGate = !!onActivatePastGate && can('activate-past-golden-gate');
  // The channel said the run failed while its row still reads running: it ended without recording it (a timeout).
  const runEndedUnrecorded = run?.status === 'running' && endedFailed === run.runId;
  const runError = run?.error === 'deadline' ? t('admin.assistantPage.golden.deadline') : run?.error ?? '';
  const failureLine = (f: GoldenFailure) => t('admin.assistantPage.golden.failure', {
    entry: f.entryId.slice(0, 8),
    attempt: f.attempt,
    reason: t(`admin.assistantPage.golden.reason.${f.reason}`, { rules: (f.rules ?? []).join(', ') }),
  });

  return (
    <div className="admin-golden-run" data-testid="golden-run" role="status">
      <strong>{t('admin.assistantPage.golden.title')}</strong>{' '}
      {error && <span className="admin-error">{error}</span>}
      {reading && !reading.available && <span>{t('admin.assistantPage.golden.unavailable')}</span>}
      {gate && gate.regressionEntries === 0 && gate.entries === 0 && <span>{t('admin.assistantPage.golden.empty')}</span>}
      {refusal?.code === 'GOLDEN_SET_THIN' && (
        <span data-testid="golden-set-thin">{t('admin.assistantPage.golden.refusal.GOLDEN_SET_THIN', refusal.params ?? {})}</span>
      )}
      {reading?.outcome?.proceed && (reading.outcome.unchecked ?? []).length > 0 && (
        <span data-testid="golden-unchecked">{t('admin.assistantPage.golden.unchecked', { intents: reading.outcome.unchecked!.join(', ') })}</span>
      )}
      {gate?.coverage && gate.coverage.length > 0 && (
        <details className="admin-golden-coverage" data-testid="golden-coverage">
          <summary>{t('admin.assistantPage.golden.coverage.title')}{gate.minRegressionPerIntent
            ? ` ${t('admin.assistantPage.golden.coverage.min', { min: gate.minRegressionPerIntent })}` : ''}</summary>
          {gate.minDeclared && <p className="admin-field-hint" data-testid="golden-min-held">{t('admin.assistantPage.golden.coverage.minHeld', { declared: gate.minDeclared, min: gate.minRegressionPerIntent })}</p>}
          {gate.minUnread && <p className="admin-field-hint" data-testid="golden-min-unread">{t('admin.assistantPage.golden.coverage.minUnread')}</p>}
          <table className="admin-mini-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.assistantPage.golden.coverage.intent')}</th>
                <th scope="col">{t('admin.assistantPage.golden.coverage.regression')}</th>
                <th scope="col">{t('admin.assistantPage.golden.coverage.capability')}</th>
                <th scope="col">{t('admin.assistantPage.golden.coverage.uploaded')}</th>
                <th scope="col">{t('admin.assistantPage.golden.coverage.exercised')}</th>
              </tr>
            </thead>
            <tbody>
              {gate.coverage.map((c) => (
                <tr key={c.intent} className={gate.minRegressionPerIntent && c.regression < gate.minRegressionPerIntent ? 'admin-golden-coverage-thin' : undefined}>
                  <td>{c.intent}</td><td>{c.regression}</td><td>{c.capability}</td><td>{c.uploaded}</td><td>{c.exercised}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(gate.outsidePack ?? []).length > 0 && (
            <p className="admin-field-hint">{t('admin.assistantPage.golden.coverage.outsidePack', {
              intents: gate.outsidePack!.map((o) => `${o.intent || t('admin.assistantPage.golden.coverage.noIntent')} (${o.entries})`).join(', '),
            })}</p>
          )}
        </details>
      )}
      {gate && gate.entries > 0 && (
        <>
          {starting && <span data-testid="golden-run-starting">{t('admin.assistantPage.golden.starting')}</span>}
          {!run && !starting && gate.regressionEntries > 0 && <span data-testid="golden-run-needed">{t('admin.assistantPage.golden.notRun')}</span>}
          {reading?.outcome && !reading.outcome.proceed && reading.outcome.code === 'GOLDEN_RUN_OUTDATED' && (
            <span data-testid="golden-run-outdated">{t('admin.assistantPage.golden.refusal.GOLDEN_RUN_OUTDATED', reading.outcome.params)}</span>
          )}
          {run?.status === 'running' && !runEndedUnrecorded && <span>{t('admin.assistantPage.golden.running', { done: run.entriesDone, total: run.entriesTotal })}</span>}
          {runEndedUnrecorded && <span data-testid="golden-run-ended-failed">{t('admin.assistantPage.golden.failed', { error: t('admin.assistantPage.golden.deadline') })}</span>}
          {run?.status === 'failed' && <span>{t('admin.assistantPage.golden.failed', { error: runError })}</span>}
          {run?.status === 'complete' && run.result && (
            <div data-testid="golden-run-result">
              <p>{t('admin.assistantPage.golden.summary', {
                entries: run.result.entries, k: run.result.k,
                blocked: new Set(run.result.failures.map((f) => f.entryId)).size,
                notExercised: run.result.notExercised.length,
              })}</p>
              <p>{run.result.pairedDifference && run.result.pairedDifference.entries >= 2
                ? t('admin.assistantPage.golden.quality', {
                  mean: fmt(run.result.pairedDifference.mean),
                  low: fmt(run.result.pairedDifference.ci[0]), high: fmt(run.result.pairedDifference.ci[1]),
                  mde: fmt(run.result.minimumDetectable).replace(/^\+/, ''),
                })
                : t('admin.assistantPage.golden.qualityUnmeasured')}</p>
              {run.result.refused
                ? <ul data-testid="golden-run-failures">{run.result.failures.map((f) => <li key={`${f.entryId}-${f.attempt}`}>{failureLine(f)}</li>)}</ul>
                : <p>{t(run.result.regressionExercised === 0 ? 'admin.assistantPage.golden.unmeasured' : 'admin.assistantPage.golden.passed')}</p>}
              {run.result.readyToPromote.length > 0 && (
                <p>{t('admin.assistantPage.golden.readyToPromote', { entries: run.result.readyToPromote.map((id) => id.slice(0, 8)).join(', ') })}</p>
              )}
            </div>
          )}
          <div className="admin-config-actions">
            {offerRun && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => { void start(); }} data-testid="golden-run-start">
                {t('admin.assistantPage.golden.run', { count: gate.entries, k: run?.k ?? 3 })}
              </button>
            )}
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => { void read(); }}>
              {t('admin.assistantPage.golden.checkAgain')}
            </button>
          </div>
          {offerRun && <p className="admin-field-hint">{t('admin.assistantPage.golden.cost', { answers: gate.entries * 3 * 2 })}</p>}
        </>
      )}
      {refusal && offerPastGate && !confirming && (
        <div className="admin-config-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setConfirming(true); setPastGateRefused(null); }} data-testid="golden-past-gate-offer">
            {t('admin.assistantPage.golden.pastGate.offer')}
          </button>
        </div>
      )}
      {refusal && offerPastGate && confirming && (
        <section className="admin-golden-past-gate" aria-labelledby="golden-past-gate-title" data-testid="golden-past-gate">
          <h4 id="golden-past-gate-title">{t('admin.assistantPage.golden.pastGate.title')}</h4>
          <p>{t(`admin.assistantPage.golden.refusal.${refusal.code}`, refusal.params ?? {})}</p>
          {(refusal.failures ?? []).length > 0 && <ul>{(refusal.failures ?? []).map((f) => <li key={`${f.entryId}-${f.attempt}`}>{failureLine(f)}</li>)}</ul>}
          <p className="admin-field-hint">{t('admin.assistantPage.golden.pastGate.explain')}</p>
          <label htmlFor="golden-past-gate-reason">{t('admin.assistantPage.golden.pastGate.reasonLabel')}</label>
          <textarea id="golden-past-gate-reason" value={reason} maxLength={REASON_MAX} rows={3} disabled={busy}
            onChange={(e) => setReason(e.target.value)} data-testid="golden-past-gate-reason" />
          <p className="admin-field-hint">{t('admin.assistantPage.golden.pastGate.reasonHint', { min: REASON_MIN, max: REASON_MAX })}</p>
          <div className="admin-config-actions">
            <button type="button" className="btn-primary" disabled={busy || reason.trim().length < REASON_MIN}
              onClick={() => { void passGate({ code: refusal.code, params: refusal.params ?? {}, ...(run?.runId ? { runId: run.runId } : {}) }); }} data-testid="golden-past-gate-confirm">
              {t('admin.assistantPage.golden.pastGate.confirm')}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setConfirming(false); setPastGateRefused(null); }}>
              {t('admin.assistantPage.golden.pastGate.cancel')}
            </button>
          </div>
        </section>
      )}
      {pastGateRefused && (
        <p className="admin-error" role="alert" data-testid="golden-past-gate-refused">
          {t(`admin.assistantPage.golden.pastGate.refused.${pastGateRefused}`, { min: REASON_MIN, max: REASON_MAX })}
        </p>
      )}
    </div>
  );
}
