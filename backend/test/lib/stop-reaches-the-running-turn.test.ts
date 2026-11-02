/**
 * `/stop` HAS TO REACH THE TURN THAT IS ALREADY RUNNING (ADR-033).
 *
 * Cancelling the task records is the durable half and it already worked. What did not: the Lambda
 * mid-Bedrock-call has no idea, finishes, and posts the answer. A person who stopped a report
 * receives the report, and from their side the escape hatch did nothing.
 *
 * A running Lambda cannot be signaled, so the turn ASKS, once, at the last instant its answer is
 * still suppressible.
 *
 * ── THE RULE THAT CAN BE SILENTLY WRONG ─────────────────────────────────────────────────────────
 *
 * It is a comparison of two RECORDED INSTANTS, never a timeout. The stop knows when it happened and
 * the turn knows when it began, so a stop counts only when it arrived AFTER the work started. Get
 * that backwards and an old stop swallows every later answer in the conversation for as long as the
 * marker lives - a conversation that has gone permanently silent, which is the failure this codebase
 * treats as worse than a duplicate.
 *
 * ── AND IT FAILS OPEN INTO DELIVERING ───────────────────────────────────────────────────────────
 *
 * An unreadable marker delivers the answer. Being wrong that way costs an answer somebody asked to
 * stop; being wrong the other way costs silence.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
}));
jest.mock('../../lambda/src/lib/abuse-controls.js', () => ({ readPlaceholderMapping: jest.fn() }));

process.env.TURN_STATE_TABLE = 'turn-state';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lock = require('../../lambda/src/lib/turn-lock');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const T0 = 1_800_000_000_000;
const BOT = 'analyst';
const OTHER_BOT = 'researcher';

beforeEach(() => mockSend.mockReset());

describe('a stop is recorded as an instant', () => {
  it('writes a marker keyed on the conversation, the person who asked, AND the assistant it named', async () => {
    // PER PERSON, because a conversation-wide marker let Alice's `/stop` suppress the answer Bob was
    // waiting for. PER RESPONDER, because a room can hold several assistants and a marker without one
    // stops the assistant halfway through an unrelated lookup along with the one writing the report.
    mockSend.mockResolvedValue({});
    await lock.recordStop(CHANNEL, 'alice', BOT);
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.input.Key.pk).toBe(`stop#${CHANNEL}#alice#${BOT}`);
    expect(cmd.input.UpdateExpression).toContain('stoppedAt');
  });

  it('the marker expires once no turn it could apply to is still running', async () => {
    // It names a person (`stop#<channel>#<personId>#<responder>`), so it declares its own expiry: the
    // longest any turn runs (`STALE_AFTER_MS`, five minutes by default), in the table's `ttl` attribute.
    mockSend.mockResolvedValue({});
    const before = Math.floor(Date.now() / 1000);
    await lock.recordStop(CHANNEL, 'alice', BOT);
    const { input } = mockSend.mock.calls[0][0];
    expect(input.UpdateExpression).toContain('#ttl = :ttl');
    expect(input.ExpressionAttributeNames).toEqual({ '#ttl': 'ttl' });
    expect(lock.STOP_MARKER_TTL_SECONDS).toBe(300);
    expect(input.ExpressionAttributeValues[':ttl']).toBeGreaterThanOrEqual(before + 300);
    expect(input.ExpressionAttributeValues[':ttl']).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
    expect(lock.stopMarkerExpiry(T0)).toBe(T0 / 1000 + 300);
  });

  it('writes NOTHING when no assistant was named', async () => {
    // The guard that keeps the retired channel-wide marker from returning through a missing argument
    // rather than a decision. The task cancellation beside it still runs, so the stop is not lost.
    mockSend.mockResolvedValue({});
    await lock.recordStop(CHANNEL, 'alice', '');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not throw when the marker cannot be written', async () => {
    // The task records are the durable half and are cancelled first. A failed marker costs the
    // suppression of one answer, not the stop itself, so it must never fail the /stop turn.
    mockSend.mockRejectedValue(new Error('throttled'));
    await expect(lock.recordStop(CHANNEL, 'alice', BOT)).resolves.toBeUndefined();
  });
});

/**
 * THE PROPERTY TARGETING EXISTS FOR, asserted where it can actually go wrong.
 *
 * A stop aimed at one assistant must not suppress another's answer. Before the responder was part of
 * the key this was unassertable, because both assistants read the same marker and there was nothing
 * to distinguish them: the test could only have restated the bug.
 */
