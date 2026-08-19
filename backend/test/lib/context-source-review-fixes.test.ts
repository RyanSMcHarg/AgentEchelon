/**
 * Regression tests for the code-review findings on the context source catalog.
 *
 * Each one is a case where something was published, granted, or documented and then could not work.
 * They are grouped here rather than scattered so the shape stays visible: every one of them was a
 * guard, a grant, or a signal that LOOKED present and was not.
 */
import {
  readPublishedCatalog,
  renderSourceSection,
  type PublishedContextSource,
} from '../../lambda/src/lib/context-sources-runtime';
import { createSourceReader } from '../../lambda/src/lib/context-source-readers';
import { contextSourceGrant } from '../../lib/config/context-sources';
import { loadContextSourceCatalog } from '../../lib/config/context-sources';
import * as fs from 'fs';
import * as path from 'path';

const GEN_CTX = {
  classification: 'standard',
  attachmentsBucketArn: 'arn:aws:s3:::b',
  attachmentsBucketName: 'b',
  userProfileTableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/UserProfile',
  userProfileTableName: 'UserProfile',
  region: 'us-east-1',
  account: '123456789012',
};

function sdkError(name: string, httpStatusCode?: number): Error {
  const err = new Error(`${name}: simulated`);
  err.name = name;
  if (httpStatusCode) (err as unknown as { $metadata: unknown }).$metadata = { httpStatusCode };
  return err;
}

function source(over: Partial<PublishedContextSource> = {}): PublishedContextSource {
  return {
    key: 'user-profile',
    title: 'About this person',
    description: 'Who they are',
    useWhen: 'Personalising',
    type: 'dynamodb-table',
    locator: 'UserProfile',
    trust: 'platform',
    availability: 'identity-settled',
    maxBytes: 4096,
    fields: { displayName: { type: 'string', description: 'name' } },
    ...over,
  };
}

describe('a DENIED catalog read is not silently an empty catalog', () => {
  // The failure this closes: AccessDenied on the catalog parameter used to return null, which made
  // every selected key count `not-in-catalog` - a SKIP. The failure-rate alarm divides Failed by
  // Failed+Resolved, so it stayed at zero while nothing worked, and the dashboard blamed the profile
  // for an IAM fault. The `(catalog)` handler can only classify what reaches it.
  it('propagates AccessDenied instead of reporting no sources', async () => {
    await expect(readPublishedCatalog(async () => { throw sdkError('AccessDeniedException', 403); }))
      .rejects.toMatchObject({ name: 'AccessDeniedException' });
  });

  it('still treats an ABSENT parameter as no sources, which is the normal state', async () => {
    // Falsification of the rule above: if every error propagated, a deployment that has configured no
    // context sources would fail its turns.
    await expect(readPublishedCatalog(async () => { throw sdkError('ParameterNotFound'); }))
      .resolves.toEqual([]);
  });

  it('parses a published catalog when the read succeeds', async () => {
    const got = await readPublishedCatalog(async () => JSON.stringify([source()]));
    expect(got.map((e) => e.key)).toEqual(['user-profile']);
  });
});

