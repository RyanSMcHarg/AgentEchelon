/**
 * THE WORDS AN EMAIL IS WRAPPED IN ARE THE ASSISTANT'S, IN ITS LANGUAGE (tenets P5 and D11).
 *
 * The body of a notice email is a message an assistant already said in a conversation, in its own words.
 * What wraps it - the greeting, the sign-off, the button into the conversation, the unsubscribe and
 * preference lines, the reply hint, the preference page - is the assistant's too, exactly as its notices are
 * (`lib/assistant-notice.ts`): each is a section of a message template (`notification-email`,
 * `email-preferences`, `invitation`, `claim`, `briefing`), selected for the room's primary by the order every
 * message follows (ADR-062 decision 3). A deployment whose assistant is terse, or holds its conversations in another
 * language, saves its own template and the email reads in that voice. The signature is the assistant's display name,
 * never a product name.
 *
 * The shipped English is the shipped message templates' (`shipped-message-templates.ts`). A line is read here
 * `{name}`-style and substituted whole; nothing here builds grammar in one language.
 *
 * `language` is the BCP 47 tag the lines are written in, the wrapper template's. It is stated on the message (`Content-Language`)
 * and on the HTML (`lang`), so a mail client and a screen reader read it in the right language.
 */
import { SSMClient } from '@aws-sdk/client-ssm';
import type { ParsedTemplate } from './document-template.js';
import { renderMessageTemplate } from './message-template.js';
import { legacyHomeOf, shippedMessageTemplate } from './shipped-message-templates.js';
import type { TemplateStoreDeps } from './template-store.js';

/**
 * Every line an email is written from, by the key the composers read, in the order the console lists them.
 * `language` is the tag the lines are written in.
 */
export const EMAIL_COPY_KEYS = [
  'language', 'greeting', 'unnamedRecipient', 'signOff', 'unnamedAssistant', 'openConversation', 'viewItHere',
  'replyHint', 'manageEmail', 'defaultSubject', 'briefingSubject', 'briefingBody', 'invitationSubject', 'invitationBody', 'openInvitation', 'invitationLinkLine', 'invitationOnce', 'nudgeSubject', 'nudgeBody', 'nudgeNote',
  'claimSubject', 'claimBody', 'openClaim', 'claimLinkLine', 'claimOnce', 'someone', 'untitled', 'preferencesTitle',
  'preferenceKind', 'stopKind', 'resumeKind', 'stopAll', 'saved', 'linkInvalid', 'expiredOffer', 'expiredStopped',
  'expiredSignIn', 'openPreferences', 'transactionalNote', 'kindConversation', 'kindConversationShared',
  'kindBriefing', 'kindAlarm', 'kindNudge', 'kindTask',
] as const;

export type EmailCopyKey = (typeof EMAIL_COPY_KEYS)[number];
export type EmailCopy = { [K in EmailCopyKey]: string };

/** The message templates an email is worded from (ADR-062 decision 6). */
export const EMAIL_TEMPLATE_NAMES = ['notification-email', 'email-preferences', 'invitation', 'claim', 'briefing'] as const;
export type EmailTemplateName = (typeof EMAIL_TEMPLATE_NAMES)[number];
export type EmailTemplates = Record<EmailTemplateName, ParsedTemplate>;

/** A `{name}`-style line's field, an optional span of that field alone (`braceLineAsSection`). */
const FIELD_SPAN = /\[\[\{\{\s*([A-Za-z0-9_]+)\s*\}\}\]\]/g;
const DOUBLE_BRACE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Every key's line, read from the templates in use: each key is the section that words it, with each `{{field}}`
 * written `{field}`, the form a preference page's token carries and `fill` takes. `language` is the wrapper
 * template's.
 */
export function emailCopyFromTemplates(templates: EmailTemplates): EmailCopy {
  const out: Record<string, string> = { language: templates['notification-email'].language || 'en' };
  for (const key of EMAIL_COPY_KEYS) {
    if (key === 'language') continue;
    const home = legacyHomeOf(`email.${key}`);
    if (!home) throw new Error(`email-copy: no shipped template words the email line "${key}"`);
    out[key] = (templates[home.name as EmailTemplateName].messageSections?.[home.section] ?? '').replace(FIELD_SPAN, '{$1}').replace(DOUBLE_BRACE, '{$1}');
  }
  return out as EmailCopy;
}

/** The shipped email templates. */
function shippedEmailTemplates(): EmailTemplates {
  return Object.fromEntries(EMAIL_TEMPLATE_NAMES.map((n) => [n, shippedMessageTemplate(n)])) as EmailTemplates;
}

export const DEFAULT_EMAIL_COPY: Readonly<EmailCopy> = Object.freeze(emailCopyFromTemplates(shippedEmailTemplates()));

/** The words one email is written in, and who signs it. */
export interface EmailVoice {
  /** Every line by key, `{field}`-style: what a preference page's token carries. */
  copy: EmailCopy;
  /** The assistant's display name, the email's signature. */
  assistantName: string;
  /** The templates the lines came from, which `emailLine` renders. Absent, `copy` is filled. */
  templates?: EmailTemplates;
}

