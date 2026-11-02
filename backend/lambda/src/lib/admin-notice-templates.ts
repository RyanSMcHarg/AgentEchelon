/**
 * THE OPERATOR NOTICES ARE MESSAGE TEMPLATES, SAID BY THE ADMIN ASSISTANT (ADR-062 decision 6).
 *
 * A notice posted into the admin notification channel (a turn that did not start, an assistant error, a membership audit
 * finding, an unrevoked connector grant, a guest outage, an alarm, a de-identified copy run) is a `kind: message`
 * template with a `chat` line and an `email.subject`, shipped here in English word for word as the code said it before.
 *
 * WHO OWNS THE WORDS. The admin assistant is the admin plane's assistant, and the admin plane is a classification of its own
 * (`admin`, `adminPlane: true`, `lib/config/profiles.ts`), so its family sits where every assistant's does, under its
 * classification: `templates/admin/_assistants/admin-agent/<name>/`, written by the operator's script
 * (`npm run template -- put admin <file> --assistant admin-agent --activate`). Selection is the admin assistant's own, then
 * the shipped one (`adminNoticeTemplate`), read by the one function that posts into the channel (`admin-alert-poster.ts`),
 * whose role reads that family and no other (`admin-services-stack.ts`).
 *
 * A SERVICE NAMES A NOTICE AND PASSES VALUES, NEVER TEXT. The emitter names the template, its values, and for a field
 * whose words depend on a case (an alarm or a recovery, which way a revoke went) the LABEL that fills it
 * (`label.<name>`, a section of the template), so a rewording of the labels reaches the notice too. The emitter also
 * renders the shipped template as the notice's `content` and `subject`: the CloudWatch line, the alarm's own email and a
 * deployment without the admin capability read those, and the poster falls back to them when the admin assistant's family
 * cannot be read.
 *
 * PURE apart from `adminNoticeTemplate`, whose store read is injected.
 */
import { parseTemplate, type ParsedTemplate } from './document-template.js';
import { renderMessageTemplate } from './message-template.js';
import { shippedMessageSource, type ShippedMessageEntry } from './shipped-message-templates.js';

/** The admin plane's classification and its assistant, whose family the operator notices are said from. */
export const ADMIN_NOTICE_CLASSIFICATION = 'admin';
export const ADMIN_NOTICE_ASSISTANT = 'admin-agent';

const text = 'value:text';
const long = 'value:longText';
const id = 'value:id';

const notice = (name: string, description: string, fields: Record<string, string>, sections: Record<string, string>): ShippedMessageEntry => ({
  name, kind: 'message', description, fields,
  sections: Object.fromEntries(Object.entries(sections).map(([s, t]) => [s, { text: t }])),
});

