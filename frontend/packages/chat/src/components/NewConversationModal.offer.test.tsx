/**
 * THE NEW CONVERSATION PICKER OFFERS THE DEPLOYMENT'S DECLARED SET, BY ITS DECLARED NAMES AND COLORS.
 *
 * The options were a hardcoded list of the three sample names, so a deployment declaring `legal` and
 * `finance` opened this picker to nothing. They are now the conversational, members-audience
 * classifications the person's own classification grants (`creatableClassifications`), named by their
 * display names and drawn in their badge colors. An affordance only: the server refuses a creation the
 * person is not cleared for.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setClassificationsForTest, type ClientClassification } from '@ae/shared/config/classifications.ts';
import { SAMPLE_CLASSIFICATIONS } from '@ae/shared/config/sampleClassifications.ts';

let tier: string | undefined = 'legal';
vi.mock('@ae/shared', () => ({ useAuth: () => ({ user: { id: 'self', tier } }) }));
vi.mock('../providers/ConversationProvider.chime', () => ({ useConversations: () => ({ createConversation: vi.fn() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: unknown; names?: string }) => (o?.names !== undefined ? `${k}:${o.names}` : (o?.defaultValue as string) ?? k) }),
}));

import NewConversationModal from './NewConversationModal';

const CUSTOM: ClientClassification[] = [
  { value: 'legal', displayName: 'Legal', audience: 'members', badgeToken: 'cls-7', grants: ['legal'], conversational: true, models: { selected: ['haiku', 'sonnet'], default: 'sonnet' } },
  { value: 'finance', displayName: 'Finance', audience: 'members', badgeToken: 'cls-2', grants: ['finance'], conversational: true, models: { selected: ['haiku'], default: 'haiku' } },
  { value: 'client', displayName: 'Client', audience: 'outside', badgeToken: 'cls-5', grants: ['client'], conversational: true, models: { selected: ['haiku'], default: 'haiku' } },
  { value: 'admin', displayName: 'Admin', audience: 'members', badgeToken: 'cls-3', grants: ['admin'], conversational: false, adminPlane: true },
];

const offered = () => [...document.querySelectorAll('.ncm-class-card-badge')].map((b) => b.textContent);

afterEach(() => {
  setClassificationsForTest(null);
  tier = 'legal';
});

describe('the New conversation picker', () => {
  it('offers a custom set by its own names, in its own badge colors', () => {
    setClassificationsForTest(CUSTOM);
    tier = 'legal';
    render(<NewConversationModal isOpen onClose={() => {}} />);
    expect(offered()).toEqual(['Legal']);
    const card = screen.getByText('Legal').closest('.ncm-class-card') as HTMLElement;
    expect(card.style.getPropertyValue('--cls-fg')).toBe('var(--cls-7)');
    // Who may join is read from the declared grants, not from a sentence per sample name.
    expect(card).toHaveTextContent('newConversation.membership:Legal');
    // NO MODEL IS SHOWN for a classification: its model is a default an intent may route past, so a name on
    // the card would say the conversation runs on one model when it may not.
    expect(card).not.toHaveTextContent('Claude Sonnet 4.6');
  });

  it('offers a person only what their own classification grants', () => {
    setClassificationsForTest(CUSTOM);
    render(<NewConversationModal isOpen onClose={() => {}} />);
    expect(offered()).toEqual(['Legal']);
  });

  it('offers the sample deployment its three member classifications, and never an outside one', () => {
    setClassificationsForTest(SAMPLE_CLASSIFICATIONS);
    tier = 'premium';
    render(<NewConversationModal isOpen onClose={() => {}} />);
    expect(offered()).toEqual(['Basic', 'Standard', 'Premium']);
  });

  it('offers nothing to a person whose token names no classification', () => {
    setClassificationsForTest(CUSTOM);
    tier = undefined;
    render(<NewConversationModal isOpen onClose={() => {}} />);
    expect(offered()).toEqual([]);
  });
});
