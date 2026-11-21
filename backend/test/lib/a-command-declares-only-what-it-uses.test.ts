/**
 * A DECLARED EXPRESSION NAME THAT NO EXPRESSION USES IS A REJECTED WRITE.
 *
 * DynamoDB refuses an `ExpressionAttributeNames` entry (and an `ExpressionAttributeValues` entry)
 * that the command's expressions never reference: "Value provided in ExpressionAttributeNames unused
 * in expressions: keys: {#ttl}". It is not a warning and not a partial write - the call throws.
 *
 * ── WHY THIS IS A SOURCE SCAN AND NOT A UNIT TEST ────────────────────────────────────────────────
 *
 * Because a unit test could not see it. Every turn-lock test mocks `send`, and a mock accepts any
 * shape it is handed - so the suite stayed green while TWO writes threw on every deployment:
 *
 *  - `enqueueMessage` kept `#ttl`/`:ttl` after the TTL refresh was deliberately removed from its
 *    expression. Every enqueue threw, the caller reported the message as ANSWERED rather than queued,
 *    and the queue silently degraded into exactly the doubling it exists to prevent.
 *  - the notice claim kept them too. That claim is what stops a burst drawing several notices, so its
 *    failure returned the duplicate notices a comment three lines above says it was added to stop.
 *
 * Both were found by reading a deployment's logs (2026-08-28), not by the suite. This scan is the
 * cheap mechanical guard for the whole class: it reads the source the way DynamoDB reads the request.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Files whose DynamoDB commands this guard reads. Add a file when it starts building commands. */
const FILES = [
  'lambda/src/lib/turn-lock.ts',
];

const ROOT = path.resolve(__dirname, '..', '..');

interface Unused { file: string; command: number; kind: 'name' | 'value'; key: string }

/**
 * Every command literal in a file, with the expression text it references and the names/values it
 * declares. Deliberately literal-only: a command whose expression is built in a variable is skipped
 * rather than guessed at, because a guess here would produce a failure nobody can act on.
 */
function unusedDeclarations(file: string): Unused[] {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const found: Unused[] = [];
  const parts = src.split(/new (?:Update|Put|Get|Query|Delete)Command\(\{/).slice(1);

  /**
   * Every quoted fragment of an expression property, joined.
   *
   * A condition assembled with `'a' + ' OR b'` is one expression to DynamoDB and was two invisible
   * halves to an earlier version of this scan, which then reported the second half's placeholders as
   * unused. Reading to the end of the property and taking every fragment is what makes that agree.
   */
  const expressionText = (body: string, src: string): string => {
    const keys = /(?:Update|Condition|KeyCondition|Filter|Projection)Expression:\s*/g;
    let out = '';
    let m: RegExpExecArray | null;
    while ((m = keys.exec(body))) {
      const rest = body.slice(m.index + m[0].length);
      const end = rest.search(/,\s*\n\s*[A-Za-z]+:|,\s*\n\s*\}/);
      const value = end === -1 ? rest.slice(0, 200) : rest.slice(0, end);
      for (const q of value.matchAll(/'([^']*)'/g)) out += q[1] + ' ';

      // AND THE CLAUSES ASSEMBLED IN A VARIABLE. A condition built as `clauses.join(' OR ')` is one
      // expression to DynamoDB and was invisible here, so every placeholder only that condition used
      // was reported unused - a false alarm on exactly the pattern a conditional claim needs. The
      // declaration is read the same way a name map's is.
      for (const id of value.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*join\s*\(/g)) {
        const decl = src.match(new RegExp('const\\s+' + id[1] + '[^=]*=\\s*\\[([\\s\\S]*?)\\];'));
        if (decl) for (const q of decl[1].matchAll(/'([^']*)'/g)) out += q[1] + ' ';
        // Clauses pushed on later, conditionally, are part of the same expression.
        const pushes = src.matchAll(new RegExp(id[1] + '\\.push\\(\\s*\'([^\']*)\'', 'g'));
        for (const q of pushes) out += q[1] + ' ';
      }
    }
    return out;
  };

  /**
   * The name or value map, whether written inline or built in a variable just above.
   *
   * The variable form is not academic: it is where the third instance of this defect lived, declaring
   * an unused `#ttl` beside a used `#qs`, and it went unseen because an inline-only scan skipped it.
   */
  const mapBody = (body: string, src: string, key: string): string | null => {
    const inline = body.match(new RegExp(key + ':\\s*\\{([\\s\\S]*?)\\n?\\s*\\},'));
    if (inline) return inline[1];
    const named = body.match(new RegExp(key + ':\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*,'));
    if (!named) return null;
    const decl = src.match(new RegExp('const\\s+' + named[1] + '[^=]*=\\s*\\{([\\s\\S]*?)\\};'));
    return decl ? decl[1] : null;
  };

  parts.forEach((part, i) => {
    const body = part.split(/\n\s*\}\)\);/)[0] ?? '';
    const exprs = expressionText(body, src);
    if (!exprs) return;

    const names = mapBody(body, src, 'ExpressionAttributeNames');
    if (names) {
      for (const m of names.matchAll(/'(#[A-Za-z0-9_]+)'/g)) {
        if (!exprs.includes(m[1])) found.push({ file, command: i + 1, kind: 'name', key: m[1] });
      }
    }
    const values = mapBody(body, src, 'ExpressionAttributeValues');
    if (values) {
      for (const m of values.matchAll(/'(:[A-Za-z0-9_]+)'/g)) {
        if (!exprs.includes(m[1])) found.push({ file, command: i + 1, kind: 'value', key: m[1] });
      }
    }
  });
  return found;
}

