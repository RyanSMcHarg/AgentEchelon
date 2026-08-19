/**
 * Unit tests for the shared live-drift flow (lambda/src/lib/live-drift-flow.ts).
 *
 * This is the flow EVERY classification now runs (extracted from the Stage-4-deleted
 * shared router). The tests pin the gates that decide whether drift runs:
 *   - infra gate  (ENABLE_LIVE_DRIFT + AURORA_DATA_PLANE_ARN present — the Aurora hookup)
 *   - policy gate (the CONVERSATION TYPE's driftEnabled — NOT the classification)
 *   - battle suppression
 * and the basic-classification path specifically (basic had no drift code before).
 *
 * The module reads ENABLE_LIVE_DRIFT/AURORA_DATA_PLANE_ARN at load, so each scenario
 * re-requires it under the right env via `loadFlow`.
 */

// Stable mock fns (defined once; factories below return these so they survive
// jest.resetModules()).
const mockDetectDrift = jest.fn();
const mockRecordDriftFire = jest.fn();
const mockRecordDriftOutcome = jest.fn();
const mockIsBattleEnabled = jest.fn();
const mockCreateConversationFromDrift = jest.fn();

const mockReadRouting = jest.fn();
const mockWriteRouting = jest.fn();
const mockSavePending = jest.fn();
const mockReadPending = jest.fn();
const mockResolvePending = jest.fn();
const mockRecordDecline = jest.fn();
const mockClassifyReply = jest.fn();

// Controllable conversation-type policy (the per-type drift gate under test).
let mockDriftEnabled = true;

// live-drift-flow now calls detectDrift/recordDriftFire/recordDriftOutcome via
// the data-plane client seam (project decision 018), not drift-detection directly.
jest.mock('../../lambda/src/lib/data-plane-client', () => ({
  detectDrift: (...a: unknown[]) => mockDetectDrift(...a),
  recordDriftFire: (...a: unknown[]) => mockRecordDriftFire(...a),
  recordDriftOutcome: (...a: unknown[]) => mockRecordDriftOutcome(...a),
  // The pending-suggestion task ops now run through the data plane (ADR-018),
  // not via a direct routing-state query() from the non-VPC handler.
  savePendingSuggestion: (...a: unknown[]) => mockSavePending(...a),
  readPendingSuggestion: (...a: unknown[]) => mockReadPending(...a),
  resolvePendingSuggestion: (...a: unknown[]) => mockResolvePending(...a),
}));
// The drift suggestion is posted BEFORE the router's duplicate-fulfillment claim (that one runs
// ~200 lines later), so this flow takes its own claim. Mocked here so a duplicate turn can be
// simulated without a DynamoDB table.
const mockClaimCorrelation = jest.fn();
jest.mock('../../lambda/src/lib/abuse-controls', () => ({
  claimCorrelation: (...args: unknown[]) => mockClaimCorrelation(...args),
}));

jest.mock('../../lambda/src/lib/battle-state', () => ({
  isBattleEnabled: (...a: unknown[]) => mockIsBattleEnabled(...a),
}));
jest.mock('../../lambda/src/lib/channel-creation', () => ({
  createConversationFromDrift: (...a: unknown[]) => mockCreateConversationFromDrift(...a),
}));
jest.mock('../../lambda/src/lib/routing-state', () => ({
  readRoutingFromSession: (...a: unknown[]) => mockReadRouting(...a),
  writeRoutingToSession: (...a: unknown[]) => mockWriteRouting(...a),
  recordDecline: (...a: unknown[]) => mockRecordDecline(...a),
  classifyConfirmDeclineReply: (...a: unknown[]) => mockClassifyReply(...a),
}));
jest.mock('../../lib/config/conversation-types', () => ({
  resolveConversationTypeKey: (o: { explicitType?: string; classification: string }) => o.explicitType || o.classification,
  getConversationTypeConfig: (k: string) => ({
    classification: k === 'premium' ? 'premium' : k === 'standard' ? 'standard' : 'basic',
    driftEnabled: mockDriftEnabled,
  }),
}));

type FlowModule = typeof import('../../lambda/src/lib/live-drift-flow');

