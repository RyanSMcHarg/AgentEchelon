/**
 * A REPLY NAMES THE WORK IT ANSWERS (ADR-035).
 *
 * Every open item carries a short reference, `#<n>`, that a person can type on any channel. A message
 * that starts with one fixes the item it answers, before any ranking and without the model choosing.
 *
 * Four properties, each a place this could quietly stop being true:
 *   - references are distinct and atomic, because triage creates several items for one conversation
 *     at once and a read-then-write counter would hand two of them the same number;
 *   - the parse reads a reference only at the start of a message, so ordinary numbering is not routing;
 *   - the router resolves a reference only against what the sender may answer, and answers one that
 *     names nothing;
 *   - the channel flow routes a bare `#<n>` in a group only when the task service says the sender may
 *     answer that item, so nobody starts a turn in a room by typing a number.
 */

const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn().mockImplementation((a) => ({ __t: 'Put', input: a })),
  GetCommand: jest.fn().mockImplementation((a) => ({ __t: 'Get', input: a })),
  UpdateCommand: jest.fn().mockImplementation((a) => ({ __t: 'Update', input: a })),
  QueryCommand: jest.fn().mockImplementation((a) => ({ __t: 'Query', input: a })),
  ScanCommand: jest.fn().mockImplementation((a) => ({ __t: 'Scan', input: a })),
  DeleteCommand: jest.fn().mockImplementation((a) => ({ __t: 'Delete', input: a })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../lambda/src', rel), 'utf8');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';

import { ownWords } from '../helpers/own-templates';
import {
  parseTaskReference, findReferencedTask, formatReferenceNotFound, taskRefHintLine,
} from '../../lambda/src/lib/task-reference';

describe('the reference a person types', () => {
  it('is read at the start of a message, after mentions, and after re', () => {
    expect(parseTaskReference('#2 EMEA only')).toEqual({ taskRef: 2, rest: 'EMEA only' });
    expect(parseTaskReference('re #2: EMEA only')).toEqual({ taskRef: 2, rest: 'EMEA only' });
    expect(parseTaskReference('@Atlas #12 - yes')).toEqual({ taskRef: 12, rest: 'yes' });
    expect(parseTaskReference('#7')).toEqual({ taskRef: 7, rest: '' });
  });

  it('is not read from the middle of a sentence or from a longer token', () => {
    expect(parseTaskReference('we ranked it #1 last quarter')).toBeNull();
    expect(parseTaskReference('#2nd place')).toBeNull();
    expect(parseTaskReference('#1234567 is an order number')).toBeNull();
    expect(parseTaskReference('#0 nothing')).toBeNull();
    expect(parseTaskReference('## Heading')).toBeNull();
    expect(parseTaskReference(undefined)).toBeNull();
  });

  it('names only a row the sender may answer: anything else finds nothing', () => {
    const rows = [{ taskId: 'a', taskRef: 1 }, { taskId: 'b', taskRef: 3 }];
    expect(findReferencedTask(rows, 3)?.taskId).toBe('b');
    expect(findReferencedTask(rows, 2)).toBeNull();
  });

  it('that names nothing is answered with the sender\'s own items, by reference', () => {
    const text = formatReferenceNotFound({}, 9, [
      { taskId: 'b', taskRef: 3, requestExcerpt: 'Q2 revenue by region' },
      { taskId: 'a', taskRef: 1, taskType: 'queued_clarification' },
      { taskId: 'c' },
    ]);
    expect(text).toContain('#9');
    // In reference order, and an item with no reference is not offered: it cannot be typed.
    expect(text.indexOf('#1 queued clarification')).toBeLessThan(text.indexOf('#3 Q2 revenue by region'));
    expect(text).not.toContain('{items}');
  });

  it('uses the assistant\'s own template when one is saved', () => {
    expect(formatReferenceNotFound({ copy: ownWords({ taskRefNotFound: 'No {ref}. Try:\n{items}' }) }, 4, [{ taskId: 'a', taskRef: 1 }]))
      .toBe('No 4. Try:\n#1 item');
    expect(formatReferenceNotFound({ copy: ownWords({ taskRefNothingOpen: 'Nothing for {ref}.' }) }, 4, [])).toBe('Nothing for 4.');
  });
});

describe('the line under a question about one of several items', () => {
  const base = { taskRef: 2, awaitsPerson: true, openItemCount: 2, response: 'Which region?' };

  it('says which reference to type when a bare reply could answer another item', () => {
    expect(taskRefHintLine(base)).toContain('#2');
  });

  it('is left out with one item, when nothing was asked, when there is no reference, or when already said', () => {
    expect(taskRefHintLine({ ...base, openItemCount: 1 })).toBe('');
    expect(taskRefHintLine({ ...base, awaitsPerson: false })).toBe('');
    expect(taskRefHintLine({ ...base, taskRef: undefined })).toBe('');
    expect(taskRefHintLine({ ...base, response: 'For #2, which region?' })).toBe('');
    // #20 is not #2.
    expect(taskRefHintLine({ ...base, response: 'Unlike #20, which region?' })).toContain('#2');
  });
});

describe('allocating references', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.TASKS_TABLE = 'tasks-test';
    process.env.USER_TASKS_TABLE = 'user-tasks-test';
  });

  /** A table whose counter row behaves like DynamoDB's atomic ADD. */
  function atomicCounterTable() {
    const counters = new Map<string, number>();
    const puts: Array<Record<string, unknown>> = [];
    mockSend.mockImplementation(async (cmd: { __t: string; input: Record<string, any> }) => {
      if (cmd.__t === 'Update' && cmd.input.UpdateExpression === 'ADD refCounter :one') {
        const key = `${cmd.input.Key.taskId}|${cmd.input.Key.channelArn}`;
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return { Attributes: { refCounter: next } };
      }
      if (cmd.__t === 'Put') puts.push(cmd.input.Item);
      return {};
    });
    return { puts };
  }

  it('gives N items created at once in one conversation N distinct references', async () => {
    const { puts } = atomicCounterTable();
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    const event = { requestAttributes: { 'CHIME.channel.arn': CHANNEL, 'CHIME.sender.arn': 'arn:x/user/u1' } };
    const created = await Promise.all(
      Array.from({ length: 6 }, () => createTask(event, 'text' as never, 'general')),
    );
    const refs = created.map((t) => t.taskRef);
    expect(new Set(refs).size).toBe(6);
    expect(refs.every((r) => Number.isInteger(r) && (r as number) > 0)).toBe(true);
    // The reference is on the task row itself.
    expect(puts.filter((p) => p.taskRef).length).toBeGreaterThanOrEqual(6);
  });

  it('uses one atomic ADD on a counter row, never a read followed by a write', async () => {
    atomicCounterTable();
    const { allocateTaskRef, TASK_REF_COUNTER_ID } = await import('../../lambda/src/lib/task-tracking');
    await allocateTaskRef(CHANNEL);
    const update = mockSend.mock.calls.map((c) => c[0]).find((c) => c.__t === 'Update');
    expect(update.input.Key).toEqual({ taskId: TASK_REF_COUNTER_ID, channelArn: CHANNEL });
    expect(update.input.UpdateExpression).toBe('ADD refCounter :one');
    expect(mockSend.mock.calls.map((c) => c[0].__t)).not.toContain('Get');
  });

  it('gives a queue drain row no reference: nobody answers it', async () => {
    atomicCounterTable();
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    const event = { requestAttributes: { 'CHIME.channel.arn': CHANNEL, 'CHIME.sender.arn': 'arn:x/user/u1' } };
    const drain = await createTask(event, 'text' as never, 'queue_drain');
    expect(drain.taskRef).toBeUndefined();
  });

  it('creates the item without a reference when the counter cannot be written', async () => {
    mockSend.mockImplementation(async (cmd: { __t: string; input: Record<string, any> }) => {
      if (cmd.__t === 'Update' && cmd.input.UpdateExpression === 'ADD refCounter :one') throw new Error('throttled');
      return {};
    });
    const { createTask } = await import('../../lambda/src/lib/task-tracking');
    const event = { requestAttributes: { 'CHIME.channel.arn': CHANNEL, 'CHIME.sender.arn': 'arn:x/user/u1' } };
    const task = await createTask(event, 'text' as never, 'general');
    expect(task.taskId).toBeTruthy();
    expect(task.taskRef).toBeUndefined();
  });
});

