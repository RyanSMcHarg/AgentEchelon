/**
 * MEETINGS (`view-meeting-analytics`): how the window's meetings went, and each meeting in full (SPEC-ASSISTANT-MEETINGS
 * FR22 to FR26, FR45 to FR47). The overview draws the server's figures (`MeetingsOverview`); a meeting opens to its
 * roster, a timeline of everything recorded about it (`MeetingTimeline`) and each attendee's connection
 * (`MeetingQualityCharts`). Every figure is derived on the server from the recorded events and carries the population it is
 * over; one over too little shows as a dash with that population, never as zero (FR23). The tab says when an answer is
 * missing rows or a classification, rather than showing smaller numbers as if complete.
 *
 * PEOPLE ARE SHOWN BY THEIR ID. The record keys a person by their AppInstanceUser id and the tab shows that id; it looks
 * up no names.
 *
 * THE DASHBOARD DETAIL (SPEC-ASSISTANT-MEETINGS FR68), beside all of that: a meeting's conversation and room
 * (opening in the conversation viewer), its creator, hosts, type and media Region, its transcript under the content
 * capability, its quality bar, each person's expandable panel, its start, end, join and leave times, a Refresh button,
 * and a link to one meeting (`?admin=meetings&meeting=<id>`). The tab reads the server when it opens, when the window
 * changes and when the operator refreshes; a running meeting's length follows the viewer's clock between (tenet D6).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import MeetingsOverview, { MeetingState } from './MeetingsOverview';
import MeetingTimeline, { type TimelineBand } from './MeetingTimeline';
import MeetingQualityCharts from './MeetingQualityCharts';
import MeetingExperience from './MeetingExperience';
import { MeetingContextPanel, TranscriptPanel } from './MeetingContext';
import { MeetingQuality, PeopleInDetail, QualityWithReasons, failureTexts } from './MeetingPeople';
import { RunningFor } from './RunningFor';
import { buildTimeline, connectivityLanes } from './meetingLanes';
import { issueKey, viewAround, type TimeView } from './meetingView';
import { clockTime, formatSeconds, meetingErrorText, msText } from './meetingFormat';
import {
  endMeetingForEveryone, fetchMeeting, fetchMeetings, type ExperienceIssue, type MeetingAnswer, type MeetingsAnswer, type RosterRow,
} from '../../services/meetingAnalyticsService';
import { ReasonDeclinedError } from '../../services/adminReason';
import { useCan } from '../../capabilities';
import './MeetingsTab.css';

export { figureText, formatSeconds } from './meetingFormat';

const DAY_CHOICES = [1, 7, 30] as const;

/** The meeting a link names (`?meeting=<id>`), when it names one. */
const MEETING_PARAM = 'meeting';
/** The window the open meeting was read in (`?meetingDays=<n>`), so a link reopens it over the same days. */
const MEETING_DAYS_PARAM = 'meetingDays';
const MEETING_ID = /^[A-Za-z0-9-]{1,64}$/;
function meetingFromUrl(): string | null {
  const id = new URL(window.location.href).searchParams.get(MEETING_PARAM);
  return id && MEETING_ID.test(id) ? id : null;
}
/** The window a link names when it names one of the choices, else the default week. */
function daysFromUrl(): number {
  const n = Number(new URL(window.location.href).searchParams.get(MEETING_DAYS_PARAM));
  return (DAY_CHOICES as readonly number[]).includes(n) ? n : 7;
}
/** Write the open meeting and its window into the address, so it can be shared and reopened; none removes both. */
function writeMeetingToUrl(id: string | null, days?: number): void {
  const url = new URL(window.location.href);
  const nextDays = id && days !== undefined ? String(days) : null;
  if ((url.searchParams.get(MEETING_PARAM) ?? null) === id && (url.searchParams.get(MEETING_DAYS_PARAM) ?? null) === nextDays) return;
  if (id) url.searchParams.set(MEETING_PARAM, id); else url.searchParams.delete(MEETING_PARAM);
  if (nextDays) url.searchParams.set(MEETING_DAYS_PARAM, nextDays); else url.searchParams.delete(MEETING_DAYS_PARAM);
  window.history.replaceState(window.history.state, '', url);
}

/** What the answer is missing, said before anything is read off it. */
const Coverage: React.FC<{ answer: { truncated: boolean; unreadClassifications: string[] } }> = ({ answer }) => {
  const { t } = useTranslation();
  return (
    <>
      {answer.truncated && <div className="admin-info-banner" role="status">{t('admin.meetings.truncated')}</div>}
      {answer.unreadClassifications.length > 0 && (
        <div className="admin-info-banner" role="status">{t('admin.meetings.unread', { classifications: answer.unreadClassifications.join(', ') })}</div>
      )}
    </>
  );
};

