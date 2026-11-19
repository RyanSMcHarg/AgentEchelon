/**
 * WHO HAD A POOR EXPERIENCE, AT THE TOP OF A MEETING (SPEC-ASSISTANT-MEETINGS FR74): each person with a poor stretch or
 * moment, and for each one what it was (packet loss, jitter or round trip past its threshold, a poor connection, a drop or
 * reconnect, signaling dropped, a device that failed, a failed join), when, for how long and its worst reading. Every item
 * jumps to its moment: the timeline and the quality charts beneath zoom to it and mark it.
 *
 * The issues and the thresholds are the server's (`meeting-experience.ts`), judged against the deployment's thresholds
 * and said here, so the reader knows what "poor" meant. A person is shown by their id: a meeting's analytics name nobody
 * by default.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ExperienceIssue, ExperienceIssueKind, ExperienceThresholds } from '../../services/meetingAnalyticsService';
import { clockTime, formatSeconds } from './meetingFormat';
import { issueKey } from './meetingView';

/** How serious an issue is: a failure or a drop stopped the person; a stretch or a reconnect degraded them. */
const SEVERE: ReadonlySet<ExperienceIssueKind> = new Set(['drop', 'joinFailure', 'deviceFailure', 'signalingDropped', 'audioSendFailed', 'audioReceiveDropped']);
export const issueSeverity = (kind: ExperienceIssueKind): 'bad' | 'warn' => (SEVERE.has(kind) ? 'bad' : 'warn');

/** The unit of an issue's worst reading. */
const PEAK_UNIT: Partial<Record<ExperienceIssueKind, 'pct' | 'ms'>> = {
  packetLossSend: 'pct', packetLossReceive: 'pct', jitter: 'ms', roundTrip: 'ms',
};

interface MeetingExperienceProps {
  experience?: { thresholds: ExperienceThresholds; issues: ExperienceIssue[] };
  /** The meeting's start, so each moment also says how far into the meeting it was. */
  startedAt: number;
  onJump: (issue: ExperienceIssue) => void;
  /** The issue jumped to last (`issueKey`), marked in the list, in this answer or one a Refresh read since. */
  currentKey?: string | null;
}

const MeetingExperience: React.FC<MeetingExperienceProps> = ({ experience, startedAt, onJump, currentKey }) => {
  const { t } = useTranslation();
  if (!experience) return null;
  const { thresholds, issues } = experience;
  const people = [...new Set(issues.map((i) => i.personKey))];
  const judged = t('admin.meetings.experience.judged', {
    loss: thresholds.packetLossPct, jitter: thresholds.jitterMs, rtt: thresholds.roundTripMs, sustained: formatSeconds(thresholds.sustainedSeconds),
  });
  const durationOf = (i: ExperienceIssue): string => {
    if (i.to === null) return t('admin.meetings.experience.neverBack');
    if (!i.seconds) return t('admin.meetings.experience.moment');
    return t('admin.meetings.experience.lasted', { length: formatSeconds(i.seconds) });
  };
  return (
    <section className="admin-panel" data-testid="meeting-experience">
      <h3>{t('admin.meetings.experience.title')}</h3>
      <p className="meetings-muted">{judged}</p>
      {issues.length === 0 ? (
        <p data-testid="experience-none">
          <span className="meetings-good" aria-hidden="true">●</span> {t('admin.meetings.experience.none')}
        </p>
      ) : (
        <div className="meetings-experience-people">
          {people.map((p) => {
            const mine = issues.filter((i) => i.personKey === p);
            const severe = mine.some((i) => issueSeverity(i.kind) === 'bad');
            return (
              <div key={p} className="meetings-experience-person" data-testid="experience-person" data-person={p}>
                <h4>
                  <span className={severe ? 'meetings-bad' : 'meetings-warn'} aria-hidden="true">{severe ? '◆' : '▲'}</span>{' '}
                  <code>{p}</code>{' '}
                  <span className="meetings-muted">{t('admin.meetings.experience.count', { count: mine.length })}</span>
                </h4>
                <ul>
                  {mine.map((i) => {
                    const sev = issueSeverity(i.kind);
                    const unit = PEAK_UNIT[i.kind];
                    const at = Date.parse(i.from);
                    const isCurrent = !!currentKey && currentKey === issueKey(i);
                    return (
                      <li key={`${i.kind}-${i.from}-${i.attendeeId ?? ''}`}>
                        <button
                          type="button" className="meetings-experience-item" aria-pressed={isCurrent} data-testid="experience-item" data-kind={i.kind}
                          onClick={() => onJump(i)}
                          aria-label={t('admin.meetings.experience.jump', { what: t(`admin.meetings.experience.kinds.${i.kind}`), at: clockTime(at, true) })}
                        >
                          <span className={sev === 'bad' ? 'meetings-bad' : 'meetings-warn'} aria-hidden="true" data-testid="experience-glyph">{sev === 'bad' ? '◆' : '▲'}</span>
                          <strong>{t(`admin.meetings.experience.kinds.${i.kind}`)}</strong>
                          {unit && i.peak !== null && (
                            <span className="meetings-num">{t(`admin.meetings.experience.peak.${unit}`, { value: Math.round(i.peak * 10) / 10 })}</span>
                          )}
                          <span className="meetings-num">{clockTime(at, true)} <span className="meetings-muted">+{formatSeconds(Math.max(0, (at - startedAt) / 1000))}</span></span>
                          <span className="meetings-muted">{durationOf(i)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

export default MeetingExperience;
