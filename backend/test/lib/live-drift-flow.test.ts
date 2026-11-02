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
const mockResolveDriftRival = jest.fn();
const mockRecordDriftFire = jest.fn();
const mockRecordDriftOutcome = jest.fn();
const mockResolveActiveBattle = jest.fn();
const mockReadBattleRows = jest.fn();

/**
 * Put a RUNNING duel in the channel, owned by `initiatorUserSub`.
 *
 * "A battle is running" is read from the duel itself - a side generating or blocked on a person - and
 * NOT from the channel's Battle Mode flag. The flag says only that a moderator switched the feature on,
 * so keying on it fired between duels, with nothing in flight, and told the person "the assistants are
 * still comparing answers" while no assistant was doing anything.
 */
function duelRunning(initiatorUserSub: string) {
  mockResolveActiveBattle.mockResolvedValue({ battleId: 'a1b2c3d4e5f60718', initiatorUserSub });
  mockReadBattleRows.mockResolvedValue([
    { battleId: 'a1b2c3d4e5f60718', botArn: 'arn:bot/A', state: 'WAITING_FOR_USER' },
    { battleId: 'a1b2c3d4e5f60718', botArn: 'arn:bot/B', state: 'COMPLETED' },
  ]);
}
const mockCreateConversationFromDrift = jest.fn();

const mockSavePending = jest.fn();
const mockReadPending = jest.fn();
const mockResolvePending = jest.fn();
const mockSeedDriftTopic = jest.fn().mockResolvedValue(undefined);
const mockAdoptTopic = jest.fn();
const mockClassifyReply = jest.fn();
const mockChimeSend = jest.fn();

// Controllable conversation-type policy (the per-type drift gate under test).
let mockDriftEnabled = true;

// live-drift-flow now calls detectDrift/recordDriftFire/recordDriftOutcome via
// the data-plane client seam (project decision 018), not drift-detection directly.
jest.mock('../../lambda/src/lib/data-plane-client', () => ({
  detectDrift: (...a: unknown[]) => mockDetectDrift(...a),
  resolveDriftRival: (...a: unknown[]) => mockResolveDriftRival(...a),
  recordDriftFire: (...a: unknown[]) => mockRecordDriftFire(...a),
  recordDriftOutcome: (...a: unknown[]) => mockRecordDriftOutcome(...a),
  // The pending-suggestion task ops now run through the data plane (ADR-018),
  // not via a direct routing-state query() from the non-VPC handler.
  savePendingSuggestion: (...a: unknown[]) => mockSavePending(...a),
  readPendingSuggestion: (...a: unknown[]) => mockReadPending(...a),
  resolvePendingSuggestion: (...a: unknown[]) => mockResolvePending(...a),
  adoptOfferedTopic: (...a: unknown[]) => mockAdoptTopic(...a),
  // An accepted offer records the new conversation topic as its first summary, so drift there has a
  // real anchor from message one rather than the turn-one seed it refuses to compare against.
  seedDriftTopicSummary: (...a: unknown[]) => mockSeedDriftTopic(...a),
}));
// The person's own words are read back by reference when an offer is accepted.
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: (...a: unknown[]) => mockChimeSend(...a) })),
  GetChannelMessageCommand: jest.fn().mockImplementation((input: unknown) => ({ __type: 'GetChannelMessage', input })),
  ListChannelMembershipsCommand: jest.fn().mockImplementation((input: unknown) => ({ __type: 'ListMemberships', input })),
  ListChannelMessagesCommand: jest.fn().mockImplementation((input: unknown) => ({ __type: 'ListMessages', input })),
  SearchChannelsCommand: jest.fn().mockImplementation((input: unknown) => ({ __type: 'Search', input })),
}), { virtual: true });
// The drift suggestion is posted BEFORE the router's duplicate-fulfillment claim (that one runs
// ~200 lines later), so this flow takes its own claim. Mocked here so a duplicate turn can be
// simulated without a DynamoDB table.
const mockClaimCorrelation = jest.fn();
jest.mock('../../lambda/src/lib/abuse-controls', () => ({
  claimCorrelation: (...args: unknown[]) => mockClaimCorrelation(...args),
}));

