import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchLanguagePreference, setLanguagePreference, LanguagePreferenceError, type LanguagePreferenceView,
} from '../services/languagePreferenceService';

/**
 * THE LANGUAGE SECTION OF ACCOUNT SETTINGS (ADR-062 decision 4).
 *
 * The language a message addressed to this person is said in: one choice among the languages the deployment declares,
 * listed by the server, each in its own name. "The deployment's language" clears the choice. A message the whole room
 * reads follows the conversation's language instead, which the section says, so nobody expects a shared room to switch.
 *
 * A read that fails is said, never shown as no choice made.
 */
interface Props {
  /** Injected for tests. */
  deps?: { load?: typeof fetchLanguagePreference; set?: typeof setLanguagePreference };
}

const UNSET = '';

const LanguagePreference: React.FC<Props> = ({ deps }) => {
  const { t } = useTranslation();
  const load = deps?.load ?? fetchLanguagePreference;
  const set = deps?.set ?? setLanguagePreference;
  const [view, setView] = useState<LanguagePreferenceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const say = useCallback((err: unknown) => {
    const code = err instanceof LanguagePreferenceError ? err.code : '';
    setError(t(`languagePreference.error.${code}`, { defaultValue: t('languagePreference.error.generic') }));
  }, [t]);

  useEffect(() => {
    setError(null);
    setSaved(false);
    setView(null);
    load().then(setView, say);
  }, [load, say]);

  const change = async (value: string) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      setView(await set(value === UNSET ? null : value));
      setSaved(true);
    } catch (err) {
      say(err);
    } finally {
      setSaving(false);
    }
  };

  const deploymentName = view?.languages.find((l) => l.tag === view.deployment)?.native ?? view?.deployment ?? '';

  return (
    <section className="settings-section" aria-labelledby="settings-language-title" id="settings-language">
      <h3 id="settings-language-title" className="settings-section-title">{t('languagePreference.title')}</h3>
      <p className="settings-section-intro">{t('languagePreference.intro')}</p>
      {!view && !error && <p role="status" className="settings-muted">{t('languagePreference.loading')}</p>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {saved && <div className="alert alert-success" role="status">{t('languagePreference.saved')}</div>}
      {view && (
        <label className="settings-row">
          <span className="settings-row-label">{t('languagePreference.label')}</span>
          <select
            value={view.language ?? UNSET}
            disabled={saving}
            onChange={(e) => change(e.target.value)}
          >
            <option value={UNSET}>{t('languagePreference.deploymentDefault', { language: deploymentName })}</option>
            {view.languages.map((l) => (
              <option key={l.tag} value={l.tag} lang={l.tag}>{l.native}</option>
            ))}
          </select>
        </label>
      )}
      {view && <p className="settings-muted">{t('languagePreference.roomNote')}</p>}
    </section>
  );
};

export default LanguagePreference;
