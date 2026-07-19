/**
 * Unit tests for the shared live-drift flow (lambda/src/lib/live-drift-flow.ts).
 *
 * This is the flow EVERY tier now runs (extracted from the Stage-4-deleted
 * shared router). The tests pin the gates that decide whether drift runs:
 *   - infra gate  (ENABLE_LIVE_DRIFT + AURORA_DATA_PLANE_ARN present — the Aurora hookup)
 *   - policy gate (the CONVERSATION TYPE's driftEnabled — NOT the tier)
 *   - battle suppression
 * and the basic-tier path specifically (basic had no drift code before).
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
  resolveConversationTypeKey: (o: { explicitType?: string; tier: string }) => o.explicitType || o.tier,
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
  tier: 'basic' as const,
  botArn: 'arn:aws:chime:us-east-1:111:app-instance/i/bot/basic',
  intent: 'general',
};

const DATA_PLANE_ARN = 'arn:aws:lambda:us-east-1:111:function:data-plane';
const ENABLED = { ENABLE_LIVE_DRIFT: 'true', AURORA_DATA_PLANE_ARN: DATA_PLANE_ARN, APP_INSTANCE_ARN: 'arn:aws:chime:us-east-1:111:app-instance/i' };

beforeEach(() => {
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

describe('battle suppression', () => {
  it('returns null when the channel has a battle active', async () => {
    mockIsBattleEnabled.mockResolvedValue(true);
    const flow = loadFlow(ENABLED);
    const result = await flow.runLiveDriftFlow({ ...baseInput });
    expect(result).toBeNull();
    expect(mockDetectDrift).not.toHaveBeenCalled();
  });
});

describe('basic-tier drift path (basic had no drift before the re-home)', () => {
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
    const result = await flow.runLiveDriftFlow({ ...baseInput, tier: 'basic' });

    expect(mockDetectDrift).toHaveBeenCalledTimes(1);
    // detectDrift gets the tier as its EMF dimension and the uppercased intent.
    expect(mockDetectDrift).toHaveBeenCalledWith(
      expect.objectContaining({ channelArn: CHANNEL, userClearance: 'basic', intent: 'GENERAL' }),
    );
    expect(mockRecordDriftFire).toHaveBeenCalledTimes(1);
    expect(mockSavePending).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result!.messages[0].content).toContain('separate conversation');
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
    const result = await flow.runLiveDriftFlow({ ...baseInput, tier: 'premium' });

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
    const result = await flow.runLiveDriftFlow({ ...baseInput, tier: 'premium', userMessage: 'yes' });

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
    await flow.runLiveDriftFlow({ ...baseInput, tier: 'premium', userMessage: ackText });

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
