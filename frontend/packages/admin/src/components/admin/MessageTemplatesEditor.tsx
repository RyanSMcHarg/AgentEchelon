/**
 * THE ONE PLACE TO READ AND EDIT WHAT AN ASSISTANT SAYS (ADR-062): every template, what it says now and whose it is,
 * beside the classification's and the shipped ones, and which of them this version uses.
 *
 * Every line the assistant posts or emails for a platform event, and the request its join recap answers, is a
 * template. Each is listed with its purpose and what it says, rendered by the runtime's own functions. Opened, it shows
 * the three families side by side, edits the assistant's own and saves it, which makes it the one in use at once: a
 * template is not part of a version.
 * Which template the version uses for the message (the shipped one, the classification's, or one of the assistant's
 * own, with conditions) is the version's `messages`, picked here and saved with the draft (`MessageChoicesEditor`).
 *
 * WHICH TEMPLATE IS IN USE, AND WHAT IT SAYS, ARE THE SERVER'S OWN RULES. `chooseMessageTemplate` is the order
 * the router and the processor select by, and the preview is `renderMessageTemplate` / `renderPromptTemplate`,
 * the functions they render with (`backend/lambda/src/lib/message-template.ts`). What the preview shows for a
 * sample is what is posted.
 *
 * A FIELD MAY READ A VARIABLE (ADR-060). The picker adds a field to the template's front matter bound to a source the
 * classification publishes, or to one of the version's variables by name, and puts `{{field}}` in the text. Whether
 * the template may carry it is checked where the template is said, against who reads it, so the picker says which
 * sources describe a person rather than refusing them here.
 *
 * A TEMPLATE SPEAKS THE DEPLOYMENT'S LANGUAGES (ADR-062 decision 4). One tab per language the deployment declares shows
 * the preview in that language: the variant written for it, else what its reader actually gets (the template's own
 * text, or for a `voice` template, a model render in that language falling back to that text). A variant is added as a
 * copy of every section under `# <section>@<tag>`, to be written in that language. A message whose call site may await
 * a model is offered the assistant's voice and its bounds; every other is said instantly, from written text only.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MarkdownHelp from './MarkdownHelp';
import { parseTemplate, messageFieldType, TEMPLATE_NAME, type ParsedTemplate } from '../../../../../../backend/lambda/src/lib/document-template.ts';
import {
  chooseMessageName,
  chooseMessageTemplate,
  messageFamilies,
  renderMessageTemplate,
  renderPromptTemplate,
  type MessageOrigin,
} from '../../../../../../backend/lambda/src/lib/message-template.ts';
import { inLanguage, writtenLanguages } from '../../../../../../backend/lambda/src/lib/message-language.ts';
import { VOICE_BOUNDS_MAX, VOICE_BOUNDS_DEFAULT, type VoiceBounds } from '../../../../../../backend/lambda/src/lib/document-template.ts';
import type { MessageEntry } from '../../../../../../backend/lambda/src/lib/message-template.ts';
import type { PublishedVariables, SourceLookup, VersionVariable } from '../../../../../../backend/lambda/src/lib/variables.ts';
import VariablePicker, { consoleLookup } from './VariablePicker';
import MessageChoicesEditor, { templateOptionsFor } from './MessageChoicesEditor';
import { messageAudience } from '../../../../../../backend/lambda/src/lib/shipped-message-templates.ts';
import {
  listMessageTemplates,
  rollbackMessageTemplate,
  saveMessageTemplate,
  type AssistantTemplateFamily,
  type DeclaredLanguage,
  type MessageTemplateListing,
} from '../../services/profileService';

/** Whether a listing is a prompt: what a model is asked rather than what a person reads. */
const isPrompt = (l: MessageTemplateListing): boolean => l.kind === 'prompt';

/** A parsed template, or the reason it does not parse. */
function tryParse(source: string | undefined): { template?: ParsedTemplate; error?: string } {
  if (!source) return {};
  try {
    return { template: parseTemplate(source) };
  } catch (err) {
    return { error: (err as Error).message.replace(/^\[DocumentTemplate\] /, '') };
  }
}

/** A sample value for a field, by its declared type: language-free, so it reads the same in every locale. */
export function sampleValue(field: string, binding: string): string {
  const type = messageFieldType(binding);
  if (type === 'count') return '3';
  if (type === 'id') return '2026-11-03';
  if (type === 'link') return 'https://example.com/link';
  return `[${field}]`;
}

/** A sample for each of a template's fields. */
const samplesFor = (fields: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(fields).map(([f, b]) => [f, sampleValue(f, b)]));

/** A field name for a binding: the version's variable's own name, else the source's last segment. */
export function fieldNameFor(binding: string): string {
  const tail = binding.split(/[:.]/).pop() ?? binding;
  return tail.replace(/[^A-Za-z0-9_]/g, '_') || 'value';
}

