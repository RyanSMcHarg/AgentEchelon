/**
 * A DELIVERED DOCUMENT IS ARCHIVED AND GRADED AS ITSELF (SPEC-EVALUATION FR22).
 *
 * Three halves, each pinned where it happens:
 *
 *  1. ARCHIVAL keeps the archive's own copy. The bytes are read from the conversation's deliverables,
 *     checked against the hash the turn recorded, and written under `delivered-documents/`, a family
 *     the archive owns. A file from another conversation, or one that does not match, is not copied.
 *  2. THE RUNNER grades the document from that copy, in a row of its own (`evaluation_type =
 *     'document'`) that names the artifact (`artifact_key`, `artifact_sha256`) and its own rubric
 *     version, beside the reply's row. The judge is shown the document and the task's recorded
 *     requirements, and is not shown the intent. Grading is its own unit of work: a failure is retried
 *     by later runs up to a bound, then reported, and a terminal skip is recorded once (migration 083).
 *  3. IAM scopes both reads to the prefix each needs: archival reads `generated-docs/*` and writes
 *     `delivered-documents/*`; the runner reads `delivered-documents/*` from the archive, writes nothing
 *     there, and reads only `battle-images/*` from the attachments bucket.
 */
process.env.ATTACHMENTS_BUCKET = 'attach-bucket';
process.env.ARCHIVE_BUCKET = 'archive-bucket';
process.env.EVALUATOR_MODEL = 'anthropic.claude-3-haiku-20240307-v1:0';

const mockSend = jest.fn();
const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockSend })),
  InvokeModelCommand: jest.fn((input) => ({ kind: 'invoke', input })),
  ConverseCommand: jest.fn((input) => ({ kind: 'converse', input })),
  ApplyGuardrailCommand: jest.fn((input) => ({ kind: 'guardrail', input })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn((input) => ({ op: 'get', input })),
  PutObjectCommand: jest.fn((input) => ({ op: 'put', input })),
}));

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({ query: jest.fn(), ensureSchema: jest.fn() }));

import * as fs from 'fs';
import * as path from 'path';
import { query } from '../../lambda/src/analytics-aurora/db-client';
import { handler } from '../../lambda/src/analytics-aurora/evaluation-runner';
import { archiveDeliveredDocument, forgetCopiedDocuments } from '../../lambda/src/analytics-aurora/delivered-document-archive';
import { documentSha256 } from '../../lambda/src/lib/delivered-document';

const mockedQuery = query as jest.MockedFunction<typeof query>;

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/ch-1';
const DOCUMENT = '# Q3 churn report\n\nChurn fell to 2.1 percent, driven by the annual plan.';
const SHA = documentSha256(DOCUMENT);
const ARCHIVE_KEY = `delivered-documents/standard/ch-1/${SHA}`;

const REFERENCE = {
  fileKey: 'generated-docs/ch-1/report-2026.md',
  sha256: SHA,
  size: Buffer.byteLength(DOCUMENT),
  contentType: 'text/markdown',
  name: 'report-2026.md',
  kind: 'report_generation',
  intent: 'report_request',
  taskId: 't-1',
  fromState: 'generating',
  requirements: { audience: 'the board', length: 'one page' },
};

function bytesOf(text: string) {
  return { Body: { transformToByteArray: async () => new Uint8Array(Buffer.from(text, 'utf-8')) } };
}