/** Every operator notice the platform ships, by name, word for word what its emitter composed before. */
const ENTRIES: readonly ShippedMessageEntry[] = [
  notice('turn-not-started', 'Tells the operators a turn could not start', { why: text, classification: id, assistant: long, conversation: long }, {
    chat: 'A turn could not start: {{why}}.\nClassification: {{classification}}\nAssistant: {{assistant}}\nConversation: {{conversation}}',
    'email.subject': '[Assistant] A turn could not start in a {{classification}} conversation',
    'label.unknown': 'unknown',
    'label.notResolved': 'not resolved',
    'label.none': 'none',
  }),
  notice('assistant-error', 'Tells the operators an assistant\'s turn failed', { classification: id, error: text, detail: long, task: text, channel: long, time: text }, {
    chat: '**Assistant error** ({{classification}} tier)\n\n**Error:** {{error}}\n**Detail:** {{detail}}\n**Task:** {{task}}\n**Channel:** {{channel}}\n**Time:** {{time}}',
    'email.subject': 'Assistant error: {{error}} ({{classification}} tier)',
  }),
  notice('uncleared-membership', 'Tells the operators the membership audit found a member or an assistant a conversation\'s classification does not admit', {
    clearance: id, noun: text, verb: text, classification: id, channel: long, heading: text, member: long, tail: long,
  }, {
    chat: 'Security audit: a {{clearance}}-tier {{noun}} {{verb}} a {{classification}}-tier conversation.\nChannel: {{channel}}\n{{heading}}: {{member}}\n{{tail}}',
    'email.subject': '[Security] Uncleared {{noun}} on a {{classification}} conversation',
    'label.member': 'member',
    'label.assistant': 'assistant',
    'label.memberHeading': 'Member',
    'label.assistantHeading': 'Assistant',
    'label.removed': 'was removed from',
    'label.found': 'was found on',
    'label.stillOn': 'is still on',
    'label.revoked': 'The membership has been revoked.',
    'label.alreadyGone': 'The membership was already gone when the audit tried to revoke it.',
    'label.failed': 'The audit could not revoke the membership. It is still in place; remove it by hand and check the audit role.',
    'label.reported': 'Enforcement is off; the membership was left in place. Flip the enforce toggle in the admin dashboard (or set MEMBERSHIP_AUDIT_ENFORCE) to auto-revoke.',
  }),
  notice('recorded-clearance-mismatch', 'Tells the operators a member\'s last recorded sign-in does not reach a conversation they are on', {
    recorded: id, classification: id, channel: long, member: long, issuer: long, recordedAt: text,
  }, {
    chat: 'Security audit: a member whose last recorded sign-in was cleared for {{recorded}} is on a {{classification}}-tier conversation.\n'
      + 'Channel: {{channel}}\nMember: {{member}}\nIssuer: {{issuer}}, recorded {{recordedAt}}\n'
      + 'This is read from the record of their last sign-in, not their current clearance, so the membership was left in place.',
    'email.subject': '[Security] A recorded clearance does not reach a {{classification}} conversation',
  }),
  notice('connector-grant-unrevoked', 'Tells the operators a connector grant could not be revoked at the vendor', { connector: id, person: id }, {
    chat: 'A per-person grant for the **{{connector}}** connector failed revocation at the vendor on every retry and has been deleted here. Revoke it at the vendor by hand for person `{{person}}`.',
    'email.subject': 'A {{connector}} grant could not be revoked at the vendor',
  }),
  notice('guest-unavailable', 'Tells the operators guest sessions are refused because a control could not answer', { flow: id, detail: long }, {
    chat: 'Guest {{flow}} refused a visitor because something it decides on could not be read: {{detail}}. Every guest control fails closed, so visitors are refused until it answers again.',
    'email.subject': 'Guest sessions are refused: a control could not answer',
  }),
  notice('activated-past-golden-gate', 'Tells the operators an administrator activated an assistant version past the golden gate', {
    assistant: id, version: text, refusal: id, actor: long, reason: long,
  }, {
    chat: '**{{assistant}}** version {{version}} was activated past the golden gate, which refused it with `{{refusal}}`.\n**By:** {{actor}}\n**Reason:** {{reason}}',
    'email.subject': '{{assistant}} was activated past the golden gate',
  }),
  notice('cloudwatch-alarm', 'Tells the operators an alarm changed state', { state: text, name: long, description: long, reason: long, when: text, dashboard: long }, {
    chat: '**{{state}}:** {{name}}\n**What:** {{description}}\n**CloudWatch:** {{reason}}\n**When:** {{when}}\n**Dashboard:** {{dashboard}}',
    'email.subject': '{{state}}: {{name}}',
    'label.alarm': 'Alarm',
    'label.recovered': 'Recovered',
    'label.anAlarm': 'an alarm',
    'label.noReason': '(no reason given)',
  }),
  notice('clean-copy-run', 'Tells the operators how a de-identified copy run ended', {
    outcome: text, conversations: text, took: text, remaining: text, failure: long,
  }, {
    chat: 'De-identified copy: run {{outcome}}. {{conversations}} conversation(s) brought up to date in {{took}}; nothing is pending.',
    'chat.incomplete': 'De-identified copy: run {{outcome}}. {{conversations}} conversation(s) brought up to date in {{took}}; '
      + '{{remaining}} still pending, picked up by the next run. For anything urgent, read the conversation in the archive.',
    'chat.failed': 'De-identified copy: run {{outcome}}. {{failure}} {{conversations}} conversation(s) were written first; '
      + 'the rest stay pending and the next run resumes them. For anything urgent, read the conversation in the archive.',
    'email.subject': 'De-identified copy: run {{outcome}}',
    'label.complete': 'complete',
    'label.incomplete': 'INCOMPLETE',
    'label.failed': 'FAILED',
    'label.some': 'some',
    'label.unknownFailure': 'Unknown failure.',
  }),
];

