/**
 * ROUTING FOLLOWS THE TASK, NEVER THE TARGET (owner, 2026-08-14).
 *
 * Whether a person addressed nobody or addressed the wrong assistant is the SAME case. Targeting is a
 * delivery concern the client settled at send - it says who can see a message, not what the message is
 * about - and what it is about is answerable from the task alone, because the chain names the assistant
 * whose work it is.
 *
 * So an assistant that receives an answer to work it does not own hands the turn to the assistant that
 * does. It does not answer it (the person's reply is absorbed into the wrong chain, and the chain that
 * was actually waiting stays blocked forever) and it does not drop it (a person answers a question and
 * watches nothing happen). Both of those still LOOK like a working conversation, which is why they need
 * a test rather than a report.
 *
 * The transport is the handler bypass, and it has to be: ADR-023 measured that Amazon Chime SDK does
 * not deliver a bot-authored message to another bot's Lex, so a handover sent as a message reaches
 * nobody at all.
 */

const mockMessagingSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  SendChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'SendMessage', input: args })),
  UpdateChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Update', input: args })),
  GetChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Get', input: args })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMemberships', input: args })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListMessages', input: args })),
  ListTagsForResourceCommand: jest.fn().mockImplementation((args) => ({ __type: 'ListTags', input: args })),
  DescribeChannelCommand: jest.fn().mockImplementation((args) => ({ __type: 'DescribeChannel', input: args })),
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
}), { virtual: true });

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const CHANNEL = `${APP}/channel/c1`;
/** The assistant the message REACHES: this classification's own bot. */
const BOT_SELF = `${APP}/bot/premium-bot`;
/** The assistant that OWNS the waiting chain. A sanctioned alt slot, so a handover to it is allowed. */
const BOT_OWNER = `${APP}/bot/AltSlot0`;
/** Named by a task but in no roster: the impersonation case. */
const BOT_STRANGER = `${APP}/bot/NotOnTheRoster`;
const HUMAN = `${APP}/user/alice`;
const principalIdOf = (arn: string) => arn.split('/').pop() || arn;

const ROSTER_PARAM = '/agent-echelon/alt-bot-slots/roster';
const SELF_FUNCTION = 'AgentEchelonClassification-Premium-AgentHandler';

/**
 * THE ENVIRONMENT THIS FILE RUNS THE ROUTER IN, DECLARED RATHER THAN INHERITED.
 *
 * Every value the router reads out of `process.env` is a value that decides what a turn does, and a
 * test file that names only the two it needs runs the other ones as whatever the shell that started
 * jest happened to hold. `undefined` means "unset for this file", and it is as much a dependency as a
 * value is: `ENABLE_LIVE_DRIFT=true` alongside a data-plane ARN adds retrieval and running-summary
 * invokes to every turn, and the assertions here read the turn's Lambda invokes to decide which one is
 * the worker dispatch. With the pair set in the ambient environment, two of these tests fail against a
 * router that is behaving correctly.
 *
 * The router captures most of these at module scope, so they are applied before the import below, not
 * after it.
 */
const ROUTER_ENV: Record<string, string | undefined> = {
  AWS_LAMBDA_FUNCTION_NAME: SELF_FUNCTION,
  ALT_BOT_SLOTS_ROSTER_PARAM: ROSTER_PARAM,
  ENABLE_LIVE_DRIFT: undefined,
};

const applyEnv = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

/**
 * The dedup marks that are down, standing in for the table.
 *
 * WRITTEN BY THE CLAIM, not only seeded by a test, because the handover's whole correctness question
 * is WHEN a mark goes down relative to the dispatch. A mock that only reads a pre-seeded set cannot
 * tell a mark taken before an invoke from one taken after it, so a redelivery in these tests observes
 * exactly what the previous delivery actually left behind.
 */
const mockAlreadyClaimed = new Set<string>();

jest.mock('../../lambda/src/lib/abuse-controls.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/abuse-controls.js');
  return {
    ...actual,
    claimCorrelation: async (key: string) => {
      if (mockAlreadyClaimed.has(key)) return false;
      mockAlreadyClaimed.add(key);
      return true;
    },
    hasCorrelationClaim: async (key: string) => mockAlreadyClaimed.has(key),
  };
}, { virtual: true });

/** The variant bound to a slot, which is the name a duel shows in the channel. */
const mockResolveVariant = jest.fn();

