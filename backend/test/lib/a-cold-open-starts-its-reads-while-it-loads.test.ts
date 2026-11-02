/**
 * A COLD OPEN STARTS ITS READS WHILE IT LOADS (`lambda/src/lib/cold-path.ts`).
 *
 * Opening a conversation crosses the person-facing API and the classification's creator, and on a cold container
 * most of each one's time is first-call work. Each function starts the reads it always needs while its module
 * loads, and shares one client per service across the modules it reads through. What this pins:
 *
 *   - a primed read is taken once, by the first request, and later requests read through the loader's own
 *     cache, so priming never changes which value a request sees;
 *   - a priming that failed or found nothing is read again once, and a second failure reaches the caller;
 *   - the creator primes the primary assistant, the channel flow and the service admin at load, and its first
 *     request reads none of them again;
 *   - the creator hands its one SSM client to the registry, the assignment records and the service admin's
 *     parameter, and its messaging client to the shared creator; the API hands its SSM client to the registry
 *     and the creators' keys, and primes each member creator's key;
 *   - nothing is primed outside a Lambda execution environment, so a test or a script loading a handler reads
 *     nothing it did not ask for.
 */
import { PrimedRead, phaseTimer, PRIMED_READ_MAX_AGE_MS } from '../../lambda/src/lib/cold-path';

/** The real registry, read lazily so an import cycle cannot capture it half-loaded, with one export replaced. */
const registryWith = (useProfileRegistrySsmClient: jest.Mock) => {
  const actual = jest.requireActual('../../lib/profile-registry');
  return new Proxy(actual, { get: (target, prop) => (prop === 'useProfileRegistrySsmClient' ? useProfileRegistrySsmClient : target[prop]) });
};

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

describe('a primed read', () => {
  it('is taken once by the first request, and later requests read through the loader', async () => {
    const load = jest.fn().mockResolvedValueOnce('primed').mockResolvedValueOnce('later');
    const read = new PrimedRead('test', load);
    read.prime();
    read.prime();
    expect(load).toHaveBeenCalledTimes(1);
    expect(await read.get()).toBe('primed');
    expect(load).toHaveBeenCalledTimes(1);
    expect(read.primed).toBe(false);
    expect(await read.get()).toBe('later');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never throws into module load, and a rejected priming is read again once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const load = jest.fn().mockRejectedValueOnce(new Error('throttled')).mockResolvedValueOnce('retried');
    const read = new PrimedRead('test', load);
    expect(() => read.prime()).not.toThrow();
    await flush();
    expect(await read.get()).toBe('retried');
    expect(load).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('primed test read failed');
    warn.mockRestore();
  });

  it('reports a second failure and hands it to the caller', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const load = jest.fn().mockRejectedValue(Object.assign(new Error('down'), { name: 'ServiceUnavailable' }));
    const read = new PrimedRead('test', load);
    read.prime();
    await expect(read.get()).rejects.toThrow('down');
    expect(load).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0][0])).toContain('failed when primed and again when retried');
    warn.mockRestore();
    error.mockRestore();
  });

  it('reads again once when the priming answered with nothing usable', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const load = jest.fn().mockResolvedValueOnce('').mockResolvedValueOnce('arn:found');
    const read = new PrimedRead('test', load, { unusable: (v: string) => !v });
    read.prime();
    expect(await read.get()).toBe('arn:found');
    expect(load).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('is discarded unread once it is older than its limit', async () => {
    let now = 1_000;
    const load = jest.fn().mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh');
    const read = new PrimedRead('test', load, { now: () => now });
    read.prime();
    await flush();
    now += PRIMED_READ_MAX_AGE_MS + 1;
    expect(await read.get()).toBe('fresh');
  });
});

describe('a phase timer', () => {
  it('records each phase, whether it resolves or throws', async () => {
    let now = 0;
    const timer = phaseTimer(() => now);
    await timer.time('a', async () => { now += 5; });
    await expect(timer.time('b', async () => { now += 7; throw new Error('x'); })).rejects.toThrow('x');
    expect(timer.phases).toEqual({ a: 5, b: 7 });
    expect(timer.elapsed()).toBe(12);
  });
});

// ── THE CREATOR ────────────────────────────────────────────────────────────────────────────────────

const APP_INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/inst';
const BOT = `${APP_INSTANCE}/bot/assistant-premium`;
const USER = `${APP_INSTANCE}/user/user-a`;
const ADMIN = `${APP_INSTANCE}/user/service-admin`;
const FLOW = 'arn:aws:chime:us-east-1:111:channel-flow/flow';