describe('archival keeps the archive\'s own copy of a delivered document', () => {
  beforeEach(() => { jest.clearAllMocks(); forgetCopiedDocuments(); });

  it('copies a document once per container: a later event of the message names it and nothing is read or written', async () => {
    const s3 = { send: jest.fn(async (cmd: { op: string }) => (cmd.op === 'get' ? bytesOf(DOCUMENT) : {})) };
    const args = { s3, attachmentsBucket: 'attach-bucket', archiveBucket: 'archive-bucket', channelArn: CHANNEL, classification: 'standard', reference: REFERENCE };
    expect((await archiveDeliveredDocument(args)).archiveKey).toBe(ARCHIVE_KEY);
    expect(s3.send).toHaveBeenCalledTimes(2);
    expect((await archiveDeliveredDocument(args)).archiveKey).toBe(ARCHIVE_KEY);
    expect(s3.send).toHaveBeenCalledTimes(2);
  });

  it('copies on the events that write the message, never on its redaction or deletion', () => {
    const archival = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'kinesis-archival.ts'), 'utf8');
    expect(archival).toContain("const writesTheMessage = EventType === 'CREATE_CHANNEL_MESSAGE' || EventType === 'UPDATE_CHANNEL_MESSAGE';");
    expect(archival).toContain('if (delivered && channelArn && writesTheMessage) {');
  });

  it('copies the verified bytes under the archive\'s family and records where', async () => {
    const s3 = { send: jest.fn(async (cmd: { op: string }) => (cmd.op === 'get' ? bytesOf(DOCUMENT) : {})) };
    const out = await archiveDeliveredDocument({
      s3, attachmentsBucket: 'attach-bucket', archiveBucket: 'archive-bucket',
      channelArn: CHANNEL, classification: 'standard', reference: REFERENCE,
    });
    expect(out.archiveKey).toBe(ARCHIVE_KEY);
    const [get, put] = s3.send.mock.calls.map((c) => c[0] as unknown as { op: string; input: Record<string, unknown> });
    expect(get.input).toEqual({ Bucket: 'attach-bucket', Key: REFERENCE.fileKey });
    expect(put.op).toBe('put');
    expect(put.input.Bucket).toBe('archive-bucket');
    expect(put.input.Key).toBe(ARCHIVE_KEY);
    expect(Buffer.from(put.input.Body as Uint8Array).toString('utf-8')).toBe(DOCUMENT);
  });

  it('does not copy a file whose bytes do not match the hash the turn recorded', async () => {
    const s3 = { send: jest.fn(async () => bytesOf('something else')) };
    const out = await archiveDeliveredDocument({
      s3, attachmentsBucket: 'attach-bucket', archiveBucket: 'archive-bucket',
      channelArn: CHANNEL, classification: 'standard', reference: REFERENCE,
    });
    expect(out.archiveKey).toBeUndefined();
    expect(s3.send).toHaveBeenCalledTimes(1); // the read, and no write
  });

  it('refuses a reference naming another conversation\'s file without reading it', async () => {
    const s3 = { send: jest.fn() };
    const out = await archiveDeliveredDocument({
      s3, attachmentsBucket: 'attach-bucket', archiveBucket: 'archive-bucket',
      channelArn: CHANNEL, classification: 'standard',
      reference: { ...REFERENCE, fileKey: 'generated-docs/ch-OTHER/report.md' },
    });
    expect(out.archiveKey).toBeUndefined();
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('fails open: an S3 error leaves the reference without an archive key and does not throw', async () => {
    const s3 = { send: jest.fn(async () => { throw new Error('s3 down'); }) };
    const out = await archiveDeliveredDocument({
      s3, attachmentsBucket: 'attach-bucket', archiveBucket: 'archive-bucket',
      channelArn: CHANNEL, classification: 'standard', reference: REFERENCE,
    });
    expect(out).toEqual(REFERENCE);
  });

  it('is wired into archival from the out-of-band record only', () => {
    const archival = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'kinesis-archival.ts'), 'utf8');
    expect(archival).toContain('const delivered = deliveredDocumentOf(oob);');
    expect(archival).toContain('await archiveDeliveredDocument({');
  });
});

// ── The runner ────────────────────────────────────────────────────────────────────────────────────

const EXCHANGE = {
  id: 'ex-doc',
  sample_stratum: 'sampled',
  channel_arn: CHANNEL,
  assistant: 'standard',
  conversation_classification: 'standard',
  intent: 'report_request',
  task_id: 't-1',
  created_at: '2026-10-23T00:00:00Z',
  user_message: 'Write the Q3 churn report for the board.',
  agent_response: 'Here is the Q3 churn report, attached.',
  agent_metadata: { deliveredDocument: { ...REFERENCE, archiveKey: ARCHIVE_KEY } },
};

function invokeJson(obj: unknown) {
  return { body: new TextEncoder().encode(JSON.stringify({ content: [{ text: JSON.stringify(obj) }] })) };
}

/** The prompt text an InvokeModel call carried. */
function promptOf(call: unknown[]): string {
  const cmd = call[0] as { input: { body: string } };
  return JSON.parse(cmd.input.body).messages[0].content as string;
}

function insertsOf(): Array<[string, unknown[]]> {
  return mockedQuery.mock.calls.filter(([sql]) => /INSERT INTO evaluation_results/.test(sql as string)) as Array<[string, unknown[]]>;
}

/** The document pass's backlog read, as opposed to the reply pass's. */
const isPendingDocumentsRead = (sql: string) => /FROM exchanges e/.test(sql) && /document_grading_attempts ga/.test(sql);

/**
 * One run where the reply pass sees `exchange` unscored and, once its reply row is written, the document
 * pass sees it owed a document grade (`attempts` failed attempts so far).
 */
