/**
 * EACH DELIVERY RECORDS THE TEMPLATE IT WAS CHECKED AGAINST, AND THE RESULT (SPEC-DOCUMENT-TEMPLATES FR8).
 *
 * The template's name and content hash and the outcome (passed, passed after correction, posted inline,
 * or filled by the platform) ride three records: the delivered-document reference evaluation grades
 * from, the task's delivery record, and the turn's out-of-band analytics record. The last carries it
 * even when nothing was attached, because a document that failed its template has no attachment.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  deliveredDocumentReference,
  deliveredDocumentOf,
  TEMPLATE_CHECK_OUTCOMES,
  type DocumentTemplateRecord,
} from '../../lambda/src/lib/delivered-document';

const RECORD: DocumentTemplateRecord = {
  name: 'quarterly-account-review', contentHash: 'f'.repeat(64), outcome: 'passed_after_correction', chosen: true, headingTextAgreement: 0,
};

describe('the delivered-document reference carries the template (behavior)', () => {
  it('records name, content hash and outcome, and survives the archive read', () => {
    const ref = deliveredDocumentReference({
      attachment: { fileKey: 'generated-docs/c/report.md', name: 'report.md', size: 900, type: 'text/markdown', sha256: 'a'.repeat(64) },
      taskId: 't1', taskType: 'report_generation', fromState: 'generating', template: RECORD,
    });
    expect(ref?.template).toEqual(RECORD);
    expect(deliveredDocumentOf({ deliveredDocument: ref })?.template).toEqual(RECORD);
  });

  it('has no template field when the step declares none', () => {
    const ref = deliveredDocumentReference({
      attachment: { fileKey: 'generated-docs/c/report.md', name: 'report.md', size: 900, type: 'text/markdown', sha256: 'a'.repeat(64) },
    });
    expect(ref && 'template' in ref).toBe(false);
  });

  it('names exactly the outcomes the spec lists, plus the platform fill', () => {
    expect([...TEMPLATE_CHECK_OUTCOMES]).toEqual(['passed', 'passed_after_correction', 'posted_inline', 'filled_by_platform']);
  });
});

describe('the delivery gate writes it to all three records (source text)', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'lambda', 'src', 'assistant-async-processor.ts'), 'utf8');

  it('puts it on the reference, the task delivery and the analytics record', () => {
    expect(src).toMatch(/deliveredDocumentReference\(\{[\s\S]{0,600}template: documentTemplate/);
    expect(src).toMatch(/recordTaskDelivery\(event\.taskId, event\.channelArn, \{[\s\S]{0,300}template: documentTemplate/);
    expect(src).toMatch(/\.\.\.\(documentTemplate \? \{ documentTemplate \} : \{\}\)/);
  });

  it('records a document posted inline on the task too, with its template', () => {
    expect(src).toMatch(/name: 'posted inline'[\s\S]{0,200}template: documentTemplate/);
  });
});
