/**
 * A ROOM WHOSE FIRST MESSAGE ANOTHER ASSISTANT ANSWERED IS NAMED BY ITS OWN ASSISTANT, ONCE (`room-naming.ts`).
 *
 * Only the room's primary moderates it, so only the primary may rename it (tenet D1): a duel's alt or a member
 * assistant addressed by name is never granted `UpdateChannel`. When a person's message in a room still carrying the
 * placeholder goes to one of those, the router asks the primary to name the room from that message, on the primary's
 * own routed session, and a claim on the room's row keeps it to one title derivation per room.
 *
 * What it proves:
 *  - who names the room: the primary, and never the assistant answering a turn it does not moderate;
 *  - one derivation in flight per room: only a message that can name the room claims it, only the caller that wins the
 *    claim dispatches, a run that could not start gives its claim back, and a lapsed claim is retried;
 *  - a room known to be named reads nothing, and one the row records as named reads no Amazon Chime SDK;
 *  - the ask starts beside the answering dispatch and never fails the turn;
 *  - the answering assistant spends no derivation on a rename it would be refused, on `@all` as on any turn;
 *  - a name a person gave, or a name given at creation, is never overwritten.
 */
const mockChimeSend = jest.fn();
const mockBedrockSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: (...a: unknown[]) => mockChimeSend(...a) })),
  DescribeChannelCommand: class { __t = 'Describe'; constructor(public input: any) {} },
  UpdateChannelCommand: class { __t = 'Update'; constructor(public input: any) {} },
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: (...a: unknown[]) => mockBedrockSend(...a) })),
  InvokeModelCommand: class { __t = 'Invoke'; constructor(public input: any) {} },
}));

import * as fs from 'fs';
import * as path from 'path';
import { askRoomPrimaryToName, namingDecisionFor, roomNamedByItsPrimary, roomNamingDispatch, type RoomNamingMemory } from '../../lambda/src/lib/room-naming';
import type { RoomNamingClaim } from '../../lambda/src/lib/channel-context-client';
import { PLACEHOLDER_TITLE } from '../../lambda/src/lib/conversation-name';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { maybeDeriveAndRenameChannel } = require('../../lambda/src/lib/channel-title');

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
const ROOM = `${APP}/channel/conv-1`;
const PRIMARY = `${APP}/bot/advisor`;
const ALT = `${APP}/bot/alt-primary-premium`;
const MEMBER = `${APP}/bot/ops-premium`;
const primaryOf = async () => ({ botArn: PRIMARY, classification: 'premium' });
const turn = (answeringBotArn: string, over: Record<string, unknown> = {}) => ({ channelArn: ROOM, answeringBotArn, classification: 'premium', ...over });

describe('who names the room', () => {
  it('the primary, when an alt or a member assistant answers a message in a room still carrying the placeholder', async () => {
    expect(await roomNamedByItsPrimary(turn(ALT), primaryOf)).toBe(PRIMARY);
    expect(await roomNamedByItsPrimary(turn(MEMBER, { knownName: PLACEHOLDER_TITLE }), primaryOf)).toBe(PRIMARY);
  });

  it('nobody else, when the primary answers: its own turn names the room as before', async () => {
    expect(await roomNamedByItsPrimary(turn(PRIMARY), primaryOf)).toBeNull();
  });

  it('nobody, when the room already has a name a person or its creation gave it', async () => {
    const reads = jest.fn(primaryOf);
    expect(await roomNamedByItsPrimary(turn(ALT, { knownName: 'Checkout latency' }), reads)).toBeNull();
    expect(reads).not.toHaveBeenCalled();
  });

  it('nobody extra in a duel\'s first round whose other side is the primary: that side names it from the prompt', async () => {
    expect(await roomNamedByItsPrimary(turn(ALT, { battle: { round: 1, rivalBotArn: PRIMARY } }), primaryOf)).toBeNull();
    expect(await roomNamedByItsPrimary(turn(ALT, { battle: { round: 2, rivalBotArn: PRIMARY } }), primaryOf)).toBe(PRIMARY);
  });

  it('nobody, when the primary cannot be read or is another classification\'s', async () => {
    expect(await roomNamedByItsPrimary(turn(ALT), async () => { throw new Error('denied'); })).toBeNull();
    expect(await roomNamedByItsPrimary(turn(ALT), async () => ({ botArn: PRIMARY, classification: 'standard' }))).toBeNull();
  });
});

const LEASE = 15 * 60 * 1000;

