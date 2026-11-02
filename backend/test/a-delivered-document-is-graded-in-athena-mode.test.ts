/**
 * A DELIVERED DOCUMENT IS GRADED IN ATHENA MODE TOO (SPEC-EVALUATION FR22).
 *
 * Athena mode has no out-of-band analytics store, so the reference to a delivered document cannot ride
 * the record Aurora-mode archival reads. Four pieces carry it instead, each pinned where it happens:
 *
 *  1. THE TURN puts a compact reference on the inline Metadata when there is no out-of-band store, and
 *     the reference is shed under the size cap before anything a person sees.
 *  2. THE RUNNER makes the archive's own copy (the Firehose runs no code that could), verified against
 *     the recorded hash, reads the copy back, and grades it with the shared document framing in a row of
 *     its own (`evaluationType: 'document'`, with the artifact key and hash). A private task's document
 *     is not read and is recorded as skipped. The reply score and the agent scores stay reply-only.
 *  3. THE QUERIES keep reply scores to reply rows, and read document rows by intent and task type.
 *  4. IAM gives the runner the conversation's deliverables (`generated-docs/*`) read-only, and the Glue
 *     table carries the columns the rows are written with.
 */
process.env.ARCHIVE_BUCKET = 'archive-bucket';
process.env.ATTACHMENTS_BUCKET = 'attach-bucket';

const mockAthenaSend = jest.fn();
const mockBedrockSend = jest.fn();
const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-athena', () => ({
  AthenaClient: jest.fn(() => ({ send: mockAthenaSend })),
  StartQueryExecutionCommand: jest.fn((input) => ({ kind: 'start', input })),
  GetQueryExecutionCommand: jest.fn((input) => ({ kind: 'status', input })),
  GetQueryResultsCommand: jest.fn((input) => ({ kind: 'results', input })),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: mockBedrockSend })),
  InvokeModelCommand: jest.fn((input) => ({ kind: 'invoke', input })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  GetObjectCommand: jest.fn((input) => ({ op: 'get', input })),
  PutObjectCommand: jest.fn((input) => ({ op: 'put', input })),
}));

import * as fs from 'fs';
import * as path from 'path';
import { handler } from '../lambda/src/evaluation/evaluation-runner';
import {
  documentRequirementsText,
  documentSha256,
  inlineDeliveredDocument,
} from '../lambda/src/lib/delivered-document';
import { __testing as athenaQuery } from '../lambda/src/analytics-query';
import { forgetCopiedDocuments } from '../lambda/src/analytics-aurora/delivered-document-archive';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/ch-1';
const DOCUMENT = '# Q3 churn report\n\nChurn fell to 2.1 percent, driven by the annual plan.';
const SHA = documentSha256(DOCUMENT);
const FILE_KEY = 'generated-docs/ch-1/report-2026.md';
const ARCHIVE_KEY = `delivered-documents/standard/ch-1/${SHA}`;

