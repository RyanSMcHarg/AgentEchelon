/**
 * A CONVERSATION THE PERSON CREATES IS THE ONE THAT STAYS OPEN.
 *
 * Opening a conversation writes its id into the URL (`?conversation=<id>`), and the app opens the
 * conversation a link names. Creating one changes the conversation list, which rebuilds
 * `selectConversation`; a link reader that ran again on that change read the URL, which still named the
 * conversation open before, and reopened it. So the person was sent back to where they were.
 *
 * Driven through the real provider and the real link hook, in the order the app runs them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

const createConversationSvc = vi.fn();
const listMessages = vi.fn();
const listChannelMembers = vi.fn();
const getConversation = vi.fn();
const listConversations = vi.fn();

const ARN_A = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-a';
const ARN_B = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-b';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';

const conv = (id: string, arn: string) => ({
  id, conversationArn: arn, title: id, modelTier: 'premium',
  modelId: 'anthropic.claude-opus', modelName: 'Opus', messages: [], createdAt: new Date().toISOString(),
});
const CONV_A = conv('conv-a', ARN_A);
const CONV_B = conv('conv-b', ARN_B);

vi.mock('../services/chimeService', () => ({
  chimeService: {
    createConversation: (...a: unknown[]) => createConversationSvc(...a),
    getConversation: (...a: unknown[]) => getConversation(...a),
    listConversations: (...a: unknown[]) => listConversations(...a),
    listMessages: (...a: unknown[]) => listMessages(...a),
    listChannelMembers: (...a: unknown[]) => listChannelMembers(...a),
    markConversationRead: () => Promise.resolve(),
    getUserArn: () => SELF,
    sendMessage: () => Promise.resolve(),
    shareConversation: () => Promise.resolve({}),
    updateChannelName: () => Promise.resolve(),
  },
}));
vi.mock('../services/notificationService', () => ({
  notificationService: { closeAll: () => {}, notifyNewMessage: () => {}, requestPermission: () => Promise.resolve() },
}));
vi.mock('../services/conversationManagementService', () => ({ archiveConversation: vi.fn(), leaveConversation: vi.fn() }));
// Stable references: the provider's effects depend on these, and a fresh object per render re-runs them forever.
const AUTH = { user: { userArn: SELF, isAdmin: false, tier: 'premium' } };
const AWS_CLIENT = { isInitialized: true };
const MESSAGING = { setChannelListener: () => {}, setGlobalListener: () => {} };
// Full replacement: the real @ae/shared barrel reaches AWS SDK modules that never settle under jsdom.
vi.mock('@ae/shared', () => ({ useAuth: () => AUTH, trackEvent: () => {}, personApiServes: () => false }));
vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('./AwsClientProvider', () => ({ useAwsClient: () => AWS_CLIENT }));
vi.mock('./MessagingProvider', () => ({ useMessaging: () => MESSAGING }));

import { ConversationProvider, useConversations } from './ConversationProvider.chime';
import { useConversationDeepLink } from '../hooks/useConversationDeepLink';

/** A mutable holder rather than a module-scope `let` the probe reassigns (`react-hooks/globals`). */
const held: { ctx?: ReturnType<typeof useConversations> } = {};
const ctxOf = () => {
  if (!held.ctx) throw new Error('the probe has not rendered yet');
  return held.ctx;
};
/** What App does: the provider's context, and the link hook reading the URL once the person is ready. */
const AppLike: React.FC = () => {
  const value = useConversations();
  held.ctx = value;
  useConversationDeepLink(true, value.selectConversation);
  return <div data-testid="open">{value.activeConversation?.id ?? 'NONE'}</div>;
};
const open = () => screen.getByTestId('open').textContent;
const urlNames = () => new URLSearchParams(window.location.search).get('conversation');

async function mount() {
  render(<ConversationProvider><AppLike /></ConversationProvider>);
  await waitFor(() => expect(listConversations).toHaveBeenCalled());
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  createConversationSvc.mockReset().mockResolvedValue(CONV_B);
  listMessages.mockReset().mockResolvedValue([]);
  listChannelMembers.mockReset().mockResolvedValue([]);
  getConversation.mockReset().mockImplementation(async (id: string) => (id === 'conv-b' ? CONV_B : CONV_A));
  listConversations.mockReset().mockResolvedValue([CONV_A]);
});

describe('creating a conversation opens it, and it stays open', () => {
  it('stays on the new conversation after one was opened from the list', async () => {
    await mount();
    // The person opens A from the sidebar, which writes A into the URL.
    await act(async () => { await ctxOf().selectConversation('conv-a'); });
    expect(open()).toBe('conv-a');
    expect(urlNames()).toBe('conv-a');

    // Then creates B. The list changes, which rebuilds selectConversation.
    await act(async () => { await ctxOf().createConversation(undefined, 'anthropic.claude-opus', 'Opus', 'premium'); });

    await waitFor(() => expect(open()).toBe('conv-b'));
    // Nothing reopens A afterwards, and the URL names the conversation that is open.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(open()).toBe('conv-b');
    expect(urlNames()).toBe('conv-b');
  });

  it('still opens the conversation a link names when the app loads', async () => {
    window.history.replaceState({}, '', '/?conversation=conv-a');
    await mount();
    await waitFor(() => expect(open()).toBe('conv-a'));
  });
});
