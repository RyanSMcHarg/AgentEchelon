/**
 * Open work items — "what do I still owe?"
 *
 * Frontend client for GET /tasks/mine, which returns the active tasks the signed-in user OWNS, across
 * every conversation. The owner is derived server-side from the Cognito token; there is no parameter
 * for whose queue to read, so this can only ever return the caller's own.
 *
 * WHY A FETCH AND NOT A DERIVATION FROM MESSAGES. The whole point of the queue is the item the user has
 * FORGOTTEN, which by definition lives in a conversation they are not looking at. A client can only
 * derive state from conversations it has loaded, so anything message-derived is blind to exactly the
 * case this exists for.
 *
 * The URL comes from VITE_USER_TASKS_API_URL (CDK output AgentEchelonFoundations.UserTasksApiUrl).
 * Unconfigured is NOT an error: a deployment that has not wired it simply has no queue, and the caller
 * renders nothing rather than an error the user cannot act on.
 */

export interface OpenWorkItem {
  taskId: string;
  taskType: string;
  channelArn: string;
  status: string;
  taskState?: string;
  /** Human-readable, server-composed. Never empty - an unnamed item cannot be acted on. */
  title?: string;
  updatedAt?: string;
  dueBy?: string;
  /**
   * The assistant whose work this is, as a principal id. Resolved against the conversation's members
   * so an answer can be ADDRESSED to it (ADR-032): a task answer that addresses nobody reaches no
   * assistant at all, and the workflow it would unblock stays blocked with nothing showing an error.
   *
   * Absent on chains that record no assistant. The composer then sends normally.
   */
  assistantId?: string;
}

export function isOpenWorkItemsConfigured(): boolean {
  return Boolean(import.meta.env.VITE_USER_TASKS_API_URL);
}

/**
 * The caller's open items, oldest first.
 *
 * FIFO, matching how the composer already queues a duel's waiting sides: the thing asked longest ago is
 * the thing most likely forgotten, and answering in the order asked is what stops a queue becoming a
 * pile. Sorting here rather than in the UI keeps one definition of "next".
 *
 * Returns [] on any failure. A queue is an ambient affordance, not a primary flow: a failed poll must
 * not raise anything at the user, and the next poll fixes it.
 */
export async function fetchOpenWorkItems(): Promise<OpenWorkItem[]> {
  const url = import.meta.env.VITE_USER_TASKS_API_URL;
  if (!url) return [];

  const idToken = localStorage.getItem('idToken');
  if (!idToken) return [];

  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
    });
    if (!response.ok) {
      console.warn('[openWorkItems] fetch failed:', response.status);
      return [];
    }
    const body = (await response.json()) as { items?: OpenWorkItem[] };
    const items = Array.isArray(body.items) ? body.items : [];
    return [...items].sort((a, b) =>
      String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')),
    );
  } catch (error) {
    console.warn('[openWorkItems] fetch error:', error);
    return [];
  }
}
