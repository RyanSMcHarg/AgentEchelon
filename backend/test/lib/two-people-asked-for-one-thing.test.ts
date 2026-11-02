/**
 * TWO PEOPLE ASKED FOR WHAT LOOKS LIKE ONE THING (maintainer, 2026-09-03).
 *
 * A queue is not one person's. When the reading groups messages from DIFFERENT senders under one
 * subject, that is the moment two requests might really be one - and merging them is not triage's
 * call to make. DESIGN 2.4.1 said exactly that from the start, and only half of it was built:
 *
 *   > it may read them together and PROPOSE it, and the person who sent the targeted one has to
 *   > confirm before they become one thing.
 *
 * The refusal was implemented. The proposing was not, so "separate" was the answer to a question
 * nobody asked, and there was no notion of an owner for an item two people had asked for.
 *
 * ── THE ORDER IS IN THE MACHINE, AND THE MIDDLE STATE IS WHY ────────────────────────────────────
 *
 * `asked -> merging -> merged` rather than `asked -> merged`. A machine whose terminal state is the
 * ANSWER records that somebody replied; a machine with a step for the WORK records that something
 * happened because they did. It is also what makes a failed merge visible - a task sitting in
 * `merging` - instead of a success with nothing behind it.
 */

const mockCreateTask = jest.fn();
const mockGetTask = jest.fn();

jest.mock('../../lambda/src/lib/task-store.js', () => ({
  createTask: (...a: unknown[]) => mockCreateTask(...a),
  getTask: (...a: unknown[]) => mockGetTask(...a),
  advanceTaskStateTo: jest.fn(),
  updateTaskStatus: jest.fn(),
}));
jest.mock('../../lambda/src/lib/turn-lock.js', () => ({ claimDrainTask: jest.fn() }));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: jest.fn() })),
  GetChannelMessageCommand: jest.fn(),
}), { virtual: true });

import {
  combinationCandidates, openCombinationQuestion, mergeCombinedRequests,
  QUEUED_COMBINATION_TASK_TYPE,
} from '../../lambda/src/lib/queue-drain-task';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';

const CHANNEL = 'arn:aws:chime:us-east-1:123456789012:app-instance/i/channel/c1';
const ANA = '11111111-0000-4000-8000-00000000aaaa';
const BEN = '22222222-0000-4000-8000-00000000bbbb';
const arn = (sub: string) => `arn:aws:chime:us-east-1:123456789012:app-instance/i/user/${sub}`;

const senders = { m1: arn(ANA), m2: arn(BEN), m3: arn(ANA) };
// The ARNs the senders actually arrive as, from the same helper the fixture uses. `createTask`
// derives the requester by splitting one on `/user/`, so a bare principal id there leaves the
// combination task awaiting nobody.
const ANA_ARN = arn(ANA);
const BEN_ARN = arn(BEN);

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateTask.mockResolvedValue({ taskId: 'merged-1' });
  mockGetTask.mockResolvedValue(null);
});

describe('which groupings are actually a question', () => {
  it('finds a subject that two different people asked about', () => {
    const found = combinationCandidates([{ label: 'the Q3 report', messageIds: ['m1', 'm2'] }], senders);

    expect(found).toEqual([{ label: 'the Q3 report', messageIds: ['m1', 'm2'], requestors: [ANA, BEN], requestorArns: [ANA_ARN, BEN_ARN] }]);
  });

  it('is NOT one person elaborating', () => {
    // Three messages from the same person about one subject is not a combination question - it is
    // somebody saying more, which the reading already handles by giving each its own item.
    expect(combinationCandidates([{ label: 'the Q3 report', messageIds: ['m1', 'm3'] }], senders)).toEqual([]);
  });

  it('is not two people on two different subjects', () => {
    // Separate subjects are separate work however many people are involved; that is what the SPLIT
    // offer is for, pointing the other way.
    expect(combinationCandidates(
      [{ label: 'the report', messageIds: ['m1'] }, { label: 'headcount', messageIds: ['m2'] }],
      senders,
    )).toEqual([]);
  });

  it('says nothing when the reading named no subjects, or nobody is known', () => {
    expect(combinationCandidates(undefined, senders)).toEqual([]);
    expect(combinationCandidates([{ label: 'x', messageIds: ['m1', 'm2'] }], undefined)).toEqual([]);
  });
});

