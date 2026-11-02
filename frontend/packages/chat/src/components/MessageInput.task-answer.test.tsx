/**
 * MessageInput — a task answer names its item, is ADDRESSED, and says what it answers (ADR-032, ADR-035).
 *
 * THE DEFECT THIS EXISTS FOR. In a shared conversation an assistant is silent unless spoken to, which
 * is right: it must not answer chatter it was not part of. But a person answering a question an
 * assistant asked THEM is not chatter, and they have no reason to know they were supposed to address
 * their reply. Untargeted, it reaches nobody - the workflow stays blocked, nothing errors, and the
 * conversation simply stops.
 *
 * AND THE PERSON SAYS WHICH ITEM (ADR-035). The composer used to pick the oldest open item on its own,
 * which attached a reply to work the person may not have been talking about. A reply now answers an
 * item only when it names that item's reference, typed or put there by the item's Answer action.
 *
 * The assertions are on what reaches `sendMessage`, which is the boundary the defect crossed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@testing-library/react';

const sendMessage = vi.fn();
const clearAnswering = vi.fn();

const ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const OTHER_ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c2';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/Alt-premium';
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
  taskRef: 1,
  taskType: 'report_generation',
  channelArn: ARN,
  status: 'in_progress',
  title: 'Quarterly report',
  assistantId: 'Alt-premium',
};

const ACTIVE_CONVERSATION = { conversationArn: ARN, modelTier: 'premium' };

const ctx: Record<string, unknown> = {};

vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => ctx,
}));
// Full replacement, not importOriginal: the real @ae/shared barrel reaches AWS SDK modules that
// never settle under jsdom and hang the run at import time.
// The sender is the ARN the messaging client acts as, never a field of the signed-in user.
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
  useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? '' }),
}));

import MessageInput from './MessageInput';

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue(undefined);
  clearAnswering.mockReset();
  for (const key of Object.keys(ctx)) delete ctx[key];
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
    answeringTaskId: null,
    clearAnswering: () => clearAnswering(),
  });
});

const textarea = () => document.querySelector('.message-textarea') as HTMLTextAreaElement;

/** Type `text` into the composer, press Enter, and return the options `sendMessage` received. */
async function send(text: string) {
  fireEvent.change(textarea(), { target: { value: text } });
  fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(sendMessage).toHaveBeenCalled(), { timeout: 3000 });
  return (sendMessage.mock.calls[0][2] ?? undefined) as
    { targetArn?: string; mentionBotArn?: string; taskId?: string } | undefined;
}

