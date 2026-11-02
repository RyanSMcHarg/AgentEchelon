/**
 * A CONVERSATION SHOWS ITS AUDIENCE AND ITS CLASSIFICATION FROM THE CLASSIFICATION'S DEFINITION.
 *
 *  - The header's badge reads the classification's declared display name, in the color its `badgeToken`
 *    names, so a custom set (`legal`, `client`) renders its own names and colors and no sample name is
 *    involved.
 *  - An outside-audience conversation carries the header treatment and the label "Visible to the
 *    customer", and the composer's placeholder says the same, so a person with an inside and an outside
 *    conversation open sees which one they are typing into. An inside one says it is internal.
 *  - Every string comes from the locale: rendered in a second locale, none of it is English.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '@ae/shared/locales/en.json';
import { setClassificationsForTest, type ClientClassification } from '@ae/shared/config/classifications.ts';
import { AudienceLabel, ClassificationBadge, headerAudienceClass } from './ConversationClassification';

const CUSTOM: ClientClassification[] = [
  { value: 'legal', displayName: 'Legal', audience: 'members', badgeToken: 'cls-7', grants: ['legal'], conversational: true, models: { selected: ['haiku', 'sonnet'], default: 'sonnet' } },
  { value: 'client', displayName: 'Client room', audience: 'outside', badgeToken: 'cls-5', grants: ['client'], conversational: true, models: { selected: ['haiku'], default: 'haiku' } },
];

const ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/channel/c1';
const SELF = 'arn:aws:chime:us-east-1:111122223333:app-instance/i/user/self';
let active: { conversationArn: string; modelTier: string } = { conversationArn: ARN, modelTier: 'legal' };

vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => ({
    activeConversation: active,
    sendMessage: vi.fn(),
    isSending: false,
    sendError: null,
    clearSendError: () => {},
    channelMembers: [{ userArn: SELF, name: 'Me', isBot: false }],
    stickyTarget: null,
    setStickyTarget: () => {},
    battleWaitingBots: [],
    openWorkItems: [],
    refreshOpenWorkItems: () => {},
  }),
}));
vi.mock('../providers/AwsClientProvider', () => ({
  useAwsClient: () => ({ userArn: SELF, isInitialized: true, error: null }),
}));
// Full replacement: the real barrel reaches AWS SDK modules that never settle under jsdom.
vi.mock('@ae/shared', () => ({
  useAuth: () => ({ user: { id: 'self', isAdmin: false } }),
  trackEvent: () => {},
}));
vi.mock('../services/attachmentService', () => ({ uploadFile: vi.fn() }));
vi.mock('../services/messageLatencyTracker', () => ({ markMessageSent: () => {} }));

import MessageInput from './MessageInput';

/** A test locale with every key, marked so English cannot pass for it. */
const marked = JSON.parse(JSON.stringify(en), (_k, v) => (typeof v === 'string' ? `[xx] ${v}` : v));

function withLocale(ui: React.ReactNode, lng: 'en' | 'xx' = 'en') {
  const i18n = i18next.createInstance();
  void i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, xx: { translation: marked } },
    lng, fallbackLng: 'en', interpolation: { escapeValue: false }, initAsync: false,
  });
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

afterEach(() => {
  setClassificationsForTest(null);
  active = { conversationArn: ARN, modelTier: 'legal' };
});

describe('the header badge', () => {
  it('names a custom classification by its declared display name, in its declared badge color', () => {
    setClassificationsForTest(CUSTOM);
    withLocale(<><ClassificationBadge value="legal" /><ClassificationBadge value="client" /></>);
    const legal = screen.getByText('Legal').closest('[data-classification]') as HTMLElement;
    const client = screen.getByText('Client room').closest('[data-classification]') as HTMLElement;
    expect(legal.style.getPropertyValue('--cls-fg')).toBe('var(--cls-7)');
    expect(legal.style.getPropertyValue('--cls-bg')).toBe('var(--cls-7-bg)');
    expect(client.style.getPropertyValue('--cls-fg')).toBe('var(--cls-5)');
    expect(legal).toHaveAccessibleName('Classification: Legal');
  });

  it('is neutral, and shows the value, for a classification the deployment does not declare', () => {
    setClassificationsForTest(CUSTOM);
    withLocale(<ClassificationBadge value="premium" />);
    const badge = screen.getByText('premium').closest('[data-classification]') as HTMLElement;
    expect(badge.style.getPropertyValue('--cls-fg')).toBe('var(--text-tertiary)');
  });
});

describe('the audience', () => {
  it('marks an outside conversation, and says it is visible to the customer', () => {
    setClassificationsForTest(CUSTOM);
    withLocale(<AudienceLabel value="client" />);
    expect(screen.getByText('Visible to the customer')).toHaveAttribute('data-audience', 'outside');
    expect(headerAudienceClass('client')).toBe(' conversation-header--outside');
  });

  it('says an inside conversation is internal, with no outside treatment', () => {
    setClassificationsForTest(CUSTOM);
    withLocale(<AudienceLabel value="legal" />);
    expect(screen.getByText('Internal')).toHaveAttribute('data-audience', 'members');
    expect(headerAudienceClass('legal')).toBe('');
  });

  it('renders in a second locale from that locale\'s strings', () => {
    setClassificationsForTest(CUSTOM);
    withLocale(<><AudienceLabel value="client" /><ClassificationBadge value="legal" /></>, 'xx');
    expect(screen.getByText('[xx] Visible to the customer')).toBeInTheDocument();
    expect(screen.getByText('Legal').closest('[data-classification]')).toHaveAccessibleName('[xx] Classification: Legal');
  });
});

describe('the composer', () => {
  const placeholder = () => (document.querySelector('.message-textarea') as HTMLTextAreaElement).placeholder;

  it('says an outside conversation is visible to the customer, where the person types', () => {
    setClassificationsForTest(CUSTOM);
    active = { conversationArn: ARN, modelTier: 'client' };
    withLocale(<MessageInput />);
    expect(placeholder()).toBe('Visible to the customer');
  });

  it('keeps the ordinary placeholder in an inside conversation', () => {
    setClassificationsForTest(CUSTOM);
    withLocale(<MessageInput />);
    expect(placeholder()).toBe(en.conversation.placeholder);
  });

  it('says it in a second locale', () => {
    setClassificationsForTest(CUSTOM);
    active = { conversationArn: ARN, modelTier: 'client' };
    withLocale(<MessageInput />, 'xx');
    expect(placeholder()).toBe('[xx] Visible to the customer');
  });
});
