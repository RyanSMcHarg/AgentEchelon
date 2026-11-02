/**
 * A TARGETED REQUEST MAKES A PRIVATE TASK, AND A PRIVATE TASK IS VISIBLE IN THAT IT EXISTS
 * (ADR-033, amended by the owner 2026-08-23).
 *
 * Targeting means the other members of a conversation cannot read the message. The first version of
 * this rule hid the task's row outright, and built, that was worse: the assistant a private task
 * occupies looked idle to everyone else, and the requester's own `/stop` - which finds work through
 * this same read - was told there was nothing to stop while their task kept running.
 *
 * So the row is returned to every member with its describing fields STRIPPED AT READ TIME and
 * `private: true` in their place. Existence and occupancy are room-visible; what the work IS never
 * leaves the requester and the assistant that holds it.
 *
 * WHAT WAS ALREADY SAFE, so this does not re-test it beyond one guard: the conversation read is
 * built field by field precisely so it cannot carry message text. The EXCERPT never traveled.
 *
 * The direction of every failure below is unchanged: a mistake must UNDER-return DETAIL, never
 * over-disclose it.
 */

/*
 * And the filter must be USED. A control that every caller omits is a control that has never run: the
 * read fails toward silence, so forgetting the viewer is safe and invisible at the same time, and the
 * only symptom is a person never being reminded of work they opened privately. See the "the callers
 * pass a viewer" block at the end of this file.
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
const tasks = require('../../lambda/src/lib/task-tracking');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readTaskVisibility, isPrivateVisibility } = require('../../lambda/src/lib/task-visibility');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const ALICE = 'arn:aws:chime:us-east-1:1:app-instance/i/user/alice';
const ASSISTANT = 'assistant-premium';

const task = (over: Record<string, unknown> = {}) => ({
  taskId: 't1',
  channelArn: CHANNEL,
  userArn: ALICE,
  assistantId: ASSISTANT,
  status: 'in_progress',
  taskType: 'report_generation',
  createdAt: '2026-08-22T10:00:00.000Z',
  updatedAt: '2026-08-22T10:00:00.000Z',
  ...over,
});

const listFor = async (viewerId?: string) =>
  tasks.getOpenTasksForConversation(CHANNEL, viewerId ? { viewerId } : {});

beforeEach(() => mockSend.mockReset());

describe('a private task exists for the room, and describes itself to nobody else', () => {
  it('is returned to another member as existence only, flagged private', async () => {
    // Existence and occupancy are the room's to see - an occupied assistant must not look idle -
    // and everything that says WHAT the work is stays stripped.
    mockSend.mockResolvedValueOnce({ Items: [task({ visibility: 'private', taskState: 'drafting', dueBy: 'friday' })] });
    const [got] = await listFor('bob');
    expect(got).toMatchObject({ taskId: 't1', status: 'in_progress', private: true });
    expect(got).not.toHaveProperty('taskType');
    expect(got).not.toHaveProperty('taskState');
    expect(got).not.toHaveProperty('dueBy');
  });

  it('is returned IN FULL to the person who asked', async () => {
    mockSend.mockResolvedValueOnce({ Items: [task({ visibility: 'private' })] });
    // The requester is resolved from the task's own userArn, not from who owes the next step -
    // ownership changes hands at every awaits boundary and is a different question.
    const [got] = await listFor('alice');
    expect(got.taskType).toBe('report_generation');
    expect(got).not.toHaveProperty('private');
  });

  it('is returned IN FULL to the assistant whose work it is', async () => {
    mockSend.mockResolvedValueOnce({ Items: [task({ visibility: 'private' })] });
    expect((await listFor(ASSISTANT))[0].taskType).toBe('report_generation');
  });

  it('is redacted when the caller does not say who it is', async () => {
    // THE DANGEROUS DEFAULT, still pinned in the safe direction. A caller that forgets the viewer
    // under-returns DETAIL: the redacted form is the most a missing argument can ever produce, so
    // forgetting it cannot publish a private request's content - only the existence the room is
    // entitled to see anyway.
    mockSend.mockResolvedValueOnce({ Items: [task({ visibility: 'private' })] });
    const [got] = await listFor();
    expect(got.private).toBe(true);
    expect(got).not.toHaveProperty('taskType');
  });

  it('never flags a shared task as private', async () => {
    mockSend.mockResolvedValueOnce({ Items: [task({ visibility: 'conversation' })] });
    const [got] = await listFor('bob');
    expect(got).not.toHaveProperty('private');
    expect(got).not.toHaveProperty('privateItem');
    expect(got.taskType).toBe('report_generation');
  });
});

/**
 * ABSENT READS AS PRIVATE. A task can be written before its targeting is known,
 * and reading that absence as shared published a targeted request's existence and label to the room.
 * Private here means exactly the existence rule above: the room sees that it exists, the owner, the
 * requester and the assistant read it in full.
 */
