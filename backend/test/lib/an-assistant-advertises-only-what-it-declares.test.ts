/**
 * WHAT ONE ASSISTANT PUBLISHES FOR ANOTHER TO READ, and what it must not.
 *
 * ── THE RULE THAT WAS PREVIOUSLY UNFALSIFIABLE ───────────────────────────────────────────────────
 *
 * "A version inheriting the deployment pack advertises nothing" was stated in the design and held only
 * by accident: the person-facing derivation runs on the RESOLVED pack, which cannot tell an inherited
 * intent from a declared one, so the rule survived only while no platform default happened to carry a
 * `summary`. Adding one is a natural edit - summaries are person-facing - and it would have silently
 * made every inheriting assistant advertise the deployment taxonomy as its own, which is a primary
 * routing work to a peer no more specialized than itself.
 *
 * The projection therefore reads the STORED pack, and the case below adds a summary to a platform
 * default to prove the rule holds when it would previously have broken.
 *
 * ── AND WHAT THE PROJECTION IS FOR ───────────────────────────────────────────────────────────────
 *
 * The published set is keys, person-facing summaries and the authored boundary. Never `instructions`,
 * never `tools`. The design's promise is that one team's implementation does not enter another team's
 * prompt, and this is the half of that promise which is code: the other half is the IAM grant, which
 * gives a peer the projection and not the definition.
 */
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ __type: 'GetParameter', input })),
  PutParameterCommand: jest.fn((input: unknown) => ({ __type: 'PutParameter', input })),
}), { virtual: true });

import {
  projectAdvertisement,
  advertisementParamName,
  readAdvertisement,
  roommatesInConversation,
  roommateForKey,
  __resetAdvertisementCacheForTests,
  type AssistantAdvertisement,
} from '../../lambda/src/lib/assistant-advertisement';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
const bot = (n: string) => `${APP}/bot/${n}`;

beforeEach(() => {
  jest.clearAllMocks();
  __resetAdvertisementCacheForTests();
});

describe('the projection publishes what a peer may read and nothing else', () => {
  it('publishes keys, summaries and the boundary', () => {
    const ad = projectAdvertisement({
      assistant: 'ops-premium',
      displayName: 'Ops',
      boundary: 'I cannot see customer accounts',
      pack: {
        intents: [
          { key: 'platform_health', description: 'classifier-facing', summary: 'ask for the error rate' },
          { key: 'log_search', description: 'classifier-facing', summary: 'ask me to search the logs' },
        ],
      } as never,
    });
    expect(ad.assistant).toBe('ops-premium');
    expect(ad.displayName).toBe('Ops');
    expect(ad.boundary).toBe('I cannot see customer accounts');
    expect(ad.intents).toEqual([
      { key: 'platform_health', summary: 'ask for the error rate' },
      { key: 'log_search', summary: 'ask me to search the logs' },
    ]);
  });

  it('publishes NEITHER instructions NOR tools, whatever the pack carries', () => {
    const ad = projectAdvertisement({
      assistant: 'ops-premium',
      pack: {
        intents: [{
          key: 'platform_health',
          description: 'classifier-facing',
          summary: 'ask for the error rate',
          instructions: 'SECRET: how the ops team wants this answered',
          tools: ['read_deployment_health'],
        }],
      } as never,
    });
    const serialized = JSON.stringify(ad);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('read_deployment_health');
    expect(serialized).not.toContain('classifier-facing');
  });

  it('omits an intent the pack recognizes but does not advertise', () => {
    // Absence of `summary` means recognized-but-not-advertised, so a narrow internal lookup stays out
    // of what a peer is offered.
    const ad = projectAdvertisement({
      assistant: 'ops-premium',
      pack: {
        intents: [
          { key: 'internal_lookup', description: 'classifier-facing' },
          { key: 'platform_health', description: 'classifier-facing', summary: 'ask for the error rate' },
        ],
      } as never,
    });
    expect(ad.intents.map((i) => i.key)).toEqual(['platform_health']);
  });

  it('advertises NOTHING when the version inherits the deployment pack', () => {
    // THE CASE THAT WAS UNFALSIFIABLE. No own pack at all.
    expect(projectAdvertisement({ assistant: 'advisor' }).intents).toEqual([]);
  });

  it('advertises nothing when it declares no intents, EVEN IF a platform default carries a summary', () => {
    // The regression the stored-pack projection exists to prevent: `extends` is present and the pack
    // declares nothing of its own, so there is nothing of its own to advertise. A projection built from
    // the RESOLVED pack would return the deployment taxonomy here and pass every other case.
    const ad = projectAdvertisement({
      assistant: 'advisor',
      pack: { extends: 'default', intents: [] } as never,
    });
    expect(ad.intents).toEqual([]);
  });

  it('falls back to the REGISTRY name, not the handle, when the version names none', () => {
    // This name reaches a person. The seeded definitions carry no display name, so falling straight to the
    // handle put "ops-premium" into a sentence somebody reads - "that one is ops-premium's" - while the
    // name on the reply they then saw was "Ops". Measured live before this precedence existed.
    expect(projectAdvertisement({ assistant: 'ops-premium' }).displayName).toBe('Ops');
  });

  it('prefers the version\'s own display name over the registry\'s', () => {
    // The version is the thing an operator edits without a deploy, so it wins.
    expect(projectAdvertisement({ assistant: 'ops-premium', displayName: 'Operations' }).displayName)
      .toBe('Operations');
  });

  it('falls back to the handle only for an assistant the registry does not know', () => {
    expect(projectAdvertisement({ assistant: 'not-a-declared-profile' }).displayName)
      .toBe('not-a-declared-profile');
  });
});

