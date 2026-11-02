/**
 * AN ASSISTANT'S MESSAGE TEMPLATES ARE EDITED BESIDE THE CLASSIFICATION'S AND THE SHIPPED, AND THE PREVIEW IS WHAT
 * THE RUNTIME POSTS (ADR-062).
 *
 * What it proves: the preview of a template and a set of values equals what the router posts for the same
 * template and values (`noticeLine`, the notice path's own render; the task notice's equality is proven on the
 * server, `a-message-is-a-template.test.ts`); the editor says which family is in use by the server's own order
 * (the template the version's `messages` names, a family it picks, the assistant's own, the classification's, then the
 * shipped), with no legacy step; picking the template a message is said from writes the draft's `messages`; saving
 * sends the edited source and the message it words for this assistant; and without `activate-profiles` the editor is
 * read-only and says why.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MessageTemplatesEditor, { previewMessageTemplate, templateInUse, sampleValue, withLanguageVariant, withVoice } from './MessageTemplatesEditor';
import { parseTemplate } from '../../../../../../backend/lambda/src/lib/document-template.ts';
import { noticeLine } from '../../../../../../backend/lambda/src/lib/assistant-notice.ts';
import { shippedMessageTemplates } from '../../../../../../backend/lambda/src/lib/shipped-message-templates.ts';
import * as svc from '../../services/profileService';

vi.mock('../../services/profileService', () => ({
  listMessageTemplates: vi.fn(),
  saveMessageTemplate: vi.fn(),
  rollbackMessageTemplate: vi.fn(),
}));

const shipped = (name: string) => shippedMessageTemplates().get(name)!;
const listing = (name: string, extra: Partial<svc.MessageTemplateListing> = {}): svc.MessageTemplateListing => ({
  name, kind: shipped(name).entry.kind, description: shipped(name).entry.description, shipped: shipped(name).source, ...extra,
});
const reworded = (name: string, section: string, text: string) => {
  const s = shipped(name);
  return s.source.replace(`# ${section}\n${s.template.messageSections![section]}\n`, `# ${section}\n${text}\n`);
};

describe('the preview is what the runtime posts', () => {
  const values = { name: 'Riley', recap: 'the Q3 review', title: 'Q3 review' };

  it.each([
    ['the shipped member welcome', shipped('member-welcome').source],
    ['a reworded one with a line that names an empty field', reworded('member-welcome', 'chat', 'Welcome, {{name}}.\nYou joined {{missing}}.\nSee you there.').replace('"title":"conversation:title"', '"title":"conversation:title","missing":"value:text"')],
  ])('%s: the chat line equals the router\'s notice render', (_label, source) => {
    const preview = previewMessageTemplate(source, values);
    if (!('sections' in preview)) throw new Error(preview.error);
    expect(preview.sections.chat).toBe(noticeLine(undefined, 'memberWelcome', values, undefined, parseTemplate(source)));
  });

  it('a template that does not parse says why', () => {
    expect(previewMessageTemplate('# chat\nHi', {})).toEqual({ error: expect.stringContaining('front-matter') });
  });

  it('samples are language-free, by type', () => {
    expect(sampleValue('count', 'value:count')).toBe('3');
    expect(sampleValue('name', 'person:displayName')).toBe('[name]');
  });
});

describe('which template is in use is the server\'s order', () => {
  const own = reworded('member-welcome', 'chat', 'Welcome aboard, {{name}}.');
  const classwide = reworded('member-welcome', 'chat', 'Hello {{name}}.');

  it('the assistant\'s own, over the classification\'s, and it is where an edit starts', () => {
    expect(templateInUse(listing('member-welcome', { own: { contentHash: 'a', source: own, history: [] }, classification: { contentHash: 'b', source: classwide } })))
      .toEqual({ origin: 'assistant', start: own });
  });

  it('the template the version names for the message, over the one of the message\'s own name', () => {
    const named = reworded('member-welcome', 'chat', 'Hi {{name}}, from the advisor.').replace('"name":"member-welcome"', '"name":"advisor-welcome"');
    const r = templateInUse(listing('member-welcome', { own: { contentHash: 'a', source: own, history: [] } }),
      { 'advisor-welcome': { contentHash: 'c', source: named, history: [] } }, { 'member-welcome': 'advisor-welcome' });
    expect(r).toEqual({ origin: 'assistant', start: named, named: 'advisor-welcome' });
  });

  it('a family the version picks: @classification skips the assistant\'s own, @shipped skips both', () => {
    const both = listing('member-welcome', { own: { contentHash: 'a', source: own, history: [] }, classification: { contentHash: 'b', source: classwide } });
    expect(templateInUse(both, {}, { 'member-welcome': '@classification' })).toEqual({ origin: 'classification', start: classwide });
    expect(templateInUse(both, {}, { 'member-welcome': '@shipped' })).toEqual({ origin: 'shipped', start: shipped('member-welcome').source });
  });

  it('the classification\'s, then the shipped', () => {
    expect(templateInUse(listing('member-welcome', { classification: { contentHash: 'b', source: classwide } })).origin).toBe('classification');
    expect(templateInUse(listing('member-welcome'))).toEqual({ origin: 'shipped', start: shipped('member-welcome').source });
  });

  it('has no legacy step: it takes no version copy, and names no legacy origin', () => {
    expect(templateInUse.length).toBeLessThanOrEqual(3);
    const source = readFileSync(join(__dirname, 'MessageTemplatesEditor.tsx'), 'utf8');
    expect(source).not.toMatch(/legacyLinesOf|'legacy'/);
  });
});

describe('the editor', () => {
  beforeEach(() => {
    vi.mocked(svc.listMessageTemplates).mockResolvedValue({ assistant: 'advisor', classification: 'basic', templates: [listing('member-welcome'), listing('join-recap')], family: {} });
    vi.mocked(svc.saveMessageTemplate).mockResolvedValue({ name: 'member-welcome', contentHash: 'h', changed: true });
  });

  it('says what is in use, previews it, and saves the edited source for this assistant', async () => {
    render(<MessageTemplatesEditor profileName="advisor" canSave />);
    await waitFor(() => expect(screen.getByTestId('message-template-in-use')).toHaveTextContent('the shipped template'));
    await waitFor(() => expect(screen.getByTestId('message-template-preview')).toHaveTextContent('Welcome, [name].'));
    const edited = reworded('member-welcome', 'chat', 'Welcome aboard, {{name}}.');
    fireEvent.change(screen.getByTestId('message-template-own'), { target: { value: edited } });
    expect(screen.getByTestId('message-template-preview')).toHaveTextContent('Welcome aboard, [name].');
    fireEvent.click(screen.getByTestId('message-template-save'));
    await waitFor(() => expect(svc.saveMessageTemplate).toHaveBeenCalledWith('advisor', edited, 'member-welcome'));
  });

  it('PICKING THE TEMPLATE A MESSAGE IS SAID FROM WRITES THE DRAFT\'S messages, and says it is in use', async () => {
    const mine = reworded('member-welcome', 'chat', 'Hi {{name}}, from the advisor.').replace('"name":"member-welcome"', '"name":"advisor-welcome"');
    vi.mocked(svc.listMessageTemplates).mockResolvedValue({
      assistant: 'advisor', classification: 'basic', templates: [listing('member-welcome'), listing('join-recap')],
      family: { 'advisor-welcome': { contentHash: 'c', source: mine, history: [] } },
    });
    const onMessagesChange = vi.fn();
    render(<MessageTemplatesEditor profileName="advisor" canSave onMessagesChange={onMessagesChange} messages={{ 'join-recap': '@shipped' }} />);
    const pick = await screen.findByTestId('message-choice-pick');
    expect(pick).toHaveValue('');
    expect([...(pick as HTMLSelectElement).options].map((o) => o.value)).toEqual(['', '@shipped', '@classification', 'advisor-welcome']);
    fireEvent.change(pick, { target: { value: 'advisor-welcome' } });
    expect(onMessagesChange).toHaveBeenLastCalledWith({ 'join-recap': '@shipped', 'member-welcome': 'advisor-welcome' });
    await waitFor(() => expect(screen.getByTestId('message-template-in-use')).toHaveTextContent('advisor-welcome'));
    fireEvent.change(screen.getByTestId('message-choice-pick'), { target: { value: '@shipped' } });
    expect(onMessagesChange).toHaveBeenLastCalledWith({ 'join-recap': '@shipped', 'member-welcome': '@shipped' });
    // No choice removes the entry, and the selection order answers.
    fireEvent.change(screen.getByTestId('message-choice-pick'), { target: { value: '' } });
    expect(onMessagesChange).toHaveBeenLastCalledWith({ 'join-recap': '@shipped' });
  });

  it('a condition before otherwise makes the entry a list of alternatives', async () => {
    const onMessagesChange = vi.fn();
    render(<MessageTemplatesEditor profileName="advisor" canSave onMessagesChange={onMessagesChange} />);
    fireEvent.click(await screen.findByTestId('message-choice-add-alternative'));
    expect(onMessagesChange).toHaveBeenLastCalledWith({ 'member-welcome': [{ template: '@classification' }, { template: '@shipped' }] });
    expect(screen.getByTestId('message-choice-alt-0-when')).toBeTruthy();
  });

  it('without edit-profiles the pick is shown and explained, not editable', async () => {
    render(<MessageTemplatesEditor profileName="advisor" canSave messages={{ 'member-welcome': '@shipped' }} />);
    expect(await screen.findByTestId('message-choice-pick')).toBeDisabled();
    expect(screen.getByTestId('message-choice-pick')).toHaveValue('@shipped');
    expect(screen.getByTestId('message-choice-read-only')).toHaveTextContent('edit-profiles');
  });

  it('will not save what does not parse', async () => {
    render(<MessageTemplatesEditor profileName="advisor" canSave />);
    await waitFor(() => screen.getByTestId('message-template-own'));
    fireEvent.change(screen.getByTestId('message-template-own'), { target: { value: '# chat\nno front matter' } });
    expect(screen.getByTestId('message-template-error')).toBeTruthy();
    expect(screen.getByTestId('message-template-save')).toBeDisabled();
  });

  it('without activate-profiles it is read-only and says why', async () => {
    render(<MessageTemplatesEditor profileName="advisor" canSave={false} />);
    await waitFor(() => screen.getByTestId('message-template-own'));
    expect(screen.getByTestId('message-template-own')).toHaveAttribute('readonly');
    expect(screen.getByTestId('message-template-save')).toBeDisabled();
    expect(screen.getByText(/activate-profiles/)).toBeTruthy();
  });
});

describe('a template speaks the deployment\'s languages, and a targeted message may use the assistant\'s voice', () => {
  const LANGUAGES = [
    { tag: 'en', name: 'English', native: 'English' },
    { tag: 'es', name: 'Spanish', native: 'Español' },
    { tag: 'pl', name: 'Polish', native: 'Polski' },
  ];

  it('adds a whole variant, which previews in its own language and plural rules', () => {
    const source = withLanguageVariant(shipped('queue-settled').source, 'pl');
    const parsed = parseTemplate(source);
    expect(Object.keys(parsed.variants?.pl ?? {})).toEqual(Object.keys(parsed.messageSections ?? {}));
    expect(withLanguageVariant(source, 'pl')).toBe(source);
    const polish = source.replace('# chat.other@pl\nCaught up - I have read those {{count}} messages.', '# chat.other@pl\nPrzeczytane: {{count}}.');
    const preview = previewMessageTemplate(polish, { count: '3' }, 'pl');
    if (!('sections' in preview)) throw new Error(preview.error);
    expect(preview.language).toBe('pl');
    expect(preview.sections['chat.other']).toBe('Przeczytane: 3.');
    const own = previewMessageTemplate(polish, { count: '3' }, 'es');
    expect('sections' in own && own.language).toBe('en');
  });

  it('turns the voice on with its bounds, and off again, in the front matter', () => {
    const on = withVoice(shipped('workflow-subject-welcome').source, true, { maxChars: 200 });
    expect(parseTemplate(on)).toMatchObject({ fill: 'voice', voice: { maxChars: 200, deadlineMs: 8000 } });
    expect(parseTemplate(withVoice(on, false)).fill).toBe('platform');
  });

  it('shows the deployment\'s languages as tabs, says what a reader in an unwritten one gets, and adds a variant', async () => {
    vi.mocked(svc.listMessageTemplates).mockResolvedValue({
      assistant: 'advisor', classification: 'basic', languages: LANGUAGES, family: {},
      templates: [listing('workflow-subject-welcome', { voiceable: true }), listing('member-welcome')],
    });
    render(<MessageTemplatesEditor profileName="advisor" canSave />);
    await waitFor(() => expect(screen.getByTestId('message-template-language-map')).toHaveTextContent('English (en), Español (es), Polski (pl)'));
    expect(screen.getByTestId('message-template-language-map')).toHaveTextContent('languages in deploy.config.json');
    fireEvent.click(screen.getByTestId('message-template-language-es'));
    expect(screen.getByTestId('message-template-language-fallback')).toHaveTextContent('a reader in es gets the en text');
    fireEvent.click(screen.getByTestId('message-template-voice-toggle'));
    expect(screen.getByTestId('message-template-language-fallback')).toHaveTextContent("in the assistant's voice, said by a model in es");
    expect(screen.getByTestId('message-template-voice-maxChars')).toHaveValue(600);
    fireEvent.click(screen.getByTestId('message-template-add-variant'));
    const text = (screen.getByTestId('message-template-own') as HTMLTextAreaElement).value;
    expect(parseTemplate(text).variants?.es).toBeDefined();
    expect(screen.queryByTestId('message-template-language-fallback')).toBeNull();
  });

  it('offers no voice on a message said instantly, and says why', async () => {
    vi.mocked(svc.listMessageTemplates).mockResolvedValue({
      assistant: 'advisor', classification: 'basic', languages: LANGUAGES, family: {}, templates: [listing('member-welcome')],
    });
    render(<MessageTemplatesEditor profileName="advisor" canSave />);
    await waitFor(() => expect(screen.getByTestId('message-template-voice')).toHaveTextContent('said instantly'));
    expect(screen.queryByTestId('message-template-voice-toggle')).toBeNull();
  });
});