const FULL_REFERENCE = {
  fileKey: FILE_KEY,
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

function invokeJson(obj: unknown) {
  return { body: new TextEncoder().encode(JSON.stringify({ content: [{ text: JSON.stringify(obj) }] })) };
}

/** The Athena rows for one user message and the bot reply that delivered the document. */
function athenaRowsWith(reference: Record<string, unknown>) {
  const cell = (v: string) => ({ VarCharValue: v });
  const row = (cells: string[]) => ({ Data: cells.map(cell) });
  const botMeta = JSON.stringify({
    intent: 'report_request',
    agentType: 'concierge',
    classification: 'standard',
    attachment: { fileKey: FILE_KEY, name: 'report-2026.md', size: 70, type: 'text/markdown', sha256: SHA },
    deliveredDocument: reference,
  });
  return [
    row(['message_id', 'channel_arn', 'content', 'sender_arn', 'metadata', 'created_at', 'event_type']),
    row(['m-user', CHANNEL, 'Write the Q3 churn report for the board.', 'arn:aws:chime:us-east-1:1:app-instance/a/user/u1', '', '2026-10-22T10:00:00.000Z', 'CREATE_CHANNEL_MESSAGE']),
    row(['m-bot', CHANNEL, 'Here is the Q3 churn report, attached.', 'arn:aws:chime:us-east-1:1:app-instance/a/bot/standard', botMeta, '2026-10-22T10:00:05.000Z', 'CREATE_CHANNEL_MESSAGE']),
  ];
}

function promptOf(call: unknown[]): string {
  return JSON.parse((call[0] as { input: { body: string } }).input.body).messages[0].content as string;
}

/** Every evaluation row the runner wrote to the archive's `evaluations/` prefix. */
function writtenRows(): Array<Record<string, unknown>> {
  return mockS3Send.mock.calls
    .map((c) => c[0] as { op: string; input: { Key: string; Body: unknown } })
    .filter((cmd) => cmd.op === 'put' && cmd.input.Key.startsWith('evaluations/'))
    .flatMap((cmd) => String(cmd.input.Body).split('\n').map((l) => JSON.parse(l)));
}

function runWith(reference: Record<string, unknown>) {
  mockAthenaSend.mockImplementation(async (cmd: { kind: string }) => {
    if (cmd.kind === 'start') return { QueryExecutionId: 'q-1' };
    if (cmd.kind === 'status') return { QueryExecution: { Status: { State: 'SUCCEEDED' } } };
    return { ResultSet: { Rows: athenaRowsWith(reference) } };
  });
}

describe('the turn carries the reference inline when there is no out-of-band store', () => {
  it('keeps what grading needs, leaves the requirements out, and says so', () => {
    const inline = inlineDeliveredDocument(FULL_REFERENCE as never);
    expect(inline).toMatchObject({ fileKey: FILE_KEY, sha256: SHA, kind: 'report_generation', taskId: 't-1', requirementsOmitted: true });
    expect(inline.requirements).toBeUndefined();
    expect(documentRequirementsText(inline)).toBe('(not recorded where this document was archived)');
    // The out-of-band reference keeps them, and with none recorded says that instead.
    expect(documentRequirementsText(FULL_REFERENCE as never)).toBe('- audience: the board\n- length: one page');
    expect(documentRequirementsText({ ...FULL_REFERENCE, requirements: undefined } as never)).toBe('(none recorded)');
  });

  it('keeps the private flag, which is what stops a private task\'s document being graded', () => {
    const inline = inlineDeliveredDocument({ ...FULL_REFERENCE, private: true } as never);
    expect(inline.private).toBe(true);
  });

  it('is put on the inline Metadata only without the out-of-band store, and is shed before what a person sees', () => {
    const core = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'src', 'lib', 'async-processor-core.ts'), 'utf8');
    expect(core).toContain('...(!messageAnalyticsEnabled() && params.deliveredDocument && attachment');
    expect(core).toContain('{ deliveredDocument: inlineDeliveredDocument(params.deliveredDocument) }');
    const order = core.slice(core.indexOf('const METADATA_SHED_ORDER'), core.indexOf('export function safeMetadataString'));
    const at = (k: string) => order.indexOf(`'${k}'`);
    expect(at('deliveredDocument')).toBeGreaterThan(-1);
    expect(at('deliveredDocument')).toBeLessThan(at('attachment'));
    expect(at('deliveredDocument')).toBeLessThan(at('activeTask'));
  });
});