describe('dotted `from` paths reach nested records', () => {
  // The built-in profile store writes `{ userSub, onboardedAt, facts: {…} }`, so a catalog that could
  // only name top-level attributes read nothing. The shipped `user-profile` entry declared `company`
  // and `role`, found neither, and resolved to absent on every turn for every user.
  const item = {
    userSub: { S: 'user-123' },
    onboardedAt: { S: '2026-01-01' },
    facts: { M: { name: { S: 'Priya' }, company: { S: 'Stratum' }, headcount: { N: '42' } } },
  };
  const ddb = () => ({ send: jest.fn(async () => ({ Item: item })) });

  it('reads a value nested under `facts`', async () => {
    const read = createSourceReader({ classification: 'standard', userSub: 'user-123' }, { ddb: ddb() as never });
    const values = await read(source({
      fields: {
        displayName: { type: 'string', from: 'facts.name', description: 'name' },
        company: { type: 'string', from: 'facts.company', description: 'employer' },
      },
    }));
    expect(values).toEqual({ displayName: 'Priya', company: 'Stratum' });
  });

  it('still reads a TOP-LEVEL attribute, so existing catalogs keep working', async () => {
    const read = createSourceReader({ classification: 'standard', userSub: 'user-123' }, { ddb: ddb() as never });
    const values = await read(source({
      fields: { onboardedAt: { type: 'string', description: 'when' } },
    }));
    expect(values).toEqual({ onboardedAt: '2026-01-01' });
  });

  it('yields nothing for a path that runs into a scalar or a missing key', async () => {
    // A mistyped path must read as an absent field, never as a wrong value.
    const read = createSourceReader({ classification: 'standard', userSub: 'user-123' }, { ddb: ddb() as never });
    expect(await read(source({
      fields: { displayName: { type: 'string', from: 'userSub.nope', description: 'x' } },
    }))).toBeNull();
    expect(await read(source({
      fields: { displayName: { type: 'string', from: 'facts.absent', description: 'x' } },
    }))).toBeNull();
  });
});

describe('the shipped example catalog can actually resolve', () => {
  it('reads user-profile fields from where the built-in store writes them', () => {
    // The entry used to declare top-level displayName/company/role. Nothing writes those, so the
    // source could never satisfy its own reserved contract on a stock deployment.
    const entry = loadContextSourceCatalog(GEN_CTX).entries.find((e) => e.key === 'user-profile');
    expect(entry).toBeDefined();
    for (const [name, spec] of Object.entries(entry!.fields)) {
      expect(`${name}: ${spec.from ?? '(none)'}`).toMatch(/facts\./);
    }
  });
});

describe('maxBytes caps the SOURCE, not each field', () => {
  // The field doc calls it "a cap on the resolved value, so one source cannot push the persona out of
  // the prompt". Applied per field, a source with N fields could contribute N times that bound.
  const wide = source({
    maxBytes: 20,
    fields: {
      a: { type: 'string', description: 'a' },
      b: { type: 'string', description: 'b' },
      c: { type: 'string', description: 'c' },
    },
  });

  it('spends one budget across every field', () => {
    const out = renderSourceSection({
      entry: wide,
      values: { a: 'x'.repeat(50), b: 'y'.repeat(50), c: 'z'.repeat(50) },
    });
    const payload = out.split('\n').filter((l) => /^[abc]: /.test(l)).join('');
    // Three fields x 20 would be 60 before this fix. Allow for the truncation marker's own text.
    expect(payload.replace(/\[truncated at \d+ characters\]/g, '').replace(/^[abc]: /gm, '').length)
      .toBeLessThanOrEqual(wide.maxBytes);
  });

  it('spends it in DECLARATION order, so the first fields survive a squeeze', () => {
    const out = renderSourceSection({
      entry: wide,
      values: { a: 'A'.repeat(50), b: 'B'.repeat(50), c: 'C'.repeat(50) },
    });
    expect(out).toContain('A');
    expect(out).not.toContain('C'.repeat(5));
  });

  it('does not truncate a source that fits', () => {
    // Falsification: a renderer that always truncated would satisfy the cap and destroy the feature.
    const out = renderSourceSection({ entry: wide, values: { a: 'short', b: 'also', c: 'fine' } });
    expect(out).toContain('a: short');
    expect(out).toContain('c: fine');
    expect(out).not.toContain('truncated');
  });
});