/**
 * The template with one more field bound and inserted: the front matter (a JSON object between two `---` lines) gains
 * `fields.<field> = binding`, and `{{field}}` is appended to the text. A name already bound to something else gets a
 * numbered one. A source that does not parse is returned unchanged, with the reason.
 */
export function withFieldBinding(source: string, binding: string): { source: string; field?: string; error?: string } {
  const lines = source.split(/\r?\n/);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if ((lines[0] ?? '').trim() !== '---' || end < 0) return { source, error: 'no front matter' };
  let front: { fields?: Record<string, string> };
  try { front = JSON.parse(lines.slice(1, end).join('\n')); } catch (err) { return { source, error: (err as Error).message }; }
  const fields = { ...(front.fields ?? {}) };
  const base = fieldNameFor(binding);
  let field = base;
  for (let n = 2; fields[field] !== undefined && fields[field] !== binding; n++) field = `${base}${n}`;
  fields[field] = binding;
  const body = lines.slice(end + 1).join('\n');
  const text = body.endsWith('\n') || !body ? `${body}{{${field}}}` : `${body} {{${field}}}`;
  return { source: ['---', JSON.stringify({ ...front, fields }), '---', text].join('\n'), field };
}

/** The front matter of a source and its body, or undefined when it has none. */
function frontOf(source: string): { front: Record<string, unknown>; body: string } | undefined {
  const lines = source.split(/\r?\n/);
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if ((lines[0] ?? '').trim() !== '---' || end < 0) return undefined;
  try {
    const front = JSON.parse(lines.slice(1, end).join('\n'));
    return front && typeof front === 'object' && !Array.isArray(front) ? { front, body: lines.slice(end + 1).join('\n') } : undefined;
  } catch {
    return undefined;
  }
}

const withFront = (front: Record<string, unknown>, body: string) => ['---', JSON.stringify(front), '---', body].join('\n');

/**
 * What the runtime posts for this source and these values, in one of its written languages: each section rendered, or
 * why it cannot be. `language` is the variant to render; absent, or one the template was not written in, its own.
 */
export function previewMessageTemplate(
  source: string,
  values: Record<string, string>,
  language?: string,
): { sections: Record<string, string>; language?: string } | { error: string } {
  const parsed = tryParse(source);
  if (!parsed.template) return { error: parsed.error ?? '' };
  const t = parsed.template;
  if (t.kind === 'prompt') {
    const r = renderPromptTemplate(t, values);
    return r.ok ? { sections: { prompt: r.prompt } } : { error: r.refused };
  }
  const said = language ? inLanguage(t, language) : t;
  const r = renderMessageTemplate(said, values);
  return r.ok ? { sections: r.sections, language: said.language ?? 'en' } : { error: r.refused };
}

/**
 * A LANGUAGE VARIANT ADDED: every section of the template's own language copied under `# <section>@<tag>`, to be written in
 * that language, so the variant starts whole (a variant missing a section is refused when stored). A source that does
 * not parse, a prompt, or a language already written is returned unchanged.
 */
export function withLanguageVariant(source: string, tag: string): string {
  const t = tryParse(source).template;
  if (!t || t.kind !== 'message' || writtenLanguages(t).includes(tag)) return source;
  const copy = Object.entries(t.messageSections ?? {}).map(([section, text]) => `# ${section}@${tag}\n${text}\n`).join('\n');
  return `${source.replace(/\s*$/, '')}\n\n${copy}`;
}

/**
 * THE ASSISTANT'S VOICE, ON OR OFF, with its bounds: `fill: voice` and `voice` set in the front matter, or both removed.
 * A source with no front matter is returned unchanged.
 */
export function withVoice(source: string, on: boolean, bounds?: Partial<VoiceBounds>): string {
  const split = frontOf(source);
  if (!split) return source;
  const { fill: _fill, voice: _voice, ...rest } = split.front;
  if (!on) return withFront(rest, split.body);
  const voice = { ...VOICE_BOUNDS_DEFAULT, ...(bounds ?? {}) };
  const declared = (Object.keys(voice) as Array<keyof VoiceBounds>).filter((k) => voice[k] !== VOICE_BOUNDS_DEFAULT[k]);
  return withFront({ ...rest, fill: 'voice', ...(declared.length ? { voice: Object.fromEntries(declared.map((k) => [k, voice[k]])) } : {}) }, split.body);
}

/**
 * Which family's template is in use for one listing, and the text an edit of the assistant's own starts from, by the
 * order the server selects in (`chooseMessageTemplate`, `messageFamilies`): the template the version's `messages`
 * names for the message (one of the assistant's own, or a family), else the assistant's own of the message's name,
 * else the classification's, else the shipped one.
 */
