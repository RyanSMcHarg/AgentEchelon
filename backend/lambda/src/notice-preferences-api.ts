/**
 * A SIGNED-IN PERSON'S EMAIL PREFERENCES (B9, M-7): `GET` and `POST /email/preferences/mine`.
 *
 * The chat app's preferences screen reads and changes the same `<personId>#notices` item an email's own
 * preference link does (`email-preferences.ts`, `lib/notice-preferences.ts`), so a mute set in either place
 * is the one a send obeys. This route is behind sign-in, where the link's page is reached by a token:
 *
 *  - `GET` answers every kind in `NOTICE_KINDS` with whether it is muted, and each transactional kind as
 *    always sent, plus whether every stoppable kind is muted at once (`email:*`);
 *  - `POST { kind, muted }` mutes or unmutes one kind, or every kind with `kind: '*'`, and answers the
 *    preferences after the change. A transactional kind is refused: it is sent whatever is muted.
 *
 * TWO LAYERS (tenet D3). The person is the caller the edge authorizer resolved (`callerPersonArn`), never a
 * field of the request, so a person changes only their own preferences. This function's role writes only
 * `<personId>#notices` items of the user-profile table, and only their `muted`, `personArn` and `updatedAt`
 * attributes (`notification-stack.ts`), so it cannot read or change a profile, a contact copy or a token.
 *
 * A guest, a one-conversation session and a host assertion resolve to nobody here (`callerPerson`): they
 * have no account whose mail they manage.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { callerPersonArn } from './lib/auth.js';
import { responder, originsFrom, DEV_ORIGIN, requestOrigin, type HttpResult } from './lib/http-response.js';
import {
  ALL_KINDS, NOTICE_KINDS, isMuted, isNoticeKind, isTransactional, readNoticePreferences, setNoticeMute,
  type NoticeKind, type NoticePreferences,
} from './lib/notice-preferences.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

type Sender = { send(command: unknown): Promise<any> };

export const PREFERENCES_MINE_ROUTE = '/email/preferences/mine';

const http = responder({ origin: { allow: originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN) }, methods: 'GET,POST,OPTIONS' });

/** One kind, as the screen shows it. */
export interface NoticeKindView {
  kind: NoticeKind;
  /** Sent whatever the person has muted: an invitation, a claim, a reply receipt. */
  transactional: boolean;
  /** Whether it is stopped, by its own mute or by the mute of every kind. Always false for a transactional kind. */
  muted: boolean;
}

export interface NoticePreferencesView {
  /** Every kind the platform emails, in `NOTICE_KINDS` order. */
  kinds: NoticeKindView[];
  /** Whether every stoppable kind is muted at once. */
  allMuted: boolean;
}

/** The view of a person's stored preferences. Pure. */
export function preferencesView(prefs: NoticePreferences): NoticePreferencesView {
  const all = isMuted(prefs, 'email', ALL_KINDS);
  return {
    kinds: (Object.keys(NOTICE_KINDS) as NoticeKind[]).map((kind) => {
      const transactional = isTransactional(kind);
      return { kind, transactional, muted: !transactional && (all || isMuted(prefs, 'email', kind)) };
    }),
    allMuted: all,
  };
}

export interface PreferencesMineDeps {
  doc: Sender;
  table: string;
  now(): Date;
}

let defaults: PreferencesMineDeps | null = null;
const depsOf = (): PreferencesMineDeps => (defaults ??= {
  doc: DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' })),
  table: process.env.NOTICE_PREFERENCES_TABLE || '',
  now: () => new Date(),
});

function bodyOf(event: APIGatewayProxyEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function handlePreferencesMine(event: APIGatewayProxyEvent, deps: PreferencesMineDeps = depsOf()): Promise<HttpResult> {
  const origin = requestOrigin(event);
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') return http.empty(204, origin);
  if (method !== 'GET' && method !== 'POST') return http.error(405, `${method} not supported`, origin);
  const personArn = await callerPersonArn(event);
  if (!personArn) return http.error(401, 'this sign-in names no person', origin, 'NO_PERSON');
  if (!deps.table) return http.error(503, 'email preferences are not configured on this deployment', origin, 'NOT_CONFIGURED');

  if (method === 'POST') {
    const body = bodyOf(event);
    const kind = body?.kind;
    const muted = body?.muted;
    if (typeof muted !== 'boolean' || (kind !== ALL_KINDS && !isNoticeKind(kind))) {
      return http.error(400, 'name a kind of notice (or "*") and whether it is muted', origin, 'INVALID_REQUEST');
    }
    if (kind !== ALL_KINDS && isTransactional(kind as NoticeKind)) {
      return http.error(400, `${String(kind)} is always sent and cannot be muted`, origin, 'TRANSACTIONAL');
    }
    await setNoticeMute(deps.doc, deps.table, {
      personArn, route: 'email', kind: kind as NoticeKind | typeof ALL_KINDS, muted, now: deps.now(),
    });
    console.log('[notice-preferences-api] a preference was changed', { kind, muted });
  }

  const prefs = await readNoticePreferences(deps.doc, deps.table, personArn);
  // An unreadable item is not "nothing muted": say so rather than show a person mail they stopped as on.
  if (!prefs) return http.error(503, 'your email preferences could not be read', origin, 'UNREADABLE');
  return http.respond(200, preferencesView(prefs), origin);
}

export const handler = async (event: APIGatewayProxyEvent): Promise<HttpResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  try {
    return await handlePreferencesMine(event);
  } catch (err) {
    console.error('[notice-preferences-api] the request failed', { err: (err as Error)?.name || 'error' });
    return http.error(500, 'the preferences could not be changed', requestOrigin(event));
  }
};

/** Test seam. */
export function __setPreferencesMineDepsForTests(d: PreferencesMineDeps | null): void {
  defaults = d;
}
