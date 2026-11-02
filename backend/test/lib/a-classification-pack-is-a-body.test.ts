/**
 * A CLASSIFICATION'S INTENT PACK IS A BODY ON THE SHARED STORE, AND ITS PARAMETER HOLDS A POINTER.
 *
 * `${SSM_ROOT}/assistant/{classification}/assistant-intent-pack` is read by the router, the processor, the
 * task service, the item list, the profile write path and the classifier replay. A pack with a declared
 * prompt on every workflow step outgrows any parameter tier, so every writer puts the JSON under
 * `classification-packs/{classification}/{sha256}/intentPack` and the parameter carries `{ ref }`.
 *
 * What these pin, rather than that the SDK was called:
 *  - an inline value (a deployment written before the store, or a hand-written parameter) still reads;
 *  - a pointer is followed, and only into the reading classification's own prefix;
 *  - a body whose hash is not its content id is refused, never served;
 *  - the writer puts the body BEFORE the pointer, so a parameter never names a body that is not there;
 *  - a pointer costs one S3 read per container, not one per turn.
 */
import {
  classificationPackKey, classificationPackPrefix, contentIdOf, putClassificationPack, getClassificationPack,
} from '../../lambda/src/lib/profile-bodies';
import {
  packPointerOf, packPointerValue, resolvePackParameterValue, writeClassificationPack, hydrateIntentPackFromSsm,
  knownIntentKeys, getIntentPack, classificationOfPackParam, _resetIntentPackCache, DEFAULT_INTENT_PACK,
  MAX_INTENT_PACK_BYTES,
} from '../../lambda/src/lib/intent-pack';

const PACK = JSON.stringify({
  intents: [{ key: 'find_recipe', description: 'Find a recipe', keywords: ['recipe'], delivery: 'PLACEHOLDER_UPDATE' }],
});

/** An S3 double holding objects by key, recording every command in order. */
function fakeStore(objects: Record<string, string> = {}) {
  const calls: Array<{ op: string; input: any }> = [];
  const s3 = {
    send: jest.fn(async (cmd: any) => {
      const op = cmd.constructor.name;
      calls.push({ op, input: cmd.input });
      if (op === 'PutObjectCommand') {
        objects[cmd.input.Key] = cmd.input.Body;
        return {};
      }
      if (op === 'GetObjectCommand') {
        const body = objects[cmd.input.Key];
        if (body === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => body } };
      }
      throw new Error(`unexpected ${op}`);
    }),
  } as any;
  return { s3, calls, objects };
}

/** An SSM double holding parameters by name, sharing the call log with the store when given one. */
function fakeSsm(params: Record<string, string> = {}, calls: Array<{ op: string; input: any }> = []) {
  return {
    send: jest.fn(async (cmd: any) => {
      const op = cmd.constructor.name;
      calls.push({ op, input: cmd.input });
      if (op === 'GetParameterCommand') {
        if (!(cmd.input.Name in params)) throw Object.assign(new Error('missing'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: params[cmd.input.Name] } };
      }
      if (op === 'PutParameterCommand') {
        params[cmd.input.Name] = cmd.input.Value;
        return {};
      }
      throw new Error(`unexpected ${op}`);
    }),
  } as any;
}

describe('the key family names its owner', () => {
  it('is classification-packs/{classification}/{sha256}/intentPack, apart from version bodies', () => {
    const id = contentIdOf(PACK);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(classificationPackKey('standard', id)).toBe(`classification-packs/standard/${id}/intentPack`);
    expect(classificationPackPrefix('standard')).toBe('classification-packs/standard/');
    expect(classificationPackKey('standard', id).startsWith('profiles/')).toBe(false);
  });

  it('refuses a classification segment that could escape its prefix', () => {
    expect(() => classificationPackPrefix('basic/../premium')).toThrow(/not a classification value/);
    expect(() => classificationPackPrefix('*')).toThrow(/not a classification value/);
  });

  it('reads the classification out of the parameter name', () => {
    expect(classificationOfPackParam('/agent-echelon/assistant/premium/assistant-intent-pack')).toBe('premium');
    expect(classificationOfPackParam('/agent-echelon/assistant/premium/definition')).toBeUndefined();
  });
});

