/**
 * THE ASSISTANT SESSION, WITHOUT AWS, FOR EVERY SUITE (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
 *
 * Every step of a turn now acts as the assistant it was routed to, on a session the vend mints from a
 * recorded routing decision. A suite exercising the router, the flow or the processor would otherwise
 * need a routing table and a vend to reach the code it is actually about. Here the decision is recorded
 * and the session minted in memory; the clients stay whatever the suite mocked.
 *
 * The mechanism itself is tested for real, by suites that `jest.unmock` these two modules:
 * `a-turn-acts-as-the-assistant-it-was-routed-to.test.ts`.
 */
const testSession = (botArn: string) => ({
  assistant: 'test-assistant',
  role: 'primary',
  botArn,
  credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test', sessionToken: 'test' },
});

// LAZY: the real module is loaded on the first access to something not overridden, never while the mock is
// being registered, so a suite's own SDK mocks are in place before anything here constructs a client.
jest.mock('../../lambda/src/lib/assistant-session', () => {
  const overrides: Record<string, unknown> = {
    vendAssistantSession: jest.fn(async () => testSession('arn:aws:chime:us-east-1:111122223333:app-instance/test/bot/test')),
    speakAsRoutedAssistant: jest.fn(async (input: { botArn: string }) => testSession(input.botArn)),
    sessionForRoutedAssistant: jest.fn(async (input: { botArn: string }) => testSession(input.botArn)),
    adoptSessionAsAssistant: jest.fn(async (input: { botArn: string }) => testSession(input.botArn)),
    // A plain client, so a suite's `mockClient(ChimeSDKMessagingClient)` sees what was sent on it.
    messagingClientAsAssistant: jest.fn(async () => {
      // `require`, not `requireActual`: a suite that `jest.mock`s the SDK module gets its own mock here too.
      const { ChimeSDKMessagingClient } = require('@aws-sdk/client-chime-sdk-messaging');
      return new ChimeSDKMessagingClient({ region: 'us-east-1' });
    }),
  };
  let actual: Record<string | symbol, unknown> | null = null;
  const real = (): Record<string | symbol, unknown> => (actual ??= jest.requireActual('../../lambda/src/lib/assistant-session'));
  return new Proxy({}, {
    get: (_t, prop) => (prop === '__esModule' ? true : prop in overrides ? overrides[prop as string] : real()[prop]),
    has: (_t, prop) => prop in overrides || prop in real(),
  });
});

jest.mock('../../lambda/src/lib/turn-routing', () => {
  const recordTurnRouting = jest.fn(async () => undefined);
  let actual: Record<string | symbol, unknown> | null = null;
  const real = (): Record<string | symbol, unknown> => (actual ??= jest.requireActual('../../lambda/src/lib/turn-routing'));
  return new Proxy({}, {
    get: (_t, prop) => (prop === '__esModule' ? true : prop === 'recordTurnRouting' ? recordTurnRouting : real()[prop]),
  });
});

/**
 * THE ROOM'S PRIMARY, WITHOUT THE ASSIGNMENT RECORDS, FOR EVERY SUITE (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8).
 *
 * A suite about the flow, Battle Mode or a notice resolves the bot its room is spoken for by, and would
 * otherwise need channel tags and assignment records it is not about. Here the room's classification comes
 * from the suite's own tag mock when it has one, and the bot from the suite's own SSM mock, by the keys the
 * suites already answer: the primary's assignment record, then the classification's bot pointer.
 *
 * The resolver itself is tested for real by `a-room-is-spoken-for-by-its-primary.test.ts`, which unmocks it.
 */