describe('MessageInput — answering a work item', () => {
  it('addresses the assistant that is waiting, and names the task, when the reply names the item', async () => {
    render(<MessageInput />);
    const options = await send('#1 the audience is engineering leadership');

    // Targeted so the message REACHES that assistant's Lex - this is what makes the answer arrive at
    // all in a room where silence is the default.
    expect(options?.targetArn).toBe(BOT);
    // The task id so a message that arrived at nobody can be detected afterwards and dispatched late.
    expect(options?.taskId).toBe('t-1');
    // The reference stays in the words sent: it is what the server resolves, on every channel.
    expect(sendMessage.mock.calls[0][0]).toBe('#1 the audience is engineering leadership');
  });

  it('attaches NOTHING on its own: a reply that names no item answers no item', async () => {
    // The composer used to pick the oldest open item and address every message to it. A person who
    // had two things open, or was talking about something else, had their reply attached to work
    // they never named.
    render(<MessageInput />);

    expect(await send('the audience is engineering leadership')).toBeUndefined();
  });

  it('writes NOTHING into the composer when the person chooses Answer on the item', async () => {
    // It used to insert the item's `#1 `, so the client's routing instruction became part of the
    // person's message to a room that reads every word of it. The item travels as metadata now.
    ctx.answeringTaskId = 't-1';
    render(<MessageInput />);

    await waitFor(() => expect(screen.getByText(/#1: /)).toBeInTheDocument());
    expect(textarea().value).toBe('');
    // AND THE CHOICE SURVIVES UNTIL THE SEND. It used to be spent the instant it became text; with
    // nothing in the text to carry it, clearing it here would drop the item on the floor.
    expect(clearAnswering).not.toHaveBeenCalled();

    const options = await send('the audience is engineering leadership');
    expect(options?.taskId).toBe('t-1');
    expect(sendMessage.mock.calls[0][0]).toBe('the audience is engineering leadership');
  });

  it('answers an older item with no reference only when the person chose it', async () => {
    ctx.openWorkItems = [{ ...ITEM, taskRef: undefined }];
    ctx.answeringTaskId = 't-1';
    render(<MessageInput />);
    const options = await send('the audience is engineering leadership');

    expect(options?.targetArn).toBe(BOT);
    expect(options?.taskId).toBe('t-1');
  });

  it('does NOT address anything in a 1:1, and still sends the reference as typed', async () => {
    // At that size Chime's AUTO trigger routes every message to the assistant regardless, so there is
    // nothing to fix - and targeting would make the person's own message private for no reason.
    ctx.channelMembers = PAIR_MEMBERS;
    render(<MessageInput />);

    expect(await send('#1 the audience is engineering leadership')).toBeUndefined();
    expect(sendMessage.mock.calls[0][0]).toBe('#1 the audience is engineering leadership');
  });

  it('lets an explicit mention win', async () => {
    // The person named who they are talking to. ADR-030 makes that a supported path in its own right:
    // the turn resolves the chain from the task, so nothing needs to ride the message - and overriding
    // their choice would send the message somewhere they did not point it.
    render(<MessageInput />);
    const options = await send('@Assistant-premium #1 what do you make of this?');

    expect(options?.taskId).toBeUndefined();
    expect(options?.mentionBotArn).toBe(OTHER_BOT);
  });

  it('lets a mention of a PERSON win too, and does not send it to the assistant', async () => {
    // The expensive regression ADR-034 opened: a human mention sets no target, and the task-answer
    // branch once took such a message to the ASSISTANT while the colleague was never mentioned.
    render(<MessageInput />);
    const options = await send('@Dana #1 can you check this?');

    expect(options?.taskId).toBeUndefined();
    expect(options?.targetArn).toBeUndefined();
    expect((options as { mentionArns?: string[] } | undefined)?.mentionArns).toEqual([COLLEAGUE]);
  });

  it('still answers the work item when the reply is formatted with /md', async () => {
    // `/md` is a RENDERING instruction, not a routing one, so it does not disqualify an answer.
    render(<MessageInput />);
    const options = await send('/md #1 the audience is `engineering leadership`');

    expect(options?.taskId).toBe('t-1');
    expect(options?.targetArn).toBe(BOT);
    expect(sendMessage.mock.calls[0][0]).toBe('/md #1 the audience is `engineering leadership`');
  });

  it('leaves a slash command alone', async () => {
    // `/battle` is a new instruction, not an answer to the waiting step.
    render(<MessageInput />);

    expect(await send('/battle Tabs or spaces?')).toBeUndefined();
  });

  it('ignores a reference to an item in another conversation', async () => {
    // References are per conversation; the composer may only act on what is open HERE. The words still
    // go out as typed and the server answers a reference that names nothing of theirs.
    ctx.openWorkItems = [{ ...ITEM, channelArn: OTHER_ARN }];
    render(<MessageInput />);

    expect(await send('#1 the audience is engineering leadership')).toBeUndefined();
  });

  it('ignores an item whose assistant is not a member this client can see', async () => {
    // Resolved against visible members rather than assembled from an id: addressing a bot the client
    // has never seen would be a guess, and a wrong ARN reaches nobody just as silently.
    ctx.openWorkItems = [{ ...ITEM, assistantId: 'SomeBotNotHere' }];
    render(<MessageInput />);

    expect(await send('#1 the audience is engineering leadership')).toBeUndefined();
  });

  it('beats a sticky mention target — the send does what the banner says', async () => {
    ctx.stickyTarget = { userArn: COLLEAGUE, name: 'Dana', isBot: false };
    render(<MessageInput />);
    const options = await send('#1 yes, use option 2');

    expect(options?.targetArn).toBe(BOT);
    expect(options?.taskId).toBe('t-1');
    // And the sticky prefix stayed out of the content: the words sent are the words typed.
    expect(sendMessage.mock.calls[0][0]).toBe('#1 yes, use option 2');
  });

  it('takes the reference back out when the person dismisses the chip', async () => {
    const { container } = render(<MessageInput />);
    fireEvent.change(textarea(), { target: { value: '#1 back in a minute' } });
    fireEvent.click(container.querySelector('.message-input-sticky-target-clear') as HTMLElement);

    expect(textarea().value).toBe('back in a minute');
    expect(await send('back in a minute')).toBeUndefined();
  });
});

/**
 * ADDRESSING IS NOT PRIVATISING.
 *
 * Reaching the assistant with a `targetArn` sets a Chime Target, and a Target is exactly what makes a
 * message unreadable to the rest of the room. A shared item is answered by MENTIONING the assistant -
 * public text - with the task id alongside as precision. A private item keeps the target.
 */
describe('MessageInput — a shared item is answered in the open', () => {
  it('sends a referenced shared item in the open with no mention, because the reference routes it', async () => {
    ctx.openWorkItems = [{ ...ITEM, visibility: 'conversation' as const }];
    render(<MessageInput />);
    const options = await send('#1 make it one page');

    expect(options?.targetArn).toBeUndefined();
    // No mention: the channel flow routes the `#1` itself, and a mention invoked the assistant a second
    // time (measured live: the message was queued behind its own answer).
    expect(options?.mentionBotArn).toBeUndefined();
    expect(options?.taskId).toBe('t-1');
  });

  it('mentions nothing for a shared item with no reference either: the id routes it', async () => {
    // This used to mention the assistant, because only an item WITH a reference had something in the
    // text for the channel flow to route on. The flow reads the id off the metadata now, so the
    // mention would be a SECOND entry for one message - and the correlation ids the two entries
    // derive never collide, so idempotency does not collapse them.
    ctx.openWorkItems = [{ ...ITEM, taskRef: undefined, visibility: 'conversation' as const }];
    ctx.answeringTaskId = 't-1';
    render(<MessageInput />);
    const options = await send('make it one page');

    expect(options?.mentionBotArn).toBeUndefined();
    expect(options?.targetArn).toBeUndefined();
    expect(options?.taskId).toBe('t-1');
  });

  it('keeps a private item targeted', async () => {
    ctx.openWorkItems = [{ ...ITEM, visibility: 'private' as const }];
    render(<MessageInput />);
    const options = await send('#1 and my expenses question');

    expect(options?.targetArn).toBe(BOT);
    expect(options?.mentionBotArn).toBeUndefined();
  });

  it('treats an item with no visibility as private', async () => {
    ctx.openWorkItems = [{ ...ITEM }];
    render(<MessageInput />);
    const options = await send('#1 an answer');

    expect(options?.targetArn).toBe(BOT);
    expect(options?.mentionBotArn).toBeUndefined();
  });
});
