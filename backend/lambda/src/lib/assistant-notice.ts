/**
 * A NOTICE IS SAID BY THE ASSISTANT IT CONCERNS, IN THAT ASSISTANT'S OWN WORDS.
 *
 * The channel flow decides that something needs saying - a `/battle` that cannot start, a duel that
 * ended, a spend that was refused - but it composes no words. It names a notice KIND and hands it to
 * the classification's router (`aeNotice`), and the router posts it as the addressed assistant, from
 * that assistant's message templates, under its own name and attribution. A
 * deployment that configured a terse assistant, or one holding its conversations in another language,
 * gets its own line here exactly as it does for the queue and stop lines (tenets P5 and D11).
 *
 * Each notice is a message template (ADR-062): the one the version's `messages` names, else the assistant's own,
 * else the classification's, else the shipped one, whose English is `notice-copy.ts`. Nothing here builds grammar
 * (plurals, lists) in one language.
 */
/**
 * The turn's words object, which carries its stored templates (`withMessageTemplates`, `message-lines.ts`). Typed by
 * its shape, so the notice path and the console's editor read it without the profile module.
 */
type VersionCopy = object;
import type { NoticeKind } from './bot-message-attribution.js';
import { notifyDirective } from './notify-directive.js';
import type { ParsedTemplate } from './document-template.js';
import { cleanMessageValue, renderMessageTemplate } from './message-template.js';
import { localizedTemplate, messageTemplateFor, resolverValues } from './message-lines.js';
import { noticeTemplateName, shippedMessageTemplate } from './shipped-message-templates.js';

import { DEFAULT_NOTICE_COPY, NOTICE_AUDIENCE, NOTICE_VARIABLES, NOTICE_VARS, type NoticeCopyKey } from './notice-copy.js';
import { inertMention } from './message-markers.js';
import { mentionRenders } from './variables.js';

export { DEFAULT_NOTICE_COPY, NOTICE_AUDIENCE, NOTICE_VARIABLES, NOTICE_VARS, type NoticeCopyKey };

/**
 * The variables a kind accepts, validated. Returns the refusal reason instead when any is not acceptable.
 *
 * EVERY MARKER A READER ACTS ON IS STRIPPED, not only comment markers: the chat client switches every
 * reader's conversation on `NAVIGATE_CHANNEL:<arn>|<label>` in an assistant's message, and a variable here
 * can carry text a member controls (a display name, a conversation's title). The check is the one a message
 * template's values get (`cleanMessageValue`), so a notice and a template strip and cap alike. No notice takes
 * a URL: the one that did, the proactive briefing's presigned page, is now the conversation it is said in, so
 * a service has no way to put a link of its choosing in an assistant's mouth.
 *
 * A VARIABLE DECLARED AS A MENTION (`NOTICE_VARIABLES`) renders as an inert display name (ADR-060 decision 7): a
 * person's name in a notice the room reads addresses nobody, carries no link and no marker syntax.
 */
export function checkNoticeVars(kind: NoticeCopyKey, vars: Record<string, unknown> = {}): { vars: Record<string, string> } | { refused: string } {
  const spec = NOTICE_VARS[kind] ?? {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(vars)) {
    const type = spec[key];
    if (!type) return { refused: `the notice ${kind} takes no variable named ${key}` };
    const checked = cleanMessageValue(type, raw, key);
    if ('refused' in checked) {
      if (checked.cap !== undefined) {
        // Logged by kind, name and length, never the value.
        console.warn('[assistant-notice] refused an over-cap variable', { kind, variable: key, type, length: checked.length, cap: checked.cap });
        return { refused: `the notice ${kind}'s ${type} ${key} is ${checked.length} characters, over its ${checked.cap} cap` };
      }
      return { refused: checked.refused };
    }
    out[key] = NOTICE_VARIABLES[kind]?.[key]?.mention ? inertMention(checked.value) : checked.value;
  }
  return { vars: out };
}

/**
 * The metadata a kind carries beyond attribution, BUILT HERE from its checked variables, never supplied by
 * a caller. These are the shapes the client and the notification bridge already read: a join announcement,
 * a welcome emailed to the new member.
 *
 * `at` is where the router says the notice. A welcome's email links into that conversation, by the id of the
 * channel the notice is posted in, so a caller cannot point the link anywhere else.
 */
export function noticeMetadata(
  kind: NoticeCopyKey,
  vars: Record<string, string>,
  at: { channelArn?: string; template?: ParsedTemplate } = {},
): Record<string, unknown> {
  switch (kind) {
    case 'memberJoined':
      return { systemAnnouncement: 'member_joined' };
    case 'memberWelcome': {
      const conversationId = (at.channelArn || '').split('/channel/')[1] || '';
      // THE EMAIL'S SUBJECT IS THE TEMPLATE'S `email.subject`, rendered from the same checked values. A
      // caller that still names a subject of its own (`notifySubject`, the event creator's topic label) keeps it.
      const rendered = renderMessageTemplate(at.template ?? shippedMessageTemplate(noticeTemplateName(kind)), vars, { sections: ['email.subject'], refusedValue: 'empty' });
      const subject = vars.notifySubject || (rendered.ok ? rendered.sections['email.subject'] : '') || undefined;
      return {
        systemAnnouncement: 'join_summary',
        // The person just added is told so as a `conversation-shared` notice, the kind they can mute, with
        // a link into the conversation they were added to.
        ...(vars.notifyPerson ? notifyDirective({
          subject,
          targets: [vars.notifyPerson],
          kind: 'conversation-shared',
          ...(conversationId ? { conversationId } : {}),
        }) : {}),
      };
    }
    default:
      return {};
  }
}