describe('a DynamoDB command declares only what its expressions use', () => {
  it.each(FILES)('%s has no unused expression names or values', (file) => {
    const unused = unusedDeclarations(file);
    const described = unused.map((u) => `${u.file} command #${u.command}: unused ${u.kind} ${u.key}`);

    expect(described).toEqual([]);
  });

  it('detects an unused name, so a green result means the scan is looking', () => {
    // The guard is only worth having if it fails on the real defect. This is that defect, in the
    // exact shape it shipped in: a TTL name left behind after the expression stopped using it.
    const sample = `
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk },
        UpdateExpression: 'SET queued = list_append(if_not_exists(queued, :empty), :one)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':empty': [], ':one': [messageId] },
      }));
    `;
    const tmp = path.join(ROOT, 'lambda', 'src', 'lib', '__unused-decl-fixture.ts');
    fs.writeFileSync(tmp, sample);
    try {
      const found = unusedDeclarations('lambda/src/lib/__unused-decl-fixture.ts');
      expect(found).toContainEqual(
        expect.objectContaining({ kind: 'name', key: '#ttl' }),
      );
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

/**
 * EVERY CONDITIONAL WRITE THE CONVERSATION STORE MAKES, IN EVERY SHAPE IT TAKES (`channel-context-client.ts`).
 *
 * The source scan above reads literal commands; a writer that picks its condition by branch (a first claim, a claim over
 * a recorded conversation, a reuse) builds several requests from one call site, and the scan cannot tell which names each
 * one uses. So each writer is called here once per branch against a client that records the request, and each request is
 * held to DynamoDB's rule. The last check reads every condition the store's source spells and requires it among the
 * requests made here, so a conditional writer added without a shape here fails this test.
 */
describe('every conditional write of the conversation store declares only what it uses', () => {
  const ROOM = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/room-1';
  const OTHER = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/meet-1';
  type Update = { UpdateExpression: string; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> };
  const made: Update[] = [];

  /** Every name and value the write declares is used by its expressions, and every one they use is declared. */
  const unacceptable = (u: Update): string[] => {
    const text = `${u.UpdateExpression} ${u.ConditionExpression ?? ''}`;
    const out: string[] = [];
    for (const n of Object.keys(u.ExpressionAttributeNames ?? {})) if (!new RegExp(`${n}\\b`).test(text)) out.push(`unused name ${n}`);
    for (const v of Object.keys(u.ExpressionAttributeValues ?? {})) if (!new RegExp(`${v}\\b`).test(text)) out.push(`unused value ${v}`);
    for (const n of text.match(/#[A-Za-z0-9_]+/g) ?? []) if (!(n in (u.ExpressionAttributeNames ?? {}))) out.push(`undeclared name ${n}`);
    for (const v of text.match(/:[A-Za-z0-9_]+/g) ?? []) if (!(v in (u.ExpressionAttributeValues ?? {}))) out.push(`undeclared value ${v}`);
    return out;
  };

  beforeAll(async () => {
    jest.resetModules();
    process.env.CHANNEL_CONTEXT_TABLE = 'Conversations-ChannelContext';
    let failNext = 0;
    let item: Record<string, unknown> | undefined;
    jest.doMock('@aws-sdk/lib-dynamodb', () => ({
      DynamoDBDocumentClient: { from: () => ({
        send: async (cmd: { kind: string; input: Update }) => {
          if (cmd.kind === 'Update') {
            made.push(cmd.input);
            if (failNext > 0) { failNext -= 1; throw Object.assign(new Error('held'), { name: 'ConditionalCheckFailedException' }); }
            return {};
          }
          return { Item: item };
        },
      }) },
      UpdateCommand: jest.fn((input) => ({ kind: 'Update', input })),
      GetCommand: jest.fn((input) => ({ kind: 'Get', input })),
      PutCommand: jest.fn((input) => ({ kind: 'Put', input })),
      DeleteCommand: jest.fn((input) => ({ kind: 'Delete', input })),
      QueryCommand: jest.fn((input) => ({ kind: 'Query', input })),
      ScanCommand: jest.fn((input) => ({ kind: 'Scan', input })),
    }));
    jest.doMock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const s = require('../../lambda/src/lib/channel-context-client');
    const intake = { subject: 'p-1', phase: 'asking', cursor: 0 } as never;

    item = undefined;
    await s.recordMemberIdentity(ROOM, { sub: 's', iss: 'i' });
    item = { memberIdentities: [{ sub: 'x', iss: 'i' }] };
    await s.recordMemberIdentity(ROOM, { sub: 's', iss: 'i' });
    item = { children: [] };
    failNext = 1;
    await s.recordChildConversation(ROOM, { channelId: 'c', typeKey: 'thread', openedAt: 'x' });
    await s.advanceOnboardingIntake(ROOM, { cursor: 0, phase: 'asking', subject: 'p-1' }, intake);
    await s.startOnboardingIntake(ROOM, intake);
    await s.claimRoomNaming(ROOM);
    await s.releaseRoomNaming(ROOM, 1);
    await s.markRoomNamed(ROOM);
    item = { room: OTHER, classification: 'premium' };
    failNext = 1;
    await s.claimRefWatch('watch#ref#premium#ticket#7', { room: ROOM, classification: 'premium' }, async () => true);
    await s.claimOpening('opened#ops#0#e-1');
    await s.claimActiveMeeting(ROOM, { meetingId: 'm', meeting: {}, classification: 'premium', createdAt: 'x', createdBy: 'p' });
    await s.releaseActiveMeeting(ROOM, 'm');
    await s.releaseActiveMeeting(ROOM, 'm', '2026-11-12T10:30:00.000Z');
    await s.recordMeetingJoin(ROOM, 'm', '2026-11-12T10:00:00.000Z');
    await s.chargeTranscriptChars(OTHER, 'm', 'p-1', 120, 4000);
    await s.claimMeetingConversation(ROOM, undefined, 'tok');
    await s.claimMeetingConversation(ROOM, OTHER, 'tok');
    await s.claimMeetingConversation(ROOM, OTHER, 'tok', { reuse: true });
    await s.settleMeetingConversation(ROOM, 'tok', OTHER);
    await s.confirmMeetingConversation(ROOM, OTHER);
    await s.releaseMeetingConversation(ROOM, 'tok', OTHER);
    await s.releaseMeetingConversation(ROOM, 'tok');
    await s.recordMeetingOf(OTHER, ROOM);
    await s.recordEndedMeetingCard(OTHER, 'm', 'msg', 'arn:bot', ROOM);
    await s.recordMeetingInvites(OTHER, { 'p-1': { brief: 'b' } });
    await s.claimArrivalBrief(OTHER, 'p-1');
    await s.claimPatternCreation('premium', 'ticket', 25);
    item = { channelArn: ROOM, generation: 2, participantRoles: {} };
    await s.resetPatternRoomContext(ROOM, 2);
    item = undefined;
  });

  afterAll(() => {
    jest.dontMock('@aws-sdk/lib-dynamodb');
    jest.dontMock('@aws-sdk/client-dynamodb');
  });

  it('every request made declares exactly the names and values its expressions use', () => {
    expect(made.length).toBeGreaterThan(20);
    const bad = made.flatMap((u) => unacceptable(u).map((why) => `${u.ConditionExpression ?? u.UpdateExpression}: ${why}`));
    expect(bad).toEqual([]);
  });

  it('every condition the store spells is among the requests made here', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lambda/src/lib/channel-context-client.ts'), 'utf8');
    const spelled = new Set<string>();
    for (const line of src.split('\n')) {
      if (/\bConditionExpression:/.test(line) && !/KeyConditionExpression/.test(line)) for (const q of line.matchAll(/'([^']+)'/g)) spelled.add(q[1]);
      // A writer that takes its condition as an argument names it where it calls itself.
      for (const q of line.matchAll(/\bput\(\s*'([^']+)'/g)) spelled.add(q[1]);
    }
    const covered = new Set(made.map((u) => u.ConditionExpression).filter(Boolean));
    expect([...spelled].filter((c) => !covered.has(c))).toEqual([]);
    expect(spelled.size).toBeGreaterThan(15);
  });
});
