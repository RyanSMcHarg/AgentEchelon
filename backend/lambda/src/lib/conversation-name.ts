/**
 * THE NAME A CONVERSATION IS CREATED WITH, FROM WHAT IT WAS OPENED FOR.
 *
 * A room the platform opens for a purpose (an event, an alarm, a visit, a claim, a briefing, the admin notification
 * channel) knows what it is about at creation, so it is created with that name and never shows the placeholder. A
 * person's own conversation knows nothing yet: it opens with {@link PLACEHOLDER_TITLE}, and its first message names it
 * (`channel-title.ts`), which renames only a room still carrying the placeholder. So a name given here, and a name a
 * person types afterwards, are never overwritten.
 *
 * THE ORDER, most specific first:
 *  1. The conversation type's own `name` (`lib/config/conversation-types.ts`), the builder's template over what opened
 *     the room. One that inserts a field the opening does not carry is passed over.
 *  2. For a room an event opened: the event's label, then the alarm the room watches (with its service where the
 *     event names one), then the event's one-line summary.
 *  3. The platform's default for the kind of room: a section of the `conversation-name` message template, read through
 *     the selection every message follows (the room's assistant's own template, the classification's, then the
 *     shipped one), so a builder rewords it, and adds a language, where every other message is reworded. A room an
 *     event opened falls back to `label.opened`, which names it by its type. Every default is a short Title Case noun
 *     phrase saying what the room is for, its most specific context first.
 *  4. The placeholder, for a room with no purpose at all, so it is named from its first message as a person's is.
 *
 * A ROOM'S SUBJECT IS NOT ITS NAME. The subject is the noun phrase the welcome says ("this conversation picks up
 * <subject>"), so it is the event's label, the alarm form, or the type's default, and never the summary sentence a name
 * may fall back to ({@link conversationSubjectFor}).
 *
 * PURE: the caller reads the templates (`loadMessageTemplateSet`) and hands them in; with none, the shipped template
 * answers in its own language.
 */
import { CONVERSATION_NAME_FIELDS, getConversationTypeConfig, type ConversationNameField } from '../../../lib/config/conversation-types.js';
import { templateLine, type VersionWords } from './message-lines.js';
import { renderPrompt } from './render-prompt.js';

/**
 * THE PLATFORM'S MARKER FOR A ROOM NOT YET NAMED: the name a conversation with no purpose is created with, and the only
 * name its first message replaces. It is the platform's own value, written by the server alone (a client asks for an
 * unnamed room by sending no title), so matching it is matching a marker, never a phrase a person typed (tenet D11). A
 * client shows it in the reader's language.
 */
export const PLACEHOLDER_TITLE = 'New conversation';

/** The message template each kind of room's default name is a section of. */
export const CONVERSATION_NAME_TEMPLATE = 'conversation-name';

/** The longest name given at creation, in characters a reader sees: a sidebar shows far fewer than the service allows. */
export const MAX_CONVERSATION_NAME_LENGTH = 80;

/** Amazon Chime SDK's limit on a channel's `Name`, in UTF-16 code units. A name never reaches it. */
export const CHANNEL_NAME_MAX_UNITS = 256;

/** What a room was opened for, each a field a type's `name` may insert. */
export type ConversationNameValues = Partial<Record<ConversationNameField, string>>;

/**
 * The kinds of room the platform names by default: `opened` for a room an event or the platform opens, the others for
 * the room each creator opens. Each is a section `label.<kind>` of the `conversation-name` template.
 */
export type ConversationNameKind = 'opened' | 'visitor' | 'customer' | 'briefing' | 'adminNotifications';

/** The text split into what a reader sees as single characters, so a cut never splits a surrogate pair or a mark. */
function graphemesOf(s: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  return Segmenter ? Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (g) => g.segment) : Array.from(s);
}

/**
 * A NAME, KEPT IN ITS OWN SCRIPT: letters and numbers of every language, the marks that combine with them, and the
 * punctuation a title carries; control characters and markup are dropped and whitespace is collapsed. Cut at a word
 * boundary to {@link MAX_CONVERSATION_NAME_LENGTH} characters, by whole characters (a CJK Extension B ideograph or a
 * letter with its marks is never split), and within {@link CHANNEL_NAME_MAX_UNITS}. Empty when nothing readable is left.
 */
export function conversationNameText(raw: string | undefined | null, max = MAX_CONVERSATION_NAME_LENGTH): string {
  const s = String(raw ?? '').normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\p{Zs}\-_.,:;'&()/#+!?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = graphemesOf(s);
  let units = 0;
  let fits = 0;
  while (fits < chars.length && fits < max && units + chars[fits].length <= CHANNEL_NAME_MAX_UNITS) {
    units += chars[fits].length;
    fits++;
  }
  if (fits === chars.length) return s;
  // A word boundary at or just past the cut, when one is near enough to the end that the name keeps most of itself.
  let cut = -1;
  for (let i = fits; i >= 0; i--) {
    if (chars[i] === ' ') { cut = i; break; }
  }
  return (cut > fits * 0.6 ? chars.slice(0, cut) : chars.slice(0, fits)).join('').replace(/[\s\-_.,:;]+$/u, '');
}

