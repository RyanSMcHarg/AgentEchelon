/**
 * A signed-in person's email preferences (B9, M-7): `GET` and `POST /email/preferences/mine` on the person API
 * (`backend/lambda/src/notice-preferences-api.ts`). The same preferences an email's own preference link
 * changes: a mute set here is the one a send obeys. The person is the caller the edge authorizer resolved,
 * so there is no parameter naming whose preferences these are.
 *
 * Served with the `notifications` capability: a deployment that sends no email has no preferences, and the
 * screen is not offered.
 */
import { personApiServes, personUrl } from '@ae/shared';

/** One kind of email, as the server lists it, in its order. */
export interface NoticeKindView {
  kind: string;
  /** Sent whatever is muted: an invitation, a claim, a reply receipt. */
  transactional: boolean;
  muted: boolean;
}

export interface NoticePreferencesView {
  kinds: NoticeKindView[];
  /** Every stoppable kind is muted at once. */
  allMuted: boolean;
}

/** A refusal the server named, shown in the client's own words (tenet D11). */
export class NoticePreferencesError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'NoticePreferencesError';
    this.code = code;
  }
}

/** Whether this deployment serves the screen's routes. */
export function isEmailPreferencesConfigured(): boolean {
  return personApiServes('notifications');
}

async function call(init: RequestInit): Promise<NoticePreferencesView> {
  const token = localStorage.getItem('idToken');
  if (!token) throw new NoticePreferencesError('UNAUTHENTICATED', 'Not authenticated');
  const resp = await fetch(personUrl('/email/preferences/mine'), {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const body = await resp.json().catch(() => ({})) as Partial<NoticePreferencesView> & { code?: string; error?: string };
  if (!resp.ok) throw new NoticePreferencesError(body.code || `HTTP_${resp.status}`, body.error || resp.statusText);
  return { kinds: Array.isArray(body.kinds) ? body.kinds : [], allMuted: body.allMuted === true };
}

/** The caller's preferences. */
export function fetchNoticePreferences(): Promise<NoticePreferencesView> {
  return call({ method: 'GET' });
}

/** Mute or unmute one kind, or every kind (`'*'`); answers the preferences after the change. */
export function setNoticeMuted(kind: string, muted: boolean): Promise<NoticePreferencesView> {
  return call({ method: 'POST', body: JSON.stringify({ kind, muted }) });
}