export function templateInUse(
  listing: MessageTemplateListing,
  family: AssistantTemplateFamily = {},
  messages: Record<string, MessageEntry> | null | undefined = undefined,
  /** What the server selects through beyond the listing: the version's lookup, and the deployment's line for this message. */
  at: { lookup?: SourceLookup; deploymentLine?: string } = {},
): { origin: MessageOrigin; start: string; named?: string } {
  const shipped = tryParse(listing.shipped).template;
  if (!shipped) return { origin: 'shipped', start: listing.shipped };
  // A conditioned entry is said from its unconditioned alternative where no condition holds; that is the one shown.
  const families = messageFamilies(chooseMessageName(messages?.[listing.name]), listing.name);
  const named = families.own !== listing.name ? families.own : undefined;
  const ownSource = families.own === undefined ? undefined : named ? family[named]?.source : listing.own?.source;
  const chosen = chooseMessageTemplate({
    shipped,
    own: tryParse(ownSource).template,
    classification: families.classification ? tryParse(listing.classification?.source).template : undefined,
    ...(at.lookup ? { lookup: at.lookup } : {}),
    ...(at.deploymentLine?.trim() ? { deploymentLines: Object.fromEntries(Object.keys(shipped.messageSections ?? {}).filter((s) => s.startsWith('chat')).map((s) => [s, at.deploymentLine!])) } : {}),
  });
  const start = chosen.origin === 'assistant' ? ownSource!
    : chosen.origin === 'classification' ? listing.classification!.source
      : chosen.origin === 'deployment' ? (at.deploymentLine ?? listing.shipped)
        : listing.shipped;
  return { origin: chosen.origin, start, ...(named && chosen.origin === 'assistant' ? { named } : {}) };
}

/** What a template says, as its list row shows it: its chat line, else its email body, else its first section, with sample values. */
export function whatItSays(source: string): string | undefined {
  const fields = tryParse(source).template?.fields ?? {};
  const preview = previewMessageTemplate(source, samplesFor(fields));
  if ('error' in preview) return undefined;
  const sections = Object.entries(preview.sections);
  return (sections.find(([s]) => s === 'chat' || s.startsWith('chat.')) ?? sections.find(([s]) => s === 'email.body') ?? sections[0])?.[1];
}

const cx = (...names: Array<string | false | undefined>): string => names.filter(Boolean).join(' ');

/** The shipped template with a deployment's line as its chat sections, as the runtime says it. */
function withDeploymentLine(shipped: string, line: string): string {
  const out: string[] = [];
  let chat = false;
  for (const l of shipped.split(/\r?\n/)) {
    const heading = /^# (\S+)/.exec(l);
    if (heading) {
      chat = heading[1].startsWith('chat') && !heading[1].includes('@');
      out.push(l, ...(chat ? [line, ''] : []));
    } else if (!chat) out.push(l);
  }
  return out.join('\n');
}

/** What editing a template starts from: what is in use, as a whole template even where that is a deployment's bare line. */
const editableStart = (listing: MessageTemplateListing, start: string): string => (frontOf(start) ? start : withDeploymentLine(listing.shipped, start));

/**
 * The assistant's own templates a message may be said from: the one of the message's own name, and each saved under a
 * name of its own (no shipped message's) of the message's kind.
 */
export function ownTemplatesFor(listing: MessageTemplateListing, family: AssistantTemplateFamily, shippedNames: ReadonlySet<string>): string[] {
  return Object.entries(family)
    .filter(([name, held]) => name === listing.name || (!shippedNames.has(name) && (tryParse(held.source).template?.kind ?? 'message') === listing.kind))
    .map(([name]) => name)
    .sort((x, y) => (x === listing.name ? -1 : y === listing.name ? 1 : x.localeCompare(y)));
}

/** The message this version says from a template of the assistant's own, if any. */
export function messagePicking(messages: Record<string, MessageEntry> | null | undefined, template: string): string | undefined {
  return Object.entries(messages ?? {}).find(([, e]) => (Array.isArray(e) ? e.some((alt) => alt.template === template) : e === template))?.[0];
}

/** Each section as it is rendered. */
const RenderedSections: React.FC<{ sections: Record<string, string>; testId: string }> = ({ sections, testId }) => (
  <dl className="admin-config-list" data-testid={testId}>
    {Object.entries(sections).map(([section, rendered]) => (
      <React.Fragment key={section}>
        <dt><code>{section}</code></dt>
        <dd><pre className="admin-welcome-preview">{rendered}</pre></dd>
      </React.Fragment>
    ))}
  </dl>
);

/**
 * A TEMPLATE UNDER A NAME OF ITS OWN, NEW OR HELD. It starts from what the message it words says now, keeps that
 * message's fields, and is stored in the assistant's own family. Saving does not put it in use: a version's `messages`
 * or a workflow step names it. The server checks that it fits the message's call site and says why when it does not.
 */