function runWith(exchange: Record<string, unknown>, attempts = 0): void {
  mockedQuery.mockImplementation((async (sql: string) => {
    if (isPendingDocumentsRead(sql)) {
      return { rows: [{ ...exchange, sample_rate: 100, document_attempts: attempts }], rowCount: 1 };
    }
    if (/FROM exchanges e/.test(sql) && /evaluation_results er/.test(sql) && /sample_stratum/.test(sql)) {
      return { rows: [exchange], rowCount: 1 };
    }
    if (/INSERT INTO evaluation_results/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }) as never);
}

/** The grading-state writes (migration 083), with their parameters. */
function attemptWritesOf(): Array<[string, unknown[]]> {
  return mockedQuery.mock.calls.filter(([sql]) => /document_grading_attempts/.test(sql as string) && !isPendingDocumentsRead(sql as string)) as Array<[string, unknown[]]>;
}

describe('the runner grades a delivered document as an artifact of its own', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockS3Send.mockImplementation(async () => bytesOf(DOCUMENT));
    mockSend.mockImplementation(async (cmd: { input: { body: string } }) => {
      const prompt = JSON.parse(cmd.input.body).messages[0].content as string;
      return prompt.includes('Delivered document:')
        ? invokeJson({ relevanceScore: 64, classification: 'partial', reasoning: 'misses the board framing', complianceBreaches: [] })
        : invokeJson({ relevanceScore: 91, classification: 'excellent', reasoning: 'clear handover', complianceBreaches: [] });
    });
  });

  it('writes the reply row and a document row, each scored on its own artifact', async () => {
    runWith(EXCHANGE);
    const body = JSON.parse((await handler({})).body);
    expect(body.evaluated).toBe(1);
    expect(body.documentsScored).toBe(1);

    const inserts = insertsOf();
    expect(inserts).toHaveLength(2);
    const [reply, doc] = inserts;
    expect(reply[0]).toContain("'exchange'");
    expect(reply[1][3]).toBe(91);
    expect(doc[0]).toContain("'document'");
    expect(doc[0]).toContain('ON CONFLICT (exchange_id) WHERE evaluation_type = \'document\' DO NOTHING');
    expect(doc[1][0]).toBe('ex-doc');
    expect(doc[1][3]).toBe(64);
    expect(doc[1][4]).toBe('partial');
    // Which artifact the score is about.
    expect(doc[1][18]).toBe(ARCHIVE_KEY);
    expect(doc[1][19]).toBe(SHA);
    // Its own rubric, so a document score never pools with reply scores under one version.
    expect(doc[1][12]).not.toBe(reply[1][12]);
  });

  it('reads the document from the archive\'s copy, not the attachments bucket', async () => {
    runWith(EXCHANGE);
    await handler({});
    const reads = mockS3Send.mock.calls.map((c) => (c[0] as { input: Record<string, unknown> }).input);
    expect(reads).toEqual([{ Bucket: 'archive-bucket', Key: ARCHIVE_KEY }]);
  });

  it('shows the judge the document and the recorded requirements, and not the intent', async () => {
    runWith(EXCHANGE);
    await handler({});
    const docPrompt = mockSend.mock.calls.map(promptOf).find((p) => p.includes('Delivered document:'))!;
    expect(docPrompt).toContain('Churn fell to 2.1 percent');
    expect(docPrompt).toContain('- audience: the board');
    expect(docPrompt).toContain('- length: one page');
    expect(docPrompt).not.toContain('report_request');
    expect(docPrompt).not.toContain('report_generation');
    // The reply's prompt is the reply, without the document.
    const replyPrompt = mockSend.mock.calls.map(promptOf).find((p) => !p.includes('Delivered document:'))!;
    expect(replyPrompt).toContain('Here is the Q3 churn report, attached.');
    expect(replyPrompt).not.toContain('Churn fell to 2.1 percent');
  });

  it('does not grade a private task\'s document, and the reply is still scored', async () => {
    runWith({ ...EXCHANGE, agent_metadata: { deliveredDocument: { ...REFERENCE, archiveKey: ARCHIVE_KEY, private: true } } });
    const body = JSON.parse((await handler({})).body);
    expect(body.evaluated).toBe(1);
    expect(body.documentsScored).toBe(0);
    expect(body.documentsSkipped).toBe(1);
    expect(insertsOf()).toHaveLength(1);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('writes no document row when the archive holds no copy', async () => {
    runWith({ ...EXCHANGE, agent_metadata: { deliveredDocument: REFERENCE } });
    const body = JSON.parse((await handler({})).body);
    expect(body.documentsSkipped).toBe(1);
    expect(insertsOf()).toHaveLength(1);
  });

  it('writes no document row when the archive\'s copy does not match the recorded hash', async () => {
    mockS3Send.mockImplementation(async () => bytesOf('tampered'));
    runWith(EXCHANGE);
    const body = JSON.parse((await handler({})).body);
    expect(body.documentsSkipped).toBe(1);
    expect(insertsOf()).toHaveLength(1);
  });
});

