/**
 * WHAT AN AWS EVENT MAY DO IN THIS DEPLOYMENT (SPEC-WORKFLOWS-AND-TASKS WT122): the allowed event types, the caps, and the switch
 * that turns every trigger off. One policy for the deployment, saved whole; the server refuses a value over the most it allows and says
 * why. The dev values are strict, and a production deployment raises them here.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { readEventPolicy, saveEventPolicy } from '../../services/eventTriggerService';

export const EventPolicyPanel: React.FC = () => {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    readEventPolicy().then((p) => setText(JSON.stringify(p, null, 2))).catch((e: Error) => setError(e.message));
  }, []);

  const save = async () => {
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const next = JSON.parse(text) as unknown;
      setText(JSON.stringify(await saveEventPolicy(next), null, 2));
      setSaved(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <fieldset className="admin-filter-group" data-testid="event-policy-panel">
      <legend className="admin-field-label">{t('admin.eventPolicy.title')}</legend>
      <span className="admin-field-hint">{t('admin.eventPolicy.help')}</span>
      <textarea className="input" rows={14} data-testid="event-policy-text" value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} />
      <button type="button" className="btn-primary" data-testid="event-policy-save" disabled={busy || !text} onClick={() => { void save(); }}>{t('admin.eventPolicy.save')}</button>
      {saved && <span className="admin-field-hint" data-testid="event-policy-saved">{t('admin.eventPolicy.saved')}</span>}
      {error && <span className="error-message" role="alert" data-testid="event-policy-error">{error}</span>}
    </fieldset>
  );
};

export default EventPolicyPanel;