jest.mock('../../lambda/src/lib/conversation-primary', () => {
  // SELF-CONTAINED: loading the real module would load the assignment reader and the session library, which a
  // suite may have partly mocked.
  const PRIMARY_TAG = 'primaryAssistant';
  class RoomHasNoPrimary extends Error { constructor(m: string) { super(m); this.name = 'RoomHasNoPrimary'; } }
  const root = () => process.env.SSM_ROOT || '/agent-echelon';
  // Cached per classification, as the real assignment reader is, so a suite counting reads sees one per classification.
  const bots = new Map<string, string>();
  const botFor = async (classification: string): Promise<string> => {
    const hit = bots.get(classification);
    if (hit) return hit;
    const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
    const ssm = new SSMClient({ region: 'us-east-1' });
    // The primary's assignment record first. A read that FAILS is the answer (no primary); only an absent value tries the
    // classification's bot pointer, which older suites answer instead.
    let record = '';
    try {
      // The declared primary's record, at the one path every live assistant's record has (ADR-048, amended 2026-10-23).
      const { defaultProfileRegistry } = require('../../lib/profile-registry');
      const primary = defaultProfileRegistry.roleAssistantName(classification, 'primary') || classification;
      record = (await ssm.send(new GetParameterCommand({ Name: `${root()}/assistant-assignments/${classification}/primary/assistants/${primary}` })))?.Parameter?.Value || '';
    } catch {
      throw new RoomHasNoPrimary(`the primary's assignment record for ${classification} could not be read`);
    }
    let arn = '';
    if (record) {
      // A suite that answers every parameter with a bare bot ARN means that bot.
      try { arn = JSON.parse(record)?.botArn || ''; } catch { arn = record.startsWith('arn:') ? record : ''; }
      if (!arn) throw new RoomHasNoPrimary(`the primary's assignment record for ${classification} names no bot`);
    } else {
      try {
        arn = (await ssm.send(new GetParameterCommand({ Name: process.env.BOT_ARN_PARAM || `${root()}/assistant/${classification}/bot-arn` })))?.Parameter?.Value || '';
      } catch { arn = ''; }
    }
    if (!arn) throw new RoomHasNoPrimary(`no primary configured for ${classification} in this suite`);
    bots.set(classification, arn);
    return arn;
  };
  const classificationOf = async (channelArn: string, chime?: { send: (c: unknown) => Promise<any> }): Promise<string> => {
    try {
      const { ListTagsForResourceCommand } = require('@aws-sdk/client-chime-sdk-messaging');
      const tags = (await chime?.send(new ListTagsForResourceCommand({ ResourceARN: channelArn })))?.Tags || [];
      const c = tags.find((t: { Key?: string }) => t.Key === 'classification')?.Value;
      if (c) return c;
    } catch { /* the suite mocks no tags */ }
    return process.env.CLASSIFICATION || 'premium';
  };
  return {
    __esModule: true,
    PRIMARY_TAG,
    PRIMARY_ROLE: 'primary',
    RoomHasNoPrimary,
    __resetRoomPrimaryCache: () => undefined,
    // A real memo, so a suite that queues one tag read per request sees one.
    memoizedTagReader: (client: { send: (c: any) => Promise<any> }) => {
      const memo = new Map<string, any>();
      return {
        send: async (cmd: any) => {
          const arn = cmd?.input?.ResourceARN || '';
          if (memo.has(arn)) return memo.get(arn);
          const res = await client.send(cmd);
          if (res?.Tags?.some((t: { Key?: string }) => t.Key === 'classification')) memo.set(arn, res);
          return res;
        },
      };
    },
    primaryAssistantOf: jest.fn(async (channelArn: string, chime?: { send: (c: unknown) => Promise<any> }) => {
      const classification = await classificationOf(channelArn, chime);
      return { assistant: 'test-assistant', botArn: await botFor(classification), classification, source: 'tag' };
    }),
    primaryAssignmentOf: jest.fn(async (classification: string) => ({ assistant: 'test-assistant', botArn: await botFor(classification) })),
    primaryTagFor: jest.fn(async () => ({ Key: PRIMARY_TAG, Value: 'test-assistant' })),
  };
});
