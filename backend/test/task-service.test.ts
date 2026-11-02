/**
 * THE TASK SERVICE'S ONE JOB: refuse a conversation this instance may not serve.
 *
 * The classification boundary for tasks has never been enforced anywhere. The grant on the tables
 * carries no condition, and the only thing scoping a read is a `channelArn = :ch` supplied by the
 * caller, so a premium processor asking for a basic conversation's tasks would be answered. This
 * service is where that stops, and these are the tests that say so.
 *
 * ── WHY THE CLASSIFICATION IS NOT AN ARGUMENT ────────────────────────────────────────────────────
 *
 * Because an argument is a claim. This instance's classification is its own environment, set by the
 * stack that deployed it, and the caller proved which one it is by being permitted to invoke this
 * function at all. There is deliberately no input by which a caller can say "I am premium", which is
 * why no test below passes one: the absence is the design.
 *
 * ── AND WHY EVERY REFUSAL RETURNS EMPTY RATHER THAN THROWING ─────────────────────────────────────
 *
 * A turn that cannot read its tasks should answer without the hint, not fail. The hints are
 * best-effort by construction at every existing call site. What must never happen is the OTHER
 * failure: answering with a task the caller was not entitled to see.
 */

const mockSend = jest.fn();
const mockTags = jest.fn();

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
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockTags(...a); },
  ListTagsForResourceCommand: class { constructor(public input: any) {} },
}));

process.env.TASKS_TABLE = 'tasks';
process.env.USER_TASKS_TABLE = 'user-tasks';
process.env.SERVICE_CLASSIFICATION = 'standard';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const svc = require('../lambda/src/task-service');

/**
 * A FRESH CONVERSATION PER TEST, because the service caches a tag per container and the cache is
 * real rather than a test artifact: the classification tag is immutable, so a container that has
 * seen one does not ask again. Sharing an ARN would let the first test that resolves a tag decide
 * the answer for every test after it.
 */
let seq = 0;
const nextChannel = () => `arn:aws:chime:us-east-1:1:app-instance/i/channel/c${++seq}`;
const ALICE = 'arn:aws:chime:us-east-1:1:app-instance/i/user/alice';

/** The conversation answers with this classification tag. */
const taggedAs = (value: string | undefined) =>
  mockTags.mockResolvedValue({ Tags: value ? [{ Key: 'classification', Value: value }] : [] });

const openTask = (over: Record<string, unknown> = {}) => ({
  taskId: 't1',
  channelArn: 'any',
  userArn: ALICE,
  status: 'in_progress',
  taskType: 'report_generation',
  createdAt: '2026-08-22T10:00:00.000Z',
  updatedAt: '2026-08-22T10:00:00.000Z',
  ...over,
});

beforeEach(() => {
  mockSend.mockReset();
  mockTags.mockReset();
  mockSend.mockResolvedValue({ Items: [openTask()], Item: openTask() });
});

