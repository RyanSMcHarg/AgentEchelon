/**
 * A SECRET IS READ THROUGH ONE CACHE (`lambda/src/lib/secret-cache.ts`).
 *
 *  - A value read in the last five minutes is served from the cache; after that it is read again.
 *  - A secret that cannot be read, or reads empty, throws and is not cached, so the next call reads again.
 *  - The guest abuse controls, a connector's OAuth client, the image providers' keys and an external
 *    model provider's key all read through it, and none keeps a cache of its own.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SECRET_CACHE_MS, SecretUnavailable, __resetSecretCacheForTests, readCachedSecret } from '../../lambda/src/lib/secret-cache';

const sender = (values: Array<string | Error | undefined>) => {
  const send = jest.fn(async () => {
    const next = values.shift();
    if (next instanceof Error) throw next;
    return { SecretString: next, Parameter: { Value: next } };
  });
  return { send };
};

beforeEach(() => __resetSecretCacheForTests());

describe('one secret cache', () => {
  it('serves a value from the cache for five minutes, then reads it again', async () => {
    const secrets = sender(['v1', 'v2']);
    expect(await readCachedSecret({ secretId: 's' }, { secrets, now: 1_000 })).toBe('v1');
    expect(await readCachedSecret({ secretId: 's' }, { secrets, now: 1_000 + SECRET_CACHE_MS - 1 })).toBe('v1');
    expect(secrets.send).toHaveBeenCalledTimes(1);
    expect(await readCachedSecret({ secretId: 's' }, { secrets, now: 1_000 + SECRET_CACHE_MS })).toBe('v2');
    expect(secrets.send).toHaveBeenCalledTimes(2);
  });

  it('keys a Secrets Manager id and an SSM parameter apart', async () => {
    const secrets = sender(['from-secrets']);
    const ssm = sender(['from-ssm']);
    expect(await readCachedSecret({ secretId: 'x' }, { secrets, ssm, now: 1 })).toBe('from-secrets');
    expect(await readCachedSecret({ parameter: 'x' }, { secrets, ssm, now: 1 })).toBe('from-ssm');
  });

  it('throws for a secret it cannot read or that is empty, and caches neither', async () => {
    const secrets = sender([Object.assign(new Error('denied'), { name: 'AccessDeniedException' }), '', 'v']);
    await expect(readCachedSecret({ secretId: 's' }, { secrets, now: 1 })).rejects.toMatchObject({ reason: 'unreadable', cause: 'AccessDeniedException' });
    await expect(readCachedSecret({ secretId: 's' }, { secrets, now: 2 })).rejects.toBeInstanceOf(SecretUnavailable);
    expect(await readCachedSecret({ secretId: 's' }, { secrets, now: 3 })).toBe('v');
    await expect(readCachedSecret({}, { secrets })).rejects.toMatchObject({ reason: 'unnamed' });
  });

  it('is the one place the four secret readers read through', () => {
    const lib = path.join(__dirname, '..', '..', 'lambda', 'src', 'lib');
    for (const rel of ['guest-abuse.ts', 'connectors/secrets.ts', 'image-gen-models.ts', 'providers/external-llm.ts']) {
      const src = fs.readFileSync(path.join(lib, rel), 'utf8');
      expect({ rel, reads: src.includes('readCachedSecret(') }).toEqual({ rel, reads: true });
      expect({ rel, ownSecretCall: /new GetSecretValueCommand\(/.test(src) }).toEqual({ rel, ownSecretCall: false });
    }
  });
});