describe('the Athena-mode runner grades a delivered document from the archive\'s own copy', () => {
  const inline = inlineDeliveredDocument(FULL_REFERENCE as never) as unknown as Record<string, unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Each case starts with nothing copied: the archiver remembers what a container already copied.
    forgetCopiedDocuments();
    mockS3Send.mockImplementation(async (cmd: { op: string; input: { Key: string } }) => (cmd.op === 'get' ? bytesOf(DOCUMENT) : {}));
    mockBedrockSend.mockImplementation(async (cmd: { input: { body: string } }) => {
      const prompt = JSON.parse(cmd.input.body).messages[0].content as string;
      return prompt.includes('Delivered document:')
        ? invokeJson({ relevanceScore: 62, classification: 'partial', reasoning: 'misses the board framing' })
        : invokeJson({ relevanceScore: 90, classification: 'excellent', reasoning: 'clear handover' });
    });
  });

  it('copies the verified file into the archive, reads the copy back, and grades it', async () => {
    runWith(inline);
    const body = JSON.parse((await handler({ targetDate: '2026-10-22' })).body);
    expect(body.documentsScored).toBe(1);
    const ops = mockS3Send.mock.calls.map((c) => c[0] as { op: string; input: { Bucket: string; Key: string } });
    // Read from the conversation's deliverables, written to the archive's own family, read back from there.
    expect(ops[0]).toMatchObject({ op: 'get', input: { Bucket: 'attach-bucket', Key: FILE_KEY } });
    expect(ops[1]).toMatchObject({ op: 'put', input: { Bucket: 'archive-bucket', Key: ARCHIVE_KEY } });
    expect(ops[2]).toMatchObject({ op: 'get', input: { Bucket: 'archive-bucket', Key: ARCHIVE_KEY } });
  });

  it('writes the document as its own row, naming the artifact, beside the reply\'s row', async () => {
    runWith(inline);
    await handler({ targetDate: '2026-10-22' });
    const rows = writtenRows();
    const reply = rows.find((r) => r.evaluationType === 'exchange')!;
    const doc = rows.find((r) => r.evaluationType === 'document')!;
    expect(reply.relevanceScore).toBe(90);
    expect(doc).toMatchObject({
      relevanceScore: 62,
      classification: 'partial',
      artifactKey: ARCHIVE_KEY,
      artifactSha256: SHA,
      documentKind: 'report_generation',
      intentType: 'report_request',
      agentType: 'concierge',
    });
    // The same exchange, so the two can be read side by side.
    expect(doc.exchangeId).toBe(reply.exchangeId);
  });

  it('frames the judge with the shared document framing, without the intent or the task type', async () => {
    runWith(inline);
    await handler({ targetDate: '2026-10-22' });
    const docPrompt = mockBedrockSend.mock.calls.map(promptOf).find((p) => p.includes('Delivered document:'))!;
    expect(docPrompt).toContain('Churn fell to 2.1 percent');
    expect(docPrompt).toContain('(not recorded where this document was archived)');
    expect(docPrompt).not.toContain('report_generation');
    const replyPrompt = mockBedrockSend.mock.calls.map(promptOf).find((p) => !p.includes('Delivered document:'))!;
    expect(replyPrompt).not.toContain('Churn fell to 2.1 percent');
  });

  it('keeps the reply score and the agent scores to replies', async () => {
    runWith(inline);
    const body = JSON.parse((await handler({ targetDate: '2026-10-22' })).body);
    expect(body.evaluated).toBe(1);
    expect(body.avgRelevanceScore).toBe(90);
    expect(body.agentScores).toEqual({ concierge: 90 });
  });

  it('does not read a private task\'s document, and records it as skipped with no score', async () => {
    runWith(inlineDeliveredDocument({ ...FULL_REFERENCE, private: true } as never) as unknown as Record<string, unknown>);
    const body = JSON.parse((await handler({ targetDate: '2026-10-22' })).body);
    expect(body.documentsSkipped).toBe(1);
    const reads = mockS3Send.mock.calls.filter((c) => (c[0] as { op: string }).op === 'get');
    expect(reads).toHaveLength(0);
    const skipped = writtenRows().find((r) => r.evaluationType === 'document_skipped')!;
    expect(skipped.skipReason).toBe('private');
    expect(skipped.relevanceScore).toBeUndefined();
  });

  it('records a file whose bytes do not match the recorded hash as not archived, and grades nothing', async () => {
    mockS3Send.mockImplementation(async (cmd: { op: string }) => (cmd.op === 'get' ? bytesOf('tampered') : {}));
    runWith(inline);
    await handler({ targetDate: '2026-10-22' });
    const skipped = writtenRows().find((r) => r.evaluationType === 'document_skipped')!;
    expect(skipped.skipReason).toBe('not-archived');
    expect(mockBedrockSend.mock.calls.map(promptOf).some((p) => p.includes('Delivered document:'))).toBe(false);
  });
});

