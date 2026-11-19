/** How the Meetings tab writes a length, a time, a rate and a figure the server could not support. */
import i18n from '@ae/shared/i18n';
import { ApiError } from '@ae/shared';
import type { Figure } from '../../services/meetingAnalyticsService';

/**
 * Seconds as `1h 05m`, `12m 30s` or `40s`, rounded to the whole second before it is split into parts. A length is never
 * negative: one counted on a viewer's clock that runs behind the server's reads as `0s`.
 */
export function formatSeconds(s: number | null): string {
  if (s === null) return '-';
  const whole = Math.max(0, Math.round(s));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = whole % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** A figure's value, formatted, or a dash when its population cannot support one. */
export function figureText(f: Figure, format: (v: number) => string): string {
  return f.value === null ? '-' : format(f.value);
}

export const pct = (v: number): string => `${Math.round(v * 100)}%`;
export const msText = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

/** A clock time in the viewer's locale, with seconds where the axis needs them. */
export function clockTime(t: number, seconds = false): string {
  return new Date(t).toLocaleTimeString(i18n.language || undefined, { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
}

/** A UTC day (`2026-11-11`) as a short date in the viewer's locale. */
export function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(i18n.language || undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** An event's name as the console says it, or the recorded name for an event the console has no words for yet. */
export function eventLabel(eventType: string): string {
  return i18n.t(`admin.meetings.events.${eventType}`, { defaultValue: eventType });
}

/**
 * WHAT A MEETINGS READ OR END THAT FAILED SAYS, from the locale. The route answers a refusal with a `code`, worded here as
 * `admin.meetings.errors.<code>`; a refusal the gateway gave carries none and is the console's own worded refusal
 * (`sigv4Fetch`); anything else reads as the caller's fallback. The handler's own `error` text is never shown.
 */
export function meetingErrorText(e: unknown, fallbackKey: string): string {
  const code = e instanceof ApiError ? (e.body as { code?: unknown } | undefined)?.code : undefined;
  if (typeof code === 'string' && /^[A-Z_]+$/.test(code) && i18n.exists(`admin.meetings.errors.${code}`)) return i18n.t(`admin.meetings.errors.${code}`);
  if (e instanceof ApiError && code === undefined && (e.status === 401 || e.status === 403) && e.message) return e.message;
  return i18n.t(fallbackKey);
}