jest.mock('../../lambda/src/lib/battle-state', () => ({
  resolveActiveBattle: (...a: unknown[]) => mockResolveActiveBattle(...a),
  readBattleRows: (...a: unknown[]) => mockReadBattleRows(...a),
  duelIsLive: (rows: Array<{ state: string; botArn?: string }>) => {
    const bots = rows.filter((r) => !String(r.botArn || '').startsWith('__'));
    if (bots.length === 0) return false;
    if (bots.every((r) => r.state === 'ABANDONED')) return false;
    return !rows.some((r) => r.botArn === '__complete__');
  },
}));
jest.mock('../../lambda/src/lib/channel-creation', () => ({
  createConversationFromDrift: (...a: unknown[]) => mockCreateConversationFromDrift(...a),
}));
jest.mock('../../lambda/src/lib/routing-state', () => ({
  classifyConfirmDeclineReply: (...a: unknown[]) => mockClassifyReply(...a),
}));
/** Which type key the gate actually looked its policy up by - the whole question for a stamped type. */
const typeKeysAsked: string[] = [];
jest.mock('../../lib/config/conversation-types', () => ({
  // The declared types the variable table names (`conversation:type`); this flow reads none of them.
  CONVERSATION_TYPES: {},
  resolveConversationTypeKey: (o: { explicitType?: string }) => o.explicitType || 'general',
  getConversationTypeConfig: (k: string) => {
    typeKeysAsked.push(k);
    return { driftEnabled: mockDriftEnabled };
  },
}));
/** The conversation's TYPE STAMP, which is where the gate reads a non-classification type from. */
const mockGetChannelContext = jest.fn();
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  getChannelContext: (...a: unknown[]) => mockGetChannelContext(...a),
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
    requestAttributes: {
      'CHIME.channel.arn': CHANNEL,
      'CHIME.message.id': 'msg-1',
      'CHIME.sender.arn': 'arn:aws:chime:us-east-1:111:app-instance/i/user/u1',
    },
  },
  channelArn: CHANNEL,
  userMessage: 'tell me about quantum tunneling',
  personId: 'u1',
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
  mockClassifyReply.mockReturnValue('ambiguous');
  mockResolveActiveBattle.mockResolvedValue(null);
  // These are awaited with `.catch(...)` in the flow, so they must be promises.
  mockRecordDriftOutcome.mockResolvedValue(undefined);
  mockResolvePending.mockResolvedValue(undefined);
  mockAdoptTopic.mockResolvedValue({ adopted: true });
  // Default: no offer open.
  mockReadPending.mockResolvedValue(null);
  mockChimeSend.mockResolvedValue({});
  // No stamp by default: a conversation created before types were recorded, which must behave exactly as
  // it did before - the type falls back to the classification.
  mockGetChannelContext.mockResolvedValue(null);
  typeKeysAsked.length = 0;
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
    expect(mockResolveActiveBattle).not.toHaveBeenCalled();
  });

  // ── THE GATE READS THE CONVERSATION'S TYPE, NOT ITS CLASSIFICATION ─────────────────────────────
  //
  // This is the half of ADR-053 Phase 1 that makes the type dimension real on the turn path. A
  // conversation created of type `ops` records its key in the channel-context store; without reading it
  // the gate resolves from the classification, and `premium` has drift ON while `ops` declares it off -
  // so the assistant would offer to split a conversation whose type exists to hold exactly one subject.

  // These three pass the gate, so detection runs; it answers "no drift" because what is under test is
  // WHICH type key the gate resolved, not what the detector then decided.
  const noDrift = () => mockDetectDrift.mockResolvedValue({ isDrift: false });

  it('looks its policy up by the STAMPED type when the conversation has one', async () => {
    noDrift();
    mockGetChannelContext.mockResolvedValue({ conversationType: 'ops' });
    const flow = loadFlow(ENABLED);
    await flow.runLiveDriftFlow({ ...baseInput, classification: 'premium' as const });
    expect(typeKeysAsked).toContain('ops');
    expect(typeKeysAsked).not.toContain('premium');
  });

  it('falls back to the ordinary type, never the classification, when nothing is stamped', async () => {
    // Every conversation created before the stamp existed is in this state, and it was an ordinary
    // conversation. A gate that refused to resolve without a stamp would turn drift off for the whole
    // estate; one that resolved by classification would treat a classification as a type.
    noDrift();
    const flow = loadFlow(ENABLED);
    await flow.runLiveDriftFlow({ ...baseInput, classification: 'premium' as const });
    expect(typeKeysAsked).toContain('general');
    expect(typeKeysAsked).not.toContain('premium');
  });

  it('prefers a type the caller supplies over the stored stamp', async () => {
    // The parameter stays an override: a caller that already resolved the type does not pay a second
    // read, and a synthetic caller keeps working unchanged.
    noDrift();
    mockGetChannelContext.mockResolvedValue({ conversationType: 'ops' });
    const flow = loadFlow(ENABLED);
    await flow.runLiveDriftFlow({
      ...baseInput, classification: 'premium' as const, conversationType: 'general',
    });
    expect(typeKeysAsked).toContain('general');
    expect(mockGetChannelContext).not.toHaveBeenCalled();
  });

  it('does not read the store at all when the infra gate already closed', async () => {
    // The read sits after the infra gate on purpose, so a deployment with drift off pays nothing for a
    // dimension it never consults.
    const flow = loadFlow({ AURORA_DATA_PLANE_ARN: DATA_PLANE_ARN });
    await flow.runLiveDriftFlow({ ...baseInput });
    expect(mockGetChannelContext).not.toHaveBeenCalled();
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

// A BATTLE BLOCKS THE ACTION AND THE MESSAGE, NOT THE DETECTION.
//
// This went through three shapes, and the middle one shipped a real defect.
//
//   1. Return null the moment Battle Mode was on. A user who changed the subject mid-duel got no
//      suggestion and no reason for its absence, which reads as being ignored.
//   2. Detect as normal and RETURN AN EXPLANATION (maintainer, 2026-08-13). The router treats any
//      drift response as the whole turn, and detection runs per answering assistant - so on a duel
//      it fired for ONE side, that side sent the explanation INSTEAD of its round-1 reply, and the
//      comparison ran with a single participant. Observed live 2026-09-21 on
//      `/battle Generate an image of a La Croix can`: the alt posted the notice, the control
//      generated the image alone, and there was nothing to compare. The copy even said "go ahead and
//      I will answer it here" while returning without answering.
//   3. Detect as normal and let the turn PROCEED. The duel answers, which is what the person asked
//      for and the only thing they can act on: no split is possible during a battle whatever they
//      are told, and they opened the turn with `/battle` because they wanted the duel.
//
// Nothing is recorded in any of the three: no drift row, no open offer, no kept embedding.
describe('drift during a battle', () => {
  it('DETECTS as normal, but does not replace the duel turn', async () => {
    duelRunning('u1');
    mockDetectDrift.mockResolvedValue({
      isDrift: true,
      driftScore: 0.42,
      suggestedAction: 'confirm',
      suggestionTemplate: 'drift-offer',
      correlationId: 'corr-1',
    });
    const flow = loadFlow(ENABLED);

    const result = await flow.runLiveDriftFlow({ ...baseInput });

    // It ran: a battle turn is an ordinary turn, and the counters still see it.
    expect(mockDetectDrift).toHaveBeenCalled();
    // THE WHOLE POINT. A response here becomes the entire turn, so this side would answer with a
    // notice instead of duelling and the comparison would lose a participant.
    expect(result).toBeNull();
  });

  it('does the same for a NON-initiator, so no duel loses a side either way', async () => {
    // Whose duel it is changed only what the old notice SAID. It cannot change whether a side
    // answers: a duel with one participant is not a comparison regardless of who is watching.
    duelRunning('someone-else');
    mockDetectDrift.mockResolvedValue({
      isDrift: true,
      driftScore: 0.42,
      suggestedAction: 'confirm',
      suggestionTemplate: 'drift-offer',
      correlationId: 'corr-1',
    });
    const flow = loadFlow(ENABLED);

    expect(await flow.runLiveDriftFlow({ ...baseInput })).toBeNull();
  });

  it('records nothing for a duel turn, so no offer is left open to accept', async () => {
    // The person was never offered anything, so there must be nothing pending for a later "yes" to
    // resolve against - that would split them out of a conversation they never asked to leave.
    duelRunning('u1');
    mockDetectDrift.mockResolvedValue({
      isDrift: true,
      driftScore: 0.42,
      suggestedAction: 'confirm',
      suggestionTemplate: 'drift-offer',
      correlationId: 'corr-1',
    });
    const flow = loadFlow(ENABLED);
    await flow.runLiveDriftFlow({ ...baseInput });
    expect(mockRecordDriftFire).not.toHaveBeenCalled();
  });
});

describe('basic-classification drift path (basic had no drift before the re-home)', () => {
  it('runs detectDrift and emits the suggestion template when drift fires', async () => {
    mockDetectDrift.mockResolvedValue({
      isDrift: true,
      driftScore: 0.42,
      suggestedAction: 'confirm',
      suggestionTemplate: 'drift-offer',
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
      suggestionTemplate: 'drift-offer', correlationId: 'corr-dup',
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
      suggestionTemplate: 'drift-offer', correlationId: 'corr-key',
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
  const openOffer = (over: Record<string, unknown> = {}) => ({
    taskId: 'task-1',
    channelArn: CHANNEL,
    personId: 'u1',
    kind: 'confirm',
    originatingMessageId: 'msg-0',
    correlationId: 'corr-offer',
    driftEventId: 'evt-1',
    createdAt: '2026-09-12T00:00:00Z',
    ...over,
  });

  it('on an affirmative reply to an open confirm, creates a new channel and returns a NAVIGATE response', async () => {
    mockReadPending.mockResolvedValue(openOffer());
    mockClassifyReply.mockReturnValue('affirmative');
    mockCreateConversationFromDrift.mockResolvedValue({ channelArn: 'arn:new:channel', channelId: 'cid' });

    const flow = loadFlow(ENABLED);
    const result = await flow.runLiveDriftFlow({ ...baseInput, classification: 'premium' });

    expect(mockCreateConversationFromDrift).toHaveBeenCalledTimes(1);
    // The spawned channel carries the PARENT conversation's classification, never one read off a type.
    expect(mockCreateConversationFromDrift).toHaveBeenCalledWith(
      expect.objectContaining({ modelTier: 'premium' }),
    );
    expect(mockResolvePending).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'confirmed' }));
    // The drift event id rides the durable offer, so the acceptance is recorded on it.
    expect(mockRecordDriftOutcome).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt-1', outcome: 'accepted' }));
    expect(result).not.toBeNull();
    expect(result!.messages[0].content).toContain('NAVIGATE_CHANNEL:arn:new:channel');
    // detectDrift is NOT re-run on a confirmed offer.
    expect(mockDetectDrift).not.toHaveBeenCalled();
  });

  /**
   * FR7, THE ACCEPT HALF: taking the person to the EXISTING conversation rather than making another.
   *
   * `drift-detection` decides there is a rival and the offer carries its ARN; this is the branch that
   * honors it. Untested until now, which is the gap the spec's own table recorded as
   * "Validated by: none" - and the failure it allows is the exact thing FR7 exists to prevent: the
   * redirect falling through to the create path and producing the duplicate thread. That failure is
   * invisible from the reply, because both branches answer with a NAVIGATE_CHANNEL to somewhere
   * plausible.
   */
  const openRedirect = (over: Record<string, unknown> = {}) => ({
    taskId: 'task-r',
    channelArn: CHANNEL,
    personId: 'u1',
    kind: 'redirect',
    rivalConversationArn: 'arn:aws:chime:us-east-1:111111111111:app-instance/test/channel/rival',
    originatingMessageId: 'msg-0',
    correlationId: 'corr-offer',
    driftEventId: 'evt-7',
    createdAt: '2026-09-12T00:00:00Z',
    ...over,
  });

  it('on an affirmative reply to an open REDIRECT, navigates to the rival and creates NOTHING', async () => {
    mockReadPending.mockResolvedValue(openRedirect());
    mockClassifyReply.mockReturnValue('affirmative');

    const flow = loadFlow(ENABLED);
    const result = await flow.runLiveDriftFlow({ ...baseInput, classification: 'premium' });

    // THE ASSERTION FR7 IS ABOUT. A redirect that created a channel would satisfy any test looking
    // only at the reply, and would be the duplicate thread the requirement forbids.
    expect(mockCreateConversationFromDrift).not.toHaveBeenCalled();

    expect(result).not.toBeNull();
    expect(result!.messages[0].content).toContain('NAVIGATE_CHANNEL:arn:aws:chime:us-east-1:111111111111:app-instance/test/channel/rival');
    expect(result!.messages[0].content).toContain('Existing conversation');

    // The acceptance is recorded against the rival, so the analytics say where the person went
    // rather than that a conversation was born.
    expect(mockRecordDriftOutcome).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'evt-7',
      outcome: 'accepted',
      newChannelArn: 'arn:aws:chime:us-east-1:111111111111:app-instance/test/channel/rival',
    }));
    expect(mockResolvePending).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'confirmed' }));
    expect(mockDetectDrift).not.toHaveBeenCalled();
  });

  it('leaves a redirect offer that names no rival unacted, rather than creating a conversation', async () => {
    // An offer written by an older deploy, or one whose rival went away. The branch is gated on the
    // ARN being present; without this, falling through to the create path would turn a redirect into
    // exactly the duplicate FR7 prevents - and the person would get a plausible answer either way.
    mockReadPending.mockResolvedValue(openRedirect({ rivalConversationArn: undefined }));
    mockClassifyReply.mockReturnValue('affirmative');

    const flow = loadFlow(ENABLED);
    const result = await flow.runLiveDriftFlow({ ...baseInput });

    expect(mockCreateConversationFromDrift).not.toHaveBeenCalled();
    // The offer stays open and the turn is answered normally rather than acted on wrongly.
    expect(mockResolvePending).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('reads the open offer from the durable store on EVERY drift turn, whatever the message looks like', async () => {
    // THE DEFECT THIS PINS. The offer was read from the Amazon Lex session first, and from Aurora only
    // when the reply looked like a yes or a no. A turn the channel flow answers has no Lex session, so
    // there an ordinary message could not see the open offer and ran detection again beside it.
    mockClassifyReply.mockReturnValue('ambiguous');
    mockDetectDrift.mockResolvedValue({ isDrift: false, driftScore: 0.1, suggestedAction: 'continue', correlationId: 'c' });

    const flow = loadFlow(ENABLED);
    await flow.runLiveDriftFlow({ ...baseInput });

    expect(mockReadPending).toHaveBeenCalledWith({ personId: 'u1', channelArn: CHANNEL });
  });

  it('keeps no state in an event session, so a turn with no Lex session behaves identically', async () => {
    mockReadPending.mockResolvedValue(openOffer());
    mockClassifyReply.mockReturnValue('affirmative');
    mockCreateConversationFromDrift.mockResolvedValue({ channelArn: 'arn:new:channel', channelId: 'cid' });
    const flow = loadFlow(ENABLED);

    // The event carries no sessionState at all: the shape a channel-flow entry produces.
    const result = await flow.runLiveDriftFlow({ ...baseInput });

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('sessionAttributes');
    expect(mockCreateConversationFromDrift).toHaveBeenCalledTimes(1);
  });

  it('passes the ORIGINATING message by reference — the ack text never becomes the new channel content', async () => {
    // SPEC-DRIFT-CONVERGENCE.md "by-reference principle": the new channel references the original user
    // message by id; the confirmation reply ("yes please") is a control token, not conversation content,
    // and must NOT be copied into the spawned channel.
    mockReadPending.mockResolvedValue(openOffer({ taskId: 'task-9', originatingMessageId: 'msg-original-42' }));
    mockClassifyReply.mockReturnValue('affirmative');
    mockCreateConversationFromDrift.mockResolvedValue({ channelArn: 'arn:new:channel2', channelId: 'cid2' });
    // The person's words, read back from Amazon Chime SDK by the id the offer stored.
    mockChimeSend.mockImplementation(async (cmd: { __type?: string; input?: { MessageId?: string } }) => (
      cmd.__type === 'GetChannelMessage' && cmd.input?.MessageId === 'msg-original-42'
        ? { ChannelMessage: { Content: encodeURIComponent('quarterly revenue forecasting') } }
        : {}
    ));

    const flow = loadFlow(ENABLED);
    const ackText = 'yes please';
    await flow.runLiveDriftFlow({ ...baseInput, classification: 'premium', userMessage: ackText });

    expect(mockCreateConversationFromDrift).toHaveBeenCalledTimes(1);
    const createArgs = mockCreateConversationFromDrift.mock.calls[0][0] as Record<string, unknown>;
    // The original message id is carried by reference, and its text read back from the conversation.
    expect(createArgs.originatingMessageId).toBe('msg-original-42');
    expect(createArgs.originatingMessageText).toBe('quarterly revenue forecasting');
    expect(createArgs.topicLabel).toBe('quarterly revenue forecasting');
    // The ack text is nowhere in the channel-creation payload.
    expect(JSON.stringify(createArgs)).not.toContain(ackText);
  });

  it('still creates the conversation under the generic label when the message cannot be read back', async () => {
    mockReadPending.mockResolvedValue(openOffer());
    mockClassifyReply.mockReturnValue('affirmative');
    mockCreateConversationFromDrift.mockResolvedValue({ channelArn: 'arn:new:channel3', channelId: 'cid3' });
    mockChimeSend.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NotFoundException' }));

    const flow = loadFlow(ENABLED);
    await flow.runLiveDriftFlow({ ...baseInput, userMessage: 'yes' });

    const createArgs = mockCreateConversationFromDrift.mock.calls[0][0] as Record<string, unknown>;
    expect(createArgs.topicLabel).toBe('Drift Follow-up');
  });
  // ── THE NEW CONVERSATION KNOWS ITS TOPIC BEFORE ITS FIRST MESSAGE ─────────────────────────────
  //
  // A conversation created by accepting a drift offer exists BECAUSE of a topic, so it is seeded from
  // that topic at version 1 rather than waiting for its own opening exchange. detectDrift refuses to
  // compare against a turn-one seed, so without this the conversation created because of a topic would
  // be the one place drift stayed blind longest.
  it('records the topic as the new conversation first summary', async () => {
    mockReadPending.mockResolvedValue(openOffer());
    mockClassifyReply.mockReturnValue('affirmative');
    mockCreateConversationFromDrift.mockResolvedValue({ channelArn: 'arn:new:channel4', channelId: 'cid4' });

    const flow = loadFlow(ENABLED);
    await flow.runLiveDriftFlow({ ...baseInput, userMessage: 'yes' });

    expect(mockSeedDriftTopic).toHaveBeenCalledTimes(1);
    const seedArgs = mockSeedDriftTopic.mock.calls[0][0] as Record<string, unknown>;
    // The NEW conversation, not the one the offer was made in.
    expect(seedArgs.channelArn).toBe('arn:new:channel4');
    // The same label the conversation is titled with, so the anchor and the sidebar agree.
    const createArgs2 = mockCreateConversationFromDrift.mock.calls[0][0] as Record<string, unknown>;
    expect(seedArgs.topicLabel).toBe(createArgs2.topicLabel);
  });

  it('still answers with the new conversation when the seed fails', async () => {
    // The conversation exists and the person is being sent to it. A failure to write its anchor must
    // be invisible to them. A REJECTION and a SYNCHRONOUS THROW are different failures and this pins
    // the throwing one, which is what escapes a bare .catch() and cost this path a whole turn.
    mockReadPending.mockResolvedValue(openOffer());
    mockClassifyReply.mockReturnValue('affirmative');
    mockCreateConversationFromDrift.mockResolvedValue({ channelArn: 'arn:new:channel5', channelId: 'cid5' });
    mockSeedDriftTopic.mockImplementationOnce(() => { throw new Error('data plane absent'); });

    const flow = loadFlow(ENABLED);
    const result = await flow.runLiveDriftFlow({ ...baseInput, userMessage: 'yes' });

    expect(result).not.toBeNull();
    expect(result!.messages[0].content).toContain('NAVIGATE_CHANNEL:arn:new:channel5');
  });
});