const Roster: React.FC<{ roster: RosterRow[] }> = ({ roster }) => {
  const { t } = useTranslation();
  return (
    <DataTable
      data={roster as unknown as Record<string, unknown>[]}
      emptyMessage={t('admin.meetings.noRoster')}
      rowClassName={(row) => (row.quality === 'good' ? undefined : `meetings-row-${String(row.quality)}`)}
      columns={[
        { key: 'personKey', label: t('admin.meetings.person'), render: (v) => <code>{String(v)}</code> },
        {
          key: 'quality', label: t('admin.meetings.quality'),
          render: (_v, row) => <QualityWithReasons row={row as unknown as RosterRow} />,
        },
        { key: 'state', label: t('admin.meetings.state'), render: (v) => t(`admin.meetings.states.${String(v)}`) },
        { key: 'firstJoinedAt', label: t('admin.meetings.attendee.joined'), render: (v) => (v ? clockTime(Date.parse(String(v)), true) : '-') },
        { key: 'lastLeftAt', label: t('admin.meetings.attendee.left'), render: (v) => (v ? clockTime(Date.parse(String(v)), true) : '-') },
        { key: 'connectedSeconds', label: t('admin.meetings.connected'), render: (v) => formatSeconds(Number(v)) },
        { key: 'cameraSeconds', label: t('admin.meetings.camera'), render: (v) => formatSeconds(Number(v)) },
        { key: 'sharedSeconds', label: t('admin.meetings.shared'), render: (v) => formatSeconds(Number(v)) },
        {
          key: 'transports', label: t('admin.meetings.joinedOver'),
          render: (v) => (v as RosterRow['transports']).map((x) => `${x.transport} ${new Date(x.at).toLocaleTimeString()}`).join(', '),
        },
        { key: 'joinLatencyMs', label: t('admin.meetings.joinTime'), render: (v) => (v === null ? '-' : msText(Number(v))) },
        { key: 'drops', label: t('admin.meetings.drops') },
        { key: 'reconnects', label: t('admin.meetings.reconnects') },
        { key: 'poorConnectionSeconds', label: t('admin.meetings.poorConnection'), render: (v) => (typeof v === 'number' ? formatSeconds(v) : '-') },
        { key: 'device', label: t('admin.meetings.device'), render: (v) => { const d = v as RosterRow['device']; return [d.browser, d.os].filter(Boolean).join(' · ') || '-'; } },
        {
          key: 'failures', label: t('admin.meetings.failuresShort'),
          render: (_v, row) => {
            const texts = failureTexts(row as unknown as RosterRow);
            return texts.length ? <ul className="meetings-errors" data-testid="roster-errors">{texts.map((x, i) => <li key={`${i}-${x}`}>{x}</li>)}</ul> : '-';
          },
        },
      ]}
    />
  );
};

/**
 * END FOR EVERYONE, offered on a live meeting to an operator who holds `end-meetings`. It asks for the reason the access
 * log records, and the server ends the meeting only while its conversation holds it and the service runs it.
 */
