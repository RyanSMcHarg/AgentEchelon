/**
 * HOW EACH PERSON IN A MEETING FARED (SPEC-ASSISTANT-MEETINGS FR46): the meeting's
 * quality and an expandable row per person:
 *
 *  - the meeting's quality bar (people by how they fared), with how many had issues, their drops and reconnects;
 *  - one expandable panel per person: their browser, system, device and SDK, their join and presence timings, why their
 *    quality is what it is, the text of each failure their app reported, and their own events in time order.
 *
 * A person is shown by their id, never a name.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@ae/shared/i18n';
import { QUALITY_MARK, QualityBadge, SegmentedBar } from './MeetingsOverview';
import { clockTime, eventLabel, formatSeconds, msText } from './meetingFormat';
import { CONNECTIVITY_SAMPLE_EVENT } from './meetingLanes';
import type { MeetingEvent, MeetingSummary, RosterRow } from '../../services/meetingAnalyticsService';

const SEP = ' · ';

/** Why a person's quality is what it is, each reason in words, worst first. Empty for a person who fared well. */
export function qualityReasons(r: RosterRow): string[] {
  const out: string[] = [];
  const failures = r.failureEvents?.length ? r.failureEvents.map((f) => f.eventType) : r.failures;
  for (const type of [...new Set(failures)]) out.push(eventLabel(type));
  if (r.drops) out.push(i18n.t('admin.meetings.reasons.drops', { count: r.drops }));
  if (r.reconnects) out.push(i18n.t('admin.meetings.reasons.reconnects', { count: r.reconnects }));
  if (r.poorConnectionSeconds) out.push(i18n.t('admin.meetings.reasons.poor', { length: formatSeconds(r.poorConnectionSeconds) }));
  return out;
}

/** A person's quality, with why in words beneath it. */
export const QualityWithReasons: React.FC<{ row: RosterRow }> = ({ row }) => {
  const reasons = qualityReasons(row);
  return (
    <>
      <QualityBadge quality={row.quality} />
      {reasons.length > 0 && <div className="meetings-muted" data-testid="quality-reasons">{reasons.join(SEP)}</div>}
    </>
  );
};

/** The text of each failure a person's app reported, `label: error`, or the label alone where it gave no error. */
export function failureTexts(r: RosterRow): string[] {
  if (r.failureEvents?.length) return r.failureEvents.map((f) => (f.errorMessage ? `${eventLabel(f.eventType)}: ${f.errorMessage}` : eventLabel(f.eventType)));
  return r.failures.map(eventLabel);
}

/** An event the app or the service recorded as something failing. */
export const isFailureEvent = (e: Pick<MeetingEvent, 'event_type'>): boolean =>
  /Failed|Dropped$/.test(e.event_type) || e.event_type === 'signalingDropped' || e.event_type === 'receivingAudioDropped';

/** The meeting's quality: its people by how they fared, and its issues counted. */
export const MeetingQuality: React.FC<{ meeting: MeetingSummary }> = ({ meeting: m }) => {
  const { t } = useTranslation();
  const roster = m.roster ?? [];
  const count = (q: RosterRow['quality']) => roster.filter((r) => r.quality === q).length;
  const withIssues = roster.filter((r) => r.quality !== 'good').length;
  return (
    <section className="admin-panel" data-testid="meeting-quality">
      <h3>{t('admin.meetings.quality')}</h3>
      <SegmentedBar
        label={t('admin.meetings.quality')}
        parts={(['good', 'warning', 'error'] as const).map((q) => ({ key: q, name: t(`admin.meetings.qualities.${q}`), value: count(q), color: QUALITY_MARK[q].color, glyph: QUALITY_MARK[q].glyph, ink: QUALITY_MARK[q].ink }))}
      />
      <p className="meetings-muted" data-testid="meeting-issues">
        <span className={withIssues ? 'meetings-bad' : undefined}>{t('admin.meetings.withIssues', { count: withIssues })}</span>
        {SEP}<span className={m.dropEvents ? 'meetings-bad' : undefined}>{t('admin.meetings.dropsCount', { count: m.dropEvents })}</span>
        {SEP}<span className={m.reconnects ? 'meetings-warn' : undefined}>{t('admin.meetings.reconnectsCount', { count: m.reconnects })}</span>
      </p>
    </section>
  );
};

const Fact: React.FC<{ label: string; value: React.ReactNode; tone?: 'warn' | 'bad' }> = ({ label, value, tone }) => (
  <><dt>{label}</dt><dd className={tone ? `meetings-${tone}` : undefined}>{value}</dd></>
);