function loadFlow(env: Record<string, string | undefined>): FlowModule {
  jest.resetModules();
  for (const k of ['ENABLE_LIVE_DRIFT', 'AURORA_DATA_PLANE_ARN', 'APP_INSTANCE_ARN', 'CHANNEL_FLOW_ARN_PARAM']) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../lambda/src/lib/live-drift-flow');
}

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const baseInput = {
  event: {
    inputTranscript: 'tell me about quantum tunneling',
    sessionState: { intent: { name: 'FallbackIntent' }, sessionAttributes: {} },
    requestAttributes: {
      'CHIME.channel.arn': CHANNEL,
      'CHIME.message.id': 'msg-1',
      'CHIME.sender.arn': 'arn:aws:chime:us-east-1:111:app-instance/i/user/u1',
    },
  },
  channelArn: CHANNEL,
  userMessage: 'tell me about quantum tunneling',
  userSub: 'u1',
  classification: 'basic' as const,
  botArn: 'arn:aws:chime:us-east-1:111:app-instance/i/bot/basic',
  intent: 'general',
};

const DATA_PLANE_ARN = 'arn:aws:lambda:us-east-1:111:function:data-plane';
const ENABLED = { ENABLE_LIVE_DRIFT: 'true', AURORA_DATA_PLANE_ARN: DATA_PLANE_ARN, APP_INSTANCE_ARN: 'arn:aws:chime:us-east-1:111:app-instance/i' };

beforeEach(() => {
    mockClaimCorrelation.mockResolvedValue(true);
  jest.clearAllMocks();
  mockDriftEnabled = true;
  mockReadRouting.mockReturnValue({ declinedDistances: [] });
  mockClassifyReply.mockReturnValue('ambiguous');
  mockIsBattleEnabled.mockResolvedValue(false);
  mockWriteRouting.mockReturnValue({ routing: 'serialized' });
  // These are awaited with `.catch(...)` in the flow, so they must be promises.
  mockRecordDriftOutcome.mockResolvedValue(undefined);
  mockResolvePending.mockResolvedValue(undefined);
  // Default: no durable task in the store (session fast-path is authoritative).
  mockReadPending.mockResolvedValue(null);
});

describe('infra gate', () => {
  it('returns null and never calls detectDrift when ENABLE_LIVE_DRIFT is unset (Athena mode)', async () => {
    const flow = loadFlow({ AURORA_DATA_PLANE_ARN: DATA_PLANE_ARN }); // no ENABLE_LIVE_DRIFT
    const result = await flow.runLiveDriftFlow({ ...baseInput });
    expect(result).toBeNull();
    expect(mockDetectDrift).not.toHaveBeenCalled();
  });

  it('returns null when AURORA_DATA_PLANE_ARN is unset (drift wired but no Aurora)', async () => {
    const flow = loadFlow({ ENABLE_LIVE_DRIFT: 'true' }); // no data-plane ARN
    const result = await flow.runLiveDriftFlow({ ...baseInput });
    expect(result).toBeNull();
    expect(mockDetectDrift).not.toHaveBeenCalled();
  });
});

describe('policy gate (conversation type drift on/off)', () => {
  it('returns null without running detectDrift when the conversation type has drift disabled', async () => {
    mockDriftEnabled = false;
    const flow = loadFlow(ENABLED);
    const result = await flow.runLiveDriftFlow({ ...baseInput });
    expect(result).toBeNull();
    expect(mockDetectDrift).not.toHaveBeenCalled();
    // The type gate is evaluated before the (async) battle check.
    expect(mockIsBattleEnabled).not.toHaveBeenCalled();
  });
});

// LIVE WORK IN THE CONVERSATION REACHES THE DETECTOR.
//
// The flow does not resolve this itself - the router already read it for task continuation, and a
// second DynamoDB round-trip here would be paid on every reply. So the only thing this layer can get
// wrong is dropping it, and dropping it is invisible: the turn still answers, drift just fires when it
// should not. That is how the live report_generation defect looked from the logs.
describe('the caller\'s live-task signal reaches detectDrift', () => {
  it('forwards it, so a mid-workflow turn is not read as a pivot', async () => {
    mockDetectDrift.mockResolvedValue({ isDrift: false, driftScore: 0.9 });
    const flow = loadFlow(ENABLED);

    await flow.runLiveDriftFlow({ ...baseInput, activeTaskInProgress: true });

    expect(mockDetectDrift.mock.calls[0][0].activeTaskInProgress).toBe(true);
  });

  it('forwards its absence too, rather than defaulting the guard on', async () => {
    // A helpful default here would suppress drift for every caller that never resolved a task,
    // including the ones that have no task path at all.
    mockDetectDrift.mockResolvedValue({ isDrift: false, driftScore: 0.02 });
    const flow = loadFlow(ENABLED);

    await flow.runLiveDriftFlow({ ...baseInput, activeTaskInProgress: false });

    expect(mockDetectDrift.mock.calls[0][0].activeTaskInProgress).toBe(false);
  });
});

