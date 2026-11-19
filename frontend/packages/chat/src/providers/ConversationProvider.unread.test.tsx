/**
 * THE OPEN CONVERSATION IS READ ONCE THE PERSON IS BACK IN FRONT OF IT. A message that arrives in the conversation on
 * screen while the window is behind another (a meeting window, a second person's window beside it) is an arrival; when the
 * window is focused again the conversation is marked read, here and on the server, so it carries no unread mark once
 * the person opens another conversation or reloads. Driven through the real provider, with the listener it registers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';

const listConversations = vi.fn();
const markConversationRead = vi.fn();
const notifyNewMessage = vi.fn();

const ARN_A = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-a';
const ARN_B = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-b';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';
const OTHER = 'arn:aws:chime:us-east-1:111:app-instance/bot/advisor';

const conv = (id: string, arn: string) => ({
  id, conversationArn: arn, title: id, modelTier: 'premium',
  modelId: 'anthropic.claude-opus', modelName: 'Opus', messages: [], createdAt: new Date().toISOString(),
});
const CONV_A = conv('conv-a', ARN_A);
const CONV_B = conv('conv-b', ARN_B);

vi.mock('../services/chimeService', () => ({
  chimeService: {
    createConversation: vi.fn(),
    getConversation: async (id: string) => (id === 'conv-b' ? CONV_B : CONV_A),
    listConversations: (...a: unknown[]) => listConversations(...a),
    listMessages: () => Promise.resolve([]),
    listChannelMembers: () => Promise.resolve([]),
    markConversationRead: (...a: unknown[]) => markConversationRead(...a),
    getUserArn: () => SELF,
    sendMessage: () => Promise.resolve(),
    shareConversation: () => Promise.resolve({}),
    updateChannelName: () => Promise.resolve(),
  },
}));
vi.mock('../services/notificationService', () => ({
  notificationService: { closeAll: () => {}, notifyNewMessage: (...a: unknown[]) => notifyNewMessage(...a), requestPermission: () => Promise.resolve() },
}));
vi.mock('../services/conversationManagementService', () => ({ archiveConversation: vi.fn(), leaveConversation: vi.fn() }));
const AUTH = { user: { userArn: SELF, isAdmin: false, tier: 'premium' } };
const AWS_CLIENT = { isInitialized: true };
const listener: { current?: { onMessageInAnyChannel?: (arn: string, sender: string) => void } } = {};
const MESSAGING = {
  setChannelListener: () => {},
  setGlobalListener: (l: typeof listener.current) => { if (l) listener.current = l; },
  localTimeOf: (t: number) => t,
};
vi.mock('@ae/shared', () => ({ useAuth: () => AUTH, trackEvent: () => {}, personApiServes: () => false }));
vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('./AwsClientProvider', () => ({ useAwsClient: () => AWS_CLIENT }));
vi.mock('./MessagingProvider', () => ({ useMessaging: () => MESSAGING }));

import { ConversationProvider, useConversations } from './ConversationProvider.chime';

const held: { ctx?: ReturnType<typeof useConversations> } = {};
const ctxOf = () => {
  if (!held.ctx) throw new Error('the probe has not rendered yet');
  return held.ctx;
};
const Probe: React.FC = () => {
  held.ctx = useConversations();
  return null;
};

let focused = true;
beforeEach(() => {
  window.history.replaceState({}, '', '/');
  listConversations.mockReset().mockResolvedValue([CONV_A, CONV_B]);
  markConversationRead.mockReset().mockResolvedValue(undefined);
  focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});
afterEach(() => vi.restoreAllMocks());

const unreadA = () => ctxOf().isConversationUnread(ctxOf().conversations.find((c) => c.id === 'conv-a')!);

describe('the open conversation is read once the person is back in front of it', () => {
  it('a message that arrived while the window was behind another is not unread after the window is focused again', async () => {
    render(<ConversationProvider><Probe /></ConversationProvider>);
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    await act(async () => { await ctxOf().selectConversation('conv-a'); });
    markConversationRead.mockClear();

    // The window is behind a meeting window when the message arrives in the conversation on screen.
    focused = false;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); listener.current?.onMessageInAnyChannel?.(ARN_A, OTHER); });
    expect(markConversationRead).not.toHaveBeenCalled();

    // The person comes back to the window.
    focused = true;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); window.dispatchEvent(new Event('focus')); });
    expect(markConversationRead).toHaveBeenCalledWith(ARN_A);

    // Moving on to another conversation leaves the first one read.
    await act(async () => { await ctxOf().selectConversation('conv-b'); });
    expect(unreadA()).toBe(false);
  });

  it('a conversation the person left with a message still unseen stays unread', async () => {
    render(<ConversationProvider><Probe /></ConversationProvider>);
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    await act(async () => { await ctxOf().selectConversation('conv-b'); });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); listener.current?.onMessageInAnyChannel?.(ARN_A, OTHER); });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(unreadA()).toBe(true);
  });

  it('focusing the window with nothing new marks nothing on the server', async () => {
    render(<ConversationProvider><Probe /></ConversationProvider>);
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    await act(async () => { await ctxOf().selectConversation('conv-a'); });
    markConversationRead.mockClear();
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(markConversationRead).not.toHaveBeenCalled();
  });

});

describe('a conversation is read in every window of the app at once', () => {
  it('clears the unread mark here when another window marks the conversation read', async () => {
    render(<ConversationProvider><Probe /></ConversationProvider>);
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    await act(async () => { await ctxOf().selectConversation('conv-b'); });
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); listener.current?.onMessageInAnyChannel?.(ARN_A, OTHER); });
    expect(unreadA()).toBe(true);
    // The meeting window read it.
    const other = new BroadcastChannel('ae-conversation-read');
    other.postMessage({ channelArn: ARN_A });
    other.close();
    await waitFor(() => expect(unreadA()).toBe(false));
  });

  it('a meeting window notifies nothing; the app beside it does', async () => {
    sessionStorage.setItem('ae.meeting.window', 'meet-1');
    try {
      notifyNewMessage.mockClear();
      render(<ConversationProvider><Probe /></ConversationProvider>);
      await waitFor(() => expect(listConversations).toHaveBeenCalled());
      focused = false;
      await act(async () => { listener.current?.onMessageInAnyChannel?.(ARN_A, OTHER); });
      expect(notifyNewMessage).not.toHaveBeenCalled();
    } finally {
      sessionStorage.removeItem('ae.meeting.window');
    }
  });
});
