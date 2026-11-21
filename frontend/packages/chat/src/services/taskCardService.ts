/**
 * A task a workflow assigned to the signed-in person (ADR-063 decision 2): `POST /tasks/advance` on the person API
 * (`backend/lambda/src/user-tasks-api.ts`). The person is the caller the edge authorizer resolved, so nothing here names
 * whose choice it is; the server takes it only for the task's current assignee, in the state the card was drawn for,
 * and only a choice that state declares.
 */
import { personUrl } from '@ae/shared';

/** What a task card is drawn from: the task's id, the state it was drawn in, its choices and when it ends (epoch seconds). */
export interface TaskCardOnMessage {
  id: string; state: string; choices: string[]; expiresAt?: number; fields?: FormFieldOnCard[];
  /** It approves a document with versions: the card reads them and names the one it approves. */
  documents?: boolean;
  /** Its choices are offered at the top of the conversation, not on its message. */
  pinned?: boolean;
}

/** One version of the document a task approves: the delivered draft, or one its approver attached. */
export interface TaskDocumentOnCard { fileKey: string; name: string; by: string; at?: string }

/** One field of a form a card asks for (ADR-067 WT50): its name, what it takes, and whether it may be left empty. */
export interface FormFieldOnCard { name: string; type: 'text' | 'number' | 'yes-no'; required?: boolean }

/** The answer choice of a form: the one its fields are submitted with. */
export const FORM_ANSWER_CHOICE = 'answered';

/**
 * THE TASK CARD A MESSAGE CARRIES, lifted from its Metadata by the one function the live path and the history load both
 * use, so a reload shows the card the live message showed. Anything malformed is no card.
 */
export function taskCardFromMetadata(metadata: Record<string, unknown>): TaskCardOnMessage | undefined {
  const raw = metadata.task as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const id = typeof raw.id === 'string' && raw.id.length <= 128 ? raw.id : '';
  const state = typeof raw.state === 'string' && raw.state.length <= 64 ? raw.state : '';
  const choices = Array.isArray(raw.choices) ? raw.choices.filter((c): c is string => typeof c === 'string' && c.length <= 64).slice(0, 8) : [];
  const expiresAt = typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt) ? raw.expiresAt : undefined;
  const fields = Array.isArray(raw.fields)
    ? raw.fields.filter((f): f is FormFieldOnCard => !!f && typeof f === 'object' && typeof (f as FormFieldOnCard).name === 'string'
      && ['text', 'number', 'yes-no'].includes((f as FormFieldOnCard).type)).slice(0, 8)
      .map((f) => ({ name: f.name, type: f.type, ...(f.required ? { required: true } : {}) }))
    : [];
  return id && state && choices.length
    ? { id, state, choices, ...(expiresAt !== undefined ? { expiresAt } : {}), ...(fields.length ? { fields } : {}), ...(raw.documents === true ? { documents: true } : {}), ...(raw.pinned === true ? { pinned: true } : {}) }
    : undefined;
}

/** A refusal the server named, shown in the client's own words (tenet D11). */
export class TaskCardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TaskCardError';
    this.code = code;
  }
}

/** Take one choice on a task's card. Resolves to the state the task moved to. */
export async function chooseOnTaskCard(channelArn: string, card: TaskCardOnMessage, choice: string, answers?: Record<string, string | number | boolean>, document?: string): Promise<{ state: string }> {
  const token = localStorage.getItem('idToken');
  if (!token) throw new TaskCardError('UNAUTHENTICATED', 'Not authenticated');
  const resp = await fetch(personUrl('/tasks/advance'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channelArn, taskId: card.id, state: card.state, choice, ...(answers ? { answers } : {}), ...(document ? { document } : {}) }),
  });
  const body = await resp.json().catch(() => ({})) as { state?: string; code?: string; error?: string };
  if (!resp.ok) throw new TaskCardError(body.code || `HTTP_${resp.status}`, body.error || resp.statusText);
  return { state: body.state ?? choice };
}

/**
 * A DECISION TAKEN FROM THE PINNED BAND: the person confirmed it there, so a choice that would end its run mid-way
 * is not asked again. The task service holds the press to the step's deciding roles, read from the conversation's record.
 */
export async function decideFromBand(channelArn: string, decision: { taskId: string; state: string }, choice: string): Promise<{ state: string }> {
  const token = localStorage.getItem('idToken');
  if (!token) throw new TaskCardError('UNAUTHENTICATED', 'Not authenticated');
  const resp = await fetch(personUrl('/tasks/advance'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channelArn, taskId: decision.taskId, state: decision.state, choice, confirmed: true }),
  });
  const body = await resp.json().catch(() => ({})) as { state?: string; code?: string; error?: string };
  if (!resp.ok) throw new TaskCardError(body.code || `HTTP_${resp.status}`, body.error || resp.statusText);
  return { state: body.state ?? choice };
}

/** The versions of the document a task approves, oldest first, or one attached by its approver. */
async function documentsCall(url: string, body: Record<string, unknown>): Promise<TaskDocumentOnCard[]> {
  const token = localStorage.getItem('idToken');
  if (!token) throw new TaskCardError('UNAUTHENTICATED', 'Not authenticated');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const out = await resp.json().catch(() => ({})) as { documents?: TaskDocumentOnCard[]; code?: string; error?: string };
  if (!resp.ok) throw new TaskCardError(out.code || `HTTP_${resp.status}`, out.error || resp.statusText);
  return Array.isArray(out.documents) ? out.documents : [];
}

export const readTaskDocuments = (channelArn: string, taskId: string) => documentsCall(personUrl('/tasks/documents'), { channelArn, taskId });
export const attachTaskDocument = (channelArn: string, taskId: string, fileKey: string, name: string) =>
  documentsCall(personUrl('/tasks/documents/add'), { channelArn, taskId, fileKey, name });
/** Ask the assistant that drafted the document to revise it; its revision arrives as the next version. */
export const reviseTaskDocument = (channelArn: string, taskId: string, instructions: string) =>
  documentsCall(personUrl('/tasks/documents/revise'), { channelArn, taskId, instructions });