/** Only the values that are present, trimmed, and fit for a name. */
function presentValues(values: ConversationNameValues): ConversationNameValues {
  const out: ConversationNameValues = {};
  for (const field of CONVERSATION_NAME_FIELDS) {
    const v = conversationNameText(values[field], 200);
    if (v) out[field] = v;
  }
  return out;
}

/**
 * THE TYPE'S OWN NAME, filled from what opened the room, or '' when the type declares none or its template inserts a
 * field this opening does not carry (a name with a hole in it reads worse than the next default).
 */
export function declaredTypeName(typeKey: string | undefined, values: ConversationNameValues = {}): string {
  if (!typeKey) return '';
  let template: string | undefined;
  try {
    template = getConversationTypeConfig(typeKey).name;
  } catch {
    return '';
  }
  if (!template?.trim()) return '';
  const present = presentValues(values);
  const inserted = [...template.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  if (inserted.some((f) => !(f in present))) return '';
  return conversationNameText(renderPrompt(template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, '{{$1}}'), present));
}

/** One section of the `conversation-name` template, rendered from the turn's words, or '' when a field it names is absent. */
function defaultName(section: string, words: VersionWords, values: Record<string, string>, form?: string): string {
  return conversationNameText(templateLine(CONVERSATION_NAME_TEMPLATE, words, { section, values, ...(form ? { form } : {}) }));
}

/** The alarm form of a room's name, with its service where the opening names one, or '' with no alarm. */
function alarmName(values: ConversationNameValues, words: VersionWords): string {
  return values.alarm ? defaultName('label.alarm', words, values, values.service ? 'service' : undefined) : '';
}

/** A type's key as a reader sees it: `ops-team` is "Ops Team". The words are the builder's own key, in Title Case. */
export function typeDisplayName(typeKey: string): string {
  return typeKey.split(/[-_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** A room an event opened, by its type: `label.opened` for its name, `label.openedSubject` for what it is about. '' with no type. */
function openedByType(section: 'label.opened' | 'label.openedSubject', typeKey: string | undefined, words: VersionWords): string {
  return typeKey ? defaultName(section, words, { type: typeDisplayName(typeKey) }) : '';
}

/** The event's own label, through `label.event`, so a builder may frame it; the label itself when the section renders nothing. */
function eventLabelName(values: ConversationNameValues, words: VersionWords): string {
  return values.label ? defaultName('label.event', words, values) || conversationNameText(values.label) : '';
}

export interface ConversationNameInput {
  kind: ConversationNameKind;
  /** The conversation type the room is created as; its `name` comes first. */
  typeKey?: string;
  /** What opened the room. `label` and `summary` are read for an `opened` room only. */
  values?: ConversationNameValues;
  /** The templates the creator read for the room's assistant (`loadMessageTemplateSet`). Absent: the shipped one. */
  words?: VersionWords;
}

/** THE NAME A ROOM IS CREATED WITH, by the order this module's header gives. Never empty: the placeholder is last. */
export function conversationNameFor(input: ConversationNameInput): string {
  const values = presentValues(input.values ?? {});
  const words = input.words ?? {};
  const declared = declaredTypeName(input.typeKey, values);
  if (declared) return declared;
  if (input.kind === 'opened') {
    const label = eventLabelName(values, words);
    if (label) return label;
    const alarm = alarmName(values, words);
    if (alarm) return alarm;
    if (values.summary) return conversationNameText(values.summary);
    return openedByType('label.opened', input.typeKey, words) || PLACEHOLDER_TITLE;
  }
  return defaultName(`label.${input.kind}`, words, values) || PLACEHOLDER_TITLE;
}

/**
 * WHAT A ROOM AN EVENT OPENED IS ABOUT, as a noun phrase: the event's label, else the alarm it watches with its
 * service, else the room's type worded through `label.openedSubject`. Never the summary, which is a sentence and is carried
 * as the room's issue instead. Empty only for an opening with no label, no alarm and no type.
 */
export function conversationSubjectFor(input: { typeKey?: string; values?: ConversationNameValues; words?: VersionWords }): string {
  const values = presentValues(input.values ?? {});
  const words = input.words ?? {};
  if (values.label) return conversationNameText(values.label);
  return alarmName(values, words) || openedByType('label.openedSubject', input.typeKey, words);
}

/**
 * THE TEXT A ROOM IS NAMED FROM, or null when the message names nothing: empty, or a slash command. `/md` says how to
 * display what follows, and what follows `/battle` is the question both sides answer, so each is stripped and the rest
 * names the room; every other command (`/help`, `/clear`) is not a subject. The commands are the platform's own
 * tokens, so this is pattern work on a marker (tenet D11).
 */
export function namingSeed(message: string | undefined | null): string | null {
  const trimmed = String(message ?? '').trim();
  const seed = trimmed.replace(/^\/md\s+/i, '').replace(/^\/battle\s+/i, '').trim();
  if (!seed || seed.startsWith('/')) return null;
  return seed;
}

/** Today's date as the platform writes one into a name: ISO, so it reads the same in every language. */
export function nameDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * THE NAME A REOPENED CONTEXT ROOM CARRIES: the host's current title while the room still carries the title it was last
 * named from (or none), and otherwise the name it has, which a person or its primary assistant gave it.
 */
export function contextRoomName(current: string | undefined, namedFrom: string | undefined, title: string): string {
  if (!current) return title;
  return namedFrom !== undefined && current === namedFrom ? title : current;
}
