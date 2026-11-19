/**
 * WHERE A MEETING WAS HELD AND WHAT WAS SAID IN IT (SPEC-ASSISTANT-MEETINGS FR46): the meeting's
 * info, its conversation, the conversation it was started from, and its summary:
 *
 *  - its conversation and the room it was started from, each by the name the console lists conversations under and each
 *    opening in the console's conversation viewer; who started it and its hosts, by id; how it was started and the
 *    conversation's type; and the Region its media was hosted in;
 *  - its transcript and summary, which are conversation content: the detail says only whether each was written, and
 *    reading them asks for the operator's reason (`view-events`), which the access log records before the read. Each
 *    action item the summary holds links to its task on the room, with the person it is assigned to by id.
 *
 * People are shown by id, never by name.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCan } from '../../capabilities';
import { findAdminConversation } from '../../services/adminConversationService';
import { fetchMeetingContent, type MeetingAnswer, type MeetingContent, type MeetingSummaryContent } from '../../services/meetingAnalyticsService';
import { ReasonDeclinedError } from '../../services/adminReason';
import { meetingErrorText } from './meetingFormat';

/**
 * Each conversation's name, read once per console session; a read in flight is shared. A read that fails is forgotten,
 * so the next showing of that conversation asks again.
 */
const names = new Map<string, Promise<string | null>>();
function nameOf(channelArn: string): Promise<string | null> {
  let p = names.get(channelArn);
  if (!p) {
    p = findAdminConversation(channelArn.split('/').pop() || channelArn).then((c) => c?.name ?? null).catch(() => {
      names.delete(channelArn);
      return null;
    });
    names.set(channelArn, p);
  }
  return p;
}
/** Forget the names read (a test). */
export function clearConversationNames(): void { names.clear(); }

/**
 * A CONVERSATION BY ITS NAME, as the console's conversation list shows it, where the operator may look conversations up
 * (`find-conversation`); else, and until the name arrives, by its id. With `onOpen`, it opens in the conversation viewer.
 */
export const ConversationName: React.FC<{ channelArn: string; onOpen?: (channelArn: string) => void }> = ({ channelArn, onOpen }) => {
  const { t } = useTranslation();
  const can = useCan();
  const mayFind = can('find-conversation');
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setName(null);
    if (mayFind && channelArn) void nameOf(channelArn).then((n) => { if (live) setName(n); });
    return () => { live = false; };
  }, [channelArn, mayFind]);
  const id = channelArn.split('/').pop() || channelArn;
  const label = name ?? id;
  if (!onOpen) return <span title={id} data-testid="conversation-name">{name ?? <code>{id}</code>}</span>;
  return (
    <button
      type="button" className="meetings-link" data-testid="conversation-link" title={id}
      aria-label={t('admin.meetings.context.openConversation', { name: label })}
      onClick={() => onOpen(channelArn)}
    >
      {name ?? <code>{id}</code>}
    </button>
  );
};

/** The detail's context: the meeting's conversation and room, who started and hosts it, how, and where its media ran. */
export const MeetingContextPanel: React.FC<{ detail: MeetingAnswer; onOpenConversation?: (channelArn: string) => void }> = ({ detail, onOpenConversation }) => {
  const { t } = useTranslation();
  const m = detail.meeting;
  const c = detail.conversation ?? null;
  const ids = (xs: string[]) => (xs.length ? xs.map((x, i) => <React.Fragment key={x}>{i > 0 && ', '}<code>{x}</code></React.Fragment>) : '-');
  return (
    <section className="admin-panel" data-testid="meeting-context">
      <h3>{t('admin.meetings.context.title')}</h3>
      <dl className="meetings-facts">
        <dt>{t('admin.meetings.context.conversation')}</dt>
        <dd>{m.channelArn ? <ConversationName channelArn={m.channelArn} onOpen={onOpenConversation} /> : '-'}</dd>
        <dt>{t('admin.meetings.context.room')}</dt>
        <dd data-testid="meeting-room">{c?.room ? <ConversationName channelArn={c.room.channelArn} onOpen={onOpenConversation} /> : t('admin.meetings.context.noRoom')}</dd>
        <dt>{t('admin.meetings.context.source')}</dt>
        <dd>
          {m.startedVia ? t(`admin.meetings.via.${m.startedVia}`) : t('admin.meetings.via.unknown')}
          {c?.room?.type && <> · <span className="meetings-muted">{t('admin.meetings.context.fromType', { type: c.room.type })}</span></>}
        </dd>
        <dt>{t('admin.meetings.context.type')}</dt>
        <dd>{c?.type ? <code>{c.type}</code> : '-'}</dd>
        <dt>{t('admin.meetings.context.creator')}</dt>
        <dd data-testid="meeting-creator">{m.createdBy ? <code>{m.createdBy}</code> : '-'}</dd>
        <dt>{t('admin.meetings.context.hosts')}</dt>
        <dd data-testid="meeting-hosts">{ids(m.hosts ?? [])}</dd>
        <dt>{t('admin.meetings.context.region')}</dt>
        <dd data-testid="meeting-region">{m.mediaRegion ? <code>{m.mediaRegion}</code> : '-'}</dd>
        <dt>{t('admin.meetings.context.classification')}</dt>
        <dd><code>{m.classification}</code></dd>
        <dt>{t('admin.meetings.context.meetingId')}</dt>
        <dd><code>{m.meetingId}</code></dd>
      </dl>
    </section>
  );
};