describe('a stop reaches ONLY the assistant it named', () => {
  it('suppresses the assistant the stop named', async () => {
    mockSend.mockResolvedValue({ Item: { stoppedAt: T0 + 5_000 } });
    expect(await lock.wasStoppedSince(CHANNEL, T0, 'alice', BOT)).toBe(true);
    expect(mockSend.mock.calls[0][0].input.Key.pk).toBe(`stop#${CHANNEL}#alice#${BOT}`);
  });

  it('leaves a DIFFERENT assistant in the same room running', async () => {
    // The marker for `analyst` is not the marker `researcher` reads, so the second assistant's key
    // simply is not there. Work nobody asked to lose survives.
    mockSend.mockImplementation((cmd: any) =>
      Promise.resolve(cmd.input.Key.pk === `stop#${CHANNEL}#alice#${BOT}`
        ? { Item: { stoppedAt: T0 + 5_000 } }
        : {}));
    expect(await lock.wasStoppedSince(CHANNEL, T0, 'alice', BOT)).toBe(true);
    expect(await lock.wasStoppedSince(CHANNEL, T0, 'alice', OTHER_BOT)).toBe(false);
  });

  it('delivers when the turn cannot say which assistant it belongs to', async () => {
    // Read from the other side: a turn with no responder cannot be the one a targeted stop named, and
    // guessing would suppress an answer the stop was not aimed at.
    expect(await lock.wasStoppedSince(CHANNEL, T0, 'alice', '')).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('whether a stop belongs to THIS turn', () => {
  const stoppedAt = (ms: number) => mockSend.mockResolvedValue({ Item: { stoppedAt: ms } });

  it('suppresses when the stop arrived AFTER the turn started', async () => {
    stoppedAt(T0 + 5_000);
    expect(await lock.wasStoppedSince(CHANNEL, T0, 'alice', BOT)).toBe(true);
  });

  it('does NOT suppress a stop from BEFORE this turn started', async () => {
    // The one that goes silently wrong. An earlier stop belongs to an earlier turn, and treating it
    // as this turn's would swallow every answer in the conversation until the marker expired.
    stoppedAt(T0 - 1);
    expect(await lock.wasStoppedSince(CHANNEL, T0, 'alice', BOT)).toBe(false);
  });

  it('does not suppress on the exact instant the turn started', async () => {
    // Strictly after. A stop at the same millisecond raced the turn's own start and did not arrive
    // during it, so the turn is not the one it meant.
    stoppedAt(T0);
    expect(await lock.wasStoppedSince(CHANNEL, T0, 'alice', BOT)).toBe(false);
  });

  it('does not suppress when no stop was ever recorded', async () => {
    mockSend.mockResolvedValue({});
    expect(await lock.wasStoppedSince(CHANNEL, T0, 'alice', BOT)).toBe(false);
  });

  it('ignores a marker whose instant is not a number', async () => {
    // A malformed value must never become a decision, which is the same rule the triage parse takes.
    mockSend.mockResolvedValue({ Item: { stoppedAt: 'yesterday' } });
    expect(await lock.wasStoppedSince(CHANNEL, T0, 'alice', BOT)).toBe(false);
  });
});

describe('it fails open into DELIVERING', () => {
  it('delivers when the marker cannot be read', async () => {
    // A table hiccup must not start swallowing answers people are waiting for.
    mockSend.mockRejectedValue(new Error('throttled'));
    expect(await lock.wasStoppedSince(CHANNEL, T0, 'alice', BOT)).toBe(false);
  });

  it('delivers when the turn has no start instant to compare against', async () => {
    // Without one there is no question to answer, and inventing an answer would mean guessing.
    expect(await lock.wasStoppedSince(CHANNEL, 0, 'alice', BOT)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('it is independent of the queue switch', () => {
  it('works on a deployment that has not enabled queueing', () => {
    // Suppressing an answer somebody asked to stop is not part of the queueing behavior. Coupling
    // them would leave the escape hatch broken everywhere queueing is off, which is everywhere.
    const prev = process.env.TURN_QUEUE_ENABLED;
    delete process.env.TURN_QUEUE_ENABLED;
    expect(lock.turnStopEnabled()).toBe(true);
    expect(lock.turnQueueEnabled()).toBe(false);
    if (prev !== undefined) process.env.TURN_QUEUE_ENABLED = prev;
  });
});

/**
 * WHAT `/stop` MUST NOT DO: touch the queue.
 *
 * It stops the work that is RUNNING. The queue holds something else entirely - requests the person
 * sent while they waited and never withdrew. "Stop what you are doing" is not "forget the other
 * things I asked you", so discarding them would be data loss arriving through the one command a
 * person uses to regain control, and it would punish them for having kept typing.
 *
 * This was implemented the wrong way first, from a draft of the ADR that said `/stop` clears the
 * queue before triage. The reasoning is seductive - a stop feels like it should reach everything
 * pending - and it is only wrong once you notice the queue holds the person's OWN unanswered
 * requests rather than the assistant's work. Asserted as SOURCE because the alternative is booting
 * the whole processor to observe an absence.
 */
describe('a stop leaves the queue alone', () => {
  const read = (rel: string) => require('fs').readFileSync(
    require('path').join(__dirname, '../../lambda/src', rel), 'utf8');

  it('the component that reads the queue does not branch on a stop', () => {
    // Triage moved from the processor's drain to arrival, so the owner of this rule moved with it.
    // The queue is read on exactly one condition - that the record still holds something - and a
    // stop-shaped second condition is the reintroduced bug.
    const src = read('lib/triage-on-arrival.ts');
    expect(src).toContain('state.queued.length');
    expect(src).not.toMatch(/wasStopped|stoppedAt/);
  });

  it('nothing clears the queue because of a stop', () => {
    // `clearQueue` has one legitimate caller: the turn that has just turned those messages into
    // tasks. A stop-conditioned clear anywhere is the defect returning.
    for (const rel of ['lib/triage-on-arrival.ts', 'assistant-async-processor.ts', 'lib/async-processor-core.ts']) {
      expect(/wasStoppedSince[sS]{0,400}?clearQueue/.test(read(rel))).toBe(false);
    }
  });
});


/**
 * ONE PERSON'S ESCAPE HATCH MUST NOT REACH ANOTHER PERSON'S ANSWER.
 *
 * The first version keyed the stop marker on the conversation alone, so in a shared room Alice
 * typing `/stop` suppressed the answer Bob was still waiting for. She cancelled his work by using a
 * control meant for her own, and nothing told either of them.
 *
 * The task cancellation beside it already had this right - `cancelActiveTasksInChannel` takes the
 * requester and touches only their tasks. The two halves of one command disagreed about scope, and
 * the half that disagreed was the quiet one: a suppressed answer looks like a slow assistant.
 */
describe('a stop belongs to the person who sent it', () => {
  const stoppedFor = (sub: string, at: number) => mockSend.mockImplementation((cmd: any) => (
    cmd.input.Key.pk === `stop#${CHANNEL}#${sub}#${BOT}`
      ? Promise.resolve({ Item: { stoppedAt: at } })
      : Promise.resolve({})
  ));

  it('suppresses the stopper\'s own in-flight turn', async () => {
    stoppedFor('alice', T0 + 1000);
    expect(await lock.wasStoppedSince(CHANNEL, T0, 'alice', BOT)).toBe(true);
  });

  it('does NOT suppress a turn somebody else asked for', async () => {
    // The defect, pinned. Bob is waiting on his own answer in the same conversation; Alice stopping
    // hers must not take his with it.
    //
    // ASKED WITH THE SAME RESPONDER Alice's stop named, deliberately. Dropping it would make this
    // pass because the responder was missing rather than because the PERSON differed, which is the
    // vacuous version of this guard: it would keep passing if the person ever stopped being part of
    // the key.
    stoppedFor('alice', T0 + 1000);
    expect(await lock.wasStoppedSince(CHANNEL, T0, 'bob', BOT)).toBe(false);
  });

  it('does not suppress a turn nobody asked for', async () => {
    // A rebuttal or a repaired dispatch has no requester, so no person's stop can apply to it.
    // Inventing an owner is exactly how one member's control reaches another member's answer.
    stoppedFor('alice', T0 + 1000);
    expect(await lock.wasStoppedSince(CHANNEL, T0, '', BOT)).toBe(false);
  });

  it('records nothing when there is no person to attribute it to', async () => {
    mockSend.mockResolvedValue({});
    await lock.recordStop(CHANNEL, '', BOT);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
