/**
 * THE TASK CARD (ADR-063 decision 2): the choices a workflow's task step offers the person it waits on, rendered under the
 * targeted message that carries the task's handle on its Metadata, which only that person receives. Pressing a choice
 * takes it, once, through the server, which checks it is still theirs to take. The person may also answer by writing in
 * the conversation. Every state is a settled, localized line, never a raw error, and the outcome is announced in a
 * `status` region without taking focus.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { chooseOnTaskCard, FORM_ANSWER_CHOICE, TaskCardError, type TaskCardOnMessage } from '../services/taskCardService';

export interface TaskCardProps {
  card: TaskCardOnMessage;
  channelArn: string;
  /** The message the card rides on, drawn as the card's own content above its choices. */
  body?: ReactNode;
  /** Called once the task took the answer, so the person's open items are read again at once. */
  onAnswered?: () => void;
  /** Injected in tests. */
  choose?: typeof chooseOnTaskCard;
  now?: () => number;
}

type CardState = { kind: 'open' } | { kind: 'choosing' } | { kind: 'done'; choice: string } | { kind: 'asked' } | { kind: 'error'; code: string; final: boolean };

/** Codes after which the card cannot be answered again. */
// The conversation access refusals (`NOT_A_MEMBER`, `NOT_CLEARED`, `CLASSIFICATION_UNREADABLE`, `NOT_A_PERSON_SESSION`)
// are final; `UNAVAILABLE` is an outage, so the card stays open to try again.
const FINAL_CODES = new Set(['NOT_FOUND', 'NOT_ASSIGNEE', 'SETTLED', 'STATE_MOVED', 'NOT_A_MEMBER', 'CONVERSATION_ARCHIVED',
  'NOT_CLEARED', 'CLASSIFICATION_UNREADABLE', 'NOT_A_PERSON_SESSION']);

export function TaskCard({ card, channelArn, body, onAnswered, choose = chooseOnTaskCard, now = Date.now }: TaskCardProps) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<CardState>({ kind: 'open' });
  /** A form's answers as the person writes them (WT50), sent with its answer choice. */
  const [answers, setAnswers] = useState<Record<string, string | number | boolean>>({});
  const fields = card.fields ?? [];
  const missing = fields.some((f) => f.required && (answers[f.name] === undefined || answers[f.name] === ''));
  const expired = card.expiresAt !== undefined && card.expiresAt * 1000 <= now();

  const take = async (choice: string) => {
    setState({ kind: 'choosing' });
    try {
      const moved = await choose(channelArn, card, choice, ...(fields.length && choice === FORM_ANSWER_CHOICE ? [answers] : []));
      // A CHOICE THE TASK TOOK TO ANOTHER STATE asks something first (a confirmation), on the card that follows.
      setState(moved?.state && moved.state !== choice ? { kind: 'asked' } : { kind: 'done', choice });
      // THE OPEN ITEMS FOLLOW THE ANSWER AT ONCE, not when the assistant next speaks.
      onAnswered?.();
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
  else if (state.kind === 'asked') status = t('taskCard.asked');
  else if (state.kind === 'error') status = t(`taskCard.error.${state.code}`, { defaultValue: t('taskCard.error.generic') });
  else if (expired) status = t('taskCard.expired');
  const settled = state.kind === 'done' || state.kind === 'asked' || (state.kind === 'error' && state.final) || expired;
  const choosing = state.kind === 'choosing';
  const time = card.expiresAt !== undefined
    ? new Intl.DateTimeFormat(i18n.language || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(card.expiresAt * 1000))
    : '';

  return (
    <div className="proposal-card task-card" role="group" aria-label={t('taskCard.label')} data-state={state.kind}>
      {body && <div className="task-card-body">{body}</div>}
      {!settled && (
        <>
          {/* A FORM'S FIELDS (WT50), each by its name in the reader's language where the deployment words it. */}
          {fields.length > 0 && (
            <div className="task-card-fields">
              {fields.map((f) => {
                const label = t(`taskCard.field.${f.name}`, { defaultValue: f.name.replace(/_/g, ' ') });
                const id = `task-card-${card.id}-${f.name}`;
                return (
                  <label key={f.name} htmlFor={id} className="task-card-field">
                    <span>{label}{f.required ? ' *' : ''}</span>
                    {f.type === 'yes-no' ? (
                      <input id={id} type="checkbox" checked={answers[f.name] === true}
                        onChange={(e) => setAnswers((a) => ({ ...a, [f.name]: e.target.checked }))} />
                    ) : f.type === 'number' ? (
                      <input id={id} type="number" className="input" value={answers[f.name] === undefined ? '' : String(answers[f.name])}
                        onChange={(e) => setAnswers((a) => {
                          const { [f.name]: _drop, ...rest } = a;
                          return e.target.value === '' ? rest : { ...rest, [f.name]: Number(e.target.value) };
                        })} />
                    ) : (
                      <textarea id={id} className="textarea" rows={2} maxLength={2000} value={String(answers[f.name] ?? '')}
                        onChange={(e) => setAnswers((a) => ({ ...a, [f.name]: e.target.value }))} />
                    )}
                  </label>
                );
              })}
            </div>
          )}
          <div className="proposal-card-actions">
            {card.choices.map((choice) => (
              <button key={choice} type="button" className="btn btn-primary" onClick={() => void take(choice)}
                disabled={choosing || (choice === FORM_ANSWER_CHOICE && fields.length > 0 && missing)} aria-busy={choosing || undefined}>
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
