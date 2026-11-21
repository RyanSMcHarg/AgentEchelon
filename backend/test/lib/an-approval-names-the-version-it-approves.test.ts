/**
 * AN APPROVAL NAMES THE VERSION IT APPROVES.
 *
 * A task's versions are its own: the draft the run's drafting step delivered, then each one its approver attached on its card.
 * Nothing is read from the conversation, so an unrelated file is never approved. These pin:
 *   - the delivered draft rides the run as one compact value, and is the task's first version;
 *   - an attached version is the approver's own Markdown upload in this conversation, and nothing else;
 *   - the version approved is the latest, named by key, and its name rides the run on to the approval notice.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { DRAFT_FILE_VALUE, documentsOf, draftFileValue, isOwnMarkdownUpload, latestDocument } from '../../lambda/src/lib/task-documents';
import { taskCardOf } from '../../lambda/src/lib/workflow-task';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { renderMessageTemplate } from '../../lambda/src/lib/message-template';

const draft = { fileKey: 'generated-docs/conv-cm-1/document-2026-11-19T19-40.md', name: 'document-2026-11-19T19-40.md', by: 'assistant:advisor' };

describe('a task\'s versions', () => {
  it('starts with the delivered draft, which rides the run as one value within its limit', () => {
    const value = draftFileValue(draft);
    expect(value.length).toBeLessThanOrEqual(500);
    const task = { workflowRun: { values: { [DRAFT_FILE_VALUE]: value } } } as never;
    expect(documentsOf(task)).toEqual([draft]);
    expect(latestDocument(task)).toEqual(draft);
  });

  it('adds each attached version after it, newest last, and has none without either', () => {
    const edited = { fileKey: 'attachments/conv-cm-1/p-maria/1795-notice.md', name: 'notice.md', by: 'p-maria', at: '2026-11-19T19:50:00Z' };
    const task = { workflowRun: { values: { [DRAFT_FILE_VALUE]: draftFileValue(draft) } }, documents: [edited, { junk: true }] } as never;
    expect(documentsOf(task).map((d) => d.fileKey)).toEqual([draft.fileKey, edited.fileKey]);
    expect(latestDocument(task)?.fileKey).toBe(edited.fileKey);
    expect(documentsOf({ workflowRun: { values: {} } } as never)).toEqual([]);
    expect(documentsOf({ workflowRun: { values: { [DRAFT_FILE_VALUE]: 'not json' } } } as never)).toEqual([]);
  });

  it('marks the card that approves one, and no other', () => {
    const machines = { approval: { initial: 'pending', states: { pending: { transitions: ['approved', 'declined'], choices: ['approved', 'declined'] }, approved: { transitions: [], terminal: 'success' as const }, declined: { transitions: [], terminal: 'failure' as const } } } };
    const base = { taskId: 't', taskType: 'approval', taskState: 'pending' };
    expect(taskCardOf({ ...base, workflowRun: { values: { [DRAFT_FILE_VALUE]: draftFileValue(draft) } } } as never, machines as never)?.documents).toBe(true);
    expect(taskCardOf({ ...base, workflowRun: { values: {} } } as never, machines as never)?.documents).toBeUndefined();
  });
});

describe('DENY: an attached version is the approver\'s own Markdown upload here', () => {
  it('refuses another person\'s file, another conversation\'s, a path trick and anything not Markdown', () => {
    expect(isOwnMarkdownUpload('attachments/conv-cm-1/p-maria/1795-notice.md', 'conv-cm-1', 'p-maria')).toBe(true);
    expect(isOwnMarkdownUpload('attachments/conv-cm-1/p-chris/1795-notice.md', 'conv-cm-1', 'p-maria')).toBe(false);
    expect(isOwnMarkdownUpload('attachments/conv-other/p-maria/1795-notice.md', 'conv-cm-1', 'p-maria')).toBe(false);
    expect(isOwnMarkdownUpload('attachments/conv-cm-1/p-maria/../p-chris/x.md', 'conv-cm-1', 'p-maria')).toBe(false);
    expect(isOwnMarkdownUpload('attachments/conv-cm-1/p-maria/1795-notice.pdf', 'conv-cm-1', 'p-maria')).toBe(false);
    expect(isOwnMarkdownUpload('generated-docs/conv-cm-1/document.md', 'conv-cm-1', 'p-maria')).toBe(false);
  });
});

describe('the approval holds to the latest version and says which', () => {
  const service = readFileSync(join(__dirname, '../../lambda/src/task-service.ts'), 'utf8');
  it('refuses an approval naming any version but the latest, and records the approved one\'s name on the run', () => {
    // A press naming no version (a card that could not read them) is asked to read them; one naming an older version is refused as moved.
    expect(service).toMatch(/if \(latest && input\.choice === 'approved'\) \{[\s\S]{0,200}if \(!input\.document\) return \{ ok: false, error: 'DOCUMENT_REQUIRED' \};\s*if \(input\.document !== latest\.fileKey\) return \{ ok: false, error: 'DOCUMENT_MOVED' \};\s*await setTaskRunValue\(task\.taskId, task\.channelArn, APPROVED_DOCUMENT_VALUE, latest\.name\);/);
  });
  it('attaches only for the assignee, only while open, only their own upload', () => {
    expect(service).toMatch(/task\.assigneeType === 'user' && task\.assigneeId === input\.callerPersonId/);
    expect(service).toMatch(/if \(settlementOutcome\(task, machinesOfTask\(task, packTaskStateMachines\(\)\)\)\) return \{ ok: false, error: 'SETTLED' \};/);
    expect(service).toMatch(/if \(!isOwnMarkdownUpload\(input\.fileKey, conversationId, input\.callerPersonId\)\) return \{ ok: false, error: 'NOT_YOURS' \};/);
  });
  it('the approval notice names the version', () => {
    const r = renderMessageTemplate(shippedMessageTemplate('customer-notice-approved')!, { label: 'Customer API Availability', approvedDocument: 'notice.md' }, { sections: ['chat'] });
    expect(r.ok && r.sections.chat).toBe('The account team approved a customer notice for Customer API Availability. Approved version: notice.md.');
    const bare = renderMessageTemplate(shippedMessageTemplate('customer-notice-approved')!, { label: 'X' }, { sections: ['chat'] });
    expect(bare.ok && bare.sections.chat).toBe('The account team approved a customer notice for X.');
  });
});

/**
 * STAGE 2: A REVISION IS ASKED OF THE ASSISTANT THAT DRAFTED IT, and lands as the same task's next version. The run, which waits
 * on the approval, is never moved on by it, and only an assistant's own delivered file in this conversation is recorded.
 */
