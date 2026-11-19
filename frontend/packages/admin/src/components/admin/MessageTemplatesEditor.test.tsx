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
import MessageTemplatesEditor, { previewMessageTemplate, templateInUse, sampleValue, whatItSays, withLanguageVariant, withVoice } from './MessageTemplatesEditor';
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

/** A template is read on its row, and opened from it to edit. */
const openRow = async (name: string) => fireEvent.click(await screen.findByTestId(`message-template-open-${name}`));

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

  it('every shipped template has words to show on its row', () => {
    const silent = [...shippedMessageTemplates().values()].filter(({ source }) => !whatItSays(source)?.trim()).map(({ entry }) => entry.name);
    expect(silent).toEqual([]);
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

  it('LISTS EVERY TEMPLATE WITH ITS PURPOSE, WHOSE IT IS AND WHAT IT SAYS, before any is opened', async () => {
    render(<MessageTemplatesEditor profileName="advisor" canSave />);
    const row = await screen.findByTestId('message-template-row-member-welcome');
    expect(row).toHaveTextContent(shipped('member-welcome').entry.description);
    expect(row).toHaveTextContent('Welcome, [name].');
    expect(screen.getByTestId('message-template-origin-member-welcome')).toHaveTextContent('Shipped');
    expect(screen.getByTestId('message-template-row-join-recap')).toBeTruthy();
    expect(screen.queryByTestId('message-template-detail')).toBeNull();
  });

  describe('a template under a name of its own', () => {
    const openNew = async () => {
      fireEvent.click(await screen.findByTestId('message-template-new'));
      fireEvent.change(screen.getByTestId('message-template-new-message'), { target: { value: 'member-welcome' } });
    };
    const named = (name: string) => reworded('member-welcome', 'chat', 'Hi {{name}}, from the advisor.').replace('"name":"member-welcome"', `"name":"${name}"`);

    it('CREATES ONE: starts from what the message says, stores it under the new name and names the message it words', async () => {
      vi.mocked(svc.saveMessageTemplate).mockResolvedValue({ name: 'advisor-welcome', contentHash: 'h', changed: true });
      render(<MessageTemplatesEditor profileName="advisor" canSave />);
      await openNew();
      expect((screen.getByTestId('message-template-new-text') as HTMLTextAreaElement).value).toContain('# chat');
      expect((screen.getByTestId('message-template-new-text') as HTMLTextAreaElement).value).not.toContain('---');
      expect(screen.getByTestId('message-template-new-save')).toBeDisabled();
      fireEvent.change(screen.getByTestId('message-template-new-name'), { target: { value: 'advisor-welcome' } });
      fireEvent.change(screen.getByTestId('message-template-new-description'), { target: { value: 'The advisor greets a member' } });
      fireEvent.click(screen.getByTestId('message-template-new-save'));
      await waitFor(() => expect(svc.saveMessageTemplate).toHaveBeenCalled());
      const [assistant, source, message] = vi.mocked(svc.saveMessageTemplate).mock.calls[0];
      expect([assistant, message]).toEqual(['advisor', 'member-welcome']);
      const saved = parseTemplate(source);
      expect([saved.name, saved.description]).toEqual(['advisor-welcome', 'The advisor greets a member']);
      expect(await screen.findByTestId('message-template-new-status')).toHaveTextContent('once a version');
    });

    it.each([
      ['a shipped name', 'join-recap', 'shipped template'],
      ['a name this assistant holds', 'advisor-welcome', 'already has'],
      ['a name the store refuses', 'Advisor Welcome', 'lowercase'],
    ])('refuses %s before it reaches the server', async (_label, name, says) => {
      vi.mocked(svc.listMessageTemplates).mockResolvedValue({ assistant: 'advisor', classification: 'basic', templates: [listing('member-welcome'), listing('join-recap')], family: { 'advisor-welcome': { contentHash: 'c', source: named('advisor-welcome'), history: [] } } });
      render(<MessageTemplatesEditor profileName="advisor" canSave />);
      await openNew();
      fireEvent.change(screen.getByTestId('message-template-new-name'), { target: { value: name } });
      expect(screen.getByTestId('message-template-new-name-hint')).toHaveTextContent(says);
      expect(screen.getByTestId('message-template-new-save')).toBeDisabled();
    });

    it('a template that does not parse cannot be saved, and says why', async () => {
      render(<MessageTemplatesEditor profileName="advisor" canSave />);
      await openNew();
      fireEvent.change(screen.getByTestId('message-template-new-name'), { target: { value: 'advisor-welcome' } });
      fireEvent.change(screen.getByTestId('message-template-new-text'), { target: { value: 'no heading here' } });
      expect(screen.getByTestId('message-template-new-error')).toBeTruthy();
      expect(screen.getByTestId('message-template-new-save')).toBeDisabled();
    });

    it('changing the message restarts the words only while they are unwritten', async () => {
      render(<MessageTemplatesEditor profileName="advisor" canSave />);
      await openNew();
      const text = () => (screen.getByTestId('message-template-new-text') as HTMLTextAreaElement).value;
      const welcome = text();
      fireEvent.change(screen.getByTestId('message-template-new-message'), { target: { value: 'join-recap' } });
      expect(text()).not.toBe(welcome);
      fireEvent.change(screen.getByTestId('message-template-new-text'), { target: { value: '# prompt\nMine' } });
      fireEvent.change(screen.getByTestId('message-template-new-message'), { target: { value: 'member-welcome' } });
      expect(text()).toBe('# prompt\nMine');
    });

    it('EDITS ONE IT HOLDS, opened on the message this version says from it, with its name kept', async () => {
      vi.mocked(svc.listMessageTemplates).mockResolvedValue({ assistant: 'advisor', classification: 'basic', templates: [listing('member-welcome'), listing('join-recap')], family: { 'advisor-welcome': { contentHash: 'c', source: named('advisor-welcome'), history: [] } } });
      render(<MessageTemplatesEditor profileName="advisor" canSave messages={{ 'member-welcome': 'advisor-welcome' }} />);
      fireEvent.click(await screen.findByTestId('message-template-open-own-advisor-welcome'));
      expect(screen.queryByTestId('message-template-new-name')).toBeNull();
      expect((screen.getByTestId('message-template-new-message') as HTMLSelectElement).value).toBe('member-welcome');
      fireEvent.click(screen.getByTestId('message-template-new-save'));
      await waitFor(() => expect(svc.saveMessageTemplate).toHaveBeenCalledWith('advisor', expect.stringContaining('"name":"advisor-welcome"'), 'member-welcome'));
    });

    it('a search that excludes the open form leaves it open with its words', async () => {
      vi.mocked(svc.listMessageTemplates).mockResolvedValue({ assistant: 'advisor', classification: 'basic', templates: [listing('member-welcome')], family: { 'advisor-welcome': { contentHash: 'c', source: named('advisor-welcome'), history: [] } } });
      render(<MessageTemplatesEditor profileName="advisor" canSave />);
      fireEvent.click(await screen.findByTestId('message-template-open-own-advisor-welcome'));
      fireEvent.change(screen.getByTestId('message-template-new-text'), { target: { value: '# chat\nMine' } });
      fireEvent.change(screen.getByTestId('message-template-find'), { target: { value: 'nothing matches this' } });
      expect((screen.getByTestId('message-template-new-text') as HTMLTextAreaElement).value).toBe('# chat\nMine');
    });

    it('choosing a message for a form nobody has written in asks nothing on closing', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<MessageTemplatesEditor profileName="advisor" canSave />);
      await openNew();
      fireEvent.change(screen.getByTestId('message-template-new-message'), { target: { value: 'join-recap' } });
      fireEvent.click(screen.getByTestId('message-template-new-close'));
      expect(confirm).not.toHaveBeenCalled();
      expect(screen.queryByTestId('message-template-own-form')).toBeNull();
      confirm.mockRestore();
    });

    it('asks before words not saved are dropped, and keeps them when told no', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<MessageTemplatesEditor profileName="advisor" canSave />);
      await openNew();
      fireEvent.change(screen.getByTestId('message-template-new-name'), { target: { value: 'advisor-welcome' } });
      fireEvent.click(screen.getByTestId('message-template-new-close'));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('message-template-own-form')).toBeTruthy();
      confirm.mockRestore();
    });

    it('one no version picks asks which message it words before it can be saved', async () => {
      vi.mocked(svc.listMessageTemplates).mockResolvedValue({ assistant: 'advisor', classification: 'basic', templates: [listing('member-welcome')], family: { 'advisor-welcome': { contentHash: 'c', source: named('advisor-welcome'), history: [] } } });
      render(<MessageTemplatesEditor profileName="advisor" canSave />);
      fireEvent.click(await screen.findByTestId('message-template-open-own-advisor-welcome'));
      expect(screen.getByTestId('message-template-new-save')).toBeDisabled();
      fireEvent.change(screen.getByTestId('message-template-new-message'), { target: { value: 'member-welcome' } });
      expect(screen.getByTestId('message-template-new-save')).not.toBeDisabled();
    });

    it('without activate-profiles there is nothing to create and the held one is only read', async () => {
      vi.mocked(svc.listMessageTemplates).mockResolvedValue({ assistant: 'advisor', classification: 'basic', templates: [listing('member-welcome')], family: { 'advisor-welcome': { contentHash: 'c', source: named('advisor-welcome'), history: [] } } });
      render(<MessageTemplatesEditor profileName="advisor" canSave={false} />);
      await screen.findByTestId('message-template-own-named-advisor-welcome');
      expect(screen.queryByTestId('message-template-new')).toBeNull();
      expect(screen.queryByTestId('message-template-open-own-advisor-welcome')).toBeNull();
    });
  });

  it('a shipped row: a save keeps its confirmation, and an unsaved rewording asks before another row opens', async () => {
    const saved = reworded('member-welcome', 'chat', 'Welcome aboard, {{name}}.');
    vi.mocked(svc.listMessageTemplates).mockResolvedValueOnce({ assistant: 'advisor', classification: 'basic', templates: [listing('member-welcome'), listing('join-recap')], family: {} })
      .mockResolvedValue({ assistant: 'advisor', classification: 'basic', templates: [listing('member-welcome', { own: { contentHash: 'a', source: saved, history: [] } }), listing('join-recap')], family: {} });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<MessageTemplatesEditor profileName="advisor" canSave />);
    await openRow('member-welcome');
    fireEvent.change(screen.getByTestId('message-template-own'), { target: { value: saved } });
    await openRow('join-recap');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('message-template-own') as HTMLTextAreaElement).value).toBe(saved);
    fireEvent.click(screen.getByTestId('message-template-save'));
    await waitFor(() => expect(screen.getByTestId('message-template-origin-member-welcome')).toHaveTextContent("This assistant's"));
    expect(screen.getByTestId('message-template-status')).toHaveTextContent('Saved');
    confirm.mockRestore();
  });

  it('a rollback asks before dropping an edit, then shows what is in use', async () => {
    const was = reworded('member-welcome', 'chat', 'Welcome back, {{name}}.');
    const now = reworded('member-welcome', 'chat', 'Hello again, {{name}}.');
    vi.mocked(svc.listMessageTemplates).mockResolvedValueOnce({ assistant: 'advisor', classification: 'basic', templates: [listing('member-welcome', { own: { contentHash: 'a', source: now, history: ['b'] } })], family: {} })
      .mockResolvedValue({ assistant: 'advisor', classification: 'basic', templates: [listing('member-welcome', { own: { contentHash: 'b', source: was, history: [] } })], family: {} });
    vi.mocked(svc.rollbackMessageTemplate).mockResolvedValue({ name: 'member-welcome', from: 'a', to: 'b' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    render(<MessageTemplatesEditor profileName="advisor" canSave />);
    await openRow('member-welcome');
    fireEvent.change(screen.getByTestId('message-template-own'), { target: { value: 'typed and not saved' } });
    fireEvent.click(screen.getByTestId('message-template-rollback'));
    expect(svc.rollbackMessageTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('message-template-rollback'));
    await waitFor(() => expect((screen.getByTestId('message-template-own') as HTMLTextAreaElement).value).toBe(was));
    confirm.mockRestore();
  });

  it('a deployment line shows its words on the row, and opens on a template that can be saved', async () => {
    render(<MessageTemplatesEditor profileName="advisor" canSave deploymentLines={{ 'member-welcome': 'Welcome to Stratum.' }} />);
    expect(await screen.findByTestId('message-template-row-member-welcome')).toHaveTextContent('Welcome to Stratum.');
    await openRow('member-welcome');
    expect((screen.getByTestId('message-template-own') as HTMLTextAreaElement).value).toContain('# chat\nWelcome to Stratum.');
    expect(screen.getByTestId('message-template-preview')).toHaveTextContent('Welcome to Stratum.');
    expect(screen.getByTestId('message-template-save')).not.toBeDisabled();
  });

  it('finds a template by its words, and shows one saved under its own name', async () => {
    vi.mocked(svc.listMessageTemplates).mockResolvedValue({
      assistant: 'advisor', classification: 'basic', templates: [listing('member-welcome'), listing('join-recap')],
      family: { 'advisor-welcome': { contentHash: 'c', source: reworded('member-welcome', 'chat', 'Hi {{name}}, from the advisor.').replace('"name":"member-welcome"', '"name":"advisor-welcome"'), history: [] } },
    });
    render(<MessageTemplatesEditor profileName="advisor" canSave />);
    expect(await screen.findByTestId('message-template-own-named-advisor-welcome')).toHaveTextContent('Hi [name], from the advisor.');
    fireEvent.change(screen.getByTestId('message-template-find'), { target: { value: 'from the advisor' } });
    expect(screen.queryByTestId('message-template-row-member-welcome')).toBeNull();
    expect(screen.getByTestId('message-template-own-named-advisor-welcome')).toBeTruthy();
  });

  it('with no draft open, says the pick changes in a draft and still saves the template', async () => {
    render(<MessageTemplatesEditor profileName="advisor" canSave picksNote="in a draft" />);
    await openRow('member-welcome');
    expect(screen.getByTestId('message-choice-read-only')).toHaveTextContent('in a draft');
    expect(screen.getByTestId('message-template-save')).toBeEnabled();
  });

  it('says what is in use, previews it, and saves the edited source for this assistant', async () => {
    render(<MessageTemplatesEditor profileName="advisor" canSave />);
    await openRow('member-welcome');
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
    await openRow('member-welcome');
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

  it('an alternative before otherwise asks for its condition, and is not saved until it has one, as the save requires', async () => {
    const onMessagesChange = vi.fn();
    render(<MessageTemplatesEditor profileName="advisor" canSave onMessagesChange={onMessagesChange} />);
    await openRow('member-welcome');
    fireEvent.click(await screen.findByTestId('message-choice-add-alternative'));
    expect(screen.getByTestId('message-choice-alt-0-when')).toBeTruthy();
    expect(screen.getByTestId('message-choice-alt-0-needs-when')).toHaveTextContent('not saved');
    // A draft patch with an alternative carrying no `when` is refused by the save (`profile-copy-fields.ts`), so none is sent.
    expect(onMessagesChange).not.toHaveBeenCalled();
  });

  it('a list whose every alternative but the last has a condition is saved as it stands', async () => {
    const onMessagesChange = vi.fn();
    const when = { source: 'conversation:type', op: 'eq', value: 'ops' };
    render(<MessageTemplatesEditor profileName="advisor" canSave onMessagesChange={onMessagesChange}
      messages={{ 'member-welcome': [{ template: '@classification', when } as never, { template: '@shipped' }] }} />);
    await openRow('member-welcome');
    fireEvent.change(await screen.findByTestId('message-choice-alt-1-template'), { target: { value: '@classification' } });
    expect(onMessagesChange).toHaveBeenLastCalledWith({ 'member-welcome': [{ template: '@classification', when }, { template: '@classification' }] });
  });

  it('without edit-profiles the pick is shown and explained, not editable', async () => {
    render(<MessageTemplatesEditor profileName="advisor" canSave messages={{ 'member-welcome': '@shipped' }} />);
    await openRow('member-welcome');
    expect(await screen.findByTestId('message-choice-pick')).toBeDisabled();
    expect(screen.getByTestId('message-choice-pick')).toHaveValue('@shipped');
    expect(screen.getByTestId('message-choice-read-only')).toHaveTextContent('edit-profiles');
  });

  it('will not save what does not parse', async () => {
    render(<MessageTemplatesEditor profileName="advisor" canSave />);
    await openRow('member-welcome');
    await waitFor(() => screen.getByTestId('message-template-own'));
    fireEvent.change(screen.getByTestId('message-template-own'), { target: { value: '# chat\nno front matter' } });
    expect(screen.getByTestId('message-template-error')).toBeTruthy();
    expect(screen.getByTestId('message-template-save')).toBeDisabled();
  });

  it('without activate-profiles it is read-only and says why', async () => {
    render(<MessageTemplatesEditor profileName="advisor" canSave={false} />);
    await openRow('member-welcome');
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
    await openRow('workflow-subject-welcome');
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
    await openRow('member-welcome');
    await waitFor(() => expect(screen.getByTestId('message-template-voice')).toHaveTextContent('said instantly'));
    expect(screen.queryByTestId('message-template-voice-toggle')).toBeNull();
  });
});