// ── A document is its own unit of work: retried, bounded, and reported ───────────────────────────────

describe('a document grade is its own unit of work (migration 083)', () => {
  const judge = (docOutcome: 'ok' | 'throw') => mockSend.mockImplementation(async (cmd: { input: { body: string } }) => {
    const prompt = JSON.parse(cmd.input.body).messages[0].content as string;
    if (prompt.includes('Delivered document:')) {
      if (docOutcome === 'throw') throw new Error('ThrottlingException: rate exceeded');
      return invokeJson({ relevanceScore: 70, classification: 'good', reasoning: 'meets the brief', complianceBreaches: [] });
    }
    return invokeJson({ relevanceScore: 91, classification: 'excellent', reasoning: 'clear handover', complianceBreaches: [] });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockS3Send.mockImplementation(async () => bytesOf(DOCUMENT));
  });

  it('a judge failure on the document leaves the reply scored and records a retrying attempt', async () => {
    judge('throw');
    runWith(EXCHANGE);
    const body = JSON.parse((await handler({})).body);
    expect(body.evaluated).toBe(1);
    expect(body.documentsScored).toBe(0);
    expect(body.documentErrors).toBe(1);
    expect(body.documentsExhausted).toBe(0);
    expect(insertsOf()).toHaveLength(1); // the reply's row, and no document row
    const [write] = attemptWritesOf();
    expect(write[0]).toContain('INSERT INTO document_grading_attempts');
    expect(write[1][0]).toBe('ex-doc');
    expect(write[1][2]).toBe('retrying');
    expect(write[1][3]).toBe(1);
    // The error's first line, never the document.
    expect(String(write[1][4])).toContain('ThrottlingException');
    expect(String(write[1][4])).not.toContain('Churn fell');
  });

  it('the next run picks up a document whose reply is already scored, grades it, and marks the retry done', async () => {
    judge('ok');
    mockedQuery.mockImplementation((async (sql: string) => {
      if (isPendingDocumentsRead(sql)) return { rows: [{ ...EXCHANGE, sample_rate: 25, document_attempts: 1 }], rowCount: 1 };
      if (/INSERT INTO evaluation_results/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 }; // the reply pass finds nothing unscored
    }) as never);
    const body = JSON.parse((await handler({})).body);
    expect(body.evaluated).toBe(0);
    expect(body.documentsScored).toBe(1);
    const inserts = insertsOf();
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toContain("'document'");
    // The population is the reply row's, not the rate in force now.
    expect(inserts[0][1][13]).toBe('sampled');
    expect(inserts[0][1][14]).toBe(25);
    const done = attemptWritesOf().find(([sql]) => /UPDATE document_grading_attempts/.test(sql));
    expect(done?.[0]).toContain("status = 'scored'");
  });

  it('stops at the bound, marks the document exhausted, and reports it', async () => {
    judge('throw');
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    runWith(EXCHANGE, 2); // two failed attempts already; the default bound is three
    const body = JSON.parse((await handler({})).body);
    expect(body.documentsExhausted).toBe(1);
    const [write] = attemptWritesOf();
    expect(write[1][2]).toBe('exhausted');
    expect(write[1][3]).toBe(3);
    expect(errors.mock.calls.some((c) => String(c[0]).includes('ex-doc') && String(c[0]).includes('not tried again'))).toBe(true);
    errors.mockRestore();
  });

  it('records a terminal skip once, with its reason, so the document is not read again', async () => {
    judge('ok');
    runWith({ ...EXCHANGE, agent_metadata: { deliveredDocument: { ...REFERENCE, archiveKey: ARCHIVE_KEY, private: true } } });
    await handler({});
    const [write] = attemptWritesOf();
    expect(write[0]).toContain("'skipped'");
    expect(write[1]).toEqual(['ex-doc', SHA, 'private']);
  });

  it('an unreadable archive copy is a failed attempt, not a terminal skip', async () => {
    judge('ok');
    mockS3Send.mockImplementation(async () => { throw new Error('SlowDown'); });
    runWith(EXCHANGE);
    const body = JSON.parse((await handler({})).body);
    expect(body.documentErrors).toBe(1);
    expect(body.documentsSkipped).toBe(0);
    const [write] = attemptWritesOf();
    expect(write[1][2]).toBe('retrying');
  });

  it('the backlog read takes only documents owed a grade, drawn with a scored reply', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'evaluation-runner.ts'), 'utf8');
    const start = src.indexOf('async function getPendingDocuments');
    const sql = src.slice(start, src.indexOf('return res.rows;', start));
    // No document row yet.
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM evaluation_results d\s+WHERE d\.exchange_id = e\.id AND d\.evaluation_type = 'document'/);
    // No terminal outcome: only never-tried or still retrying.
    expect(sql).toContain("(ga.exchange_id IS NULL OR ga.status = 'retrying')");
    // Drawn with its exchange: the reply's row must exist.
    expect(sql).toMatch(/JOIN LATERAL \([\s\S]*evaluation_type = 'exchange'[\s\S]*\) er ON TRUE/);
    // And the reply pass no longer grades the document inline.
    const handlerSrc = src.slice(src.indexOf('export async function handler'));
    expect(handlerSrc).toContain('runDocumentPass(runId)');
    expect(handlerSrc.slice(0, handlerSrc.indexOf('runDocumentPass(runId)'))).not.toContain('gradeDeliveredDocument(');
  });
});

