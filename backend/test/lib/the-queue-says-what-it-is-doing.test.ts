/**
 * A QUEUE BEING WORKED LOOKS EXACTLY LIKE A QUEUE THAT IS STUCK (DESIGN 2.4.2).
 *
 * The same messages, marked waiting, for as long as it takes. The person who sent them cannot tell
 * the difference, and the difference is the whole of their experience of it: one is patience, the
 * other is a product that has stopped. Tasks already solved this by carrying a state that moves, and
 * a queue is the same problem.
 *
 * TWO PROPERTIES ARE WORTH PINNING. That the stages are ORDERED, because the updates race - the
 * private half and the clear are driven by different awaits in the same turn, and a late write of an
 * earlier stage shows somebody "reviewing" after they have already been asked to confirm something,
 * which reads as the turn having restarted. And that the public stage names NOTHING: the notice is
 * untargeted, so a stage that said whose private request was being handled would publish precisely
 * what the private message exists to keep private.
 */

import { ownWords } from '../helpers/own-templates';
import {
  queueStatusLabel,
  statesThatMayPrecede,
  QUEUE_DRAIN_MACHINE,
  QUEUE_STATUS_ORDER,
  type QueueStatus,
} from '../../lambda/src/lib/turn-queue-status';

describe('what a person reads while the queue is worked', () => {
  it('has a word for every stage of the drain', () => {
    // A stage with nothing to say would render blank, which reads as the assistant having stopped.
    for (const status of QUEUE_STATUS_ORDER) {
      expect(queueStatusLabel(status).trim().length).toBeGreaterThan(0);
    }
  });

  it('lets a deployment word a stage in its own voice', () => {
    const copy = ownWords({ queueStatus: { reviewing: 'Reading what came in' } });

    expect(queueStatusLabel('reviewing', copy as never)).toBe('Reading what came in');
  });

  it('falls back per stage rather than all or nothing', () => {
    // A deployment that words one stage has not thereby blanked the others.
    const copy = ownWords({ queueStatus: { reviewing: 'Reading what came in' } });

    expect(queueStatusLabel('clearing', copy as never)).toBe(queueStatusLabel('clearing'));
  });

  it('ignores a stage a deployment left empty', () => {
    // A blank line is no wording, and a version's retired `queueStatus` key is not read either way.
    const copy = { queueStatus: { clearing: '   ' } };

    expect(queueStatusLabel('clearing', copy as never)).toBe(queueStatusLabel('clearing'));
  });

  it('says only THAT private requests are being handled', () => {
    const label = queueStatusLabel('addressing_private');

    // The notice is untargeted, so this line is read by the whole room. It may say that something
    // private is being dealt with; it may not say whose, how many, or what about.
    expect(label.toLowerCase()).toContain('private');
    expect(label).not.toMatch(/\d/);
  });
});

/**
 * THE DRAIN IS DECLARED AS A STATE MACHINE, NOT AS AN ORDERING.
 *
 * An ordering says only "later than", and that is too weak to be an enforcement: it waves through a
 * drain that jumps from waiting straight to settled and calls it progress. Declared edges say which
 * moves actually exist, which is what the conditional write conditions on.
 *
 * It is declared with the same type, and validated by the same validator, as every task machine in
 * this codebase. Working a queue is a workflow with states and legal moves; a second vocabulary for
 * that would be a second thing to learn and a second validator to keep honest.
 */
