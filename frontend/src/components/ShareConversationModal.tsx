import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversations } from '../providers/ConversationProvider.chime';
import './NewConversationModal.css';

interface ShareConversationModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const ShareConversationModal: React.FC<ShareConversationModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [isSharing, setIsSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const { shareConversation } = useConversations();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError(t('share.invalidEmail'));
      return;
    }

    try {
      setIsSharing(true);
      setError(null);
      setSuccess(null);
      setWarning(null);
      const result = await shareConversation(trimmed);
      const successMsg = result.isNowMultiUser
        ? t('share.successMultiUser', { name: result.recipientName })
        : t('share.successPlain', { name: result.recipientName });
      setSuccess(successMsg);
      if (!result.emailSent) {
        setWarning(
          result.emailError
            ? t('share.emailWarningWithReason', { reason: result.emailError })
            : t('share.emailWarningNoReason'),
        );
      }
      setEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('share.failureFallback'));
    } finally {
      setIsSharing(false);
    }
  };

  const handleClose = () => {
    setEmail('');
    setError(null);
    setSuccess(null);
    setWarning(null);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('share.title')}</h2>
          <button className="modal-close-btn" onClick={handleClose} aria-label={t('common.close')}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="close-icon">
              <path fillRule="evenodd" d="M5.47 5.47a.75.75 0 011.06 0L12 10.94l5.47-5.47a.75.75 0 111.06 1.06L13.06 12l5.47 5.47a.75.75 0 11-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 01-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 010-1.06z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="modal-form">
          <div className="form-group">
            <label htmlFor="share-email" className="form-label">
              {t('share.emailLabel')}
            </label>
            <input
              id="share-email"
              type="email"
              className="form-input"
              placeholder={t('share.emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
            <p className="text-tertiary" style={{ fontSize: 'var(--text-sm)', marginTop: 'var(--space-2)' }}>
              {t('share.emailHelper')}
            </p>
          </div>
          {error && (
            <div className="alert alert-error">
              {error}
            </div>
          )}
          {success && (
            <div className="alert alert-success">
              {success}
            </div>
          )}
          {warning && (
            <div className="alert alert-warning">
              {warning}
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={handleClose}>
              {t('share.closeButton')}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!email.trim() || isSharing}
            >
              {isSharing ? t('share.sharing') : t('share.shareButton')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ShareConversationModal;
