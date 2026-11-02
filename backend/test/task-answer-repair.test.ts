/**
 * THE REPAIR FOR AN ANSWER THAT REACHED NO ASSISTANT (ADR-032).
 *
 * A person answers a question an assistant asked them, addresses nobody, and nothing runs. This
 * component dispatches that turn from the message stream, after delivery, so the person is answered
 * late rather than never.
 *
 * WHAT THESE TESTS ARE FOR, and it is not the happy path. Every failure this component can have looks
 * like success from outside:
 *  - it repairs a message that was ALREADY delivered ⇒ the person gets two answers, and nothing errors;
 *  - it repairs a bystander's remark ⇒ someone else's workflow advances on words that were not for it;
 *  - it repairs a duplicate stream delivery ⇒ the same, twice, from one message;
 *  - it succeeds silently ⇒ the client defect becomes invisible and the repair becomes the design
 *    (tenet 6), which is the one failure that gets worse the longer it works.
 * So the assertions here are mostly about what it declines to do, and about the counter.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
}), { virtual: true });

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn().mockImplementation((args) => ({ __type: 'Invoke', input: args })),
  InvocationType: { Event: 'Event', RequestResponse: 'RequestResponse' },
}), { virtual: true });

/** Keys a previous delivery has already claimed, so a redelivery can be exercised. */
const mockAlreadyClaimed = new Set<string>();
const mockClaims: string[] = [];

jest.mock('../lambda/src/lib/abuse-controls.js', () => ({
  claimCorrelation: async (key: string) => {
    mockClaims.push(key);
    return !mockAlreadyClaimed.has(key);
  },
  // The real key, not a stand-in: the repair competes for the CHANNEL FLOW's claim to find out
  // whether the flow already dispatched this message, so a mock that spelled it differently would
  // make every one of these tests pass against a key nothing else ever takes.
  flowDeliveryKey: (messageId: string) => `flow-${messageId}`,
}), { virtual: true });

const mockGetTask = jest.fn();

jest.mock('../lambda/src/lib/task-tracking.js', () => {
  const actual = jest.requireActual('../lambda/src/lib/task-tracking.js');
  return {
    ...actual,
    getTask: (...a: unknown[]) => mockGetTask(...a),
  };
}, { virtual: true });

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
const HUMAN = `${APP}/user/alice`;
const BYSTANDER = `${APP}/user/bob`;
const OWNING_BOT = `${APP}/bot/AltSlot0`;
const SOME_BOT = `${APP}/bot/premium-bot`;

process.env.STANDARD_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:AgentEchelonAssistants-standard-Handler';
process.env.PREMIUM_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:AgentEchelonAssistants-premium-Handler';
process.env.BASIC_ROUTER_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:AgentEchelonAssistants-basic-Handler';

// Exercised through the post-processing ENTRY rather than by calling the rule directly: the entry is
// what Kinesis invokes, and a rule that works when called by hand but is not wired into the consumer
// is exactly the inert mechanism this repo has shipped before.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/src/message-post-processing');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { decideRepair, botArnInChannel } = require('../lambda/src/lib/task-answer-repair');

/** One Chime stream record, as Kinesis delivers it. */
const record = (event: unknown) => ({
  kinesis: { data: Buffer.from(JSON.stringify(event)).toString('base64') },
});

/** A person's message, untargeted, carrying the client's task reference. */
const answer = (overrides: Record<string, unknown> = {}) => ({
  EventType: 'CREATE_CHANNEL_MESSAGE',
  Payload: {
    MessageId: 'm-1',
    ChannelArn: CHANNEL,
    Content: encodeURIComponent('the audience is engineering leadership'),
    Metadata: JSON.stringify({ task: { id: 't-1' } }),
    Sender: { Arn: HUMAN, Name: 'Alice' },
    ...overrides,
  },
});

/** The task the hint names: held by the person, owned by the assistant that asked. */
const task = (overrides: Record<string, unknown> = {}) => ({
  taskId: 't-1',
  channelArn: CHANNEL,
  status: 'in_progress',
  taskState: 'collecting_requirements',
  assistantId: 'AltSlot0',
  assigneeId: 'alice',
  assigneeType: 'user',
  ...overrides,
});

