/**
 * THE ONE PLACE TO EDIT WHAT AN ASSISTANT SAYS (ADR-062): its message templates, beside the classification's and the
 * shipped ones, and which of them this version uses.
 *
 * Every line the assistant posts or emails for a platform event, and the request its join recap answers, is a
 * template. For the one selected, this shows the three families side by side, says which one is in use, edits
 * the assistant's own and saves it, which makes it the one in use at once: a template is not part of a version.
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
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseTemplate, messageFieldType, type ParsedTemplate } from '../../../../../../backend/lambda/src/lib/document-template.ts';
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
import type { PublishedVariables, VersionVariable } from '../../../../../../backend/lambda/src/lib/variables.ts';
import VariablePicker from './VariablePicker';
import MessageChoicesEditor, { templateOptionsFor } from './MessageChoicesEditor';
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
  });
  const start = chosen.origin === 'assistant' ? ownSource!
    : chosen.origin === 'classification' ? listing.classification!.source
      : listing.shipped;
  return { origin: chosen.origin, start, ...(named && chosen.origin === 'assistant' ? { named } : {}) };
}

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
}> = ({ profileName, messages: draftMessages, onMessagesChange, canSave, published, variables }) => {
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
  const [text, setText] = useState('');
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [languages, setLanguages] = useState<DeclaredLanguage[]>([]);
  const [tab, setTab] = useState('');

  const load = async (keep?: string) => {
    setLoadError('');
    try {
      const r = await listMessageTemplates(profileName);
      setListing(r.templates);
      setFamily(r.family ?? {});
      setLanguages(Array.isArray(r.languages) ? r.languages : []);
      const pick = keep && r.templates.some((x) => x.name === keep) ? keep : r.templates[0]?.name ?? '';
      setName(pick);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  };
  useEffect(() => { void load(); }, [profileName]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = listing?.find((x) => x.name === name);
  const inUse = useMemo(() => (selected ? templateInUse(selected, family, messages) : undefined), [selected, family, messages]);
  const shippedNames = useMemo(() => new Set((listing ?? []).map((x) => x.name)), [listing]);
  useEffect(() => {
    if (!selected || !inUse) return;
    setText(inUse.start);
    const fields = tryParse(selected.shipped).template?.fields ?? {};
    setSamples(Object.fromEntries(Object.entries(fields).map(([f, b]) => [f, sampleValue(f, b)])));
    setStatus(null);
  }, [selected?.name, inUse?.start]); // eslint-disable-line react-hooks/exhaustive-deps

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
      await load(name);
    } catch (err) {
      setStatus({ kind: 'error', text: t('admin.messageTemplates.notSaved', { error: (err as Error).message }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="profiles-persona-field" data-testid="message-templates">
      <h5>{t('admin.messageTemplates.title')}</h5>
      <p className="admin-field-hint">{t('admin.messageTemplates.help')}</p>
      {loadError && <p className="admin-field-hint" role="alert">{t('admin.messageTemplates.loadFailed', { error: loadError })}</p>}
      {!listing && !loadError && <p className="admin-muted">{t('admin.messageTemplates.loading')}</p>}
      {listing && (
        <>
          <label><span className="admin-field-label">{t('admin.messageTemplates.pick')}</span>
            <select className="select" value={name} data-testid="message-template-pick" onChange={(e) => setName(e.target.value)}>
              {listing.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            </select>
          </label>
          {selected && inUse && (
            <>
              <p className="admin-field-hint">{selected.description}</p>
              <p className="admin-field-hint" data-testid="message-template-in-use">
                {t('admin.messageTemplates.inUse', { origin: inUse.named
                  ? t('admin.messageTemplates.origin.named', { name: inUse.named })
                  : t(`admin.messageTemplates.origin.${inUse.origin}`) })}
              </p>
              {isPrompt(selected) && <p className="admin-field-hint">{t('admin.messageTemplates.promptNote')}</p>}
              <MessageChoicesEditor message={selected.name} entry={messages[selected.name]} published={published} variables={variables}
                options={templateOptionsFor(t as never, { hasClassification: !!selected.classification, own: ownTemplatesFor(selected, family, shippedNames) })}
                {...(onMessagesChange ? { onChange: (next: MessageEntry | undefined) => pick(selected.name, next) } : {})} />
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
              </label>
              {canSave && !isPrompt(selected) && (
                <VariablePicker published={published} variables={variables} purpose="insert" testId="message-template-variable-picker"
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

              {message && (
                <div data-testid="message-template-languages">
                  <h6>{t('admin.messageTemplates.languages.title')}</h6>
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

              <h6>{t('admin.messageTemplates.preview')}</h6>
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
                : preview && (
                  <dl className="admin-config-list" data-testid="message-template-preview">
                    {Object.entries(preview.sections).map(([section, rendered]) => (
                      <React.Fragment key={section}>
                        <dt><code>{section}</code></dt>
                        <dd><pre className="admin-welcome-preview">{rendered}</pre></dd>
                      </React.Fragment>
                    ))}
                  </dl>
                )}

              <div className="admin-review-buttons">
                <button type="button" className="btn-secondary" data-testid="message-template-save"
                  disabled={busy || !canSave || !preview || 'error' in preview}
                  onClick={() => run(() => saveMessageTemplate(profileName, text, selected.name))}>
                  {t('admin.messageTemplates.save')}
                </button>
                {!!selected.own?.history.length && (
                  <button type="button" className="btn-secondary" data-testid="message-template-rollback" disabled={busy || !canSave}
                    onClick={() => run(() => rollbackMessageTemplate(profileName, selected.name))}>
                    {t('admin.messageTemplates.rollback')}
                  </button>
                )}
              </div>
              {status && <p className="admin-field-hint" role={status.kind === 'error' ? 'alert' : 'status'} data-testid="message-template-status">{status.text}</p>}
            </>
          )}
        </>
      )}
    </div>
  );
};

export default MessageTemplatesEditor;
