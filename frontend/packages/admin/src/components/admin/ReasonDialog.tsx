import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setReasonProvider, type ReasonRequest } from '../../services/adminReason';

/**
 * Asks the operator why they are reaching a conversation (SPEC-ADMIN-CONSOLE FR51).
 *
 * Mounted once by the dashboard, it registers itself as the reason provider: every per-conversation admin
 * credential - a message read, the live members, an attachment, a redaction, a deletion, a membership
 * change - waits here for a reason before it is requested, and the credential exchange records that
 * reason beside what the credential reaches. Cancelling abandons the action rather than failing it.
 */
export default function ReasonDialog(): React.ReactElement | null {
  const { t } = useTranslation();
  const [pending, setPending] = useState<{ request: ReasonRequest; resolve: (r: string | null) => void } | null>(null);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setReasonProvider((request) => new Promise((resolve) => {
    setText('');
    setPending({ request, resolve });
  })), []);

  useEffect(() => {
    if (pending) inputRef.current?.focus();
  }, [pending]);

  if (!pending) return null;
  const finish = (answer: string | null) => {
    pending.resolve(answer);
    setPending(null);
  };
  const isRead = pending.request.kind === 'read';

  return (
    <div
      className="admin-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('admin.reason.title')}
      data-testid="admin-reason-dialog"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
        padding: '16px',
      }}
    >
      <div className="admin-modal admin-section" style={{ maxWidth: '520px', width: '100%', margin: 0 }}>
        <h4>{t('admin.reason.title')}</h4>
        <p>
          {!isRead
            ? t('admin.reason.changePrompt', { capability: pending.request.capability })
            : pending.request.subject === 'responses' ? t('admin.reason.readResponsesPrompt') : t('admin.reason.readPrompt')}
        </p>
        <textarea
          ref={inputRef}
          className="textarea input"
          data-testid="admin-reason-input"
          aria-label={t('admin.reason.title')}
          value={text}
          maxLength={500}
          rows={3}
          placeholder={t('admin.reason.placeholder')}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="admin-field-hint">{t('admin.reason.recorded')}</p>
        <div className="admin-inline-actions">
          <button className="btn-secondary" onClick={() => finish(null)}>{t('admin.reason.cancel')}</button>
          <button
            className="btn-secondary"
            data-testid="admin-reason-confirm"
            disabled={!text.trim()}
            onClick={() => finish(text.trim())}
          >
            {t('admin.reason.continue')}
          </button>
        </div>
      </div>
    </div>
  );
}