describe('the drain is a declared machine', () => {
  it('starts where the queue starts, and ends when nothing is waiting', () => {
    expect(QUEUE_DRAIN_MACHINE.initial).toBe('waiting');
    expect(QUEUE_DRAIN_MACHINE.states.settled.terminal).toBe('success');
    expect(QUEUE_DRAIN_MACHINE.states.settled.transitions).toEqual([]);
  });

  it('refuses the moves an ordering would have allowed', () => {
    // An ordering permits any later stage from any earlier one. These are the pairs where that is
    // wrong, and where declared edges are the whole difference:
    //
    //   reviewing -> settled     a reading that never cleared the queue leaves the messages held
    //   waiting -> clarifying    nothing can be put to somebody about a queue nobody has read
    //   waiting -> clearing      clearing a queue that was never read discards it unanswered
    expect(QUEUE_DRAIN_MACHINE.states.reviewing.transitions).not.toContain('settled');
    expect(statesThatMayPrecede('clarifying')).not.toContain('waiting');
    expect(statesThatMayPrecede('clearing')).not.toContain('waiting');
  });

  it('lets a stopped queue settle without ever being read', () => {
    // The one jump that IS real: /stop ends the turn, the queue settles, and no reading happened.
    // Declaring it is what keeps it distinguishable from the jumps above rather than lumped with
    // them by a rule that only knows "later".
    expect(statesThatMayPrecede('settled').sort()).toEqual(['clearing', 'waiting']);
  });

  it('declares every route a reading can take, not just the two with a question in them', () => {
    // Not every drain has something to ask about, and not every drain that skips the question is
    // finished with people: a queue of purely private requests goes from the reading straight to
    // taking them up one to one. All three routes are declared rather than two being real and the
    // third being a special case somebody has to remember - which is what it was, and the omission
    // cost FR7 its stage (see the private-half describe below).
    expect(QUEUE_DRAIN_MACHINE.states.reviewing.transitions)
      .toEqual(['clarifying', 'addressing_private', 'clearing']);
  });

  it('waits on nobody, at any stage', () => {
    // `clarifying` is the proposal being put to somebody, and it used to declare that it awaited the
    // requester. It does not any more, and the reason is the queue rather than the drain: a drain
    // that waits is a QUEUE that lives until somebody answers, and every message still in it is
    // somebody else's wait too.
    //
    // The question is not dropped by not being held here. Each queued message that became work opens
    // a `queued_request` in `proposed`, which DOES await the requester - so the follow-up is owned,
    // in their list, and answered against the task it is about, while the queue clears on the
    // assistant's own timescale.
    const waiting = Object.entries(QUEUE_DRAIN_MACHINE.states)
      .filter(([, def]) => (def as { awaits?: unknown }).awaits)
      .map(([name]) => name);

    expect(waiting).toEqual([]);
  });

  it('names a predecessor for every stage except the first', () => {
    for (const status of QUEUE_STATUS_ORDER) {
      if (status === QUEUE_DRAIN_MACHINE.initial) continue;
      // A stage nothing leads to is a stage the conditional write can never accept, which would
      // strand the drain at whatever came before it.
      expect(statesThatMayPrecede(status).length).toBeGreaterThan(0);
    }
  });
});