const EndForEveryone: React.FC<{ detail: MeetingAnswer; onEnded: () => void }> = ({ detail, onEnded }) => {
  const { t } = useTranslation();
  const can = useCan();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const m = detail.meeting;
  if (m.live !== true || !can('end-meetings')) return null;
  const end = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await endMeetingForEveryone(m.meetingId, m.channelArn);
      onEnded();
    } catch (e) {
      if (!(e instanceof ReasonDeclinedError)) setFailed(meetingErrorText(e, 'admin.meetings.end.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="btn-danger" disabled={busy} onClick={() => { void end(); }} data-testid="end-meeting">
        {busy ? t('admin.meetings.end.ending') : t('admin.meetings.end.button')}
      </button>
      {failed && <div className="admin-error" role="alert">{failed}</div>}
    </>
  );
};

/**
 * One meeting: what it was and where it was held, who had a poor experience and when, everything recorded about it on one
 * axis with each attendee's connection charted on the same axis beneath, who was in it and how they fared, each person
 * in detail, and its transcript. The timeline and the charts share one view, one moment pointed at and one stretch an
 * experience issue jumped to.
 */
const MeetingDetail: React.FC<{ detail: MeetingAnswer; days: number; onBack: () => void; onEnded: () => void; onOpenConversation?: (channelArn: string) => void }> = ({ detail, days, onBack, onEnded, onOpenConversation }) => {
  const { t } = useTranslation();
  const m = detail.meeting;
  const events = useMemo(() => detail.events ?? [], [detail.events]);
  const timeline = useMemo(() => buildTimeline(m, events), [m, events]);
  const connectivity = useMemo(() => connectivityLanes(detail.connectivity, events), [detail.connectivity, events]);
  const issues = useMemo(() => new Map((m.roster ?? []).filter((r) => r.quality !== 'good').map((r) => [r.personKey, r.quality as 'warning' | 'error'])), [m.roster]);
  const people = useMemo(() => (m.roster ?? []).map((r) => r.personKey), [m.roster]);
  const full = useMemo<TimeView>(() => ({ from: timeline.start, to: timeline.end }), [timeline.start, timeline.end]);
  const [view, setView] = useState<TimeView>(full);
  const [cursor, setCursor] = useState<number | null>(null);
  const [band, setBand] = useState<TimelineBand | null>(null);
  const [jumped, setJumped] = useState<string | null>(null);
  const timelineRef = useRef<HTMLElement | null>(null);
  /** The view and the stretch an issue frames, in the meeting as this answer holds it. */
  const framing = (issue: ExperienceIssue): { view: TimeView; band: TimelineBand } => {
    const from = Date.parse(issue.from);
    const to = issue.to === null ? full.to : Date.parse(issue.to);
    return { view: viewAround(from, to, full), band: { from, to: Math.max(to, from), lane: issue.personKey } };
  };
  /** AN EXPERIENCE ISSUE JUMPS TO ITS MOMENT: the timeline and the charts zoom to it, mark it, and come into sight. */
  const jump = (issue: ExperienceIssue) => {
    const f = framing(issue);
    setView(f.view);
    setBand(f.band);
    setCursor(f.band.from);
    setJumped(issueKey(issue));
    const el = timelineRef.current;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // EACH ANSWER READ AGAIN (Refresh) KEEPS THE JUMP ONLY WHILE ITS ISSUE IS STILL IN IT: the issue is found again by what it is
  // (`issueKey`), so it stays marked and framed; one that is gone takes its band and its mark with it, and the view is the
  // whole meeting again.
  useEffect(() => {
    const still = jumped ? detail.experience?.issues.find((i) => issueKey(i) === jumped) : undefined;
    if (still) {
      const f = framing(still);
      setView(f.view);
      setBand(f.band);
      return;
    }
    setView(full);
    setBand(null);
    setJumped(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full, detail.experience]);
  const running = m.live === true && Boolean(m.startedAt);
  const length = running ? <RunningFor startedAt={m.startedAt as string} /> : formatSeconds(m.durationSeconds);
  return (
    <div data-testid="meeting-detail">
      <button className="btn-secondary" onClick={onBack}>{t('admin.meetings.back')}</button>
      <Coverage answer={detail} />
      <h3>{m.startedAt ? new Date(m.startedAt).toLocaleString() : m.meetingId}</h3>
      <div className="meetings-list-head">
        <p className="meetings-muted"><MeetingState meeting={m} />{m.live === true && <> · {t('admin.meetings.live.inItNow', { present: m.present ?? 0, count: m.people })}</>}</p>
        <EndForEveryone detail={detail} onEnded={onEnded} />
      </div>
      <p className="meetings-muted" data-testid="meeting-times">
        {t('admin.meetings.detail.start')} {m.startedAt ? new Date(m.startedAt).toLocaleString() : '-'}
        {' · '}{t('admin.meetings.detail.end')} {m.endedAt ? new Date(m.endedAt).toLocaleString() : '-'}
      </p>
      <p className="meetings-muted">
        <span data-testid="meeting-length">{length}</span> · {t('admin.meetings.peopleCount', { count: m.people })}
        {' · '}{t('admin.meetings.dropsCount', { count: m.dropEvents })} · {t('admin.meetings.failuresCount', { count: m.clientFailures })}
        {' · '}<code>{m.classification}</code> · <code>{m.meetingId}</code>
      </p>
      <MeetingExperience experience={detail.experience} startedAt={timeline.start} onJump={jump} currentKey={jumped} />
      <div className="meetings-two-up">
        <MeetingContextPanel detail={detail} onOpenConversation={onOpenConversation} />
        <MeetingQuality meeting={m} />
      </div>
      <section className="admin-panel" ref={timelineRef} data-testid="timeline-section">
        <h3>{t('admin.meetings.timeline.title')}</h3>
        <MeetingTimeline
          timeline={timeline} events={events} issues={issues} view={view} onView={setView} cursor={cursor} onCursor={setCursor} band={band}
        />
      </section>
      <MeetingQualityCharts
        lanes={connectivity} people={people} thresholds={detail.experience?.thresholds}
        view={view} full={full} onView={setView} cursor={cursor} onCursor={setCursor} band={band}
      />
      <section className="admin-panel">
        <h3>{t('admin.meetings.roster')}</h3>
        <Roster roster={m.roster ?? []} />
      </section>
      <PeopleInDetail roster={m.roster ?? []} events={events} />
      <TranscriptPanel detail={detail} days={days} onOpenConversation={onOpenConversation} />
    </div>
  );
};

const MeetingsTab: React.FC<{
  onOpenConversation?: (channelArn: string) => void;
  /** The console's Back: while a meeting is open, Back closes it to the list before it walks the tab history. */
  registerBack?: (close: (() => void) | null) => void;
}> = ({ onOpenConversation, registerBack }) => {
  const { t } = useTranslation();
  const [days, setDays] = useState<number>(daysFromUrl);
  const [answer, setAnswer] = useState<MeetingsAnswer | null>(null);
  const [detail, setDetail] = useState<MeetingAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Each read takes a ticket and only the latest ticket's answer is shown, so the figures always belong to the selected
  // window and the detail always belongs to the last meeting opened in it.
  const listTicket = useRef(0);
  const detailTicket = useRef(0);

  const load = useCallback(async (d: number) => {
    const ticket = ++listTicket.current;
    setIsLoading(true);
    setError(null);
    try {
      const next = await fetchMeetings(d);
      if (ticket === listTicket.current) setAnswer(next);
    } catch (e) {
      if (ticket === listTicket.current) setError(meetingErrorText(e, 'admin.meetings.loadFailed'));
    } finally {
      if (ticket === listTicket.current) setIsLoading(false);
    }
  }, [t]);
  useEffect(() => { void load(days); }, [load, days]);

  const open = useCallback(async (meetingId: string, d: number = days) => {
    const ticket = ++detailTicket.current;
    setError(null);
    writeMeetingToUrl(meetingId, d);
    try {
      const next = await fetchMeeting(meetingId, d);
      if (ticket === detailTicket.current) setDetail(next);
    } catch (e) {
      if (ticket === detailTicket.current) setError(meetingErrorText(e, 'admin.meetings.loadFailed'));
    }
  }, [days, t]);

  // A LINK TO ONE MEETING opens it once, when the tab opens.
  useEffect(() => {
    const linked = meetingFromUrl();
    if (linked) void open(linked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeDetail = useCallback(() => { detailTicket.current += 1; setDetail(null); writeMeetingToUrl(null); }, []);
  // AN OPEN MEETING IS A DRILL-DOWN: the console's Back returns to the list, never past the tab.
  const isOpen = detail !== null;
  useEffect(() => {
    registerBack?.(isOpen ? closeDetail : null);
    return () => registerBack?.(null);
  }, [isOpen, closeDetail, registerBack]);
  /** Read the window again, and the open meeting with it. */
  const refresh = () => {
    void load(days);
    if (detail) void open(detail.meeting.meetingId);
  };

  return (
    <div className="admin-tab" data-testid="meetings-tab">
      <div className="admin-tab-header">
        <h2>{t('admin.meetings.title')}</h2>
        <button type="button" className="btn-secondary" onClick={refresh} disabled={isLoading} data-testid="meetings-refresh">
          {isLoading ? t('admin.meetings.detail.refreshing') : t('admin.meetings.detail.refresh')}
        </button>
        <label>
          {t('admin.meetings.window')}
          <select className="select" value={days} onChange={(e) => { closeDetail(); setAnswer(null); setDays(Number(e.target.value)); }} aria-label={t('admin.meetings.window')}>
            {DAY_CHOICES.map((d) => <option key={d} value={d}>{t('admin.meetings.lastDays', { count: d })}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="admin-error" role="alert">{error}</div>}
      {isLoading && <div className="admin-tab-loading">{t('admin.meetings.loading')}</div>}

      {detail ? (
        <MeetingDetail
          detail={detail} days={days} onBack={closeDetail} onOpenConversation={onOpenConversation}
          onEnded={() => { void open(detail.meeting.meetingId); void load(days); }}
        />
      ) : answer && answer.figures && (
        <>
          <Coverage answer={answer} />
          <MeetingsOverview answer={answer} onOpen={(id) => { void open(id); }} />
        </>
      )}
    </div>
  );
};

export default MeetingsTab;
