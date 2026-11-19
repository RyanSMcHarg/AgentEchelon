/**
 * MessageInput - typing a mention by hand opens the picker; picking shows the member by name in the field and sends the same token the
 * picker always writes (`@<Name|id> `, `.<Name|id> `), so a typed mention and a picked one are the
 * same message and render as the same chip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

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
const listbox = () => document.querySelector('[role="listbox"]');
const optionNames = () =>
  Array.from(document.querySelectorAll('[role="option"] .mention-option-name')).map((n) => n.textContent);

describe('typing a mention by hand', () => {
  it('opens the picker filtered to what is typed, with Alice first', async () => {
    render(<MessageInput />);
    type('hi @Al');
    await waitFor(() => expect(listbox()).not.toBeNull());
    // `all` also begins with "al"; a member at the same rank comes first.
    expect(optionNames()[0]).toBe('@Alice');
    expect(optionNames()).not.toContain('@Ryan McHarg');
  });

  it('ties the listbox to the textarea for assistive technology', async () => {
    render(<MessageInput />);
    expect(textarea().getAttribute('aria-expanded')).toBe('false');
    type('@Al');
    await waitFor(() => expect(listbox()).not.toBeNull());
    expect(textarea().getAttribute('aria-expanded')).toBe('true');
    expect(textarea().getAttribute('aria-controls')).toBe(listbox()!.id);
    const active = document.getElementById(textarea().getAttribute('aria-activedescendant')!);
    expect(active?.getAttribute('aria-selected')).toBe('true');
    expect(active?.textContent).toContain('@Alice');
  });

  it('moves through the list with the arrow keys', async () => {
    render(<MessageInput />);
    type('@');
    await waitFor(() => expect(listbox()).not.toBeNull());
    const first = textarea().getAttribute('aria-activedescendant');
    key('ArrowDown');
    expect(textarea().getAttribute('aria-activedescendant')).not.toBe(first);
    key('ArrowUp');
    expect(textarea().getAttribute('aria-activedescendant')).toBe(first);
  });

  it('shows the picked member by name on Enter, and sends the delimited token', async () => {
    render(<MessageInput />);
    type('hi @Al');
    await waitFor(() => expect(listbox()).not.toBeNull());
    key('Enter');
    expect(textarea().value).toBe('hi @Alice ');
    expect(listbox()).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();

    type('hi @Alice ping');
    expect(listbox()).toBeNull();
    key('Enter');
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toBe(`hi @<Alice|${ALICE_ID}> ping`);
    expect(sendMessage.mock.calls[0][2]).toMatchObject({ mentionArns: [ALICE] });
  });

  it('sends plain text for a picked mention the person then edits', async () => {
    render(<MessageInput />);
    type('@Al');
    await waitFor(() => expect(listbox()).not.toBeNull());
    key('Enter');
    type('@Alic ping');
    key('Escape');
    key('Enter');
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toBe('@Alic ping');
  });

  it('writes the token on Tab and on a click too, a name with a space delimited', async () => {
    render(<MessageInput />);
    type('@Ry');
    await waitFor(() => expect(listbox()).not.toBeNull());
    key('Tab');
    expect(textarea().value).toBe('@Ryan McHarg ');

    type('@Ryan McHarg @Ali');
    await waitFor(() => expect(listbox()).not.toBeNull());
    fireEvent.mouseDown(document.querySelector('[role="option"]')!);
    expect(textarea().value).toBe('@Ryan McHarg @Alice ');
    key('Enter');
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toBe(`@<Ryan McHarg|ryan-id> @<Alice|${ALICE_ID}>`);
  });

  it('keeps matching a name typed with a space', async () => {
    render(<MessageInput />);
    type('@Ryan Mc');
    await waitFor(() => expect(listbox()).not.toBeNull());
    expect(optionNames()).toEqual(['@Ryan McHarg']);
  });

  it('closes on Escape and leaves the text as typed', async () => {
    render(<MessageInput />);
    type('@Al');
    await waitFor(() => expect(listbox()).not.toBeNull());
    key('Escape');
    expect(listbox()).toBeNull();
    expect(textarea().value).toBe('@Al');
    expect(textarea().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when nothing matches, and the text stays plain', async () => {
    render(<MessageInput />);
    type('@Zed');
    expect(listbox()).toBeNull();
    key('Enter');
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toBe('@Zed');
  });

  it('does not open for an @ inside a word, such as an email address', () => {
    render(<MessageInput />);
    type('mail a@b.com');
    expect(listbox()).toBeNull();
    type('mail a@Al');
    expect(listbox()).toBeNull();
  });

  it('offers assistants and @all the way the picker does', async () => {
    render(<MessageInput />);
    type('@');
    await waitFor(() => expect(listbox()).not.toBeNull());
    expect(optionNames()).toEqual(expect.arrayContaining(['@all', '@Advisor', '@Alice', '@Ryan McHarg']));
    expect(optionNames()).not.toContain('@Me');
  });
});

describe('typing a private address by hand', () => {
  it('opens the private picker for a dot at the start, shows `.Name`, and sends `.<Name|id>`', async () => {
    render(<MessageInput />);
    type('.Al');
    await waitFor(() => expect(document.querySelector('.mention-dropdown--private')).not.toBeNull());
    expect(optionNames()).toEqual(['.Alice']);
    key('Enter');
    expect(textarea().value).toBe('.Alice ');
    expect(document.querySelector('.message-input-sticky-target-chip--private')?.textContent).toBe('Alice');
    type('.Alice are you free');
    key('Enter');
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toBe(`.<Alice|${ALICE_ID}> are you free`);
    expect(sendMessage.mock.calls[0][2]).toMatchObject({ targetArn: ALICE });
  });

  it('does not open for a dot later in the message', () => {
    render(<MessageInput />);
    type('see file.Al');
    expect(listbox()).toBeNull();
  });
});
