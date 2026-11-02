/**
 * AN ASSISTANT'S OWN MESSAGE TEMPLATE, AS THE STORE HOLDS IT, AND HOW A SPEC PUTS IT BACK (ADR-062 decision 2).
 *
 * A template's body is stored once under its content hash, `templates/<classification>/_assistants/<assistant>/<name>/
 * <sha256>.md` in the attachments bucket, and the version said is the SSM pointer
 * `<ssmRoot>/assistant/<classification>/templates/_assistants/<assistant>/<name>` (`templatePointerName`,
 * `backend/lambda/src/lib/template-store.ts`). Only the pointer decides what is said, so a spec that saves a template
 * records the pointer's value first and writes that value back afterwards, or deletes the pointer when there was
 * none: the console's rollback cannot undo the first version a family ever held, because it has no earlier one.
 *
 * `putAssistantTemplate` is the operator's write (`npm run template -- put <classification> <file> --assistant <name>
 * --activate`), for a family the console does not write, such as the admin agent's operator notices.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { awsv, awsvText } from './aws';
import { SSM_ROOT } from './stack-prefix';
import { attachmentsBucket } from './delivered-template';

/** The pointer parameter of one template in an assistant's own family. */
export function assistantTemplatePointer(classification: string, assistant: string, name: string): string {
  return `${SSM_ROOT}/assistant/${classification}/templates/_assistants/${assistant}/${name}`;
}

/** A pointer's value, or null when no version of that template was ever activated. */
export function readPointer(param: string): string | null {
  try {
    const v = awsvText(['ssm', 'get-parameter', '--name', param, '--query', 'Parameter.Value', '--output', 'text'], { quiet: true }).trim();
    return v && v !== 'None' ? v : null;
  } catch {
    return null;
  }
}

/** Write a pointer back to the value it held, or delete it when it held none. */
export function restorePointer(param: string, value: string | null): void {
  if (value === null) {
    try {
      awsv(['ssm', 'delete-parameter', '--name', param], { quiet: true });
    } catch (err) {
      if (!/ParameterNotFound/.test(String((err as Error)?.message))) throw err;
    }
    return;
  }
  awsv(['ssm', 'put-parameter', '--name', param, '--type', 'String', '--overwrite', '--value', value]);
}

/**
 * Store a template body in an assistant's family and make it the active version, as the operator's script does:
 * the body first, under its content hash, then the pointer, keeping the version it replaces in the pointer's history.
 */
export function putAssistantTemplate(classification: string, assistant: string, name: string, source: string): { contentHash: string } {
  const bucket = attachmentsBucket();
  if (!bucket) throw new Error('the Conversations stack publishes no AttachmentsBucketName, where templates are stored');
  const contentHash = createHash('sha256').update(source, 'utf8').digest('hex');
  const file = path.join(os.tmpdir(), `template-${contentHash}.md`);
  fs.writeFileSync(file, source, 'utf8');
  try {
    awsv(['s3api', 'put-object', '--bucket', bucket, '--key', `templates/${classification}/_assistants/${assistant}/${name}/${contentHash}.md`,
      '--body', file, '--content-type', 'text/markdown; charset=utf-8']);
  } finally {
    fs.rmSync(file, { force: true });
  }
  const param = assistantTemplatePointer(classification, assistant, name);
  const before = readPointer(param);
  let history: string[] = [];
  if (before) {
    try {
      const p = JSON.parse(before) as { active?: string; history?: string[] };
      history = [...(p.history ?? []), ...(p.active && p.active !== contentHash ? [p.active] : [])];
    } catch {
      history = [];
    }
  }
  awsv(['ssm', 'put-parameter', '--name', param, '--type', 'String', '--overwrite', '--value', JSON.stringify({ active: contentHash, history })]);
  return { contentHash };
}
