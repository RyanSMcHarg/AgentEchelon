/**
 * A CONVERSATION ARCHIVED WHILE IT IS OPEN TURNS READ-ONLY IN FRONT OF THE PERSON (SPEC-ASSISTANT-MEETINGS FR71).
 *
 * The archive writes the `archived` display mirror into the channel's Metadata, which the channel update event carries.
 * The provider applies it to the listed and the open conversation, so the composer, which follows `archived`, goes
 * read-only the moment a meeting's own conversation is archived on its end. Driven through the real provider, with the
 * channel listener it registers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';

const ARN_A = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/meet-a';
const ARN_B = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/room-b';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';

const conv = (id: string, arn: string, title: string) => ({
  id, conversationArn: arn, title, modelTier: 'premium',
  modelId: 'anthropic.claude-opus', modelName: 'Opus', messages: [], createdAt: new Date().toISOString(),
});
const CONV_A = conv('meet-a', ARN_A, 'Meeting Room');
const CONV_B = conv('room-b', ARN_B, 'Report Latency');

const listConversations = vi.fn();
vi.mock('../services/chimeService', () => ({
  chimeService: {
    createConversation: () => Promise.resolve(CONV_A),
    getConversation: (id: string) => Promise.resolve(id === 'room-b' ? CONV_B : CONV_A),
    listConversations: (...a: unknown[]) => listConversations(...a),
    listMessages: () => Promise.resolve([]),
    listChannelMembers: () => Promise.resolve([]),
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
type ChannelListener = { onChannelUpdate?: (arn: string, name: string, metadata?: string) => void };
const listener: { current?: ChannelListener } = {};
const MESSAGING = { setChannelListener: (l: ChannelListener | null) => { if (l) listener.current = l; }, setGlobalListener: () => {} };
// Full replacement: the real @ae/shared barrel reaches AWS SDK modules that never settle under jsdom.
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

beforeEach(() => {
  listConversations.mockReset().mockResolvedValue([CONV_A, CONV_B]);
});

describe('a conversation archived while it is open', () => {
  it('turns the open conversation and its list entry read-only from the channel update', async () => {
    render(<ConversationProvider><Probe /></ConversationProvider>);
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    await act(async () => { await ctxOf().selectConversation('meet-a'); });
    expect(ctxOf().activeConversation?.archived).toBeFalsy();

    await act(async () => {
      listener.current?.onChannelUpdate?.(ARN_A, 'Meeting Room', JSON.stringify({ meetingOf: 'room-b', archived: true }));
    });
    expect(ctxOf().activeConversation?.archived).toBe(true);
    expect(ctxOf().conversations.find((c) => c.id === 'meet-a')?.archived).toBe(true);
    expect(ctxOf().conversations.find((c) => c.id === 'room-b')?.archived).toBeFalsy();
  });

  it('leaves a renamed conversation as it was when the update carries no archive mirror', async () => {
    render(<ConversationProvider><Probe /></ConversationProvider>);
    await waitFor(() => expect(listConversations).toHaveBeenCalled());
    await act(async () => { await ctxOf().selectConversation('meet-a'); });

    await act(async () => { listener.current?.onChannelUpdate?.(ARN_A, 'Renamed', JSON.stringify({ meetingOf: 'room-b' })); });
    expect(ctxOf().activeConversation?.title).toBe('Renamed');
    expect(ctxOf().activeConversation?.archived).toBeFalsy();
    await act(async () => { listener.current?.onChannelUpdate?.(ARN_A, 'Renamed again', 'not json'); });
    expect(ctxOf().activeConversation?.title).toBe('Renamed again');
    expect(ctxOf().activeConversation?.archived).toBeFalsy();
  });
});
