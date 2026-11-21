/**
 * A WORKFLOW STEP CAN DELIVER ITS OUTPUT AS A FILE.
 *
 * Long drafts are documents people download, edit and attach again, so the workflow decides it, whoever writes them:
 *  - an agent step declares `deliver: 'file'`, as the incident's post-incident review draft does (Ops writes it on its own);
 *  - a task step that asks an assistant declares it, and the asked turn carries it whatever the intent says, as customer
 *    messaging's notice drafts do;
 *  - anything else is refused by name, and a step that proposes (a card) cannot be a file.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { SHIPPED_EVENT_WORKFLOWS, eventWorkflowErrors, type EventWorkflow } from '../../lambda/src/lib/event-workflow';

const clone = (wf: EventWorkflow) => JSON.parse(JSON.stringify(wf)) as EventWorkflow & { states: Record<string, Record<string, Record<string, unknown>>> };

describe('the shipped incident delivers its drafts as files', () => {
  it('the post-incident review draft and each customer notice draft', () => {
    expect(SHIPPED_EVENT_WORKFLOWS['ops-room'].states['review-draft'].agent?.deliver).toBe('file');
    for (const step of ['initial-draft', 'update-draft', 'final-draft']) {
      expect(SHIPPED_EVENT_WORKFLOWS['customer-messaging'].states[step].task?.deliver).toBe('file');
    }
    expect(eventWorkflowErrors('ops-room', SHIPPED_EVENT_WORKFLOWS['ops-room'])).toEqual([]);
    expect(eventWorkflowErrors('customer-messaging', SHIPPED_EVENT_WORKFLOWS['customer-messaging'])).toEqual([]);
  });
});

describe('what a step may declare', () => {
  it('DENY: an agent step delivers a file or a message, nothing else', () => {
    const wf = clone(SHIPPED_EVENT_WORKFLOWS['ops-room']);
    (wf.states['review-draft'].agent as unknown as { deliver: string }).deliver = 'pdf';
    expect(eventWorkflowErrors('ops-room', wf).join('\n')).toMatch(/deliver is file, or left out for a message/);
  });

  it('DENY: a task step delivers a file only where it asks an assistant', () => {
    const wf = clone(SHIPPED_EVENT_WORKFLOWS['ops-room']);
    wf.states['runbook-act'].task!.deliver = 'file';
    expect(eventWorkflowErrors('ops-room', wf).join('\n')).toMatch(/deliver is file, on a step that asks an assistant/);
  });
});

describe('the asked turn carries it, and the processor delivers it', () => {
  const router = readFileSync(join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const processor = readFileSync(join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
  it('the router hands the asking step\'s delivery to the asked turn', () => {
    expect(router).toMatch(/\.\.\.\(def\.deliver === 'file' \? \{ deliver: 'file' as const \} : \{\}\)/);
  });
  it('the processor attaches the output where the step, the asking step or the asked intent says file', () => {
    expect(processor).toMatch(/const asFile = def\.deliver === 'file' \|\| asked\?\.deliver === 'file' \|\| \(asked \? intentDefFor\(asked\.intent, turnPack\)\?\.answer\?\.form === 'file' : false\);/);
    expect(processor).toMatch(/\.\.\.\(file \? \{ attachment: file \} : \{\}\)/);
    expect(processor).toMatch(/asFile \? postAsFile\(content\)/);
  });
});