type ContentState = { kind: 'idle' } | { kind: 'reading' } | { kind: 'read'; content: MeetingContent } | { kind: 'none' } | { kind: 'failed'; message: string };

/** A list under its heading, or nothing when it is empty. */
const Listed: React.FC<{ title: string; items: string[]; testId: string }> = ({ title, items, testId }) => (items.length ? (
  <div data-testid={testId}><h4>{title}</h4><ul>{items.map((x, i) => <li key={`${i}-${x}`}>{x}</li>)}</ul></div>
) : null);

/**
 * THE SUMMARY THE ROUTER WROTE: what was said, its key points, next steps and topics, and its action items. An item with a
 * task opens the room the task is on, where it is tracked; the person it is assigned to, or the host holding it, by id.
 */
const SummaryView: React.FC<{ summary: MeetingSummaryContent; roomArn: string | null; onOpenConversation?: (channelArn: string) => void }> = ({ summary, roomArn, onOpenConversation }) => {
  const { t } = useTranslation();
  return (
    <div className="meetings-summary" data-testid="meeting-summary">
      <h4>{t('admin.meetings.transcript.summary')}</h4>
      <p className="meetings-summary-text">{summary.summary}</p>
      <Listed title={t('admin.meetings.transcript.keyPoints')} items={summary.keyPoints} testId="summary-key-points" />
      <Listed title={t('admin.meetings.transcript.nextSteps')} items={summary.nextSteps} testId="summary-next-steps" />
      {summary.topics.length > 0 && <p className="meetings-muted">{t('admin.meetings.transcript.topics', { topics: summary.topics.join(', ') })}</p>}
      {summary.actionItems.length > 0 && (
        <div data-testid="summary-action-items">
          <h4>{t('admin.meetings.transcript.actionItems')}</h4>
          <ul className="meetings-action-items">
            {summary.actionItems.map((a, i) => (
              <li key={`${i}-${a.text}`} data-testid="action-item">
                <span>{a.text}</span>
                {a.assignee && <>{SEP}{t('admin.meetings.transcript.assignedTo')} <code>{a.assignee}</code></>}
                {!a.assignee && a.heldBy && <>{SEP}{t('admin.meetings.transcript.heldBy')} <code>{a.heldBy}</code></>}
                {a.due && <>{SEP}{t('admin.meetings.transcript.due', { day: a.due })}</>}
                {a.taskId && (roomArn && onOpenConversation ? (
                  <>{SEP}<button type="button" className="meetings-link" data-testid="action-item-task" onClick={() => onOpenConversation(roomArn)} title={t('admin.meetings.transcript.taskIn')}>
                    {t('admin.meetings.transcript.task', { id: a.taskId })}
                  </button></>
                ) : <>{SEP}<code data-testid="action-item-task">{t('admin.meetings.transcript.task', { id: a.taskId })}</code></>)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
const SEP = ' · ';

/**
 * WHAT WAS SAID: THE MEETING'S TRANSCRIPT AND SUMMARY. Whether each was written is part of the detail; what they say is
 * read only on the operator's request, under `view-events`, with their reason. Without the capability, the panel says
 * what exists and what reading it needs, and reads nothing.
 */
export const TranscriptPanel: React.FC<{ detail: MeetingAnswer; days: number; onOpenConversation?: (channelArn: string) => void }> = ({ detail, days, onOpenConversation }) => {
  const { t } = useTranslation();
  const can = useCan();
  const m = detail.meeting;
  const [state, setState] = useState<ContentState>({ kind: 'idle' });
  // Each answer read for the meeting (opening it, Refresh) starts the panel over, so a read made before the transcript was
  // written can be made again.
  useEffect(() => { setState({ kind: 'idle' }); }, [detail]);
  const ended = Boolean(m.endedAt) || m.live === false;
  const summarized = detail.conversation?.summarized === true;
  // Captions alone keep no transcript: the record says whether recording mode ran at some point.
  const captionsOnly = !summarized && detail.conversation?.transcriptKept === false;
  const mayRead = can('view-events');
  // An action item's task is on the room the meeting was started from; a meeting held in its room is its own room.
  const roomArn = detail.conversation?.room?.channelArn ?? (detail.conversation ? m.channelArn : null);

  const read = async () => {
    setState({ kind: 'reading' });
    try {
      const content = await fetchMeetingContent(m.meetingId, m.channelArn, days);
      setState(content === null ? { kind: 'none' } : { kind: 'read', content });
    } catch (e) {
      if (e instanceof ReasonDeclinedError) setState({ kind: 'idle' });
      else {
        setState({ kind: 'failed', message: meetingErrorText(e, 'admin.meetings.transcript.failed') });
      }
    }
  };

  let body: React.ReactNode;
  if (!m.transcribed && !summarized) {
    body = <p className="meetings-muted" data-testid="transcript-absent">{t(m.people <= 1 ? 'admin.meetings.transcript.notTranscribedAlone' : 'admin.meetings.transcript.notTranscribed')}</p>;
  } else if (captionsOnly) {
    body = <p className="meetings-muted" data-testid="transcript-absent">{t('admin.meetings.transcript.captionsOnly')}</p>;
  } else if (!ended) {
    body = <p className="meetings-muted" data-testid="transcript-absent">{t('admin.meetings.transcript.afterEnd')}</p>;
  } else if (state.kind === 'read') {
    const { transcript, summary } = state.content;
    body = (
      <>
        {summary ? <SummaryView summary={summary} roomArn={roomArn} onOpenConversation={onOpenConversation} />
          : <p className="meetings-muted" data-testid="summary-absent">{t('admin.meetings.transcript.noSummary')}</p>}
        {transcript !== null ? (
          <>
            <h4>{t('admin.meetings.transcript.title')}</h4>
            <pre className="meetings-transcript" data-testid="transcript-text">{transcript}</pre>
          </>
        ) : <p className="meetings-muted" data-testid="transcript-absent">{t('admin.meetings.transcript.noneWritten')}</p>}
      </>
    );
  } else {
    body = (
      <>
        {state.kind === 'none' ? (
          <p className="meetings-muted" data-testid="transcript-absent">{t('admin.meetings.transcript.notWrittenYet')}</p>
        ) : (
          <p className="meetings-muted" data-testid="transcript-exists">
            {t(summarized ? 'admin.meetings.transcript.existsWithSummary' : 'admin.meetings.transcript.exists')}
          </p>
        )}
        {mayRead ? (
          <button type="button" className="btn-secondary" disabled={state.kind === 'reading'} onClick={() => { void read(); }} data-testid="read-transcript">
            {state.kind === 'reading' ? t('admin.meetings.transcript.reading') : t('admin.meetings.transcript.read')}
          </button>
        ) : (
          <p className="meetings-muted" data-testid="transcript-needs-capability">{t('admin.meetings.transcript.needsCapability')}</p>
        )}
        {state.kind === 'failed' && <div className="admin-error" role="alert">{state.message}</div>}
      </>
    );
  }
  return (
    <section className="admin-panel" data-testid="meeting-transcript">
      <h3>{t('admin.meetings.transcript.sectionTitle')}</h3>
      {body}
    </section>
  );
};