// ── IAM ───────────────────────────────────────────────────────────────────────────────────────────

describe('each read and write is scoped to the prefix it needs', () => {
  type Statement = { Action: string | string[]; Resource: unknown; Sid?: string };
  let statementsOf: (roleIdPrefix: string) => Statement[];

  beforeAll(async () => {
    const cdk = await import('aws-cdk-lib');
    const { Template } = await import('aws-cdk-lib/assertions');
    const { ArchiveStackAurora } = await import('../../lib/stacks/archive-stack-aurora');
    const { testMessageStream } = await import('../helpers/synth');
    const app = new cdk.App();
    const stack = new ArchiveStackAurora(app, 'TestDeliveredDocuments', {
      env: { account: '123456789012', region: 'us-east-1' },
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
      messageStream: testMessageStream(app),
      userPoolId: 'us-east-1_TestPoolId',
      attachmentsBucketArn: 'arn:aws:s3:::attachments-test',
    } as never);
    const template = Template.fromStack(stack).toJSON() as { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
    statementsOf = (roleIdPrefix: string): Statement[] => {
      const out: Statement[] = [];
      for (const [id, r] of Object.entries(template.Resources)) {
        if (r.Type === 'AWS::IAM::Role' && id.startsWith(roleIdPrefix)) {
          for (const p of (r.Properties.Policies as Array<{ PolicyDocument: { Statement: Statement[] } }>) ?? []) out.push(...p.PolicyDocument.Statement);
        }
        if (r.Type === 'AWS::IAM::Policy') {
          const roles = JSON.stringify(r.Properties.Roles);
          if (roles.includes(roleIdPrefix)) out.push(...((r.Properties.PolicyDocument as { Statement: Statement[] }).Statement));
        }
      }
      return out;
    };
  }, 300_000);

  const s3Of = (stmts: Statement[]) => stmts.filter((s) => [s.Action].flat().some((a) => a.startsWith('s3:')));
  const text = (v: unknown) => JSON.stringify(v);

  it('the runner reads only the archive\'s delivered documents and the generated images, and writes nothing', () => {
    const s3 = s3Of(statementsOf('EvaluationLambdaRole'));
    expect(s3.length).toBeGreaterThan(0);
    for (const s of s3) expect([s.Action].flat()).toEqual(['s3:GetObject']);
    const resources = s3.map((s) => text(s.Resource));
    expect(resources.some((r) => r.includes('/delivered-documents/*'))).toBe(true);
    expect(resources.some((r) => r.includes('attachments-test/battle-images/*'))).toBe(true);
    for (const r of resources) expect(r.includes('/delivered-documents/*') || r.includes('/battle-images/*')).toBe(true);
  });

  it('archival reads the conversation\'s deliverables and writes only the archive\'s family', () => {
    const s3 = s3Of(statementsOf('ArchivalLambdaRole'));
    const get = s3.filter((s) => [s.Action].flat().includes('s3:GetObject'));
    const put = s3.filter((s) => [s.Action].flat().includes('s3:PutObject'));
    expect(get.map((s) => text(s.Resource))).toEqual([text('arn:aws:s3:::attachments-test/generated-docs/*')]);
    expect(put).toHaveLength(1);
    expect(text(put[0].Resource)).toContain('/delivered-documents/*');
  });
});
