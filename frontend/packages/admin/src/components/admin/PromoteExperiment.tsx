/**
 * THE PROMOTE ACTION ON AN EXPERIMENT (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.6).
 *
 * Promotion copies the measured treatment into the live assistant as a new version and activates it, so the
 * server refuses it unless the live version is still the experiment's control and the copy hashes to what
 * was measured. This button only asks; every refusal comes back from the server with its reason, and is
 * shown as given. Offered on an experiment that pinned two versions (`servesVersions`) and is running or
 * paused, to a role holding `activate-profiles` (the route's capability).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Experiment } from '@ae/shared';
import { promoteExperiment } from '../../services/experimentsService';

/** Whether the Promote action is offered for this experiment, to a caller with these capabilities. */
export function promotable(exp: Experiment, can: (capability: string) => boolean): boolean {
  return (exp.status === 'active' || exp.status === 'paused')
    && exp.servesVersions === true
    && !!exp.variants?.[1]?.altPin
    && can('activate-profiles');
}

/** The live assistant the treatment would be promoted into: the control's pinned assistant. */
function liveAssistantOf(exp: Experiment): string {
  return exp.variants?.[0]?.controlPin?.profileName ?? '';
}

export default function PromoteExperiment(props: {
  exp: Experiment;
  can: (capability: string) => boolean;
  /** Called after a promotion succeeds, so the list re-reads the completed experiment. */
  onPromoted: () => void;
}) {
  const { t: translate } = useTranslation();
  const { exp } = props;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'done' | 'refused'; text: string } | null>(null);
  if (!promotable(exp, props.can)) return null;
  const assistant = liveAssistantOf(exp);

  async function run() {
    setBusy(true);
    setOutcome(null);
    try {
      const r = await promoteExperiment(exp.experimentId, note.trim() || undefined);
      setOpen(false);
      setOutcome({
        kind: 'done',
        text: translate('admin.experiments.promoteDone', {
          assistant: r.promotion?.profileName ?? assistant, version: r.promotion?.version ?? '', id: exp.experimentId,
        }),
      });
      props.onPromoted();
    } catch (err) {
      setOutcome({ kind: 'refused', text: translate('admin.experiments.promoteRefused', { reason: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="btn-secondary"
        title={translate('admin.experiments.promoteHint')}
        onClick={() => { setOpen(true); setOutcome(null); }}
      >
        {translate('admin.experiments.promote')}
      </button>
      {outcome && (
        <span role={outcome.kind === 'refused' ? 'alert' : 'status'} className="admin-field-hint">{outcome.text}</span>
      )}
      {open && (
        <div className="admin-modal-overlay" role="dialog" aria-modal="true" aria-label={translate('admin.experiments.promoteTitle')}>
          <div className="admin-modal experiment-confirm admin-section">
            <h4>{translate('admin.experiments.promoteTitle')}</h4>
            <p>{translate('admin.experiments.promoteConfirm', { id: exp.experimentId, assistant })}</p>
            <label>
              {translate('admin.experiments.promoteNote')}
              <textarea className="textarea input" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
            </label>
            {outcome?.kind === 'refused' && <p role="alert">{outcome.text}</p>}
            <div className="admin-inline-actions">
              <button className="btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
                {translate('common.cancel')}
              </button>
              <button className="btn-secondary" onClick={run} disabled={busy}>
                {busy ? translate('admin.experiments.promoteWorking') : translate('admin.experiments.promoteRun')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