/** A room's row as the store keeps it: one claim at a time, which lapses after the lease, and a record that it is named. */
function roomRow() {
  const row: { claimedAt?: number; named?: boolean } = {};
  const claim = jest.fn(async (_arn: string, now: number): Promise<RoomNamingClaim> => {
    if (row.named) return { claimed: false, named: true };
    if (row.claimedAt !== undefined && row.claimedAt >= now - LEASE) return { claimed: false, named: false, heldUntil: row.claimedAt + LEASE };
    const lapsed = row.claimedAt !== undefined;
    row.claimedAt = now;
    return { claimed: true, at: now, lapsed };
  });
  const release = jest.fn(async (_arn: string, at: number) => { if (row.claimedAt === at) delete row.claimedAt; });
  const markNamed = jest.fn(async () => { row.named = true; delete row.claimedAt; });
  return { row, claim, release, markNamed };
}

describe('one derivation in flight per room, as the primary', () => {
  const ASK = { channelArn: ROOM, primaryBotArn: PRIMARY, userMessage: '@Advisor (alt) compare the Q3 plans', classification: 'premium' };

  function asker(over: Record<string, unknown> = {}) {
    const store = roomRow();
    let clock = 1_000_000;
    const deps = {
      claim: store.claim, release: store.release, markNamed: store.markNamed,
      currentName: jest.fn(async (): Promise<string | undefined> => PLACEHOLDER_TITLE),
      dispatch: jest.fn(async () => true),
      leaseMs: LEASE, now: () => clock,
      ...over,
    };
    return { store, deps, tick: (ms: number) => { clock += ms; } };
  }

  it('only the caller that wins the claim dispatches, and the run names the room as the primary and answers nothing', async () => {
    const { deps } = asker();
    expect(await askRoomPrimaryToName(ASK, deps)).toBe('asked');
    expect(await askRoomPrimaryToName(ASK, deps)).toBe('held');
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.dispatch.mock.calls[0]).toEqual([expect.objectContaining({
      channelArn: ROOM, botArn: PRIMARY, nameRoom: true, classification: 'premium',
      userMessage: '@Advisor (alt) compare the Q3 plans', correlationId: 'name-conv-1',
    })]);
  });

  it('a message that names nothing claims nothing: an empty message or a slash command other than /battle and /md', async () => {
    const { deps } = asker();
    for (const userMessage of ['/help', '/clear', '  ', '/battle', '/md']) {
      expect(await askRoomPrimaryToName({ ...ASK, userMessage }, deps)).toBe('not-a-seed');
    }
    expect(deps.claim).not.toHaveBeenCalled();
    expect(await askRoomPrimaryToName({ ...ASK, userMessage: '/battle compare the Q3 plans' }, deps)).toBe('asked');
  });

  it('a run that could not be started gives its claim back, so the next message asks again', async () => {
    const { store, deps } = asker({ dispatch: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) });
    expect(await askRoomPrimaryToName(ASK, deps)).toBe('not-dispatched');
    expect(store.row.claimedAt).toBeUndefined();
    expect(await askRoomPrimaryToName(ASK, deps)).toBe('asked');
  });

  it('a dispatch that throws gives its claim back too, and a claim that throws asks nothing', async () => {
    const { store, deps } = asker({ dispatch: jest.fn(async () => { throw new Error('throttled'); }) });
    expect(await askRoomPrimaryToName(ASK, deps)).toBe('not-dispatched');
    expect(store.release).toHaveBeenCalledTimes(1);
    expect(await askRoomPrimaryToName(ASK, { ...deps, claim: async () => { throw new Error('throttled'); } })).toBe('failed');
  });

  it('a run that named nothing lets its claim lapse, and a later message retries it', async () => {
    const { deps, tick } = asker();
    expect(await askRoomPrimaryToName(ASK, deps)).toBe('asked');
    tick(LEASE + 1);
    expect(await askRoomPrimaryToName(ASK, deps)).toBe('asked');
    expect(deps.currentName).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledTimes(2);
  });

  it('a lapsed claim whose run did name the room records it as named and dispatches nothing more', async () => {
    const { store, deps, tick } = asker();
    expect(await askRoomPrimaryToName(ASK, deps)).toBe('asked');
    tick(LEASE + 1);
    deps.currentName.mockResolvedValueOnce('Q3 Plan Comparison');
    expect(await askRoomPrimaryToName(ASK, deps)).toBe('named');
    expect(store.row.named).toBe(true);
    expect(await askRoomPrimaryToName(ASK, deps)).toBe('named');
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
  });

  it('the run is the same id for the room whichever message asked, so its routing names the primary alone', () => {
    const a = roomNamingDispatch({ channelArn: ROOM, primaryBotArn: PRIMARY, userMessage: 'one', classification: 'premium', now: 1 });
    const b = roomNamingDispatch({ channelArn: ROOM, primaryBotArn: PRIMARY, userMessage: 'two', classification: 'premium', now: 2 });
    expect(a.correlationId).toBe(b.correlationId);
  });

  it('the claim is written on the room\'s own row, refused once the room is named, and taken over only after its lease', () => {
    const store = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'lib', 'channel-context-client.ts'), 'utf8');
    expect(store).toMatch(/ConditionExpression: 'attribute_exists\(#arn\) AND attribute_not_exists\(#named\) AND \(attribute_not_exists\(#naming\) OR #naming < :lapsed\)'/);
    expect(store).toMatch(/export const ROOM_NAMING_LEASE_MS = 15 \* 60 \* 1000;/);
  });
});

