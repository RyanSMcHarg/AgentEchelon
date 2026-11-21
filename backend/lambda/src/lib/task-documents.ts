/**
 * THE VERSIONS OF A DOCUMENT A TASK APPROVES: a draft an assistant delivered, then each version its approver
 * attached on the task's card. Nothing is inferred from the conversation: a file attached anywhere else, or one an
 * assistant produced for another request, is never one of a task's versions.
 *
 *  - The first is the file the run's drafting step delivered, which rides the run as `draftFile` (the processor records it
 *    when the step delivers as a file) and so reaches the approval task the run opens next.
 *  - Each later one is the approver's own upload (`attachments/<conversation>/<their person id>/...`), recorded on the task by
 *    the task service once it has checked the key is theirs, in this conversation, and Markdown.
 *  - Approving names the version the card showed, and is refused unless it is still the latest.
 */
import type { Task } from './task-tracking.js';

export interface TaskDocument {
  fileKey: string;
  name: string;
  /** Who produced it: `assistant:<profile>` for a delivered draft, else the person id of the approver who attached it. */
  by: string;
  at?: string;
  /** A delivered draft's assistant role and the intent it answered, so a revision is asked of the same assistant for the same intent. */
  role?: string;
  intent?: string;
}

/** A revision its approver asked for, while the drafting assistant writes it (stage 2). */
export interface TaskRevisionRequest { instructions: string; by: string; at: string; n: number }

/**
 * HOW LONG A REVISION HOLDS THE NEXT ONE BACK: the drafting turn's longest reach with room to spare. Every failure the platform
 * sees clears the request at once (`abandonRevision`); a turn that ended where nothing could say so (its function stopped)
 * leaves one that is stale past this, and the next request replaces it.
 */
export const REVISION_PENDING_MS = 15 * 60_000;

/** Whether a recorded revision still holds the next one back: recorded, and younger than `REVISION_PENDING_MS`. */
export function revisionPending(revision: TaskRevisionRequest | undefined | null, now: number = Date.now()): boolean {
  if (!revision) return false;
  const at = Date.parse(revision.at);
  return Number.isFinite(at) && now - at < REVISION_PENDING_MS;
}

/** The revision number a drafting turn's step names (`revise-<taskId>-<n>`), or undefined for any other step. */
export function revisionNumberOfStep(step: string): number | undefined {
  const m = /^revise-.+-(\d+)$/.exec(step);
  return m ? Number(m[1]) : undefined;
}
/** The longest instructions a revision carries. */
export const MAX_REVISION_INSTRUCTIONS = 2000;

/** Whether a key is a file an assistant delivered in this conversation (`generated-docs/<conversation id>/`). */
export function isAssistantDocumentKey(fileKey: string, conversationId: string): boolean {
  return typeof fileKey === 'string' && fileKey.length <= MAX_KEY && !fileKey.includes('..') && !!conversationId
    && fileKey.startsWith(`generated-docs/${conversationId}/`) && /\.(md|markdown)$/i.test(fileKey);
}

/** The run value a drafting step's delivered file rides as. */
export const DRAFT_FILE_VALUE = 'draftFile';
/** The run value an approval records the approved version's name in, which the approval notice says. */
export const APPROVED_DOCUMENT_VALUE = 'approvedDocument';
/** The most versions one task records, and the longest name kept. */
export const MAX_TASK_DOCUMENTS = 20;
const MAX_NAME = 120;
const MAX_KEY = 300;

const docOf = (v: unknown): TaskDocument | undefined => {
  const d = v as Partial<TaskDocument> | undefined;
  if (!d || typeof d.fileKey !== 'string' || !d.fileKey || d.fileKey.length > MAX_KEY || typeof d.name !== 'string' || typeof d.by !== 'string') return undefined;
  return {
    fileKey: d.fileKey, name: d.name.slice(0, MAX_NAME), by: d.by, ...(typeof d.at === 'string' ? { at: d.at } : {}),
    ...(typeof d.role === 'string' && d.role ? { role: d.role.slice(0, 40) } : {}), ...(typeof d.intent === 'string' && d.intent ? { intent: d.intent.slice(0, 64) } : {}),
  };
};

/** A delivered draft as the run value it rides as: compact JSON within the run's value limit. */
export function draftFileValue(doc: TaskDocument): string {
  return JSON.stringify({
    fileKey: doc.fileKey.slice(0, MAX_KEY), name: doc.name.slice(0, 80), by: doc.by.slice(0, 40),
    ...(doc.role ? { role: doc.role.slice(0, 24) } : {}), ...(doc.intent ? { intent: doc.intent.slice(0, 48) } : {}),
  });
}

/** The assistant draft a task's versions start from: who to ask for a revision, and for which intent. */
export function draftingOf(task: Parameters<typeof documentsOf>[0]): TaskDocument | undefined {
  return documentsOf(task).find((d) => d.by.startsWith('assistant:') && d.role && d.intent);
}

/** The task's versions, oldest first: the run's delivered draft, then each one attached on its card. */
export function documentsOf(task: Pick<Task, 'workflowRun'> & { documents?: unknown }): TaskDocument[] {
  let draft: TaskDocument | undefined;
  try { draft = docOf(JSON.parse(task.workflowRun?.values?.[DRAFT_FILE_VALUE] ?? 'null')); } catch { draft = undefined; }
  const attached = Array.isArray(task.documents) ? task.documents.map(docOf).filter((d): d is TaskDocument => !!d) : [];
  return [...(draft ? [draft] : []), ...attached].slice(0, MAX_TASK_DOCUMENTS + 1);
}

/** The version an approval would approve now: the newest. */
export function latestDocument(task: Parameters<typeof documentsOf>[0]): TaskDocument | undefined {
  const all = documentsOf(task);
  return all[all.length - 1];
}

/**
 * WHETHER A KEY IS THE APPROVER'S OWN MARKDOWN UPLOAD IN THIS CONVERSATION: under `attachments/<conversation id>/<person id>/`
 * (the prefix the upload grant and the presigner write, so nobody can name another person's file as theirs), with no path
 * tricks, and a Markdown file.
 */
export function isOwnMarkdownUpload(fileKey: string, conversationId: string, personId: string): boolean {
  if (typeof fileKey !== 'string' || fileKey.length > MAX_KEY || fileKey.includes('..') || !conversationId || !personId) return false;
  return fileKey.startsWith(`attachments/${conversationId}/${personId}/`) && /\.(md|markdown)$/i.test(fileKey);
}