// A DECLINED SUBJECT BELONGS TO THE CONVERSATION.
//
// "Once drift is declined the topic determined as drift becomes a topic of the conversation, so
// therefore should no longer be considered drift." And the offer says "anything else to keep going here",
// so any reply but a yes is that decline.
describe('declining an offer keeps the subject here, as a topic of the conversation', () => {
  const openOffer = {
    taskId: 'task-d', channelArn: CHANNEL, personId: 'u1', kind: 'confirm',
    originatingMessageId: 'msg-d', correlationId: 'corr-d', driftEventId: 'evt-d', createdAt: '2026-09-12T00:00:00Z',
  };

  it('a "no" records the decline, closes the offer, and adopts its topic', async () => {
    mockReadPending.mockResolvedValue(openOffer);
    mockClassifyReply.mockReturnValue('negative');
    mockDetectDrift.mockResolvedValue({ isDrift: false, driftScore: 0.1, suggestedAction: 'continue', correlationId: 'c' });
    const flow = loadFlow(ENABLED);

    const result = await flow.runLiveDriftFlow({ ...baseInput, userMessage: 'no' });

    expect(mockRecordDriftOutcome).toHaveBeenCalledWith({ eventId: 'evt-d', outcome: 'declined' });
    expect(mockResolvePending).toHaveBeenCalledWith({ taskId: 'task-d', outcome: 'declined' });
    expect(mockAdoptTopic).toHaveBeenCalledWith({ channelArn: CHANNEL, correlationId: 'corr-d' });
    // The turn is answered normally.
    expect(result).toBeNull();
  });

  it('hands over the question the offer held, read back from the conversation, so the turn answers it', async () => {
    mockReadPending.mockResolvedValue(openOffer);
    mockClassifyReply.mockReturnValue('negative');
    mockDetectDrift.mockResolvedValue({ isDrift: false, driftScore: 0.1, suggestedAction: 'continue', correlationId: 'c' });
    mockChimeSend.mockImplementation(async (cmd: { __type?: string; input?: { MessageId?: string } }) => (
      cmd.__type === 'GetChannelMessage' && cmd.input?.MessageId === 'msg-d'
        ? { ChannelMessage: { Content: encodeURIComponent("What's our net revenue retention?") } }
        : {}
    ));
    const held: Array<{ messageId: string; text: string }> = [];
    const flow = loadFlow(ENABLED);

    const result = await flow.runLiveDriftFlow({ ...baseInput, userMessage: 'no', onHeldQuestion: (q: { messageId: string; text: string }) => held.push(q) });

    expect(held).toEqual([{ messageId: 'msg-d', text: "What's our net revenue retention?" }]);
    expect(result).toBeNull();
  });

  it('a held question that cannot be read back still lets the reply be answered', async () => {
    mockReadPending.mockResolvedValue(openOffer);
    mockClassifyReply.mockReturnValue('negative');
    mockDetectDrift.mockResolvedValue({ isDrift: false, driftScore: 0.1, suggestedAction: 'continue', correlationId: 'c' });
    mockChimeSend.mockRejectedValue(Object.assign(new Error('gone'), { name: 'NotFoundException' }));
    const held: unknown[] = [];
    const flow = loadFlow(ENABLED);

    const result = await flow.runLiveDriftFlow({ ...baseInput, userMessage: 'no', onHeldQuestion: (q: unknown) => held.push(q) });

    expect(held).toEqual([]);
    expect(result).toBeNull();
    expect(mockAdoptTopic).toHaveBeenCalled();
  });

  it('an ordinary message that carries on is the same decline, and adopts the same topic', async () => {
    // Before, this left the offer pending in the Lex session and kept detection off while it lived.
    mockReadPending.mockResolvedValue(openOffer);
    mockClassifyReply.mockReturnValue('ambiguous');
    mockDetectDrift.mockResolvedValue({ isDrift: false, driftScore: 0.1, suggestedAction: 'continue', correlationId: 'c' });
    const flow = loadFlow(ENABLED);

    await flow.runLiveDriftFlow({ ...baseInput, userMessage: 'actually, what about the second quarter?' });

    expect(mockResolvePending).toHaveBeenCalledWith({ taskId: 'task-d', outcome: 'declined' });
    expect(mockAdoptTopic).toHaveBeenCalledWith({ channelArn: CHANNEL, correlationId: 'corr-d' });
  });

  it('the reply that declines is answered, never offered again, even when it moves to a third subject', async () => {
    // A reply such as "Before that, what is 17 multiplied by 3?" is answered along with the held question,
    // and the declined offer is never made again.
    mockReadPending.mockResolvedValue(openOffer);
    mockClassifyReply.mockReturnValue('ambiguous');
    mockDetectDrift.mockResolvedValue({
      isDrift: true, driftScore: 0.9, suggestedAction: 'confirm', confidence: 'high', correlationId: 'c3',
      suggestionTemplate: 'It looks like you are shifting topics.',
    });
    const flow = loadFlow(ENABLED);

    const result = await flow.runLiveDriftFlow({ ...baseInput, userMessage: 'Before that, what is 17 multiplied by 3?' });

    expect(result).toBeNull();
    expect(mockDetectDrift).not.toHaveBeenCalled();
    expect(mockAdoptTopic).toHaveBeenCalledWith({ channelArn: CHANNEL, correlationId: 'corr-d' });
  });

  it('a REDELIVERY of the message that made the offer does not decline it', async () => {
    // THE DEFECT (code review). The first delivery saved the offer; the second read it and would have
    // declined it with the very message it answers, so the person's "yes" found nothing to confirm.
    // baseInput's message is msg-1, and this offer was made by msg-1.
    mockReadPending.mockResolvedValue({ ...openOffer, originatingMessageId: 'msg-1' });
    mockClassifyReply.mockReturnValue('ambiguous');
    const flow = loadFlow(ENABLED);

    const result = await flow.runLiveDriftFlow({ ...baseInput });

    expect(result).toBeNull();
    expect(mockResolvePending).not.toHaveBeenCalled();
    expect(mockRecordDriftOutcome).not.toHaveBeenCalled();
    expect(mockAdoptTopic).not.toHaveBeenCalled();
    // And no second offer is attempted beside the open one.
    expect(mockDetectDrift).not.toHaveBeenCalled();
  });

  it('a message sent BEFORE the offer was opened does not answer it', async () => {
    // Sent while the offer was still being made, so the person had not seen it: not a reply.
    mockReadPending.mockResolvedValue({ ...openOffer, createdAt: '2026-09-12T10:00:05.000Z' });
    mockClassifyReply.mockReturnValue('ambiguous');
    const flow = loadFlow(ENABLED);

    const result = await flow.runLiveDriftFlow({
      ...baseInput,
      event: { ...baseInput.event, requestAttributes: { ...baseInput.event.requestAttributes, 'CHIME.message.id': '' } },
      resolveInbound: async () => ({ messageId: 'msg-early', createdAt: '2026-09-12T10:00:04.000Z' }),
    });

    expect(result).toBeNull();
    expect(mockResolvePending).not.toHaveBeenCalled();
    expect(mockAdoptTopic).not.toHaveBeenCalled();
  });

  it('a message sent AFTER the offer answers it', async () => {
    mockReadPending.mockResolvedValue({ ...openOffer, createdAt: '2026-09-12T10:00:05.000Z' });
    mockClassifyReply.mockReturnValue('negative');
    mockDetectDrift.mockResolvedValue({ isDrift: false, driftScore: 0.1, suggestedAction: 'continue', correlationId: 'c' });
    const flow = loadFlow(ENABLED);

    await flow.runLiveDriftFlow({
      ...baseInput,
      userMessage: 'no',
      event: { ...baseInput.event, requestAttributes: { ...baseInput.event.requestAttributes, 'CHIME.message.id': '' } },
      resolveInbound: async () => ({ messageId: 'msg-late', createdAt: '2026-09-12T10:00:09.000Z' }),
    });

    expect(mockResolvePending).toHaveBeenCalledWith({ taskId: 'task-d', outcome: 'declined' });
  });

  it('a fired offer keeps its embedding for adoption and carries its drift event on the durable record', async () => {
    mockDetectDrift.mockResolvedValue({
      isDrift: true, driftScore: 0.5, suggestedAction: 'confirm',
      suggestionTemplate: 'drift-offer', correlationId: 'corr-new',
    });
    mockRecordDriftFire.mockResolvedValue('evt-new');
    mockSavePending.mockResolvedValue({ taskId: 'task-new' });
    const flow = loadFlow(ENABLED);

    await flow.runLiveDriftFlow({ ...baseInput });

    expect(mockDetectDrift.mock.calls[0][0].retainOfferEmbedding).toBe(true);
    expect(mockSavePending).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: 'corr-new', driftEventId: 'evt-new',
    }));
  });
});