jest.mock('../../lambda/src/lib/experiment-manager.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/experiment-manager.js');
  return {
    ...actual,
    resolveBattleVariantBySlotArn: (...a: unknown[]) => mockResolveVariant(...a),
  };
}, { virtual: true });

const mockResolveActiveBattle = jest.fn();
const mockReadBattleRows = jest.fn();
const mockResumeFromWaiting = jest.fn();

jest.mock('../../lambda/src/lib/battle-state.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/battle-state.js');
  return {
    ...actual,
    resolveActiveBattle: (...a: unknown[]) => mockResolveActiveBattle(...a),
    readBattleRows: (...a: unknown[]) => mockReadBattleRows(...a),
    resumeBotFromWaiting: (...a: unknown[]) => mockResumeFromWaiting(...a),
  };
}, { virtual: true });

const mockGetActiveTaskForOwner = jest.fn();
const mockGetActiveTaskForAssistant = jest.fn();
const mockGetActiveTasksForOwnerInChannel = jest.fn();
const mockGetActiveTask = jest.fn();
const mockApplyUserResponseToTask = jest.fn();

jest.mock('../../lambda/src/lib/task-tracking.js', () => {
  const actual = jest.requireActual('../../lambda/src/lib/task-tracking.js');
  return {
    ...actual,
    getActiveTaskForOwner: (...a: unknown[]) => mockGetActiveTaskForOwner(...a),
    getActiveTaskForAssistant: (...a: unknown[]) => mockGetActiveTaskForAssistant(...a),
    // The router fetches the person's held LIST once per turn and answers both "what do they owe"
    // and "which chain is mine" from it. Tests that model one held task keep setting the singular
    // mock - the list falls back to wrapping it - and a test that models a person holding SEVERAL
    // chains sets this one directly.
    getActiveTasksForOwnerInChannel: async (...a: unknown[]) => {
      const list = await mockGetActiveTasksForOwnerInChannel(...a);
      if (list !== undefined) return list;
      const t = await mockGetActiveTaskForOwner(...a);
      return t ? [t] : [];
    },
    // The same one query, in the shape the router reads it: live work plus anything that ended here
    // recently. These tests model no finished work, so the second list is always empty.
    getOwnerChannelTasks: async (...a: unknown[]) => {
      const list = await mockGetActiveTasksForOwnerInChannel(...a);
      if (list !== undefined) return { live: list, recentlyEnded: [] };
      const t = await mockGetActiveTaskForOwner(...a);
      return { live: t ? [t] : [], recentlyEnded: [] };
    },
    getActiveTask: (...a: unknown[]) => mockGetActiveTask(...a),
    applyUserResponseToTask: (...a: unknown[]) => mockApplyUserResponseToTask(...a),
  };
}, { virtual: true });

/** Every Lambda invoke this turn made, with its payload decoded. */
const invokes = () => mockLambdaSend.mock.calls
  .map((c) => c[0])
  .filter((c) => c?.__type === 'Invoke')
  .map((c) => ({
    fn: c.input.FunctionName as string,
    payload: JSON.parse(Buffer.from(c.input.Payload).toString()),
  }));

/** The turn handed to another assistant, or undefined when nothing was handed over. */
const handover = () => invokes().find((i) => i.payload?.aeTurn?.handedOverFrom)?.payload.aeTurn;

/** Every message this turn POSTED itself (as opposed to returned for Amazon Chime SDK to materialise). */
const posts = () => mockMessagingSend.mock.calls
  .map((c) => c[0])
  .filter((c) => c?.__type === 'SendMessage')
  .map((c) => c.input as { Content: string; Target?: Array<{ MemberArn: string }> });

/** A task the PERSON holds, blocked on them, belonging to `assistantId`. */
const heldTask = (assistantId: string | undefined, taskId = 't-waiting') => ({
  taskId,
  taskType: 'report_generation',
  taskState: 'collecting_requirements',
  channelArn: CHANNEL,
  status: 'in_progress',
  userSub: principalIdOf(HUMAN),
  ...(assistantId ? { assistantId } : {}),
});

/** An ordinary turn: the person speaks in the channel, addressing nobody. */
const turn = (extra: Record<string, unknown> = {}) => ({
  aeTurn: {
    channelArn: CHANNEL,
    senderArn: HUMAN,
    userMessage: 'the audience is engineering leadership',
    userMessageId: 'm-1',
    ...extra,
  },
});