const OwnTemplateForm: React.FC<{
  profileName: string;
  listing: MessageTemplateListing[];
  family: AssistantTemplateFamily;
  /** The held template this edits; absent, a new one. */
  existing?: string;
  /** The message this version says from it, which the form opens on. */
  picked?: string;
  /** The source a new template words a message from. */
  seedFor: (message: string) => string;
  published?: PublishedVariables;
  variables?: Readonly<Record<string, VersionVariable>>;
  contextSources?: readonly string[];
  onSaved: () => Promise<void>;
  onClose: () => void;
  /** Set while the form holds words not saved, so leaving it can ask first. */
  unsaved: React.MutableRefObject<boolean>;
}> = ({ profileName, listing, family, existing, picked, seedFor, published, variables, contextSources, onSaved, onClose, unsaved }) => {
  const { t } = useTranslation();
  const [held, setHeld] = useState(existing);
  const [message, setMessage] = useState(picked ?? (existing ? '' : listing[0]?.name ?? ''));
  const [seed, setSeed] = useState(() => (existing ? family[existing]!.source : seedFor(message)));
  const [source, setSource] = useState(seed);
  const seedDescription = String(frontOf(seed)?.front.description ?? '');
  const [description, setDescription] = useState(seedDescription);
  const [name, setName] = useState(existing ?? '');
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const split = frontOf(source);
  const composed = split ? withFront({ ...split.front, ...(name ? { name } : {}), description }, split.body) : source;
  const clean = useRef(composed);
  const untouched = !held && !name && source === seed && description === seedDescription;
  useEffect(() => { unsaved.current = !untouched && composed !== clean.current; }, [composed, untouched, unsaved]);
  const fields = tryParse(composed).template?.fields ?? {};
  const preview = previewMessageTemplate(composed, samplesFor(fields));
  const nameProblem = held || !name ? undefined
    : !TEMPLATE_NAME.test(name) ? 'nameInvalid'
      : listing.some((l) => l.name === name) ? 'nameShipped'
        : family[name] ? 'nameHeld' : undefined;
  const worded = listing.find((l) => l.name === message);

  /** A new message restarts the words, unless they have been written. */
  const chooseMessage = (next: string) => {
    setMessage(next);
    if (held || source !== seed) return;
    const fresh = seedFor(next);
    setSeed(fresh);
    setSource(fresh);
    if (description === seedDescription) setDescription(String(frontOf(fresh)?.front.description ?? ''));
  };
  const act = async (fn: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
      after();
      await onSaved();
    } catch (err) {
      setStatus({ kind: 'error', text: t('admin.messageTemplates.notSaved', { error: (err as Error).message }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-message-detail" data-testid="message-template-own-form">
      {!held && (
        <label><span className="admin-field-label">{t('admin.messageTemplates.form.name')}</span>
          <input type="text" className="input" value={name} maxLength={64} data-testid="message-template-new-name" onChange={(e) => setName(e.target.value)} />
          <span className="admin-field-hint" {...(nameProblem ? { role: 'alert' } : {})} data-testid="message-template-new-name-hint">{t(`admin.messageTemplates.form.${nameProblem ?? 'nameHelp'}`)}</span>
        </label>
      )}
      <label><span className="admin-field-label">{t('admin.messageTemplates.form.description')}</span>
        <input type="text" className="input" value={description} data-testid="message-template-new-description" onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label><span className="admin-field-label">{t('admin.messageTemplates.form.message')}</span>
        <select className="select" value={message} data-testid="message-template-new-message" onChange={(e) => chooseMessage(e.target.value)}>
          {!message && <option value="" className="select-placeholder" disabled hidden>{t('admin.messageTemplates.form.messagePick')}</option>}
          {listing.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
        </select>
        <span className="admin-field-hint">{worded?.description ?? t('admin.messageTemplates.form.messageHelp')}</span>
      </label>
      <label><span className="admin-field-label">{t('admin.messageTemplates.form.text')}</span>
        <textarea className="textarea" rows={8} value={split?.body ?? source} data-testid="message-template-new-text"
          onChange={(e) => setSource(split ? withFront(split.front, e.target.value) : e.target.value)} />
        <span className="admin-field-hint">{t('admin.messageTemplates.form.textHelp', { fields: Object.keys(fields).map((f) => `{{${f}}}`).join(', ') || '-' })}</span>
      </label>
      {worded && !isPrompt(worded) && (
        <VariablePicker published={published} variables={variables} purpose="insert" testId="message-template-new-variable-picker"
          audience={messageAudience(worded.name)} contextSources={contextSources}
          onPick={(binding) => { const next = withFieldBinding(source, binding); if (next.field) setSource(next.source); }} />
      )}
      <h5>{t('admin.messageTemplates.preview')}</h5>
      {'error' in preview
        ? <p className="admin-field-hint" role="alert" data-testid="message-template-new-error">{t('admin.messageTemplates.cannotParse', { error: preview.error })}</p>
        : <RenderedSections sections={preview.sections} testId="message-template-new-preview" />}
      <div className="admin-review-buttons">
        <button type="button" className="btn-primary" data-testid="message-template-new-save"
          disabled={busy || !name || !!nameProblem || !message || 'error' in preview}
          onClick={() => act(() => saveMessageTemplate(profileName, composed, message), () => {
            clean.current = composed;
            unsaved.current = false;
            setHeld(name);
            setStatus({ kind: 'saved', text: t('admin.messageTemplates.form.saved') });
          })}>
          {t('admin.messageTemplates.form.save')}
        </button>
        {!!held && !!family[held]?.history.length && (
          <button type="button" className="btn-secondary" data-testid="message-template-new-rollback" disabled={busy}
            onClick={() => act(() => rollbackMessageTemplate(profileName, held), () => { unsaved.current = false; onClose(); })}>
            {t('admin.messageTemplates.rollback')}
          </button>
        )}
        <button type="button" className="btn-secondary" data-testid="message-template-new-close" onClick={onClose}>{t('admin.messageTemplates.close')}</button>
      </div>
      {status && <p className="admin-field-hint" role={status.kind === 'error' ? 'alert' : 'status'} data-testid="message-template-new-status">{status.text}</p>}
    </div>
  );
};

const MessageTemplatesEditor: React.FC<{
  profileName: string;
  /** The draft's `messages`: which template each message is said from in this version. */
  messages?: Record<string, MessageEntry> | null;
  /** The draft's `messages` once a pick changes it (null clears it). Absent, the picks are shown read-only. */
  onMessagesChange?: (next: Record<string, MessageEntry> | null) => void;
  /** Saving and rolling back are activations (`activate-profiles`). */
  canSave: boolean;
  /** The classification's published sources and the version's variables, for the picker. */
  published?: PublishedVariables;
  variables?: Readonly<Record<string, VersionVariable>>;
  /** The deployment-wide lines a message is said from where no stored template fits, by template name. */
  deploymentLines?: Record<string, string>;
  /** The context sources the version reads: a field bound to one of any other is never resolved. */
  contextSources?: readonly string[];
  /** Why the version's picks are read-only here, where that is not the capability. */
  picksNote?: string;
}> = ({ profileName, messages: draftMessages, onMessagesChange, canSave, published, variables, deploymentLines, contextSources, picksNote }) => {
  const { t } = useTranslation();
  /** The draft's picks, seeded from the draft and reported once changed. */
  const [messages, setMessages] = useState<Record<string, MessageEntry>>(() => ({ ...(draftMessages ?? {}) }));
  const pick = (message: string, next: MessageEntry | undefined) => {
    const { [message]: _old, ...rest } = messages;
    const updated = next === undefined ? rest : { ...rest, [message]: next };
    setMessages(updated);
    onMessagesChange?.(Object.keys(updated).length ? updated : null);
  };
  const [listing, setListing] = useState<MessageTemplateListing[] | null>(null);
  const [family, setFamily] = useState<AssistantTemplateFamily>({});
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [filter, setFilter] = useState('');
  /** The template of the assistant's own open in its form, by name, or `@new` for one being written. */
  const [ownOpen, setOwnOpen] = useState('');
  const ownUnsaved = useRef(false);
  /** Leaving words not saved is asked about first. */
  const mayLeave = (unsaved: boolean) => !unsaved || window.confirm(t('admin.messageTemplates.discard'));
  const openOwn = (next: string) => {
    if (!mayLeave(ownUnsaved.current)) return;
    ownUnsaved.current = false;
    setOwnOpen(next);
  };
  const [text, setText] = useState('');
  /** The text as it was seeded or last saved: what an edit is measured from. */
  const [cleanText, setCleanText] = useState('');
  const seeded = useRef('');
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [languages, setLanguages] = useState<DeclaredLanguage[]>([]);
  const [tab, setTab] = useState('');

  const load = async () => {
    setLoadError('');
    try {
      const r = await listMessageTemplates(profileName);
      setListing(r.templates);
      setFamily(r.family ?? {});
      setLanguages(Array.isArray(r.languages) ? r.languages : []);
      // WHATEVER IS OPEN WHEN THE LIST ARRIVES STAYS OPEN, however long the read or the save before it took.
      setName((open) => (open && r.templates.some((x) => x.name === open) ? open : ''));
    } catch (err) {
      setLoadError((err as Error).message);
    }
  };
  useEffect(() => { void load(); }, [profileName]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = listing?.find((x) => x.name === name);
  const lookup = useMemo(() => consoleLookup(published, variables), [published, variables]);
  const inUseOf = (l: MessageTemplateListing) => templateInUse(l, family, messages, {
    lookup,
    ...(deploymentLines?.[l.name] ? { deploymentLine: deploymentLines[l.name] } : {}),
  });
  const matches = (...words: Array<string | undefined>) => !filter.trim() || words.some((w) => w?.toLowerCase().includes(filter.trim().toLowerCase()));
  const allRows = useMemo(() => (listing ?? []).map((l) => {
    const use = inUseOf(l);
    return { l, use, said: use.origin === 'deployment' ? use.start : whatItSays(use.start) };
  }), [listing, family, messages, lookup, deploymentLines]); // eslint-disable-line react-hooks/exhaustive-deps
  // AN OPEN TEMPLATE STAYS OPEN WHATEVER IS SEARCHED FOR, so a search cannot take its edit away.
  const rows = allRows.filter((r) => r.l.name === name || matches(r.l.name, r.l.description, r.said));
  const inUse = selected ? inUseOf(selected) : undefined;
  const shippedNames = useMemo(() => new Set((listing ?? []).map((x) => x.name)), [listing]);
  useEffect(() => {
    if (!selected || !inUse) { seeded.current = ''; return; }
    // AN EDIT IN PROGRESS IS KEPT when what is in use changes under it.
    if (seeded.current === selected.name && text !== cleanText) return;
    seeded.current = selected.name;
    const start = editableStart(selected, inUse.start);
    setText(start);
    setCleanText(start);
    const fields = tryParse(selected.shipped).template?.fields ?? {};
    setSamples(samplesFor(fields));
  }, [selected?.name, inUse?.start]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setStatus(null); }, [selected?.name]);
  const rowUnsaved = !!selected && text !== cleanText;
  const openRow = (next: string) => { if (mayLeave(rowUnsaved)) setName(next); };

  const parsedText = useMemo(() => tryParse(text).template, [text]);
  const written = parsedText ? writtenLanguages(parsedText) : [];
  const ownLanguage = parsedText?.language ?? 'en';
  // THE TAB IS A LANGUAGE THE DEPLOYMENT SPEAKS, or the template's own when it lists none.
  const tabs = languages.length ? languages : [{ tag: ownLanguage, name: ownLanguage, native: ownLanguage }];
  const activeTab = tabs.some((l) => l.tag === tab) ? tab : (tabs.find((l) => l.tag === ownLanguage)?.tag ?? tabs[0]?.tag ?? ownLanguage);
  const tabWritten = written.includes(activeTab);
  const isVoice = parsedText?.fill === 'voice';
  const preview = text ? previewMessageTemplate(text, samples, tabWritten ? activeTab : undefined) : null;
  const message = !!selected && !isPrompt(selected);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
      setStatus({ kind: 'saved', text: t('admin.messageTemplates.saved') });
      await load();
    } catch (err) {
      setStatus({ kind: 'error', text: t('admin.messageTemplates.notSaved', { error: (err as Error).message }) });
    } finally {
      setBusy(false);
    }
  };

  const detail = selected && inUse && (
    <div className="admin-message-detail" data-testid="message-template-detail">
              <p className="admin-field-hint" data-testid="message-template-in-use">
                {t('admin.messageTemplates.inUse', { origin: inUse.named
                  ? t('admin.messageTemplates.origin.named', { name: inUse.named })
                  : t(`admin.messageTemplates.origin.${inUse.origin}`) })}
              </p>
              {isPrompt(selected) && <p className="admin-field-hint">{t('admin.messageTemplates.promptNote')}</p>}
              {message && (
                <div data-testid="message-template-languages">
                  <h5>{t('admin.messageTemplates.languages.title')}</h5>
                  <p className="admin-field-hint" data-testid="message-template-language-map">
                    {t('admin.messageTemplates.languages.map', { languages: tabs.map((l) => `${l.native} (${l.tag})`).join(', ') })}
                  </p>
                  <div role="tablist" className="admin-tabs" aria-label={t('admin.messageTemplates.languages.title')}>
                    {tabs.map((l) => (
                      <button key={l.tag} type="button" role="tab" aria-selected={l.tag === activeTab}
                        className={`admin-tab-btn${l.tag === activeTab ? ' active' : ''}`} data-testid={`message-template-language-${l.tag}`}
                        onClick={() => setTab(l.tag)}>
                        {l.native}{written.includes(l.tag) ? '' : ` · ${t('admin.messageTemplates.languages.notWritten')}`}
                      </button>
                    ))}
                  </div>
                  {!tabWritten && (
                    <p className="admin-field-hint" data-testid="message-template-language-fallback">
                      {isVoice
                        ? t('admin.messageTemplates.languages.voiceFallback', { language: activeTab, own: ownLanguage })
                        : t('admin.messageTemplates.languages.writtenFallback', { language: activeTab, own: ownLanguage })}
                    </p>
                  )}
                  {!tabWritten && canSave && parsedText && (
                    <button type="button" className="btn-secondary" data-testid="message-template-add-variant"
                      onClick={() => setText(withLanguageVariant(text, activeTab))}>
                      {t('admin.messageTemplates.languages.add', { language: tabs.find((l) => l.tag === activeTab)?.native ?? activeTab })}
                    </button>
                  )}
                </div>
              )}

              <h5>{t('admin.messageTemplates.preview')}</h5>
              <p className="admin-field-hint">{t('admin.messageTemplates.previewHelp')}</p>
              <div className="admin-form-grid">
                {Object.keys(samples).map((f) => (
                  <label key={f}><span className="admin-field-label">{t('admin.messageTemplates.sample', { field: f })}</span>
                    <input type="text" className="input" value={samples[f]} data-testid={`message-template-sample-${f}`}
                      onChange={(e) => setSamples((cur) => ({ ...cur, [f]: e.target.value }))} />
                  </label>
                ))}
              </div>
              {preview && 'error' in preview
                ? <p className="admin-field-hint" role="alert" data-testid="message-template-error">{t('admin.messageTemplates.cannotParse', { error: preview.error })}</p>
                : preview && <RenderedSections sections={preview.sections} testId="message-template-preview" />}

              <MessageChoicesEditor message={selected.name} entry={messages[selected.name]} published={published} variables={variables}
                options={templateOptionsFor(t as never, { hasClassification: !!selected.classification, own: ownTemplatesFor(selected, family, shippedNames) })}
                {...(onMessagesChange ? { onChange: (next: MessageEntry | undefined) => pick(selected.name, next) } : { ...(picksNote ? { readOnlyNote: picksNote } : {}) })} />
              <details>
                <summary>{t('admin.messageTemplates.shipped')}</summary>
                <pre className="admin-welcome-example" data-testid="message-template-shipped">{selected.shipped}</pre>
              </details>
              <details>
                <summary>{t('admin.messageTemplates.classification')}</summary>
                {selected.classification
                  ? <pre className="admin-welcome-example" data-testid="message-template-classification">{selected.classification.source}</pre>
                  : <p className="admin-field-hint">{t('admin.messageTemplates.classificationNone')}</p>}
              </details>
              <label><span className="admin-field-label">{t('admin.messageTemplates.own')}</span>
                <textarea className="textarea" rows={10} value={text} data-testid="message-template-own"
                  readOnly={!canSave} onChange={(e) => setText(e.target.value)} />
                <span className="admin-field-hint">{t('admin.messageTemplates.ownHelp')}</span>
                <MarkdownHelp testId="message-template-markdown" />
              </label>
              {canSave && !isPrompt(selected) && (
                <VariablePicker published={published} variables={variables} purpose="insert" testId="message-template-variable-picker"
                  audience={messageAudience(selected.name)} contextSources={contextSources}
                  onPick={(name) => {
                    const next = withFieldBinding(text, name);
                    if (next.field) {
                      setText(next.source);
                      setSamples((cur) => ({ ...cur, [next.field!]: `[${next.field}]` }));
                    }
                  }} />
              )}
              {!canSave && <p className="admin-field-hint">{t('admin.messageTemplates.cannotSave')}</p>}

              {message && (
                <div data-testid="message-template-voice">
                  {selected.voiceable ? (
                    <>
                      <label className="admin-checkbox">
                        <input type="checkbox" checked={isVoice} disabled={!canSave} data-testid="message-template-voice-toggle"
                          onChange={(e) => setText(withVoice(text, e.target.checked, parsedText?.voice))} />
                        {t('admin.messageTemplates.voice.toggle')}
                      </label>
                      <p className="admin-field-hint">{t('admin.messageTemplates.voice.help')}</p>
                      {isVoice && (
                        <div className="admin-form-grid">
                          {(['maxChars', 'deadlineMs'] as const).map((k) => (
                            <label key={k}><span className="admin-field-label">{t(`admin.messageTemplates.voice.${k}`, { most: VOICE_BOUNDS_MAX[k] })}</span>
                              <input type="number" className="input" min={1} max={VOICE_BOUNDS_MAX[k]} disabled={!canSave}
                                data-testid={`message-template-voice-${k}`} value={parsedText?.voice?.[k] ?? VOICE_BOUNDS_DEFAULT[k]}
                                onChange={(e) => setText(withVoice(text, true, { ...(parsedText?.voice ?? {}), [k]: Number(e.target.value) }))} />
                            </label>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="admin-field-hint">{t('admin.messageTemplates.voice.instant')}</p>
                  )}
                </div>
              )}

              <div className="admin-review-buttons">
                <button type="button" className="btn-secondary" data-testid="message-template-save"
                  disabled={busy || !canSave || !preview || 'error' in preview}
                  onClick={() => run(async () => { await saveMessageTemplate(profileName, text, selected.name); setCleanText(text); })}>
                  {t('admin.messageTemplates.save')}
                </button>
                {!!selected.own?.history.length && (
                  <button type="button" className="btn-secondary" data-testid="message-template-rollback" disabled={busy || !canSave}
                    onClick={() => { if (mayLeave(rowUnsaved)) void run(async () => { await rollbackMessageTemplate(profileName, selected.name); seeded.current = ''; }); }}>
                    {t('admin.messageTemplates.rollback')}
                  </button>
                )}
              </div>
              {status && <p className="admin-field-hint" role={status.kind === 'error' ? 'alert' : 'status'} data-testid="message-template-status">{status.text}</p>}
    </div>
  );

  const row = ({ l, use, said }: typeof rows[number]) => {
    const open = l.name === name;
    return (
      <li key={l.name} className={cx('admin-workflow-item', open && 'admin-workflow-item-focus')} data-testid={`message-template-row-${l.name}`}>
        <div className="admin-workflow-item-head">
          <code>{l.name}</code>
          <span className="admin-chip" data-testid={`message-template-origin-${l.name}`}>{t(`admin.messageTemplates.originChip.${use.origin}`)}</span>
          <button type="button" className={cx('btn-secondary', 'btn-sm')} aria-expanded={open} data-testid={`message-template-open-${l.name}`} onClick={() => openRow(open ? '' : l.name)}>
            {t(open ? 'admin.messageTemplates.close' : canSave ? 'admin.messageTemplates.edit' : 'admin.messageTemplates.view')}
          </button>
        </div>
        <span>{l.description}</span>
        {said && !open && <p className="admin-message-said">{said}</p>}
        {open && detail}
      </li>
    );
  };
  const messageRows = rows.filter((r) => !isPrompt(r.l));
  const promptRows = rows.filter((r) => isPrompt(r.l));
  const ownNamed = Object.entries(family).filter(([n, held]) => !shippedNames.has(n) && (n === ownOpen || matches(n, tryParse(held.source).template?.description, whatItSays(held.source)))).sort(([x], [y]) => x.localeCompare(y));
  /** What a new template starts from: what the message says now, where that is a whole template. */
  const seedFor = (message: string): string => {
    const l = listing?.find((x) => x.name === message);
    if (!l) return '';
    return editableStart(l, inUseOf(l).start);
  };
  const ownForm = (existing?: string) => (
    <OwnTemplateForm key={existing ?? '@new'} profileName={profileName} listing={listing ?? []} family={family} existing={existing}
      picked={existing ? messagePicking(messages, existing) : undefined} seedFor={seedFor} published={published} variables={variables}
      contextSources={contextSources} onSaved={load} onClose={() => openOwn('')} unsaved={ownUnsaved} />
  );

  return (
    <div className="profiles-persona-field" data-testid="message-templates">
      <p className="admin-field-hint">{t('admin.messageTemplates.help')}</p>
      {loadError && <p className="admin-field-hint" role="alert">{t('admin.messageTemplates.loadFailed', { error: loadError })}</p>}
      {!listing && !loadError && <p className="admin-muted">{t('admin.messageTemplates.loading')}</p>}
      {listing && (
        <>
          <label><span className="admin-field-label">{t('admin.messageTemplates.find')}</span>
            <input type="search" className="input" value={filter} data-testid="message-template-find" onChange={(ev) => setFilter(ev.target.value)} />
          </label>
          {canSave && ownOpen !== '@new' && (
            <div className="admin-review-buttons">
              <button type="button" className="btn-secondary" data-testid="message-template-new" onClick={() => openOwn('@new')}>{t('admin.messageTemplates.form.new')}</button>
            </div>
          )}
          {ownOpen === '@new' && ownForm()}
          {messageRows.length > 0 && (
            <>
              <h4>{t('admin.messageTemplates.groupMessages')}</h4>
              <ul className="admin-workflow-list" data-testid="message-template-messages">{messageRows.map(row)}</ul>
            </>
          )}
          {promptRows.length > 0 && (
            <>
              <h4>{t('admin.messageTemplates.groupPrompts')}</h4>
              <p className="admin-field-hint">{t('admin.messageTemplates.groupPromptsHelp')}</p>
              <ul className="admin-workflow-list" data-testid="message-template-prompts">{promptRows.map(row)}</ul>
            </>
          )}
          {ownNamed.length > 0 && (
            <>
              <h4>{t('admin.messageTemplates.groupOwnNamed')}</h4>
              <p className="admin-field-hint">{t('admin.messageTemplates.groupOwnNamedHelp')}</p>
              <ul className="admin-workflow-list" data-testid="message-template-own-named">
                {ownNamed.map(([n, held]) => { const said = whatItSays(held.source); return (
                  <li key={n} className="admin-workflow-item" data-testid={`message-template-own-named-${n}`}>
                    <div className="admin-workflow-item-head">
                      <code>{n}</code>
                      {canSave && (
                        <button type="button" className={cx('btn-secondary', 'btn-sm')} aria-expanded={ownOpen === n} data-testid={`message-template-open-own-${n}`} onClick={() => openOwn(ownOpen === n ? '' : n)}>
                          {t(ownOpen === n ? 'admin.messageTemplates.close' : 'admin.messageTemplates.edit')}
                        </button>
                      )}
                    </div>
                    <span>{tryParse(held.source).template?.description}</span>
                    {ownOpen !== n && said && <p className="admin-message-said">{said}</p>}
                    {ownOpen === n ? ownForm(n) : !canSave && (
                      <details>
                        <summary>{t('admin.messageTemplates.source')}</summary>
                        <pre className="admin-welcome-example">{held.source}</pre>
                      </details>
                    )}
                  </li>
                ); })}
              </ul>
            </>
          )}
          {!messageRows.length && !promptRows.length && !ownNamed.length && <p className="admin-muted" data-testid="message-template-none">{t('admin.messageTemplates.noMatch')}</p>}
        </>
      )}
    </div>
  );
};

export default MessageTemplatesEditor;
