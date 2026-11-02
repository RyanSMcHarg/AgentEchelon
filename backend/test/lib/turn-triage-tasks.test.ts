/**
 * A TRIAGED QUEUE BECOMES TASKS (ADR-033), and the tasks decide who sees them.
 *
 * Two rules are load-bearing here and neither is visible from the proposal a person reads.
 *
 * ONE TASK PER NEW REQUEST, NONE FOR AN AMENDMENT. An amendment changes work that already exists, so
 * giving it its own task splits one piece of work in two and leaves somebody closing a task that was
 * never separate. The exception is the case that looks identical and is not: an amendment with
 * NOTHING in flight to amend is new work, and dropping it because of its label would lose a message
 * the person sent.
 *
 * THE VISIBILITY IS THE QUEUE'S. It was decided when the messages were read, from their targeting,
 * and it travels to here because it cannot be recovered from a triage turn - whose prompt is
 * generated text and whose reply says nothing about who was addressed. Every failure below must
 * under-disclose: a task nobody sees costs a notification, a task everybody sees publishes a request
 * its sender kept off the room.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  QueryCommand: class { __t = 'Query'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
  PutCommand: class { __t = 'Put'; constructor(public input: any) {} },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  DeleteCommand: class { __t = 'Delete'; constructor(public input: any) {} },
  ScanCommand: class { __t = 'Scan'; constructor(public input: any) {} },
}));

process.env.TASKS_TABLE = 'tasks';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createTasksFromProposal, parseTriageTurnContext } = require('../../lambda/src/lib/turn-triage-proposal');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveTaskAssignee } = require('../../lambda/src/lib/task-tracking');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const ALICE = 'arn:aws:chime:us-east-1:1:app-instance/i/user/alice';
const ASSISTANT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/premium';

const AMEND = { messageId: 'm1', intent: 'amends', priority: 'high', label: 'make it one page' };
const NEW = { messageId: 'm2', intent: 'new', priority: 'normal', label: 'look up Q3 headcount' };

const run = (over: Record<string, unknown> = {}) => createTasksFromProposal({
  proposal: { items: [AMEND, NEW], inFlightAmbiguous: false },
  channelArn: CHANNEL,
  senderArn: ALICE,
  assistantId: ASSISTANT,
  visibility: 'conversation',
  hasWorkInFlight: true,
  correlationId: 'c-1',
  ...over,
});

/** The rows this call actually wrote. */
const puts = () => mockSend.mock.calls
  .map(([cmd]: any[]) => cmd)
  .filter((c: any) => c.__t === 'Put')
  .map((c: any) => c.input.Item);

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

describe('a targeted request is not merged with an untargeted one (DESIGN 2.4.1)', () => {
  // The rule: a queued targeted message and a queued untargeted message may not become one task,
  // or one action, unless the person who sent the targeted one confirms. Triage may READ them
  // together and propose it. It may not decide it.

  it('gives a targeted amendment its OWN task, instead of folding it into work in flight', () => run({
    proposal: { items: [{ ...AMEND, messageId: 'm1' }], inFlightAmbiguous: false },
    hasWorkInFlight: true,
    targetedIds: ['m1'],
  }).then(() => {
    // Without the rule this writes nothing: an amendment with work in flight is folded INTO that
    // work, which is how a private request becomes part of something the room can see.
    const rows = puts();
    expect(rows).toHaveLength(1);
    expect(rows[0].userMessageId).toBe('m1');
    expect(rows[0].visibility).toBe('private');
  }));

  it('still folds an UNtargeted amendment, so the rule costs nothing when nobody is private', () => run({
    proposal: { items: [{ ...AMEND, messageId: 'm1' }], inFlightAmbiguous: false },
    hasWorkInFlight: true,
    targetedIds: [],
  }).then(() => {
    // The existing behavior, untouched: splitting an ordinary amendment in two leaves somebody
    // closing a task that was never separate.
    expect(puts()).toHaveLength(0);
  }));

  it('gives each message ITS OWN visibility, not the batch\'s', () => run({
    proposal: { items: [NEW, { ...NEW, messageId: 'm3', label: 'a private thing' }], inFlightAmbiguous: false },
    hasWorkInFlight: false,
    // The batch floor is the quiet one, and on its own it would make BOTH of these private -
    // publishing nothing, but also telling the untargeted sender's request it was secret.
    visibility: 'conversation',
    targetedIds: ['m3'],
  }).then(() => {
    const rows = puts();
    expect(rows).toHaveLength(2);
    const byId = Object.fromEntries(rows.map((r) => [r.userMessageId, r.visibility]));
    expect(byId.m2).toBe('conversation');
    expect(byId.m3).toBe('private');
  }));

  it('treats an absent targetedIds as none known, leaving older payloads alone', () => run({
    proposal: { items: [{ ...AMEND, messageId: 'm1' }], inFlightAmbiguous: false },
    hasWorkInFlight: true,
  }).then(() => {
    // A dispatcher that predates the field records no targeting, and inventing some would split
    // work that was never private.
    expect(puts()).toHaveLength(0);
  }));
});

