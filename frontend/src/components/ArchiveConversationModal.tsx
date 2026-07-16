import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import './NewConversationModal.css';

interface ArchiveConversationModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Performs the archive (persisting, moderator-gated). Resolves on success. */
  onConfirm: () => Promise<void>;
}

/**
 * In-app confirmation for archiving a conversation (replaces window.confirm).
 * Shows the plain-language consequences, an explicit danger confirm, and any
 * failure inline rather than in a browser alert.
 */
const ArchiveConversationModal: React.FC<ArchiveConversationModalProps> = ({ isOpen, onClose, onConfirm }) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleClose = () => {
    if (busy) return;
    setError(null);
    onClose();
  };

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(t('conversation.archiveError', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2>{t('conversation.archiveTitle')}</h2>
          <button className="modal-close-btn" onClick={handleClose} aria-label={t('common.close')} disabled={busy}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="close-icon">
              <path fillRule="evenodd" d="M5.47 5.47a.75.75 0 011.06 0L12 10.94l5.47-5.47a.75.75 0 111.06 1.06L13.06 12l5.47 5.47a.75.75 0 11-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 01-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 010-1.06z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
        <div className="modal-form">
          <p className="text-secondary" style={{ margin: 0, lineHeight: 'var(--leading-relaxed)' }}>
            {t('conversation.archiveConfirm')}
          </p>
          {error && <div className="alert alert-error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={handleClose} disabled={busy}>
              {t('common.cancel')}
            </button>
            <button type="button" className="btn btn-danger" onClick={handleConfirm} disabled={busy}>
              {busy ? t('common.working', { defaultValue: 'Working…' }) : t('conversation.archiveConfirmButton')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ArchiveConversationModal;