describe('a task with no visibility reads as private', () => {
  it('the rule: only the literal `conversation` is shared', () => {
    expect(readTaskVisibility('conversation')).toBe('conversation');
    expect(readTaskVisibility('private')).toBe('private');
    for (const absent of [undefined, null, '', 'public', 'Conversation', 42]) {
      expect(readTaskVisibility(absent)).toBe('private');
      expect(isPrivateVisibility(absent)).toBe(true);
    }
    expect(isPrivateVisibility('conversation')).toBe(false);
  });

  it('is existence only to another member', async () => {
    mockSend.mockResolvedValueOnce({ Items: [task({ taskState: 'drafting', dueBy: 'friday' })] });
    const [got] = await listFor('bob');
    expect(got).toMatchObject({ taskId: 't1', status: 'in_progress', private: true, privateItem: true });
    expect(got).not.toHaveProperty('taskType');
    expect(got).not.toHaveProperty('taskState');
    expect(got).not.toHaveProperty('dueBy');
  });

  it('is existence only to a caller that does not say who it is', async () => {
    mockSend.mockResolvedValueOnce({ Items: [task()] });
    const [got] = await listFor();
    expect(got.private).toBe(true);
    expect(got).not.toHaveProperty('taskType');
  });

  it('is read in full by the requester and the assistant whose work it is, marked as a private item', async () => {
    mockSend.mockResolvedValueOnce({ Items: [task()] });
    const [mine] = await listFor('alice');
    expect(mine.taskType).toBe('report_generation');
    expect(mine).not.toHaveProperty('private');
    expect(mine.privateItem).toBe(true);
    mockSend.mockResolvedValueOnce({ Items: [task()] });
    expect((await listFor(ASSISTANT))[0].taskType).toBe('report_generation');
  });

  it('still returns an explicitly conversation-visible task to everyone in full', async () => {
    mockSend.mockResolvedValueOnce({ Items: [task({ visibility: 'conversation' })] });
    const got = await listFor('bob');
    expect(got).toHaveLength(1);
    expect(got[0].taskType).toBe('report_generation');
  });
});

/**
 * NO READER HAS ITS OWN RULE. A reader that compares a stored visibility to a literal can disagree with
 * every other reader about what absence means, which is how absent read as shared in one place and as
 * private in another. The one rule lives in `task-visibility.ts`.
 *
 * An enum VALIDATION (a line that compares against both values, refusing anything else) is not a
 * reading of absence and is allowed.
 */
