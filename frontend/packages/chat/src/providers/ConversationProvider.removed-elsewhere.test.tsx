/**
 * A CONVERSATION DELETED ELSEWHERE, OR ONE THE VIEWER WAS REMOVED FROM, LEAVES THE CLIENT AT ONCE.
 *
 * Deleted from another client, the console or a demo reset, it stayed listed and open until a reload. The
 * messaging provider now reports it (`onRemovedFromChannel`), and the conversation provider drops it from the
 * list and closes it when it is the one open. Driven through the real provider, with the listener it registers.
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
const listener: { current?: { onRemovedFromChannel?: (arn: string) => void } } = {};
const MESSAGING = { setChannelListener: () => {}, setGlobalListener: (l: typeof listener.current) => { if (l) listener.current = l; } };
// Full replacement: the real @ae/shared barrel reaches AWS SDK modules that never settle under jsdom.
vi.mock('@ae/shared', () => ({ useAuth: () => AUTH, trackEvent: () => {}, personApiServes: () => false }));
vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('./AwsClientProvider', () => ({ useAwsClient: () => AWS_CLIENT }));
vi.mock('./MessagingProvider', () => ({ useMessaging: () => MESSAGING }));

import { ConversationProvider, useConversations } from './ConversationProvider.chime';

/** A mutable holder rather than a module-scope `let` the probe reassigns (`react-hooks/globals`). */
const held: { ctx?: ReturnType<typeof useConversations> } = {};
const ctxOf = () => {
  if (!held.ctx) throw new Error('the probe has not rendered yet');
  return held.ctx;
};
const AppLike: React.FC = () => {
  const value = useConversations();
  held.ctx = value;
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

describe('a conversation that is gone leaves the client', () => {
  const list = () => ctxOf().conversations.map((c) => c.id);

  it('closes the open conversation and drops it from the list when it is deleted', async () => {
    listConversations.mockResolvedValue([CONV_A, CONV_B]);
    await mount();
    await act(async () => { await ctxOf().selectConversation('conv-a'); });
    expect(open()).toBe('conv-a');

    await act(async () => { listener.current?.onRemovedFromChannel?.(ARN_A); });
    expect(open()).toBe('NONE');
    expect(list()).toEqual(['conv-b']);
    expect(urlNames()).toBeNull();
  });

  it('drops a deleted conversation that is not open, and leaves the open one alone', async () => {
    listConversations.mockResolvedValue([CONV_A, CONV_B]);
    await mount();
    await act(async () => { await ctxOf().selectConversation('conv-a'); });

    await act(async () => { listener.current?.onRemovedFromChannel?.(ARN_B); });
    expect(open()).toBe('conv-a');
    expect(list()).toEqual(['conv-a']);
  });
});