describe('the s3-prefix grant does not claim a permission it cannot use', () => {
  it('grants object reads on the prefix and NOT bucket-level ListBucket', () => {
    // `s3:ListBucket` is a BUCKET-level action. Granted on an object ARN it authorizes nothing at all,
    // while reading as present in a policy review - and it would deny the moment a reader listed.
    const [statement, ...rest] = contextSourceGrant({
      key: 'company-docs', title: 't', description: 'd', useWhen: 'w',
      type: 's3-prefix', arn: 'arn:aws:s3:::b', locator: 'b', prefix: 'context/standard/',
      trust: 'operator', availability: 'always', maxBytes: 10,
      fields: { digest: { type: 'string', description: 'm' } },
    });
    expect(rest).toEqual([]);
    expect(statement.actions).toEqual(['s3:GetObject']);
    expect(statement.actions).not.toContain('s3:ListBucket');
    expect(statement.resources).toEqual(['arn:aws:s3:::b/context/standard/*']);
  });

  it('returns a LIST, so a type needing two statement shapes can express both', () => {
    const grants = contextSourceGrant({
      key: 'user-profile', title: 't', description: 'd', useWhen: 'w',
      type: 'dynamodb-table', arn: 'arn:aws:dynamodb:us-east-1:1:table/T', locator: 'T',
      trust: 'platform', availability: 'identity-settled', maxBytes: 10,
      fields: { displayName: { type: 'string', description: 'n' } },
    });
    expect(Array.isArray(grants)).toBe(true);
    expect(grants[0].resources).toEqual(['arn:aws:dynamodb:us-east-1:1:table/T']);
  });
});

describe('a field failure inside a resolving source stays OUT of the rate', () => {
  // The failure-rate alarm divides Failed by Failed+Resolved. Counting a per-field hiccup as a SOURCE
  // failure put the same source on both sides of that ratio, so the percentage stopped meaning
  // sources-failed over sources-attempted.
  let emitted: Array<Record<string, unknown>>;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    emitted = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
      try { emitted.push(JSON.parse(line)); } catch { /* not EMF */ }
    });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { logSpy.mockRestore(); warnSpy.mockRestore(); });

  const s3Source = (): PublishedContextSource => ({
    key: 'company-docs', title: 't', description: 'd', useWhen: 'w',
    type: 's3-prefix', locator: 'b', prefix: 'context/standard/',
    trust: 'operator', availability: 'always', maxBytes: 4096,
    fields: {
      notes: { type: 'string', description: 'n' },
      policies: { type: 'string', description: 'p' },
    },
  });

  it('counts it on its OWN metric, never ContextSourceFailed', async () => {
    const s3 = {
      send: jest.fn(async (cmd: { input: { Key: string } }) => {
        if (cmd.input.Key.endsWith('policies.json')) throw sdkError('ThrottlingException', 429);
        return { Body: { transformToString: async () => 'kept' } };
      }),
    };
    const read = createSourceReader({ classification: 'standard' }, { s3: s3 as never });
    expect(await read(s3Source())).toEqual({ notes: 'kept' });

    const metric = emitted.find((d) => d.SourceKey === 'company-docs');
    expect(metric).toMatchObject({ ContextSourceFieldFailed: 1, Outcome: 'error', Field: 'policies' });
    // The assertion that matters: nothing on this path may inflate the rate's numerator.
    expect(emitted.some((d) => d.ContextSourceFailed !== undefined)).toBe(false);
  });

  it('keeps the failing FIELD out of the DIMENSIONS, so cardinality stays bounded', async () => {
    // Field names are per-source; as a dimension they would multiply the metric count for a value
    // only useful once you are already reading the log line. It rides as a property instead.
    const s3 = { send: jest.fn(async () => { throw sdkError('ThrottlingException', 429); }) };
    await createSourceReader({ classification: 'standard' }, { s3: s3 as never })(s3Source());

    const metric = emitted.find((d) => d.ContextSourceFieldFailed === 1);
    expect(metric).toBeDefined();
    const dimensionSets = (metric!._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][] }> })
      .CloudWatchMetrics[0].Dimensions;
    expect(dimensionSets.flat()).not.toContain('Field');
    // Every field failed here, so one metric per field, each naming its own as a PROPERTY.
    expect(emitted.filter((d) => d.ContextSourceFieldFailed === 1).map((d) => d.Field))
      .toEqual(['notes', 'policies']);
  });
});