interface CreatorMocks {
  ssmSend: jest.Mock;
  primary: jest.Mock;
  bearer: jest.Mock;
  create: jest.Mock;
  useRegistry: jest.Mock;
  useAgents: jest.Mock;
  useBearer: jest.Mock;
  useMessaging: jest.Mock;
}

function loadCreator(mocks: CreatorMocks, inLambda: boolean): typeof import('../../lambda/src/create-conversation-at-classification') {
  const saved = { ...process.env };
  Object.assign(process.env, {
    CREATOR_CLASSIFICATION: 'premium',
    APP_INSTANCE_ARN: APP_INSTANCE,
    CHANNEL_FLOW_ARN_PARAM: '/flow-arn',
    CREATOR_BEARER_ARN_PARAM: '/admin-arn',
  });
  if (inLambda) process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';
  else delete process.env.AWS_EXECUTION_ENV;
  let mod: typeof import('../../lambda/src/create-conversation-at-classification') | undefined;
  try {
    jest.isolateModules(() => {
      jest.doMock('@aws-sdk/client-ssm', () => ({
        SSMClient: jest.fn(() => ({ send: mocks.ssmSend })),
        GetParameterCommand: jest.fn((input: unknown) => ({ input })),
        GetParametersByPathCommand: jest.fn((input: unknown) => ({ input })),
      }));
      jest.doMock('../../lib/profile-registry', () => registryWith(mocks.useRegistry));
      jest.doMock('../../lambda/src/lib/conversation-primary', () => ({ primaryAssignmentOf: mocks.primary }));
      jest.doMock('../../lambda/src/lib/default-agents', () => ({ useDefaultAgentsSsmClient: mocks.useAgents }));
      jest.doMock('../../lambda/src/lib/service-admin-bearer', () => ({
        resolveServiceAdminBearer: mocks.bearer,
        useServiceAdminBearerSsmClient: mocks.useBearer,
      }));
      jest.doMock('../../lambda/src/lib/channel-creation', () => ({
        createConversationForPerson: mocks.create,
        useChannelCreationMessagingClient: mocks.useMessaging,
      }));
      mod = require('../../lambda/src/create-conversation-at-classification');
    });
  } finally {
    process.env = saved;
  }
  return mod!;
}

function creatorMocks(): CreatorMocks {
  return {
    ssmSend: jest.fn().mockResolvedValue({ Parameter: { Value: FLOW } }),
    primary: jest.fn().mockResolvedValue({ assistant: 'premium', botArn: BOT }),
    bearer: jest.fn().mockResolvedValue(ADMIN),
    create: jest.fn().mockResolvedValue({ channelArn: `${APP_INSTANCE}/channel/c1`, channelId: 'c1' }),
    useRegistry: jest.fn(),
    useAgents: jest.fn(),
    useBearer: jest.fn(),
    useMessaging: jest.fn(),
  };
}

const TYPED = { classification: 'premium', userArn: USER, title: 'Hello', modelId: 'm' };