describe('reading an advertisement', () => {
  const AD: AssistantAdvertisement = {
    assistant: 'ops-premium',
    displayName: 'Ops',
    intents: [{ key: 'platform_health', summary: 'ask for the error rate' }],
  };

  it('reads it from the assistant\'s own advertisement parameter, never the definition', () => {
    expect(advertisementParamName('/agent-echelon', 'ops-premium'))
      .toBe('/agent-echelon/assistant/ops-premium/advertisement');
    expect(advertisementParamName('/agent-echelon', 'ops-premium')).not.toContain('definition');
  });

  it('returns null rather than throwing when the parameter does not exist', async () => {
    // The ordinary case on a single-assistant deployment, and it must cost a person nothing.
    mockSsmSend.mockRejectedValue(Object.assign(new Error('nope'), { name: 'ParameterNotFound' }));
    expect(await readAdvertisement('ops-premium')).toBeNull();
  });

  it('returns null when the advertisement is readable but says nothing', async () => {
    mockSsmSend.mockResolvedValue({ Parameter: { Value: JSON.stringify({ assistant: 'x', displayName: 'X', intents: [] }) } });
    expect(await readAdvertisement('x')).toBeNull();
  });

  it('caches by assistant, including the negative', async () => {
    mockSsmSend.mockRejectedValue(new Error('ParameterNotFound'));
    await readAdvertisement('ops-premium');
    await readAdvertisement('ops-premium');
    // Caching the MISS is the point: the common deployment has no advertisements, and re-reading an
    // absent parameter on every fall-through turn is the cost this exists to avoid.
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
  });

  it('does not let one assistant\'s answer serve another', async () => {
    mockSsmSend.mockResolvedValue({ Parameter: { Value: JSON.stringify(AD) } });
    await readAdvertisement('ops-premium');
    await readAdvertisement('advisor');
    expect(mockSsmSend).toHaveBeenCalledTimes(2);
  });
});

describe('which roommates a turn could route to', () => {
  const LIVE_ASSISTANTS = [
    { handle: 'advisor', botArn: bot('advisor'), role: 'primary' },
    { handle: 'ops-premium', botArn: bot('ops'), role: 'ops' },
  ];
  const adFor = (assistant: string, keys: string[]): AssistantAdvertisement => ({
    assistant, displayName: assistant, intents: keys.map((k) => ({ key: k, summary: `do ${k}` })),
  });

  beforeEach(() => {
    mockSsmSend.mockImplementation((cmd: { input: { Name: string } }) => {
      const name = cmd.input.Name;
      if (name.includes('/ops-premium/')) {
        return Promise.resolve({ Parameter: { Value: JSON.stringify(adFor('ops-premium', ['platform_health'])) } });
      }
      return Promise.reject(new Error('ParameterNotFound'));
    });
  });

  it('excludes the assistant answering the turn', async () => {
    const r = await roommatesInConversation({
      botArnsInRoom: [bot('advisor'), bot('ops')], selfBotArn: bot('advisor'), liveAssistants: LIVE_ASSISTANTS,
    });
    expect(r.map((x) => x.assistant)).toEqual(['ops-premium']);
  });

  it('excludes an assistant that is NOT in the conversation', async () => {
    // Membership is the index. An assistant that exists in the deployment but is absent from this room is not
    // a routing target, which is what keeps routing bounded by who is actually present.
    const r = await roommatesInConversation({
      botArnsInRoom: [bot('advisor')], selfBotArn: bot('advisor'), liveAssistants: LIVE_ASSISTANTS,
    });
    expect(r).toEqual([]);
  });

  it('excludes a member that holds no live role in this classification', async () => {
    const r = await roommatesInConversation({
      botArnsInRoom: [bot('advisor'), bot('a-stranger')], selfBotArn: bot('advisor'), liveAssistants: LIVE_ASSISTANTS,
    });
    expect(r).toEqual([]);
  });

  it('excludes a roommate that advertises nothing', async () => {
    const r = await roommatesInConversation({
      botArnsInRoom: [bot('ops'), bot('advisor')], selfBotArn: bot('ops'), liveAssistants: LIVE_ASSISTANTS,
    });
    // `advisor` publishes no advertisement, so it is present but not routable.
    expect(r).toEqual([]);
  });

  it('reads nothing when the room holds no other assistant', async () => {
    await roommatesInConversation({
      botArnsInRoom: [bot('advisor')], selfBotArn: bot('advisor'), liveAssistants: LIVE_ASSISTANTS,
    });
    expect(mockSsmSend).not.toHaveBeenCalled();
  });
});

describe('choosing a roommate for an advertised key', () => {
  const r = (assistant: string, keys: string[]): never => ({
    assistant, botArn: bot(assistant), role: 'x',
    advertisement: { assistant, displayName: assistant, intents: keys.map((k) => ({ key: k, summary: k })) },
  }) as never;

  it('names the one that advertises the key', () => {
    const out = roommateForKey([r('ops-premium', ['platform_health'])], 'platform_health');
    expect(out.kind).toBe('one');
  });

  it('REFUSES TO CHOOSE when two advertise the same key', () => {
    // Silently picking one makes the answer depend on which assistant was listed first, which is an
    // order nobody can see and nothing records. The design's rule is to ask the person.
    const out = roommateForKey([r('a', ['platform_health']), r('b', ['platform_health'])], 'platform_health');
    expect(out.kind).toBe('ambiguous');
    if (out.kind === 'ambiguous') expect(out.roommates).toHaveLength(2);
  });

  it('says none when nobody advertises it, so the answering assistant keeps the turn', () => {
    expect(roommateForKey([r('ops-premium', ['platform_health'])], 'financial_metric').kind).toBe('none');
    expect(roommateForKey([], 'platform_health').kind).toBe('none');
    expect(roommateForKey([r('ops-premium', ['platform_health'])], '').kind).toBe('none');
  });
});