// A BATTLE BLOCKS THE ACTION, NOT THE DETECTION (owner, 2026-08-13).
//
// The previous behaviour returned null the moment Battle Mode was on, so a user who changed the
// subject mid-duel got no suggestion AND no reason for its absence - which reads as being ignored.
// Detection now runs as it does anywhere else, and the battle changes only what happens when drift
// fires: the user is told the duel is still running, and given the two ways out.
describe('drift during a battle', () => {
  it('detects as normal, but explains instead of offering to split', async () => {
    mockIsBattleEnabled.mockResolvedValue(true);
    mockDetectDrift.mockResolvedValue({
      isDrift: true,
      driftScore: 0.42,
      suggestedAction: 'confirm',
      suggestionTemplate: 'Want me to start a separate conversation?',
      correlationId: 'corr-1',
    });
    const flow = loadFlow(ENABLED);

    const result = await flow.runLiveDriftFlow({ ...baseInput });

    // It ran: a battle turn is an ordinary turn.
    expect(mockDetectDrift).toHaveBeenCalled();
    const content = result?.messages?.[0]?.content ?? '';
    expect(content).toMatch(/battle/i);
    // Both exits are named, or the user is told "no" with no way forward.
    expect(content).toMatch(/finish|finishes/i);
    expect(content).toMatch(/Battle Mode off/i);
    // The offer itself must NOT appear - there is nothing to accept.
    expect(content).not.toContain('Want me to start a separate conversation?');
  });

  it('records nothing: there is no offer, so an outcome would be a fiction', async () => {
    mockIsBattleEnabled.mockResolvedValue(true);
    mockDetectDrift.mockResolvedValue({
      isDrift: true,
      driftScore: 0.42,
      suggestedAction: 'confirm',
      suggestionTemplate: 'Want me to start a separate conversation?',
      correlationId: 'corr-1',
    });
    const flow = loadFlow(ENABLED);

    await flow.runLiveDriftFlow({ ...baseInput });

    expect(mockRecordDriftFire).not.toHaveBeenCalled();
    expect(mockSavePending).not.toHaveBeenCalled();
  });

  it('falls through normally when the turn has NOT drifted', async () => {
    mockIsBattleEnabled.mockResolvedValue(true);
    mockDetectDrift.mockResolvedValue({ isDrift: false, driftScore: 0.02 });
    const flow = loadFlow(ENABLED);

    // No drift means nothing to explain: a battle must not make ordinary turns chatty.
    expect(await flow.runLiveDriftFlow({ ...baseInput })).toBeNull();
  });

  it('holds an ACCEPTANCE made before Battle Mode was turned on, without losing it', async () => {
    // The suggestion outlived the condition it was made under. Acting now would walk the user out of a
    // duel in progress; the pending stays so a later "yes" still works.
    mockIsBattleEnabled.mockResolvedValue(true);
    mockReadRouting.mockReturnValue({
      pendingDriftSuggestion: {
        taskId: 'task-1', channelArn: 'arn:chan', userSub: 'u1', kind: 'confirm',
      },
      declinedDistances: [],
    });
    mockClassifyReply.mockReturnValue('affirmative');
    const flow = loadFlow(ENABLED);

    const result = await flow.runLiveDriftFlow({ ...baseInput });

    expect(mockCreateConversationFromDrift).not.toHaveBeenCalled();
    expect(mockResolvePending).not.toHaveBeenCalled();
    expect(result?.messages?.[0]?.content ?? '').toMatch(/battle/i);
  });
});

