/**
 * Context source readers (SPEC-CONTEXT-SOURCES-AND-STORES phase 5).
 *
 * These do the I/O the resolver deliberately does not. The cases that matter are the DEGRADE paths:
 * a reader that throws on an absent object, or invents an identity it was not given, converts a
 * missing section into a broken turn or a leak.
 */
import { createSourceReader } from '../../lambda/src/lib/context-source-readers';
import type { PublishedContextSource } from '../../lambda/src/lib/context-sources-runtime';

const CTX = { classification: 'standard', userSub: 'user-123' };

/**
 * Shaped like a real AWS SDK v3 error: the service's CODE is the error `name`, with `$metadata`
 * alongside. A test double that only put the code in the message would exercise a classifier path the
 * SDK never takes.
 */
function sdkError(name: string, httpStatusCode?: number): Error {
  const err = new Error(`${name}: simulated`);
  err.name = name;
  if (httpStatusCode) (err as unknown as { $metadata: unknown }).$metadata = { httpStatusCode };
  return err;
}

function s3Source(over: Partial<PublishedContextSource> = {}): PublishedContextSource {
  return {
    key: 'company-docs',
    title: 'Company knowledge',
    description: 'd',
    useWhen: 'w',
    type: 's3-prefix',
    // Locator and prefix come from the PUBLISHED entry now - the reader no longer holds a resource map.
    locator: 'ctx-bucket',
    prefix: 'context/standard/',
    trust: 'operator',
    availability: 'always',
    maxBytes: 16384,
    fields: { digest: { type: 'string', from: '_digest.json', description: 'menu' } },
    ...over,
  };
}

function ddbSource(over: Partial<PublishedContextSource> = {}): PublishedContextSource {
  return {
    ...s3Source(),
    key: 'user-profile',
    type: 'dynamodb-table',
    locator: 'UserProfile',
    prefix: undefined,
    trust: 'platform',
    availability: 'identity-settled',
    maxBytes: 4096,
    fields: {
      displayName: { type: 'string', description: 'name' },
      company: { type: 'string', optional: true, description: 'employer' },
    },
    ...over,
  };
}

/** A minimal S3 double whose `send` is typed, so the key assertions below compile. */
const s3With = (body: string) => ({
  send: jest.fn(async (_cmd: { input: { Bucket: string; Key: string } }) => (
    { Body: { transformToString: async () => body } }
  )),
});

