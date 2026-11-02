/**
 * ConversationProvider - a message posted while the live session was not connected is not lost.
 *
 * THE DEFECT THIS EXISTS FOR. Live messages arrive only over the messaging session,
 * and nothing re-read the conversation when that session started or restarted. Measured live
 * 2026-10-05: on a slow page the session endpoint returned 5 s after the conversation opened, the
 * person sent `/battle` before the socket was up, and the assistant's targeted reply landed in that
 * gap - delivered, readable in history, and never shown until the conversation was reopened.
 *
 * These drive the real provider: open a conversation, let history change while "disconnected", then
 * flip the session to connected and assert the page catches up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

const listMessages = vi.fn();
const listChannelMembers = vi.fn();
const getConversation = vi.fn();
const listConversations = vi.fn();

const ARN_A = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-a';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/b';
const CONV_A = {
  id: 'conv-a', conversationArn: ARN_A, title: 'A', modelTier: 'premium',
  modelId: 'anthropic.claude-opus', modelName: 'Opus', messages: [], createdAt: new Date().toISOString(),
};

const msg = (id: string, content: string, at: string, isBot = true) => ({
  id, content, timestamp: at, isBot,
  sender: { arn: isBot ? BOT : SELF, name: isBot ? 'Advisor' : 'Me' },
});

vi.mock('../services/chimeService', () => ({
  chimeService: {
    createConversation: vi.fn(),
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

const AUTH = { user: { userArn: SELF, isAdmin: false, tier: 'premium' } };
const AWS_CLIENT = { isInitialized: true };
// MUTABLE, so a re-render sees the session start - the provider reads `sessionVersion` from this hook.
const MESSAGING = { setChannelListener: () => {}, setGlobalListener: () => {}, sessionVersion: 0 };
// No person API in this harness: the open-work and turn-state reads stay unconfigured, as they do unset.
vi.mock('@ae/shared', () => ({ useAuth: () => AUTH, trackEvent: () => {}, personApiServes: () => false }));
vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('./AwsClientProvider', () => ({ useAwsClient: () => AWS_CLIENT }));
vi.mock('./MessagingProvider', () => ({ useMessaging: () => ({ ...MESSAGING }) }));

import { ConversationProvider, useConversations } from './ConversationProvider.chime';

const held: { ctx?: ReturnType<typeof useConversations> } = {};
const Probe: React.FC = () => {
  const value = useConversations();
  held.ctx = value;
  return <div data-testid="msgs">{value.messages.map((m) => m.content).join(' | ')}</div>;
};
const shown = () => screen.getByTestId('msgs').textContent ?? '';

async function mountWithConversationOpen() {
  const view = render(<ConversationProvider><Probe /></ConversationProvider>);
  await waitFor(() => expect(listConversations).toHaveBeenCalled());
  await act(async () => { await held.ctx!.selectConversation('conv-a'); });
  return view;
}
async function connect(view: ReturnType<typeof render>) {
  MESSAGING.sessionVersion += 1;
  await act(async () => { view.rerender(<ConversationProvider><Probe /></ConversationProvider>); });
}

beforeEach(() => {
  MESSAGING.sessionVersion = 0;
  listMessages.mockReset();
  listChannelMembers.mockReset().mockResolvedValue([]);
  getConversation.mockReset().mockResolvedValue(CONV_A);
  listConversations.mockReset().mockResolvedValue([CONV_A]);
});

describe('ConversationProvider - catch-up when a messaging session starts', () => {
  it('shows a reply that was posted before the session was up', async () => {
    listMessages.mockResolvedValueOnce([msg('w', 'Welcome', '2026-10-06T00:25:51Z')]);
    const view = await mountWithConversationOpen();
    expect(shown()).toBe('Welcome');

    // The hint lands while disconnected: history has it, the page does not.
    listMessages.mockResolvedValueOnce([
      msg('w', 'Welcome', '2026-10-06T00:25:51Z'),
      msg('u', '/battle Why do we lose deals?', '2026-10-06T00:25:59Z', false),
      msg('h', "Battle Mode isn't enabled on this channel.", '2026-10-06T00:26:00Z'),
    ]);
    await connect(view);

    await waitFor(() => expect(shown()).toContain("Battle Mode isn't enabled"));
    expect(shown()).toBe("Welcome | /battle Why do we lose deals? | Battle Mode isn't enabled on this channel.");
  });

  it('applies an answer whose UPDATE was missed, replacing the placeholder text', async () => {
    listMessages.mockResolvedValueOnce([msg('p', 'One moment...', '2026-10-06T00:26:00Z')]);
    const view = await mountWithConversationOpen();
    expect(shown()).toBe('One moment...');

    listMessages.mockResolvedValueOnce([msg('p', 'Net revenue retention is 112%.', '2026-10-06T00:26:00Z')]);
    await connect(view);

    await waitFor(() => expect(shown()).toBe('Net revenue retention is 112%.'));
  });

  it('reads history once per connect, not on every render', async () => {
    listMessages.mockResolvedValue([msg('w', 'Welcome', '2026-10-06T00:25:51Z')]);
    const view = await mountWithConversationOpen();
    const before = listMessages.mock.calls.length;
    await connect(view);
    await waitFor(() => expect(listMessages.mock.calls.length).toBe(before + 1));
    await act(async () => { view.rerender(<ConversationProvider><Probe /></ConversationProvider>); });
    expect(listMessages.mock.calls.length).toBe(before + 1);
  });

  it('re-fetches the sidebar on a RECONNECT, not on the first start', async () => {
    listMessages.mockResolvedValue([msg('w', 'Welcome', '2026-10-06T00:25:51Z')]);
    const view = await mountWithConversationOpen();
    const initialLoads = listConversations.mock.calls.length;
    await connect(view); // first start
    await waitFor(() => expect(listMessages).toHaveBeenCalled());
    expect(listConversations.mock.calls.length).toBe(initialLoads);
    await connect(view); // a reconnect
    await waitFor(() => expect(listConversations.mock.calls.length).toBe(initialLoads + 1));
  });
});
