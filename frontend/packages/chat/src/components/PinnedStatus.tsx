/**
 * WHAT A CONVERSATION KEEPS AT ITS TOP: the newest dashboard its assistant published, pinned above the
 * messages, so an incident's people see where it stands without scrolling: whether it is open, the alarm's state, who is on
 * call, secondary and leading, and the dashboard one press away. Its open steps are the dashboard's, which lists every one.
 *
 * Drawn from the dashboard message alone, which every member already reads: no further read, and nothing polls. It follows
 * the message, which its assistant updates in place as the incident moves.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Message } from '@ae/shared';
import { DashboardCard } from './DashboardCard';
import { TaskCardError } from '../services/taskCardService';
import './PinnedStatus.css';

/** The newest dashboard in the conversation, or undefined where it holds none. */
export function pinnedDashboardOf(messages: readonly Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].dashboard) return messages[i];
  return undefined;
}

/** A role key as a reader sees it: `on-call:ops` is the on-call, in the reader's language where the deployment words it. */
function roleBase(role: string): string {
  return role.split(':')[0];
}

/**
 * THE PINNED STEP'S CHOICES, for those who decide it: each is confirmed before it is sent, and the task service
 * holds the press to the step's roles again. Labelled by the step's own choices, so any pinned step offers what its machine
 * declares: a choice reads as its state's word, and a reopen as "Reopen".
 */
function Decision({ decide, onDecide }: {
  decide: NonNullable<NonNullable<Message['dashboard']>['decide']>;
  onDecide: (choice: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const words = (s: string) => s.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const label = (choice: string) => decide.reopen ? t('pinned.reopen') : t(`pinned.choice.${choice}`, { defaultValue: words(choice) });
  const send = async (choice: string) => {
    setBusy(true); setError(null);
    // A REFUSAL IS SAID AS A TASK CARD SAYS IT, by its code in the reader's language; one the locale does not word is said generically.
    try { await onDecide(choice); setAsking(null); } catch (e) {
      setError(t(`taskCard.error.${e instanceof TaskCardError ? e.code : 'generic'}`, { defaultValue: t('taskCard.error.generic') }));
    } finally { setBusy(false); }
  };
  return (
    <div className="pinned-status-decide" data-testid="pinned-decide">
      {asking ? (<>
        <span className="pinned-status-confirm">{t('pinned.confirm', { choice: label(asking) })}</span>
        <button type="button" className="ae-button ae-button--primary" disabled={busy} onClick={() => void send(asking)} data-testid="pinned-confirm">{label(asking)}</button>
        <button type="button" className="ae-button" disabled={busy} onClick={() => { setAsking(null); setError(null); }}>{t('pinned.cancel')}</button>
      </>) : decide.choices.map((c) => (
        <button key={c} type="button" className="ae-button" onClick={() => setAsking(c)} data-testid={`pinned-choice-${c}`}>{label(c)}</button>
      ))}
      {error && <span className="pinned-status-error" role="alert">{error}</span>}
    </div>
  );
}

export function PinnedStatus({ messages, channelArn, conversationName, personId, onDecide }: {
  messages: readonly Message[]; channelArn: string; conversationName?: string;
  /** The signed-in person's id: the band offers the pinned step's choices where they may decide it. */
  personId?: string;
  /** Takes a choice on the pinned step, confirmed in the band. */
  onDecide?: (decision: { taskId: string; state: string }, choice: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const pinned = pinnedDashboardOf(messages);
  const dashboard = pinned?.dashboard;
  if (!dashboard) return null;
  const words = (base: string) => base.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return (
    <section className="pinned-status" aria-label={t('pinned.label')} data-testid="pinned-status">
      <div className="pinned-status-lines">
        {dashboard.standing && (
          <p className={`pinned-status-standing pinned-status-standing--${dashboard.standing}`} data-testid="pinned-standing">
            <span className="pinned-status-key">{t('pinned.standingKey')}</span>{' '}
            <span>{t(`pinned.standing.${dashboard.standing}`)}</span>
          </p>
        )}
        {dashboard.state && (
          <p className={`pinned-status-alarm pinned-status-alarm--${dashboard.state}`} data-testid="pinned-alarm">
            <span className="pinned-status-key">{t('pinned.alarmKey')}</span>{' '}
            <span>{t(`pinned.alarm.${dashboard.state}`, { defaultValue: t(`dashboard.state.${dashboard.state}`) })}</span>
            {dashboard.state === 'OK' && dashboard.standing === 'open' && <span className="pinned-status-hint">{' '}{t('pinned.recoveredOpen')}</span>}
          </p>
        )}
        {dashboard.people?.length ? (
          <ul className="pinned-status-people" data-testid="pinned-people">
            {dashboard.people.map((p) => (
              <li key={p.role}>
                <span className="pinned-status-key">{t(`pinned.role.${roleBase(p.role)}`, { defaultValue: words(roleBase(p.role)) })}</span>{' '}
                <span>{p.name}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {dashboard.decide && onDecide && personId && dashboard.decide.by.includes(personId) && (
        <Decision key={`${dashboard.decide.taskId}:${dashboard.decide.state}`} decide={dashboard.decide} onDecide={(choice) => onDecide(dashboard.decide!, choice)} />
      )}
      <DashboardCard dashboard={dashboard} channelArn={channelArn} conversationName={conversationName} compact />
    </section>
  );
}