describe('what becomes a task', () => {
  it('creates one for a new request and NONE for an amendment', () => run().then(() => {
    const rows = puts();
    expect(rows).toHaveLength(1);
    expect(rows[0].userMessageId).toBe('m2');
    expect(rows[0].requestExcerpt).toBe('look up Q3 headcount');
  }));

  it('returns the items it created, so the caller can tell a skip from a failure', () => run()
    .then(({ created }: any) => {
      expect(created.map((i: any) => i.messageId)).toEqual(['m2']);
    }));

  it('DOES create one for an amendment with nothing in flight to amend', () => run({
    // The case that looks identical to the one above and is not. A message calling itself an
    // amendment when no work exists is new work; dropping it on its label loses what the person sent.
    hasWorkInFlight: false,
  }).then(() => {
    expect(puts().map((r: any) => r.userMessageId)).toEqual(['m1', 'm2']);
  }));

  it('writes nothing when the proposal is empty', () => run({
    proposal: { items: [], inFlightAmbiguous: false },
  }).then(() => {
    expect(puts()).toHaveLength(0);
  }));
});

describe('the task carries the decisions triage made', () => {
  it('records the queue\'s visibility, not a default', () => run({ visibility: 'private' })
    .then(() => {
      expect(puts()[0].visibility).toBe('private');
    }));

  it('records the priority triage assigned', () => run({
    proposal: { items: [{ ...NEW, priority: 'low' }], inFlightAmbiguous: false },
  }).then(() => {
    expect(puts()[0].priority).toBe('low');
  }));

  it('starts in a state that AWAITS THE PERSON, which is the pause', () => run().then(() => {
    // Nothing is executed by creating these. `proposed` awaits the requester, so the task sits in
    // their queue as something they must direct - the ADR's pause, expressed in the machine every
    // other awaiting task already uses rather than as a confirm step built beside it.
    const row = puts()[0];
    expect(row.taskType).toBe('queued_request');
    expect(row.taskState).toBe('proposed');
    // Read through the accessor the rest of the platform reads it through, so this asserts the
    // ownership rather than the field names it happens to be spelled with.
    expect(resolveTaskAssignee(row)).toEqual({ id: 'alice', type: 'user' });
  }));

  it('records the assistant the work belongs to, and the channel and requester', () => run()
    .then(() => {
      const row = puts()[0];
      // As a bare PRINCIPAL ID, which is what every other task row carries. An ARN here would be a
      // value nothing joins to: a triage task would be invisible to every "this assistant's work"
      // read, because those resolve their ARN-shaped fields down to exactly this.
      expect(row.assistantId).toBe('premium');
      expect(row.channelArn).toBe(CHANNEL);
      expect(row.userArn).toBe(ALICE);
      expect(row.correlationId).toBe('c-1');
    }));
});

