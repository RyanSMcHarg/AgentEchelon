/**
 * MessageInput - replying to a duel side the person chose (DESIGN-BATTLE, "A side parked on the person").
 *
 * The person chooses a side on its message ("Reply to this side", or "Answer both sides"), and the
 * composer then says which side the next send goes to, lets them cancel, and sends the reply targeted
 * at that side: the `Target` is what reaches the side's Lex and resumes it. The composer never enters
 * this mode on its own, so a member who did not start the duel, or an owner who wants to say something
 * to the room, sends an ordinary message.
 *
 * The assertions are on what reaches `sendMessage`, the boundary the router's resume reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';

const sendMessage = vi.fn();
const clearReplyingToSides = vi.fn();

const ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';
const ATLAS = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/Alt-premium';
const PIXEL = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/assistant-premium';
const COLLEAGUE = 'arn:aws:chime:us-east-1:111:app-instance/i/user/dana';

const MEMBERS = [
  { userArn: ATLAS, name: 'Atlas', isBot: true },
  { userArn: PIXEL, name: 'Pixel', isBot: true },
  { userArn: SELF, name: 'Me', isBot: false },
  { userArn: COLLEAGUE, name: 'Dana', isBot: false },
];
const ACTIVE_CONVERSATION = { conversationArn: ARN, modelTier: 'premium' };
const ATLAS_WAITING = { botArn: ATLAS, battleId: 'b1', ownerId: 'self' };
const PIXEL_WAITING = { botArn: PIXEL, battleId: 'b1', ownerId: 'self' };

const ctx: Record<string, unknown> = {};

vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => ctx,
}));
vi.mock('../providers/AwsClientProvider', () => ({
  useAwsClient: () => ({ userArn: SELF, isInitialized: true, error: null }),
}));
vi.mock('@ae/shared', () => ({
  useAuth: () => ({ user: { id: 'self', isAdmin: false } }),
  trackEvent: () => {},
}));
vi.mock('../services/attachmentService', () => ({ uploadFile: vi.fn() }));
vi.mock('../services/messageLatencyTracker', () => ({ markMessageSent: () => {} }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, o?: { name?: string }) => (o?.name ? `${key}:${o.name}` : key),
  }),
}));

import MessageInput from './MessageInput';

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue(undefined);
  clearReplyingToSides.mockReset();
  for (const key of Object.keys(ctx)) delete ctx[key];
  Object.assign(ctx, {
    activeConversation: ACTIVE_CONVERSATION,
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    isSending: false,
    sendError: null,
    clearSendError: () => {},
    channelMembers: MEMBERS,
    stickyTarget: null,
    setStickyTarget: () => {},
    battleWaitingBots: [ATLAS_WAITING, PIXEL_WAITING],
    replyingToSides: [],
    replyToSides: () => {},
    clearReplyingToSides: () => clearReplyingToSides(),
    openWorkItems: [],
    refreshOpenWorkItems: () => {},
    answeringTaskId: null,
    clearAnswering: () => {},
  });
});

const textarea = () => document.querySelector('.message-textarea') as HTMLTextAreaElement;

async function send(text: string, expectedSends = 1) {
  fireEvent.change(textarea(), { target: { value: text } });
  fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(expectedSends), { timeout: 3000 });
}

describe('MessageInput - replying to a duel side', () => {
  it('sends the reply targeted at the chosen side, and leaves the mode once it is sent', async () => {
    ctx.replyingToSides = [ATLAS_WAITING];
    render(<MessageInput />);
    await send('Yes, that is exactly it. Go ahead.');

    expect(sendMessage).toHaveBeenCalledWith('Yes, that is exactly it. Go ahead.', undefined, { targetArn: ATLAS });
    expect(clearReplyingToSides).toHaveBeenCalled();
  });

  it('labels the mode with the side, in the bar and in the field', () => {
    ctx.replyingToSides = [ATLAS_WAITING];
    render(<MessageInput />);

    expect(screen.getByText('@Atlas')).toBeInTheDocument();
    expect(screen.getByText('conversation.battleWaitingOne:Atlas')).toBeInTheDocument();
    expect(textarea().placeholder).toBe('conversation.placeholderBattleReply:Atlas');
  });

  it('is cancellable, from a labeled control', () => {
    ctx.replyingToSides = [ATLAS_WAITING];
    render(<MessageInput />);

    fireEvent.click(screen.getByRole('button', { name: 'conversation.clearReplyingToSide' }));
    expect(clearReplyingToSides).toHaveBeenCalledTimes(1);
  });

  it('"Answer both sides" sends the same words to each side, one targeted message apiece', async () => {
    ctx.replyingToSides = [ATLAS_WAITING, PIXEL_WAITING];
    render(<MessageInput />);
    expect(textarea().placeholder).toBe('conversation.placeholderBattleReplyBoth');
    await send('Audience is the leadership team.', 2);

    expect(sendMessage).toHaveBeenNthCalledWith(1, 'Audience is the leadership team.', undefined, { targetArn: ATLAS });
    expect(sendMessage).toHaveBeenNthCalledWith(2, 'Audience is the leadership team.', undefined, { targetArn: PIXEL });
  });

  it('a side waiting is not a reply mode: without a choice the send is an ordinary message', async () => {
    // The composer used to route every send to a waiting side on its own, for every member. A reply
    // goes to a side only when the person chose that side.
    render(<MessageInput />);
    await send('Interesting, both look good so far.');

    const options = sendMessage.mock.calls[0][2] as { targetArn?: string } | undefined;
    expect(options?.targetArn).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'conversation.clearReplyingToSide' })).toBeNull();
  });
});
