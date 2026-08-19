/**
 * Canonical, DETERMINISTIC stripping of internal message markers.
 *
 * The assistant embeds machine-readable control markers in a message's Content
 * so the frontend can render UI deterministically (navigate to a channel, show a
 * battle scorecard, render suggestion cards, attach a generated image, etc.).
 * The SPA parses + strips them in `frontend/packages/shared/src/utils/messageParser.ts`
 * (parseMessageContent) so the human never sees them. Everything that reads the
 * message text for a *non-UI* purpose — analytics, the LLM relevance judge, the
 * admin conversation browser — must strip the SAME markers, or the raw marker
 * leaks in and (e.g.) the judge scores `"…NAVIGATE_CHANNEL:arn:…"` as irrelevant.
 *
 * This module is the single backend source of truth for that set, mirroring the
 * SPA parser. Two shapes:
 *   - HTML-comment markers: `<!--ACTIVE_TASK:…-->`, `<!--battle:…-->`,
 *     `<!--battlestats:…-->`, `<!--battlewaiting:…-->`,
 *     `<!--corr:…-->`, `<!--proposal:…-->`, `<!--sources:…-->`,
 *     `<!--suggestions:…-->`. The assistant never emits HTML comments as real
 *     content, so we strip ALL `<!--…-->` comments — this also auto-covers any
 *     future marker without a code change.
 *   - Inline nav marker: `NAVIGATE_CHANNEL:<channelArn>|<label>` (drift redirect).
 *   - Guardrail MASK TOKENS: what Amazon Bedrock Guardrails leaves where it masked one of the
 *     markers above. See `stripGuardrailMaskTokens`.
 */

import { GUARDRAIL_MASK_TOKEN_PATTERNS } from '../../../lib/config/guardrail-masks.js';

/** Every internal control marker, as a deterministic pattern. */
export const MESSAGE_MARKER_PATTERNS: RegExp[] = [
  // All HTML-comment control markers (ACTIVE_TASK/battle*/corr/proposal/sources/suggestions/…).
  /<!--[\s\S]*?-->/g,
  // Inline drift-redirect marker: NAVIGATE_CHANNEL:<arn>|<label> (label runs to EOL).
  /NAVIGATE_CHANNEL:\S+\|[^\n]*/g,
  // A marker the guardrail already rewrote. Text stored BEFORE the strip at the guardrail boundary
  // (below) still carries the token, and every reader of stored text - the admin browser, the judge,
  // analytics - has to see what the human was meant to see.
  ...GUARDRAIL_MASK_TOKEN_PATTERNS,
];

/**
 * Remove the mask tokens Amazon Bedrock Guardrails leaves behind for the internal-marker filters.
 *
 * A guardrail regex filter with action `ANONYMIZE` replaces its match with the literal
 * `{FILTER_NAME}`, so a control marker the model leaked comes back as `{MetadataMarkerFilter}`
 * instead of as the marker. `stripMessageMarkers` cannot help: by the time the runtime holds the
 * response, the text it matches on is gone and a token that matches nothing is in its place. This
 * runs at the guardrail boundary itself (`applyOutputGuardrail`), which is the single point where
 * such a token can enter the system, so no surface downstream ever stores or renders one.
 *
 * Scoped to the filters declared for internal markers (`config/guardrail-masks`), never to PII
 * entity masks: `{EMAIL}` is the intended output of an EMAIL ANONYMIZE rule and deleting it would
 * remove the evidence that a redaction happened. Idempotent; safe on null/undefined.
 */
export function stripGuardrailMaskTokens(content: string | null | undefined): string {
  let s = content || '';
  for (const pattern of GUARDRAIL_MASK_TOKEN_PATTERNS) s = s.replace(pattern, '');
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

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

/**
 * Reasoning-tag scaffolding a model sometimes leaks into its FINAL answer — a
 * `<thinking>…</thinking>` block, or a `<result>…</result>` wrapper around the
 * real answer. These are internal scaffolding, never intended for the human, but
 * they are NOT control markers (no UI semantics), so stripMessageMarkers leaves
 * them. Seen live: a report task's stored result carried a `<thinking>` block, and
 * a drift reply surfaced a bare `<result>` fragment. Strip the whole thinking
 * block (content included — it's private reasoning) and unwrap `<result>` tags
 * (keep the inner answer). Tolerant of an unclosed `<thinking>` (strip to end) and
 * stray closing tags. Idempotent; safe on null/undefined.
 */
export function stripReasoningTags(content: string | null | undefined): string {
  let s = content || '';
  // Whole <thinking>…</thinking> blocks (private reasoning) — drop content too.
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  // Unclosed <thinking> with no matching close: strip from the tag to end.
  s = s.replace(/<thinking>[\s\S]*$/i, '');
  // <result> wrappers: keep the inner answer, drop the tags (either or both).
  s = s.replace(/<\/?result>/gi, '');
  // Any orphaned </thinking> left behind.
  s = s.replace(/<\/thinking>/gi, '');
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
