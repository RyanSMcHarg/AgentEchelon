/**
 * A CONVERSATION NAMES ITSELF, INCLUDING WHEN ITS OPENING WAS QUEUED.
 *
 * The symptom is one line in the sidebar - a conversation stuck at "New conversation" - and it has now
 * been caused twice, by two unrelated mechanisms, with no test in between.
 *
 *   1. `8d32a79` (frontend). A title typed at creation meant the channel was never named exactly
 *      "New conversation", and the rename only touches a channel that is. Every such conversation was
 *      opted out of ever being named from its own content. Fixed by removing the field, so a channel is
 *      always created with the placeholder.
 *   2. This one (backend). The channel WAS eligible, and the rename never ran, because its caller
 *      gated on `isFirstUserTurn` - an ordinal derived from channel history at processor time. Under
 *      ADR-033 a burst is queued and read together, so the first user message may never run as its own
 *      invocation, and by the time one does its own history already holds a user message. The flag
 *      reads false and never becomes true again.
 *
 * Observed live 2026-09-09: three messages in a burst, two processor invocations, neither with an empty
 * user history (`roles: 'au'` then `'auuua'`), no `[channel-title]` line logged at all, and the channel
 * still named "New conversation" afterwards.
 *
 * There was NO test on this path at all - not on the function, not on its gate - which is how the same
 * visible symptom shipped twice. What is pinned here is the part that keeps being got wrong: the
 * decision to rename belongs to the channel's NAME, which is a fact, and not to any count of what has
 * been said so far, which queueing moves.
 */

const mockChimeSend = jest.fn();
const mockBedrockSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: (...a: unknown[]) => mockChimeSend(...a) })),
  DescribeChannelCommand: class { __t = 'Describe'; constructor(public input: any) {} },
  UpdateChannelCommand: class { __t = 'Update'; constructor(public input: any) {} },
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: (...a: unknown[]) => mockBedrockSend(...a) })),
  InvokeModelCommand: class { __t = 'Invoke'; constructor(public input: any) {} },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { maybeDeriveAndRenameChannel } = require('../../lambda/src/lib/channel-title');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/b1';
const PLACEHOLDER = 'New conversation';

/** Haiku's reply, in the shape `InvokeModel` returns it. */
const titleReply = (text: string) => ({
  body: new TextEncoder().encode(JSON.stringify({ content: [{ text }] })),
});

beforeEach(() => {
  mockChimeSend.mockReset();
  mockBedrockSend.mockReset();
});