let catalog: Map<string, { entry: ShippedMessageEntry; source: string; template: ParsedTemplate }> | undefined;

/** Every operator notice template the platform ships, parsed once. */
export function shippedAdminNotices(): Map<string, { entry: ShippedMessageEntry; source: string; template: ParsedTemplate }> {
  if (catalog) return catalog;
  const out = new Map<string, { entry: ShippedMessageEntry; source: string; template: ParsedTemplate }>();
  for (const entry of ENTRIES) {
    const source = shippedMessageSource(entry);
    out.set(entry.name, { entry, source, template: parseTemplate(source) });
  }
  catalog = out;
  return out;
}

/** One shipped operator notice template. Throws for a name the platform does not ship. */
export function shippedAdminNotice(name: string): ParsedTemplate {
  const t = shippedAdminNotices().get(name);
  if (!t) throw new Error(`the platform ships no operator notice "${name}"`);
  return t.template;
}

/** What an emitter names: the template, its values, the labels that fill a field by case, and the chat form. */
export interface AdminNoticeWords {
  name: string;
  values: Record<string, string | number>;
  /** Field to the `label.<name>` section that fills it. */
  labels?: Record<string, string>;
  /** The `chat.<form>` line, where the template has one per case. */
  form?: string;
}

/**
 * THE NOTICE, RENDERED from a template: each label filled from the template's own label section, then every value
 * checked, capped and stripped by its declared type, and a line naming a field with no value left out. Undefined when
 * the template cannot say it (a label it does not declare, or no line), so the caller falls back to what it has.
 */
export function renderAdminNotice(template: ParsedTemplate, words: AdminNoticeWords): { content: string; subject: string } | undefined {
  const sections = template.messageSections ?? {};
  const values: Record<string, unknown> = { ...words.values };
  for (const [field, label] of Object.entries(words.labels ?? {})) {
    const said = sections[`label.${label}`];
    if (said === undefined) return undefined;
    values[field] = said;
  }
  const chat = words.form ? `chat.${words.form}` : 'chat';
  const rendered = renderMessageTemplate(template, values, { sections: [chat, 'email.subject'], refusedValue: 'empty' });
  if (!rendered.ok) return undefined;
  const content = (rendered.sections[chat] ?? '').trim();
  const subject = (rendered.sections['email.subject'] ?? '').trim();
  return content && subject ? { content, subject } : undefined;
}

/** The notice as the shipped template says it: what an emitter logs and carries, and the poster's fallback. */
export function shippedAdminNoticeText(words: AdminNoticeWords): { content: string; subject: string } {
  const out = renderAdminNotice(shippedAdminNotice(words.name), words);
  if (!out) throw new Error(`the operator notice "${words.name}" could not be said from its shipped template`);
  return out;
}

/** Reads one template from the admin assistant's family, or undefined when it holds none of that name. */
export type AdminFamilyReader = (name: string) => Promise<ParsedTemplate | undefined>;

/**
 * THE TEMPLATE A NOTICE IS SAID FROM: the admin assistant's own, then the shipped one. A template of the admin assistant's that
 * is not a message, or that declares a field the shipped one does not, is passed over, so a rewording can neither drop
 * the notice nor ask for a value the emitter does not supply. A read that fails is the shipped template.
 */
export async function adminNoticeTemplate(name: string, readOwn: AdminFamilyReader): Promise<{ template: ParsedTemplate; origin: 'assistant' | 'shipped' }> {
  const shipped = shippedAdminNotice(name);
  const own = await readOwn(name).catch((err) => {
    console.warn('[admin-notice] the admin assistant\'s template could not be read; the shipped one is said', { template: name, err: (err as Error)?.name });
    return undefined;
  });
  if (own && own.kind === 'message' && Object.entries(own.fields ?? {}).every(([f, b]) => shipped.fields?.[f] === b)) {
    return { template: own, origin: 'assistant' };
  }
  return { template: shipped, origin: 'shipped' };
}
