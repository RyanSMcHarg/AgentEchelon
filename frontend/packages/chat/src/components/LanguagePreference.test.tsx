/**
 * The language section of Account settings (ADR-062 decision 4): the choices are the languages the server lists, each
 * in its own name; choosing one stores that tag, choosing the deployment's language clears the choice, and a failure is
 * said in the client's own words rather than shown as no choice made (tenet D11).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@ae/shared/i18n';
import LanguagePreference from './LanguagePreference';
import { LanguagePreferenceError, type LanguagePreferenceView } from '../services/languagePreferenceService';

const LANGUAGES = [
  { tag: 'en', name: 'English', native: 'English' },
  { tag: 'es', name: 'Spanish', native: 'Español' },
  { tag: 'ja', name: 'Japanese', native: '日本語' },
];
const viewOf = (language: string | null): LanguagePreferenceView => ({ language, deployment: 'en', languages: LANGUAGES });

describe('the language section of Account settings', () => {
  it('offers the declared languages in their own names, with the deployment\'s language as no choice', async () => {
    render(<LanguagePreference deps={{ load: async () => viewOf(null) }} />);
    const select = await screen.findByRole('combobox', { name: 'Messages to me' });
    expect(select).toHaveValue('');
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(["This deployment's language (English)", 'English', 'Español', '日本語']);
    expect(screen.getByText("A message the whole conversation reads is in the conversation's language.")).toBeInTheDocument();
  });

  it('stores the tag chosen, and clears it when the deployment\'s language is chosen', async () => {
    const user = userEvent.setup();
    const set = vi.fn().mockResolvedValueOnce(viewOf('es')).mockResolvedValueOnce(viewOf(null));
    render(<LanguagePreference deps={{ load: async () => viewOf(null), set }} />);
    const select = await screen.findByRole('combobox', { name: 'Messages to me' });
    await user.selectOptions(select, 'es');
    expect(set).toHaveBeenLastCalledWith('es');
    expect(await screen.findByText('Your language is saved.')).toBeInTheDocument();
    expect(select).toHaveValue('es');
    await user.selectOptions(select, '');
    expect(set).toHaveBeenLastCalledWith(null);
  });

  it('says a refusal in its own words', async () => {
    const user = userEvent.setup();
    const set = vi.fn().mockRejectedValue(new LanguagePreferenceError('UNDECLARED_LANGUAGE', 'raw server text'));
    render(<LanguagePreference deps={{ load: async () => viewOf(null), set }} />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Messages to me' }), 'ja');
    expect(await screen.findByRole('alert')).toHaveTextContent('That language is not one this deployment speaks.');
    expect(screen.queryByText('raw server text')).toBeNull();
  });

  it('says a failed read, never showing it as no choice', async () => {
    render(<LanguagePreference deps={{ load: async () => { throw new LanguagePreferenceError('UNREADABLE', 'x'); } }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Your language could not be read just now.');
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