describe('a room known to be named reads nothing', () => {
  const TURN = turn(ALT, { knownName: PLACEHOLDER_TITLE });
  const deps = () => ({
    primaryOf: jest.fn(primaryOf),
    isNamed: jest.fn(async () => false),
    markNamed: jest.fn(async () => undefined),
    now: () => 5_000,
  });

  it('a room this container knows is named reads no store and no channel', async () => {
    const memory: RoomNamingMemory = new Map([[ROOM, { named: true }]]);
    const d = deps();
    expect(await namingDecisionFor(TURN, memory, d)).toEqual({ namer: null, ask: false });
    expect(d.primaryOf).not.toHaveBeenCalled();
    expect(d.isNamed).not.toHaveBeenCalled();
  });

  it('a room whose naming is in hand tells its assistant not to name it, and asks again only after the lease', async () => {
    const memory: RoomNamingMemory = new Map([[ROOM, { primary: PRIMARY, until: 6_000 }]]);
    const d = deps();
    expect(await namingDecisionFor(TURN, memory, d)).toEqual({ namer: PRIMARY, ask: false });
    expect(d.primaryOf).not.toHaveBeenCalled();
    expect(await namingDecisionFor(TURN, memory, { ...d, now: () => 7_000 })).toEqual({ namer: PRIMARY, ask: true });
  });

  it('a name the router\'s own read saw is recorded on the row, so no container asks again', async () => {
    const memory: RoomNamingMemory = new Map();
    const d = deps();
    expect(await namingDecisionFor(turn(ALT, { knownName: 'Q3 Plan Comparison' }), memory, d)).toEqual({ namer: null, ask: false });
    expect(d.markNamed).toHaveBeenCalledWith(ROOM);
    expect(memory.get(ROOM)).toEqual({ named: true });
  });

  it('a room the row records as named reads no Amazon Chime SDK', async () => {
    const memory: RoomNamingMemory = new Map();
    const d = { ...deps(), isNamed: jest.fn(async () => true) };
    expect(await namingDecisionFor(TURN, memory, d)).toEqual({ namer: null, ask: false });
    expect(d.primaryOf).not.toHaveBeenCalled();
  });

  it('an asked room is remembered for the lease, so the next turn reads nothing and still tells its assistant not to name', async () => {
    const memory: RoomNamingMemory = new Map();
    const store = roomRow();
    expect(await askRoomPrimaryToName({ channelArn: ROOM, primaryBotArn: PRIMARY, userMessage: 'compare the Q3 plans', classification: 'premium' }, {
      claim: store.claim, release: store.release, markNamed: store.markNamed, currentName: async () => undefined,
      dispatch: async () => true, leaseMs: LEASE, now: () => 5_000,
    }, memory)).toBe('asked');
    const d = deps();
    expect(await namingDecisionFor(TURN, memory, d)).toEqual({ namer: PRIMARY, ask: false });
    expect(d.primaryOf).not.toHaveBeenCalled();
  });
});

