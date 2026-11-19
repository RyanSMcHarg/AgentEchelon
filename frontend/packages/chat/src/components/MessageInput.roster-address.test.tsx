/**
 * MessageInput - a member addressed from elsewhere in the window (the meeting roster, `utils/composerRequests.ts`) is written
 * with the picker's own tokens: shown by name in the field, sent as `@<Name|id>` in public or `.<Name|id>` to that member alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { requestComposerAddress } from '../utils/composerRequests';

const sendMessage = vi.fn();

const INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/i';
const CHANNEL = `${INSTANCE}/channel/c1`;
const SELF = `${INSTANCE}/user/self-id`;
const ALICE_ID = 'alice-id';
const ALICE = `${INSTANCE}/user/${ALICE_ID}`;
const RYAN = `${INSTANCE}/user/ryan-id`;
const BOT = `${INSTANCE}/bot/advisor`;

const MEMBERS = [
  { userArn: BOT, name: 'Advisor', isBot: true },
  { userArn: ALICE, name: 'Alice', isBot: false },
  { userArn: RYAN, name: 'Ryan McHarg', isBot: false },
  { userArn: SELF, name: 'Me', isBot: false },
];

vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => ({
    activeConversation: { id: 'c1', conversationArn: CHANNEL, modelTier: 'premium' },
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    isSending: false,
    sendError: null,
    clearSendError: () => {},
    channelMembers: MEMBERS,
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
vi.mock('@ae/shared', () => ({
  useAuth: () => ({ user: { id: 'self-id', userArn: SELF, email: 'me@example.com', isAdmin: false } }),
  trackEvent: () => {},
}));
vi.mock('../services/attachmentService', () => ({ uploadFile: vi.fn() }));
vi.mock('../services/messageLatencyTracker', () => ({ markMessageSent: () => {} }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));

import MessageInput from './MessageInput';

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue(undefined);
});

const textarea = () => document.querySelector('.message-textarea') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });
const key = (k: string) => fireEvent.keyDown(textarea(), { key: k, code: k });

describe('a member addressed from the roster', () => {
  it("a mention goes in at the caret, shown by name and sent with the member's id", async () => {
    render(<MessageInput />);
    type('ping');
    textarea().setSelectionRange(4, 4);
    act(() => { requestComposerAddress({ member: MEMBERS[1], mode: 'mention' }); });
    expect(textarea().value).toBe('ping @Alice ');
    key('Enter');
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toBe(`ping @<Alice|${ALICE_ID}>`);
  });

  it('Message privately addresses the member at the front of the draft, replacing any private address there', async () => {
    render(<MessageInput />);
    type('the numbers');
    act(() => { requestComposerAddress({ member: MEMBERS[2], mode: 'private' }); });
    act(() => { requestComposerAddress({ member: MEMBERS[1], mode: 'private' }); });
    expect(textarea().value).toBe('.Alice the numbers');
    key('Enter');
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toContain(`.<Alice|${ALICE_ID}>`);
    expect(sendMessage.mock.calls[0][0]).not.toContain('Ryan');
  });
});
