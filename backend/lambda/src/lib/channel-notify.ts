/**
 * Conversation → transport notification fan-out (SPEC-NOTIFICATION-BRIDGE Phase 1, outbound).
 *
 * A channel message tagged with a `notify` directive in its Metadata is fanned out to the
 * conversation's MEMBERS over the requested transport (email in v1; SMS/voice are the same fan-out
 * later).
 *
 * WHO is decided by live channel MEMBERSHIP (`ListChannelMemberships`). It used to be decided by the
 * `{sub,iss,role}[]` roster stamped into channel Metadata, and that was a member-controlled recipient
 * list: Metadata is writable by any channel moderator — including a user in their own conversation —
 * so a member could add a sub and have the assistant's messages emailed to that person. Membership is
 * not forgeable that way.
 *
 * CONTACT DETAILS are resolved by person at send time, never stored: `Directory.contactFor`
 * (`lib/membership-source.ts`) finds the person's issuer subjects through `Identities` and asks that
 * issuer's directory. Nothing here reads an id's shape or a stored issuer hint, so a person of any
 * trusted issuer is reached the same way. Best-effort: reuses `lib/notification.sendEmailNotifications`;
 * failures are collected, never thrown.
 *
 * THE ONE FAN-OUT. A path that emails people it names directly (the share invitation, the briefing, an
 * alarm) calls `emailPeople` with their AppInstanceUser ARNs, so every email the platform sends resolves
 * its recipients the same way, and the directive that asks the bridge for one is built once
 * (`notifyDirective`).
 *
 * The on-channel message stays in the conversation (the in-app surface); this just adds the
 * out-of-band transport for members who aren't watching it.
 */
