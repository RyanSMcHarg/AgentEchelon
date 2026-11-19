/**
 * THE SHAPES AN EMAIL IS ASKED FOR IN: the `notify` directive a message carries, and the link into a
 * conversation it may name. Pure and dependency-free, so a notice builder can import it without the
 * fan-out's clients.
 *
 * The bridge that reads the directive is `lib/channel-notify.ts` (`parseNotifyDirective`), and it
 * re-exports both builders. `backend/test/single-entry-point.test.ts` refuses a hand-written copy of
 * either.
 */

/**
 * THE ONE DIRECTIVE BUILDER: the Metadata keys that ask the bridge to email a message, in the shape
 * `parseNotifyDirective` reads. Every producer spreads this into its message Metadata rather than writing
 * the keys by hand, so a key renamed here is renamed for all of them.
 */
export function notifyDirective(args: {
  subject?: string;
  /** People to address, by AppInstanceUser ARN; omitted addresses the membership or the mentioned members. */
  targets?: string[];
  /** A conversation the email links into, by channel id. */
  conversationId?: string;
  /**
   * The kind of notice an ADDRESSED email is (`targets`), which decides what a recipient's mute stops
   * (`lib/notice-preferences.ts`). One of {@link DIRECTIVE_NOTICE_KINDS}; absent is `conversation`. Written
   * only with `targets`: a membership-wide or mentioned email is always `conversation`.
   */
  kind?: DirectiveNoticeKind;
  /** The email's body, where it differs from the message: an assistant's own `email.body` section. A person's is never read. */
  body?: string;
  /** Where the email's button leads, with `conversationId`: its meeting window (`meeting`), else the conversation. */
  link?: 'meeting';
  /** People a room-wide email leaves out, by AppInstanceUser id: the person a notice is about who already knows it. */
  exclude?: string[];
}): Record<string, unknown> {
  const targets = (args.targets || []).filter(Boolean);
  return {
    notify: { email: true },
    ...(args.subject ? { notifySubject: args.subject } : {}),
    ...(targets.length ? { notifyTargets: targets.map((person) => ({ person })) } : {}),
    ...(targets.length && args.kind && args.kind !== 'conversation' ? { notifyKind: args.kind } : {}),
    ...(args.conversationId ? { notifyConversationId: args.conversationId } : {}),
    ...(args.body ? { notifyBody: args.body } : {}),
    ...(args.link && args.conversationId ? { notifyLink: args.link } : {}),
    ...(args.exclude?.filter(Boolean).length ? { notifyExclude: args.exclude.filter(Boolean) } : {}),
  };
}

/**
 * A MESSAGE'S METADATA WITHIN THE SERVICE'S CAP (`max`, encoded as every message is sent). What gives way, in order:
 *  1. an email's own words, its body and then its subject, so the email falls back to the message's text and the default
 *     subject and is still sent;
 *  2. the oldest of a workflow run's moves (`eventRun.transitions`), down to the newest one. A run's every message
 *     carries its moves so far, so the earlier ones are already on the run's earlier messages, and a long run's card
 *     (its task, its buttons, its email directive) is still posted;
 *  3. the last of a meeting card's hosts (`meetingCard.hosts`), first recorded kept longest. The list only decides who an
 *     app offers the transcript and the recording to; the download path signs them for the recorded hosts whatever the
 *     card lists, so a shorter list hides a link and grants nothing.
 * Everything else the Metadata carries stays as it is.
 */
export function withinMetadataCap(metadata: Record<string, unknown>, max: number): Record<string, unknown> {
  const size = (m: Record<string, unknown>) => encodeURIComponent(JSON.stringify(m)).length;
  let out = metadata;
  for (const key of ['notifyBody', 'notifySubject']) {
    if (size(out) <= max) break;
    if (key in out) { const { [key]: _shed, ...rest } = out; out = rest; }
  }
  const run = out.eventRun as { transitions?: unknown } | undefined;
  if (size(out) > max && run && Array.isArray(run.transitions)) {
    let moves = run.transitions as unknown[];
    while (moves.length > 1 && size(out) > max) {
      moves = moves.slice(1);
      out = { ...out, eventRun: { ...run, transitions: moves } };
    }
  }
  const card = out.meetingCard as { hosts?: unknown } | undefined;
  if (size(out) > max && card && Array.isArray(card.hosts)) {
    let hosts = card.hosts as unknown[];
    while (hosts.length > 0 && size(out) > max) {
      hosts = hosts.slice(0, -1);
      out = { ...out, meetingCard: { ...card, hosts } };
    }
  }
  return out;
}

/**
 * THE KINDS A DIRECTIVE MAY NAME: the notices about a conversation a person can stop. Never a transactional
 * kind, which is sent whatever a person has muted, so no message's Metadata can lift a mute by naming one.
 */
export const DIRECTIVE_NOTICE_KINDS = ['conversation', 'conversation-shared', 'task'] as const;
export type DirectiveNoticeKind = (typeof DIRECTIVE_NOTICE_KINDS)[number];
export const isDirectiveNoticeKind = (v: unknown): v is DirectiveNoticeKind =>
  typeof v === 'string' && (DIRECTIVE_NOTICE_KINDS as readonly string[]).includes(v);

/**
 * THE ONE CONVERSATION LINK: opens one conversation in the chat app, in the shape the client follows,
 * `<app>?conversation=<channel id>`.
 *
 * BUILT HERE FROM AN ID, NEVER TAKEN AS A URL. The id is validated to the id alphabet and the origin is
 * this deployment's own configuration, so nothing a directive says can point a recipient anywhere but
 * this app. Absent an origin, or given anything that is not an id, there is no link rather than a wrong
 * one.
 */
export function conversationDeepLink(appUrl: string, conversationId: string | undefined): string | undefined {
  if (!appUrl || !conversationId || !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) return undefined;
  return `${appUrl}?${conversationRef(conversationId)}`;
}

/** The query that names a conversation to the chat app, relative to wherever the reader already is. */
export function conversationRef(conversationId: string): string {
  return `conversation=${encodeURIComponent(conversationId)}`;
}

/**
 * The query that opens a conversation's meeting window in the chat app: the meeting full-window, with the conversation's
 * chat beside it, after sign-in. Relative, as `conversationRef` is.
 */
export function meetingRef(conversationId: string): string {
  return `meeting=${encodeURIComponent(conversationId)}`;
}

/** THE ONE MEETING LINK, built as {@link conversationDeepLink} is: from an id and this deployment's own origin, or none. */
export function meetingDeepLink(appUrl: string, conversationId: string | undefined): string | undefined {
  if (!appUrl || !conversationId || !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) return undefined;
  return `${appUrl}?${meetingRef(conversationId)}`;
}

/** Where an email's button leads: the conversation (absent), or its meeting window. */
export const DIRECTIVE_LINKS = ['meeting'] as const;
export type DirectiveLink = (typeof DIRECTIVE_LINKS)[number];

/** The query that opens the chat app's signed-in email preferences screen. */
export const PREFERENCES_SCREEN_QUERY = 'settings=email-preferences';

/**
 * THE LINK TO A PERSON'S SIGNED-IN EMAIL PREFERENCES: the chat app's screen, opened after sign-in, built from
 * this deployment's own origin. Absent an origin there is no link rather than a wrong one.
 */
export function preferencesScreenLink(appUrl: string): string | undefined {
  if (!appUrl || !/^https?:\/\//.test(appUrl)) return undefined;
  return `${appUrl}?${PREFERENCES_SCREEN_QUERY}`;
}
