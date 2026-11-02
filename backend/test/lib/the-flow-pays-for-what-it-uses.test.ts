/**
 * THE FLOW PAYS FOR WHAT IT USES, AND ORDINARY CHATTER USES ALMOST NOTHING.
 *
 * This function is synchronous with Amazon Chime SDK waiting on it and runs on EVERY message,
 * human-to-human included, so what it spends before it knows whether it has anything to do is paid by
 * every conversation in the deployment (MESSAGE-FLOW 4.17, 4.18).
 *
 * THE DEFECT THESE PIN. The channel's classification tag and the conversation's primary assistant were
 * both resolved at the top of the person pass, ABOVE the prefilters that decide whether either answer
 * is wanted. A message with no `@`, no `.` and no command - the overwhelming majority of what a busy
 * room carries - paid a `ListTagsForResource` and, on a cold container, an `ssm:GetParameter`, and then
 * reached no check that read either one. The prefilters below them already existed to keep the roster
 * read off exactly that message.
 *
 * WHY EACH HALF NEEDS ITS OWN ASSERTION. Moving a read later is only correct if every consumer still
 * gets it, and a consumer that quietly resolves an UNDEFINED classification is a fail-open on the
 * boundary IAM evaluates (SPEC-CONVERSATION-SECURITY Layer 1). So the cheap half is pinned alongside
 * the non-vacuity half: an addressed message still reads both, and still resolves the same
 * classification it did before - which is what says the saving came from deferral rather than from the
 * read going missing.
 *
 * AND THE TAG IS MEMOIZED, because it cannot change: it is the Layer-1 boundary, `chime:UpdateChannel`
 * cannot write it, and nothing re-tags a channel after creation. A memo keyed by the wrong thing would
 * be far worse than the read it replaces, so the memo is pinned per channel rather than per container:
 * a second conversation reads its own tag and routes to its own classification.
 */
const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ChannelFlowCallbackCommand: jest.fn().mockImplementation((args) => ({ __type: 'Callback', input: args })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
  GetChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetMessage', input: args })),
  DeleteChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'DeleteMessage', input: args })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((args) => ({ __type: 'Invoke', input: args })),
  InvocationType: { Event: 'Event', RequestResponse: 'RequestResponse' },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetParam', input: args })),
  GetParametersByPathCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetByPath', input: args })),
}), { virtual: true });

// The durable claims are not what these cases are about; every one of them succeeds so the dispatch
// paths run to the point the reads can be counted.
// Spread, not listed: a mock that enumerates the module is a snapshot of it, and adding
// `flowDeliveryKey` to `abuse-controls` broke every case here with "is not a function" in a file that
// only wanted the claims to succeed.
jest.mock('../../lambda/src/lib/abuse-controls.js', () => ({
  ...jest.requireActual('../../lambda/src/lib/abuse-controls.js'),
  claimCorrelation: async () => true,
  claimPlaceholderMapping: async () => true,
  evaluateAbuseGate: async () => ({ allowed: true }),
}), { virtual: true });

/** The duel's own state, stubbed to the one shape these cases need: a live, claimable battle. */
jest.mock('../../lambda/src/lib/battle-state.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/battle-state.js');
  return {
    ...actual,
    loadChannelBattleConfig: async () => ({ channelArn: 'c', enabled: true }),
    resolveActiveBattleId: async () => null,
    resolveActiveBattle: async () => null,
    readBattleRows: async () => [],
    tryClaimRound1Fanout: async () => true,
    setActiveBattle: async () => undefined,
    initBotState: async () => undefined,
  };
}, { virtual: true });

/** The experiments gate. Empty, and a config with no bound experiment is runnable regardless. */
jest.mock('../../lambda/src/lib/experiment-manager.js', () => ({
  listExperimentsCached: async () => [],
}), { virtual: true });

