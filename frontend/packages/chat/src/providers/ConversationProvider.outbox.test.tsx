/**
 * ConversationProvider - a message sent offline, or whose send was never answered, is kept on this device and sent once
 * when the person can be heard again (the browser's `online`, or a messaging session starting). A send the service
 * refused is reported and kept nowhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';

const sendMessage = vi.fn();
const sentByClientId = vi.fn();
const listMessages = vi.fn();

const ARN_A = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-a';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';
const CONV_A = {
  id: 'conv-a', conversationArn: ARN_A, title: 'A', modelTier: 'premium',
  modelId: 'anthropic.claude-opus', modelName: 'Opus', messages: [], createdAt: new Date().toISOString(),
};

vi.mock('../services/chimeService', () => ({
  chimeService: {
    createConversation: vi.fn(),
    getConversation: () => Promise.resolve(CONV_A),
    listConversations: () => Promise.resolve([CONV_A]),
    listMessages: (...a: unknown[]) => listMessages(...a),
    listChannelMembers: () => Promise.resolve([]),
    markConversationRead: () => Promise.resolve(),
    getUserArn: () => SELF,
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    sentByClientId: (...a: unknown[]) => sentByClientId(...a),
    shareConversation: () => Promise.resolve({}),
    updateChannelName: () => Promise.resolve(),
  },
}));
vi.mock('../services/notificationService', () => ({
  notificationService: { closeAll: () => {}, notifyNewMessage: () => {}, requestPermission: () => Promise.resolve() },
}));
vi.mock('../services/conversationManagementService', () => ({ archiveConversation: vi.fn(), leaveConversation: vi.fn() }));

const AUTH = { user: { userArn: SELF, isAdmin: false, tier: 'premium' } };
const AWS_CLIENT = { isInitialized: true, userArn: SELF };
const MESSAGING = { setChannelListener: () => {}, setGlobalListener: () => {}, sessionVersion: 0 };
vi.mock('@ae/shared', () => ({ useAuth: () => AUTH, trackEvent: () => {}, personApiServes: () => false }));
vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));
vi.mock('./AwsClientProvider', () => ({ useAwsClient: () => AWS_CLIENT }));
vi.mock('./MessagingProvider', () => ({ useMessaging: () => ({ ...MESSAGING }) }));

import { ConversationProvider, OUTBOX_RETRY_DELAYS_MS, useConversations } from './ConversationProvider.chime';

const held: { ctx?: ReturnType<typeof useConversations> } = {};
const Probe: React.FC = () => {
  held.ctx = useConversations();
  return <div data-testid="msgs">{held.ctx.messages.map((m) => m.content).join(' | ')}</div>;
};

async function mountWithConversationOpen() {
  const view = render(<ConversationProvider><Probe /></ConversationProvider>);
  await act(async () => { await held.ctx!.selectConversation('conv-a'); });
  return view;
}

const sent = (id: string, content: string) => ({
  id, content, timestamp: new Date(), isBot: false, sender: { arn: SELF, name: 'You' }, status: 'sent',
});

let online: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  MESSAGING.sessionVersion = 0;
  sendMessage.mockReset();
  sentByClientId.mockReset().mockResolvedValue(false);
  listMessages.mockReset().mockResolvedValue([]);
  online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConversationProvider - the outbox', () => {
  it('offline: the message is queued and not sent; back online it is sent once, with its client id', async () => {
    await mountWithConversationOpen();
    online.mockReturnValue(false);
    let outcome: unknown;
    await act(async () => { outcome = await held.ctx!.sendMessage('when you can'); });
    expect(outcome).toEqual({ queued: true });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(held.ctx!.queuedMessages.map((q) => q.content)).toEqual(['when you can']);

    sendMessage.mockResolvedValue(sent('m1', 'when you can'));
    online.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(held.ctx!.queuedMessages).toEqual([]));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [channel, content, , options] = sendMessage.mock.calls[0];
    expect(channel).toBe(ARN_A);
    expect(content).toBe('when you can');
    expect(typeof options.clientMessageId).toBe('string');
    expect(held.ctx!.messages.map((m) => m.content)).toEqual(['when you can']);

    // Another `online` finds nothing left to send.
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a send never answered is kept; when a session starts it is found already sent and not posted again', async () => {
    const view = await mountWithConversationOpen();
    sendMessage.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    let outcome: unknown;
    await act(async () => { outcome = await held.ctx!.sendMessage('did this go?'); });
    expect(outcome).toEqual({ queued: true });
    expect(held.ctx!.queuedMessages).toHaveLength(1);
    const clientId = sendMessage.mock.calls[0][3].clientMessageId;

    sentByClientId.mockResolvedValue(true);
    MESSAGING.sessionVersion += 1;
    await act(async () => { view.rerender(<ConversationProvider><Probe /></ConversationProvider>); });
    await waitFor(() => expect(held.ctx!.queuedMessages).toEqual([]));
    expect(sentByClientId).toHaveBeenCalledWith(ARN_A, clientId);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a send never answered and not found is sent again with the same client id', async () => {
    const view = await mountWithConversationOpen();
    sendMessage.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await act(async () => { await held.ctx!.sendMessage('try again'); });
    const clientId = sendMessage.mock.calls[0][3].clientMessageId;

    sendMessage.mockResolvedValue(sent('m2', 'try again'));
    MESSAGING.sessionVersion += 1;
    await act(async () => { view.rerender(<ConversationProvider><Probe /></ConversationProvider>); });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls[1][3].clientMessageId).toBe(clientId);
    await waitFor(() => expect(held.ctx!.queuedMessages).toEqual([]));
  });

  it('a send the service refused is reported and kept nowhere', async () => {
    await mountWithConversationOpen();
    sendMessage.mockRejectedValueOnce(Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } }));
    await act(async () => {
      await expect(held.ctx!.sendMessage('not allowed')).rejects.toThrow('AccessDenied');
    });
    expect(held.ctx!.sendError).toBe('AccessDenied');
    expect(held.ctx!.queuedMessages).toEqual([]);
    expect(localStorage.getItem('ae.composer.v1.outbox.self')).toBeNull();
  });

  it('a confirmed send leaves nothing in the outbox', async () => {
    await mountWithConversationOpen();
    sendMessage.mockResolvedValue(sent('m3', 'hello'));
    let outcome: unknown;
    await act(async () => { outcome = await held.ctx!.sendMessage('hello'); });
    expect(outcome).toEqual({ queued: false });
    expect(localStorage.getItem('ae.composer.v1.outbox.self')).toBeNull();
  });

  it('a send into a conversation no longer open goes there and is not shown in the one open now', async () => {
    await mountWithConversationOpen();
    const ARN_B = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-b';
    sendMessage.mockResolvedValue(sent('mb', 'for b'));
    await act(async () => { await held.ctx!.sendMessage('for b', undefined, undefined, { id: 'conv-b', conversationArn: ARN_B }); });
    expect(sendMessage.mock.calls[0][0]).toBe(ARN_B);
    expect(held.ctx!.messages).toEqual([]);
  });

  it('online, a send met by a server error is sent again after a short wait, with no reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await mountWithConversationOpen();
      sendMessage.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { $metadata: { httpStatusCode: 503 } }));
      let outcome: unknown;
      await act(async () => { outcome = await held.ctx!.sendMessage('try later'); });
      expect(outcome).toEqual({ queued: true });
      sendMessage.mockResolvedValue(sent('m9', 'try later'));
      await act(async () => { await vi.advanceTimersByTimeAsync(OUTBOX_RETRY_DELAYS_MS[0] + 10); });
      await waitFor(() => expect(held.ctx!.queuedMessages).toEqual([]));
      expect(sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offline with storage refused: the message is not said to be waiting, and the person is told', async () => {
    await mountWithConversationOpen();
    online.mockReturnValue(false);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await act(async () => {
      await expect(held.ctx!.sendMessage('nowhere to keep')).rejects.toThrow('conversation.notKeptToSend');
    });
    expect(held.ctx!.sendError).toBe('conversation.notKeptToSend');
    expect(held.ctx!.queuedMessages).toEqual([]);
  });

  it('a message sent while an earlier one of its conversation waits goes after it, in order', async () => {
    await mountWithConversationOpen();
    sendMessage.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await act(async () => { await held.ctx!.sendMessage('first'); });
    sendMessage.mockReset().mockImplementation(async (_arn: string, content: string) => sent(`id-${content}`, content));
    let outcome: unknown;
    await act(async () => { outcome = await held.ctx!.sendMessage('second'); });
    expect(outcome).toEqual({ queued: true });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
