/**
 * The catalog LOADER's absent-versus-broken distinction.
 *
 * The bug: `require(mod)` raising MODULE_NOT_FOUND was read as "the local file is absent". A
 * `context-sources.local.ts` that EXISTS but imports a missing module raises the same code for the
 * INNER module, so the deployer's catalog was skipped, the tracked example was loaded instead, and
 * synth reported success while publishing the example's keys and emitting the example's IAM grants.
 * A silent change to the isolation boundary, reported as a clean deploy.
 *
 * Module access is injected rather than exercised on disk. Writing a real `context-sources.local.ts`
 * cannot test this: resolution is cached per jest worker in BOTH directions (a resolved path keeps
 * resolving after deletion, a failed one keeps failing after creation), and the path is read
 * concurrently by other test files, so such a test asserts against a cache and breaks its neighbours.
 */
import { loadContextSourceCatalog, type ContextSourceEntry } from '../../lib/config/context-sources';

const CTX = {
  classification: 'standard',
  attachmentsBucketArn: 'arn:aws:s3:::b',
  attachmentsBucketName: 'b',
  userProfileTableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/UserProfile',
  userProfileTableName: 'UserProfile',
  region: 'us-east-1',
  account: '123456789012',
};

const LOCAL = './context-sources.local';
const EXAMPLE = './context-sources.example';

/** A valid one-entry catalog module, standing in for whichever file the loader picks. */
const catalogModule = (key: string) => ({
  contextSourceCatalog: (): ContextSourceEntry[] => [{
    key, title: 't', description: 'd', useWhen: 'w',
    type: 'ssm-parameter', arn: 'arn:aws:ssm:us-east-1:1:parameter/p', locator: '/p',
    trust: 'operator', availability: 'always', maxBytes: 100,
    fields: { value: { type: 'string', description: 'v' } },
  }],
});

const absent = (mod: string) => {
  const err = new Error(`Cannot find module '${mod}'`) as NodeJS.ErrnoException;
  err.code = 'MODULE_NOT_FOUND';
  throw err;
};

describe('loadContextSourceCatalog: a broken local file is not an absent one', () => {
  it('THROWS when the local file exists but its own import is missing', () => {
    // The load raises MODULE_NOT_FOUND for the INNER module. Before the fix that was indistinguishable
    // from "no local file" and the loader silently used the example instead.
    expect(() => loadContextSourceCatalog(CTX, {
      resolve: () => '/resolved/context-sources.local.ts', // the file EXISTS
      load: () => absent('./definitely-not-a-real-module'), // its import does not
    })).toThrow(/definitely-not-a-real-module/);
  });

  it('falls back to the example when the local file is genuinely ABSENT', () => {
    // Falsification of the throw above: a loader that raised on every MODULE_NOT_FOUND would break
    // every fresh clone, which is exactly what the original catch existed to protect.
    const loaded = loadContextSourceCatalog(CTX, {
      resolve: (mod) => (mod === LOCAL ? absent(mod) : '/resolved/context-sources.example.ts'),
      load: () => catalogModule('x-from-example'),
    });
    expect(loaded.source).toBe(EXAMPLE);
    expect(loaded.entries.map((e) => e.key)).toEqual(['x-from-example']);
  });

  it('prefers the deployer local file when it loads cleanly', () => {
    const loaded = loadContextSourceCatalog(CTX, {
      resolve: () => '/resolved/context-sources.local.ts',
      load: () => catalogModule('x-from-local'),
    });
    expect(loaded.source).toBe(LOCAL);
    expect(loaded.entries.map((e) => e.key)).toEqual(['x-from-local']);
  });

  it('propagates a SYNTAX error in the local file rather than substituting the example', () => {
    // Same class of fault, different error code: nothing about a broken deployer file may be quietly
    // replaced by the tracked one.
    expect(() => loadContextSourceCatalog(CTX, {
      resolve: () => '/resolved/context-sources.local.ts',
      load: () => { throw new SyntaxError('Unexpected token }'); },
    })).toThrow(/Unexpected token/);
  });

  it('still rejects a file that resolves and loads but exports the wrong shape', () => {
    expect(() => loadContextSourceCatalog(CTX, {
      resolve: () => '/resolved/context-sources.local.ts',
      load: () => ({}),
    })).toThrow(/must export contextSourceCatalog/);
  });
});
