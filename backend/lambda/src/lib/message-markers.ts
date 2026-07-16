/**
 * Canonical, DETERMINISTIC stripping of internal message markers.
 *
 * The assistant embeds machine-readable control markers in a message's Content
 * so the frontend can render UI deterministically (navigate to a channel, show a
 * battle scorecard, render suggestion cards, attach a generated image, etc.).
 * The SPA parses + strips them in `frontend/src/utils/messageParser.ts`
 * (parseMessageContent) so the human never sees them. Everything that reads the
 * message text for a *non-UI* purpose — analytics, the LLM relevance judge, the
 * admin conversation browser — must strip the SAME markers, or the raw marker
 * leaks in and (e.g.) the judge scores `"…NAVIGATE_CHANNEL:arn:…"` as irrelevant.
 *
 * This module is the single backend source of truth for that set, mirroring the
 * SPA parser. Two shapes:
 *   - HTML-comment markers: `<!--ACTIVE_TASK:…-->`, `<!--battle:…-->`,
 *     `<!--battlestats:…-->`, `<!--battlewaiting:…-->`, `<!--battleimage:…-->`,
 *     `<!--corr:…-->`, `<!--proposal:…-->`, `<!--sources:…-->`,
 *     `<!--suggestions:…-->`. The assistant never emits HTML comments as real
 *     content, so we strip ALL `<!--…-->` comments — this also auto-covers any
 *     future marker without a code change.
 *   - Inline nav marker: `NAVIGATE_CHANNEL:<channelArn>|<label>` (drift redirect).
 */

/** Every internal control marker, as a deterministic pattern. */
export const MESSAGE_MARKER_PATTERNS: RegExp[] = [
  // All HTML-comment control markers (ACTIVE_TASK/battle*/corr/proposal/sources/suggestions/…).
  /<!--[\s\S]*?-->/g,
  // Inline drift-redirect marker: NAVIGATE_CHANNEL:<arn>|<label> (label runs to EOL).
  /NAVIGATE_CHANNEL:\S+\|[^\n]*/g,
];

/**
 * Return the human-visible text with every internal marker removed, matching
 * what the SPA renders. Idempotent; safe on null/undefined.
 */
export function stripMessageMarkers(content: string | null | undefined): string {
  let s = content || '';
  for (const pattern of MESSAGE_MARKER_PATTERNS) s = s.replace(pattern, '');
  // Collapse whitespace the stripping left behind (trailing spaces, blank runs).
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