describe('a parameter value is an inline pack or a pointer', () => {
  it('tells the two apart', () => {
    const ref = { key: classificationPackKey('basic', contentIdOf(PACK)), configId: contentIdOf(PACK) };
    expect(packPointerOf(packPointerValue(ref))).toEqual(ref);
    expect(packPointerOf(PACK)).toBeUndefined();
    expect(packPointerOf('[{"key":"x"}]')).toBeUndefined();
    expect(packPointerOf('not json')).toBeUndefined();
  });

  it('returns an inline pack as it is, with no S3 read', async () => {
    const { s3 } = fakeStore();
    await expect(resolvePackParameterValue(PACK, 'basic', { s3, bucket: 'b' })).resolves.toBe(PACK);
    await expect(resolvePackParameterValue(undefined, 'basic', { s3, bucket: 'b' })).resolves.toBeUndefined();
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('follows a pointer to the body it names', async () => {
    const { s3 } = fakeStore();
    const ref = await putClassificationPack('basic', PACK, { s3, bucket: 'b' });
    await expect(resolvePackParameterValue(packPointerValue(ref), 'basic', { s3, bucket: 'b' })).resolves.toBe(PACK);
  });

  it('REFUSES a body whose hash is not its content id', async () => {
    const id = contentIdOf(PACK);
    const key = classificationPackKey('basic', id);
    const { s3 } = fakeStore({ [key]: PACK.replace('Find a recipe', 'Find anything') });
    await expect(getClassificationPack({ key, configId: id }, 'basic', { s3, bucket: 'b' }))
      .rejects.toThrow(/hashes to .*not the/);
  });

  it("REFUSES a pointer into another classification's prefix, before any read", async () => {
    const { s3 } = fakeStore();
    const premium = await putClassificationPack('premium', PACK, { s3, bucket: 'b' });
    s3.send.mockClear();
    await expect(resolvePackParameterValue(packPointerValue(premium), 'basic', { s3, bucket: 'b' }))
      .rejects.toThrow(/Refusing to read another classification's pack/);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('REFUSES a pointer whose body is absent rather than serving the platform default', async () => {
    const id = contentIdOf(PACK);
    const { s3 } = fakeStore();
    await expect(getClassificationPack({ key: classificationPackKey('basic', id), configId: id }, 'basic', { s3, bucket: 'b' }))
      .rejects.toThrow(/could not be read/);
  });
});

describe('the writer puts the body, then the pointer', () => {
  const ROOT = '/agent-echelon';
  const NAME = `${ROOT}/assistant/standard/assistant-intent-pack`;

  it('writes the body to the classification prefix before the parameter names it', async () => {
    const { s3, calls } = fakeStore();
    const params: Record<string, string> = {};
    const ssm = fakeSsm(params, calls);
    await expect(writeClassificationPack(ssm, ROOT, 'standard', PACK, { s3, bucket: 'b' })).resolves.toBe(true);
    expect(calls.map((c) => c.op)).toEqual(['PutObjectCommand', 'PutParameterCommand']);
    expect(calls[0].input.Key).toBe(classificationPackKey('standard', contentIdOf(PACK)));
    expect(packPointerOf(params[NAME])).toEqual({ key: calls[0].input.Key, configId: contentIdOf(PACK) });
    // And what it wrote reads back as the pack.
    await expect(resolvePackParameterValue(params[NAME], 'standard', { s3, bucket: 'b' })).resolves.toBe(PACK);
  });

  it('writes nothing, body included, when ifAbsent finds a parameter already set', async () => {
    const { s3, calls } = fakeStore();
    const ssm = fakeSsm({ [NAME]: '{"intents":[]}' }, calls);
    await expect(writeClassificationPack(ssm, ROOT, 'standard', PACK, { s3, bucket: 'b' }, { ifAbsent: true })).resolves.toBe(false);
    expect(calls.map((c) => c.op)).toEqual(['GetParameterCommand']);
  });

  it('refuses an oversize pack with the measurement named, before any write', async () => {
    const { s3, calls } = fakeStore();
    const ssm = fakeSsm({}, calls);
    const big = JSON.stringify({ intents: [{ key: 'k', description: 'x'.repeat(MAX_INTENT_PACK_BYTES) }] });
    await expect(writeClassificationPack(ssm, ROOT, 'standard', big, { s3, bucket: 'b' }))
      .rejects.toThrow(new RegExp(`over the ${MAX_INTENT_PACK_BYTES}-byte limit`));
    expect(calls).toEqual([]);
  });

  it('accepts a pack past the 8 KB parameter limit, which is the point of the store', async () => {
    const { s3 } = fakeStore();
    const ssm = fakeSsm();
    const large = JSON.stringify({ intents: [{ key: 'k', description: 'x'.repeat(12 * 1024) }] });
    await expect(writeClassificationPack(ssm, ROOT, 'standard', large, { s3, bucket: 'b' })).resolves.toBe(true);
  });
});

describe('the runtime hydrates a pointer once per container', () => {
  afterEach(() => {
    delete process.env.ASSISTANT_INTENT_PACK_PARAM;
    _resetIntentPackCache();
  });

  it('follows the pointer at cold start and reads S3 no more after that', async () => {
    const { s3 } = fakeStore();
    const ref = await putClassificationPack('analyst', PACK, { s3, bucket: 'b' });
    s3.send.mockClear();
    process.env.ASSISTANT_INTENT_PACK_PARAM = '/agent-echelon/assistant/analyst/assistant-intent-pack';
    _resetIntentPackCache();
    const deps = { getParameter: async () => packPointerValue(ref), bodies: { s3, bucket: 'b' } };
    await hydrateIntentPackFromSsm(deps);
    await hydrateIntentPackFromSsm(deps);
    expect(knownIntentKeys().has('find_recipe')).toBe(true);
    expect(s3.send).toHaveBeenCalledTimes(1);
  });

  it('serves the platform default and says so when the body is refused', async () => {
    const id = contentIdOf(PACK);
    const key = classificationPackKey('analyst', id);
    const { s3 } = fakeStore({ [key]: '{"intents":[]}' });
    process.env.ASSISTANT_INTENT_PACK_PARAM = '/agent-echelon/assistant/analyst/assistant-intent-pack';
    _resetIntentPackCache();
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await hydrateIntentPackFromSsm({ getParameter: async () => packPointerValue({ key, configId: id }), bodies: { s3, bucket: 'b' } });
    expect(getIntentPack()).toBe(DEFAULT_INTENT_PACK);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
