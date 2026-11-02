/**
 * MessageInput - the sender is never offered as a mention, and never mentioned.
 *
 * The sender is the ARN the messaging client acts as: the person's AppInstanceUser, which the
 * credential exchange mints and which is NOT the ID token's `sub`. The composer read it from
 * `useAuth().user.userArn`, a field nothing ever set, so the comparison ran against '' and the sender
 * stayed in their own mention list. These tests give the person an id that differs from their token
 * subject and read the sender from `useAwsClient()`, which is where the composer takes it from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const sendMessage = vi.fn();

const INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/i';
const CHANNEL = `${INSTANCE}/channel/c1`;
// The token subject the person signed in with. It names nobody in the app instance.
const TOKEN_SUB = '9f1c2e4a-0000-4000-8000-00000000c0de';
// The person, as the exchange minted them: a UUID v7, unrelated to the subject.
const SELF_ID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const SELF = `${INSTANCE}/user/${SELF_ID}`;
const ALICE = `${INSTANCE}/user/0192f3a4-0000-7000-8000-0000000a11ce`;
const BOT = `${INSTANCE}/bot/assistant-premium`;

const MEMBERS = [
  { userArn: BOT, name: 'Assistant-premium', isBot: true },
  { userArn: ALICE, name: 'Alice', isBot: false },
  { userArn: SELF, name: 'Me', isBot: false },
];

vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => ({
    activeConversation: { conversationArn: CHANNEL, modelTier: 'premium' },
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
// The signed-in user carries the exchange's id and ARN. Nothing here is the token subject, and the
// composer must not need it to be.
vi.mock('@ae/shared', () => ({
  useAuth: () => ({ user: { id: SELF_ID, userArn: SELF, email: 'me@example.com', isAdmin: false } }),
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
const enter = () => fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });
const optionNames = () =>
  Array.from(document.querySelectorAll('.mention-option-name')).map((n) => n.textContent);

describe('MessageInput - the sender is excluded by the exchange ARN', () => {
  it('the fixture person is not their token subject', () => {
    expect(SELF).not.toContain(TOKEN_SUB);
  });

  it('does not offer the sender in the @ picker', async () => {
    render(<MessageInput />);
    type('@');
    await waitFor(() => expect(optionNames().length).toBeGreaterThan(0));
    expect(optionNames()).toContain('@Alice');
    expect(optionNames()).toContain('@Assistant-premium');
    expect(optionNames()).not.toContain('@Me');
  });

  it('does not offer the sender in the private picker', async () => {
    render(<MessageInput />);
    type('.');
    await waitFor(() => expect(optionNames().length).toBeGreaterThan(0));
    expect(optionNames()).toContain('.Alice');
    expect(optionNames()).not.toContain('.Me');
  });

  it('never targets the sender when they type their own name', async () => {
    render(<MessageInput />);
    type('@Me hello');
    enter();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const options = sendMessage.mock.calls[0][2] as { targetArn?: string; mentionedArns?: string[] } | undefined;
    expect(options?.targetArn).not.toBe(SELF);
    expect(JSON.stringify(sendMessage.mock.calls[0])).not.toContain(`"${SELF}"`);
  });
});