describe('the router resolves a reference before ranking', () => {
  const router = src('router-agent-handler.ts');
  const at = router.indexOf('const reference = !isAmendmentFold(event) ? parseTaskReference(userMessage) : null;');
  const block = router.slice(at, router.indexOf('let answered = referenced', at));

  it('the block exists, so the assertions below are not vacuous', () => {
    expect(at).toBeGreaterThan(-1);
    expect(block.length).toBeGreaterThan(1500);
  });

  it('resolves only against what the sender holds or owns here', () => {
    expect(block).toContain('...heldByPerson,');
    expect(block).toContain('...ownedHere.filter(');
    expect(block).toContain('findReferencedTask(answerable, reference.taskRef)');
  });

  it('answers a reference that names nothing, only to the sender, and stops', () => {
    const notFound = block.slice(block.indexOf('if (reference && !referenced && answerable.length'));
    // Worded from the assistant's `task-ref-not-found` template, with its version's legacy line and stored templates.
    expect(notFound).toContain('const { copy } = await turnWords();');
    expect(notFound).toContain('{ copy },');
    expect(notFound).toContain('Target: [{ MemberArn: senderArn }]');
    expect(notFound.indexOf('return formatLexSilentResponse(event);')).toBeGreaterThan(-1);
  });

  it('answers a private item from a public message rather than refusing it; delivery keeps it private', () => {
    // The details go only to the person, which the delivery planner enforces for
    // every turn on private work. See a-reply-goes-where-the-work-lives.test.ts.
    expect(block).not.toContain("referenced.visibility === 'private' && isFlowEntry(event)");
    expect(src('lib/async-processor-core.ts')).toContain('taskIsPrivate: !!params.taskContext?.task && isPrivateVisibility(params.taskContext.task.visibility),');
  });

  it('fixes the item: no candidates travel for the model to redirect to', () => {
    const fixed = block.slice(block.lastIndexOf('if (referenced) {'));
    expect(fixed).toContain('referentCandidates = [];');
    expect(fixed).toContain('referentCandidateIds = [];');
    expect(router).toContain('let answered = referenced');
  });

  it('a referenced item owned by another assistant still goes through the handover', () => {
    const after = router.slice(router.indexOf('let answered = referenced'));
    expect(after.indexOf('handOverToOwningAssistant({')).toBeGreaterThan(-1);
    expect(after.indexOf('handOverToOwningAssistant({'))
      .toBeLessThan(after.indexOf('applyUserResponseToTask({'));
  });

  it('records how the item was decided on the turn it dispatches', () => {
    expect(router).toContain('...(taskResolution ? { taskResolution } : {}),');
    expect(src('lib/async-processor-core.ts')).toContain('...(event.taskResolution && { taskResolution: event.taskResolution }),');
  });
});

