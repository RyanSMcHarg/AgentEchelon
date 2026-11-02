/**
 * INVITE SOMEBODY NEW (M-10): the part of the share dialog for a person who has no account yet.
 *
 * Sharing adds somebody who already has an account, found in the directory. An invitation is for somebody
 * who does not: the server mints the person it names, adds them to this conversation, and emails them a
 * link to its landing page, where they join by signing in (or, where the conversation's type and the
 * deployment allow it, by the link alone, as a guest for 15 minutes). Below the form, the invitations this
 * person issued here (every one, for a moderator), each with its status and a way to withdraw it, which
 * removes the person it named from the conversation.
 *
 * Every refusal is the client's own localized sentence for the server's code (tenet D11).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  InvitationRequestError,
  issueInvitation as defaultIssue,
  listInvitations as defaultList,
  revokeInvitation as defaultRevoke,
  type InvitationView,
  type RedemptionMode,
} from '../services/invitationService';

export interface InvitePanelProps {
  channelArn: string;
  deps?: { issue?: typeof defaultIssue; list?: typeof defaultList; revoke?: typeof defaultRevoke };
}

const KNOWN_REFUSALS = new Set([
  'NOT_A_MEMBER', 'CONVERSATION_ARCHIVED', 'INVITATIONS_NOT_DECLARED', 'MODE_NOT_DECLARED', 'LINK_NOT_AVAILABLE',
  'NOT_CLEARED', 'INVITATIONS_UNAVAILABLE', 'INVITATION_INVALID', 'NOT_YOURS',
]);

export default function InvitePanel({ channelArn, deps = {} }: InvitePanelProps) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState<RedemptionMode>('sign-in');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<InvitationView[]>([]);

  const reasonOf = useCallback((err: unknown): string => {
    const code = err instanceof InvitationRequestError ? err.code : '';
    return KNOWN_REFUSALS.has(code) ? t(`invite.refused.${code}`) : t('invite.failed');
  }, [t]);

  const refresh = useCallback(async () => {
    try {
      setInvitations((await (deps.list ?? defaultList)(channelArn)).invitations);
    } catch {
      /* the list is a convenience beside the form; a failed read leaves it as it was */
    }
  }, [channelArn, deps.list]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setLink(null);
    try {
      const issued = await (deps.issue ?? defaultIssue)({ channelArn, name: trimmed, ...(email.trim() ? { email: email.trim() } : {}), mode });
      setNotice(issued.emailed ? t('invite.sent', { name: trimmed }) : t('invite.linkReady', { name: trimmed }));
      if (issued.link) setLink(issued.link);
      setName('');
      setEmail('');
      await refresh();
    } catch (err) {
      setError(reasonOf(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (invitationId: string) => {
    setError(null);
    try {
      await (deps.revoke ?? defaultRevoke)(channelArn, invitationId);
      await refresh();
    } catch (err) {
      setError(reasonOf(err));
    }
  };

  const date = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(i18n.language);

  return (
    <section className="invite-panel" aria-labelledby="invite-title">
      <h3 id="invite-title" className="form-label">{t('invite.title')}</h3>
      <p className="text-tertiary" style={{ fontSize: 'var(--text-sm)', marginTop: 0 }}>{t('invite.helper')}</p>
      <form onSubmit={submit} className="modal-form">
        <div className="form-group">
          <label htmlFor="invite-name" className="form-label">{t('invite.nameLabel')}</label>
          <input id="invite-name" className="form-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
        </div>
        <div className="form-group">
          <label htmlFor="invite-email" className="form-label">{t('invite.emailLabel')}</label>
          <input id="invite-email" type="email" className="form-input" value={email} onChange={(e) => setEmail(e.target.value)} />
          <p className="text-tertiary" style={{ fontSize: 'var(--text-sm)', marginTop: 'var(--space-2)' }}>{t('invite.emailHelper')}</p>
        </div>
        <fieldset className="form-group">
          <legend className="form-label">{t('invite.modeLabel')}</legend>
          <label><input type="radio" name="invite-mode" checked={mode === 'sign-in'} onChange={() => setMode('sign-in')} /> {t('invite.modeSignIn')}</label>
          <label><input type="radio" name="invite-mode" checked={mode === 'link'} onChange={() => setMode('link')} /> {t('invite.modeLink')}</label>
        </fieldset>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {notice && <div className="alert alert-success" role="status">{notice}</div>}
        {link && (
          <div className="form-group">
            <label htmlFor="invite-link" className="form-label">{t('invite.linkLabel')}</label>
            <input id="invite-link" className="form-input" value={link} readOnly onFocus={(e) => e.currentTarget.select()} />
            <p className="text-tertiary" style={{ fontSize: 'var(--text-sm)', marginTop: 'var(--space-2)' }}>{t('invite.linkHelper')}</p>
          </div>
        )}
        <div className="modal-actions">
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>
            {busy ? t('invite.inviting') : t('invite.inviteButton')}
          </button>
        </div>
      </form>
      {invitations.length > 0 && (
        <ul className="invite-list" aria-label={t('invite.listLabel')}>
          {invitations.map((inv) => (
            <li key={inv.invitationId} className="invite-list-item">
              <span>{inv.inviteeName}</span>{' '}
              <span className="text-tertiary">
                {t(`invite.status.${inv.status}`, { date: date(inv.status === 'redeemed' && inv.redeemedAt ? inv.redeemedAt : inv.expiresAt) })}
              </span>{' '}
              {inv.status !== 'revoked' && (
                <button type="button" className="btn btn-secondary" onClick={() => void revoke(inv.invitationId)}
                  aria-label={t('invite.revokeFor', { name: inv.inviteeName })}>
                  {t('invite.revoke')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
