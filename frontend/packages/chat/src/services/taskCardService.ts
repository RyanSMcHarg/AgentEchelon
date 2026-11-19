/**
 * A task a workflow assigned to the signed-in person (ADR-063 decision 2): `POST /tasks/advance` on the person API
 * (`backend/lambda/src/user-tasks-api.ts`). The person is the caller the edge authorizer resolved, so nothing here names
 * whose choice it is; the server takes it only for the task's current assignee, in the state the card was drawn for,
 * and only a choice that state declares.
 */
import { personUrl } from '@ae/shared';

/** What a task card is drawn from: the task's id, the state it was drawn in, its choices and when it ends (epoch seconds). */
export interface TaskCardOnMessage { id: string; state: string; choices: string[]; expiresAt?: number; fields?: FormFieldOnCard[] }

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
  return id && state && choices.length ? { id, state, choices, ...(expiresAt !== undefined ? { expiresAt } : {}), ...(fields.length ? { fields } : {}) } : undefined;
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
export async function chooseOnTaskCard(channelArn: string, card: TaskCardOnMessage, choice: string, answers?: Record<string, string | number | boolean>): Promise<{ state: string }> {
  const token = localStorage.getItem('idToken');
  if (!token) throw new TaskCardError('UNAUTHENTICATED', 'Not authenticated');
  const resp = await fetch(personUrl('/tasks/advance'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ channelArn, taskId: card.id, state: card.state, choice, ...(answers ? { answers } : {}) }),
  });
  const body = await resp.json().catch(() => ({})) as { state?: string; code?: string; error?: string };
  if (!resp.ok) throw new TaskCardError(body.code || `HTTP_${resp.status}`, body.error || resp.statusText);
  return { state: body.state ?? choice };
}
