/**
 * A DELIVERED DOCUMENT IS RECORDED ON THE TURN, SO EVALUATION CAN GRADE IT (SPEC-EVALUATION FR22).
 *
 * The archived `response` of a turn that delivers a file is the chat reply beside it. Before this, no
 * record of the turn named the file, so no evaluator could read it and the quality of every delivered
 * report, extraction and code file went unmeasured.
 *
 * Pinned here: the reference the turn records (what it carries, what it withholds for a private task,
 * and that an image is not mistaken for a document), the archive key it is copied to, and that the
 * processor records it on the turn's out-of-band analytics record - the record archival merges into
 * the archived message.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  deliveredDocumentArchiveKey,
  deliveredDocumentOf,
  deliveredDocumentReference,
  documentSha256,
  requirementsOf,
} from '../../lambda/src/lib/delivered-document';

const BODY = '# Q3 churn report\n\nChurn fell to 2.1 percent.';
const SHA = documentSha256(BODY);
const ATTACHMENT = { fileKey: 'generated-docs/ch-1/report-2026.md', name: 'report-2026.md', size: 44, type: 'text/markdown', sha256: SHA };

describe('the reference a delivered document is recorded with', () => {
  it('carries the key, hash, size, kind, intent, task and the state it was delivered from', () => {
    const ref = deliveredDocumentReference({
      attachment: ATTACHMENT,
      intent: 'report_request',
      taskId: 't-1',
      taskType: 'report_generation',
      fromState: 'generating',
      taskDetails: {
        collectedRequirements: { audience: { value: 'the board', source: 'message', evidence: 'for the board' } },
      },
    });
    expect(ref).toEqual({
      fileKey: ATTACHMENT.fileKey,
      sha256: SHA,
      size: 44,
      contentType: 'text/markdown',
      name: 'report-2026.md',
      kind: 'report_generation',
      intent: 'report_request',
      taskId: 't-1',
      fromState: 'generating',
      requirements: { audience: 'the board' },
    });
  });

  it('records the requirement values and never their evidence quotes', () => {
    // The evidence is a quote of a person's message; the judge needs what was agreed, not who said it.
    const reqs = requirementsOf({
      collectedRequirements: { length: { value: 'two pages', source: 'message', evidence: 'Ada said two pages' } },
    });
    expect(reqs).toEqual({ length: 'two pages' });
    expect(JSON.stringify(reqs)).not.toContain('Ada');
  });

  it('reads the plain requirement map a task written before sourced needs carries', () => {
    expect(requirementsOf({ requirements: { format: 'table' } })).toEqual({ format: 'table' });
  });

  it('withholds a private task\'s requirements and marks the reference private', () => {
    const ref = deliveredDocumentReference({
      attachment: ATTACHMENT,
      taskId: 't-2',
      taskType: 'report_generation',
      taskDetails: { requirements: { topic: 'my salary' } },
      taskPrivate: true,
    });
    expect(ref?.private).toBe(true);
    expect(ref?.requirements).toBeUndefined();
  });

  it('names an ad-hoc file `document`', () => {
    expect(deliveredDocumentReference({ attachment: ATTACHMENT })?.kind).toBe('document');
  });

  it('is absent for a generated image, which carries no hash and is judged by the image judge', () => {
    const image = { fileKey: 'battle-images/ch-1/ts-0.png', name: 'g.png', size: 10, type: 'image/png' };
    expect(deliveredDocumentReference({ attachment: image })).toBeUndefined();
    expect(deliveredDocumentReference({ attachment: undefined })).toBeUndefined();
  });

  it('is read back off an archived message, and a malformed one is not read at all', () => {
    expect(deliveredDocumentOf({ deliveredDocument: { fileKey: 'k', sha256: SHA } })?.sha256).toBe(SHA);
    expect(deliveredDocumentOf(JSON.stringify({ deliveredDocument: { fileKey: 'k', sha256: SHA } }))?.fileKey).toBe('k');
    expect(deliveredDocumentOf({ deliveredDocument: { fileKey: 'k', sha256: 'not-a-hash' } })).toBeUndefined();
    expect(deliveredDocumentOf({})).toBeUndefined();
    expect(deliveredDocumentOf('{not json')).toBeUndefined();
  });
});

describe('the archive key a delivered document is copied to', () => {
  const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/ch-1';

  it('names the archive family, the classification, the conversation and the content hash', () => {
    expect(deliveredDocumentArchiveKey('standard', CHANNEL, SHA)).toBe(`delivered-documents/standard/ch-1/${SHA}`);
  });

  it('refuses a segment that could place an object outside the family', () => {
    expect(deliveredDocumentArchiveKey('../context', CHANNEL, SHA)).toBeNull();
    expect(deliveredDocumentArchiveKey('standard', CHANNEL, '../../x')).toBeNull();
    expect(deliveredDocumentArchiveKey('standard', '', SHA)).toBeNull();
  });
});

describe('the processor records the reference on the turn', () => {
  const read = (...segments: string[]): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', ...segments), 'utf8');
  const core = read('lib', 'async-processor-core.ts');
  const processor = read('assistant-async-processor.ts');

  it('hashes every generated document as it uploads it', () => {
    const at = core.indexOf('export async function generateAndUploadDocument');
    expect(core.slice(at, at + 4000)).toContain('sha256: documentSha256(bodyBuffer)');
  });

  it('puts the reference on the out-of-band analytics record, beside the passages', () => {
    const at = core.indexOf('const writeTurnAnalytics');
    expect(core.slice(at, at + 2600)).toContain('deliveredDocument: params.deliveredDocument');
  });

  it('builds it where the document is uploaded, from the state it was delivered from', () => {
    const at = processor.indexOf('attachment = await generateAndUploadDocument(');
    const block = processor.slice(at, at + 1400);
    expect(block).toContain('deliveredDocument = deliveredDocumentReference(');
    expect(block).toContain('fromState: taskContext?.task.taskState');
    expect(block).toContain('taskPrivate: isPrivateVisibility(');
  });
});
