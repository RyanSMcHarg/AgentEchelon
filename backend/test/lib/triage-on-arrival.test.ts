/**
 * TRIAGE RUNS WHEN THE MESSAGE ARRIVES, NOT WHEN THE TURN ENDS (ADR-033).
 *
 * The question the whole design exists to ask is whether the work in flight is still wanted. Triage
 * ran in the processor's `finally`, so it began only once the turn ENDED, and asked that question
 * about a report that had already finished. An interrupt evaluated after the work completes is not an
 * interrupt.
 *
 * ── THE LOCK QUESTION, AND WHY IT DISSOLVED ─────────────────────────────────────────────────────
 *
 * Moving it looked blocked: off-turn, either the lock is released while triage is pending and a
 * message claims the conversation alongside it, or the lock is held by something whose liveness
 * nothing can attest and only a TTL frees it - which tenet 2 forbids.
 *
 * Both disappear once the two questions are separated. The TURN lock answers "who may answer", and
 * the turn being triaged behind is still running and still holds it. Triage answers nothing. What it
 * needs is exclusion from ITSELF, which is a weaker claim whose stranding costs a delay rather than
 * silence - so that one MAY expire on a timer, and safely.
 *
 * ── AND THE COMMON PATH IS SILENCE ──────────────────────────────────────────────────────────────
 *
 * This rule runs on every message in the deployment. Almost all of them must leave without a single
 * call, or a queue feature becomes a tax on every conversation that never queues anything.
 */

const mockRead = jest.fn();
const mockClaim = jest.fn();
const mockRelease = jest.fn();
const mockTriage = jest.fn();
const mockDispatch = jest.fn();
const mockTag = jest.fn();
const mockAssistants = jest.fn();