describe('the rename decides from the channel name, not from what has been said', () => {
  it('names a channel still on the placeholder', async () => {
    mockChimeSend.mockResolvedValueOnce({ Channel: { Name: PLACEHOLDER, Mode: 'RESTRICTED' } });
    mockBedrockSend.mockResolvedValueOnce(titleReply('Agent Echelon overview'));
    mockChimeSend.mockResolvedValueOnce({});

    const applied = await maybeDeriveAndRenameChannel(CHANNEL, 'What is Agent Echelon?', BOT);

    expect(applied).toBe('Agent Echelon overview');
    const update = mockChimeSend.mock.calls[1][0];
    expect(update.__t).toBe('Update');
    expect(update.input.Name).toBe('Agent Echelon overview');
    // The bot renames as ITSELF. Reaching for the service app-instance-admin here would widen the
    // blast radius to work around a grant the bot is meant to hold.
    expect(update.input.ChimeBearer).toBe(BOT);
  });

  it('does NOT depend on the message being the first thing said in the channel', async () => {
    // ── THE DEFECT THIS PINS ────────────────────────────────────────────────────────────────────
    //
    // The function never knew about turn ordinals and still does not; this asserts the CONTRACT the
    // caller is now allowed to rely on. A queued burst reaches the processor with the opening already
    // in history, and that must not be what decides whether the conversation gets a name.
    mockChimeSend.mockResolvedValueOnce({ Channel: { Name: PLACEHOLDER, Mode: 'RESTRICTED' } });
    mockBedrockSend.mockResolvedValueOnce(titleReply('Who built it'));
    mockChimeSend.mockResolvedValueOnce({});

    const applied = await maybeDeriveAndRenameChannel(CHANNEL, 'Who created it', BOT);

    expect(applied).toBe('Who built it');
  });

  it('leaves an already-named channel alone', async () => {
    // Either a person renamed it or an earlier turn derived one. Both are answers, and neither is ours
    // to overwrite - which is also what makes the rename safe to attempt more than once.
    mockChimeSend.mockResolvedValueOnce({ Channel: { Name: 'Q3 planning', Mode: 'RESTRICTED' } });

    expect(await maybeDeriveAndRenameChannel(CHANNEL, 'anything at all', BOT)).toBeNull();
    expect(mockChimeSend).toHaveBeenCalledTimes(1);
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('does not seed a title from a slash command, and spends nothing finding out', async () => {
    expect(await maybeDeriveAndRenameChannel(CHANNEL, '/help', BOT)).toBeNull();
    // Refused before the channel is even described: "/help" is not what the conversation is about.
    expect(mockChimeSend).not.toHaveBeenCalled();
  });

  it('names a conversation a duel opens from the battle prompt, without the command', async () => {
    mockChimeSend.mockResolvedValueOnce({ Channel: { Name: PLACEHOLDER, Mode: 'RESTRICTED' } });
    mockBedrockSend.mockResolvedValueOnce(titleReply('Fox watercolor at dusk'));
    mockChimeSend.mockResolvedValueOnce({});

    expect(await maybeDeriveAndRenameChannel(CHANNEL, '/battle Paint a red fox in snow at dusk', BOT)).toBe('Fox watercolor at dusk');
    // The title model reads the question both sides answer, never the command token.
    const body = mockBedrockSend.mock.calls[0][0].input.body;
    const asked = typeof body === 'string' ? body : new TextDecoder().decode(body);
    expect(asked).toContain('Paint a red fox in snow at dusk');
    expect(asked).not.toContain('/battle');
  });

  it('keeps the placeholder when the derivation gives nothing usable', async () => {
    mockChimeSend.mockResolvedValueOnce({ Channel: { Name: PLACEHOLDER, Mode: 'RESTRICTED' } });
    mockBedrockSend.mockResolvedValueOnce(titleReply(''));

    expect(await maybeDeriveAndRenameChannel(CHANNEL, 'What is Agent Echelon?', BOT)).toBeNull();
    // No UpdateChannel: a channel named "" is worse than one still on the placeholder.
    expect(mockChimeSend).toHaveBeenCalledTimes(1);
  });

  it('never lets a rename failure reach the turn', async () => {
    // The reply is the critical path. A title is a nicety and must never be able to fail a turn.
    mockChimeSend.mockRejectedValueOnce(new Error('Chime is having a day'));

    await expect(maybeDeriveAndRenameChannel(CHANNEL, 'What is Agent Echelon?', BOT))
      .resolves.toBeNull();
  });
});

describe('the caller does not gate the rename on a turn ordinal', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const core: string = fs.readFileSync(
    path.resolve(__dirname, '../..', 'lambda/src/lib/async-processor-core.ts'),
    'utf8',
  );

  it('starts the rename on a bound that a queued burst survives', () => {
    // A SOURCE GUARD, because the gate is inside a long function whose other 30 dependencies are not
    // what this is about, and because the defect was ENTIRELY in which expression the `if` tested.
    const gate = core.indexOf('let titleRename: Promise<unknown> | undefined;');
    const start = core.indexOf('maybeDeriveAndRenameChannel', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(gate);

    const between = core.slice(gate, start);
    // The ordinal must not be what opens this branch again.
    expect(between).not.toContain('if (isFirstUserTurn)');
    expect(between).toContain('if (earlyInConversation && !rivalTurnCannotRename)');
  });

  it('does not ask on behalf of a turn that is not allowed to rename', () => {
    // A DUEL SIDE HAS NOTHING TO NAME, and cannot: it runs as an alt-slot bot which is a member of
    // the channel but not its owner, so `UpdateChannel` is refused. The widened bound above is what
    // exposed this - while the gate was the ordinal, a duel turn never reached the call, because
    // `/battle <prompt>` is itself a user message.
    //
    // Live on the 2026-09-09 sweep: three `ForbiddenException: You do not have sufficient access`
    // renames in one duel, which the e2e backend-error guard reports as a failed turn because the
    // logged error carries `Exception`. Not silenced - not asked for.
    // The room's own side is the exception: it moderates the room, and a duel that opens the conversation is
    // named from its prompt by that side alone. And a turn the router marks as not naming the room (an assistant that is
    // not its primary, whose room the primary names instead, `room-naming.ts`) asks for nothing either.
    expect(core).toContain('const rivalTurnCannotRename = (!!event.battleContext && !event.battleContext.namesConversation) || event.namesConversation === false;');

    const gate = core.indexOf('let titleRename: Promise<unknown> | undefined;');
    const start = core.indexOf('maybeDeriveAndRenameChannel', gate);
    expect(core.slice(gate, start)).toContain('!rivalTurnCannotRename');
  });

  it('marks only the room\'s own side of a round-one duel as the one that names the conversation', () => {
    const router: string = fs.readFileSync(path.resolve(__dirname, '../..', 'lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toContain('...(battleCtx.round === 1 && !altBotArns.has(battleCtx.selfBotArn) && { namesConversation: true })');
  });

  it('keeps the ordinal for the greeting, which really does happen once', () => {
    // NOT collateral. The first-turn greeting means what it says: greeting on every early turn would
    // greet the same person repeatedly, so it keeps the ordinal and accepts that a queued opening
    // costs it. Asserted so that the two gates above are not read as "the ordinal was wrong
    // everywhere" - it was wrong for the two things with a fact of their own to check.
    expect(core).toContain("const isFirstUserTurn = conversationHistory.filter(m => m.role === 'user').length === 0;");

    const handler: string = fs.readFileSync(
      path.resolve(__dirname, '../..', 'lambda/src/assistant-async-processor.ts'),
      'utf8',
    );
    // The greeting still opens on the ordinal, and still appends the directive it always did.
    // The greeting also stands down where an event run already greeted the person (ADR-061), and still keys on the ordinal.
    expect(handler).toContain('const greet = isFirstUserTurn && !(await wasGreetedByEventRun(');
    const composer = fs.readFileSync(path.resolve(__dirname, '../..', 'lambda/src/lib/answer-prompt.ts'), 'utf8');
    expect(composer).toContain('if (c.greet) systemPrompt += firstTurnGreetingDirective');
  });

  it('anchors drift on the early turns, not on an ordinal a queued burst destroys', () => {
    // ── THE OTHER HALF OF THE SAME DEFECT ───────────────────────────────────────────────────────
    //
    // Drift cannot fire at all without a turn-one summary - every early turn skips with
    // `drift_skipped_no_summary` - so a conversation whose opening was queued lost the anchor and
    // could not detect a pivot, in exactly the window a person is most likely to pivot.
    //
    // Asking more than once is safe and does not weaken the once-per-conversation rule: the data
    // plane holds it, selecting from `conversation_summaries` first and inserting
    // `ON CONFLICT DO NOTHING`.
    const handler: string = fs.readFileSync(
      path.resolve(__dirname, '../..', 'lambda/src/assistant-async-processor.ts'),
      'utf8',
    );
    expect(handler).toContain('if (pipeline.earlyInConversation && event.channelArn');
    expect(handler).not.toContain('if (pipeline.isFirstUserTurn && event.channelArn');
  });
});

describe('a room another assistant created is not renamed; a room the service admin created is', () => {
  const ALT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/alt-1';

  it('an alt answering a duel does NOT rename, and does not pay for a title first', async () => {
    // THE DEFECT THIS PINS (observed 2026-09-21 in a live duel). The rename works because the bot is
    // the channel's creator and moderator; a duel's alt joins as an ordinary member and is neither.
    // So its turn reached UpdateChannel, got ForbiddenException, and the swallow logged
    // "Rename skipped (non-fatal)" - which reads as a permissions regression in a feature that had
    // been working, because every non-battle turn IS answered by the creator.
    mockChimeSend.mockResolvedValueOnce({
      Channel: { Name: PLACEHOLDER, Mode: 'RESTRICTED', CreatedBy: { Arn: BOT } },
    });

    const applied = await maybeDeriveAndRenameChannel(CHANNEL, 'What is a feature flag?', ALT);

    expect(applied).toBeNull();
    // No UpdateChannel: the Describe is the only call made.
    expect(mockChimeSend.mock.calls.filter((c) => c[0].__t === 'Update')).toHaveLength(0);
    // AND NO DERIVATION. Asking Haiku for a title we may not apply spends a model call on every duel
    // turn to produce a string that is thrown away, which is why the check runs before it.
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('the creator still renames, so the guard is not simply refusing everything', async () => {
    mockChimeSend.mockResolvedValueOnce({
      Channel: { Name: PLACEHOLDER, Mode: 'RESTRICTED', CreatedBy: { Arn: BOT } },
    });
    mockBedrockSend.mockResolvedValueOnce(titleReply('Feature flags'));
    mockChimeSend.mockResolvedValueOnce({});

    expect(await maybeDeriveAndRenameChannel(CHANNEL, 'What is a feature flag?', BOT)).toBe('Feature flags');
  });

  it('renames a conversation the service admin created, which is every person-created one', async () => {
    // THE DEFECT THIS PINS (observed 2026-10-14 on dev). Person-created rooms are created by the service
    // admin and the assistant is added as moderator afterwards, so a creator-only rule logged "did not
    // create the channel" and left every such conversation named "New conversation".
    const ADMIN = 'arn:aws:chime:us-east-1:1:app-instance/i/user/agent-echelon-admin';
    mockChimeSend.mockResolvedValueOnce({
      Channel: { Name: PLACEHOLDER, Mode: 'RESTRICTED', CreatedBy: { Arn: ADMIN } },
    });
    mockBedrockSend.mockResolvedValueOnce(titleReply('What Is AgentEchelon'));
    mockChimeSend.mockResolvedValueOnce({});

    expect(await maybeDeriveAndRenameChannel(CHANNEL, 'What is AgentEchelon?', BOT)).toBe('What Is AgentEchelon');
    expect(mockChimeSend.mock.calls.filter((c) => c[0].__t === 'Update')).toHaveLength(1);
  });

  it('a non-moderator in an admin-created room is refused by the service, and that is not a warning', async () => {
    const ADMIN = 'arn:aws:chime:us-east-1:1:app-instance/i/user/agent-echelon-admin';
    mockChimeSend.mockResolvedValueOnce({
      Channel: { Name: PLACEHOLDER, Mode: 'RESTRICTED', CreatedBy: { Arn: ADMIN } },
    });
    mockBedrockSend.mockResolvedValueOnce(titleReply('Feature flags'));
    mockChimeSend.mockRejectedValueOnce(Object.assign(new Error('no access'), { name: 'ForbiddenException' }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await maybeDeriveAndRenameChannel(CHANNEL, 'What is a feature flag?', ALT)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('renames when the channel does not say who created it, rather than refusing', async () => {
    // Absent is not "somebody else". A deployment whose DescribeChannel omits CreatedBy must keep
    // naming its conversations; failing closed here would silently disable the feature everywhere.
    mockChimeSend.mockResolvedValueOnce({ Channel: { Name: PLACEHOLDER, Mode: 'RESTRICTED' } });
    mockBedrockSend.mockResolvedValueOnce(titleReply('Feature flags'));
    mockChimeSend.mockResolvedValueOnce({});

    expect(await maybeDeriveAndRenameChannel(CHANNEL, 'What is a feature flag?', BOT)).toBe('Feature flags');
  });
});