describe('s3-prefix reader', () => {
  it('reads the object named by `from`, under the classification prefix', async () => {
    const s3 = s3With('{"digest":"Employee directory: staff and team leads"}');
    const read = createSourceReader(CTX, { s3: s3 as never });
    const values = await read(s3Source());
    expect(values).toEqual({ digest: 'Employee directory: staff and team leads' });
    // The prefix is the isolation boundary, so the key must carry the classification.
    const sent = s3.send.mock.calls[0][0];
    expect(sent.input).toMatchObject({ Bucket: 'ctx-bucket', Key: 'context/standard/_digest.json' });
  });

  it('falls back to `{field}.json` when the entry declares no `from`', async () => {
    const s3 = s3With('plain text body');
    const read = createSourceReader(CTX, { s3: s3 as never });
    await read(s3Source({ fields: { notes: { type: 'string', description: 'n' } } }));
    expect(s3.send.mock.calls[0][0].input.Key)
      .toBe('context/standard/notes.json');
  });

  it('accepts a non-JSON body as the value directly', async () => {
    const s3 = s3With('a plain digest line');
    const read = createSourceReader(CTX, { s3: s3 as never });
    expect(await read(s3Source())).toEqual({ digest: 'a plain digest line' });
  });

  it('omits a field whose object is ABSENT instead of failing the source', async () => {
    // A missing digest is a source with nothing to say. Throwing here would cost the whole turn's
    // other sections for one absent object.
    const s3 = { send: jest.fn(async () => { throw sdkError('NoSuchKey'); }) };
    const read = createSourceReader(CTX, { s3: s3 as never });
    expect(await read(s3Source())).toBeNull();
  });

  it('an entry with no locator is a CONFIG fault, raised rather than read as empty', async () => {
    // Silently returning null here made a malformed catalog entry look like an empty document.
    const read = createSourceReader(CTX, { s3: s3With('{}') as never });
    await expect(read(s3Source({ locator: undefined }))).rejects.toMatchObject({ reason: 'error' });
  });

  // THE FAIL-OPEN THIS CLOSES. A bare `catch {}` around the GetObject turned every failure into the
  // same empty result, so an IAM refusal - the one failure that can mean a boundary was tested -
  // produced no log line, no metric, and no difference from a document nobody had uploaded.
  describe('an authorisation refusal is never swallowed', () => {
    it('fails the source with reason `denied`, not silently', async () => {
      const s3 = { send: jest.fn(async () => { throw sdkError('AccessDenied', 403); }) };
      const read = createSourceReader(CTX, { s3: s3 as never });
      await expect(read(s3Source())).rejects.toMatchObject({
        reason: 'denied',
        sourceKey: 'company-docs',
      });
    });

    it('fails the WHOLE source even when other fields read fine', async () => {
      // Partial resolution under a partial denial is the misleading case: the section renders, the
      // turn looks healthy, and one refused document is invisible. A refusal is a fact about the
      // grant, so it takes the source with it.
      const s3 = {
        send: jest.fn(async (cmd: { input: { Key: string } }) => {
          if (cmd.input.Key.endsWith('policies.json')) throw sdkError('AccessDenied', 403);
          return { Body: { transformToString: async () => 'fine' } };
        }),
      };
      const read = createSourceReader(CTX, { s3: s3 as never });
      await expect(read(s3Source({
        fields: {
          notes: { type: 'string', description: 'n' },
          policies: { type: 'string', description: 'p' },
        },
      }))).rejects.toMatchObject({ reason: 'denied' });
    });

    it('a NON-refusal on one field still yields the others', async () => {
      // Falsification of the rule above: if every classified failure failed the source, this would
      // throw too, and a transient throttle would cost context it did not need to.
      const s3 = {
        send: jest.fn(async (cmd: { input: { Key: string } }) => {
          if (cmd.input.Key.endsWith('policies.json')) throw sdkError('ThrottlingException', 429);
          return { Body: { transformToString: async () => 'kept' } };
        }),
      };
      const read = createSourceReader(CTX, { s3: s3 as never });
      expect(await read(s3Source({
        fields: {
          notes: { type: 'string', description: 'n' },
          policies: { type: 'string', description: 'p' },
        },
      }))).toEqual({ notes: 'kept' });
    });

    it('counts the field-level failure it continued past, on its OWN metric', async () => {
      // Continuing is only acceptable because the failure is still measured. Without this the
      // throttle case above would be a silent partial read.
      //
      // It is `ContextSourceFieldFailed`, NOT `ContextSourceFailed`: the source may still resolve
      // from its other fields, and counting a field hiccup as a source failure would put the same
      // source on both sides of the failure-rate ratio.
      const emitted: string[] = [];
      const spy = jest.spyOn(console, 'log').mockImplementation((l: string) => { emitted.push(l); });
      try {
        const s3 = { send: jest.fn(async () => { throw sdkError('ThrottlingException', 429); }) };
        await createSourceReader(CTX, { s3: s3 as never })(s3Source());
        const docs = emitted.map((l) => JSON.parse(l));
        expect(docs.find((d) => d.ContextSourceFieldFailed === 1)).toMatchObject({
          Classification: 'standard', SourceKey: 'company-docs', Outcome: 'error', Field: 'digest',
        });
        expect(docs.some((d) => d.ContextSourceFailed !== undefined)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // THE REGRESSION TEST. The reader used to hardcode `context/{classification}/` because the published
  // catalog stripped `prefix`, so an entry granted against `resumes/standard/` was READ from
  // `context/standard/` - the IAM grant and the actual read naming different locations. A per-team
  // prefix is the whole point of per-source boundaries, so assert the read follows the entry.
  it('reads from the ENTRY prefix, not a hardcoded corpus path', async () => {
    const s3 = s3With('{"headline":"Staff Engineer"}');
    const read = createSourceReader(CTX, { s3: s3 as never });
    const values = await read(s3Source({
      key: 'x-resume',
      locator: 'hr-team-bucket',
      prefix: 'resumes/standard/',
      fields: { headline: { type: 'string', from: 'me.json', description: 'top line' } },
    }));

    expect(values).toEqual({ headline: 'Staff Engineer' });
    expect(s3.send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'hr-team-bucket',              // the team's own bucket, not the corpus bucket
      Key: 'resumes/standard/me.json',       // the granted prefix, not context/standard/
    });
  });

  it('handles an entry with no prefix (the whole bucket is the source)', async () => {
    const s3 = s3With('value');
    const read = createSourceReader(CTX, { s3: s3 as never });
    await read(s3Source({ prefix: undefined, fields: { notes: { type: 'string', description: 'n' } } }));
    expect(s3.send.mock.calls[0][0].input.Key).toBe('notes.json');
  });
});

describe('dynamodb-table reader', () => {
  const ddbWith = (item: Record<string, unknown> | undefined) => ({
    send: jest.fn(async () => ({ Item: item })),
  });

  it('projects only the DECLARED fields, keyed by the caller', async () => {
    const ddb = ddbWith({
      userSub: { S: 'user-123' },
      displayName: { S: 'Priya' },
      company: { S: 'Stratum' },
      // Present on the item but NOT declared in the catalog: must not reach the prompt.
      internalNotes: { S: 'do not surface' },
    });
    const read = createSourceReader(CTX, { ddb: ddb as never });
    const values = await read(ddbSource());
    expect(values).toEqual({ displayName: 'Priya', company: 'Stratum' });
    expect(JSON.stringify(values)).not.toContain('do not surface');
  });

  it('REFUSES to read without a caller identity, rather than inventing one', async () => {
    // availability:identity-settled should already have prevented this; the reader is the second
    // line, because a per-user source resolved for "whoever" is a cross-user leak.
    const ddb = ddbWith({ displayName: { S: 'Priya' } });
    const read = createSourceReader({ classification: 'standard' }, { ddb: ddb as never });
    expect(await read(ddbSource())).toBeNull();
    expect(ddb.send).not.toHaveBeenCalled();
  });

  it('returns null when the user has no profile row', async () => {
    const read = createSourceReader(CTX, { ddb: ddbWith(undefined) as never });
    expect(await read(ddbSource())).toBeNull();
  });

  it('reads a numeric attribute as its string form', async () => {
    const ddb = ddbWith({ displayName: { S: 'Priya' }, company: { N: '42' } });
    const read = createSourceReader(CTX, { ddb: ddb as never });
    expect(await read(ddbSource())).toEqual({ displayName: 'Priya', company: '42' });
  });
});

describe('unknown type', () => {
  it('reads nothing rather than guessing, and says so as a failure', async () => {
    // A published type this build cannot read means the stack and the Lambda are at different
    // versions. Returning null would have made a deploy skew look like an empty document.
    const read = createSourceReader(CTX, {});
    await expect(read(s3Source({ type: 'quantum-entangled' })))
      .rejects.toMatchObject({ reason: 'error' });
  });
});

describe('the other readers classify their failures too', () => {
  // Each of these used to let the raw SDK error propagate, which the resolver counted as a generic
  // `error` - so a refusal on the per-user table was indistinguishable from a malformed response.
  it('dynamodb-table surfaces a refusal as `denied`', async () => {
    const ddb = { send: jest.fn(async () => { throw sdkError('AccessDeniedException', 403); }) };
    const read = createSourceReader(CTX, { ddb: ddb as never });
    await expect(read(ddbSource())).rejects.toMatchObject({ reason: 'denied', sourceKey: 'user-profile' });
  });

  it('ssm-parameter surfaces an absent parameter as `absent`, not as a refusal', async () => {
    const ssm = { send: jest.fn(async () => { throw sdkError('ParameterNotFound'); }) };
    const read = createSourceReader(CTX, { ssm: ssm as never });
    await expect(read(ddbSource({ key: 'x-policy', type: 'ssm-parameter', locator: '/p' })))
      .rejects.toMatchObject({ reason: 'absent' });
  });

  it('lambda-service surfaces a refusal as `denied`', async () => {
    const lambda = { send: jest.fn(async () => { throw sdkError('AccessDeniedException', 403); }) };
    const read = createSourceReader(CTX, { lambda: lambda as never });
    await expect(read(ddbSource({ key: 'x-crm', type: 'lambda-service', locator: 'fn' })))
      .rejects.toMatchObject({ reason: 'denied' });
  });
});