/** Every turn dispatched, with its payload decoded. */
const dispatches = () => mockLambdaSend.mock.calls
  .map((c) => c[0])
  .filter((c) => c?.__type === 'Invoke')
  .map((c) => ({
    fn: c.input.FunctionName as string,
    invocationType: c.input.InvocationType as string,
    aeTurn: JSON.parse(Buffer.from(c.input.Payload).toString()).aeTurn,
  }));

/** The EMF metric names this run emitted. */
const metrics = () => (console.log as jest.Mock).mock.calls
  .map((c) => c[0])
  .filter((line): line is string => typeof line === 'string' && line.includes('"_aws"'))
  .map((line) => JSON.parse(line))
  .flatMap((doc) => doc._aws.CloudWatchMetrics[0].Metrics.map((m: { Name: string }) => m.Name));

/** The `Reason` each emitted `Unresolved` metric carried. */
const unresolvedReasons = () => (console.log as jest.Mock).mock.calls
  .map((c) => c[0])
  .filter((line): line is string => typeof line === 'string' && line.includes('"_aws"'))
  .map((line) => JSON.parse(line))
  .filter((doc) => doc.Unresolved === 1)
  .map((doc) => doc.Reason);

beforeEach(() => {
  jest.clearAllMocks();
  mockAlreadyClaimed.clear();
  mockClaims.length = 0;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockGetTask.mockResolvedValue(task());
  // A group conversation (three members) whose classification tag says premium.
  mockMessagingSend.mockImplementation(async (cmd: { __type: string }) => {
    if (cmd.__type === 'ListMemberships') {
      return { ChannelMemberships: [{ Member: { Arn: HUMAN } }, { Member: { Arn: BYSTANDER } }, { Member: { Arn: OWNING_BOT } }] };
    }
    if (cmd.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
    return {};
  });
  mockLambdaSend.mockResolvedValue({});
});

afterEach(() => jest.restoreAllMocks());

describe('what the record alone decides', () => {
  it('repairs a person\'s untargeted answer that names a task', () => {
    expect(decideRepair(answer())).toMatchObject({ repair: true, taskId: 't-1', messageId: 'm-1' });
  });

  it('LEAVES A TARGETED MESSAGE ALONE - it already reached an assistant', () => {
    // The whole point of the client stamping a Target: the message reaches the addressed bot's Lex,
    // the turn runs, and what it answers is resolved from the chain (ADR-030) - including when the
    // person addressed the WRONG assistant, which is handed over rather than repaired. Dispatching
    // here would answer one message twice, and both answers would look correct.
    expect(decideRepair(answer({ Target: [{ MemberArn: OWNING_BOT }] })))
      .toEqual({ repair: false, reason: 'targeted' });
  });

  it('leaves a message targeted at a PERSON alone too', () => {
    // Not merely the cheap direction. A targeted message is a private delivery, and this repair's
    // answer is posted publicly (ADR-030) - so dispatching a turn into a private aside would surface
    // it to the whole room.
    expect(decideRepair(answer({ Target: [{ MemberArn: BYSTANDER }] })))
      .toEqual({ repair: false, reason: 'targeted' });
  });

  it('LEAVES A MENTIONED MESSAGE ALONE, which carries no Target at all', () => {
    // The gap a Target check cannot see. Amazon Chime SDK routes a message mentioning a bot to that
    // bot's Lex via `CHIME.mentions`, and the message has no `Target` field - so on targeting alone it
    // is indistinguishable from one that reached nobody. Measured on the live stream: the record
    // carries MessageAttributes with the full mention ARNs.
    expect(decideRepair(answer({
      MessageAttributes: { 'CHIME.mentions': { StringValues: [OWNING_BOT] } },
    }))).toEqual({ repair: false, reason: 'mentioned' });
  });

  it('leaves `@all` and `/battle` alone - the CHANNEL FLOW claims those turns', () => {
    // Neither carries a Target or a mention; the flow matches the token in the content and takes the
    // turn. Post-processing is the third component in that seam and stands down for the same reason
    // the router does, using the same shared matcher so the three cannot drift.
    expect(decideRepair(answer({ Content: encodeURIComponent('@all what do we think?') })))
      .toEqual({ repair: false, reason: 'bypass-token' });
    expect(decideRepair(answer({ Content: encodeURIComponent('/battle tabs or spaces?') })))
      .toEqual({ repair: false, reason: 'bypass-token' });
  });

  it('leaves a message that starts with a task reference alone - the CHANNEL FLOW routes those (ADR-035)', () => {
    // The composer sends a shared item's `#n` reply with the task id and no mention, because the flow
    // routes it from the text. Repairing it too answered the message twice: measured live, the second
    // entry found the first turn busy and queued the message behind its own answer.
    expect(decideRepair(answer({ Content: encodeURIComponent('#2 EMEA only, one page') })))
      .toEqual({ repair: false, reason: 'task-reference' });
    // Only at the start: a sentence that mentions a number is still repairable.
    expect(decideRepair(answer({ Content: encodeURIComponent('we ranked it #1 last quarter') })).repair)
      .toBe(true);
  });

  it('ignores an ordinary message with no task reference', () => {
    // The common case, and the reason the filter is pure and cheap: this runs on every message in
    // the deployment.
    expect(decideRepair(answer({ Metadata: undefined }))).toEqual({ repair: false, reason: 'no-task-hint' });
    expect(decideRepair(answer({ Metadata: JSON.stringify({ attachment: { fileKey: 'k' } }) })))
      .toEqual({ repair: false, reason: 'no-task-hint' });
  });

  it('never treats an assistant\'s own message as a person answering', () => {
    // Structural loop safety: the turn this dispatches posts messages of its own, and they cross this
    // same stream.
    expect(decideRepair(answer({ Sender: { Arn: SOME_BOT } }))).toEqual({ repair: false, reason: 'bot-authored' });
  });

  it('acts on a NEW message only', () => {
    // An edit re-enters the stream. Repairing an UPDATE would dispatch a second turn for a message
    // that has already been repaired, and the claim would not stop it - it is a different event on
    // the same id only after the claim window.
    expect(decideRepair({ ...answer(), EventType: 'UPDATE_CHANNEL_MESSAGE' }))
      .toEqual({ repair: false, reason: 'not-a-new-message' });
    expect(decideRepair({ ...answer(), EventType: 'REDACT_CHANNEL_MESSAGE' }))
      .toEqual({ repair: false, reason: 'not-a-new-message' });
  });
});

describe('the dispatch', () => {
  it('hands the turn to the assistant the TASK names, over the ordinary bypass', async () => {
    await handler({ Records: [record(answer())] });

    expect(dispatches()).toHaveLength(1);
    const [d] = dispatches();
    // The premium router, because the CHANNEL is premium - not because of anything the message said.
    expect(d.fn).toBe(process.env.PREMIUM_ROUTER_ARN);
    // Fire and forget: the repair is finished once the work is somewhere it can be done.
    expect(d.invocationType).toBe('Event');
    // The assistant off the task, never off the hint.
    expect(d.aeTurn.botArn).toBe(OWNING_BOT);
    expect(d.aeTurn.senderArn).toBe(HUMAN);
    expect(d.aeTurn.userMessage).toBe('the audience is engineering leadership');
    // The inbound id, so the turn's correlation id is declared rather than derived.
    expect(d.aeTurn.userMessageId).toBe('m-1');
  });

  it('POSTS NOTHING ITSELF', async () => {
    // A repair that answered would be a second implementation of a turn, which is the divergence this
    // whole design exists to avoid. The turn posts its own acknowledgement and its own answer.
    await handler({ Records: [record(answer())] });
    expect(mockMessagingSend.mock.calls.map((c) => c[0].__type)).not.toContain('SendMessage');
  });

  it('reads the assistant off the task and ignores one the client tries to name', async () => {
    // A copy in metadata would be a second source for a fact the task already holds, free to disagree
    // with it - and a wrong copy would dispatch a turn to the wrong assistant.
    await handler({
      Records: [record(answer({ Metadata: JSON.stringify({ task: { id: 't-1', assistant: 'premium-bot' } }) }))],
    });
    expect(dispatches()[0].aeTurn.botArn).toBe(OWNING_BOT);
  });

  it('COUNTS EVERY REPAIR (ADR-032 tenet 6)', async () => {
    // A stream-side fix that silently succeeds is indistinguishable from the defect not existing, so
    // the client never gets corrected and this path becomes the primary one by default.
    await handler({ Records: [record(answer())] });
    expect(metrics()).toContain('Repairs');
  });
});

describe('what it refuses to repair', () => {
  it('refuses a message from someone who does not hold the task', async () => {
    // A bystander's remark, stamped with a task id their client could see. Repairing it would advance
    // someone else's work on words that were not about it - and the person who DOES owe the answer
    // would never know.
    await handler({ Records: [record(answer({ Sender: { Arn: BYSTANDER } }))] });
    expect(dispatches()).toHaveLength(0);
    expect(metrics()).toContain('Unresolved');
  });

  it('refuses when the hint names no task in this channel', async () => {
    // The key is (taskId, channelArn), so a task id lifted from another conversation resolves to
    // nothing here. The hint is what made us look; the task is the authority.
    mockGetTask.mockResolvedValue(null);
    await handler({ Records: [record(answer())] });
    expect(dispatches()).toHaveLength(0);
  });

  it('refuses when the task records no assistant', async () => {
    // Rows written before the ownership split. Nothing here can invent one, and guessing would
    // dispatch to whichever assistant the channel happens to default to.
    mockGetTask.mockResolvedValue(task({ assistantId: undefined }));
    await handler({ Records: [record(answer())] });
    expect(dispatches()).toHaveLength(0);
  });

  it('REFUSES IN A 1:1, where the answer already reached the assistant', async () => {
    // At that size Amazon Chime SDK's AUTO trigger routes every message to Lex regardless of
    // addressing. This is the case where a repair produces the SECOND turn on one message.
    mockMessagingSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'ListMemberships') return { ChannelMemberships: [{ Member: { Arn: HUMAN } }, { Member: { Arn: OWNING_BOT } }] };
      if (cmd.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      return {};
    });
    await handler({ Records: [record(answer())] });
    expect(dispatches()).toHaveLength(0);
  });

  it('refuses when the channel size cannot be read', async () => {
    // `resolveChannelSize` fails toward the GROUP shape for its own caller, which here would mean
    // repairing a conversation that may be a 1:1. The cheaper mistake is the repair that did not
    // happen: the person is left exactly where they already were, with the item still open.
    mockMessagingSend.mockImplementation(async (cmd: { __type: string }) => {
      if (cmd.__type === 'ListMemberships') throw new Error('Chime is having a moment');
      if (cmd.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      return {};
    });
    await handler({ Records: [record(answer())] });
    expect(dispatches()).toHaveLength(0);
    expect(metrics()).toContain('Unresolved');
  });

  it('DECLINES a premium conversation whose router is unwired, and never borrows standard\'s (ADR-046)', async () => {
    const saved = process.env.PREMIUM_ROUTER_ARN;
    delete process.env.PREMIUM_ROUTER_ARN;
    try {
      await handler({ Records: [record(answer())] });
      expect(dispatches()).toHaveLength(0);
      // THE REASON, not merely that it was unresolved: an unreadable tag or a size refusal also emits
      // `Unresolved`, and only `no-router` says the router table declined.
      expect(unresolvedReasons()).toContain('no-router');
    } finally {
      process.env.PREMIUM_ROUTER_ARN = saved;
    }
  });
});

