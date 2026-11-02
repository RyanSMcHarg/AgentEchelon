/**
 * THE CONFIRMATION CARD (ADR-061 decision 8, rule 8; DESIGN-ASSISTANT-MEETINGS B.2): what an assistant proposed and the
 * person it is addressed to confirms or declines. Rendered under the targeted message that carries the proposal's
 * handle on its Metadata, which only that person receives. Nothing happens until they answer: the server performs the
 * act, once, for them alone.
 *
 * A reminder (`send_nudge`) asks for the invitee's email address, because the platform stores none (K2); it is sent
 * with the answer and used for that one email. Every state is a settled, localized line, never a raw error, and the
 * outcome is announced in a `status` region without taking focus.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { decideProposal, ProposalError, type ProposalAnswer, type ProposalDecision } from '../services/proposalService';

export interface ProposalCardProps {
  proposal: { id: string; op: string; expiresAt: number };
  /** Opens a conversation by its id, for a proposal that opened one. */
  onOpenConversation?: (conversationId: string) => void;
  /** Injected in tests. */
  decide?: typeof decideProposal;
  now?: () => number;
}

type CardState =
  | { kind: 'open' }
  | { kind: 'deciding' }
  | { kind: 'done'; answer: ProposalAnswer }
  | { kind: 'error'; code: string; final: boolean };

/** Codes after which the proposal cannot be answered again. */
const FINAL_CODES = new Set(['PROPOSAL_DECIDED', 'PROPOSAL_EXPIRED', 'PROPOSAL_UNKNOWN', 'NOT_ADDRESSEE', 'NOT_A_PERSON', 'ROLE_NOT_HELD', 'NOT_A_MEMBER', 'ARCHIVED', 'ALREADY_NUDGED', 'INVITATION_NOT_PENDING']);

export function ProposalCard({ proposal, onOpenConversation, decide = decideProposal, now = Date.now }: ProposalCardProps) {
  const { t, i18n } = useTranslation();
  const addressId = useId();
  const helpId = useId();
  const [state, setState] = useState<CardState>({ kind: 'open' });
  const [address, setAddress] = useState('');
  const asksAddress = proposal.op === 'send_nudge';
  const expired = proposal.expiresAt * 1000 <= now();

  const answer = async (decision: ProposalDecision) => {
    if (decision === 'apply' && asksAddress && !address.trim()) {
      setState({ kind: 'error', code: 'ADDRESS_INVALID', final: false });
      return;
    }
    setState({ kind: 'deciding' });
    try {
      const result = await decide(proposal.id, decision, decision === 'apply' && asksAddress ? address.trim() : undefined);
      setState({ kind: 'done', answer: result });
    } catch (err) {
      const code = err instanceof ProposalError ? err.code : 'generic';
      setState({ kind: 'error', code, final: FINAL_CODES.has(code) });
    }
  };

  const errorLine = (code: string) => t(`proposal.error.${code}`, { defaultValue: t('proposal.error.generic') });
  const time = new Intl.DateTimeFormat(i18n.language || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(proposal.expiresAt * 1000));

  let status = '';
  if (state.kind === 'done') {
    if (state.answer.declined) status = t('proposal.declined');
    else if (proposal.op === 'send_nudge' && state.answer.sent === false) status = t('proposal.appliedNotSent');
    else status = t(`proposal.applied.${proposal.op}`, { defaultValue: t('proposal.applied.send_nudge') });
  } else if (state.kind === 'error') status = errorLine(state.code);
  else if (expired) status = t('proposal.error.PROPOSAL_EXPIRED');

  const settled = state.kind === 'done' || (state.kind === 'error' && state.final) || expired;
  const deciding = state.kind === 'deciding';
  const opened = state.kind === 'done' && typeof state.answer.channelArn === 'string' ? state.answer.channelArn.split('/').pop() : undefined;

  return (
    <div className="proposal-card" role="group" aria-label={t('proposal.label')} data-op={proposal.op} data-state={state.kind}>
      {!settled && (
        <>
          {asksAddress && (
            <div className="proposal-card-field">
              <label htmlFor={addressId}>{t('proposal.address')}</label>
              <input
                id={addressId}
                type="email"
                autoComplete="off"
                value={address}
                aria-describedby={helpId}
                aria-invalid={state.kind === 'error' && state.code === 'ADDRESS_INVALID' ? true : undefined}
                onChange={(e) => setAddress(e.target.value)}
                disabled={deciding}
              />
              <span id={helpId} className="proposal-card-help">{t('proposal.addressHelp')}</span>
            </div>
          )}
          <div className="proposal-card-actions">
            <button type="button" className="btn btn-primary" onClick={() => void answer('apply')} disabled={deciding} aria-busy={deciding || undefined}>
              {deciding ? t('proposal.deciding') : t('proposal.apply')}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => void answer('decline')} disabled={deciding}>
              {t('proposal.decline')}
            </button>
          </div>
          <span className="proposal-card-expiry">{t('proposal.expiresAt', { time })}</span>
        </>
      )}
      <div role="status" className="proposal-card-status">{status}</div>
      {opened && onOpenConversation && (
        <button type="button" className="btn btn-secondary" onClick={() => onOpenConversation(opened)}>{t('proposal.openConversation')}</button>
      )}
    </div>
  );
}