describe('the channel flow routes a bare reference only when the sender may answer it', () => {
  const flow = src('channel-flow-processor.ts');
  const fn = flow.slice(flow.indexOf('async function resolveReferenceTarget('), flow.indexOf('async function invokeRouterTurn('));

  it('asks the task service of the conversation\'s own classification, with no fallback', () => {
    expect(fn).toContain("op: 'answerableTaskByRef'");
    // Found by name at call time (the classification's own task-service-arn parameter), never another's.
    expect(flow).toContain('resolveTaskServiceArn(');
  });

  it('resolves each declared classification to its own task service and nothing else to any', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { taskServiceArnForClassification, classificationEnvName } = require('../../lambda/src/lib/classification-env');
    const saved = { ...process.env };
    try {
      process.env[classificationEnvName('basic', 'TASK_SERVICE_ARN')] = 'arn:basic-tasks';
      process.env[classificationEnvName('premium', 'TASK_SERVICE_ARN')] = 'arn:premium-tasks';
      delete process.env[classificationEnvName('standard', 'TASK_SERVICE_ARN')];
      expect(taskServiceArnForClassification('basic')).toBe('arn:basic-tasks');
      expect(taskServiceArnForClassification('premium')).toBe('arn:premium-tasks');
      // A declared classification whose service is not wired has none; it never borrows a neighbor's.
      expect(taskServiceArnForClassification('standard')).toBeUndefined();
      // An undeclared value and the admin plane have none.
      expect(taskServiceArnForClassification('legal')).toBeUndefined();
      expect(taskServiceArnForClassification('')).toBeUndefined();
      expect(taskServiceArnForClassification('admin')).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });

  it('does nothing in a 1:1, on an unreadable roster, for an assistant\'s own message, or on a failed lookup', () => {
    expect(fn).toContain('if (size.unknown || size.isOneToOne) return null;');
    expect(fn).toContain('personIdFromArn(args.senderArn)');
    expect(fn).toMatch(/catch \(err\) \{[\s\S]*return null;/);
  });

  it('adopts the owning assistant only while that assistant is still in the room (source text)', () => {
    // WHY THIS MATTERS AND WHY IT IS NOT A SECURITY FIX. The owning identity here is SPLICED from a
    // task record, so unlike an `@<assistant>` it is bounded by task answerability rather than by
    // membership - and the bypass-identity gate admits the live occupant of any role in the
    // classification, so the splice can name an assistant since removed from the conversation.
    //
    // It is not an exposure: the router performs its `DescribeChannel` AS THE ADOPTED BEARER before
    // anything expensive, so an identity that should not act here reaches a refused read rather than a
    // tool. What this prevents is a turn adopting an identity destined to refuse, and two producers
    // answering "who is in this room" differently - the mention path resolves against `size.members`
    // and so must this one.
    //
    // SOURCE TEXT, deliberately: the producer is an inner function of the flow handler with no export,
    // which is the same reason the assertions above are source text. It catches the check being
    // deleted; it does not catch a wrong comparison.
    expect(fn).toContain('size.members.some((m) => m.arn === splicedBotArn)');
    expect(fn).toContain('const owningBotArn = ownerIsPresent ? splicedBotArn : botArn;');
  });

  it('claims the message like every dispatched turn, and never for a private or addressed one', () => {
    expect(flow).toContain('|| referenceTarget !== null;');
    const gate = flow.slice(flow.indexOf('const referenceTarget ='), flow.indexOf('const dispatchesATurn ='));
    expect(gate).toContain('!ownsTheTurn && !mentionsAll && !invokesBattle && !mentioned && !privateTo');
  });

  it('the service checks the sender may answer: the step awaits them, or they own the item', () => {
    const tracking = src('lib/task-tracking.ts');
    const check = tracking.slice(tracking.indexOf('function answerableBy('));
    expect(check).toContain('assignee?.id === senderSub || found.ownerPersonId === senderSub');
    const lookup = tracking.slice(tracking.indexOf('export async function findAnswerableTaskByRef('));
    expect(lookup).toContain("'taskRef = :ref AND #status IN (:pending, :inProgress)'");
    expect(src('task-service.ts')).toContain("case 'answerableTaskByRef':");
  });

  // NAMING AN ITEM BY ID MUST REACH NOTHING NAMING IT BY REFERENCE CANNOT. The id selector is the one
  // a client uses, so it is the one an untrusted caller can aim; it earns nothing by being precise.
  it('both selectors apply ONE permission, and accept the same statuses', () => {
    const tracking = src('lib/task-tracking.ts');
    const byId = tracking.slice(
      tracking.indexOf('export async function findAnswerableTaskById('),
      tracking.indexOf('export async function findAnswerableTaskByRef('),
    );
    const byRef = tracking.slice(tracking.indexOf('export async function findAnswerableTaskByRef('));
    // Neither decides for itself who may answer.
    expect(byId).toContain('answerableBy(found, senderSub)');
    expect(byRef).toContain('answerableBy(found, senderSub)');
    expect(byId).not.toContain('ownerPersonId === senderSub');
    // The id read is keyed by BOTH parts, so another conversation's id misses instead of matching.
    expect(byId).toContain('getTask(taskId, channelArn)');
    // The status set the reference query filters on is applied to an id lookup too - `abandoned` is
    // active and not terminal, so "not terminal" would admit work a `#<n>` cannot reach.
    const check = tracking.slice(tracking.indexOf('function answerableBy('));
    expect(check).toContain("found.status !== 'pending' && found.status !== 'in_progress'");
    expect(src('task-service.ts')).toContain("case 'answerableTaskById':");
  });

  // THE ROUTER DOES NOT TRUST THE FLOW'S CHECK. A declared id is intersected with the rows this
  // person holds or owns, so a stale or forged one narrows to nothing rather than widening.
  it('a declared task id is intersected with what the sender may answer', () => {
    const router = src('router-agent-handler.ts');
    expect(router).toContain('answerable.find((t) => t.taskId === declaredTaskId)');
    expect(router).toContain("taskResolution = declaredTaskId ? 'id' : 'reference';");
  });

  // The flow declares the id ONLY when the metadata named it; a typed `#<n>` is still in the text.
  it('the flow reads the id from Metadata and declares it only then', () => {
    // THE SAME READER THE LATE REPAIR USES. Two readers of one field are free to disagree about what
    // counts as named, and both decide whether a turn runs.
    expect(flow).toContain('const metadataTaskId = extractTaskAnswerHint(args.metadata)?.taskId;');
    expect(flow).toContain('const reference = metadataTaskId ? null : parseTaskReference(args.text);');
    expect(flow).toContain("referenceTarget.namedBy === 'metadata' && { answersTaskId: referenceTarget.taskId }");
  });

  // THE DEFECT MOVING THE REFERENCE OUT OF THE BODY WOULD OTHERWISE HAVE INTRODUCED.
  //
  // `decideRepair` stands down for a message whose TEXT starts with a `#<n>`, because the flow routes
  // those. A message that names its item in Metadata carries no reference in its text, so that content
  // check sees an unaddressed message - and the repair would dispatch a second turn for one the flow
  // already dispatched. The two components compete for the flow's own claim instead.
  it('the late repair stands down when the flow already dispatched the message', () => {
    const repair = src('lib/task-answer-repair.ts');
    expect(repair).toContain('claimCorrelation(flowDeliveryKey(messageId))');
    // Taken BEFORE the repair's own claim, so losing it does not burn `repair-<id>`.
    expect(repair.indexOf('flowDeliveryKey(messageId)'))
      .toBeLessThan(repair.indexOf('`repair-${messageId}`'));
    // One definition of the key, because two components now depend on it meaning the same thing.
    expect(src('lib/abuse-controls.ts')).toContain('export const flowDeliveryKey');
    expect(flow).not.toMatch(/^const flowDeliveryKey/m);
  });
});

describe('the service lookup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.TASKS_TABLE = 'tasks-test';
  });

  const row = { taskId: 't2', channelArn: CHANNEL, taskRef: 2, status: 'pending', userArn: 'arn:x/user/requester' };

  it('returns an item the step awaits the sender on, or they own', async () => {
    mockSend.mockResolvedValue({ Items: [{ ...row, ownerPersonId: 'owner-1', assistantId: 'bot-a', visibility: 'conversation' }] });
    const { findAnswerableTaskByRef } = await import('../../lambda/src/lib/task-tracking');
    expect(await findAnswerableTaskByRef(CHANNEL, 2, 'owner-1')).toEqual({ taskId: 't2', assistantId: 'bot-a' });
  });

  it('returns nothing for someone else, and does not say whose it is', async () => {
    mockSend.mockResolvedValue({ Items: [{ ...row, ownerPersonId: 'owner-1', assistantId: 'bot-a' }] });
    const { findAnswerableTaskByRef } = await import('../../lambda/src/lib/task-tracking');
    expect(await findAnswerableTaskByRef(CHANNEL, 2, 'someone-else')).toBeNull();
  });

  it('marks a private item so the router can refuse to answer it in public', async () => {
    mockSend.mockResolvedValue({ Items: [{ ...row, ownerPersonId: 'owner-1', visibility: 'private' }] });
    const { findAnswerableTaskByRef } = await import('../../lambda/src/lib/task-tracking');
    expect((await findAnswerableTaskByRef(CHANNEL, 2, 'owner-1'))?.private).toBe(true);
  });

  it('marks an item with no visibility private, and leaves a shared one unmarked', async () => {
    const { findAnswerableTaskByRef } = await import('../../lambda/src/lib/task-tracking');
    mockSend.mockResolvedValue({ Items: [{ ...row, ownerPersonId: 'owner-1' }] });
    expect((await findAnswerableTaskByRef(CHANNEL, 2, 'owner-1'))?.private).toBe(true);
    mockSend.mockResolvedValue({ Items: [{ ...row, ownerPersonId: 'owner-1', visibility: 'conversation' }] });
    expect(await findAnswerableTaskByRef(CHANNEL, 2, 'owner-1')).toEqual({ taskId: 't2' });
  });
});