describe('the answering assistant spends nothing on a rename it would be refused, and the router and processor say so', () => {
  const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
  const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

  it('a turn the router marks as not naming the room asks for no title', () => {
    expect(read('lib/async-processor-core.ts')).toMatch(/event\.namesConversation === false/);
  });

  it('the router marks both dispatches and asks the primary beside each, never after it', () => {
    const router = read('router-agent-handler.ts');
    expect(router.match(/\.\.\.roomNamingFields,/g)).toHaveLength(2);
    expect(router.match(/const \[dispatched\] = await Promise\.all\(\[invokeAsync\(asyncProcessorArn, \{/g)).toHaveLength(2);
    expect(router.match(/\}, turnRoster\), askRoomToBeNamed\(asyncProcessorArn\)\]\);/g)).toHaveLength(2);
    expect(router).not.toMatch(/await askRoomToBeNamed/);
    expect(router).not.toMatch(/UpdateChannelCommand\(\{[^}]*Name:/);
  });

  it('the ask never fails the turn: its failure is logged and the promise settles', () => {
    const router = read('router-agent-handler.ts');
    const at = router.indexOf('const askRoomToBeNamed = ');
    const body = router.slice(at, router.indexOf('/** Fields every dispatch owes the worker', at));
    expect(body).toMatch(/\.then\(\(asked\) => \{[\s\S]*\}, \(err\) => \{/);
  });

  it('@all reaches an assistant only through the router, so the same rule names its room', () => {
    // The channel flow holds no processor ARN and hands an `@all` to the router as a turn (MESSAGE-FLOW 6.1); the
    // router's naming decision covers every turn it dispatches, so a non-primary answering `@all` is marked too.
    const flow = read('channel-flow-processor.ts');
    expect(flow).not.toMatch(/ASYNC_PROCESSOR|asyncProcessorArn/);
    const allBranch = flow.slice(flow.indexOf('  if (mentionsAll) {'), flow.indexOf('AN UNADDRESSED COMMAND GOES TO THE PRIMARY ASSISTANT'));
    expect(allBranch).toMatch(/await handOffTurnToRouter\(\{/);
    expect(allBranch).not.toMatch(/InvokeCommand/);
  });

  it('the processor\'s naming run renames as the bot it was routed as, before any turn work, and answers nothing', () => {
    const processor = read('assistant-async-processor.ts');
    const at = (t: string) => processor.indexOf(t);
    expect(at('if (event.nameRoom) {')).toBeGreaterThan(at('await adoptTurnIdentity(event.correlationId'));
    expect(at('if (event.nameRoom) {')).toBeLessThan(at('const pipeline = await runSharedPipeline(event, admission);'));
    expect(processor).toMatch(/maybeDeriveAndRenameChannel\(event\.channelArn, event\.userMessage \|\| '', event\.botArn\)/);
  });
});

describe('a name already given is never overwritten', () => {
  beforeEach(() => {
    mockChimeSend.mockReset();
    mockBedrockSend.mockReset();
  });

  it('a person\'s own rename stands: no title is derived and the room is not updated', async () => {
    mockChimeSend.mockResolvedValueOnce({ Channel: { Name: 'Our Q3 plan', Mode: 'RESTRICTED' } });
    expect(await maybeDeriveAndRenameChannel(ROOM, 'What is our Q3 plan?', PRIMARY)).toBeNull();
    expect(mockBedrockSend).not.toHaveBeenCalled();
    expect(mockChimeSend.mock.calls.map((c) => c[0].__t)).toEqual(['Describe']);
  });

  it('a name given at creation stands the same way', async () => {
    mockChimeSend.mockResolvedValueOnce({ Channel: { Name: 'checkout-p99 Alarm on AWS/Lambda', Mode: 'RESTRICTED' } });
    expect(await maybeDeriveAndRenameChannel(ROOM, 'Is it still firing?', PRIMARY)).toBeNull();
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  it('the primary\'s naming run renames a room still on the placeholder, bearing its own bot', async () => {
    mockChimeSend.mockResolvedValueOnce({ Channel: { Name: PLACEHOLDER_TITLE, Mode: 'RESTRICTED' } }).mockResolvedValueOnce({});
    mockBedrockSend.mockResolvedValueOnce({ body: new TextEncoder().encode(JSON.stringify({ content: [{ text: 'Q3 Plan Comparison' }] })) });
    expect(await maybeDeriveAndRenameChannel(ROOM, '@Advisor (alt) compare the Q3 plans', PRIMARY)).toBe('Q3 Plan Comparison');
    const update = mockChimeSend.mock.calls.map((c) => c[0]).find((c) => c.__t === 'Update');
    expect(update.input).toMatchObject({ ChannelArn: ROOM, Name: 'Q3 Plan Comparison', ChimeBearer: PRIMARY });
  });
});