describe('asking whether they are one thing', () => {
  const candidate = {
  label: 'the Q3 report',
  messageIds: ['m1', 'm2'],
  requestors: [ANA, BEN],
  requestorArns: [ANA_ARN, BEN_ARN],
};

  it('asks ONE person - the sender of the earliest message in the group', () => {
    // Asking everybody produces several answers to a question with one outcome. The earliest sender
    // is the one whose request the others arrived alongside.
    return openCombinationQuestion({
      event: { requestAttributes: { 'CHIME.channel.arn': CHANNEL } },
      channelArn: CHANNEL, responderId: 'bot', candidate, drainTaskId: 'drain-1',
    }).then(() => {
      // THE ARN, NOT THE PRINCIPAL ID. This asserted the bare id, which is what the code passed and
      // what the defect was: the field is named `CHIME.sender.arn` and `createTask` derives the
      // requester by splitting it on `/user/`, so an id left `requesterPersonId` empty. The combination
      // task was created owning nobody and was never handed back to the person it awaits.
      expect(mockCreateTask.mock.calls[0][0].requestAttributes['CHIME.sender.arn']).toBe(ANA_ARN);
      expect(mockCreateTask.mock.calls[0][2]).toBe(QUEUED_COMBINATION_TASK_TYPE);
    });
  });

  it('carries the ids and the people, and quotes nobody', async () => {
    // The question is whether to combine, never what the other message said - which is what keeps a
    // targeted request inside the group unreadable to the person being asked.
    await openCombinationQuestion({
      event: { requestAttributes: { 'CHIME.channel.arn': CHANNEL } },
      channelArn: CHANNEL, responderId: 'bot', candidate, drainTaskId: 'drain-1',
    });

    const details = mockCreateTask.mock.calls[0][4].details;
    expect(details.messageIds).toEqual(['m1', 'm2']);
    expect(details.requestors).toEqual([ANA, BEN]);
    expect(details.subject).toBe('the Q3 report');
  });

  it('asks once per subject however many passes read it', async () => {
    mockGetTask.mockResolvedValue({ taskId: 'drain-1-combine-m1' });

    await openCombinationQuestion({
      event: { requestAttributes: { 'CHIME.channel.arn': CHANNEL } },
      channelArn: CHANNEL, responderId: 'bot', candidate, drainTaskId: 'drain-1',
    });

    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('refuses to ask when only one person is involved', async () => {
    await openCombinationQuestion({
      event: { requestAttributes: { 'CHIME.channel.arn': CHANNEL } },
      channelArn: CHANNEL, responderId: 'bot',
      candidate: { label: 'x', messageIds: ['m1'], requestors: [ANA], requestorArns: [ANA_ARN] },
    });

    expect(mockCreateTask).not.toHaveBeenCalled();
  });
});

describe('acting on the answer', () => {
  const task = {
    taskId: 'combine-1', channelArn: CHANNEL, taskType: QUEUED_COMBINATION_TASK_TYPE,
    taskState: 'merging',
    details: {
      subject: 'the Q3 report',
      messageIds: ['m1', 'm2'],
      requestors: [ANA, BEN],
      // THE ARNs ARE PART OF THE RECORD, in the same order as the bare ids. `openCombinationQuestion`
      // writes them for exactly one reason: the merge opens a task, and `createTask` derives its
      // requester by splitting the sender on `/user/`.
      requestorArns: [ANA_ARN, BEN_ARN],
    },
  };

  it('opens ONE item covering the group', async () => {
    await mergeCombinedRequests({ task: task as never, channelArn: CHANNEL, responderId: 'bot' });

    expect(mockCreateTask).toHaveBeenCalledTimes(1);
    expect(mockCreateTask.mock.calls[0][4].details.mergedFrom).toEqual(['m1', 'm2']);
  });

  it('gives it to the person the answer named, not to whoever was asked', async () => {
    // Half of what is being asked is whose request this really is.
    await mergeCombinedRequests({ task: task as never, channelArn: CHANNEL, responderId: 'bot', ownerId: BEN });

    expect(mockCreateTask.mock.calls[0][0].requestAttributes['CHIME.sender.arn']).toBe(BEN_ARN);
  });

  it('refuses an owner who never asked for anything', async () => {
    // The candidates are the people who actually asked. Handing the work to a bystander is not a
    // decision this question is entitled to make, so it falls back to the person who was asked.
    await mergeCombinedRequests({ task: task as never, channelArn: CHANNEL, responderId: 'bot', ownerId: 'somebody-else' });

    expect(mockCreateTask.mock.calls[0][0].requestAttributes['CHIME.sender.arn']).toBe(ANA_ARN);
  });

  it('hands the merged item a sender an ARN split can actually read', async () => {
    // THE DEFECT THIS LOCKS OUT. The details carried bare principal ids and the ARNs were never
    // recorded, so the merge passed an id as `CHIME.sender.arn`. `createTask` splits its sender on
    // `/user/` to derive the requester, an id has no such segment, and the merged `queued_request`
    // was therefore opened awaiting nobody - work that can never be handed back to either of the two
    // people who asked for it. The assertion is on the SHAPE, not on a literal, because what the
    // split needs is the thing that was missing.
    await mergeCombinedRequests({ task: task as never, channelArn: CHANNEL, responderId: 'bot' });

    const sender = mockCreateTask.mock.calls[0][0].requestAttributes['CHIME.sender.arn'];
    expect(sender).toContain('/user/');
    expect(sender.split('/user/').pop()).toBe(ANA);
  });

  it('carries the subject rather than anybody\'s words', async () => {
    await mergeCombinedRequests({ task: task as never, channelArn: CHANNEL, responderId: 'bot' });

    expect(mockCreateTask.mock.calls[0][4].requestExcerpt).toBe('the Q3 report');
  });

  it('opens nothing when there is nothing to merge', async () => {
    const empty = { ...task, details: {} };

    expect(await mergeCombinedRequests({ task: empty as never, channelArn: CHANNEL, responderId: 'bot' })).toBe('');
    expect(mockCreateTask).not.toHaveBeenCalled();
  });

  it('reports failure rather than claiming a merge', async () => {
    // The caller advances to `merged` only on a real id, so a failed merge leaves the task in
    // `merging` where it is visible.
    mockCreateTask.mockRejectedValue(new Error('throttled'));

    expect(await mergeCombinedRequests({ task: task as never, channelArn: CHANNEL, responderId: 'bot' })).toBe('');
  });
});

describe('the machine carries the order', () => {
  const m = DEFAULT_TASK_STATE_MACHINES.queued_combination;

  it('asks the person first, and waits on them', () => {
    expect(m.initial).toBe('asked');
    expect(m.states.asked.awaits).toEqual({ party: 'requester' });
  });

  it('puts the WORK between the answer and the ending', () => {
    // The reason this is not `asked -> merged`. A terminal reached by the answer alone would record
    // that somebody replied, not that anything was done because they did.
    expect(m.states.asked.transitions).toEqual(['merging', 'separate']);
    expect(m.states.merging.transitions).toEqual(['merged']);
    expect(m.states.merging.terminal).toBeUndefined();
  });

  it('treats keeping them apart as a real ending, not a refusal', () => {
    expect(m.states.separate.terminal).toBe('success');
    expect(m.states.merged.terminal).toBe('success');
  });
});