describe('the scope is resolved only when question 3 is asked', () => {
  // The scope costs one SearchChannels page per 50 conversations the room shares with the assistant.
  // Resolved on every turn, a person sharing 597 paid 12 sequential searches a turn and a burst was
  // throttled (2026-10-05). Only a turn that fires ever asks question 3.
  const chimeCallTypes = () => mockChimeSend.mock.calls.map((c) => (c[0] as { __type?: string }).__type);

  it('makes no membership read and no search on a turn that does not fire', async () => {
    mockDetectDrift.mockResolvedValue({
      isDrift: false, driftScore: 0.1, suggestedAction: 'continue', confidence: 'low', signalAvailable: true, correlationId: 'c',
    });
    const flow = loadFlow(ENABLED);
    await flow.runLiveDriftFlow({ ...baseInput });

    expect(mockDetectDrift).toHaveBeenCalledWith(expect.objectContaining({ deferRelatedLookup: true }));
    expect(mockDetectDrift.mock.calls[0][0]).not.toHaveProperty('scopedChannelArns');
    expect(chimeCallTypes()).not.toContain('ListMemberships');
    expect(chimeCallTypes()).not.toContain('Search');
    expect(mockResolveDriftRival).not.toHaveBeenCalled();
  });

  it('resolves the scope live when drift fires, and asks for the rival inside it', async () => {
    const embedding = [0.1, 0.2, 0.3];
    mockDetectDrift.mockResolvedValue({
      isDrift: true, driftScore: 0.5, suggestedAction: 'confirm', confidence: 'medium', signalAvailable: true,
      correlationId: 'corr-1', suggestionTemplate: 'drift-offer',
      relatedLookupPending: { messageEmbedding: embedding },
    });
    const OTHER = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/other';
    mockChimeSend.mockImplementation(async (cmd: { __type?: string }) => {
      if (cmd.__type === 'ListMemberships') return { ChannelMemberships: [{ Member: { Arn: baseInput.event.requestAttributes['CHIME.sender.arn'] } }] };
      if (cmd.__type === 'Search') return { Channels: [{ ChannelArn: CHANNEL }, { ChannelArn: OTHER }] };
      return {};
    });
    mockResolveDriftRival.mockResolvedValue({
      isDrift: true, driftScore: 0.5, suggestedAction: 'redirect', confidence: 'medium', signalAvailable: true,
      correlationId: 'corr-1', suggestionTemplate: 'Continue there?', rivalConversationArn: OTHER,
    });
    mockRecordDriftFire.mockResolvedValue('evt');
    mockSavePending.mockResolvedValue({ taskId: 't' });

    const flow = loadFlow(ENABLED);
    await flow.runLiveDriftFlow({ ...baseInput });

    expect(chimeCallTypes()).toContain('Search');
    expect(mockResolveDriftRival).toHaveBeenCalledWith(expect.objectContaining({
      channelArn: CHANNEL, messageEmbedding: embedding, scopedChannelArns: [CHANNEL, OTHER], classification: 'basic',
    }));
    // What gets recorded is the RESOLVED result: the redirect, and never the transport embedding.
    const recorded = mockRecordDriftFire.mock.calls[0][0] as { result: Record<string, unknown> };
    expect(recorded.result.rivalConversationArn).toBe(OTHER);
    expect(recorded.result).not.toHaveProperty('relatedLookupPending');
  });
});

// Make this file a module so project-mode tsc isolates its top-level test scaffolding.
export {};
