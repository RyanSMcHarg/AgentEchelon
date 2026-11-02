/**
 * A corpus object whose ingest fails is retried, kept, recovered by the next sync, and reported by validate.
 *
 * DocumentIngestion runs on the S3 notification, an asynchronous invoke. An invoke that timed out left the object in
 * S3 with no chunks, nothing retried it into a record anyone would read, and every phase reported success because a
 * put returns before ingestion runs. Four pieces close it:
 *   (a) the invoke retries a failed record and keeps the event in a dead-letter queue with an alarm;
 *   (b) the sync asks the database which keys hold chunks (`ragSourceCoverage` on the data plane) and re-puts the
 *       ones that hold none;
 *   (c) `--verify` (the knowledge-rag validate phase) waits, bounded, until every synced key is ingested.
 */
const mockS3Send = jest.fn();
const mockBedrockSend = jest.fn();
const mockDbQuery = jest.fn();
const mockAssumedRoles: string[] = [];

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn().mockImplementation((args) => ({ __type: 'GetObject', input: args })),
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn().mockImplementation((args) => ({ __type: 'InvokeModel', input: args })),
}));
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: mockDbQuery, getClient: jest.fn(), ensureSchema: jest.fn() }));
jest.mock('../../lambda/src/analytics-aurora/classification-boundary', () => ({
  withWriterRole: jest.fn(async (fn: (c: unknown) => unknown) => {
    mockAssumedRoles.push('ae_writer');
    return fn({ query: mockDbQuery });
  }),
  withReaderRole: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';

const { planRagSync, unsettledKeys, waitForIngest, coverageMap, CONTENT_HASH_METADATA } = require('../../scripts/lib/rag-sync-plan.cjs');

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockReset();
  mockAssumedRoles.length = 0;
});

const record = (key: string, etag = 'e1') => ({ s3: { bucket: { name: 'archive' }, object: { key, eTag: `"${etag}"` } } });

describe('(a) a failed ingest fails the invocation, so the asynchronous invoke retries it and keeps it', () => {
  it('throws after processing every record when one record failed, naming it', async () => {
    const { handler } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    // rag/a.md: the read fails. rag/b.md: already current, skipped.
    mockDbQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: String(params[0]).endsWith('b.md') ? '1' : '0' }] };
      return { rows: [], rowCount: 0 };
    });
    mockS3Send.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handler({ Records: [record('rag/x/a.md'), record('rag/x/b.md')] } as never)).rejects.toThrow('1 record(s) not ingested: rag/x/a.md');
    err.mockRestore();
    // The second record was still processed.
    expect(mockDbQuery.mock.calls.filter(([sql]) => String(sql).includes('SELECT COUNT(*)'))).toHaveLength(2);
  });

  it('throws when no chunk of an object embedded, since nothing of it is retrievable', async () => {
    const { handler } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }).mockResolvedValue({ rows: [], rowCount: 0 });
    mockS3Send.mockResolvedValueOnce({ Body: { transformToString: async () => 'some text' } });
    mockBedrockSend.mockRejectedValue(new Error('no route to bedrock'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(handler({ Records: [record('rag/x/c.md')] } as never)).rejects.toThrow('rag/x/c.md');
    warn.mockRestore();
    mockBedrockSend.mockReset();
  });

  it('returns normally when every record ingested or was current', async () => {
    const { handler } = await import('../../lambda/src/analytics-aurora/document-ingestion');
    mockDbQuery.mockResolvedValue({ rows: [{ count: '1' }] });
    await expect(handler({ Records: [record('rag/x/d.md')] } as never)).resolves.toEqual({
      ingested: [expect.objectContaining({ skippedReason: 'unchanged_etag' })],
    });
  });

  describe('the stack', () => {
    type Res = { Type: string; Properties: Record<string, unknown> };
    let resources: Record<string, Res>;
    let retry: { retryAttempts: number; maxEventAgeHours: number; dlqRetentionDays: number };

    beforeAll(async () => {
      const cdk = await import('aws-cdk-lib');
      const { Template } = await import('aws-cdk-lib/assertions');
      const { ArchiveStackAurora, DOCUMENT_INGESTION_RETRY } = await import('../../lib/stacks/archive-stack-aurora');
      const { testMessageStream } = await import('../helpers/synth');
      retry = DOCUMENT_INGESTION_RETRY;
      const app = new cdk.App();
      const stack = new ArchiveStackAurora(app, 'TestIngestRetry', {
        env: { account: '123456789012', region: 'us-east-1' },
        appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
        messageStream: testMessageStream(app),
        userPoolId: 'us-east-1_TestPoolId',
      } as never);
      resources = (Template.fromStack(stack).toJSON() as { Resources: Record<string, Res> }).Resources;
    });

    const ofType = (t: string) => Object.entries(resources).filter(([, r]) => r.Type === t);
    const ingestionId = () => ofType('AWS::Lambda::Function').map(([id]) => id).find((id) => id.startsWith('DocumentIngestionLambda'))!;
    const dlqId = () => ofType('AWS::SQS::Queue').map(([id]) => id).find((id) => id.startsWith('DocumentIngestionDlq'))!;

    it('retries a failed invoke a bounded number of times, for a bounded age, then sends it to the dead-letter queue', () => {
      const config = ofType('AWS::Lambda::EventInvokeConfig').find(([, r]) => JSON.stringify(r.Properties.FunctionName).includes(ingestionId()));
      expect(config).toBeDefined();
      const props = config![1].Properties;
      expect(props.MaximumRetryAttempts).toBe(retry.retryAttempts);
      expect(props.MaximumEventAgeInSeconds).toBe(retry.maxEventAgeHours * 3600);
      expect(JSON.stringify(props.DestinationConfig)).toContain(dlqId());
    });

    it('keeps the queue encrypted for its retention, and the function may send to it', () => {
      const q = resources[dlqId()].Properties;
      expect(q.MessageRetentionPeriod).toBe(retry.dlqRetentionDays * 86400);
      expect(q.SqsManagedSseEnabled).toBe(true);
      const sends = ofType('AWS::IAM::Policy').some(([, r]) => JSON.stringify(r.Properties).includes('sqs:SendMessage') && JSON.stringify(r.Properties).includes(dlqId()));
      expect(sends).toBe(true);
    });

    it('alarms on a kept event', () => {
      const alarm = ofType('AWS::CloudWatch::Alarm').find(([id]) => id.startsWith('DocumentIngestionDlqAlarm'));
      expect(alarm).toBeDefined();
      const p = alarm![1].Properties;
      expect(p.MetricName).toBe('ApproximateNumberOfMessagesVisible');
      expect(JSON.stringify(p.Dimensions)).toContain(dlqId());
      expect(p.Threshold).toBe(0);
      expect(p.ComparisonOperator).toBe('GreaterThanThreshold');
    });

    it('alarms on the de-identified copy only after two empty days, so a daily run that lands past the edge of one window pages no one', () => {
      const alarm = ofType('AWS::CloudWatch::Alarm').find(([id]) => id.startsWith('CleanCopyNeverStartedAlarm'));
      expect(alarm).toBeDefined();
      const p = alarm![1].Properties;
      expect(p.Period).toBe(86400);
      expect([p.EvaluationPeriods, p.DatapointsToAlarm]).toEqual([2, 2]);
      expect(p.TreatMissingData).toBe('breaching');
    });

    describe('a deployment starts its de-identified copy at deploy', () => {
      const batchId = () => ofType('AWS::Lambda::Function').map(([id]) => id).find((id) => id.startsWith('CleanCopyBatchFunction'))!;
      const firstRun = () => ofType('Custom::AWS').find(([id]) => id.startsWith('CleanCopyFirstRun'))!;

      it('invokes the batch function asynchronously on create and on update', () => {
        expect(firstRun()).toBeDefined();
        for (const phase of ['Create', 'Update'] as const) {
          const raw = JSON.stringify(firstRun()[1].Properties[phase]);
          expect(raw).toContain('\\"service\\":\\"Lambda\\"');
          expect(raw).toContain('\\"action\\":\\"invoke\\"');
          expect(raw).toContain('\\"InvocationType\\":\\"Event\\"');
          // The function it names is the batch, by reference, so a replaced function is a changed property.
          expect(raw).toContain(`{"Ref":"${batchId()}"}`);
        }
      });

      it('may invoke that one function and nothing else', () => {
        const policies = ofType('AWS::IAM::Policy').filter(([id]) => id.startsWith('CleanCopyFirstRunCustomResourcePolicy'));
        expect(policies).toHaveLength(1);
        const statements = (policies[0][1].Properties.PolicyDocument as { Statement: Array<{ Action: unknown; Resource: unknown; Effect: string }> }).Statement;
        expect(statements).toEqual([
          { Action: 'lambda:InvokeFunction', Effect: 'Allow', Resource: { 'Fn::GetAtt': [batchId(), 'Arn'] } },
        ]);
      });

      it('creates the never-started alarm after the first run is asked for', () => {
        const alarm = ofType('AWS::CloudWatch::Alarm').find(([id]) => id.startsWith('CleanCopyNeverStartedAlarm'))!;
        const dependsOn = (alarm[1] as unknown as { DependsOn?: string[] }).DependsOn ?? [];
        expect(dependsOn.some((d) => d.startsWith('CleanCopyFirstRun'))).toBe(true);
      });
    });
  });
});