describe('a message answering another assistant\'s work is handed to that assistant', () => {
  let routerHandler: (e: any) => Promise<any>;
  /** What the environment held before this file touched it, put back when the file is done. */
  const envBefore: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of Object.keys(ROUTER_ENV)) envBefore[key] = process.env[key];
  });

  // Restored rather than left standing. A test file mutating the environment it runs in is a file
  // whose result depends on where it sits in a run, and the reader of a failure has no way to see it.
  afterAll(() => applyEnv(envBefore));

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    mockAlreadyClaimed.clear();

    applyEnv(ROUTER_ENV);

    // The roster is what makes an identity sanctionable, so it is mocked per-parameter rather than
    // blanket: a blanket mock would make the security test below pass for the wrong reason.
    mockSsmSend.mockImplementation(async (cmd: { input?: { Name?: string } }) =>
      cmd?.input?.Name === ROSTER_PARAM
        ? { Parameter: { Value: JSON.stringify([{ slotId: 'AltSlot0', botArn: BOT_OWNER }]) } }
        : { Parameter: { Value: BOT_SELF } });

    mockMessagingSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd?.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'premium' }] };
      return { MessageId: 'sent-1' };
    });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ messages: [] })) });

    mockResolveVariant.mockResolvedValue({ displayName: 'Atlas' });
    mockResolveActiveBattle.mockResolvedValue(null);
    mockReadBattleRows.mockResolvedValue([]);
    mockResumeFromWaiting.mockResolvedValue(false);
    mockGetActiveTaskForOwner.mockResolvedValue(null);
    mockGetActiveTaskForAssistant.mockResolvedValue(null);
    // BACK TO UNSET, so the list falls back to wrapping the singular mock again. `jest.clearAllMocks`
    // clears recorded calls and KEEPS implementations, and this is the only mock here whose default is
    // "unset" rather than a value, so it is the only one an earlier test can leave standing. Left
    // standing, the multi-chain list set below is every later test's answer: the person holds a chain
    // THIS assistant owns, so the handover branch is never reached and the tests that assert a
    // handover report on something else entirely.
    mockGetActiveTasksForOwnerInChannel.mockResolvedValue(undefined);
    mockGetActiveTask.mockResolvedValue(null);
    mockApplyUserResponseToTask.mockResolvedValue({ applied: true });

    ({ handler: routerHandler } = await import('../../lambda/src/router-agent-handler.js'));
  });

  describe('when the chain belongs to a DIFFERENT assistant', () => {
    beforeEach(() => {
      mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN) ? heldTask(principalIdOf(BOT_OWNER)) : null);
    });

    it('hands the turn to the assistant the task names', async () => {
      await routerHandler(turn());

      const handed = handover();
      expect(handed).toBeTruthy();
      expect(handed.botArn).toBe(BOT_OWNER);
      expect(handed.handedOverFrom).toBe(principalIdOf(BOT_SELF));
    });

    it('carries the person\'s actual message, not a summary of it', async () => {
      await routerHandler(turn());

      // The owning assistant has to run the turn on what the person SAID. Anything reconstructed here
      // would make the handover a second interpretation of the message, and the two would diverge.
      expect(handover().userMessage).toBe('the audience is engineering leadership');
      expect(handover().senderArn).toBe(HUMAN);
      expect(handover().userMessageId).toBe('m-1');
    });

    it('does NOT absorb the answer into a chain it does not own', async () => {
      await routerHandler(turn());

      // The failure this is really about. Applying the response here advances someone else's workflow
      // from the wrong assistant, and leaves the chain that WAS waiting blocked forever - while the
      // person watches a perfectly ordinary-looking reply.
      expect(mockApplyUserResponseToTask).not.toHaveBeenCalled();
    });

    it('gives the person a receipt, TARGETED at them, saying where the work went', async () => {
      await routerHandler(turn());

      const receipts = posts();
      expect(receipts).toHaveLength(1);
      // Targeted by the CODE. The inbound here is untargeted, so inheritance would have broadcast it -
      // telling the whole channel about a message it never saw.
      expect(receipts[0].Target).toEqual([{ MemberArn: HUMAN }]);
      // By the name the person SEES. In a duel that is the variant's, resolved here as "Atlas".
      expect(decodeURIComponent(receipts[0].Content)).toContain('Atlas');
    });

    it('never names the assistant by its principal id', async () => {
      // `AltSlot0` is a slot in a pool, not a name anyone has been shown. Printing it in the one
      // message whose job is to say where the answer went names something the person has never seen.
      mockResolveVariant.mockResolvedValue(null);

      await routerHandler(turn());

      const content = decodeURIComponent(posts()[0].Content);
      expect(content).not.toContain(principalIdOf(BOT_OWNER));
      // Vague beats precise-and-wrong: the owning assistant's reply follows under its own name.
      expect(content).toContain('another assistant here');
    });

    it('says nothing through Lex, so the receipt is not doubled', async () => {
      const response = await routerHandler(turn());

      // Amazon Chime SDK materialises a message from whatever the fulfillment returns. Returning the
      // receipt here as well as posting it is two receipts, and the returned one would carry the
      // inbound's targeting rather than the one the rule requires.
      expect(response.messages ?? []).toHaveLength(0);
    });

    it('invokes no worker of its own', async () => {
      await routerHandler(turn());

      // A dispatched processor would answer the person from THIS assistant, in parallel with the
      // handover - two assistants replying to one message, which is the rule this all exists to keep.
      expect(invokes().filter((i) => !i.payload?.aeTurn)).toHaveLength(0);
    });

    it('hands one message over ONCE, however many times it is delivered', async () => {
      // Delivery is at-least-once, and this runs ahead of the turn's own correlation claim - which is
      // minted per fulfillment, so a redelivery mints a fresh one and would sail past it. Unmarked, a
      // duplicate gives the person two receipts and the owning assistant two turns on one message.
      // The mark records a dispatch that happened, which is what the seeded key stands for here.
      mockAlreadyClaimed.add('handover-m-1');

      await routerHandler(turn());

      expect(handover()).toBeUndefined();
      // And it does not fall back to answering: the first delivery's handover stands, so a reply here
      // would land beside the owning assistant's.
      expect(posts()).toHaveLength(0);
      expect(mockApplyUserResponseToTask).not.toHaveBeenCalled();
    });
  });

  describe('what must NOT be handed over', () => {
    it('answers its own chain rather than handing it anywhere', async () => {
      mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN) ? heldTask(principalIdOf(BOT_SELF)) : null);

      await routerHandler(turn());

      expect(handover()).toBeUndefined();
      expect(mockApplyUserResponseToTask).toHaveBeenCalled();
    });

    it('prefers the chain IT holds with this person over a newer one belonging to someone else', async () => {
      // Two duel sides wait on the same person, so the newest-first lookup names a row that is not
      // necessarily this assistant's. The person is mid-conversation with THIS assistant; reading their
      // message as the answer to the other side's question is the wrong reading, and it would hand away
      // a message that was meant here.
      // The person holds BOTH sides' chains; the list is newest-first, so the other side's is the
      // newest and "the active task" as an implicit notion would name it.
      mockGetActiveTasksForOwnerInChannel.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN)
          ? [heldTask(principalIdOf(BOT_OWNER), 't-theirs'), heldTask(principalIdOf(BOT_SELF), 't-mine')]
          : []);

      await routerHandler(turn());

      expect(handover()).toBeUndefined();
      expect(mockApplyUserResponseToTask.mock.calls[0][0].taskId).toBe('t-mine');
    });

    it('does not hand over a chain with no assistant recorded', async () => {
      // A row written before `assistantId` existed. Nobody is named, so there is nobody to hand it to,
      // and the receiving assistant answering is the only behaviour that is not a dead end.
      mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN) ? heldTask(undefined) : null);

      await routerHandler(turn());

      expect(handover()).toBeUndefined();
      expect(mockApplyUserResponseToTask).toHaveBeenCalled();
    });

    it('REFUSES an assistant this deployment does not sanction, and answers instead of dropping', async () => {
      // The impersonation seam. A task carrying a junk or foreign `assistantId` must not be able to
      // make this handler invoke a turn as an arbitrary bot in the app instance - `isSanctionedBattleBot`
      // is the same gate that guards a caller-supplied identity, and this is the path that reaches it
      // from stored data rather than from a caller.
      mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN) ? heldTask(principalIdOf(BOT_STRANGER)) : null);

      await routerHandler(turn());

      expect(handover()).toBeUndefined();
      // No handover RECEIPT, which is the message that would have promised the person an answer from
      // an assistant this deployment never dispatched to. The turn's own acknowledgement is a different
      // message and is expected.
      expect(posts().filter((p) => p.Target)).toHaveLength(0);
      // Refusing to hand over is not refusing to answer: the person still gets a turn.
      expect(mockApplyUserResponseToTask).toHaveBeenCalled();
    });

    it('never hands over a turn that ARRIVED by handover', async () => {
      // The loop bound, and it is structural rather than a counter each side declares for itself -
      // which is the weakness ADR-023's hop cap has, measured on the deployment. Exercised with a task
      // that still names another assistant, so the guard cannot pass by the branch being unreachable.
      mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN) ? heldTask(principalIdOf(BOT_OWNER)) : null);

      await routerHandler(turn({ botArn: BOT_OWNER, handedOverFrom: principalIdOf(BOT_SELF) }));

      expect(handover()).toBeUndefined();
    });
  });

  // MEASURED ON THE DEPLOYMENT, 2026-08-14, by B-E7's positive control.
  //
  // A duel side's chain starts in an `awaits` state, so under the ownership split the PERSON holds
  // it from its first moment - and the person-owed lookup is therefore the one that finds it. The duel
  // resume lived only in the assistant's-own-chain branch, which that split had stopped reaching. The
  // response was applied, the battle row was never touched, and both sides of a live duel sat in
  // `WAITING_FOR_USER` while the duel looked like it had simply gone quiet. Round 2 never fired.
  //
  // Nothing errored, and the negative half of B-E7 passed throughout: a non-owner did not resume it,
  // because nobody could.
  describe('answering a chain the person holds also resumes the duel side', () => {
    beforeEach(() => {
      mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN) ? heldTask(principalIdOf(BOT_SELF)) : null);
      mockResolveActiveBattle.mockResolvedValue({ battleId: 'b-1', initiatorUserSub: principalIdOf(HUMAN) });
      mockReadBattleRows.mockResolvedValue([
        { battleId: 'b-1', botArn: BOT_SELF, state: 'WAITING_FOR_USER' },
        { battleId: 'b-1', botArn: BOT_OWNER, state: 'WAITING_FOR_USER' },
      ]);
      mockResumeFromWaiting.mockResolvedValue(true);
    });

    it('takes THIS side out of WAITING_FOR_USER', async () => {
      await routerHandler(turn());

      expect(mockResumeFromWaiting).toHaveBeenCalledTimes(1);
      expect(mockResumeFromWaiting.mock.calls[0][0]).toEqual({ battleId: 'b-1', botArn: BOT_SELF });
    });

    it('leaves the RIVAL waiting, so per-side isolation holds', async () => {
      await routerHandler(turn());

      // Both sides wait on the same person. Resuming the rival on this turn would answer a question it
      // never got an answer to.
      expect(mockResumeFromWaiting.mock.calls.map((c) => c[0].botArn)).not.toContain(BOT_OWNER);
    });

    it('broadcasts the answer, because a duel is a comparison', async () => {
      await routerHandler(turn());

      // The person answers by targeting the side that asked, so Amazon Chime SDK targets this turn's
      // reply back at them. Answering in place buries a duel's answer where only its sender can read it.
      const worker = invokes().find((i) => !i.payload?.aeTurn)?.payload;
      expect(worker?.broadcastAnswer).toBe(true);
    });

    it('does NOT broadcast an ordinary task continuation', async () => {
      // The scope of the previous assertion, and the negative control for it. A 1:1 task step has no
      // public to broadcast to; splitting it would add a receipt nobody needs to every such turn.
      mockResolveActiveBattle.mockResolvedValue(null);

      await routerHandler(turn());

      const worker = invokes().find((i) => !i.payload?.aeTurn)?.payload;
      expect(worker?.broadcastAnswer).toBeUndefined();
      expect(mockResumeFromWaiting).not.toHaveBeenCalled();
    });

    it('resumes nothing when the side is not waiting', async () => {
      // The guard on the resume itself: a side mid-flight must not be transitioned out of a state it
      // is not in, or the orchestrator's round-2 barrier moves for the wrong reason.
      mockReadBattleRows.mockResolvedValue([
        { battleId: 'b-1', botArn: BOT_SELF, state: 'INVOKED' },
      ]);

      await routerHandler(turn());

      expect(mockResumeFromWaiting).not.toHaveBeenCalled();
    });
  });

  // THE RECEIPT IS A PROMISE, AND A PROMISE MADE BEFORE THE DISPATCH CAN BE FALSE BY THE TIME IT IS
  // READ. Posted first, an invoke that then threw left the person told that another assistant had
  // their answer while this one answered it instead - and the same ordering hid a worse case: a mark
  // taken before the dispatch and a container that died before issuing it made the redelivery read
  // "the first handover stands", so no invoke was ever issued and nobody answered the person at all.
  describe('the receipt follows the dispatch that makes it true', () => {
    beforeEach(() => {
      mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN) ? heldTask(principalIdOf(BOT_OWNER)) : null);
    });

    /** The receipt: the only message this turn TARGETS at the person. */
    const receipts = () => posts().filter((p) => p.Target);

    /**
     * When a mock recorded a matching call, on the counter jest keeps ACROSS mocks - which is what
     * lets a Lambda invoke and a Chime message be put in order against each other.
     */
    const orderOf = (
      mock: { mock: { calls: any[][]; invocationCallOrder: number[] } },
      matches: (arg: any) => unknown,
    ): number => {
      const at = mock.mock.calls.findIndex((c) => Boolean(matches(c[0])));
      return at < 0 ? Number.POSITIVE_INFINITY : mock.mock.invocationCallOrder[at];
    };

    const isHandoverInvoke = (c: any) => c?.__type === 'Invoke'
      && JSON.parse(Buffer.from(c.input.Payload).toString())?.aeTurn?.handedOverFrom;

    /** The owning assistant's Lambda is unreachable; the worker dispatch still works. */
    const handoverDispatchFails = () => mockLambdaSend.mockImplementation(async (cmd: any) => {
      if (isHandoverInvoke(cmd)) throw new Error('Lambda unavailable');
      return { Payload: Buffer.from(JSON.stringify({ messages: [] })) };
    });

    it('dispatches before it tells the person where their answer went', async () => {
      await routerHandler(turn());

      expect(orderOf(mockLambdaSend, isHandoverInvoke))
        .toBeLessThan(orderOf(mockMessagingSend, (c) => c?.__type === 'SendMessage'));
    });

    it('says nothing about a handover that did not happen', async () => {
      handoverDispatchFails();

      await routerHandler(turn());

      // THE DISPATCH WAS ATTEMPTED, asserted first because everything below it is also true of a turn
      // that never reached the handover at all. Without this the test passes on a mislabelled task, a
      // stale lookup, or a branch that stopped being reachable, and reports the ordering as sound.
      expect(mockLambdaSend.mock.calls.some((c) => isHandoverInvoke(c[0]))).toBe(true);
      // The receipt names an assistant and promises its reply. Sent for a dispatch that threw, it is
      // a message the person can only read as an answer being on its way from someone it is not.
      expect(receipts()).toHaveLength(0);
      // And the fallback still stands: refusing to promise is not refusing to answer.
      expect(mockApplyUserResponseToTask).toHaveBeenCalled();
    });

    it('leaves a failed handover for the redelivery to make', async () => {
      handoverDispatchFails();
      await routerHandler(turn());

      mockLambdaSend.mockClear();
      mockMessagingSend.mockClear();
      mockApplyUserResponseToTask.mockClear();
      mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ messages: [] })) });

      await routerHandler(turn());

      // Marked before the dispatch, the first delivery's mark stood for an invoke that never left, and
      // this delivery read it as "already handed over" - so the person's answer reached nobody and the
      // chain waited on a turn no assistant had been given.
      expect(handover()?.botArn).toBe(BOT_OWNER);
      expect(receipts()).toHaveLength(1);
    });

    it('does not hand over or speak twice when the first dispatch DID happen', async () => {
      await routerHandler(turn());

      mockLambdaSend.mockClear();
      mockMessagingSend.mockClear();
      mockApplyUserResponseToTask.mockClear();

      await routerHandler(turn());

      // The idempotency the mark exists for, and it has to survive the reordering: a real redelivery
      // after a handover that succeeded gives the owning assistant one turn and the person one receipt.
      expect(invokes()).toHaveLength(0);
      expect(posts()).toHaveLength(0);
      expect(mockApplyUserResponseToTask).not.toHaveBeenCalled();
    });
  });

  describe('the handed-over turn', () => {
    it('owes the answer and NOT a second receipt', async () => {
      // The receiving assistant already told the person, naming this one as the assistant acting. A
      // second receipt says the same message was picked up twice, by two assistants, and the second
      // contradicts the first about who is doing the work.
      mockGetActiveTaskForOwner.mockImplementation(async (ownerId: string) =>
        ownerId === principalIdOf(HUMAN) ? heldTask(principalIdOf(BOT_OWNER)) : null);

      await routerHandler(turn({ botArn: BOT_OWNER, handedOverFrom: principalIdOf(BOT_SELF) }));

      const worker = invokes().find((i) => !i.payload?.aeTurn)?.payload;
      expect(worker).toBeTruthy();
      expect(worker.suppressAcknowledgement).toBe(true);
    });
  });
});