describe('a revision of the document', () => {
  const service = readFileSync(join(__dirname, '../../lambda/src/task-service.ts'), 'utf8');
  const router = readFileSync(join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const processor = readFileSync(join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');

  it('is asked of the assistant whose draft the versions start from, by its role and intent', () => {
    const { draftingOf } = jest.requireActual('../../lambda/src/lib/task-documents') as typeof import('../../lambda/src/lib/task-documents');
    const v = draftFileValue({ ...draft, role: 'primary', intent: 'customer_notice_draft' });
    expect(draftingOf({ workflowRun: { values: { [DRAFT_FILE_VALUE]: v } } } as never)).toMatchObject({ role: 'primary', intent: 'customer_notice_draft' });
    expect(draftingOf({ workflowRun: { values: { [DRAFT_FILE_VALUE]: draftFileValue(draft) } } } as never)).toBeUndefined();
    expect(router).toMatch(/const holder = await roleHolder\(drafting\.role, t\.channelArn, run\.botArn\);/);
    expect(router).toMatch(/deliver: 'file', revisionOf: \{ taskId: t\.taskId, fileKey: latest\.fileKey, name: latest\.name \}/);
  });

  it('DENY: records only an assistant\'s delivered file in this conversation, and only while a revision is asked for', () => {
    const { isAssistantDocumentKey } = jest.requireActual('../../lambda/src/lib/task-documents') as typeof import('../../lambda/src/lib/task-documents');
    expect(isAssistantDocumentKey('generated-docs/conv-cm-1/document-2.md', 'conv-cm-1')).toBe(true);
    expect(isAssistantDocumentKey('generated-docs/conv-other/document-2.md', 'conv-cm-1')).toBe(false);
    expect(isAssistantDocumentKey('attachments/conv-cm-1/p-maria/x.md', 'conv-cm-1')).toBe(false);
    expect(service).toMatch(/if \(!task\?\.revision\) return \{ ok: false, error: 'NOT_ASKED' \};/);
    expect(service).toMatch(/if \(revisionPending\(task\.revision\)\) return \{ ok: false, error: 'PENDING' \};/);
  });

  it('never moves the waiting run on', () => {
    expect(processor).toMatch(/if \(run\.won && !revising\) await handBack\(run\.outcome\);/);
  });
});

/**
 * A REVISION THAT WILL NOT LAND NEVER BLOCKS THE NEXT: each failure the platform sees clears the request, only that one by its
 * number, and one whose turn ended unseen holds the next back no longer than the drafting turn's reach.
 */
describe('a revision that will not land is cleared, so another may be asked', () => {
  const docs = jest.requireActual('../../lambda/src/lib/task-documents') as typeof import('../../lambda/src/lib/task-documents');
  const service = readFileSync(join(__dirname, '../../lambda/src/task-service.ts'), 'utf8');
  const router = readFileSync(join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const processor = readFileSync(join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
  const tracking = readFileSync(join(__dirname, '../../lambda/src/lib/task-tracking.ts'), 'utf8');
  const handle = router.slice(router.indexOf('async function handleRevisionRequest('), router.indexOf('export async function handleTaskNaming('));
  const now = Date.parse('2026-11-20T12:00:00Z');
  const asked = (minutesAgo: number) => ({ instructions: 'Shorter.', by: 'p-maria', at: new Date(now - minutesAgo * 60_000).toISOString(), n: 2 });

  it('a turn that ended unseen holds the next request back only within the drafting turn\'s reach', () => {
    expect(docs.revisionPending(asked(1), now)).toBe(true);
    expect(docs.revisionPending(asked(docs.REVISION_PENDING_MS / 60_000 + 1), now)).toBe(false);
    expect(docs.revisionPending(undefined, now)).toBe(false);
    expect(docs.revisionPending({ ...asked(1), at: 'not a time' }, now)).toBe(false);
  });

  it('no assistant holding the drafting role, or one the role names twice, clears it', () => {
    expect(handle).toMatch(/if \(!holder \|\| holder === 'ambiguous'\) return abandon\('no assistant holds the drafting role here'\);/);
    expect(handle).toMatch(/await abandonRevision\(\{ taskId: t\.taskId, channelArn: t\.channelArn, n \}\)/);
  });

  it('a run, a drafting step or a version that cannot be read clears it', () => {
    expect(handle).toMatch(/if \(!run \|\| !drafting\?\.role \|\| !drafting\.intent \|\| !latest\) return abandon\('nothing to revise'\);/);
  });

  it('a drafting turn that could not be dispatched clears it', () => {
    expect(handle).toMatch(/return dispatched \? \{ ran: true \} : abandon\('the drafting turn could not be dispatched'\);/);
  });

  it('a drafting turn that ended without its file (no answer, a timeout, a file that could not be stored) clears it', () => {
    expect(processor).toMatch(/if \(revising\) revisedLanded = \(await addRevisedDocument\(/);
    expect(processor).toMatch(/if \(revising && run\.won && !revisedLanded && revisionN !== undefined\) \{\s+await abandonRevision\(\{ taskId: revising\.taskId, channelArn: event\.channelArn, n: revisionN \}\)/);
    // THE NUMBER IS THE ONE THE ROUTER ASKED FOR, read from the step it named.
    expect(router).toMatch(/step: `revise-\$\{t\.taskId\}-\$\{t\.revision\.n\}`/);
    expect(docs.revisionNumberOfStep('revise-evt-abc-def-3')).toBe(3);
    expect(docs.revisionNumberOfStep('answer')).toBeUndefined();
  });

  it('DENY: a failure clears only the revision it was for, never a later one', () => {
    const clear = tracking.slice(tracking.indexOf('export async function clearTaskRevision('), tracking.indexOf('export async function setTaskRunValue('));
    expect(clear).toContain("UpdateExpression: 'REMOVE revision',");
    expect(clear).toContain("ConditionExpression: 'revision.n = :n',");
    expect(service).toMatch(/case 'abandonRevision':\s+return abandonRevision\(input as never\);/);
    expect(service).toMatch(/!Number\.isInteger\(input\?\.n\) \|\| await refusesChannel\(input\.channelArn\)\) return \{ cleared: false \};/);
  });
});