/**
 * WHAT A NOTICE'S TEMPLATE IS CHECKED AGAINST (ADR-060 decision 3): who reads it, by where it is said (`to` empty is
 * the room) or, for a notice that names a person, by its declaration; and the fields it renders as mentions.
 */
export function noticeUse(kind: NoticeCopyKey, to: readonly string[] = []): { audience: 'room' | 'addressed'; mentions: string[] } {
  const audience = to.length ? 'addressed' : (NOTICE_AUDIENCE[kind] ?? 'room');
  const mentions = Object.entries(NOTICE_VARIABLES[kind] ?? {}).filter(([, d]) => d.mention).map(([v]) => v);
  return { audience, mentions };
}

/**
 * A NOTICE'S MENTIONS RENDER ONLY FOR MEMBERS (ADR-060 decision 7, second layer): each mention field the caller names
 * a person for (`people`, field to AppInstanceUser ARN) is checked against the conversation's live membership when the
 * notice is said, and one naming a person who is not a member is left out, so its line drops. A mention whose person
 * the caller did not name is kept as checked (`checkNoticeVars`) and reported back, so the caller can log it.
 */
export function noticeMentionsForMembers(
  kind: NoticeCopyKey,
  vars: Readonly<Record<string, string>>,
  people: Readonly<Record<string, string>> | undefined,
  members: ReadonlySet<string>,
): { vars: Record<string, string>; unverified: string[]; notMembers: string[] } {
  const out = { ...vars };
  const unverified: string[] = [];
  const notMembers: string[] = [];
  for (const field of noticeUse(kind).mentions) {
    if (!(field in out)) continue;
    const person = people && Object.prototype.hasOwnProperty.call(people, field) ? people[field] : undefined;
    if (typeof person !== 'string' || !person.includes('/user/')) { unverified.push(field); continue; }
    if (!mentionRenders({ person, members })) { delete out[field]; notMembers.push(field); }
  }
  return { vars: out, unverified, notMembers };
}

/** Which attribution kind each notice is recorded under (`turnKind` on the message Metadata). */
export function noticeTurnKind(key: NoticeCopyKey): NoticeKind {
  return key.startsWith('battle') ? 'battle-notice' : 'notice';
}

export function isNoticeCopyKey(value: unknown): value is NoticeCopyKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_NOTICE_COPY, value);
}

/**
 * The template a notice is said from: `stored` when the caller selected one from the store
 * (`message-template-selection.ts`), else the selection order over the templates the turn's words carry: the
 * assistant's own stored template, the classification's, the deployment-wide line when one is configured, then the
 * shipped template.
 */
export function noticeTemplate(
  copy: VersionCopy | undefined,
  key: NoticeCopyKey,
  deploymentDefault?: string,
  stored?: ParsedTemplate,
): ParsedTemplate {
  if (stored) return stored;
  // The selection order, with the stored templates the turn's copy carries (`templatesOf`) where it read them.
  return messageTemplateFor(noticeTemplateName(key), { copy }, deploymentDefault);
}

/**
 * The line for one notice, rendered from its template (`renderMessageTemplate`): each `{{field}}` filled
 * with its checked value, and a line naming a field with no value left out. A value its field's type refuses
 * is treated as empty, so the rest of the notice is still said.
 */
export function noticeLine(
  copy: VersionCopy | undefined,
  key: NoticeCopyKey,
  vars: Record<string, string | number> = {},
  /** A deployment-wide line that stands between the profile's and the shipped English. */
  deploymentDefault?: string,
  /** A template the store selected for this notice, ahead of the templates the turn's words carry. */
  stored?: ParsedTemplate,
): string {
  // IN THE LANGUAGE ITS READERS GET (ADR-062 decision 4): the first written language in the order for its audience.
  const template = localizedTemplate(noticeTemplate(copy, key, deploymentDefault, stored), { copy }, noticeUse(key).audience);
  // A field the template binds to a source or a version variable is read through the turn's resolver, where the copy
  // carries one (ADR-060, slice 1d); a value the call site passes stands over it.
  const resolved = resolverValues(template, { copy }, noticeUse(key).audience);
  const rendered = renderMessageTemplate(template, { ...resolved, ...vars }, { sections: ['chat'], refusedValue: 'empty' });
  return rendered.ok ? rendered.sections.chat ?? '' : '';
}

/**
 * What the channel flow hands the router to say. The router validates every field before it speaks:
 * the conversation must carry this router's classification and the bot must be one of its assistants.
 */
export interface NoticeRequest {
  kind: NoticeCopyKey;
  channelArn: string;
  /** The assistant that says it. */
  botArn: string;
  /** Who sees it. Empty means the whole conversation. */
  to: string[];
  vars?: Record<string, string | number>;
  /**
   * The person each mention field names, as an AppInstanceUser ARN (`memberJoined`'s `name`, `conversationArchived`'s
   * `who`): the router checks each against live membership before the name is said (`noticeMentionsForMembers`).
   */
  people?: Record<string, string>;
}

export interface NoticeEvent {
  aeNotice: NoticeRequest;
}

export interface NoticeOutcome {
  posted: boolean;
  /** Why nothing was posted, when nothing was. */
  reason?: string;
}