describe('one message, one repair', () => {
  // ── THE FLOW MAY ALREADY OWN THIS TURN, AND THE TEXT NO LONGER SAYS SO ────────────────────────
  //
  // `decideRepair` stands down for a message whose TEXT starts with a `#<n>`, because the channel
  // flow routes those. The flow now also routes on the task id in `Metadata`, and such a message
  // carries NO reference in its text - so every free check here sees an ordinary unaddressed message
  // and this would dispatch a second turn for one the flow already dispatched.
  //
  // The flow claims `flow-<MessageId>` before releasing the message, and a message reaches this
  // stream only after release, so losing that claim is proof the flow dispatched, not a race.
  it('stands down when the channel flow already claimed the message', async () => {
    mockAlreadyClaimed.add('flow-m-1');

    await handler({ Records: [record(answer())] });

    expect(dispatches()).toHaveLength(0);
    // And it did NOT burn the repair's own claim on a repair it never performed, so a later genuine
    // repair of this message is still possible.
    expect(mockClaims).not.toContain('repair-m-1');
  });

  it('repairs when the flow did not claim it, which is what it exists for', async () => {
    await handler({ Records: [record(answer())] });

    expect(dispatches()).toHaveLength(1);
    expect(mockClaims).toContain('flow-m-1');
  });

  it('claims the message durably, so a redelivery on another container dispatches nothing', async () => {
    // Kinesis delivery is at-least-once and a retried batch runs on whichever container is free. An
    // in-memory claim is per container, so both deliveries would believe they were first - the exact
    // defect the channel flow's dedup was measured to have.
    await handler({ Records: [record(answer())] });
    expect(dispatches()).toHaveLength(1);
    expect(mockClaims).toContain('repair-m-1');

    mockAlreadyClaimed.add('repair-m-1');
    mockLambdaSend.mockClear();
    await handler({ Records: [record(answer())] });
    expect(dispatches()).toHaveLength(0);
  });

  // THIS PINNED THE CLAIM BEING TAKEN FIRST, AND ADR-045 DECISION 2 MOVED IT AFTER THE CHECKS.
  //
  // "A duplicate costs nothing" was the right instinct applied at the wrong point. Claiming before
  // the checks meant a repair REFUSED by the classification boundary, or declined on an unreadable
  // size, still consumed the message's only durable claim - so the retry that should have succeeded
  // once the throttle passed was turned away as a duplicate of a repair that never happened. The
  // person's answer was then lost for good, which is the outcome the claim exists to prevent.
  //
  // What the claim still guarantees is unchanged and is asserted below: at most one DISPATCH per
  // message. What it no longer does is charge for work that was declined. The cost of the new order
  // is that a genuine duplicate re-runs the reads above the claim, and those are all reads.
  it('still dispatches only once for a duplicate delivery', async () => {
    mockAlreadyClaimed.add('repair-m-1');
    await handler({ Records: [record(answer())] });
    expect(dispatches()).toHaveLength(0);
  });

  it('reads the task before claiming, so a declined repair leaves the claim for a retry', async () => {
    mockAlreadyClaimed.add('repair-m-1');
    await handler({ Records: [record(answer())] });
    // The inversion of the old assertion, and the point of the change: the checks run first now.
    expect(mockGetTask).toHaveBeenCalled();
  });
});

