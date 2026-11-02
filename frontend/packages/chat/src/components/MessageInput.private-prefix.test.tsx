/**
 * MessageInput - the private prefix, and the protection that makes it safe to have (ADR-034).
 *
 * `.member ` addresses one member privately without leaving the conversation. It is the only thing
 * that sets an Amazon Chime SDK `Target`, and a `Target` is what makes a message unreadable to the
 * rest of the room.
 *
 * THE ASYMMETRY THESE TESTS EXIST FOR. A message meant for the room that reaches one person is
 * confusing and recoverable: send it again. A message meant for one person that reaches the room
 * cannot be taken back. So every behaviour here fails toward "not private" being VISIBLE, and
 * toward refusing rather than guessing:
 *
 *  1. the token becomes a decoration the moment it resolves, so privacy is something a person SEES
 *     before they commit to it rather than something they hope happened;
 *  2. a token-shaped near miss blocks the send instead of going out as prose;
 *  3. privacy is never sticky - it is re-stated per message, because a mode that outlives the
 *     message is a mode somebody forgets they are in;
 *  4. the sticky mention never prepends in front of it, which would move the token off the start
 *     and silently stop it meaning anything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const sendMessage = vi.fn();
const setStickyTarget = vi.fn();

const ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/assistant-premium';
const ALICE = 'arn:aws:chime:us-east-1:111:app-instance/i/user/alice';

const STICKY = { userArn: BOT, name: 'Assistant-premium', isBot: true, isAll: false };
const MEMBERS = [
  { userArn: BOT, name: 'Assistant-premium', isBot: true },
  { userArn: ALICE, name: 'Alice', isBot: false },
  { userArn: SELF, name: 'Me', isBot: false },
];
const CONVERSATIONS = {
  activeConversation: { conversationArn: ARN, modelTier: 'premium' },
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  isSending: false,
  sendError: null,
  clearSendError: () => {},
  channelMembers: MEMBERS,
  stickyTarget: STICKY,
  setStickyTarget: (...a: unknown[]) => setStickyTarget(...a),
  battleWaitingBots: [],
  openWorkItems: [],
  refreshOpenWorkItems: () => {},
};

vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => CONVERSATIONS,
}));
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
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));

import MessageInput from './MessageInput';

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue(undefined);
  setStickyTarget.mockReset();
});

const textarea = () => document.querySelector('.message-textarea') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });
const enter = () => fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });

describe('MessageInput - the private prefix', () => {
  it('decorates the moment the token completes, so privacy is visible before sending', async () => {
    render(<MessageInput />);

    // Incomplete: no trailing space, so the token has not resolved and nothing claims to be private.
    type('.Alice');
    expect(document.querySelector('.message-input-sticky-target-chip--private')).toBeNull();

    // Complete. The chip names the member in words, not the token.
    type('.Alice are you free');
    await waitFor(() => {
      const chip = document.querySelector('.message-input-sticky-target-chip--private');
      expect(chip).not.toBeNull();
      expect(chip!.textContent).toContain('Alice');
    });
  });

  it('sets the Target, which is what the service enforces', async () => {
    render(<MessageInput />);
    type('.Alice are you free');
    enter();

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const options = sendMessage.mock.calls[0][2] as { targetArn?: string } | undefined;
    expect(options?.targetArn).toBe(ALICE);
  });

  it('sends a token-shaped near miss to the room, with no target and no error', async () => {
    // THE RULE: a dot applies a Target only when it names an actual member in
    // full. Carol is not in this conversation, so this is ordinary text that begins with a dot.
    //
    // This used to block the send. The regex matches far more than names - ".env is missing" and
    // ".gitignore needs a line" produce a token too - so the refusal made everyday sentences
    // unsendable in any room where people discuss code, which cost more than it protected.
    render(<MessageInput />);
    type('.Carol are you free');
    enter();

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(document.querySelector('.message-input-error, [role="alert"]')).toBeNull();
    const options = sendMessage.mock.calls[0][2] as { targetArn?: string } | undefined;
    expect(options?.targetArn).toBeUndefined();
  });

  it('shows NO privacy decoration for a near miss, which is what warns the person', async () => {
    // The decoration carries the safety now that the refusal is gone: a person typing `.Carol` sees
    // no "Private to Carol" chip before they commit, which is the signal this feature was asked for
    // with. Asserting its ABSENCE is what keeps that true.
    render(<MessageInput />);
    type('.Carol are you free');

    await waitFor(() => expect(textarea().value).toBe('.Carol are you free'));
    expect(document.querySelector('.message-input-sticky-target-chip--private')).toBeNull();
  });

  it('never makes privacy sticky', async () => {
    render(<MessageInput />);
    type('.Alice are you free');
    enter();

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    // Carrying privacy forward would be a mode that outlives the message. Addressing is sticky;
    // privacy is re-stated every time.
    expect(setStickyTarget).not.toHaveBeenCalled();
  });

  it('does not let the sticky mention push the token off the start of the message', async () => {
    render(<MessageInput />);
    type('.Alice are you free');
    enter();

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const sent = sendMessage.mock.calls[0][0] as string;
    // A prepended `@Assistant-premium ` would move `.Alice` off the start, and an unanchored token
    // resolves to nothing - the message would go to the room with no signal that it had.
    expect(sent.startsWith('.Alice')).toBe(true);
    expect(sent).not.toContain('@Assistant-premium');
  });

  it('offers the member list when a dot is typed at the start', async () => {
    // PICKED FROM A LIST, NOT TYPED FROM MEMORY. The dot token IS the whole address and must equal a
    // member's name exactly, and an unresolved one now goes to the ROOM rather than being refused -
    // so the cost of a typo is a published message. The picker is what keeps that out of reach.
    render(<MessageInput />);
    type('.');

    await waitFor(() => {
      const names = [...document.querySelectorAll('.mention-option-name')].map((n) => n.textContent);
      expect(names).toContain('.Alice');
    });
  });

  it('marks the privacy picker as a different act from the mention picker', async () => {
    // "Alice" and "Alice" look identical; only the framing distinguishes addressing her in the room
    // from addressing her privately. The list that applies a Target must not look like the one that
    // does not.
    render(<MessageInput />);
    type('.');

    await waitFor(() => {
      expect(document.querySelector('.mention-dropdown--private')).not.toBeNull();
      expect(document.querySelector('.mention-dropdown-heading')?.textContent).toMatch(/privately/i);
    });
  });

  it('OFFERS a member whose name is an email address', async () => {
    // FOUND ON A LIVE DEPLOYMENT, where members are named by their email address. The token was once
    // a character class with no `@` in it, so `.someone@example.com hello` produced no token at all:
    // the message was not private and went to the whole room, and no human on that deployment could
    // be privately addressed. The safety was never the class - it is that a token must match a
    // member's name in FULL - so the token now runs to the first space.
    const EMAIL_NAMED = [
      { userArn: BOT, name: 'Assistant-premium', isBot: true },
      { userArn: ALICE, name: 'alice@example.com', isBot: false },
      { userArn: SELF, name: 'Me', isBot: false },
    ];
    Object.assign(CONVERSATIONS, { channelMembers: EMAIL_NAMED });
    try {
      render(<MessageInput />);
      type('.');
      await waitFor(() => expect(document.querySelector('.mention-dropdown--private')).not.toBeNull());
      const names = [...document.querySelectorAll('.mention-option-name')].map((n) => n.textContent);
      expect(names).toContain('.alice@example.com');
    } finally {
      Object.assign(CONVERSATIONS, { channelMembers: MEMBERS });
    }
  });

  it('keeps the picker open while an email-shaped name is being typed', async () => {
    // THE TOKEN IS LEXED IN MORE THAN ONE PLACE AND MUST MEAN ONE THING. The trigger carried its own
    // copy of the old character class, so when the token widened this copy stayed narrow: for a
    // member named by email the picker closed the instant `@` was typed - half way through their own
    // name - and the person was left to type the rest of it unaided, which is the situation the
    // picker exists to prevent.
    const EMAIL_NAMED = [
      { userArn: BOT, name: 'Assistant-premium', isBot: true },
      { userArn: ALICE, name: 'alice@example.com', isBot: false },
      { userArn: SELF, name: 'Me', isBot: false },
    ];
    Object.assign(CONVERSATIONS, { channelMembers: EMAIL_NAMED });
    try {
      render(<MessageInput />);
      type('.alice@ex');
      await waitFor(() => {
        const names = [...document.querySelectorAll('.mention-option-name')].map((n) => n.textContent);
        expect(names).toContain('.alice@example.com');
      });
    } finally {
      Object.assign(CONVERSATIONS, { channelMembers: MEMBERS });
    }
  });

  it('clears a private prefix whose name the old pattern could not express', async () => {
    // The "clear" control carried a third copy of the pattern, so after the widening it could not
    // remove the very tokens the picker had just inserted.
    const EMAIL_NAMED = [
      { userArn: BOT, name: 'Assistant-premium', isBot: true },
      { userArn: ALICE, name: 'alice@example.com', isBot: false },
      { userArn: SELF, name: 'Me', isBot: false },
    ];
    Object.assign(CONVERSATIONS, { channelMembers: EMAIL_NAMED });
    try {
      render(<MessageInput />);
      type('.alice@example.com are you free');
      const clear = document.querySelector('.message-input-sticky-target-clear') as HTMLElement;
      expect(clear, 'a resolved private prefix offers a way out of it').not.toBeNull();
      fireEvent.click(clear);
      await waitFor(() => expect(textarea().value).toBe('are you free'));
    } finally {
      Object.assign(CONVERSATIONS, { channelMembers: MEMBERS });
    }
  });

  it('inserts the DELIMITED form for a name with a space, and decorates it', async () => {
    // The picker writes the form the name requires, so nobody types a bracket. Angle brackets follow
    // the convention every major client uses to delimit a mention target.
    const SPACED = [
      { userArn: BOT, name: 'Assistant-premium', isBot: true },
      { userArn: ALICE, name: 'Ryan McHarg', isBot: false },
      { userArn: SELF, name: 'Me', isBot: false },
    ];
    Object.assign(CONVERSATIONS, { channelMembers: SPACED });
    try {
      render(<MessageInput />);
      type('.Ryan');
      await waitFor(() => {
        const names = [...document.querySelectorAll('.mention-option-name')].map((n) => n.textContent);
        expect(names, 'a name with a space is offered now that it can be expressed').toContain('.Ryan McHarg');
      });
      fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });

      // THE PICKER WRITES THE ID BESIDE THE NAME, because a display name is not unique and the channel
      // flow sees no Target - so the id has to travel in the text. The chip below still shows the NAME,
      // which is the half a person reads.
      await waitFor(() => expect(textarea().value).toBe('.<Ryan McHarg|alice> '));
      // The chip is the confirmation that privacy was applied, and it must appear for this form too.
      await waitFor(() => {
        const chip = document.querySelector('.message-input-sticky-target-chip--private');
        expect(chip).not.toBeNull();
        expect(chip!.textContent).toContain('Ryan McHarg');
      });
    } finally {
      Object.assign(CONVERSATIONS, { channelMembers: MEMBERS });
    }
  });

  it('keeps the picker open while a delimited name is being typed past its space', async () => {
    // The space inside the name must not close the list - that space is the whole reason the
    // delimited form exists.
    const SPACED = [
      { userArn: BOT, name: 'Assistant-premium', isBot: true },
      { userArn: ALICE, name: 'Ryan McHarg', isBot: false },
      { userArn: SELF, name: 'Me', isBot: false },
    ];
    Object.assign(CONVERSATIONS, { channelMembers: SPACED });
    try {
      render(<MessageInput />);
      type('.<Ryan Mc');
      await waitFor(() => {
        const names = [...document.querySelectorAll('.mention-option-name')].map((n) => n.textContent);
        expect(names).toContain('.Ryan McHarg');
      });
    } finally {
      Object.assign(CONVERSATIONS, { channelMembers: MEMBERS });
    }
  });

  it('sets the Target from a delimited address', async () => {
    const SPACED = [
      { userArn: BOT, name: 'Assistant-premium', isBot: true },
      { userArn: ALICE, name: 'Ryan McHarg', isBot: false },
      { userArn: SELF, name: 'Me', isBot: false },
    ];
    Object.assign(CONVERSATIONS, { channelMembers: SPACED });
    try {
      render(<MessageInput />);
      type('.<Ryan McHarg> are you free');
      enter();

      await waitFor(() => expect(sendMessage).toHaveBeenCalled());
      const options = sendMessage.mock.calls[0][2] as { targetArn?: string } | undefined;
      expect(options?.targetArn).toBe(ALICE);
    } finally {
      Object.assign(CONVERSATIONS, { channelMembers: MEMBERS });
    }
  });

  it('does NOT offer a member whose name contains the delimiters themselves', async () => {
    // What remains out of reach once the delimited form exists: a name carrying `<` or `>` cannot be
    // wrapped in them unambiguously. Offering that member would be offering an action the platform
    // cannot perform - the same rule that keeps `all` out of a list whose Target holds one member.
    const SPACED = [
      { userArn: BOT, name: 'Assistant-premium', isBot: true },
      { userArn: ALICE, name: 'Ryan <the boss> McHarg', isBot: false },
      { userArn: SELF, name: 'Me', isBot: false },
    ];
    Object.assign(CONVERSATIONS, { channelMembers: SPACED });
    try {
      render(<MessageInput />);
      type('.');
      await waitFor(() => expect(document.querySelector('.mention-dropdown--private')).not.toBeNull());
      const names = [...document.querySelectorAll('.mention-option-name')].map((n) => n.textContent);
      expect(names.some((n) => n?.includes('the boss'))).toBe(false);
      // Still a filter, not an empty list.
      expect(names).toContain('.Assistant-premium');
    } finally {
      Object.assign(CONVERSATIONS, { channelMembers: MEMBERS });
    }
  });

  it('does NOT offer "all", because a private message goes to exactly one member', async () => {
    // `Target` holds one member, so "privately to everyone" is not expressible at all - offering it
    // would present a choice the platform cannot honour.
    render(<MessageInput />);
    type('.');

    await waitFor(() => expect(document.querySelector('.mention-dropdown')).not.toBeNull());
    const names = [...document.querySelectorAll('.mention-option-name')].map((n) => n.textContent);
    expect(names).not.toContain('.all');
    expect(names).not.toContain('@all');
  });

  it('does not open the privacy picker for a dot mid-sentence', async () => {
    // The prefix is anchored: "call me at 5.sam" is not addressing Sam, and a decimal must not put a
    // privacy picker in front of somebody who was writing a number.
    render(<MessageInput />);
    type('call me at 5.');

    await waitFor(() => expect(textarea().value).toBe('call me at 5.'));
    expect(document.querySelector('.mention-dropdown--private')).toBeNull();
  });

  it('inserts the full name with its trailing space, so the token is finished and decorated', async () => {
    // The parser needs the space before the token resolves, which is also when the chip appears.
    // Inserting without it would leave the person looking at an address that is not yet an address.
    render(<MessageInput />);
    type('.Ali');

    await waitFor(() => expect(document.querySelector('.mention-option-name')).not.toBeNull());
    fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });

    // Delimited now even for a simple name, because the id is written with it.
    await waitFor(() => expect(textarea().value).toBe('.<Alice|alice> '));
    await waitFor(() => {
      expect(document.querySelector('.message-input-sticky-target-chip--private')).not.toBeNull();
    });
  });

  it('still offers the ordinary mention picker for @', async () => {
    // One dropdown serves both grammars; the public one must not have been narrowed by the private
    // one's rules - `@all` belongs there and nowhere else.
    render(<MessageInput />);
    type('@');

    await waitFor(() => {
      const names = [...document.querySelectorAll('.mention-option-name')].map((n) => n.textContent);
      expect(names).toContain('@Alice');
    });
    expect(document.querySelector('.mention-dropdown--private')).toBeNull();
  });

  it('DECORATES a private message that is also formatted with /md', async () => {
    // THE WORST SHAPE THIS FEATURE CAN TAKE, and it was reachable. The send path parses `/md` off
    // first, so the Target WAS set and the message really was private - while the chip and the picker
    // read the raw input, where both grammars are anchored, and saw nothing. Privacy applied and
    // invisible. The decoration is the entire mechanism for confirming it before committing, so a
    // mistyped name then produced a public message with no signal either way.
    render(<MessageInput />);
    type('/md .Alice here is the **plan**');

    await waitFor(() => {
      const chip = document.querySelector('.message-input-sticky-target-chip--private');
      expect(chip).not.toBeNull();
      expect(chip!.textContent).toContain('Alice');
    });
  });

  it('opens the privacy picker behind a /md command', async () => {
    render(<MessageInput />);
    type('/md .');

    await waitFor(() => {
      expect(document.querySelector('.mention-dropdown--private')).not.toBeNull();
      const names = [...document.querySelectorAll('.mention-option-name')].map((n) => n.textContent);
      expect(names).toContain('.Alice');
    });
  });

  it('sets the Target and keeps the /md command on the wire', async () => {
    // The command belongs to the message - it is what the person wrote - so only the ADDRESS is
    // lifted out downstream. Both have to survive the send.
    render(<MessageInput />);
    type('/md .Alice here is the **plan**');
    enter();

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const options = sendMessage.mock.calls[0][2] as { targetArn?: string } | undefined;
    expect(options?.targetArn).toBe(ALICE);
    expect(sendMessage.mock.calls[0][0]).toBe('/md .Alice here is the **plan**');
  });

  it('leaves an ordinary @ mention public', async () => {
    render(<MessageInput />);
    type('@Alice quick question');
    enter();

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const options = sendMessage.mock.calls[0][2] as { targetArn?: string } | undefined;
    expect(options?.targetArn).toBeUndefined();
  });

  it('MENTIONS the person it names, so an @ actually notifies them', async () => {
    // The other half of "public and addressed". Without the attribute an `@` at a colleague is plain
    // text that happens to start with a punctuation mark: no platform mention, no push, and the flow
    // deliberately starts no turn for it - so nothing at all would reach the person named.
    render(<MessageInput />);
    type('@Alice quick question');
    enter();

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const options = sendMessage.mock.calls[0][2] as { mentionArns?: string[] } | undefined;
    expect(options?.mentionArns).toEqual([ALICE]);
  });

  it('does NOT mention on a private message, because the Target already routes it', async () => {
    // A `.` message reaches an assistant through `TargetedMessages: ALL` and a person through
    // delivery. Adding the attribute as well would give a targeted assistant a second way in - the
    // duplicate-responder shape - and would mention a member the sender never named in the text.
    render(<MessageInput />);
    type('.Alice are you free');
    enter();

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const options = sendMessage.mock.calls[0][2] as { mentionArns?: string[]; targetArn?: string } | undefined;
    expect(options?.targetArn).toBe(ALICE);
    expect(options?.mentionArns).toBeUndefined();
  });
});