describe('every reader goes through the one rule', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const ROOT = path.join(__dirname, '../../lambda/src');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return files(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [full] : [];
  });

  it('no source compares a visibility to a literal or defaults it', () => {
    const offenders: string[] = [];
    for (const file of files(ROOT)) {
      if (file.endsWith('task-visibility.ts')) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        const compares = /visibility\s*(===|!==|==|!=)\s*'(private|conversation)'/.test(line)
          || /'(private|conversation)'\s*(===|!==|==|!=)\s*[\w?.]*visibility/.test(line);
        const defaults = /visibility\s*\?\?/.test(line);
        const validates = /!==\s*'conversation'/.test(line) && /!==\s*'private'/.test(line);
        if ((compares || defaults) && !validates) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * EVERY WRITER THAT MEANS A TASK TO BE SHARED SAYS SO. With absent reading as private, a writer that
 * omits the field silently turns shared work private.
 */
describe('writers record the visibility they mean', () => {
  it('createTask stores the visibility it was given, and nothing when it was given none', async () => {
    const event = { requestAttributes: { 'CHIME.channel.arn': CHANNEL, 'CHIME.sender.arn': ALICE } };
    const puts = () => mockSend.mock.calls.map((c) => c[0]).filter((c: any) => c.__t === 'Put');
    mockSend.mockResolvedValue({});
    await tasks.createTask(event, 'direct', undefined, 'c1', { visibility: 'conversation' });
    expect(puts().at(-1).input.Item.visibility).toBe('conversation');
    mockSend.mockReset().mockResolvedValue({});
    await tasks.createTask(event, 'direct', undefined, 'c2', {});
    expect(puts().at(-1).input.Item).not.toHaveProperty('visibility');
  });

  const src = (rel: string) => require('fs').readFileSync(
    require('path').join(__dirname, '../../lambda/src', rel), 'utf8') as string;

  it('the router records `conversation` for an untargeted message and `private` for a targeted one', () => {
    const block = src('router-agent-handler.ts');
    const fields = block.slice(block.indexOf('const inboundTaskFields = async'));
    // SCOPED TO THE FUNCTION, NOT TO A CHARACTER COUNT. This read `slice(0, 600)`, which made the
    // guard fail when a correct change added lines above the mapping rather than when the mapping
    // itself changed - a guard that reports edits instead of regressions. The window is the function.
    const fn = fields.slice(0, fields.indexOf('\n    };'));
    expect(fn).toContain("visibility: targeted ? ('private' as const) : ('conversation' as const)");
    // Both creation branches take those fields.
    expect(block.match(/\.\.\.\(await inboundTaskFields\(\)\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('a caller that DECLARED the targeting is believed over the content lookup', () => {
    // WHY THIS EXISTS. The lookup matches the turn's text against the stored channel message. A flow
    // dispatch strips its address token before handing the turn over, so on that path the match can
    // never succeed - not rarely, structurally - and `targeted` came back `undefined`. An absent
    // visibility reads as private, so every task opened by an openly-asked `@all` was written private
    // and the room was told the assistant had replied privately.
    const block = src('router-agent-handler.ts');
    const fields = block.slice(block.indexOf('const inboundTaskFields = async'));
    const fn = fields.slice(0, fields.indexOf('\n    };'));
    expect(fn).toContain('const declared = declaredTargeted();');
    // THE PRECEDENCE, NOT THE STORAGE KEYWORD. This pinned `const targeted = ...` and failed when the
    // binding became `let` so a declared `false` could be VERIFIED against the stored message - a
    // correct change, because the flow declares `false` for "not addressed in the text" and cannot see
    // `Target` at all (ADR-029/ADR-034), which let a privately targeted request open a task the room
    // could see (measured live, 2026-09-28). That is the same "reports edits instead of regressions"
    // trap the comment above this block already records, one line down.
    expect(fn).toMatch(/(?:const|let) targeted = declared !== undefined \? declared : looked;/);
    // And the verification may only ever tighten: an upgrade to private is allowed, a downgrade to
    // shared is the disclosure ADR-033 forbids, so it must not appear.
    expect(fn).not.toContain('targeted = false;');
    // Only the two values the writer produces are honoured; anything else is "not declared", so a
    // malformed attribute leaves the task private rather than publishing one.
    expect(block).toContain("raw === '1' ? true : raw === '0' ? false : undefined");
    // And the flow actually declares it, or the read side above is dead code.
    //
    // IT USED TO DECLARE `!broadcast`, AND THAT WAS TOO WIDE. Measured in
    // `conv-1790010890868-807ae3b58087`: a plainly public "List all the tasks in this conversation
    // and their status" opened a PRIVATE task, and every answer to it was targeted - so a
    // two-person room got four "I have replied to you privately" receipts and the person asked why.
    // A mention is not a broadcast, so `!broadcast` made every mention private. The rule is now that
    // only a message SENT as targeted makes a private task.
    expect(src('channel-flow-processor.ts')).toContain('targeted: requestWasPrivate === true,');
  });

  it('the queue\'s own task writers record `conversation` explicitly', () => {
    const drain = src('lib/queue-drain-task.ts');
    expect(drain.match(/visibility: 'conversation'/g)?.length).toBeGreaterThanOrEqual(3);
    expect(drain).toContain("...(visibility ? { visibility } : { visibility: 'conversation' as const }),");
  });

  /**
   * THE RULE CHANGED: a public queue is not made private.
   *
   * This asserted that a triaged task "records the BATCH visibility, or private for its own targeted
   * message" - and the batch value was `private` whenever ANY queued message was targeted, so an
   * openly asked request became a private task because somebody else in the same burst asked
   * privately. The test was faithful to the code; the code was wrong.
   *
   * The batch value is kept and SCOPED to the reading, which names every queued request in one message
   * and so does need the most restrictive floor. A task carries one request, so it takes that
   * request's own answer.
   */
  it('a triaged task records ITS OWN message visibility, and the batch floor stays with the reading', () => {
    // The reading keeps the collapse, and its comment now says which of the two it governs.
    expect(src('lib/turn-triage.ts')).toContain("visibility: messages.some((m) => m.targeted) ? 'private' : 'conversation',");
    expect(src('lib/turn-triage.ts')).toContain('What the READING must be visible to');
    // A task takes its own message's answer. Whitespace-tolerant: the expression spans lines.
    const proposal = src('lib/turn-triage-proposal.ts');
    expect(proposal).toMatch(/targeted\.has\(item\.messageId\)\s*\n?\s*\?\s*'private'/);
    // AND THE BATCH VALUE SURVIVES ONLY FOR AN OLDER DISPATCHER. `targetedIds` absent means nothing
    // looked, so membership carries no information and reading it as "not targeted" would publish a
    // request its sender addressed privately - the fail-open direction the gate caught.
    expect(proposal).toContain("perItemVisibilityKnown ? 'conversation' : visibility");
    expect(proposal).toContain('args.targetedIds !== undefined');
  });
});

describe('a redacted row owns its place in the page', () => {
  it('a private task occupies a slot like any other, in its redacted form', async () => {
    // Under the old hide-outright rule this asserted the opposite. Now the room SEES the row, so it
    // legitimately takes a place: dropping it from the count would report an assistant less occupied
    // than it is, which is the idle-looking-assistant defect existence-visibility exists to fix.
    const rows = [
      task({ taskId: 'private-1', visibility: 'private' }),
      task({ taskId: 'visible-1', visibility: 'conversation' }),
      task({ taskId: 'visible-2', visibility: 'conversation' }),
    ];
    mockSend.mockResolvedValueOnce({ Items: rows });
    const got = await tasks.getOpenTasksForConversation(CHANNEL, { viewerId: 'bob', limit: 2 });
    expect(got.map((t: { taskId: string }) => t.taskId)).toEqual(['private-1', 'visible-1']);
    expect(got[0].private).toBe(true);
  });
});

describe('content still never travels', () => {
  it('returns no message text, private or not', async () => {
    // The pre-existing guarantee, re-asserted because this change touches the same read: the excerpt
    // is on the row and must not reach a caller, whatever the visibility says.
    mockSend.mockResolvedValueOnce({
      Items: [task({ messageExcerpt: 'the private thing Alice asked for', details: { secret: 1 } })],
    });
    const [got] = await listFor('alice');
    expect(JSON.stringify(got)).not.toContain('private thing');
    expect(got).not.toHaveProperty('messageExcerpt');
    expect(got).not.toHaveProperty('details');
  });
});

describe('the callers pass a viewer', () => {
  const SRC = 'lambda/src/assistant-async-processor.ts';

  it('the conversation hint asks as the SPEAKER', () => {
    // A source assertion, deliberately, and it is the only kind available: the alternative is booting
    // the whole processor to observe one argument. What it guards is a control that has never run -
    // the read fails toward silence, so an omitted viewer is safe AND invisible, and the only symptom
    // is a person never being reminded of work they opened by a targeted request. Under triage that
    // is every queued request from a targeted message, not an edge.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../', SRC), 'utf8');
    const call = /getOpenTasksForConversation\(\s*event\.channelArn\s*,([\s\S]{0,200}?)\)\s*;/.exec(src);
    expect(call).not.toBeNull();
    expect(call![1]).toContain('viewerId');
  });
});

describe('a conversation busier than one page still finds its open work', () => {
  /**
   * `Limit` COUNTS ROWS READ, NOT ROWS MATCHED - THE THIRD INSTANCE OF A DEFECT THIS FILE'S SUBJECT
   * ALREADY RECORDS TWICE.
   *
   * This read over-fetched a multiple of the caller's page size and filtered for open status
   * afterwards. The index is sorted newest-first, so a conversation with more recent finished rows
   * than the cap returned nothing - and `/stop` reads this through `selectStoppableTasks`, so a person
   * could stop work that was genuinely running and be told there was nothing in progress.
   *
   * The two sibling reads in the same module dropped their `Limit` and paginate. This one now does
   * too, stopping at the first of "enough matches" or "no more pages".
   */
  it('follows the pages until it has matches, rather than reading one and giving up', async () => {
    // Page one is entirely rows the filter drops - DynamoDB returns an empty Items with a continuation
    // key, which is exactly what a filtered page of finished work looks like.
    mockSend
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { pk: 'page-1-end' } })
      .mockResolvedValueOnce({ Items: [task({ taskId: 'still-running' })] });

    const got = await tasks.getOpenTasksForConversation(CHANNEL, { viewerId: 'bob' });

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(got.map((t: any) => t.taskId)).toEqual(['still-running']);
  });

  it('passes the continuation key back, so page two is not page one again', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { pk: 'page-1-end' } })
      .mockResolvedValueOnce({ Items: [task({ taskId: 't' })] });

    await tasks.getOpenTasksForConversation(CHANNEL, { viewerId: 'bob' });

    // Without this the loop would re-read the first page for ever, which is a worse failure than the
    // one being fixed.
    expect(mockSend.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ pk: 'page-1-end' });
  });

  it('stops as soon as it has the caller page, rather than draining the partition', async () => {
    // Non-vacuity: a loop with no stop condition would pass the assertions above and read every row in
    // a conversation on every turn.
    mockSend.mockResolvedValueOnce({
      Items: [task({ taskId: 'a' }), task({ taskId: 'b' })],
      LastEvaluatedKey: { pk: 'more' },
    });

    const got = await tasks.getOpenTasksForConversation(CHANNEL, { viewerId: 'bob', limit: 2 });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(got).toHaveLength(2);
  });
});