/** One person's panel: what they joined from, their timings, why they fared as they did, and their own events. */
const PersonPanel: React.FC<{ row: RosterRow; events: MeetingEvent[] }> = ({ row: r, events }) => {
  const { t } = useTranslation();
  const reasons = qualityReasons(r);
  const errors = failureTexts(r);
  const own = events.filter((e) => e.person_key === r.personKey && e.event_type !== CONNECTIVITY_SAMPLE_EVENT);
  return (
    <details className={`meetings-person${r.quality !== 'good' ? ` has-${r.quality}` : ''}`} data-testid="person-panel" data-person={r.personKey}>
      <summary>
        <code>{r.personKey}</code> <QualityBadge quality={r.quality} />
        {reasons.length > 0 && <span className="meetings-muted">{SEP}{reasons.join(SEP)}</span>}
      </summary>
      <div className="meetings-person-body">
        <div>
          <h4>{t('admin.meetings.attendee.device')}</h4>
          <dl className="meetings-facts">
            <Fact label={t('admin.meetings.attendee.browser')} value={r.device.browser ?? '-'} />
            <Fact label={t('admin.meetings.attendee.os')} value={r.device.os ?? '-'} />
            <Fact label={t('admin.meetings.attendee.deviceName')} value={r.device.name ?? '-'} />
            <Fact label={t('admin.meetings.attendee.sdk')} value={r.device.sdk ?? '-'} />
          </dl>
        </div>
        <div>
          <h4>{t('admin.meetings.attendee.timings')}</h4>
          <dl className="meetings-facts">
            <Fact label={t('admin.meetings.attendee.joined')} value={r.firstJoinedAt ? clockTime(Date.parse(r.firstJoinedAt), true) : '-'} />
            <Fact label={t('admin.meetings.attendee.left')} value={r.lastLeftAt ? clockTime(Date.parse(r.lastLeftAt), true) : '-'} />
            <Fact label={t('admin.meetings.attendee.meetingStart')} value={r.joinLatencyMs == null ? '-' : msText(r.joinLatencyMs)} tone={(r.joinLatencyMs ?? 0) > 5000 ? 'warn' : undefined} />
            <Fact label={t('admin.meetings.attendee.presence')} value={r.presenceReceivedMs == null ? '-' : msText(r.presenceReceivedMs)} />
            <Fact label={t('admin.meetings.reconnects')} value={r.reconnects} tone={r.reconnects ? 'warn' : undefined} />
            <Fact label={t('admin.meetings.drops')} value={r.drops} tone={r.drops ? 'bad' : undefined} />
          </dl>
        </div>
        <div>
          <h4>{t('admin.meetings.attendee.issues')}</h4>
          {reasons.length === 0 ? <p className="meetings-muted">{t('admin.meetings.attendee.noIssues')}</p> : (
            <div className="meetings-tags">{reasons.map((x) => <span key={x} className="meetings-tag">{x}</span>)}</div>
          )}
          {errors.length > 0 && (
            <ul className="meetings-errors" data-testid="person-errors">{errors.map((x, i) => <li key={`${i}-${x}`}>{x}</li>)}</ul>
          )}
        </div>
        <div className="meetings-person-events">
          <h4>{t('admin.meetings.attendee.events', { count: own.length })}</h4>
          <table className="meetings-events" data-testid="person-events">
            <tbody>
              {own.map((e, i) => {
                const err = typeof e.detail?.errorMessage === 'string' ? e.detail.errorMessage : null;
                return (
                  <tr key={`${e.event_at}-${e.event_type}-${i}`} className={isFailureEvent(e) ? 'is-failure' : undefined}>
                    <td className="meetings-num">{clockTime(Date.parse(e.event_at), true)}</td>
                    <td><span className={`meetings-source source-${e.source}`}>{t(`admin.meetings.sourceTags.${e.source}`)}</span></td>
                    <td>{eventLabel(e.event_type)}{err && <span className="meetings-error-text"> {err}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
};

/** Every person's panel, those with issues first. */
export const PeopleInDetail: React.FC<{ roster: RosterRow[]; events: MeetingEvent[] }> = ({ roster, events }) => {
  const { t } = useTranslation();
  if (!roster.length) return null;
  const rank = { error: 0, warning: 1, good: 2 } as const;
  const ordered = [...roster].sort((a, b) => rank[a.quality] - rank[b.quality]);
  return (
    <section className="admin-panel" data-testid="people-in-detail">
      <h3>{t('admin.meetings.attendee.title')}</h3>
      {ordered.map((r) => <PersonPanel key={r.personKey} row={r} events={events} />)}
    </section>
  );
};