describe('the classification\'s creator', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    log.mockRestore();
    warn.mockRestore();
  });

  it('hands one SSM client to every module it reads through, and its messaging client to the creator', () => {
    const mocks = creatorMocks();
    loadCreator(mocks, false);
    const ssm = mocks.useRegistry.mock.calls[0][0];
    expect(ssm).toBeDefined();
    expect(mocks.useAgents).toHaveBeenCalledWith(ssm);
    expect(mocks.useBearer).toHaveBeenCalledWith(ssm);
    expect(mocks.useMessaging).toHaveBeenCalledTimes(1);
  });

  it('primes nothing outside a Lambda execution environment', async () => {
    const mocks = creatorMocks();
    loadCreator(mocks, false);
    await flush();
    expect(mocks.primary).not.toHaveBeenCalled();
    expect(mocks.bearer).not.toHaveBeenCalled();
    expect(mocks.ssmSend).not.toHaveBeenCalled();
  });

  it('starts all three reads at load, and its first request reads none of them again', async () => {
    const mocks = creatorMocks();
    const { handler } = loadCreator(mocks, true);
    await flush();
    expect(mocks.primary).toHaveBeenCalledTimes(1);
    expect(mocks.bearer).toHaveBeenCalledTimes(1);
    expect(mocks.ssmSend).toHaveBeenCalledTimes(1);

    const result = await handler(TYPED);
    expect(result).toEqual({ ok: true, channelArn: `${APP_INSTANCE}/channel/c1`, channelId: 'c1', title: 'Hello' });
    expect(mocks.primary).toHaveBeenCalledTimes(1);
    expect(mocks.bearer).toHaveBeenCalledTimes(1);
    expect(mocks.ssmSend).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ botArn: BOT, channelFlowArn: FLOW, creatorBearerArn: ADMIN }));

    // The second request reads through the loaders, which keep their own caches and TTLs.
    await handler(TYPED);
    expect(mocks.primary).toHaveBeenCalledTimes(2);
    expect(mocks.bearer).toHaveBeenCalledTimes(2);
  });

  it('a room asked for with no title opens with the platform placeholder, whatever language the client reads', async () => {
    const mocks = creatorMocks();
    const { handler } = loadCreator(mocks, true);
    const { title: _omitted, ...untitled } = TYPED;
    expect(await handler(untitled)).toEqual(expect.objectContaining({ ok: true, title: 'New conversation' }));
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'New conversation' }));
  });

  it('reads a failed or empty priming again once, so a transient failure refuses nothing', async () => {
    const mocks = creatorMocks();
    mocks.primary.mockRejectedValueOnce(new Error('throttled'));
    mocks.bearer.mockResolvedValueOnce('');
    const { handler } = loadCreator(mocks, true);
    await flush();
    const result = await handler(TYPED);
    expect(result.ok).toBe(true);
    expect(mocks.primary).toHaveBeenCalledTimes(2);
    expect(mocks.bearer).toHaveBeenCalledTimes(2);
  });

  it('still refuses as before when the retry fails too', async () => {
    const mocks = creatorMocks();
    mocks.primary.mockRejectedValue(new Error('down'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler } = loadCreator(mocks, true);
    await flush();
    expect(await handler(TYPED)).toEqual({ ok: false, code: 'SERVER_MISCONFIG', error: 'no assistant is published for this classification' });
    error.mockRestore();
  });

  it('writes one timing line per request, with the cold flag and each phase', async () => {
    const mocks = creatorMocks();
    const { handler } = loadCreator(mocks, true);
    await handler(TYPED);
    await handler(TYPED);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"_timing"')).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.cold)).toEqual([true, false]);
    expect(lines[0]).toEqual(expect.objectContaining({ _timing: 'conversation-creator', kind: 'typed', classification: 'premium', ok: true }));
    expect(Object.keys(lines[0].phases)).toEqual(expect.arrayContaining(['registry', 'primaryAssistant', 'channelFlow', 'serviceAdmin']));
  });
});

// ── THE API ────────────────────────────────────────────────────────────────────────────────────────

describe('the person-facing API', () => {
  function loadApi(resolve: jest.Mock, useCreatorSsm: jest.Mock, useRegistry: jest.Mock, inLambda: boolean) {
    const saved = { ...process.env };
    if (inLambda) process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';
    else delete process.env.AWS_EXECUTION_ENV;
    try {
      jest.isolateModules(() => {
        jest.doMock('@aws-sdk/client-ssm', () => ({ SSMClient: jest.fn(() => ({ send: jest.fn() })) }));
        jest.doMock('../../lib/profile-registry', () => registryWith(useRegistry));
        jest.doMock('../../lambda/src/lib/conversation-creator-arn', () => ({
          resolveConversationCreatorArn: resolve,
          useConversationCreatorArnSsmClient: useCreatorSsm,
        }));
        require('../../lambda/src/create-conversation');
      });
    } finally {
      process.env = saved;
    }
  }

  it('hands one SSM client to the registry and the creators\' keys', () => {
    const useCreatorSsm = jest.fn();
    const useRegistry = jest.fn();
    loadApi(jest.fn(), useCreatorSsm, useRegistry, false);
    expect(useRegistry).toHaveBeenCalledTimes(1);
    expect(useCreatorSsm).toHaveBeenCalledWith(useRegistry.mock.calls[0][0]);
  });

  it('primes each member conversational classification\'s creator key at load, and only in Lambda', async () => {
    const { defaultProfileRegistry: profiles } = jest.requireActual('../../lib/profile-registry');
    const members = profiles.memberClassificationValues().filter((c: string) => profiles.isConversational(c));
    expect(members.length).toBeGreaterThan(0);

    const idle = jest.fn();
    loadApi(idle, jest.fn(), jest.fn(), false);
    await flush();
    expect(idle).not.toHaveBeenCalled();

    const resolve = jest.fn().mockResolvedValue('arn:creator');
    loadApi(resolve, jest.fn(), jest.fn(), true);
    await flush();
    expect(resolve.mock.calls.map((c) => c[0]).sort()).toEqual([...members].sort());
  });
});
