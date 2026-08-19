/**
 * MessageInput — a task answer is ADDRESSED, and says what it answers (ADR-032).
 *
 * THE DEFECT THIS EXISTS FOR. In a shared conversation an assistant is silent unless spoken to, which
 * is right: it must not answer chatter it was not part of. But a person answering a question an
 * assistant asked THEM is not chatter, and they have no reason to know they were supposed to address
 * their reply. Untargeted, it reaches nobody - the workflow stays blocked, nothing errors, and the
 * conversation simply stops.
 *
 * THE COMPOSER IS WHERE THAT IS FIXED, because it is the only component that knows what is being
 * answered: it rendered the item. The stream-side repair exists for what this misses and COUNTS it
 * (ADR-032 tenets 3 and 6), so every count here staying at zero is what says this is working.
 *
 * The assertions are on what reaches `sendMessage`, which is the boundary the defect crossed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const sendMessage = vi.fn();

const ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const OTHER_ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c2';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/AltSlot0';
const OTHER_BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/assistant-premium';
const COLLEAGUE = 'arn:aws:chime:us-east-1:111:app-instance/i/user/dana';

/** A GROUP: the person, a colleague and the assistant that asked. Stable references - the composer's
 *  hooks depend on them, and a fresh object per render re-runs effects forever under jsdom. */
const GROUP_MEMBERS = [
  { userArn: BOT, name: 'Atlas', isBot: true },
  { userArn: OTHER_BOT, name: 'Assistant-premium', isBot: true },
  { userArn: SELF, name: 'Me', isBot: false },
  { userArn: COLLEAGUE, name: 'Dana', isBot: false },
];
/** A 1:1. Amazon Chime SDK's AUTO trigger routes every message here regardless of addressing. */
const PAIR_MEMBERS = [
  { userArn: BOT, name: 'Atlas', isBot: true },
  { userArn: SELF, name: 'Me', isBot: false },
];

const ITEM = {
  taskId: 't-1',
  taskType: 'report_generation',
  channelArn: ARN,
  status: 'in_progress',
  title: 'Quarterly report',
  assistantId: 'AltSlot0',
};

const ACTIVE_CONVERSATION = { conversationArn: ARN, modelTier: 'premium' };

const ctx: Record<string, unknown> = {};

vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => ctx,
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
  Object.assign(ctx, {
    activeConversation: ACTIVE_CONVERSATION,
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    isSending: false,
    sendError: null,
    clearSendError: () => {},
    channelMembers: GROUP_MEMBERS,
    stickyTarget: null,
    setStickyTarget: () => {},
    battleWaitingBots: [],
    openWorkItems: [ITEM],
    refreshOpenWorkItems: () => {},
  });
});

/** Type `text` into the composer, press Enter, and return the options `sendMessage` received. */
async function send(text: string) {
  const textarea = document.querySelector('.message-textarea') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(sendMessage).toHaveBeenCalled(), { timeout: 3000 });
  return (sendMessage.mock.calls[0][2] ?? undefined) as
    { targetArn?: string; mentionBotArn?: string; taskId?: string } | undefined;
}

describe('MessageInput — answering a work item', () => {
  it('addresses the assistant that is waiting, and names the task', async () => {
    render(<MessageInput />);
    const options = await send('the audience is engineering leadership');

    // Targeted so the message REACHES that assistant's Lex - this is what makes the answer arrive at
    // all in a room where silence is the default.
    expect(options?.targetArn).toBe(BOT);
    // The task id so a message that arrived at nobody can be detected afterwards and dispatched late.
    expect(options?.taskId).toBe('t-1');
  });

  it('does NOT address anything in a 1:1', async () => {
    // At that size Chime's AUTO trigger routes every message to the assistant regardless, so there is
    // nothing to fix - and targeting would make the person's own message private for no reason.
    ctx.channelMembers = PAIR_MEMBERS;
    render(<MessageInput />);

    expect(await send('the audience is engineering leadership')).toBeUndefined();
  });

  it('lets an explicit mention win', async () => {
    // The person named who they are talking to. ADR-030 makes that a supported path in its own right:
    // the turn resolves the chain from the task, so nothing needs to ride the message - and overriding
    // their choice would send the message somewhere they did not point it.
    render(<MessageInput />);
    const options = await send('@Assistant-premium what do you make of this?');

    expect(options?.taskId).toBeUndefined();
    expect(options?.mentionBotArn).toBe(OTHER_BOT);
  });

  it('leaves a slash command alone', async () => {
    // `/battle` is a new instruction, not an answer to the waiting step.
    render(<MessageInput />);

    expect(await send('/battle Tabs or spaces?')).toBeUndefined();
  });

  it('ignores an item that belongs to another conversation', async () => {
    // The queue is cross-conversation by design; the composer may only act on what is waiting HERE.
    ctx.openWorkItems = [{ ...ITEM, channelArn: OTHER_ARN }];
    render(<MessageInput />);

    expect(await send('the audience is engineering leadership')).toBeUndefined();
  });

  it('ignores an item whose assistant is not a member this client can see', async () => {
    // Resolved against visible members rather than assembled from an id: addressing a bot the client
    // has never seen would be a guess, and a wrong ARN reaches nobody just as silently.
    ctx.openWorkItems = [{ ...ITEM, assistantId: 'SomeBotNotHere' }];
    render(<MessageInput />);

    expect(await send('the audience is engineering leadership')).toBeUndefined();
  });

  it('beats a sticky mention target — the send does what the banner says', async () => {
    // The banner renders the work item BEFORE the sticky target when both exist, so the person is
    // told "Answering". The send must agree: prepending the sticky @Name here set the mention target
    // to that human, forced answersTask false, and routed the reply to Dana with no taskId - the UI
    // said the opposite and the work item stayed blocked.
    ctx.stickyTarget = { userArn: COLLEAGUE, name: 'Dana', isBot: false };
    render(<MessageInput />);
    const options = await send('yes, use option 2');

    expect(options?.targetArn).toBe(BOT);
    expect(options?.taskId).toBe('t-1');
    // And the sticky prefix stayed out of the content: the words sent are the words typed.
    expect(sendMessage.mock.calls[0][0]).toBe('yes, use option 2');
  });

  it('stops addressing the item once the person dismisses it', async () => {
    // Someone with an open item must still be able to say something else in the room. Without this,
    // every remark they make becomes an answer to work they were not talking about.
    const { container } = render(<MessageInput />);
    fireEvent.click(container.querySelector('.message-input-sticky-target-clear') as HTMLElement);

    expect(await send('back in a minute')).toBeUndefined();
  });
});
