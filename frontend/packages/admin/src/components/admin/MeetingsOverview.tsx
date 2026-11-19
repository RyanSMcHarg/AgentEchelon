/**
 * THE WINDOW'S MEETINGS AT A GLANCE (SPEC-ASSISTANT-MEETINGS FR45): the headline figures, each with the population it
 * is over; meetings, people, drops and failures by day; how the people in them fared; the window's incidents, each
 * opening its meeting; and the devices people joined from. Every number is the server's (`meeting-figures.ts`); this
 * only lays it out.
 *
 * It also shows the meeting health score, the status color on the health, drop and join tiles
 * (`--status-*` tokens, each with a glyph and words so it never rests on color alone), each meeting's conversation and
 * host in the list, and a running meeting's length following the viewer's clock.
 */
import React, { useState } from 'react';
import { RunningFor } from './RunningFor';
import { ConversationName } from './MeetingContext';
import { useTranslation } from 'react-i18next';
import DataTable from './DataTable';
import ColumnChart from './ColumnChart';
import { InfoTooltip } from './AdminHelp';
import { windowDays } from './meetingLanes';
import { eventLabel, figureText, formatSeconds, msText, pct, shortDay } from './meetingFormat';
import {
  INCIDENT_KINDS, type Figure, type MeetingIncident, type MeetingSummary, type MeetingsAnswer, type RosterRow,
} from '../../services/meetingAnalyticsService';

/** How a figure reads against its threshold: good, worth a look, or bad. */
export type Tone = 'good' | 'warn' | 'bad';
const TONE_MARK: Record<Tone, { color: string; glyph: string }> = {
  good: { color: 'var(--status-good)', glyph: '✓' },
  warn: { color: 'var(--status-warn)', glyph: '!' },
  bad: { color: 'var(--status-bad)', glyph: '✕' },
};

/**
 * THE THRESHOLDS THE TILES ARE COLORED BY: health at 90% or more is good and under 70% bad;
 * more than 10% of people dropping is bad; a join slower than 5 s is bad. A dash has no tone.
 */
export const toneOf = {
  health: (v: number | null): Tone | null => (v === null ? null : v >= 0.9 ? 'good' : v >= 0.7 ? 'warn' : 'bad'),
  dropRate: (v: number | null): Tone | null => (v === null ? null : v > 0.1 ? 'bad' : 'good'),
  joinMs: (v: number | null): Tone | null => (v === null ? null : v > 5000 ? 'bad' : 'good'),
};

export const Tile: React.FC<{ label: string; figure: Figure; format: (v: number) => string; help: string; tone?: (v: number | null) => Tone | null }> = ({ label, figure, format, help, tone }) => {
  const { t } = useTranslation();
  const toned = tone ? tone(figure.value) : null;
  return (
    <div className="metric-card" data-testid="meeting-figure" data-tone={toned ?? undefined}>
      <div className="metric-card-title">
        {label} <InfoTooltip label={t('admin.meetings.aboutFigure', { label })} content={help} />
      </div>
      <div className="metric-card-value" style={toned ? { color: TONE_MARK[toned].color } : undefined}>
        {toned && <span className="meetings-tone" aria-hidden="true">{TONE_MARK[toned].glyph}</span>}
        {figureText(figure, format)}
        {toned && <span className="meetings-sr-only"> {t(`admin.meetings.tones.${toned}`)}</span>}
      </div>
      <div className="metric-card-subtitle">{t('admin.meetings.over', { count: figure.over })}</div>
    </div>
  );
};

/** The status colors a person's quality wears, with a glyph so it never rests on color alone. */
export const QUALITY_MARK: Record<RosterRow['quality'], { color: string; glyph: string; ink: string }> = {
  good: { color: 'var(--status-good)', glyph: '✓', ink: '#052e16' },
  warning: { color: 'var(--status-warn)', glyph: '!', ink: '#1c1917' },
  error: { color: 'var(--status-bad)', glyph: '✕', ink: '#ffffff' },
};

export const QualityBadge: React.FC<{ quality: RosterRow['quality'] }> = ({ quality }) => {
  const { t } = useTranslation();
  return (
    <span className="meetings-quality">
      <i style={{ background: QUALITY_MARK[quality].color, color: QUALITY_MARK[quality].ink }} aria-hidden="true">{QUALITY_MARK[quality].glyph}</i>
      {t(`admin.meetings.qualities.${quality}`)}
    </span>
  );
};

