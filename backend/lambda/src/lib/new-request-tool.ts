/**
 * A NEW REQUEST MID-TASK OPENS ITS OWN TASK (ADR-067 Appendix A, G15; WT106).
 *
 * A person's message reaches their live task's turn first (continue before trigger), where the model judges whether it
 * is about the task. When it reads the message as a new request for a different multi-step intent, it calls
 * `open_new_request` naming that intent, and the platform opens the request as its own task, as if it had arrived alone:
 * for the person who sent it, holding their message, under that intent, and the router starts the intent's workflow on
 * it. The task the turn is on does not move and keeps waiting.
 *
 * WHAT IT GUARANTEES:
 *  - A CLOSED SET. The intent is one of the multi-step intents the turn's own pack declares, other than the task's own,
 *    enumerated in the tool's schema and checked again when the call arrives: the enum constrains a model, the check is
 *    the boundary.
 *  - ONCE PER TURN. One message is one request: a second call on the same turn is refused.
 *  - THE PERSON'S OWN. The task is for the message's sender, and as private as their message: its stored Target decides,
 *    and a message whose Target cannot be read opens a private request (`requestVisibility`, ADR-033).
 *
 * Pure: the opening itself is the caller's (`assistant-async-processor.ts`), through the task service.
 */

export const OPEN_NEW_REQUEST_TOOL_NAME = 'open_new_request';

/** The longest the request line may be, which names the task in the person's list. */
export const MAX_NEW_REQUEST_LINE = 300;

/**
 * THE INTENTS A NEW REQUEST MAY BE OPENED UNDER: the pack's multi-step intents, in declaration order, other than the
 * task's own type and the intent that opened it. Empty, the tool is not offered.
 */
export function newRequestIntents(
  pack: { intents?: ReadonlyArray<{ key: string; delivery?: string }> } | undefined,
  current: { taskType?: string; openingIntent?: string },
): string[] {
  const own = new Set([current.taskType, current.openingIntent].filter((v): v is string => !!v));
  return (pack?.intents ?? [])
    .filter((i) => i.delivery === 'TASK_MULTI_STEP' && !own.has(i.key))
    .map((i) => i.key);
}

/** The tool as the model is offered it: the intents as an enum, and one line naming the request. */
export function openNewRequestToolSpec(intents: readonly string[]) {
  return {
    toolSpec: {
      name: OPEN_NEW_REQUEST_TOOL_NAME,
      description:
        'Open the person\'s message as a separate request when it asks for a different piece of work than the task you '
        + 'are on, of one of the kinds listed. The current task does not move and keeps waiting. Call it at most once, '
        + 'only when the message clearly asks for that new work; a question or a remark about the current task is not '
        + 'a new request. Then tell the person, in your reply, that the new request is open.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            intent: { type: 'string', enum: [...intents], description: 'What kind of work the new request is.' },
            request: { type: 'string', description: `One line naming the new request in the person's own terms, at most ${MAX_NEW_REQUEST_LINE} characters.` },
          },
          required: ['intent', 'request'],
        },
      },
    },
  } as const;
}

/** The request a call names, held to the offered intents; or why it is refused, which the model reads. */
export function newRequestOf(
  input: Record<string, unknown> | undefined,
  intents: readonly string[],
): { intent: string; request: string } | { error: string } {
  const intent = typeof input?.intent === 'string' ? input.intent.trim() : '';
  const request = typeof input?.request === 'string' ? input.request.trim().slice(0, MAX_NEW_REQUEST_LINE) : '';
  if (!intents.includes(intent)) return { error: `intent must be one of: ${intents.join(', ')}` };
  if (!request) return { error: 'request is one line naming the new request' };
  return { intent, request };
}
