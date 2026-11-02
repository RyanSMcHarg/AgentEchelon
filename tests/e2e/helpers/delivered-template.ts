/**
 * THE TEMPLATE A DELIVERED DOCUMENT WAS CHECKED AGAINST, AND THE DOCUMENT COMPARED TO IT THE SAME WAY
 * (SPEC-DOCUMENT-TEMPLATES FR6, FR8).
 *
 * Every report follows a template: the platform `report_generation` workflow declares one on both of its
 * delivering states, and a deployment's pack may offer a choice instead. Which one a delivery used is read
 * from the task's own delivery record (`deliveries[].template`: the name and content hash), never assumed,
 * so a spec holds for the platform template, a deployment's replacement and a person's choice alike. The
 * body is read from `templates/<classification>/<name>/<contentHash>.md` and the delivered document is
 * compared to it with `checkAgainstTemplate`, the function the processor's delivery check runs: required
 * sections present and in order by position and heading level, and each declared table's column count.
 */
import { awsv, awsvText } from './aws';
import { stackName } from './stack-prefix';
import { parseTemplate, checkAgainstTemplate, type ParsedTemplate, type TemplateCheck } from '../../../backend/lambda/src/lib/document-template';

/** What the task's delivery record says about the template a delivery was checked against. */
export interface DeliveryTemplateRecord {
  name: string;
  contentHash: string;
  outcome: string;
  chosen?: true;
}

/** The attachments bucket, where templates are stored. */
export function attachmentsBucket(): string | undefined {
  const outputs = awsv(['cloudformation', 'describe-stacks', '--stack-name', stackName('Conversations')], { quiet: true })
    ?.Stacks?.[0]?.Outputs as Array<{ OutputKey: string; OutputValue: string }> | undefined;
  return outputs?.find((o) => o.OutputKey === 'AttachmentsBucketName')?.OutputValue;
}

/** The template on a task's latest delivery record, or undefined when it names none. */
export function lastDeliveryTemplate(task: Record<string, unknown> | undefined): DeliveryTemplateRecord | undefined {
  const deliveries = task?.deliveries as Array<{ template?: DeliveryTemplateRecord }> | undefined;
  return deliveries?.filter((d) => d.template).at(-1)?.template;
}

/** The stored body of one template version, parsed. */
export function storedTemplate(classification: string, name: string, contentHash: string): ParsedTemplate {
  const bucket = attachmentsBucket();
  if (!bucket) throw new Error(`${stackName('Conversations')} has no AttachmentsBucketName output`);
  return parseTemplate(awsvText(['s3', 'cp', `s3://${bucket}/templates/${classification}/${name}/${contentHash}.md`, '-'], { quiet: true }));
}

/**
 * The delivered document compared to the template its delivery record names. Throws, naming why, when the
 * record names none: every report delivers in a template, so a delivery without one is the defect.
 */
export function checkDeliveredAgainstItsTemplate(
  task: Record<string, unknown> | undefined,
  classification: string,
  document: string,
): { record: DeliveryTemplateRecord; template: ParsedTemplate; check: TemplateCheck } {
  const record = lastDeliveryTemplate(task);
  if (!record) {
    throw new Error('the task\'s delivery record names no template: every report_generation delivery is checked against one');
  }
  const template = storedTemplate(classification, record.name, record.contentHash);
  return { record, template, check: checkAgainstTemplate(document, template) };
}