jest.mock('../../lambda/src/lib/turn-lock.js', () => ({
  readTurnState: (...a: unknown[]) => mockRead(...a),
  claimTriage: (...a: unknown[]) => mockClaim(...a),
  releaseTriage: (...a: unknown[]) => mockRelease(...a),
}));
jest.mock('../../lambda/src/lib/turn-triage.js', () => ({
  triageQueuedMessages: (...a: unknown[]) => mockTriage(...a),
  dispatchTriageTurn: (...a: unknown[]) => mockDispatch(...a),
}));
// THE NAME HAS TO MATCH THE EXPORT THE MODULE ACTUALLY CALLS. Triage moved to
// `readChannelClassificationTag` in ADR-045 decision 2, and a factory still exporting only the old
// name fails as a TypeError ("not a function") rather than as the assertion under test - which reads
// like a broken test instead of a caller that changed.
jest.mock('../../lambda/src/lib/channel-classification.js', () => ({
  readChannelClassificationTag: (...a: unknown[]) => mockTag(...a),
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = jest.fn(); },
}));
// WHICH ASSISTANT'S QUEUE THIS IS comes from the live assignment records.
jest.mock('../../lambda/src/lib/default-agents.js', () => ({
  liveAssistantsByHandleOrThrow: (...a: unknown[]) => mockAssistants(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { triageOnArrival } = require('../../lambda/src/lib/triage-on-arrival');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/atlas';
const USER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/alice';

/** A stream event, defaulting to the deferral notice that SHOULD trigger. */
const evt = (over: Record<string, unknown> = {}) => ({
  EventType: 'CREATE_CHANNEL_MESSAGE',
  Payload: {
    MessageId: 'notice-1',
    ChannelArn: CHANNEL,
    Sender: { Arn: BOT },
    Metadata: JSON.stringify({ botResponse: true, respPhase: 'notice', queueDepth: 2 }),
    ...over,
  },
});

beforeEach(() => {
  [mockRead, mockClaim, mockRelease, mockTriage, mockDispatch, mockTag, mockAssistants].forEach((m) => m.mockReset());
  mockAssistants.mockResolvedValue(new Map([['analyst', { handle: 'analyst', botArn: BOT, role: 'primary' }]]));
  mockRead.mockResolvedValue({ busy: true, queued: ['m1', 'm2'] });
  mockClaim.mockResolvedValue(true);
  mockRelease.mockResolvedValue(undefined);
  mockTag.mockResolvedValue('standard');
  mockTriage.mockResolvedValue({
    messages: [{ messageId: 'm1', content: 'a', targeted: false, senderArn: USER }],
    allTriaged: true,
    visibility: 'conversation',
  });
  mockDispatch.mockResolvedValue(true);
});

describe('what triggers it', () => {
  it('a deferral notice with something still waiting', async () => {
    await triageOnArrival(evt());
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('NOT an ordinary message from a person', async () => {
    // The common path. A queue feature must not cost a lookup on every message in the deployment.
    await triageOnArrival(evt({ Sender: { Arn: USER }, Metadata: '{}' }));
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('NOT an answer from an assistant', async () => {
    await triageOnArrival(evt({ Metadata: JSON.stringify({ botResponse: true, respPhase: 'final' }) }));
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('NOT the SETTLED notice, which reports an empty queue', async () => {
    // The settled notice carries zero. Acting on it would read a queue that has already been read.
    await triageOnArrival(evt({
      Metadata: JSON.stringify({ botResponse: true, respPhase: 'notice', queueDepth: 0 }),
    }));
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('NOT a message whose metadata cannot be parsed', async () => {
    await triageOnArrival(evt({ Metadata: 'not json' }));
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('the record decides, not the notice', () => {
  it('leaves when the queue has already been read', async () => {
    // A re-delivered or updated notice is harmless because the RECORD is what is consulted. Kinesis
    // is at-least-once, so this is ordinary rather than exotic.
    mockRead.mockResolvedValue({ busy: true, queued: [] });
    await triageOnArrival(evt());
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('leaves when the state cannot be read', async () => {
    mockRead.mockRejectedValue(new Error('throttled'));
    await expect(triageOnArrival(evt())).resolves.toBeUndefined();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('one triage at a time', () => {
  it('does nothing when another run holds the claim', async () => {
    // Two notices arriving together would otherwise both read the same queue and create the work
    // twice - duplicates a person has to close by hand.
    mockClaim.mockResolvedValue(false);
    await triageOnArrival(evt());
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('releases the claim even when the dispatch throws', async () => {
    // A claim left behind blocks triage until its own expiry. Releasing here makes even that wait
    // unnecessary.
    mockDispatch.mockRejectedValue(new Error('boom'));
    await expect(triageOnArrival(evt())).resolves.toBeUndefined();
    expect(mockRelease).toHaveBeenCalled();
  });

  // THIS CASE USED TO ASSERT THE OPPOSITE, and the behavior it asserted is what put five tasks and
  // two proposals in front of one person. Releasing on the happy path frees the claim while the turn
  // just dispatched is still reading, and the queue is not cleared until that turn ends - so the next
  // dispatcher reads the same messages again. Kept, inverted, so the old expectation cannot come back
  // without someone reading why it went.
  it('HOLDS the claim on the happy path, because a turn is now reading the queue', async () => {
    await triageOnArrival(evt());
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

describe('it never touches the TURN lock', () => {
  it('dispatches without claiming or handing over anything', async () => {
    // THE RESOLUTION, asserted. The turn being triaged behind is still running and still holds the
    // lock; a handover here would be the turn-completion design wearing new clothes, and claiming
    // would queue triage behind the very turn it exists to describe.
    const lock = require('../../lambda/src/lib/turn-lock.js');
    expect(lock.claimTurn).toBeUndefined();
    expect(lock.handOverLock).toBeUndefined();
    await triageOnArrival(evt());
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('carries the queue\'s visibility to the turn it dispatches', async () => {
    mockTriage.mockResolvedValue({
      messages: [{ messageId: 'm1', content: 'a', targeted: true, senderArn: USER }],
      allTriaged: true,
      visibility: 'private',
    });
    await triageOnArrival(evt());
    expect(mockDispatch.mock.calls[0][0].visibility).toBe('private');
  });
});

describe('an unserveable conversation', () => {
  it('does nothing when the classification cannot be resolved', async () => {
    // Same fail-closed direction the task service takes: no tag, no action.
    mockTag.mockResolvedValue('');
    await triageOnArrival(evt());
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });
});

describe('the assistant whose queue this is has to be named', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => errorSpy.mockRestore());

  it('triages nothing for a bot no record names, and says so as a security event', async () => {
    mockAssistants.mockResolvedValue(new Map([['analyst', { handle: 'analyst', botArn: 'arn:other-bot', role: 'primary' }]]));
    await triageOnArrival(evt());
    expect(mockTriage).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[SecurityEvent]'), expect.objectContaining({ reason: 'no-assignment-record' }));
  });

  it('triages nothing when the records cannot be read in a classification that has several', async () => {
    mockTag.mockResolvedValue('premium');
    mockAssistants.mockRejectedValue(new Error('throttled'));
    await triageOnArrival(evt());
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[SecurityEvent]'), expect.objectContaining({ reason: 'assistant-index-unreadable' }));
  });

  it('still triages when the records cannot be read in a classification that has one assistant', async () => {
    // `standard` has only its primary, so the primary IS the assistant; nothing is substituted.
    mockAssistants.mockRejectedValue(new Error('throttled'));
    await triageOnArrival(evt());
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

/**
 * A TRIAGE TURN'S TOOL SURFACE IS SCOPED, NOT ABSENT (DESIGN 2.3).
 *
 * Its job is to produce a READING - amends or new, in what order - and hand it back for a person to
 * confirm. The prompt says "do not answer any of them yet", and a prompt is the weakest possible way
 * to say that while the model is holding tools that let it advance a task or generate a document.
 *
 * Executing a reading is the exact failure this design exists to prevent, and through the tool
 * surface it would arrive BEFORE the reply exists - so no amount of parsing the reply catches it.
 * The constraint has to be structural, and this is where that is asserted.
 *
 * ── WHAT CHANGED, AND WHY THE EARLIER VERSION OF THIS TEST WAS TOO STRONG ───────────────────────
 *
 * It used to assert the surface was EMPTY. That satisfied the guard and also removed step 3 of the
 * loop: a turn that cannot look anything up can never decide it needs another pass, so it always
 * returns its first impression. The guard belongs in what the tools ARE, so what is pinned now is
 * that everything with a SIDE EFFECT stays withheld. A read cannot execute the work it was only
 * asked to classify, which is the property that actually matters.
 */
describe('a triage turn cannot act', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');

  it('withholds the edit tools at BOTH call sites', () => {
    expect(SRC).toContain('const isTriageTurn = !!event.triage?.ids.length');
    // Both call sites - the external-provider fallback and the default Bedrock path - or the
    // constraint holds on one model provider and not the other.
    const edits = SRC.match(/enableEditTools: enableEditTools && !isTriageTurn/g) || [];
    expect(edits.length).toBe(2);
  });

  it('runs no task loop, so it cannot advance the work it is reading about', () => {
    expect(SRC).toMatch(/isTriageTurn \? \{\} : \{ taskContext \}/);
  });

  it('never withholds the READ-ONLY context tool, because step 3 needs it', () => {
    // The regression in the other direction: restoring `!isTriageTurn` here would re-remove the
    // ability to look anything up, and the loop would quietly become a single call again while every
    // other test still passed.
    expect(SRC).not.toMatch(/enableCompanyContextTool: !isTriageTurn/);
  });
});

/**
 * A STAGE UPDATE IS NOT A NEW DEFERRAL.
 *
 * The drain updates the SAME notice as it moves - reviewing, clarifying, clearing - and each update
 * carries the same phase and the same non-zero depth, because the queue genuinely still holds those
 * messages until the turn reading them clears them at the end.
 *
 * So every stage re-triggered this rule, inside the window where the claim had been released and the
 * queue not yet cleared: a second triage over the same ids. Triage turns bypass the turn claim and
 * task creation is not idempotent, so the person got duplicate work items and two proposals for one
 * queue. A code review found it; the stage feature had opened it.
 */
describe('the drain updating its own notice does not re-trigger triage', () => {
  it('ignores a notice that carries a stage', async () => {
    await triageOnArrival({
      Payload: {
        ChannelArn: CHANNEL,
        Sender: { Arn: BOT },
        MessageId: 'notice-1',
        Metadata: JSON.stringify({
          botResponse: true, respPhase: 'notice', queueDepth: 3, queueStatus: 'reviewing',
        }),
      },
    } as never);

    // Not even a read: this is the common path once a drain is running, and it must cost nothing.
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('still acts on a genuine deferral, which carries no stage', async () => {
    mockRead.mockResolvedValue({ queued: ['m1'], holder: 'turn-1' });
    mockClaim.mockResolvedValue(false);

    await triageOnArrival({
      Payload: {
        ChannelArn: CHANNEL,
        Sender: { Arn: BOT },
        MessageId: 'notice-2',
        Metadata: JSON.stringify({ botResponse: true, respPhase: 'notice', queueDepth: 1 }),
      },
    } as never);

    expect(mockRead).toHaveBeenCalled();
  });
});

/**
 * The claim's LIFETIME, which is what a second reading of the same queue turned on. The mutex was
 * always correct; it was simply let go while the turn it started was still reading. See
 * `the-triage-claim-lasts-the-drain.test.ts` for the other half, where the drain ends it.
 */
describe('the claim is held for the drain, not the dispatch', () => {
  it('does NOT release the claim once a turn is reading the queue', async () => {
    await triageOnArrival(evt());

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    // Releasing here is what let the handover dispatcher read the same messages seconds later: the
    // turn is still reading and the queue is not cleared until it finishes. The drain ends the claim.
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('releases the claim when the dispatch did not start a turn', async () => {
    // `dispatchTriageTurn` swallows its own failures and returns false - an unresolvable router, a
    // throttled invoke. Nothing is reading, so holding the claim would stall triage for its whole
    // expiry over a queue nobody is looking at.
    mockDispatch.mockResolvedValue(false);

    await triageOnArrival(evt());

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when there was nothing to read after all', async () => {
    mockTriage.mockResolvedValue({ messages: [], allTriaged: true, visibility: 'conversation' });

    await triageOnArrival(evt());

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when the run fails', async () => {
    mockTriage.mockRejectedValue(new Error('chime is down'));

    await triageOnArrival(evt());

    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE NOTICE IS UPDATED IN PLACE, SO ITS ID IS NOT AN IDENTITY.
 *
 * A second message arriving behind a deferred turn rewrites the SAME notice with a higher depth. That
 * is a real trigger - the queue changed - but it arrives carrying the message id of the first notice,
 * so the claim built from it was the one the running triage already held, and `claimTriage` grants a
 * claim to its own holder so that a redelivery is idempotent. Two different runs looked like one run
 * twice, and the second read a queue that was already being read.
 *
 * Observed live: two dispatches seven seconds apart under one correlation id.
 */
describe('two notices for the same queue are two different claims', () => {
  const depthEvt = (queueDepth: number) => evt({
    Metadata: JSON.stringify({ botResponse: true, respPhase: 'notice', queueDepth }),
  });

  it('builds a DIFFERENT claim when the depth has moved', async () => {
    await triageOnArrival(depthEvt(2));
    await triageOnArrival(depthEvt(3));

    const claims = mockClaim.mock.calls.map((c) => c[0].by);
    expect(claims).toHaveLength(2);
    expect(claims[0]).not.toEqual(claims[1]);
  });

  it('builds the SAME claim for the same event redelivered, so a retry stays idempotent', async () => {
    // Kinesis is at-least-once. The identical event must re-acquire its own claim rather than be
    // treated as a second reading - that property is why `triagedBy = :me` exists and it is kept.
    await triageOnArrival(depthEvt(2));
    await triageOnArrival(depthEvt(2));

    const claims = mockClaim.mock.calls.map((c) => c[0].by);
    expect(claims[0]).toEqual(claims[1]);
  });

  it('stands down when the reading in flight already holds the claim', async () => {
    mockClaim.mockResolvedValue(false);

    await triageOnArrival(depthEvt(3));

    // The message is not lost: the turn that holds the claim folds it in before it speaks.
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('the reading is told that something is running', () => {
  // A message is in the queue BECAUSE a turn was running - that is the only way it got there - and
  // this dispatch never said so. `inFlight` was false on every arrival reading in production, and
  // three rules gated on it silently did nothing: "none for an amendment" (so every amendment opened
  // its own task), the work in progress taking a subject of its own, and the amendment being
  // recorded for the running turn to fold in. Each was written, unit-tested, and unreachable.
  it('declares the work in flight when a turn holds the conversation', async () => {
    mockRead.mockResolvedValue({ busy: true, queued: ['m1'] });
    await triageOnArrival(evt());
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ inFlightLabel: expect.any(String) }),
    );
  });

  it('declares nothing when no turn is running, because there is nothing to amend', async () => {
    mockRead.mockResolvedValue({ busy: false, queued: ['m1'] });
    await triageOnArrival(evt());
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.not.objectContaining({ inFlightLabel: expect.anything() }),
    );
  });
});