/** One whole split into parts as a tall segmented bar: each part's share printed where it fits, a legend of names. */
export const SegmentedBar: React.FC<{ label: string; parts: Array<{ key: string; name: string; value: number; color: string; glyph?: string; ink?: string }> }> = ({ label, parts }) => {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (!total) return null;
  return (
    <div className="meetings-segmented" data-testid="segmented-bar">
      <div className="meetings-segmented-bar" role="img" aria-label={`${label}: ${parts.map((p) => `${p.name} ${p.value}`).join(', ')}`}>
        {parts.filter((p) => p.value > 0).map((p) => {
          const share = p.value / total;
          return (
            <span key={p.key} style={{ width: `${share * 100}%`, background: p.color, color: p.ink ?? '#ffffff' }} title={`${p.name}: ${p.value} (${pct(share)})`}>
              {share >= 0.12 ? pct(share) : ''}
            </span>
          );
        })}
      </div>
      <div className="meetings-span-key">
        {parts.map((p) => (
          <span key={p.key}><i style={{ background: p.color, color: p.ink ?? '#ffffff' }} aria-hidden="true">{p.glyph}</i>{p.name} <strong>{p.value}</strong></span>
        ))}
      </div>
    </div>
  );
};

/** Ranked horizontal bars, one hue, largest first, each with its count at the tip. */
const BarList: React.FC<{ title: string; counts: Record<string, number>; label?: (k: string) => string }> = ({ title, counts, label = (k) => k }) => {
  const entries = Object.entries(counts).sort(([, a], [, b]) => b - a);
  if (!entries.length) return null;
  const max = entries[0][1] || 1;
  return (
    <div className="meetings-barlist" data-testid="bar-list">
      <h4>{title}</h4>
      <ul>
        {entries.map(([k, n]) => (
          <li key={k}>
            <span className="meetings-barlist-name" title={k}>{label(k)}</span>
            <span className="meetings-barlist-track"><span style={{ width: `${(n / max) * 100}%` }} /></span>
            <span className="meetings-num">{n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** The window's incidents of one kind, newest first, each opening the meeting it happened in. */
const IncidentList: React.FC<{ kind: string; count: number; recent: MeetingIncident[]; onOpen: (meetingId: string) => void }> = ({ kind, count, recent, onOpen }) => {
  const { t } = useTranslation();
  return (
    <details className="meetings-incidents" data-testid={`incidents-${kind}`} open={count > 0 && kind === 'drop' ? true : undefined}>
      <summary>
        {t(`admin.meetings.incidents.${kind}`)} <span className="meetings-chip-count">{count}</span>
      </summary>
      {count === 0 ? (
        <p className="meetings-muted">{t('admin.meetings.incidents.none')}</p>
      ) : (
        <>
          {count > recent.length && <p className="meetings-muted">{t('admin.meetings.incidents.newest', { shown: recent.length, count })}</p>}
          <table className="meetings-events">
            <thead>
              <tr>
                <th>{t('admin.meetings.timeline.when')}</th>
                <th>{t('admin.meetings.person')}</th>
                <th>{t('admin.meetings.timeline.event')}</th>
                <th><span className="meetings-sr-only">{t('admin.meetings.incidents.open')}</span></th>
              </tr>
            </thead>
            <tbody>
              {recent.map((i) => (
                <tr key={`${i.meetingId}|${i.personKey}|${i.eventType}|${i.at}`} data-testid="incident-row" className="meetings-clickable" onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) onOpen(i.meetingId); }}>
                  <td className="meetings-num">{new Date(i.at).toLocaleString()}</td>
                  <td><code>{i.personKey}</code></td>
                  <td>{eventLabel(i.eventType)}{i.errorMessage ? <span className="meetings-muted"> · {i.errorMessage}</span> : null}</td>
                  <td><button type="button" className="btn-secondary" onClick={() => onOpen(i.meetingId)}>{t('admin.meetings.incidents.open')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </details>
  );
};

/**
 * WHERE A MEETING STANDS: live while the service runs it (read when the answer was made), else how it ended as its events
 * show it. A meeting whose state could not be read says so, never live and never ended.
 */
const LIVE_MARK: React.CSSProperties = { background: QUALITY_MARK.good.color, color: QUALITY_MARK.good.ink };

export const MeetingState: React.FC<{ meeting: MeetingSummary }> = ({ meeting: m }) => {
  const { t } = useTranslation();
  if (m.live === true) {
    return (
      <span className="meetings-quality" data-testid="meeting-state" data-state="live">
        <i style={LIVE_MARK} aria-hidden="true">●</i>
        {t('admin.meetings.live.live')}
      </span>
    );
  }
  if (m.live == null && !m.endedAt) return <span data-testid="meeting-state" data-state="unknown">{t('admin.meetings.live.unknown')}</span>;
  const how = m.endedAt ? m.endedHow ?? null : 'noEndRecorded';
  return <span data-testid="meeting-state" data-state="ended">{how ? t(`admin.meetings.endedHow.${how}`) : t('admin.meetings.statuses.ended')}</span>;
};

/** Live meetings first, longest running first; then the rest, newest first. */
export function inListOrder(meetings: MeetingSummary[]): MeetingSummary[] {
  const live = meetings.filter((m) => m.live === true).sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  const rest = meetings.filter((m) => m.live !== true).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  return [...live, ...rest];
}

const MeetingsOverview: React.FC<{ answer: MeetingsAnswer; onOpen: (meetingId: string) => void }> = ({ answer, onOpen }) => {
  const [liveOnly, setLiveOnly] = useState(false);
  const liveCount = answer.meetings.filter((m) => m.live === true).length;
  const listed = inListOrder(answer.meetings).filter((m) => !liveOnly || m.live === true);
  const { t } = useTranslation();
  const f = answer.figures;
  const help = (key: string) => `${t(`admin.meetings.help.${key}`)} ${t('admin.meetings.help.population')}`;
  const days = windowDays(f.byDay, answer.from, answer.to);
  const series = [
    { key: 'meetings', color: 'var(--chart-1)', v: (d: typeof days[number]) => d.meetings },
    { key: 'people', color: 'var(--chart-1)', v: (d: typeof days[number]) => d.people },
    { key: 'drops', color: 'var(--chart-1)', v: (d: typeof days[number]) => d.dropEvents },
    { key: 'failures', color: 'var(--chart-1)', v: (d: typeof days[number]) => d.clientFailures },
  ];
  const quality = f.quality;
  const incidents = f.incidents;

  return (
    <>
      <div className="metric-cards-grid">
        {f.healthyMeetings && (
          <Tile label={t('admin.meetings.figures.health')} figure={f.healthyMeetings} format={pct} help={help('health')} tone={toneOf.health} />
        )}
        <Tile label={t('admin.meetings.figures.meetings')} figure={{ value: f.meetings, over: f.meetings }} format={String} help={t('admin.meetings.help.meetings')} />
        <Tile label={t('admin.meetings.figures.duration')} figure={f.durationSeconds} format={(v) => formatSeconds(v)} help={help('duration')} />
        <Tile label={t('admin.meetings.figures.people')} figure={f.peoplePerMeeting} format={(v) => v.toFixed(1)} help={help('people')} />
        <Tile label={t('admin.meetings.figures.joinP50')} figure={f.joinLatencyMs.p50} format={msText} help={help('joinTime')} tone={toneOf.joinMs} />
        <Tile label={t('admin.meetings.figures.joinP95')} figure={f.joinLatencyMs.p95} format={msText} help={help('joinTime')} tone={toneOf.joinMs} />
        <Tile label={t('admin.meetings.figures.joinSuccess')} figure={f.joinSuccessRate} format={pct} help={help('joinSuccess')} />
        <Tile label={t('admin.meetings.figures.dropRate')} figure={f.dropRate} format={pct} help={help('dropRate')} tone={toneOf.dropRate} />
        <Tile label={t('admin.meetings.figures.phone')} figure={f.phoneShare} format={pct} help={help('phone')} />
        <Tile label={t('admin.meetings.figures.ringAnswered')} figure={f.ring.answerRate} format={pct} help={help('ring')} />
        <Tile label={t('admin.meetings.figures.timeToAnswer')} figure={f.ring.timeToAnswerMs.p50} format={msText} help={help('timeToAnswer')} />
      </div>

      {days.length >= 1 && (
        <section className="admin-panel" data-testid="meetings-by-day">
          <h3>{t('admin.meetings.trends.title')}</h3>
          <div className="meetings-small-multiples">
            {series.map((s) => (
              <ColumnChart
                key={s.key} title={t(`admin.meetings.trends.${s.key}`)} color={s.color}
                columns={days.map((d) => ({ key: d.day, label: shortDay(d.day), value: s.v(d) }))}
              />
            ))}
          </div>
          <details className="meetings-table-twin">
            <summary>{t('admin.meetings.trends.asTable')}</summary>
            <table className="meetings-events" data-testid="by-day-table">
              <thead>
                <tr><th>{t('admin.meetings.trends.day')}</th>{series.map((s) => <th key={s.key}>{t(`admin.meetings.trends.${s.key}`)}</th>)}</tr>
              </thead>
              <tbody>
                {days.map((d) => <tr key={d.day}><td>{shortDay(d.day)}</td>{series.map((s) => <td key={s.key} className="meetings-num">{s.v(d)}</td>)}</tr>)}
              </tbody>
            </table>
          </details>
        </section>
      )}

      <div className="meetings-two-up">
        {quality && (
          <section className="admin-panel" data-testid="meetings-quality">
            <h3>{t('admin.meetings.health.title')} <InfoTooltip label={t('admin.meetings.health.title')} content={t('admin.meetings.health.help')} /></h3>
            <SegmentedBar
              label={t('admin.meetings.health.title')}
              parts={(['good', 'warning', 'error'] as const).map((q) => ({ key: q, name: t(`admin.meetings.qualities.${q}`), value: quality[q], color: QUALITY_MARK[q].color, glyph: QUALITY_MARK[q].glyph, ink: QUALITY_MARK[q].ink }))}
            />
            {quality.good + quality.warning + quality.error === 0 && <p className="meetings-muted">{t('admin.meetings.health.nobody')}</p>}
          </section>
        )}
        <section className="admin-panel" data-testid="meetings-status">
          <h3>{t('admin.meetings.status')}</h3>
          <SegmentedBar
            label={t('admin.meetings.status')}
            parts={(['ended', 'active', 'abandoned'] as const).map((k, i) => ({ key: k, name: t(`admin.meetings.statuses.${k}`), value: f.byStatus[k], color: `var(--chart-${i + 1})` }))}
          />
          <h4>{t('admin.meetings.startedVia')}</h4>
          <SegmentedBar
            label={t('admin.meetings.startedVia')}
            parts={(['person', 'workflow', 'unknown'] as const).map((k, i) => ({ key: k, name: t(`admin.meetings.via.${k}`), value: f.startedVia[k], color: `var(--chart-${i + 1})` }))}
          />
        </section>
      </div>

      {incidents && (
        <section className="admin-panel" data-testid="meetings-incidents">
          <h3>{t('admin.meetings.incidents.title')}</h3>
          {INCIDENT_KINDS.map((k) => <IncidentList key={k} kind={k} count={incidents[k].count} recent={incidents[k].recent} onOpen={onOpen} />)}
        </section>
      )}

      <section className="meetings-breakdowns">
        <BarList title={t('admin.meetings.failures')} counts={f.failuresByType} label={eventLabel} />
        <BarList title={t('admin.meetings.browsers')} counts={f.browsers} />
        <BarList title={t('admin.meetings.systems')} counts={f.operatingSystems} />
        <BarList title={t('admin.meetings.sdks')} counts={f.sdkVersions} />
      </section>

      <div className="meetings-list-head">
        <h3>{t('admin.meetings.list')}</h3>
        <button
          type="button" className="meetings-chip" aria-pressed={liveOnly} data-testid="live-filter"
          onClick={() => setLiveOnly(!liveOnly)}
        >
          {t('admin.meetings.live.filter')} <span className="meetings-chip-count">{liveCount}</span>
        </button>
      </div>
      <DataTable
        data={listed as unknown as Record<string, unknown>[]}
        emptyMessage={liveOnly ? t('admin.meetings.live.none') : t('admin.meetings.empty')}
        onRowClick={(row) => onOpen((row as unknown as MeetingSummary).meetingId)}
        columns={[
          { key: 'startedAt', label: t('admin.meetings.started'), render: (v) => (v ? new Date(String(v)).toLocaleString() : '-') },
          { key: 'live', label: t('admin.meetings.status'), render: (_v, row) => <MeetingState meeting={row as unknown as MeetingSummary} /> },
          { key: 'channelArn', label: t('admin.meetings.context.conversation'), render: (v) => (v ? <ConversationName channelArn={String(v)} /> : '-') },
          {
            key: 'createdBy', label: t('admin.meetings.context.hostOrCreator'),
            render: (_v, row) => { const m = row as unknown as MeetingSummary; const who = m.hosts?.[0] ?? m.createdBy; return who ? <code>{who}</code> : '-'; },
          },
          {
            key: 'durationSeconds', label: t('admin.meetings.duration'),
            render: (v, row) => {
              const m = row as unknown as MeetingSummary;
              if (m.live === true && m.startedAt) return <RunningFor startedAt={m.startedAt} />;
              return formatSeconds(v === null ? null : Number(v));
            },
          },
          {
            key: 'people', label: t('admin.meetings.people'),
            render: (v, row) => {
              const m = row as unknown as MeetingSummary;
              return m.live === true ? t('admin.meetings.live.inItNow', { present: m.present ?? 0, count: Number(v) }) : String(v);
            },
          },
          { key: 'phonePeople', label: t('admin.meetings.phone') },
          { key: 'peopleWhoDropped', label: t('admin.meetings.dropped'), render: (v, row) => `${String(v)} (${String(row.dropEvents)})` },
          { key: 'clientFailures', label: t('admin.meetings.failuresShort') },
          { key: 'startedVia', label: t('admin.meetings.startedVia'), render: (v) => (v ? t(`admin.meetings.via.${String(v)}`) : '-') },
        ]}
      />
    </>
  );
};

export default MeetingsOverview;