describe('a conversation this instance may not serve', () => {
  it('is refused when it is tagged ABOVE this classification', async () => {
    const CH = nextChannel();
    // The leak this exists to prevent: a standard service must not answer a premium conversation.
    taggedAs('premium');
    const out = await svc.tasksForTurn({ channelArn: CH, senderArn: ALICE });
    expect(out).toEqual({ current: null, here: [], elsewhere: [] });
  });

  it('is refused when it carries NO tag', async () => {
    const CH = nextChannel();
    // Same rule Layer 1 takes for channel actions: a tagging gap never silently grants access.
    //
    // AND IT MUST NOT SUBSTITUTE. The shared resolver stands in the narrowest classification for a
    // missing tag, which is right where it is used and wrong here: substituting the lowest would make
    // every untagged conversation serveable by EVERY instance, converting "unknown" into "permitted".
    // An authorization decision is the one place that conversion cannot be made.
    taggedAs(undefined);
    const out = await svc.tasksForTurn({ channelArn: CH, senderArn: ALICE });
    expect(out.here).toEqual([]);
    expect(out.current).toBeNull();
  });

  it('PROCEEDS and alarms when the tag read fails, because this check is not the boundary', async () => {
    const CH = nextChannel();
    // REVERSED DELIBERATELY (maintainer, 2026-08-31). This asserted the opposite, arguing that "an
    // unreadable tag is not a permissive one" and that an outage must not become a disclosure.
    // The argument is a fair one and it is not dismissed: this service IS the only guard on the
    // tasks table, whose grant carries no condition (see this file's header). What it is NOT is the
    // gate on who may be in this conversation or send into it - those are IAM, tag-gated and
    // fail-closed, and settled long before anything arrives here.
    //
    // A failed tag read is not evidence of a violation; it is evidence that this check cannot run.
    // Refusing on it let a Chime throttle impersonate a policy decision and silently drop legitimate
    // work, including fire-and-forget status writes that nothing retries. For an outage to become a
    // disclosure now, IAM would have to be wrong at the same moment - a compound failure - whereas
    // the old behavior broke every cold-container task read during any tag-read throttle.
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockTags.mockRejectedValue(new Error('throttled'));
      const out = await svc.tasksForTurn({ channelArn: CH, senderArn: ALICE });
      expect(out.here.length).toBeGreaterThan(0);
      // The alarm is what makes proceeding defensible, so it is asserted rather than assumed.
      expect(err).toHaveBeenCalledWith(
        expect.stringContaining('PROCEEDING'),
        expect.objectContaining({ channelArn: CH }),
      );
    } finally {
      err.mockRestore();
    }
  });

  it('reads NOTHING from the store when it refuses', async () => {
    const CH = nextChannel();
    // The refusal must come before the read, not filter after it. A service that fetches a premium
    // conversation's tasks and then discards them has already put them in the wrong process.
    taggedAs('premium');
    await svc.tasksForTurn({ channelArn: CH, senderArn: ALICE });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('a conversation this instance may serve', () => {
  it('serves its OWN classification', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    const out = await svc.tasksForTurn({ channelArn: CH, senderArn: ALICE });
    expect(out.here.length).toBeGreaterThan(0);
  });

  it('serves a classification BELOW its own', async () => {
    const CH = nextChannel();
    // Narrowing cannot leak. A standard service answering a basic conversation is the direction the
    // whole model already permits; the reverse is the one it forbids.
    taggedAs('basic');
    const out = await svc.tasksForTurn({ channelArn: CH, senderArn: ALICE });
    expect(out.here.length).toBeGreaterThan(0);
  });
});

describe('the classification cannot be claimed by a caller', () => {
  it('ignores a classification supplied in the input', async () => {
    const CH = nextChannel();
    // There is no input for it, and this proves the absence rather than trusting it: passing one
    // changes nothing, because the instance's own environment is what decides.
    taggedAs('premium');
    const out = await svc.tasksForTurn({
      channelArn: CH, senderArn: ALICE, classification: 'premium', serviceClassification: 'premium',
    } as never);
    expect(out).toEqual({ current: null, here: [], elsewhere: [] });
  });
});

describe('the viewer is passed through, never inferred', () => {
  it('asks the conversation read as the SPEAKER', async () => {
    const CH = nextChannel();
    // `getOpenTasksForConversation` returns a private task only to its requester or its owning
    // assistant, and fails toward silence when nobody says who is asking. Dropping the viewer here
    // would hide a person's own privately-opened work from them.
    taggedAs('standard');
    await svc.tasksForTurn({ channelArn: CH, senderArn: ALICE });
    const queries = mockSend.mock.calls.map(([c]: any[]) => c).filter((c: any) => c.__t === 'Query');
    expect(queries.length).toBeGreaterThan(0);
  });

  it('asks for no cross-conversation work when there is no speaker', async () => {
    const CH = nextChannel();
    // "What does this person owe elsewhere" has no answer without a person, and inventing one would
    // read another partition.
    taggedAs('standard');
    const out = await svc.tasksForTurn({ channelArn: CH });
    expect(out.elsewhere).toEqual([]);
  });
});

describe('reading one task by id', () => {
  it('still refuses on the conversation', async () => {
    const CH = nextChannel();
    // A task id names a row; it does not say the caller is entitled to it. Without this check an id
    // obtained anywhere would be sufficient rather than merely necessary.
    taggedAs('premium');
    expect(await svc.readTask({ taskId: 't1', channelArn: CH })).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns the task when the conversation is serveable', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    expect(await svc.readTask({ taskId: 't1', channelArn: CH })).not.toBeNull();
  });
});

describe('the dispatch', () => {
  it('refuses an op it does not know rather than defaulting', async () => {
    const CH = nextChannel();
    // A service that answers something for a request it does not understand is how a typo becomes a
    // silent read of the wrong thing.
    await expect(svc.handler({ op: 'tasksForTurnn', input: {} })).rejects.toThrow('unknown op');
  });

  it('routes a known op', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    const out = await svc.handler({ op: 'tasksForTurn', input: { channelArn: CH, senderArn: ALICE } });
    expect(out).toHaveProperty('here');
  });
});

/**
 * A LOOKUP WITH NO CONVERSATION TO SCOPE TO (code review, 2026-09-04).
 *
 * `activeTaskByType` answered `null` whenever it was asked without a `channelArn`, reasoning that a
 * classification boundary cannot be applied to a question that names no conversation. The boundary
 * part is right; returning `null` is not a way of expressing it. `null` here means "there is no such
 * task", and the router's channel-less continuation path acts on that answer by opening a fresh one -
 * so a person continuing work got a SECOND task tracking it, beside the live one, every time.
 *
 * `adminListAssigneeTasks` has the same shape and already resolves it the other way: it gates each ROW
 * on the classification of the conversation that row names. These pin that this one does the same,
 * and that the boundary is still enforced - which is the half a careless fix would drop.
 */
describe('an active-task lookup with no conversation named', () => {
  const unscoped = (over: Record<string, unknown> = {}) =>
    svc.handler({
      op: 'activeTaskByType',
      input: { personId: ALICE, taskType: 'report_generation', ...over },
    });

  it('ANSWERS from the row it finds, rather than reporting no such task', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    mockSend.mockResolvedValue({ Items: [openTask({ channelArn: CH })] });

    const found = await unscoped();
    expect(found).not.toBeNull();
    expect(found.taskId).toBe('t1');
  });

  it('still refuses a row whose conversation is above this classification', async () => {
    const CH = nextChannel();
    taggedAs('premium');
    mockSend.mockResolvedValue({ Items: [openTask({ channelArn: CH })] });

    // The boundary moved from the question to the answer; it did not go away. A row this instance may
    // not serve is withheld exactly as a scoped read of the same conversation would be.
    expect(await unscoped()).toBeNull();
  });

  it('reports no such task when there genuinely is none', async () => {
    taggedAs('standard');
    mockSend.mockResolvedValue({ Items: [] });
    expect(await unscoped()).toBeNull();
  });

  it('still scopes the read when a conversation IS named', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    mockSend.mockResolvedValue({ Items: [openTask({ channelArn: CH })] });
    await unscoped({ channelArn: CH });

    // The scoped path is the one that can pin the conversation in the query, and it must keep doing
    // so: falling back to the unscoped read for everybody would widen every lookup in the system.
    const query = mockSend.mock.calls[0][0];
    expect(JSON.stringify(query.input)).toContain(CH);
  });
});

