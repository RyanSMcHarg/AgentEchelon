/**
 * WHAT ONE ACCESS-LOG RECORD MEANS, in the reader's terms.
 *
 * Every per-conversation credential was one event, "Conversation access", with raw capability keys beside
 * it, so a temporary moderation credential read like a read, and nothing said when it ended. The record
 * already says which: the exchange writes `moderation` and `ttlSeconds` on the vend's audit line
 * (`admin-credential-exchange.ts`), and a team member's or a de-identified read is its own event
 * (`admin-conversations.ts`), as are a meeting's transcript read and a meeting ended for everyone
 * (`admin-meetings.ts`). This turns those facts into a kind, an expiry and plain capability names; the words are copy
 * (`admin.accessLog.kind.*`, `admin.accessLog.allows.*`). A refusal is its own kind of
 * record, a request one of the credential exchanges answered with nothing (`accessOutcome`, `refusalOf`).
 */
import type { AccessLogRecord } from '../../services/accessLogService';

export type AccessKind =
  | 'consoleSession'
  | 'temporaryModeration'
  | 'temporaryRead'
  | 'teamRead'
  | 'contentRead'
  | 'teamResponsesRead'
  | 'deidentifiedRead'
  | 'teamAttachment'
  | 'logRead'
  | 'adminRequest'
  | 'signInRequest'
  | 'meetingTranscriptRead'
  | 'meetingEnded'
  | 'other';

const detailOf = (r: AccessLogRecord): Record<string, unknown> => (r.detail && typeof r.detail === 'object' ? r.detail : {});

export function accessKind(r: AccessLogRecord): AccessKind {
  switch (r.event) {
    case 'admin_console_session_vend': return 'consoleSession';
    case 'admin_scoped_credential_vend': return detailOf(r).moderation === true ? 'temporaryModeration' : 'temporaryRead';
    case 'team_conversation_read': return 'teamRead';
    case 'analytics_content_read': return 'contentRead';
    case 'team_quality_read': return 'teamResponsesRead';
    case 'clean_conversation_read': return 'deidentifiedRead';
    case 'team_scoped_credential_vend': return 'teamAttachment';
    case 'access_log_read': return 'logRead';
    case 'admin_credential_refused': return 'adminRequest';
    case 'person_credential_refused': return 'signInRequest';
    case 'meeting_transcript_read': return 'meetingTranscriptRead';
    case 'meeting_ended_for_all': return 'meetingEnded';
    default: return 'other';
  }
}

/**
 * WHO WAS GIVEN THE ACCESS: a person by their id, or, for a reader that is not a person, the IAM principal that signed
 * the request, by its role's name (the name after `role/` or `assumed-role/`, else the ARN's last segment). Null where
 * the record names neither.
 */
export function accessActor(r: AccessLogRecord): { kind: 'person'; id: string } | { kind: 'iam'; name: string; arn: string } | null {
  if (r.actorKind === 'iam' && r.actorPrincipalArn) {
    const arn = r.actorPrincipalArn;
    const name = /:assumed-role\/([^/]+)/.exec(arn)?.[1] ?? /:role\/(?:.*\/)?([^/]+)$/.exec(arn)?.[1] ?? (arn.split(/[:/]/).pop() || arn);
    return { kind: 'iam', name, arn };
  }
  return r.actor ? { kind: 'person', id: r.actor } : null;
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

/** Whether the access was given or refused. A record written before refusals were recorded is a grant. */
export function accessOutcome(r: AccessLogRecord): 'granted' | 'refused' {
  return r.outcome === 'refused' ? 'refused' : 'granted';
}

/** What a refusal said: its code, or its HTTP status when the exchange gave no code. Null on a grant. */
export function refusalOf(r: AccessLogRecord): { code: string } | { status: number } | null {
  if (accessOutcome(r) !== 'refused') return null;
  if (r.code) return { code: r.code };
  return typeof r.status === 'number' ? { status: r.status } : null;
}

/**
 * THE ACCESS KINDS THAT ARE GRANTED ONLY WITH A STATED REASON: every per-conversation credential, every
 * read of conversation content, and a team's read of its assistant's responses. Any other access (a
 * console sign-in, a read of this log) asks for none, so only those are labeled as needing none; a
 * reason-gated record that carries no reason says so instead.
 */
const REASONED_KINDS: ReadonlySet<AccessKind> = new Set<AccessKind>([
  'temporaryModeration', 'temporaryRead', 'teamRead', 'deidentifiedRead', 'teamAttachment', 'contentRead', 'teamResponsesRead',
  'meetingTranscriptRead', 'meetingEnded',
]);

/** Whether this kind of access is granted only with a stated reason. */
export function reasonRequired(r: AccessLogRecord): boolean {
  return REASONED_KINDS.has(accessKind(r));
}

/**
 * The reads served on the console session itself rather than on a credential vended for them: they are
 * recorded by the service that answered, and have no expiry of their own.
 */
const SESSION_READ_KINDS: ReadonlySet<AccessKind> = new Set<AccessKind>([
  'teamRead', 'deidentifiedRead', 'contentRead', 'teamResponsesRead', 'meetingTranscriptRead', 'meetingEnded',
]);

export function servedOnConsoleSession(r: AccessLogRecord): boolean {
  return SESSION_READ_KINDS.has(accessKind(r));
}

/**
 * WHAT THE ACCESS WAS SCOPED TO, beyond the conversation column: the role of a console sign-in, the
 * assistant a team read through, the classifications a content read was narrowed to, and the query it ran.
 */
export interface AccessScope {
  role: string | null;
  assistant: string | null;
  classifications: string | null;
  query: string | null;
}

export function accessScope(r: AccessLogRecord): AccessScope {
  const d = detailOf(r);
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return { role: str(d.role), assistant: accessAssistant(r), classifications: str(d.scope), query: str(d.queryType) };
}