describe('(b) the database says which corpus objects hold chunks', () => {
  it('counts per source under the prefix, as the write role, with the prefix taken literally', async () => {
    const { ragSourceCoverage } = await import('../../lambda/src/analytics-aurora/rag-coverage');
    mockDbQuery.mockResolvedValueOnce({ rows: [{ source_id: 's3://archive/rag/a_b/x.md', chunks: '4', etag: 'e1' }] });
    const out = await ragSourceCoverage({ bucket: 'archive', prefix: 'rag/a_b/' });
    expect(out).toEqual({ sources: [{ key: 'rag/a_b/x.md', chunks: 4, etag: 'e1' }] });
    expect(mockAssumedRoles).toEqual(['ae_writer']);
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toContain("LIKE $1 ESCAPE '\\'");
    expect(params).toEqual(['s3://archive/rag/a\\_b/%']);
  });

  it('refuses a prefix outside rag/ and a malformed bucket', async () => {
    const { ragSourceCoverage } = await import('../../lambda/src/analytics-aurora/rag-coverage');
    await expect(ragSourceCoverage({ bucket: 'archive', prefix: 'conversations/' })).rejects.toThrow('under rag/');
    await expect(ragSourceCoverage({ bucket: 'a/b', prefix: 'rag/' })).rejects.toThrow('bucket');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('is an op on the existing data-plane seam', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../lambda/src/analytics-aurora/data-plane-handler.ts'), 'utf8');
    expect(src).toContain("| 'ragSourceCoverage'");
    expect(src).toMatch(/case 'ragSourceCoverage':\s+return ragSourceCoverage\(/);
  });

  it('puts what is new, changed, or not ingested, and leaves an ingested key alone', () => {
    const corpus = [
      { key: 'rag/new.md', sha256: 'h1' },
      { key: 'rag/changed.md', sha256: 'h2' },
      { key: 'rag/lost.md', sha256: 'h3' },
      { key: 'rag/stale.md', sha256: 'h4' },
      { key: 'rag/fine.md', sha256: 'h5' },
    ];
    const heads = new Map([
      ['rag/changed.md', { sha256: 'old', etag: '"e2"' }],
      ['rag/lost.md', { sha256: 'h3', etag: '"e3"' }],
      ['rag/stale.md', { sha256: 'h4', etag: '"e4"' }],
      ['rag/fine.md', { sha256: 'h5', etag: '"e5"' }],
    ]);
    const coverage = coverageMap({ sources: [{ key: 'rag/stale.md', chunks: 2, etag: 'e-old' }, { key: 'rag/fine.md', chunks: 3, etag: 'e5' }] });
    expect(planRagSync({ corpus, heads, coverage })).toEqual({
      put: [
        { key: 'rag/new.md', reason: 'new' },
        { key: 'rag/changed.md', reason: 'changed' },
        { key: 'rag/lost.md', reason: 'no-chunks' },
        { key: 'rag/stale.md', reason: 'stale-chunks' },
      ],
      unchanged: ['rag/fine.md'],
    });
  });

  it('puts every unchanged key when the database could not be asked', () => {
    const plan = planRagSync({ corpus: [{ key: 'k', sha256: 'h' }], heads: new Map([['k', { sha256: 'h', etag: 'e' }]]), coverage: null });
    expect(plan.put).toEqual([{ key: 'k', reason: 'coverage-unknown' }]);
  });

  it('the sync writes the content hash it compares against, and offers a dry run', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../scripts/sync-project-knowledge.mjs'), 'utf8');
    expect(CONTENT_HASH_METADATA).toBe('content-sha256');
    expect(src).toContain('Metadata: { [CONTENT_HASH_METADATA]: sha256 }');
    expect(src).toContain("'ragSourceCoverage', { bucket, prefix: PREFIX }");
    expect(src).toMatch(/if \(dryRun\) \{[\s\S]*?nothing written to S3[\s\S]*?return;/);
  });
});

describe('(c) validate fails until every synced key is ingested', () => {
  it('a key is settled only with chunks at the ETag S3 holds now', () => {
    const coverage = coverageMap({ sources: [{ key: 'a', chunks: 1, etag: 'e1' }, { key: 'b', chunks: 2, etag: 'old' }, { key: 'c', chunks: 0, etag: 'e3' }] });
    const etags = new Map([['a', '"e1"'], ['b', '"e2"'], ['c', '"e3"'], ['d', '"e4"']]);
    expect(unsettledKeys({ keys: ['a', 'b', 'c', 'd'], etags, coverage })).toEqual(['b', 'c', 'd']);
  });

  it('waits until the corpus settles, reading the database at the interval', async () => {
    let t = 0;
    const reads = [
      coverageMap({ sources: [] }),
      coverageMap({ sources: [{ key: 'a', chunks: 1, etag: 'e1' }] }),
      coverageMap({ sources: [{ key: 'a', chunks: 1, etag: 'e1' }, { key: 'b', chunks: 1, etag: 'e2' }] }),
    ];
    const out = await waitForIngest({
      keys: ['a', 'b'], etags: new Map([['a', 'e1'], ['b', 'e2']]),
      read: async () => reads.shift(), timeoutMs: 60_000, intervalMs: 15_000,
      sleep: async (ms: number) => { t += ms; }, now: () => t,
    });
    expect(out).toEqual({ settled: true, unsettled: [] });
    expect(t).toBe(30_000);
  });

  it('gives up at the bound and names what never settled', async () => {
    let t = 0;
    const read = jest.fn(async () => coverageMap({ sources: [{ key: 'a', chunks: 1, etag: 'e1' }] }));
    const out = await waitForIngest({
      keys: ['a', 'b'], etags: new Map([['a', 'e1'], ['b', 'e2']]),
      read, timeoutMs: 60_000, intervalMs: 15_000,
      sleep: async (ms: number) => { t += ms; }, now: () => t,
    });
    expect(out).toEqual({ settled: false, unsettled: ['b'] });
    expect(t).toBeLessThanOrEqual(60_000);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it('the knowledge-rag phase runs the sync with --verify, and a failed verify exits non-zero', () => {
    const validate = fs.readFileSync(path.join(__dirname, '../../scripts/validate.mjs'), 'utf8');
    expect(validate).toContain("cmd: 'node scripts/sync-project-knowledge.mjs --rag --verify'");
    const sync = fs.readFileSync(path.join(__dirname, '../../scripts/sync-project-knowledge.mjs'), 'utf8');
    expect(sync).toMatch(/if \(!settled\) \{[\s\S]*?throw new Error/);
  });
});
