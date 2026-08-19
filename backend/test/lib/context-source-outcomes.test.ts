/**
 * Context source OUTCOMES: the classifier and the CloudWatch signal.
 *
 * This exists because the feature degrades silently on purpose, so its only safety property for an
 * operator is that the degrade is COUNTED and correctly labelled. Two failures in particular must not
 * be confused: `denied` (a boundary refused a read) and `absent` (nobody uploaded the document). One
 * is a security event, the other is a content gap, and before this module both arrived as `null`.
 *
 * So every case here asserts the classifier puts an error in the right bucket AND that it does not put
 * an unrelated error there - a classifier that answered `denied` for everything would satisfy a
 * one-sided test while making the alarm useless.
 */
import {
  classifyAccessError,
  emitContextSourceOutcome,
  ContextSourceAccessError,
  CONTEXT_SOURCE_NAMESPACE,
} from '../../lambda/src/lib/context-source-outcomes';

/** Shaped like an AWS SDK v3 error: the code is the `name`, with `$metadata` alongside. */
function sdkError(name: string, httpStatusCode?: number): Error {
  const err = new Error(`${name}: simulated`);
  err.name = name;
  if (httpStatusCode) (err as unknown as { $metadata: unknown }).$metadata = { httpStatusCode };
  return err;
}

describe('classifyAccessError', () => {
  describe('denied - the outcome an alarm fires on', () => {
    // The SDKs are not consistent about the name, which is exactly how a refusal ends up
    // unrecognised and silently reclassified as a content gap.
    it.each([
      ['S3', 'AccessDenied'],
      ['most services', 'AccessDeniedException'],
      ['KMS on an encrypted object', 'KMSAccessDeniedException'],
      ['Cognito-style', 'NotAuthorizedException'],
      ['EC2-style', 'UnauthorizedOperation'],
    ])('recognises a %s refusal (%s)', (_svc, name) => {
      expect(classifyAccessError(sdkError(name))).toBe('denied');
    });

    it('falls back to the HTTP status when the name is unfamiliar', () => {
      // A service AE does not use today, or a future error code, must still be caught.
      expect(classifyAccessError(sdkError('SomeFutureRefusal', 403))).toBe('denied');
    });
  });

  describe('absent - a content gap, not a security event', () => {
    it.each(['NoSuchKey', 'NoSuchBucket', 'ResourceNotFoundException', 'ParameterNotFound'])(
      'recognises %s',
      (name) => expect(classifyAccessError(sdkError(name))).toBe('absent'),
    );

    it('falls back to a 404', () => {
      expect(classifyAccessError(sdkError('Whatever', 404))).toBe('absent');
    });
  });

  it('recognises a timeout', () => {
    expect(classifyAccessError(sdkError('TimeoutError'))).toBe('timeout');
    expect(classifyAccessError(sdkError('RequestTimeout', 408))).toBe('timeout');
  });

  describe('anything unrecognised is `error`, never `absent`', () => {
    // THE fail-open this classifier exists to close. Guessing "absent" for an unknown error would
    // silently relabel a novel authorisation failure as a missing document - the alarm stays quiet
    // and the log line reads like a configuration gap.
    it.each([
      ['a throttle', sdkError('ThrottlingException', 429)],
      ['a server fault', sdkError('InternalError', 500)],
      ['a plain Error with no SDK shape', new Error('something went wrong')],
      ['a string', 'not an error at all'],
      ['null', null],
      ['undefined', undefined],
    ])('%s classifies as error', (_label, err) => {
      expect(classifyAccessError(err)).toBe('error');
    });

    it('does NOT treat a message that merely mentions denial as a refusal', () => {
      // Matching on the message would let any log text steer the classification. AWS puts the code in
      // `name`; a message is prose.
      const err = new Error('AccessDenied appeared in the response body');
      expect(classifyAccessError(err)).toBe('error');
    });
  });
});

describe('ContextSourceAccessError', () => {
  it('carries the reason and the key through to the resolver', () => {
    const err = new ContextSourceAccessError('denied', 'x-hr-docs', 'refused', new Error('root'));
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('denied');
    expect(err.sourceKey).toBe('x-hr-docs');
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe('emitContextSourceOutcome', () => {
  let logged: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    logged = [];
    spy = jest.spyOn(console, 'log').mockImplementation((line: string) => { logged.push(line); });
  });
  afterEach(() => spy.mockRestore());

  const emitted = () => JSON.parse(logged[0]);

  it('emits parseable EMF in the context source namespace', () => {
    emitContextSourceOutcome({ classification: 'standard', sourceKey: 'x-hr-docs', outcome: 'denied' });
    const doc = emitted();
    expect(doc._aws.CloudWatchMetrics[0].Namespace).toBe(CONTEXT_SOURCE_NAMESPACE);
    expect(doc._aws.CloudWatchMetrics[0].Metrics).toEqual([{ Name: 'ContextSourceFailed', Unit: 'Count' }]);
    expect(doc.ContextSourceFailed).toBe(1);
    expect(doc).toMatchObject({ Classification: 'standard', Outcome: 'denied', SourceKey: 'x-hr-docs' });
  });

  it('offers three dimension sets: the rate rollup, the reason, and the source', () => {
    // The bare Classification rollup is what the failure-RATE alarm divides - failed/(failed+resolved)
    // for the whole classification. Deriving that by summing one series per outcome would go silently
    // wrong the day an outcome is added. The other two are for the human who gets paged: why, and
    // which source.
    emitContextSourceOutcome({ classification: 'premium', sourceKey: 'company-docs', outcome: 'denied' });
    expect(emitted()._aws.CloudWatchMetrics[0].Dimensions).toEqual([
      ['Classification'],
      ['Classification', 'Outcome'],
      ['Classification', 'Outcome', 'SourceKey'],
    ]);
  });

  it.each([
    ['resolved', 'ContextSourceResolved'],
    ['denied', 'ContextSourceFailed'],
    ['absent', 'ContextSourceFailed'],
    ['timeout', 'ContextSourceFailed'],
    ['error', 'ContextSourceFailed'],
    ['not-in-catalog', 'ContextSourceSkipped'],
    ['unavailable', 'ContextSourceSkipped'],
  ] as const)('maps outcome %s to metric %s', (outcome, metric) => {
    emitContextSourceOutcome({ classification: 'standard', sourceKey: 'k', outcome });
    const doc = emitted();
    expect(doc._aws.CloudWatchMetrics[0].Metrics[0].Name).toBe(metric);
    expect(doc[metric]).toBe(1);
  });

  it('keeps every outcome on ONE metric name per disposition, so an alarm is a filter', () => {
    // If failures fanned out across several metric names, an operator would have to know the full set
    // to alarm on "anything failed" - and would miss whichever one was added last.
    const names = new Set<string>();
    for (const outcome of ['denied', 'absent', 'timeout', 'error'] as const) {
      logged = [];
      emitContextSourceOutcome({ classification: 'standard', sourceKey: 'k', outcome });
      names.add(emitted()._aws.CloudWatchMetrics[0].Metrics[0].Name);
    }
    expect([...names]).toEqual(['ContextSourceFailed']);
  });
});