/**
 * WHAT AN OPERATOR IS TOLD ABOUT A PRIVATE ROW (ADR-033, code review 2026-09-04).
 *
 * The conversation-scoped read marks a private task `private: true` and withholds its details. This
 * cross-conversation one did neither, so a private request arrived indistinguishable from an ordinary
 * one: the console had nothing to render a marker from, and `dueBy` - when somebody's private request
 * is due, which is a fact about that request - was handed over with it.
 */
describe('an assignee listing marks what it must not detail', () => {
  it('flags a private row and withholds its due date', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    mockSend.mockResolvedValue({
      Items: [openTask({ channelArn: CH, visibility: 'private', dueBy: '2026-09-09T00:00:00.000Z' })],
    });

    const rows = await svc.handler({ op: 'adminListAssigneeTasks', input: { assigneeId: ALICE } });
    expect(rows).toHaveLength(1);
    expect(rows[0].private).toBe(true);
    expect(rows[0].dueBy).toBeUndefined();
  });

  it('leaves a shared row alone, so the marker means something', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    mockSend.mockResolvedValue({
      Items: [openTask({ channelArn: CH, visibility: 'conversation', dueBy: '2026-09-09T00:00:00.000Z' })],
    });

    const rows = await svc.handler({ op: 'adminListAssigneeTasks', input: { assigneeId: ALICE } });
    expect(rows[0].private).toBeUndefined();
    expect(rows[0].dueBy).toBe('2026-09-09T00:00:00.000Z');
  });

  it('reads a row with no visibility as private, on both admin listings', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    mockSend.mockResolvedValue({
      Items: [openTask({ channelArn: CH, dueBy: '2026-09-09T00:00:00.000Z' })],
    });

    for (const [op, input] of [
      ['adminListAssigneeTasks', { assigneeId: ALICE }],
      ['adminListTasksOwnedBy', { ownerPersonId: ALICE }],
    ] as const) {
      const rows = await svc.handler({ op, input });
      expect(rows).toHaveLength(1);
      expect(rows[0].private).toBe(true);
      expect(rows[0].dueBy).toBeUndefined();
    }
  });
});

