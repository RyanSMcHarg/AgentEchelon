/**
 * THE TASK CARD (ADR-063 decision 2): the choices a workflow's task step offers the person it waits on, rendered under the
 * targeted message that carries the task's handle on its Metadata, which only that person receives. Pressing a choice
 * takes it, once, through the server, which checks it is still theirs to take. The person may also answer by writing in
 * the conversation. Every state is a settled, localized line, never a raw error, and the outcome is announced in a
 * `status` region without taking focus.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { chooseOnTaskCard, FORM_ANSWER_CHOICE, TaskCardError, type TaskCardOnMessage, readTaskDocuments, attachTaskDocument, reviseTaskDocument, type TaskDocumentOnCard } from '../services/taskCardService';

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
  /** Its task is no longer open for this person in the state the card asks from: it is drawn finished, with no choices. */
  closed?: boolean;
  /** The versions of the document it approves, and attaching one; the defaults call the person API. */
  documents?: {
    read: typeof readTaskDocuments; attach: typeof attachTaskDocument; upload: (file: File) => Promise<{ fileKey: string; name: string }>;
    revise?: typeof reviseTaskDocument;
  };
  /** Changes when an assistant's file arrives in the conversation, so a revision the assistant delivered is read without polling. */
  refreshKey?: number;
}

type CardState = { kind: 'open' } | { kind: 'choosing' } | { kind: 'done'; choice: string } | { kind: 'asked' } | { kind: 'error'; code: string; final: boolean };

/** Codes after which the card cannot be answered again. */
// The conversation access refusals (`NOT_A_MEMBER`, `NOT_CLEARED`, `CLASSIFICATION_UNREADABLE`, `NOT_A_PERSON_SESSION`)
// are final; `UNAVAILABLE` is an outage, so the card stays open to try again.
const FINAL_CODES = new Set(['NOT_FOUND', 'NOT_ASSIGNEE', 'SETTLED', 'STATE_MOVED', 'NOT_A_MEMBER', 'CONVERSATION_ARCHIVED',
  'NOT_CLEARED', 'CLASSIFICATION_UNREADABLE', 'NOT_A_PERSON_SESSION']);