describe('basic-classification drift path (basic had no drift before the re-home)', () => {
  it('runs detectDrift and emits the suggestion template when drift fires', async () => {
    mockDetectDrift.mockResolvedValue({
      isDrift: true,
      driftScore: 0.42,
      suggestedAction: 'confirm',
      suggestionTemplate: 'Want me to start a separate conversation?',
      correlationId: 'corr-1',
    });
    mockRecordDriftFire.mockResolvedValue('drift-evt-1');
    mockSavePending.mockResolvedValue({ taskId: 'task-1' });

    const flow = loadFlow(ENABLED);
    const result = await flow.runLiveDriftFlow({ ...baseInput, classification: 'basic' });

    expect(mockDetectDrift).toHaveBeenCalledTimes(1);
    // detectDrift gets the classification as its EMF dimension and the uppercased intent.
    expect(mockDetectDrift).toHaveBeenCalledWith(
      expect.objectContaining({ channelArn: CHANNEL, userClearance: 'basic', intent: 'GENERAL' }),
    );
    expect(mockRecordDriftFire).toHaveBeenCalledTimes(1);

    // The drift row must carry a RESOLVED originating message id, and the SAME one the pending
    // suggestion records. It previously took `CHIME.message.id` straight off the event, which Chime
    // does not send, so every live row stored '' - and the evaluation pass selects offers by
    // `JOIN messages m ON m.message_id = d.originating_message_id`, which '' can never satisfy. No
    // live offer was ever judged and the Accuracy tile read "Not measured" for good.
    const firedWith = mockRecordDriftFire.mock.calls[0][0] as { messageId?: string };
    expect(firedWith.messageId).toBeTruthy();
    const savedWith = mockSavePending.mock.calls[0][0] as { originatingMessageId?: string };
    expect(firedWith.messageId).toBe(savedWith.originatingMessageId);

    expect(mockSavePending).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result!.messages[0].content).toContain('separate conversation');
  });

  it('claims BEFORE posting, so a duplicate turn does not suggest twice', async () => {
    // THE DEFECT THIS PINS. The router collapses a duplicate fulfillment with a correlation claim,
    // but that claim runs ~200 lines AFTER this flow has already posted its suggestion. So a second
    // invocation posted a SECOND suggestion and only then returned idempotently: the answer was
    // protected, the suggestion was not.
    //
    // Measured live 2026-08-12 on a group @all: two identical suggestions 1.8s apart, distinct
    // MessageIds, neither carrying a corr marker (this path posts directly, not as a placeholder,
    // which is why the placeholder guards missed it too).
    mockDetectDrift.mockResolvedValue({
      isDrift: true, driftScore: 0.42, suggestedAction: 'confirm',
      suggestionTemplate: 'Want me to start a separate conversation?', correlationId: 'corr-dup',
    });
    mockRecordDriftFire.mockResolvedValue('drift-evt-dup');
    mockSavePending.mockResolvedValue({ taskId: 'task-dup' });

    // The SECOND invocation of the same turn loses the claim.
    mockClaimCorrelation.mockResolvedValueOnce(false);

    const flow = loadFlow(ENABLED);
    const result = await flow.runLiveDriftFlow({ ...baseInput });

    // No suggestion, and nothing recorded: a duplicate must not double-count the offer either, or
    // the acceptance rate is computed against inflated denominators.
    expect(result).toBeNull();
    expect(mockRecordDriftFire).not.toHaveBeenCalled();
    expect(mockSavePending).not.toHaveBeenCalled();
  });

  it('claims on the ORIGINATING MESSAGE id, which a redelivery replays identically', async () => {
    // A random or time-derived key would let each attempt claim its own and defeat the guard - the
    // failure mode lib/correlation.ts documents for the placeholder path. It must be the same stable
    // per-turn property the answer already dedups on.
    mockDetectDrift.mockResolvedValue({
      isDrift: true, driftScore: 0.42, suggestedAction: 'confirm',
      suggestionTemplate: 'Want me to start a separate conversation?', correlationId: 'corr-key',
    });
    mockRecordDriftFire.mockResolvedValue('drift-evt-key');
    mockSavePending.mockResolvedValue({ taskId: 'task-key' });

    const flow = loadFlow(ENABLED);
    await flow.runLiveDriftFlow({ ...baseInput });

    expect(mockClaimCorrelation).toHaveBeenCalledTimes(1);
    const key = String(mockClaimCorrelation.mock.calls[0][0]);
    expect(key).toMatch(/^drift-suggest-/);
    // The id the fire and the pending row both use, so all three agree on which turn this was.
    const firedWith = mockRecordDriftFire.mock.calls[0][0] as { messageId?: string };
    expect(key).toBe(`drift-suggest-${firedWith.messageId}`);
  });

  it('returns null (falls through to normal flow) when detectDrift reports no drift', async () => {
    mockDetectDrift.mockResolvedValue({ isDrift: false, driftScore: 0.1, suggestedAction: 'continue', correlationId: 'c' });
    const flow = loadFlow(ENABLED);
    const result = await flow.runLiveDriftFlow({ ...baseInput });
    expect(mockDetectDrift).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });
});

