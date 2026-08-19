/**
 * MessageInput — a sticky mention must not swallow a slash command.
 *
 * THE DEFECT THIS EXISTS FOR. A sticky mention target persists across sends: once set, every later
 * message that does not already start with `@` gets `@Name ` prepended. `/battle` is a
 * START-OF-MESSAGE command, so that prefix turns it into ordinary prose addressed to one assistant.
 * The router reads `invokesBattle: false` and answers normally - no duel, no scorecard, and no
 * message saying why. The user typed a valid command and simply got a different feature.
 *
 * It is also semantically wrong: a battle fans out to TWO bots, so a sticky target naming one of
 * them contradicts the command it is attached to.
 *
 * This surfaced as e2e B-E6, the only battle test with a second member in the channel, where the
 * backend log read `rawHead: '@Assistant-premium /battle Tabs or spaces...'` against a correct
 * `invokesBattle: false`. Nothing was broken on the backend; the composer never sent a command.
 *
 * The assertion is on what reaches `sendMessage`, since that is the boundary the defect crossed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const sendMessage = vi.fn();
const setStickyTarget = vi.fn();

const ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/assistant-premium';

// A sticky target is SET — the state the defect needs. Stable references: the composer's hooks
// depend on these, and a fresh object per render re-runs effects forever under jsdom.
const STICKY = { userArn: BOT, name: 'Assistant-premium', isBot: true, isAll: false };
const MEMBERS = [
  { userArn: BOT, name: 'Assistant-premium', isBot: true },
  { userArn: SELF, name: 'Me', isBot: false },
];
const ACTIVE_CONVERSATION = { conversationArn: ARN, modelTier: 'premium' };
const CONVERSATIONS = {
  activeConversation: ACTIVE_CONVERSATION,
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  isSending: false,
  sendError: null,
  clearSendError: () => {},
  channelMembers: MEMBERS,
  stickyTarget: STICKY,
  setStickyTarget: (...a: unknown[]) => setStickyTarget(...a),
  battleWaitingBots: [],
  // Nothing is waiting on this person, so the task-answer branch stays out of the way of what this
  // file is about (see MessageInput.task-answer.test.tsx for that branch).
  openWorkItems: [],
  refreshOpenWorkItems: () => {},
};

vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => CONVERSATIONS,
}));
// Full replacement, not importOriginal: the real @ae/shared barrel reaches AWS SDK modules that
// never settle under jsdom and hang the run at import time.
vi.mock('@ae/shared', () => ({
  useAuth: () => ({ user: { userArn: SELF, isAdmin: false } }),
  trackEvent: () => {},
}));
vi.mock('../services/attachmentService', () => ({ uploadFile: vi.fn() }));
vi.mock('../services/messageLatencyTracker', () => ({ markMessageSent: () => {} }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? '' }),
}));

import MessageInput from './MessageInput';

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue(undefined);
  setStickyTarget.mockReset();
});

/** Type `text` into the composer and press Enter. */
async function send(text: string) {
  const textarea = document.querySelector('.message-textarea') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(sendMessage).toHaveBeenCalled(), { timeout: 3000 });
  return sendMessage.mock.calls[0][0] as string;
}

describe('MessageInput — sticky mention vs slash command', () => {
  it('sends /battle unprefixed even with a sticky target set', async () => {
    render(<MessageInput />);
    const sent = await send('/battle Tabs or spaces?');

    // The whole defect: a leading mention makes this ordinary prose to the backend.
    expect(sent.startsWith('/battle')).toBe(true);
    expect(sent).not.toContain('@Assistant-premium');
  });

  it('still prepends the sticky mention to ordinary prose', async () => {
    render(<MessageInput />);
    const sent = await send('what do you think?');

    // The exemption must be narrow — sticky targeting is the feature, not the bug.
    expect(sent).toBe('@Assistant-premium what do you think?');
  });

  it('leaves a message that already carries its own mention alone', async () => {
    render(<MessageInput />);
    const sent = await send('@all please review');

    expect(sent).toBe('@all please review');
  });
});