describe('a failed write is REPORTED, and does not take the rest with it', () => {
  const items = [
    { ...NEW, messageId: 'a' }, { ...NEW, messageId: 'b' }, { ...NEW, messageId: 'c' },
  ];
  /** Fail the row for one message, whichever call it turns out to be. */
  const failWriteFor = (messageId: string) => mockSend.mockImplementation((cmd: any) => (
    cmd.input?.Item?.userMessageId === messageId
      ? Promise.reject(new Error('throttled'))
      : Promise.resolve({})
  ));

  it('returns what LANDED, not what was attempted', () => {
    // The default inside createTask swallows a failed write, which is right when the task accompanies
    // an answer and wrong here: the proposal describes work that exists nowhere else, so a swallowed
    // write would leave the person told their messages landed when nothing holds them.
    failWriteFor('b');
    return run({ proposal: { items, inFlightAmbiguous: false } }).then(({ created }: any) => {
      expect(created.map((i: any) => i.messageId)).toEqual(['a', 'c']);
    });
  });

  it('names what was LOST, so the caller can stop describing it as picked up', () => {
    failWriteFor('b');
    return run({ proposal: { items, inFlightAmbiguous: false } }).then(({ lost }: any) => {
      expect(lost.map((i: any) => i.messageId)).toEqual(['b']);
    });
  });

  it('still creates the ones it can', () => {
    // Three of four pieces of work existing beats none of it because one write failed.
    failWriteFor('a');
    return run({ proposal: { items, inFlightAmbiguous: false } }).then(() => {
      expect(puts()).toHaveLength(3); // three attempted; two of them landed
    });
  });
});

describe('reporting a failed write is OPT-IN', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createTask } = require('../../lambda/src/lib/task-tracking');
  const lexEvent = {
    inputTranscript: 'a thing',
    requestAttributes: { 'CHIME.channel.arn': CHANNEL, 'CHIME.sender.arn': ALICE },
  };

  it('leaves every caller that did not ask for it exactly as it was', async () => {
    // The fail-open default is right when a task ACCOMPANIES an answer already delivered: throwing
    // there would fail a turn that succeeded. Changing it under those callers is the regression this
    // guards, and it is not hypothetical - every task in the platform is created that way.
    mockSend.mockRejectedValue(new Error('throttled'));
    await expect(createTask(lexEvent, 'DIRECT', 'general')).resolves.toBeDefined();
  });

  it('throws only for the caller that declared a lost row unsurvivable', async () => {
    mockSend.mockRejectedValue(new Error('throttled'));
    await expect(createTask(lexEvent, 'DIRECT', 'general', undefined, { throwOnWriteFailure: true }))
      .rejects.toThrow('throttled');
  });
});

describe('the context a triage turn travels with', () => {
  const ctx = JSON.stringify({ ids: ['m1', 'm2'], visibility: 'private', inFlight: true });

  it('reads what was sent', () => {
    // `pass` defaults to the first when a payload does not carry one, which is what an older
    // dispatcher sends. See `triage-is-a-bounded-loop.test.ts` for the loop state itself.
    expect(parseTriageTurnContext(ctx)).toEqual({
      ids: ['m1', 'm2'], visibility: 'private', inFlight: true, pass: 1,
    });
  });

  it('refuses a context with NO visibility rather than defaulting one', () => {
    // A default here would be a disclosure decision nobody made, taken on the evidence that a value
    // failed to arrive. Undefined means the turn is not a triage turn, which is late, not disclosing.
    expect(parseTriageTurnContext(JSON.stringify({ ids: ['m1'], inFlight: true }))).toBeUndefined();
  });

  it('refuses a visibility outside the closed set', () => {
    expect(parseTriageTurnContext(JSON.stringify({ ids: ['m1'], visibility: 'public' }))).toBeUndefined();
  });

  it('refuses an absent, empty or malformed id list', () => {
    expect(parseTriageTurnContext(undefined)).toBeUndefined();
    expect(parseTriageTurnContext('not json')).toBeUndefined();
    expect(parseTriageTurnContext(JSON.stringify({ ids: [], visibility: 'private' }))).toBeUndefined();
    expect(parseTriageTurnContext(JSON.stringify({ ids: [1, 2], visibility: 'private' }))).toBeUndefined();
  });

  it('treats a missing in-flight flag as no work in flight', () => {
    // False means the proposal does not ask whether to keep going with something, and asking about
    // work that does not exist invites an answer about nothing.
    expect(parseTriageTurnContext(JSON.stringify({ ids: ['m1'], visibility: 'conversation' })))
      .toEqual({ ids: ['m1'], visibility: 'conversation', inFlight: false, pass: 1 });
  });
});