/** The deployment's stand-in voice: the shipped templates, signed by an unnamed assistant. */
export function defaultEmailVoice(): EmailVoice {
  const templates = shippedEmailTemplates();
  return { copy: emailCopyFromTemplates(templates), assistantName: DEFAULT_EMAIL_COPY.unnamedAssistant, templates };
}

/**
 * The lines a preference page's token carries (`PAGE_COPY_KEYS`, written from the voice the email was sent in), over
 * the shipped ones, per key. A key that is not a non-blank string is not a line, so the shipped one stands.
 */
export function emailCopyOfLines(lines?: Record<string, unknown> | null): EmailCopy {
  const out: Record<string, string> = { ...DEFAULT_EMAIL_COPY };
  for (const key of EMAIL_COPY_KEYS) {
    const v = lines?.[key];
    if (typeof v === 'string' && v.trim()) out[key] = v;
  }
  return out as EmailCopy;
}

/** Fill `{name}`-style placeholders, whole. An unknown placeholder is left as written. */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/**
 * ONE LINE OF AN EMAIL, rendered from the template it is in use from (`renderMessageTemplate`): each value
 * checked by its field's type, and a line naming a field with no value left out. A voice built without its
 * templates fills its `copy` line instead.
 */
export function emailLine(voice: EmailVoice, key: Exclude<EmailCopyKey, 'language'>, values: Record<string, string> = {}): string {
  const home = legacyHomeOf(`email.${key}`);
  const template = home && voice.templates?.[home.name as EmailTemplateName];
  if (!home || !template) return fill(voice.copy[key], values);
  const rendered = renderMessageTemplate(template, values, { sections: [home.section], refusedValue: 'empty' });
  return rendered.ok ? rendered.sections[home.section] ?? '' : '';
}

/** The label a preference page shows for a kind a person can stop. */
export function kindLabel(copy: EmailCopy, kind: string): string {
  const key = `kind${kind.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')}` as EmailCopyKey;
  return copy[key] ?? kind;
}

// ── THE VOICE OF A CONVERSATION ──────────────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; voice: EmailVoice }>();
const CACHE_TTL_MS = 60_000;

/** Tests only. */
export function __clearEmailVoiceCache(): void {
  cache.clear();
}

/**
 * The templates an email about a room is worded from, by the selection order (ADR-062 decision 3): the one the room
 * primary's version names, its own, the room classification's, then the shipped. The store is read where the
 * function holds the read (`TEMPLATE_BUCKET`, `grantEmailConsent`); elsewhere the shipped answer.
 */
export async function emailTemplatesFor(
  at: { classification: string; assistant: string; messages?: import('./message-template.js').VersionMessages | null },
  deps?: TemplateStoreDeps,
): Promise<EmailTemplates> {
  if (!deps && !process.env.TEMPLATE_BUCKET) return shippedEmailTemplates();
  const { selectMessageTemplate } = await import('./message-template-selection.js');
  const chosen = await Promise.all(EMAIL_TEMPLATE_NAMES.map(async (name) => [name, (await selectMessageTemplate({
    classification: at.classification, assistant: at.assistant, name, messages: at.messages,
  }, deps)).template] as const));
  return Object.fromEntries(chosen) as EmailTemplates;
}

/**
 * The voice of the assistant that speaks for a conversation: the room's primary (`primaryAssistantOf`), the
 * email templates it is in use from (`emailTemplatesFor`) and its display name. Any failure answers the
 * stand-in voice, so a notice is never lost for want of its wording; the fault is logged.
 */
export async function emailVoiceForRoom(channelArn: string): Promise<EmailVoice> {
  const hit = cache.get(channelArn);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.voice;
  let voice = defaultEmailVoice();
  try {
    const [{ primaryAssistantOf }, { resolveActiveProfile }, { chimeMessagingClient }] = await Promise.all([
      import('./conversation-primary.js'),
      import('./active-profile.js'),
      import('./chime/clients.js'),
    ]);
    const chime = chimeMessagingClient({ region: process.env.AWS_REGION || 'us-east-1' });
    const primary = await primaryAssistantOf(channelArn, chime as never, '[email-copy]');
    const active = await resolveActiveProfile(primary.assistant, {
      ssm: new SSMClient({ region: process.env.AWS_REGION || 'us-east-1' }),
      ssmRoot: process.env.SSM_ROOT || '/agent-echelon',
      // The name and the `messages` choice are the version's own fields; the persona body is not the email's to read.
      withoutBodies: true,
    });
    const templates = await emailTemplatesFor({ classification: primary.classification, assistant: primary.assistant, messages: active.messages });
    voice = {
      copy: emailCopyFromTemplates(templates),
      assistantName: active.displayName || active.profile?.displayName || voice.assistantName,
      templates,
    };
  } catch (err) {
    console.warn('[email-copy] the conversation\'s assistant voice could not be read; using the stand-in copy', {
      channelArn, err: (err as Error)?.name || String(err),
    });
  }
  cache.set(channelArn, { at: Date.now(), voice });
  return voice;
}