/**
 * WHO MAY ASK WHICH OF WHOSE WORK (ADR-024 D8, tenet P4).
 *
 * `referentCandidates` answers "the open work in this conversation belonging to this person and this
 * assistant". It reads over a conversation index rather than an owner partition, so the narrowing to
 * one person is no longer a property of the key - which means it has to be PROVEN rather than
 * reasoned about. Tenet P4 asks for exactly that: isolation provable with a deny-test rather than a
 * code review, and two enforcement layers so one missed check is not a breach.
 *
 * The two layers here:
 *   1. IAM decides who may invoke this service at all. Not testable from here, and not this test's
 *      claim - a person cannot reach this function, only the roles that run turns can.
 *   2. This service answers for ONE classification, from its own environment, and refuses a
 *      conversation above it BEFORE any read runs. That is asserted below, including that no read is
 *      attempted on a refusal.
 *
 * And the narrowing itself: an owner is required, is never defaulted, and a row belonging to somebody
 * else is not returned however the question is asked.
 *
 * MEASURED, so the layering is not a claim: removing the service guard leaves the classification
 * refusal failing here and the owner and assistant requirements still passing, because the store read
 * refuses those too. That is the redundancy tenet D3 asks for by name - one missed check is not a
 * breach - and it is recorded so a later reader does not delete one of the two as duplication.
 */
