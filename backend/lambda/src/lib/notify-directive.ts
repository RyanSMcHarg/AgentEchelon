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
}): Record<string, unknown> {
  const targets = (args.targets || []).filter(Boolean);
  return {
    notify: { email: true },
    ...(args.subject ? { notifySubject: args.subject } : {}),
    ...(targets.length ? { notifyTargets: targets.map((person) => ({ person })) } : {}),
    ...(targets.length && args.kind && args.kind !== 'conversation' ? { notifyKind: args.kind } : {}),
    ...(args.conversationId ? { notifyConversationId: args.conversationId } : {}),
  };
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