const INSTANCE = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${INSTANCE}/channel/c1`;
const OTHER_CHANNEL = `${INSTANCE}/channel/c2`;
const BASIC_BOT = `${INSTANCE}/bot/basic-bot`;
const PREMIUM_BOT = `${INSTANCE}/bot/premium-bot`;
const RIVAL_BOT = `${INSTANCE}/bot/premium-alt`;
const ALICE = `${INSTANCE}/user/alice`;
const BOB = `${INSTANCE}/user/bob`;
const ROUTER_BASIC = 'arn:aws:lambda:us-east-1:111122223333:function:router-basic';
const ROUTER_PREMIUM = 'arn:aws:lambda:us-east-1:111122223333:function:router-premium';
const PLACEHOLDER = 'One moment... <!--corr:mention-abc-->';

const GROUP = [
  { Member: { Arn: ALICE, Name: 'Alice' } },
  { Member: { Arn: BOB, Name: 'Bob' } },
  { Member: { Arn: BASIC_BOT, Name: 'Atlas' } },
];

/** A premium room with two assistants in it: the only shape a duel can run in. */
const DUEL_ROOM = [
  { Member: { Arn: ALICE, Name: 'Alice' } },
  { Member: { Arn: PREMIUM_BOT, Name: 'Atlas' } },
  { Member: { Arn: RIVAL_BOT, Name: 'Nova' } },
];

function flowEvent(content: string, channelArn = CHANNEL) {
  return {
    CallbackId: `cb-${Math.random().toString(36).slice(2)}`,
    EventType: 'CHANNEL_MESSAGE',
    ChannelMessage: {
      MessageId: `m-${Math.random().toString(36).slice(2)}`,
      Content: content,
      Metadata: undefined,
      Sender: { Arn: ALICE, Name: 'Alice' },
      ChannelArn: channelArn,
    },
  };
}

const callsOfType = (type: string) => mockMessagingSend.mock.calls.filter((c) => c[0]?.__type === type);
const tagReads = () => callsOfType('ListTags').length;
const rosterReads = () => callsOfType('ListMemberships').length;
// The vend's ARN is read once per container when the flow first speaks as an assistant; it is not a
// per-message cost of routing, so it is not counted here.
const ssmReads = () => mockSsmSend.mock.calls
  .filter((c) => c[0]?.__type === 'GetParam' && !String(c[0]?.input?.Name).endsWith('/vend-arn')).length;

const invokes = () => mockLambdaSend.mock.calls
  .filter((c) => c[0]?.__type === 'Invoke')
  .map((c) => c[0].input.FunctionName as string);

/** ALLOWED, not DENIED. A denied message is never persisted - it leaves the room entirely. */
const releases = () => mockMessagingSend.mock.calls.filter(
  (c) => c[0]?.__type === 'Callback' && !c[0]?.input?.DeleteResource,
);

describe('what the flow spends on a message nobody addressed', () => {
  let handler: (e: any) => Promise<void>;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  /** Tags per channel, so a memo keyed by the wrong thing shows up as the wrong classification. */
  const withChannels = (tags: Record<string, string>, memberships: unknown[] = GROUP) => {
    mockMessagingSend.mockImplementation((cmd: { __type: string; input?: { ResourceARN?: string } }) => {
      if (cmd.__type === 'ListTags') {
        return Promise.resolve({
          Tags: [{ Key: 'classification', Value: tags[cmd.input?.ResourceARN ?? ''] ?? 'basic' }],
        });
      }
      if (cmd.__type === 'ListMemberships') return Promise.resolve({ ChannelMemberships: memberships });
      if (cmd.__type === 'GetMessage') return Promise.resolve({ ChannelMessage: { Target: [{ MemberArn: BOB }] } });
      return Promise.resolve({ ChannelMessage: { MessageId: 'placeholder-1' }, MessageId: 'placeholder-1' });
    });
  };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.BASIC_ROUTER_ARN = ROUTER_BASIC;
    process.env.STANDARD_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:router-standard';
    process.env.PREMIUM_ROUTER_ARN = ROUTER_PREMIUM;
    // The ASSIGNMENT record's shape: the flow resolves the live occupant of the primary role through it.

    mockSsmSend.mockImplementation((cmd: { __type?: string; input: { Name: string; Path?: string } }) => {
      // THE LIVE ASSIGNMENT RECORDS, which name the assistant on each bot. A duel is metered at the
      // limit of the live side's own assistant, read from them.
      if (cmd.__type === 'GetByPath') {
        const premium = (cmd.input.Path || '').includes('premium');
        return Promise.resolve({ Parameters: [{ Value: JSON.stringify({
          role: 'primary', occupancy: 'live', assistant: premium ? 'advisor' : 'concierge', botArn: premium ? PREMIUM_BOT : BASIC_BOT,
        }) }] });
      }
      // THE BATTLE SWITCH IS A DIFFERENT PARAMETER WITH A DIFFERENT SHAPE (ADR-049).
      //
      // `isBattleOn` reads `.../battle/<classification>/enabled` and requires the literal string
      // 'true' (`lib/battle-enablement.ts:78`). This mock used to answer EVERY GetParameter with the
      // assistant-roster JSON blob, so that gate read the blob, saw it was not 'true', and reported
      // battle OFF - which made `/battle` refuse with a hint and fan out to nobody. The duel case
      // below then failed for a reason that had nothing to do with roster reads.
      //
      // The gate was added AFTER this fixture was written, which is why a blanket mock stopped being
      // a safe shortcut: it answers questions the test does not know are being asked.
      if (cmd.input.Name.includes('/battle/')) {
        return Promise.resolve({ Parameter: { Value: 'true' } });
      }
      return Promise.resolve({
        Parameter: { Value: JSON.stringify({ role: 'primary', occupancy: 'live', botArn: cmd.input.Name.includes('premium') ? PREMIUM_BOT : BASIC_BOT }) },
      });
    });
    mockLambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({
        sessionState: { dialogAction: { type: 'Close' }, intent: { name: 'FallbackIntent', state: 'Fulfilled' } },
        messages: [{ contentType: 'PlainText', content: PLACEHOLDER }],
      })),
    });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    withChannels({ [CHANNEL]: 'basic', [OTHER_CHANNEL]: 'premium' });
    ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  it('reads no parameter and no roster for a message with no token in it', async () => {
    await handler(flowEvent('the deploy finished, thanks for picking that up'));

    // THE FLOOR UNDER THE FLOW ENTRY, which is now the project default. Every profile enters through
    // the channel flow, so the flow starts EVERY untargeted turn - including this one, in a 1:1 - and
    // the prefilter that used to keep an unaddressed message free has stopped being a gate.
    //
    // NO TAG READ, AND THAT IS THE PART WORTH PINNING. Resolving the entry means resolving which
    // profile serves the conversation, which is a classification tag read. But the profiles all
    // ANSWER THE SAME WAY, so there is nothing to look up: `sharedTurnEntry` supplies the agreed
    // value and `entryVariesByProfile` is false. A deployment that sets one profile back to 'lex'
    // makes it true and the read returns, which is correct - only then does the tag decide.
    //
    // WHAT IS PAID INSTEAD is the roster, because deciding whether this is a 1:1 needs a live
    // `ListChannelMemberships`, and the bearer that read needs. ADR-041 rule 4 puts both AFTER
    // `callbackAllow`, so they are not in front of the person seeing their own words.
    // ONE tag read, and NOT for the entry. `entryVariesByProfile` is false, so the entry is taken
    // from `sharedTurnEntry` with no lookup at all. The tag is still read once because the flow has
    // to know which classification to dispatch to - it is the routing read, which only a message that
    // DISPATCHES pays, and this one now does.
    expect(`tag reads: ${tagReads()}`).toBe('tag reads: 1');
    expect({ ssmReads: ssmReads(), rosterReads: rosterReads() })
      .toEqual({ ssmReads: 1, rosterReads: 1 });
    // Released exactly once, and released BEFORE the roster read - rule 4. A second release would be
    // the double-callback this file's sibling guards.
    expect(releases()).toHaveLength(1);
    // NOTHING IS DISPATCHED, and that is the group rule rather than the entry rule. This roster is a
    // GROUP, where a message nobody addressed is nobody's turn under either entry - an assistant does
    // not answer people talking to each other. What the flow entry changed is that the roster now has
    // to be READ to find that out, where the token prefilter used to answer it for free.
    expect(invokes()).toEqual([]);
  });

  it('still reads both for an ADDRESSED message, and resolves the same classification', async () => {
    // The non-vacuity half. Deferring a read is only a saving if the read still happens where it is
    // needed - and the classification is what picks the router, so a lost one is silent and routes the
    // turn to the wrong assistant's boundary rather than failing.
    await handler(flowEvent('@Atlas what did we decide?'));

    expect({ tagReads: tagReads(), ssmReads: ssmReads() }).toEqual({ tagReads: 1, ssmReads: 1 });
    expect(invokes()).toEqual([ROUTER_BASIC]);
  });

  it('reads the tag ONCE for a second addressed message in the same conversation', async () => {
    // The tag is immutable, so the second read asked a question that could not have a new answer.
    await handler(flowEvent('@Atlas one more thing'));
    await handler(flowEvent('@Atlas and another'));

    expect({ tagReads: tagReads(), ssmReads: ssmReads() }).toEqual({ tagReads: 1, ssmReads: 1 });
    expect(invokes()).toEqual([ROUTER_BASIC, ROUTER_BASIC]);
  });

  it('does not answer one conversation from another conversations memo', async () => {
    // The memo is per CHANNEL. Keyed per container instead, the second room here would answer at
    // `basic` - a premium conversation quietly routed to a lower assistant, which is the Layer-1
    // boundary being decided by whichever message the container happened to see first.
    await handler(flowEvent('@Atlas what did we decide?', CHANNEL));
    await handler(flowEvent('@Atlas what did we decide?', OTHER_CHANNEL));

    expect(tagReads()).toBe(2);
    expect(invokes()).toEqual([ROUTER_BASIC, ROUTER_PREMIUM]);
  });

  it('does not memoize a tag it could not read, so one failure does not pin a conversation to the floor', async () => {
    // The resolver fails CLOSED to the floor classification, which is the right answer for one turn
    // and the wrong thing to keep: a single throttled read would otherwise answer every later message
    // in a premium room at `basic` for the life of the container.
    let failNext = true;
    mockMessagingSend.mockImplementation((cmd: { __type: string }) => {
      if (cmd.__type === 'ListTags') {
        if (failNext) { failNext = false; return Promise.reject(new Error('Throttled')); }
        return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'premium' }] });
      }
      if (cmd.__type === 'ListMemberships') return Promise.resolve({ ChannelMemberships: GROUP });
      return Promise.resolve({ ChannelMessage: { MessageId: 'p' }, MessageId: 'p' });
    });

    await handler(flowEvent('@Atlas first'));
    await handler(flowEvent('@Atlas second'));

    expect(tagReads()).toBe(2);
    // NOBODY ANSWERED THE FIRST TURN, AND THAT IS THE CHANGE (ADR-045 decision 2). It used to read
    // `[ROUTER_BASIC, ROUTER_PREMIUM]`: the floor answered the throttled turn, so a premium
    // conversation got a basic assistant for one message. There is no floor to answer with now, so an
    // unreadable tag dispatches nothing and the person asks again.
    //
    // The property this case is named for is unchanged and is what the second turn proves: the failed
    // read was not memoized, so the retry resolves the REAL tag rather than a remembered floor.
    expect(invokes()).toEqual([ROUTER_PREMIUM]);
  });

  it('reads the roster ONCE for a duel, not once to address it and again to count its assistants', async () => {
    // The bot-member gate used to make a second `ListChannelMemberships` of its own, bounded at one
    // page against the address pass's ten - so a duel in a room past 50 members gated on a different
    // roster from the one that resolved the message's addressing.
    withChannels({ [OTHER_CHANNEL]: 'premium' }, DUEL_ROOM);
    // A deployment that declares `battle`, which names the battle-setting table to the flow (`battleDeclared`).
    process.env.CHANNEL_BATTLE_CONFIG_TABLE = 'channel-battle-config';
    try {
      await handler(flowEvent('/battle what should we prioritise?', OTHER_CHANNEL));
    } finally {
      delete process.env.CHANNEL_BATTLE_CONFIG_TABLE;
    }

    expect(rosterReads()).toBe(1);
    // And it really did fan out, so the single read answered the gate rather than skipping it.
    expect(invokes()).toEqual([ROUTER_PREMIUM, ROUTER_PREMIUM]);
  });

  it('reads no battle setting and invokes no side in a deployment that does not declare battle', async () => {
    // No `battle`: the flow is named no battle-setting table, so `/battle` answers with the unavailable notice and
    // never asks for the operator's setting, which only the Battle stack grants.
    withChannels({ [OTHER_CHANNEL]: 'premium' }, DUEL_ROOM);

    await handler(flowEvent('/battle what should we prioritise?', OTHER_CHANNEL));

    const battleReads = mockSsmSend.mock.calls.filter((c) => c[0]?.__type === 'GetParam' && String(c[0]?.input?.Name).includes('/battle/'));
    expect(battleReads).toEqual([]);
    // One invoke, the room's router saying the notice; a duel would have invoked both sides.
    const notices = mockLambdaSend.mock.calls
      .filter((c) => c[0]?.__type === 'Invoke')
      .map((c) => JSON.parse(Buffer.from(c[0].input.Payload).toString()).aeNotice?.kind);
    expect(notices).toEqual(['battleUnavailable']);
  });
});

describe('when the conversation has no resolvable primary assistant', () => {
  let handler: (e: any) => Promise<void>;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.BASIC_ROUTER_ARN = ROUTER_BASIC;
    mockMessagingSend.mockImplementation((cmd: { __type: string }) => {
      if (cmd.__type === 'ListTags') return Promise.resolve({ Tags: [{ Key: 'classification', Value: 'basic' }] });
      if (cmd.__type === 'ListMemberships') return Promise.resolve({ ChannelMemberships: GROUP });
      return Promise.resolve({ ChannelMessage: { MessageId: 'p' }, MessageId: 'p' });
    });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    ({ handler } = await import('../../lambda/src/channel-flow-processor.js'));
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  /**
   * THE DEGRADATION, AND WHY IT IS THIS ONE.
   *
   * Every action left on this path - the roster read, the private-address read-back, the delete, the
   * notices, the dispatch - is made AS the assistant, and there is no assistant to be. The only thing
   * that does not need a bearer is the callback. So the message is released unprocessed, in
   * milliseconds and with a line saying why, instead of being released unprocessed 35 seconds later by
   * `FallbackAction: CONTINUE` after the invocation failed.
   */
  it.each([
    ['the parameter is empty', { Parameter: {} }, null],
    ['the parameter cannot be read', null, new Error('AccessDeniedException')],
  ])('releases the message unprocessed when %s, rather than timing out', async (_name, resolved, rejected) => {
    if (rejected) mockSsmSend.mockRejectedValue(rejected);
    else mockSsmSend.mockResolvedValue(resolved);

    // It RESOLVES. Throwing is what made this a 35-second timeout and an Amazon Chime SDK retry.
    await expect(handler(flowEvent('@Atlas are you there?'))).resolves.toBeUndefined();

    // Released, with the person's own words, and nothing dispatched.
    expect(releases()).toHaveLength(1);
    expect(releases()[0][0].input.ChannelMessage.Content).toBe('@Atlas are you there?');
    expect(invokes()).toEqual([]);
    // No roster read either: the bearer is what would have read it.
    expect(rosterReads()).toBe(0);
    // And it is a decision the code made, said out loud.
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain('no primary assistant');
  });

  it('releases an unaddressed message even when the bearer cannot be read at all', async () => {
    mockSsmSend.mockRejectedValue(new Error('AccessDeniedException'));

    await handler(flowEvent('sounds good to me'));

    // THE BEARER IS NOW REACHED FOR ON EVERY MESSAGE, because under the flow entry every untargeted
    // turn is the flow's to start, and deciding that needs the roster, which needs a bearer to read
    // it as. So this case stopped being "never asks" and became the one that matters more: the ask
    // FAILS, and the person's message must still reach the room.
    //
    // `resolvePrimaryBearer` returning null releases and stands down rather than throwing. The
    // alternative is the flow timing out and `FallbackAction: CONTINUE` delivering the message
    // UNPROCESSED - with the raw envelope instead of the unwrapped text - 35 seconds later.
    expect(`ssm reads: ${ssmReads()}`).toBe('ssm reads: 1');
    // The tag is read once, for routing rather than for the entry: the profiles agree, so the entry
    // itself costs no lookup.
    expect(`tag reads: ${tagReads()}`).toBe('tag reads: 1');
    expect(releases()).toHaveLength(1);
    // No turn started, because there is no assistant to start one as.
    expect(invokes()).toEqual([]);
    // AND IT IS LOGGED LOUDLY, which is a change worth asserting rather than tolerating. Under the
    // Amazon Lex entry an unaddressed message never reached the bearer at all, so a broken SSM read
    // was invisible on this path. Now every message resolves one, so a deployment whose assistant
    // parameter is unreadable says so on every message instead of silently answering nothing - and
    // silently answering nothing is exactly the failure the flow entry makes possible.
    expect(error).toHaveBeenCalled();
  });
});