import { ChimeSDKMessagingClient, DescribeChannelCommand, ListChannelMembershipsCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { sendEmailNotifications, escapeHtml, type EmailRecipient, type NotificationResult } from './notification.js';
import { isAdminNotificationChannel } from './admin-channel-kind.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';
import { delimitedMentionTokens } from './flow-bypass.js';
import { appInstanceArnOf, isPersonArn, personIdFromArn, rosterOf, userArnFor } from './person-arn.js';
import { defaultDirectory, type Directory } from './membership-source.js';
import { conversationDeepLink, isDirectiveNoticeKind, notifyDirective, type DirectiveNoticeKind } from './notify-directive.js';
import { randomUUID } from 'crypto';
import { isTransactional, mayNotify, type NoticeKind } from './notice-preferences.js';
import { defaultEmailConsent, type EmailConsent } from './email-consent.js';
import { defaultEmailVoice, emailLine, emailVoiceForRoom, type EmailVoice } from './email-copy.js';

export { conversationDeepLink, notifyDirective };

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
/** The chat app's origin, for a link into a conversation. Absent ⇒ the email carries no link. */
const APP_URL = process.env.APP_URL || '';

export interface NotifyOptions {
  email?: boolean;
}

/**
 * A delivery target: a PERSON, by AppInstanceUser ARN (or a bare person id in the channel's app
 * instance). Who they are on an issuer, and where to reach them, is resolved at send time by the
 * directory; a target carries no subject, issuer or address.
 */
export interface NotifyTarget {
  person: string;
}

/** A notify directive parsed off a channel message's Metadata. */
export interface NotifyDirective {
  notify: NotifyOptions;
  /** Email subject; a sensible default is used when absent. */
  subject?: string;
  /** Limit delivery to these people (e.g. a task assignee, or a just-shared member); omit ⇒ all
   *  participants. */
  targets?: NotifyTarget[];
  /** The channel id of a conversation the email should link INTO (`notifyConversationId`). Only an id:
   *  the link is built by {@link conversationDeepLink} from this deployment's own app origin. */
  conversationId?: string;
  /** The kind an addressed email is sent as (`notifyKind`), read with `targets` only; absent is `conversation`. */
  kind?: DirectiveNoticeKind;
}

/**
 * Parse a notify directive from a channel message's Metadata string. Returns null when there is no
 * actionable directive (no metadata, bad JSON, or no transport requested) — the common case, so the
 * channel flow skips the fan-out cheaply.
 */
export function parseNotifyDirective(metadata?: string): NotifyDirective | null {
  if (!metadata) return null;
  try {
    const m = JSON.parse(metadata) as Record<string, unknown>;
    const n = m.notify as { email?: unknown } | undefined;
    if (!n || !n.email) return null;
    // notifyTargets = [{person}], each a person ARN (or a bare person id in the channel's instance).
    let targets: NotifyTarget[] | undefined;
    if (Array.isArray(m.notifyTargets)) {
      targets = (m.notifyTargets as unknown[])
        .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>) : {}))
        .filter((t) => typeof t.person === 'string' && t.person)
        .map((t) => ({ person: t.person as string }));
    }
    return {
      notify: { email: true },
      subject: typeof m.notifySubject === 'string' ? (m.notifySubject as string) : undefined,
      ...(targets && targets.length ? { targets } : {}),
      ...(typeof m.notifyConversationId === 'string' && m.notifyConversationId
        ? { conversationId: m.notifyConversationId as string } : {}),
      // A kind outside the directive's set (a transactional one, a typo) is ignored, never honored.
      ...(targets && targets.length && isDirectiveNoticeKind(m.notifyKind) ? { kind: m.notifyKind } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The people a message @mentions by id, in order, once each. Only the delimited `@<Name|id>` the
 * composer writes counts: a bare `@Name` names nobody this can resolve without guessing, and an email
 * sent on a guess goes to the wrong person.
 */
export function mentionedMemberIds(text: string): string[] {
  const seen = new Set<string>();
  return delimitedMentionTokens(text || '').tokens
    .map((t) => t.id || '')
    .filter((id) => id && !seen.has(id) && seen.add(id));
}

/** The text as a reader sees it: `@<Name|id>` becomes `@Name`. An email has no mention chip to render
 *  the token into, so the raw grammar would reach the reader as punctuation and an opaque id. */
export function readableMentions(text: string): string {
  let out = text || '';
  for (const t of [...delimitedMentionTokens(out).tokens].reverse()) {
    out = `${out.slice(0, t.at)}@${t.name}${out.slice(t.at + t.raw.length + 3)}`;
  }
  return out;
}

/**
 * The channel's HUMAN members, from live membership. This is the authority on WHO gets notified.
 *
 * WHY NOT THE METADATA ROSTER, WHICH THIS REPLACED. Channel Metadata is member-WRITABLE: a channel's
 * creator is a moderator of their own channel and holds `chime:UpdateChannel`, which rewrites Name and
 * Metadata in ONE call that IAM cannot split. Deriving the recipient list from it let any member add a
 * `sub` to their own conversation's roster and have the assistant's messages emailed to that person -
 * a member-controlled path to sending someone else conversation content out of band. Membership cannot
 * be forged that way: adding a member is `CreateChannelMembership`, a separate, moderated operation
 * that shows up in the conversation.
 *
 * Bots are excluded - they have no IdP identity and nothing to email.
 */
async function readMemberIds(
  chime: ChimeSDKMessagingClient,
  channelArn: string,
  bearerArn: string,
): Promise<string[]> {
  try {
    // PAGINATED. One 50-member page silently dropped everyone past it, and because this read is the
    // AUTHORITY for who gets notified, the omission was invisible downstream: the recipients simply
    // did not exist as far as the rest of the function was concerned. A conversation of 60 people
    // notified 50 of them and reported success.
    const ids: string[] = [];
    let nextToken: string | undefined;
    do {
      const r = await chime.send(new ListChannelMembershipsCommand({
        ChannelArn: channelArn,
        ChimeBearer: bearerArn,
        MaxResults: 50,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }));
      ids.push(...rosterOf(r.ChannelMemberships).filter((m) => m.kind === 'person').map((m) => m.id));
      nextToken = r.NextToken;
    } while (nextToken);
    return ids;
  } catch (err) {
    console.warn('[channel-notify] failed to list memberships:', err);
    return [];
  }
}


/** A target as an AppInstanceUser ARN in the channel's instance, or null when it names nobody. */
function targetArn(person: string, channelArn: string): string | null {
  if (isPersonArn(person)) return person;
  const app = appInstanceArnOf(channelArn);
  return app && person && !person.includes('/') ? userArnFor(app, person) : null;
}

/**
 * THE FAN-OUT, for a path that names its recipients: email each person, resolved by the directory at
 * send time. Who could not be reached is returned by person id in `skipped`, never dropped silently.
 *
 * EVERY MAIL NAMES ITS KIND (B9, `lib/notice-preferences.ts`). A kind outside the transactional set goes
 * only to a person whose preferences allow it, and only with its unsubscribe headers: a person who muted
 * it, a preference that cannot be read, or a link that cannot be minted sends nothing to that person, and
 * they are counted in `skipped` and `muted`. A mail about a conversation (`channelArn`) carries the
 * person's own reply address when the deployment takes replies (M-8).
 *
 * A person offboarded, or disabled at their issuer's pool, receives nothing: `Directory.contactFor`
 * answers no address for them.
 */
export async function emailPeople(args: {
  personArns: string[];
  /** What kind of notice this is, which decides whether a person can stop it. */
  kind: NoticeKind;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  /** A conversation to link into, by channel id; the link is built from this deployment's origin. */
  conversationId?: string;
  /** The conversation the mail is about, for its reply address and its assistant's voice. */
  channelArn?: string;
  appUrl?: string;
  /** Whose words wrap the mail. Default: the voice of `channelArn`'s assistant, or the stand-in copy. */
  voice?: EmailVoice;
  deps?: { directory?: Directory; send?: typeof sendEmailNotifications; consent?: EmailConsent };
}): Promise<{ emailed: string[]; skipped: string[]; failed: string[]; muted: string[]; notSentBecause?: string }> {
  const directory = args.deps?.directory ?? defaultDirectory();
  const send = args.deps?.send ?? sendEmailNotifications;
  const consent = args.deps?.consent ?? defaultEmailConsent();
  const voice = args.voice ?? (args.channelArn ? await emailVoiceForRoom(args.channelArn) : defaultEmailVoice());
  const { copy } = voice;
  const transactional = isTransactional(args.kind);
  const noticeId = randomUUID();
  const toSend: EmailRecipient[] = [];
  const skipped: string[] = [];
  const muted: string[] = [];
  const seen = new Set<string>();
  for (const arn of args.personArns) {
    if (!arn || seen.has(arn)) continue;
    seen.add(arn);
    const who = personIdFromArn(arn) || arn;
    const contact = await directory.contactFor(arn, 'email');
    if (!contact) { skipped.push(who); continue; }
    let unsubscribeUrl: string | undefined;
    if (!transactional) {
      const allowed = mayNotify(await consent.preferences(arn), 'email', args.kind);
      if (!allowed.ok) {
        console.log('[channel-notify] not emailed: the person has not consented to this kind', { kind: args.kind, reason: allowed.reason });
        skipped.push(who);
        muted.push(who);
        continue;
      }
      const url = await consent.unsubscribeUrl({ personArn: arn, kind: args.kind, ...(args.channelArn ? { channelArn: args.channelArn } : {}), copy });
      if (!url) {
        console.warn('[channel-notify] not emailed: no unsubscribe link could be minted, and this kind needs one', { kind: args.kind });
        skipped.push(who);
        continue;
      }
      unsubscribeUrl = url;
    }
    const replyTo = args.channelArn
      ? await consent.replyAddress({ personArn: arn, channelArn: args.channelArn, noticeId, kind: args.kind })
      : null;
    toSend.push({
      email: contact.address,
      name: contact.name || '',
      ...(replyTo ? { replyTo } : {}),
      ...(unsubscribeUrl ? { unsubscribeUrl } : {}),
    });
  }
  if (!toSend.length) return { emailed: [], skipped, failed: [], muted };

  // THE DEEP LINK, when the caller names a conversation and the deployment knows its own origin. One
  // link, worded and styled the same, everywhere an email opens a conversation.
  const link = conversationDeepLink(args.appUrl ?? APP_URL, args.conversationId);
  if (args.conversationId && !link) {
    console.warn('[channel-notify] a conversation link was asked for and cannot be built; sending without it', {
      hasAppUrl: Boolean(args.appUrl ?? APP_URL),
    });
  }
  const button = link
    ? `<p style="margin: 24px 0;"><a href="${escapeHtml(link)}" style="background: #2d2d2d; color: #fff; `
      + `padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">${escapeHtml(copy.openConversation)}</a></p>`
    : '';
  const res: NotificationResult = await send(toSend, {
    subject: args.subject,
    bodyText: link ? `${args.bodyText}\n\n${emailLine(voice, 'viewItHere', { link })}` : args.bodyText,
    ...(link || args.bodyHtml ? { bodyHtml: (args.bodyHtml ?? `<p>${escapeHtml(args.bodyText)}</p>`) + button } : {}),
    voice,
  });
  return { emailed: res.sent, skipped, failed: res.failed.map((f) => f.email), muted, ...(res.skipped ? { notSentBecause: res.skipped } : {}) };
}

/**
 * Fan a channel notification out to the conversation's participants over the requested transports.
 * Email is the one transport. Best-effort; returns who was reached/skipped/failed, by person id.
 */
export async function fanOutChannelNotification(args: {
  channelArn: string;
  bearerArn: string;
  messageText: string;
  directive: NotifyDirective;
  /**
   * A PERSON wrote the message, not an assistant. Their directive is member-writable Metadata, so it
   * may reach only the members they @mention: its `notifyTargets` are ignored (they bypass membership)
   * and it never becomes a membership-wide email, even in the admin conversation.
   */
  personSent?: boolean;
  /** Who wrote it, so mentioning yourself does not email you. */
  senderArn?: string;
  /** The chat app's origin for a conversation link. Defaults to `APP_URL`. */
  appUrl?: string;
  deps?: {
    chime?: ChimeSDKMessagingClient;
    directory?: Directory;
    send?: typeof sendEmailNotifications;
    isEmailConversation?: (chime: ChimeSDKMessagingClient, channelArn: string) => Promise<boolean>;
    consent?: EmailConsent;
    voice?: EmailVoice;
  };
}): Promise<{ emailed: string[]; skipped: string[]; failed: string[]; emailOff?: boolean }> {
  const { channelArn, bearerArn, messageText, directive } = args;
  const chime = args.deps?.chime ?? sessionClient(ChimeSDKMessagingClient, { region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER });

  if (!directive.notify.email) return { emailed: [], skipped: [], failed: [] };

  // ── ONLY THE ADMIN CONVERSATION SENDS EMAIL ──────────────────────────────────
  //
  // A `notify` directive asks for email; whether the conversation sends any is decided from the live
  // channel, by the immutable `aeChannelKind` tag its provisioner stamps at creation - never from a
  // copy, and never from Metadata, which members can write. A tag that cannot be read is not the admin
  // conversation: an unreadable answer must not become an email to every member.
  //
  // FUTURE SCOPE, not built: per-conversation email for other conversations, and "email only when the
  // recipient is not connected when the message is sent" (email in place of an unfocused-tab browser
  // notification is roadmap). The admin conversation and the communication-hub project hold the start
  // of that design.
  // ── THE GATE IS ABOUT A BROADCAST, SO IT GATES THE BROADCAST (review, 2026-09-17) ───────────────
  //
  // Applied to EVERY directive, this also blocked the one notification that is not a broadcast at
  // all: a host's add-member (`membershipHandler`) posts a `notify.email` with an explicit `notifyTargets` into the
  // conversation it just created, and that is the invitation - the one email an invited person cannot
  // discover any other way. The gate silently dropped it, because a new conversation is not the admin
  // conversation.
  //
  // The risk this gate names is "an unreadable answer must not become an email to every member", and
  // an explicit server-side target list is not that. It also cannot be forged: `decideNotify` fans out
  // only a message whose sender ARN carries `/bot/`, so a person's hand-crafted Metadata never reaches
  // here. So the membership-derived fan-out stays admin-only and an addressed notification is allowed
  // through, which keeps both halves of the 2026-09-15 decision rather than trading one for the other.
  //
  // ── A MENTION ADDRESSES ITS EMAIL ───────────────────────────────────────────
  //
  // "The single recipient email should be message with mention triggering single email" - and only
  // when the directive asks for email, so a mention alone sends nothing. Anyone's mention may, people
  // included. It is addressed rather than a broadcast, so it passes the gate above for the same reason
  // an explicit target list does, and it is bounded by live MEMBERSHIP below: a mention of somebody who
  // is not in the room reaches nobody, because the id in the token is text the writer chose.
  const senderId = personIdFromArn(args.senderArn) || '';
  const mentioned = mentionedMemberIds(messageText).filter((id) => id !== senderId);
  const explicitlyTargeted = !args.personSent && Boolean(directive.targets && directive.targets.length);
  const mentionTargeted = !explicitlyTargeted && mentioned.length > 0;
  if (args.personSent && !mentionTargeted) {
    console.log('[channel-notify] a person\'s email reaches only the members they mention; not sending', { channelArn });
    return { emailed: [], skipped: [], failed: [], emailOff: true };
  }
  const isEmailConversation = args.deps?.isEmailConversation ?? isAdminNotificationChannel;
  if (!explicitlyTargeted && !mentionTargeted && !(await isEmailConversation(chime, channelArn).catch(() => false))) {
    console.log('[channel-notify] a membership-wide email is sent only in the admin conversation; not sending', {
      channelArn,
    });
    return { emailed: [], skipped: [], failed: [], emailOff: true };
  }

  // Recipients: explicit `targets` resolve DIRECTLY (a targeted recipient — e.g. a just-shared
  // member — may not be in the channel membership yet, which is the whole point of a share
  // notification). Those come from the CALLER, server-side, not from channel Metadata.
  //
  // Otherwise the recipient set is the channel's live MEMBERSHIP. It used to be the Metadata roster,
  // which a member could rewrite to have conversation content emailed to someone of their choosing —
  // see `readMemberIds`.
  let personArns: string[];
  // ACCOUNTED FOR, NOT JUST LOGGED (review, 2026-09-17). A dropped recipient that appeared in neither
  // `emailed` nor `failed` nor `skipped` let the caller's own record - which `notify-on-delivery` logs
  // and turns into a metric - say the fan-out reached everyone it could.
  const notReached: string[] = [];
  if (explicitlyTargeted && directive.targets) {
    personArns = [];
    for (const t of directive.targets) {
      const arn = targetArn(t.person, channelArn);
      if (arn) personArns.push(arn);
      else notReached.push(t.person);
    }
  } else {
    const memberIds = await readMemberIds(chime, channelArn, bearerArn);
    let reachable = memberIds;
    if (mentionTargeted) {
      reachable = memberIds.filter((id) => mentioned.includes(id));
      const notMembers = mentioned.filter((id) => !memberIds.includes(id));
      if (notMembers.length) {
        // Accounted for in `skipped`: a mention that emailed nobody must not read as a fan-out that
        // reached everyone it could.
        notReached.push(...notMembers);
        console.log('[channel-notify] mentioned but not a member of this conversation; not emailed', {
          channelArn, count: notMembers.length,
        });
      }
    }
    personArns = reachable.map((id) => targetArn(id, channelArn)).filter((a): a is string => Boolean(a));
  }
  if (!personArns.length) return { emailed: [], skipped: [...notReached], failed: [] };

  // ONE FAN-OUT. Each person's contact is resolved by the directory, through `Identities`, whichever
  // trusted issuer they sign in with; the deep link is built there from the directive's channel id.
  // In the words of the conversation's assistant, and replyable as the person (M-8).
  const voice = args.deps?.voice ?? await emailVoiceForRoom(channelArn);
  // THE DIRECTIVE NAMES THE KIND ONLY WHEN IT ADDRESSES ITS RECIPIENTS: the welcome to a person just added
  // to a conversation is `conversation-shared`, so muting that kind stops it. A broadcast or a mention is
  // always `conversation`.
  const kind: NoticeKind = explicitlyTargeted && directive.kind ? directive.kind : 'conversation';
  const res = await emailPeople({
    personArns,
    kind,
    subject: directive.subject || voice.copy.defaultSubject,
    bodyText: readableMentions(messageText),
    channelArn,
    voice,
    ...(directive.conversationId ? { conversationId: directive.conversationId } : {}),
    ...(args.appUrl !== undefined ? { appUrl: args.appUrl } : {}),
    deps: { directory: args.deps?.directory, send: args.deps?.send, consent: args.deps?.consent },
  });
  return { emailed: res.emailed, skipped: [...notReached, ...res.skipped], failed: res.failed };
}