export function TaskCard({ card, channelArn, body, onAnswered, choose = chooseOnTaskCard, now = Date.now, closed = false, documents, refreshKey }: TaskCardProps) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<CardState>({ kind: 'open' });
  /** A form's answers as the person writes them (WT50), sent with its answer choice. */
  const [answers, setAnswers] = useState<Record<string, string | number | boolean>>({});
  const fields = card.fields ?? [];
  const missing = fields.some((f) => f.required && (answers[f.name] === undefined || answers[f.name] === ''));
  const expired = card.expiresAt !== undefined && card.expiresAt * 1000 <= now();

  // THE DOCUMENT IT APPROVES: its versions, read from the task, and the newest is the one an approval names.
  const [versions, setVersions] = useState<TaskDocumentOnCard[] | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [docError, setDocError] = useState('');
  const docs = card.documents && documents ? documents : null;
  useEffect(() => {
    if (!docs || closed) return;
    let live = true;
    void docs.read(channelArn, card.id).then((v) => { if (live) setVersions(v); }).catch(() => { if (live) setDocError(t('taskCard.documents.unreadable')); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, channelArn, closed, refreshKey]);
  // A REVISION ASKED OF THE ASSISTANT THAT DRAFTED IT (stage 2): the approver's instructions; its file arrives as the next version.
  const [instructions, setInstructions] = useState('');
  const [revising, setRevising] = useState<'idle' | 'asking' | 'asked'>('idle');
  const askedAtVersions = useRef(0);
  useEffect(() => { if (revising === 'asked' && (versions?.length ?? 0) > askedAtVersions.current) setRevising('idle'); }, [versions, revising]);
  const onRevise = async () => {
    if (!docs?.revise || !instructions.trim()) return;
    setRevising('asking');
    setDocError('');
    try {
      askedAtVersions.current = versions?.length ?? 0;
      await docs.revise(channelArn, card.id, instructions.trim());
      setInstructions('');
      setRevising('asked');
    } catch (err) {
      setRevising('idle');
      setDocError(t(`taskCard.documents.error.${err instanceof TaskCardError ? err.code : 'generic'}`, { defaultValue: t('taskCard.documents.error.generic') }));
    }
  };
  const latest = versions?.length ? versions[versions.length - 1] : undefined;
  const onAttach = async (file: File | undefined) => {
    if (!file || !docs) return;
    setAttaching(true);
    setDocError('');
    try {
      const up = await docs.upload(file);
      setVersions(await docs.attach(channelArn, card.id, up.fileKey, up.name));
    } catch (err) {
      setDocError(t(`taskCard.documents.error.${err instanceof TaskCardError ? err.code : 'generic'}`, { defaultValue: t('taskCard.documents.error.generic') }));
    } finally {
      setAttaching(false);
    }
  };

  const take = async (choice: string) => {
    setState({ kind: 'choosing' });
    try {
      // AN APPROVAL NAMES THE VERSION SHOWN, which the server holds to the latest.
      const document = docs && choice === 'approved' ? latest?.fileKey : undefined;
      const formAnswers = fields.length && choice === FORM_ANSWER_CHOICE ? answers : undefined;
      const moved = document ? await choose(channelArn, card, choice, formAnswers, document)
        : formAnswers ? await choose(channelArn, card, choice, formAnswers) : await choose(channelArn, card, choice);
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
  else if (closed) status = t('taskCard.error.SETTLED');
  const settled = state.kind === 'done' || state.kind === 'asked' || (state.kind === 'error' && state.final) || expired || closed;
  const choosing = state.kind === 'choosing';
  const time = card.expiresAt !== undefined
    ? new Intl.DateTimeFormat(i18n.language || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(card.expiresAt * 1000))
    : '';

  return (
    <div className="proposal-card task-card" role="group" aria-label={t('taskCard.label')} data-state={state.kind}>
      {body && <div className="task-card-body">{body}</div>}
      {docs && !settled && (
        <div className="task-card-documents" data-testid="task-card-documents">
          {latest ? (
            <p className="proposal-card-help" data-testid="task-card-approves">
              {t('taskCard.documents.approves', { name: latest.name })}{' '}
              <span>{latest.by.startsWith('assistant:') ? t('taskCard.documents.byAssistant') : t('taskCard.documents.byYou')}</span>
            </p>
          ) : versions ? <p className="proposal-card-help">{t('taskCard.documents.none')}</p> : null}
          <label className="btn btn-secondary task-card-attach">
            {attaching ? t('taskCard.documents.attaching') : t('taskCard.documents.attach')}
            <input type="file" accept=".md,.markdown,text/markdown" hidden disabled={attaching} data-testid="task-card-attach"
              onChange={(e) => { void onAttach(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {docs.revise && latest?.by && (
            <div className="task-card-revise">
              <textarea className="input" rows={2} value={instructions} maxLength={2000} data-testid="task-card-revise-instructions"
                placeholder={t('taskCard.documents.revisePlaceholder')} aria-label={t('taskCard.documents.revisePlaceholder')}
                disabled={revising !== 'idle'} onChange={(e) => setInstructions(e.target.value)} />
              <button type="button" className="btn btn-secondary" data-testid="task-card-revise" disabled={revising !== 'idle' || !instructions.trim()} onClick={() => void onRevise()}>
                {t('taskCard.documents.revise')}
              </button>
              {revising === 'asked' && <span role="status" className="proposal-card-help" data-testid="task-card-revise-asked">{t('taskCard.documents.reviseAsked')}</span>}
            </div>
          )}
          {docError && <span role="status" className="proposal-card-status">{docError}</span>}
        </div>
      )}
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
                // AN APPROVAL OF A DOCUMENT WAITS FOR ITS VERSIONS: it names the one it approves, so it is not offered before they are read.
                disabled={choosing || (choice === FORM_ANSWER_CHOICE && fields.length > 0 && missing) || (!!docs && choice === 'approved' && !latest)} aria-busy={choosing || undefined}>
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