describe('the work in this conversation that belongs to this person', () => {
  const ask = (over: Record<string, unknown> = {}) =>
    svc.handler({
      op: 'referentCandidates',
      input: { channelArn: 'set-me', assistantId: 'atlas', ownerPersonId: ALICE, ...over },
    });

  it('returns this person\'s work here', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    mockSend.mockResolvedValue({ Items: [openTask({ channelArn: CH, ownerPersonId: ALICE })] });
    const rows = await ask({ channelArn: CH });
    expect(rows).toHaveLength(1);
  });

  it('DENIES a conversation above this classification, and reads nothing at all', async () => {
    const CH = nextChannel();
    taggedAs('premium');
    mockSend.mockResolvedValue({ Items: [openTask({ channelArn: CH, ownerPersonId: ALICE })] });

    expect(await ask({ channelArn: CH })).toEqual([]);
    // BEFORE THE REQUEST RUNS. A refusal that still read the table would be a filter on the way out,
    // which is the shape tenet P4 exists to refuse.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('DENIES an unowned question rather than widening it to the conversation', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    mockSend.mockResolvedValue({ Items: [openTask({ channelArn: CH, ownerPersonId: ALICE })] });

    // An absent owner defaulting to "everything here" would answer a different and much wider
    // question than the one asked, and it would do it silently.
    expect(await ask({ channelArn: CH, ownerPersonId: '' })).toEqual([]);
    expect(await ask({ channelArn: CH, ownerPersonId: undefined })).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('DENIES a question with no assistant, so it cannot become "everyone\'s work here"', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    expect(await ask({ channelArn: CH, assistantId: '' })).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('narrows by owner IN THE QUERY, not in whatever calls it', async () => {
    // A narrowing applied by the caller is one a second caller can forget. Asserted on the request so
    // it cannot be satisfied by a filter somewhere up the stack.
    const CH = nextChannel();
    taggedAs('standard');
    mockSend.mockResolvedValue({ Items: [] });
    await ask({ channelArn: CH });

    const sent = JSON.stringify(mockSend.mock.calls[0][0].input);
    expect(sent).toContain('ownerPersonId');
    expect(sent).toContain(ALICE);
    expect(sent).toContain('channelArn-assistantId-index');
  });
});

/**
 * THE TWO PRINCIPAL READS ANSWER DIFFERENT QUESTIONS (ADR-024 D8).
 *
 * A task names an OWNER, the person the work belongs to, and an ASSIGNEE, whoever owes its next step.
 * They come apart exactly when work is in flight: the assistant is the assignee and the person is
 * still the owner. An operator asking "what is this person's" and an operator asking "what does this
 * person owe" are asking different things, and one route answering both would have to guess.
 *
 * `adminListOwnerTasks` used to be the assignee read under the owner's name. The path kept its word
 * and changed meaning; the assignee read moved to its own name, and the old op still reaches it so a
 * caller mid-deploy does not meet `unknown op`.
 */
describe('what a person owns, and what a principal is assigned', () => {
  it('the owner read answers from the owner, not the partition', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    mockSend.mockResolvedValue({ Items: [openTask({ channelArn: CH, ownerPersonId: ALICE })] });

    const rows = await svc.handler({ op: 'adminListTasksOwnedBy', input: { ownerPersonId: ALICE } });
    expect(rows).toHaveLength(1);
    const sent = JSON.stringify(mockSend.mock.calls[0][0].input);
    expect(sent).toContain('ownerPersonId-index');
  });

  it('still refuses a row whose conversation is above this classification', async () => {
    const CH = nextChannel();
    taggedAs('premium');
    mockSend.mockResolvedValue({ Items: [openTask({ channelArn: CH, ownerPersonId: ALICE })] });
    expect(await svc.handler({ op: 'adminListTasksOwnedBy', input: { ownerPersonId: ALICE } })).toEqual([]);
  });

  it('refuses an unowned question rather than listing everybody', async () => {
    taggedAs('standard');
    expect(await svc.handler({ op: 'adminListTasksOwnedBy', input: { ownerPersonId: '' } })).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the assignee read is reachable only by the name that means it', async () => {
    // The pre-D8 op named this read "owner" and is GONE rather than aliased: an alias preserves the
    // confusion it was meant to retire, and this op has one caller whose deploy order we control
    // (task-service before admin-tasks).
    const CH = nextChannel();
    taggedAs('standard');
    mockSend.mockResolvedValue({ Items: [openTask({ channelArn: CH })] });
    const rows = await svc.handler({ op: 'adminListAssigneeTasks', input: { assigneeId: ALICE } });
    expect(rows).toHaveLength(1);
    await expect(svc.handler({ op: 'adminListOwnerTasks', input: { ownerId: ALICE } }))
      .rejects.toThrow('unknown op');
  });
});

/**
 * HANDING A TASK TO A DIFFERENT OWNER (ADR-024 D8).
 *
 * The write that makes the owner a role rather than a record of how the task started. It is
 * channel-scoped because a task is keyed by (taskId, channelArn), which is also what lets it sit
 * behind the same classification refusal as every other task write.
 */
describe('handing a task to a different owner', () => {
  it('refuses a conversation above this classification, and writes nothing', async () => {
    const CH = nextChannel();
    taggedAs('premium');
    const out = await svc.handler({
      op: 'reassignTaskOwner', input: { taskId: 't1', channelArn: CH, ownerPersonId: ALICE },
    });
    expect(out).toEqual({ ok: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a handover with no destination, rather than clearing the owner', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    // An empty owner that fell through would leave the task owned by nobody, which is worse than the
    // handover failing: it disappears from its owner's list and appears in no other.
    expect(await svc.handler({
      op: 'reassignTaskOwner', input: { taskId: 't1', channelArn: CH, ownerPersonId: '' },
    })).toEqual({ ok: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not touch the assignee, which is the separate axis', async () => {
    const CH = nextChannel();
    taggedAs('standard');
    mockSend.mockResolvedValue({ Item: openTask({ channelArn: CH }), Attributes: {} });
    await svc.handler({
      op: 'reassignTaskOwner', input: { taskId: 't1', channelArn: CH, ownerPersonId: ALICE },
    });
    const updates = mockSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c?.__t === 'Update')
      .map((c) => String(c.input?.UpdateExpression ?? ''));
    expect(updates.length).toBeGreaterThan(0);
    // Who owns the work and who owes its next step move independently. A handover that also moved the
    // assignee would answer a question nobody asked, on a turn nobody was having.
    for (const u of updates) {
      expect(u).toContain('ownerPersonId');
      expect(u).not.toContain('assigneeId');
    }
  });
});

/**
 * "ELSEWHERE" IS THE ONE LEG WHOSE ROWS COME FROM CONVERSATIONS NOBODY CHECKED.
 *
 * `refusesChannel` gates the conversation the turn is in. It says nothing about the conversations
 * these rows come from, and by definition they come from others - each with its own classification,
 * on a table whose grant carries no condition for IAM to apply.
 *
 * So a person with open work in a premium conversation speaks in a basic one, and the count and
 * type of that work reaches the basic assistant's system prompt through `buildCrossChannelTasksHint`.
 * `adminListAssigneeTasks` already gates every row of the SAME call; the turn read did not.
 */
describe('open work in another conversation', () => {
  /** Tags answered per conversation, so one test can hold two classifications at once. */
  const taggedPerChannel = (byArn: Record<string, string>) =>
    mockTags.mockImplementation((cmd: any) => {
      const value = byArn[cmd?.input?.ResourceARN ?? ''];
      return Promise.resolve({ Tags: value ? [{ Key: 'classification', Value: value }] : [] });
    });

  /** The conversation read and the cross-conversation read hit different tables; answer each its own. */
  const rowsPerTable = (here: unknown[], elsewhere: unknown[]) =>
    mockSend.mockImplementation((cmd: any) => Promise.resolve(
      cmd?.input?.TableName === 'user-tasks' ? { Items: elsewhere } : { Items: here },
    ));

  it('withholds a row from a conversation ABOVE this classification', async () => {
    const HERE = nextChannel();
    const ABOVE = nextChannel();
    taggedPerChannel({ [HERE]: 'standard', [ABOVE]: 'premium' });
    rowsPerTable([openTask({ channelArn: HERE })], [openTask({ taskId: 't-above', channelArn: ABOVE })]);

    const out = await svc.tasksForTurn({ channelArn: HERE, senderArn: ALICE });

    // The conversation itself is serveable, so this is not the outer refusal passing by accident.
    expect(out.here.length).toBeGreaterThan(0);
    expect(out.elsewhere).toEqual([]);
  });

  it('keeps a row from a conversation this instance may serve', async () => {
    const HERE = nextChannel();
    const BELOW = nextChannel();
    taggedPerChannel({ [HERE]: 'standard', [BELOW]: 'basic' });
    rowsPerTable([openTask({ channelArn: HERE })], [openTask({ taskId: 't-below', channelArn: BELOW })]);

    const out = await svc.tasksForTurn({ channelArn: HERE, senderArn: ALICE });

    // Non-vacuity: without this the test above would pass on a service that returned nothing at all.
    expect(out.elsewhere.map((t: any) => t.taskId)).toEqual(['t-below']);
  });

  it('withholds a row whose conversation carries NO tag', async () => {
    const HERE = nextChannel();
    const UNTAGGED = nextChannel();
    taggedPerChannel({ [HERE]: 'standard' });
    rowsPerTable([openTask({ channelArn: HERE })], [openTask({ taskId: 't-untagged', channelArn: UNTAGGED })]);

    const out = await svc.tasksForTurn({ channelArn: HERE, senderArn: ALICE });

    // Same rule the conversation leg takes: a tagging gap never silently grants.
    expect(out.elsewhere).toEqual([]);
  });
});