describe('it never costs the stream', () => {
  it('swallows a dispatch failure rather than stalling the shard', async () => {
    // A Kinesis handler that throws blocks its shard until the retries are exhausted - so a defect
    // affecting one message would stop the stream for every message behind it.
    mockLambdaSend.mockRejectedValue(new Error('Lambda said no'));
    await expect(handler({ Records: [record(answer())] })).resolves.toBeUndefined();
    expect(metrics()).toContain('Failures');
  });

  it('skips a record it cannot parse and keeps going', async () => {
    const junk = { kinesis: { data: Buffer.from('not json').toString('base64') } };
    await expect(handler({ Records: [junk, record(answer())] })).resolves.toBeUndefined();
    expect(dispatches()).toHaveLength(1);
  });
});

describe('the assistant identity', () => {
  it('is derived from the channel, so it is always in this app instance', () => {
    // A channel ARN and a bot ARN differ only in their last two segments, so the channel the message
    // arrived in already names the app instance the assistant must live in. A stored prefix would be
    // a second copy of that fact.
    expect(botArnInChannel(CHANNEL, 'AltSlot0')).toBe(OWNING_BOT);
    expect(botArnInChannel('not-an-arn', 'AltSlot0')).toBeUndefined();
    expect(botArnInChannel(CHANNEL, '')).toBeUndefined();
  });
});
