/**
 * WHAT ONE ACCESS-LOG RECORD MEANS, in the reader's terms.
 *
 * Every per-conversation credential was one event, "Conversation access", with raw capability keys beside
 * it, so a temporary moderation credential read like a read, and nothing said when it ended. The record
 * already says which: the exchange writes `moderation` and `ttlSeconds` on the vend's audit line
 * (`admin-credential-exchange.ts`), and a team member's or a de-identified read is its own event
 * (`admin-conversations.ts`). This turns those facts into a kind, an expiry and plain capability names;
 * the words are copy (`admin.accessLog.kind.*`, `admin.accessLog.allows.*`).
 */
import type { AccessLogRecord } from '../../services/accessLogService';

export type AccessKind =
  | 'consoleSession'
  | 'temporaryModeration'
  | 'temporaryRead'
  | 'teamRead'
  | 'deidentifiedRead'
  | 'teamAttachment'
  | 'logRead'
  | 'other';

const detailOf = (r: AccessLogRecord): Record<string, unknown> => (r.detail && typeof r.detail === 'object' ? r.detail : {});

export function accessKind(r: AccessLogRecord): AccessKind {
  switch (r.event) {
    case 'admin_console_session_vend': return 'consoleSession';
    case 'admin_scoped_credential_vend': return detailOf(r).moderation === true ? 'temporaryModeration' : 'temporaryRead';
    case 'team_conversation_read': return 'teamRead';
    case 'clean_conversation_read': return 'deidentifiedRead';
    case 'team_scoped_credential_vend': return 'teamAttachment';
    case 'access_log_read': return 'logRead';
    default: return 'other';
  }
}

/** When a temporary credential stopped working, or null for an access that was not a timed credential. */
export function accessExpiry(r: AccessLogRecord): Date | null {
  const ttl = Number(detailOf(r).ttlSeconds);
  const at = Date.parse(r.at);
  if (!Number.isFinite(ttl) || ttl <= 0 || Number.isNaN(at)) return null;
  return new Date(at + ttl * 1000);
}

/** The assistant a team member read through, when the record names one. */
export function accessAssistant(r: AccessLogRecord): string | null {
  const a = detailOf(r).assistant;
  return typeof a === 'string' && a ? a : null;
}