describe('confirm path creates a channel at the type classification', () => {
  it('on an affirmative reply to a pending confirm, creates a new channel and returns a NAVIGATE response', async () => {
    mockReadRouting.mockReturnValue({
      declinedDistances: [],
      pendingDriftSuggestion: {
        taskId: 'task-1',
        kind: 'confirm',
        originatingMessageId: 'msg-0',
        driftEventId: 'evt-1',
      },
    });
    mockClassifyReply.mockReturnValue('affirmative');
    mockCreateConversationFromDrift.mockResolvedValue({ channelArn: 'arn:new:channel', channelId: 'cid' });

    const flow = loadFlow(ENABLED);
    const result = await flow.runLiveDriftFlow({ ...baseInput, classification: 'premium' });

    expect(mockCreateConversationFromDrift).toHaveBeenCalledTimes(1);
    // The spawned channel inherits the conversation type's classification.
    expect(mockCreateConversationFromDrift).toHaveBeenCalledWith(
      expect.objectContaining({ modelTier: 'premium' }),
    );
    expect(mockResolvePending).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'confirmed' }));
    expect(result).not.toBeNull();
    expect(result!.messages[0].content).toContain('NAVIGATE_CHANNEL:arn:new:channel');
    // detectDrift is NOT re-run on a confirmed pending suggestion.
    expect(mockDetectDrift).not.toHaveBeenCalled();
  });

  it('resumes from the DURABLE task when the session lost the pending suggestion (misrouted turn)', async () => {
    // The Lex session carries no pending (it was lost / the turn was misrouted),
    // but the durable conversation_creation_tasks row is still open. A "yes"
    // reply must resolve it — the task is the source of truth, not the session.
    mockReadRouting.mockReturnValue({ declinedDistances: [] }); // no session pending
    mockClassifyReply.mockReturnValue('affirmative');
    mockReadPending.mockResolvedValue({
      taskId: 'durable-task-7',
      channelArn: CHANNEL,
      userSub: 'u1',
      kind: 'confirm',
      originatingMessageId: 'msg-orig-7',
      correlationId: 'corr-7',
      createdAt: '2026-07-14T00:00:00Z',
    });
    mockCreateConversationFromDrift.mockResolvedValue({ channelArn: 'arn:new:from-durable', channelId: 'cid7' });

    const flow = loadFlow(ENABLED);
    const result = await flow.runLiveDriftFlow({ ...baseInput, classification: 'premium', userMessage: 'yes' });

    // The durable task was consulted (session had nothing)...
    expect(mockReadPending).toHaveBeenCalledWith({ userSub: 'u1', channelArn: CHANNEL });
    // ...and the confirm acted on it: new channel + close the SAME task.
    expect(mockCreateConversationFromDrift).toHaveBeenCalledTimes(1);
    expect(mockResolvePending).toHaveBeenCalledWith({ taskId: 'durable-task-7', outcome: 'confirmed' });
    expect(result).not.toBeNull();
    expect(result!.messages[0].content).toContain('NAVIGATE_CHANNEL:arn:new:from-durable');
    // detectDrift must NOT run — this turn is a resume, not a fresh detection.
    expect(mockDetectDrift).not.toHaveBeenCalled();
  });

  it('does NOT hit the durable store for an ordinary (ambiguous) message', async () => {
    // A normal question with no session pending must not cost a data-plane
    // round-trip — the durable read is gated on a yes/no-looking reply.
    mockReadRouting.mockReturnValue({ declinedDistances: [] });
    mockClassifyReply.mockReturnValue('ambiguous');
    mockDetectDrift.mockResolvedValue({ isDrift: false, driftScore: 0.1, suggestedAction: 'continue', correlationId: 'c' });

    const flow = loadFlow(ENABLED);
    await flow.runLiveDriftFlow({ ...baseInput });

    expect(mockReadPending).not.toHaveBeenCalled();
  });

  it('passes the ORIGINATING message by reference — the ack text never becomes the new channel content', async () => {
    // SPEC-DRIFT-CONVERGENCE.md "by-reference principle": the new channel
    // references the original user message by id; the confirmation reply
    // ("yes please") is a control token, not conversation content, and must
    // NOT be copied into the spawned channel.
    mockReadRouting.mockReturnValue({
      declinedDistances: [],
      pendingDriftSuggestion: {
        taskId: 'task-9',
        kind: 'confirm',
        originatingMessageId: 'msg-original-42',
        driftEventId: 'evt-9',
      },
    });
    mockClassifyReply.mockReturnValue('affirmative');
    mockCreateConversationFromDrift.mockResolvedValue({ channelArn: 'arn:new:channel2', channelId: 'cid2' });

    const flow = loadFlow(ENABLED);
    const ackText = 'yes please';
    await flow.runLiveDriftFlow({ ...baseInput, classification: 'premium', userMessage: ackText });

    expect(mockCreateConversationFromDrift).toHaveBeenCalledTimes(1);
    const createArgs = mockCreateConversationFromDrift.mock.calls[0][0] as Record<string, unknown>;
    // The original message id is carried by reference.
    expect(createArgs.originatingMessageId).toBe('msg-original-42');
    // The ack text is nowhere in the channel-creation payload.
    expect(JSON.stringify(createArgs)).not.toContain(ackText);
  });
});

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};