describe('Athena-mode queries never pool a document score into a reply score', () => {
  it('evaluation_scores reads reply rows only', () => {
    const sql = athenaQuery.buildQuery('evaluation_scores', '2026-10-01', '2026-10-22')!;
    expect(sql).toContain("COALESCE(evaluationType, 'exchange') = 'exchange'");
  });

  it('document_evaluation is served, by intent and by task type, with the reply beside it', () => {
    expect(athenaQuery.SUPPORTED_TYPES.has('document_evaluation')).toBe(true);
    const sql = athenaQuery.buildQuery('document_evaluation', '2026-10-01', '2026-10-22')!;
    expect(sql).toContain("evaluationType IN ('document', 'document_skipped')");
    expect(sql).toContain("'intent' AS dimension");
    expect(sql).toContain("'task_type' AS dimension");
    expect(sql).toContain('reply_avg_relevance');
  });
});

describe('the Athena archive grants and records what the document grade needs', () => {
  type Statement = { Action: string | string[]; Resource: unknown };
  let template: { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };

  beforeAll(async () => {
    const cdk = await import('aws-cdk-lib');
    const cognito = await import('aws-cdk-lib/aws-cognito');
    const { Template } = await import('aws-cdk-lib/assertions');
    const { ArchiveStack } = await import('../lib/stacks/archive-stack');
    const { MessagingStack } = await import('../lib/stacks/messaging-stack');
    const app = new cdk.App();
    const env = { account: '123456789012', region: 'us-east-1' };
    const chime = new MessagingStack(app, 'TestChime', { env, appInstanceName: 'test-instance' });
    const stack = new ArchiveStack(app, 'TestArchiveDocs', {
      env,
      appInstanceArn: chime.appInstanceArn,
      messageStream: chime.messageStream,
      userPool: cognito.UserPool.fromUserPoolId(chime, 'TestPool', 'us-east-1_TestPool'),
      attachmentsBucketArn: 'arn:aws:s3:::attachments-test',
    });
    template = Template.fromStack(stack).toJSON() as typeof template;
  }, 300_000);

  it('the runner reads the conversation\'s deliverables and nothing else in the attachments bucket', () => {
    const statements: Statement[] = [];
    for (const [id, r] of Object.entries(template.Resources)) {
      if (r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes('EvaluationRunnerRole')) {
        statements.push(...(r.Properties.PolicyDocument as { Statement: Statement[] }).Statement);
      }
      if (r.Type === 'AWS::IAM::Role' && id.startsWith('EvaluationRunnerRole')) {
        for (const p of (r.Properties.Policies as Array<{ PolicyDocument: { Statement: Statement[] } }>) ?? []) statements.push(...p.PolicyDocument.Statement);
      }
    }
    const onAttachments = statements.filter((s) => JSON.stringify(s.Resource).includes('attachments-test'));
    expect(onAttachments).toHaveLength(1);
    expect([onAttachments[0].Action].flat()).toEqual(['s3:GetObject']);
    expect(JSON.stringify(onAttachments[0].Resource)).toBe(JSON.stringify('arn:aws:s3:::attachments-test/generated-docs/*'));
  });

  it('the evaluation_results table carries the artifact columns', () => {
    const table = Object.values(template.Resources).find((r) => r.Type === 'AWS::Glue::Table'
      && (r.Properties.TableInput as { Name: string }).Name === 'evaluation_results')!;
    const columns = ((table.Properties.TableInput as { StorageDescriptor: { Columns: Array<{ Name: string }> } })
      .StorageDescriptor.Columns).map((c) => c.Name);
    expect(columns).toEqual(expect.arrayContaining(['evaluationType', 'artifactKey', 'artifactSha256', 'documentKind', 'skipReason']));
  });
});
