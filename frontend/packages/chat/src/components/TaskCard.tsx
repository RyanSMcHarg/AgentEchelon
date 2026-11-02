/**
 * THE TASK CARD (ADR-063 decision 2): the choices a workflow's task step offers the person it waits on, rendered under the
 * targeted message that carries the task's handle on its Metadata, which only that person receives. Pressing a choice
 * takes it, once, through the server, which checks it is still theirs to take. The person may also answer by writing in
 * the conversation. Every state is a settled, localized line, never a raw error, and the outcome is announced in a
 * `status` region without taking focus.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { chooseOnTaskCard, TaskCardError, type TaskCardOnMessage } from '../services/taskCardService';

export interface TaskCardProps {
  card: TaskCardOnMessage;
  channelArn: string;
  /** Injected in tests. */
  choose?: typeof chooseOnTaskCard;
  now?: () => number;
}

type CardState = { kind: 'open' } | { kind: 'choosing' } | { kind: 'done'; choice: string } | { kind: 'error'; code: string; final: boolean };

/** Codes after which the card cannot be answered again. */
const FINAL_CODES = new Set(['NOT_FOUND', 'NOT_ASSIGNEE', 'SETTLED', 'STATE_MOVED', 'NOT_A_MEMBER', 'CONVERSATION_ARCHIVED']);

export function TaskCard({ card, channelArn, choose = chooseOnTaskCard, now = Date.now }: TaskCardProps) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<CardState>({ kind: 'open' });
  const expired = card.expiresAt !== undefined && card.expiresAt * 1000 <= now();

  const take = async (choice: string) => {
    setState({ kind: 'choosing' });
    try {
      await choose(channelArn, card, choice);
      setState({ kind: 'done', choice });
    } catch (err) {
      const code = err instanceof TaskCardError ? err.code : 'generic';
      setState({ kind: 'error', code, final: FINAL_CODES.has(code) });
    }
  };

  // A CHOICE IS A STATE NAME THE MACHINE DECLARES, labelled in the reader's language where the deployment words it, and
  // shown as written otherwise.
  const label = (choice: string) => t(`taskCard.choice.${choice}`, { defaultValue: choice.replace(/_/g, ' ') });
  let status = '';
  if (state.kind === 'done') status = t('taskCard.done', { choice: label(state.choice) });
  else if (state.kind === 'error') status = t(`taskCard.error.${state.code}`, { defaultValue: t('taskCard.error.generic') });
  else if (expired) status = t('taskCard.expired');
  const settled = state.kind === 'done' || (state.kind === 'error' && state.final) || expired;
  const choosing = state.kind === 'choosing';
  const time = card.expiresAt !== undefined
    ? new Intl.DateTimeFormat(i18n.language || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(card.expiresAt * 1000))
    : '';

  return (
    <div className="proposal-card task-card" role="group" aria-label={t('taskCard.label')} data-state={state.kind}>
      {!settled && (
        <>
          <div className="proposal-card-actions">
            {card.choices.map((choice) => (
              <button key={choice} type="button" className="btn btn-primary" onClick={() => void take(choice)} disabled={choosing} aria-busy={choosing || undefined}>
                {label(choice)}
              </button>
            ))}
          </div>
          <span className="proposal-card-help">{t('taskCard.orReply')}</span>
          {time && <span className="proposal-card-expiry">{t('taskCard.expiresAt', { time })}</span>}
        </>
      )}
      <div role="status" className="proposal-card-status">{status}</div>
    </div>
  );
}