describe('advancing the stage is a conditional write', () => {
  const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';

  it('advances when nothing has been shown yet, and refuses a stage already passed', async () => {
    jest.resetModules();
    process.env.TURN_STATE_TABLE = 'test-table';
    process.env.TURN_QUEUE_ENABLED = '1';

    const send = jest.fn();
    jest.doMock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
    jest.doMock('@aws-sdk/lib-dynamodb', () => ({
      DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => send(...a) }) },
      UpdateCommand: class { constructor(public input: any) {} },
      GetCommand: class { constructor(public input: any) {} },
    }));
    jest.doMock('../../lambda/src/lib/abuse-controls', () => ({}));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { advanceQueueStatus } = require('../../lambda/src/lib/turn-lock');

    send.mockResolvedValueOnce({});
    expect(await advanceQueueStatus({
      channelArn: CHANNEL, responderId: 'atlas', status: 'reviewing', cameFrom: ['waiting'],
    })).toBe(true);

    // The condition itself, which is the whole mechanism: absent means nothing has been shown, and
    // anything may follow it; otherwise the stored rank must be strictly lower.
    // THE CONDITION IS THE MACHINE: accepted only from a state that actually leads here.
    const cond = send.mock.calls[0][0].input.ConditionExpression;
    expect(cond).toContain('#qs IN (:f0)');
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues[':f0']).toBe('waiting');

    send.mockRejectedValueOnce(
      Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' }),
    );
    expect(await advanceQueueStatus({
      channelArn: CHANNEL, responderId: 'atlas', status: 'reviewing', cameFrom: ['waiting'],
    })).toBe(false);

    // A stage nothing leads to is refused WITHOUT a write: there is no condition that could pass,
    // and issuing the call anyway would spend a round trip to be told so.
    send.mockClear();
    expect(await advanceQueueStatus({
      channelArn: CHANNEL, responderId: 'atlas', status: 'reviewing', cameFrom: [],
    })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * THE FIRST STAGE HAS TO BE REACHABLE FROM A RECORD THAT SAYS NOTHING.
 *
 * A queue is `waiting` by EXISTING - nothing writes that value anywhere. So a record being worked for
 * the first time has no `queueStatus` attribute at all, and a condition that only accepts a recorded
 * predecessor can never pass. The first advance failed, and with it every later one, so the whole
 * feature was inert on the deployment while its unit test passed - because that test mocked the write
 * and asserted the assumption rather than the behavior.
 */
describe('an absent stage is the start, not an unknown', () => {
  it('lets the first real stage follow the initial one', () => {
    // `reviewing` follows `waiting`, and `waiting` is what an empty record means. If this stops being
    // true the drain silently stops reporting anything.
    expect(statesThatMayPrecede('reviewing')).toContain(QUEUE_DRAIN_MACHINE.initial);
  });

  it('accepts a write against a record with no stage recorded', async () => {
    jest.resetModules();
    process.env.TURN_STATE_TABLE = 'test-table';
    process.env.TURN_QUEUE_ENABLED = '1';

    const send = jest.fn().mockResolvedValue({});
    jest.doMock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
    jest.doMock('@aws-sdk/lib-dynamodb', () => ({
      DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => send(...a) }) },
      UpdateCommand: class { constructor(public input: any) {} },
      GetCommand: class { constructor(public input: any) {} },
    }));
    jest.doMock('../../lambda/src/lib/abuse-controls', () => ({}));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { advanceQueueStatus } = require('../../lambda/src/lib/turn-lock');

    expect(await advanceQueueStatus({
      channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1',
      responderId: 'atlas',
      status: 'reviewing',
      cameFrom: ['waiting'],
      absentCountsAsStart: true,
    })).toBe(true);

    // THE CLAUSE THAT WAS MISSING. Without it the condition is `#qs IN ('waiting')` against an item
    // that has no `#qs`, which never passes.
    expect(send.mock.calls[0][0].input.ConditionExpression).toContain('attribute_not_exists(#qs)');
  });
});

/**
 * A QUEUE OF PURELY PRIVATE REQUESTS STILL SHOWS THE STAGE IT IS IN (FR7, owner 2026-09-03).
 *
 * `addressing_private` is shown whenever the queue held targeted requests. It was reachable only from
 * `clarifying`, so a queue with private messages and nothing needing an answer went `reviewing` and
 * then straight to `clearing`: the conditional advance refused an edge the machine did not declare,
 * and the room watched the drain jump from reading to done while the private half was still being
 * written. The messages were always delivered - the STAGE was what went missing, which is the half of
 * FR7 that stayed open.
 */
describe('the private half is reachable however the reading went', () => {
  it('can be reached straight from reviewing, with nothing to clarify', () => {
    expect(statesThatMayPrecede('addressing_private')).toContain('reviewing');
  });

  it('and still from clarifying, because a queue can need both', () => {
    // Something was put to the person AND somebody's private request was taken up. Losing this edge
    // to fix the other one would trade one silence for another.
    expect(statesThatMayPrecede('addressing_private')).toContain('clarifying');
  });

  it('does not make the private half reachable from the end', () => {
    // `clearing` and `settled` come after it. An edge from either would let a drain claim it was
    // writing to people privately after it had already said the queue was done.
    expect(statesThatMayPrecede('addressing_private')).not.toContain('clearing');
    expect(statesThatMayPrecede('addressing_private')).not.toContain('settled');
  });
});
