import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchNoticePreferences, setNoticeMuted, NoticePreferencesError, type NoticePreferencesView,
} from '../services/noticePreferencesService';

/**
 * THE EMAIL SECTION OF ACCOUNT SETTINGS (B9, M-7).
 *
 * Two groups, because they are two different things to a reader: OPTIONAL emails, each with its state said
 * in words and a switch, and REQUIRED emails (an invitation, a claim, a reply receipt), listed with why they
 * cannot be turned off. The bulk action opts out of, or back in to, the optional ones. It lives in Account
 * settings rather than the header: a preference is not navigation.
 *
 * A read that fails is said, never shown as nothing muted: a person who opted out must not see it on.
 */
interface Props {
  /** Injected for tests. */
  deps?: { load?: typeof fetchNoticePreferences; set?: typeof setNoticeMuted };
}

const EmailPreferences: React.FC<Props> = ({ deps }) => {
  const { t } = useTranslation();
  const load = deps?.load ?? fetchNoticePreferences;
  const set = deps?.set ?? setNoticeMuted;
  const [view, setView] = useState<NoticePreferencesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const say = useCallback((err: unknown) => {
    const code = err instanceof NoticePreferencesError ? err.code : '';
    setError(t(`emailPreferences.error.${code}`, { defaultValue: t('emailPreferences.error.generic') }));
  }, [t]);

  useEffect(() => {
    setError(null);
    setSaved(false);
    setView(null);
    load().then(setView, say);
  }, [load, say]);

  const change = async (kind: string, muted: boolean) => {
    setSaving(kind);
    setError(null);
    setSaved(false);
    try {
      setView(await set(kind, muted));
      setSaved(true);
    } catch (err) {
      say(err);
    } finally {
      setSaving(null);
    }
  };

  const kindLabel = (kind: string) => t(`emailPreferences.kind.${kind}`, { defaultValue: kind });
  const optional = view?.kinds.filter((k) => !k.transactional) ?? [];
  const required = view?.kinds.filter((k) => k.transactional) ?? [];

  return (
    <section className="settings-section" aria-labelledby="settings-email-title" id="settings-email">
      <h3 id="settings-email-title" className="settings-section-title">{t('emailPreferences.title')}</h3>
      <p className="settings-section-intro">{t('emailPreferences.intro')}</p>
      {!view && !error && <p role="status" className="settings-muted">{t('emailPreferences.loading')}</p>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {saved && <div className="alert alert-success" role="status">{t('emailPreferences.saved')}</div>}

      {view && optional.length > 0 && (
        <>
          <h4 className="settings-group-title">{t('emailPreferences.optionalTitle')}</h4>
          <ul className="settings-list">
            {optional.map((k) => {
              const on = !k.muted;
              return (
                <li key={k.kind} className="settings-row">
                  <span className="settings-row-label">{kindLabel(k.kind)}</span>
                  <span className={`settings-row-state ${on ? 'is-on' : 'is-off'}`}>
                    {t(on ? 'emailPreferences.sending' : 'emailPreferences.optedOut')}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={kindLabel(k.kind)}
                    className="settings-switch"
                    disabled={saving !== null}
                    onClick={() => change(k.kind, on)}
                  >
                    <span className="settings-switch-knob" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="btn btn-secondary settings-bulk"
            disabled={saving !== null}
            onClick={() => change('*', !view.allMuted)}
          >
            {view.allMuted ? t('emailPreferences.optInAll') : t('emailPreferences.optOutAll')}
          </button>
        </>
      )}

      {view && required.length > 0 && (
        <>
          <h4 className="settings-group-title">{t('emailPreferences.requiredTitle')}</h4>
          <p className="settings-muted">{t('emailPreferences.requiredNote')}</p>
          <ul className="settings-list">
            {required.map((k) => (
              <li key={k.kind} className="settings-row">
                <span className="settings-row-label">{kindLabel(k.kind)}</span>
                <span className="settings-row-state is-fixed">{t('emailPreferences.alwaysSent')}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};

export default EmailPreferences;
