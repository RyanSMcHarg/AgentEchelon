/**
 * A message the client sends as the ANSWER to a task step (ADR-030, ADR-031).
 *
 * THE HOLE THIS FILLS. In a shared conversation, a message that mentions nobody reaches no assistant:
 * `InvokedBy` routes on mentions, silence-by-default is the rule everywhere else, and that rule is
 * right - an assistant must not answer un-addressed chatter. But a person answering a question an
 * assistant asked them is not chatter, and they have no reason to know they were supposed to address
 * it. Their answer lands in the channel, nothing runs, and the workflow they were unblocking stays
 * blocked. Nothing errors; the conversation simply stops.
 *
 * WHERE THIS IS READ, AND WHERE IT IS NOT (ADR-032). NOT on the critical path. The client addresses a
 * task answer at send, and a message arriving without that is a CLIENT DEFECT - so the repair belongs
 * on the message stream, after delivery, where it costs latency only in the broken case and where a
 * counter can say how often the client is getting it wrong. Repairing it in the channel flow would
 * make the correct path and the broken path indistinguishable, and the repair would quietly become the
 * primary path.
 *
 * WHY METADATA AND NOT `Target` FOR THE DETECTION. A `Target` says who may SEE a message; it does not
 * say what the message is about, and the stream would have to reconstruct that from ownership anyway.
 * The task reference states it directly. (A channel flow could not use `Target` for this in any case:
 * it can neither read one - the callback delivers none, tracker row 94 - nor set one, since
 * `ChannelMessageCallback` carries `MessageId`, `Content`, `Metadata`, `PushNotification`,
 * `MessageAttributes` and `SubChannelId`, and no `Target`.)
 *
 * WHAT IT IS, AND WHAT IT IS NOT. It is a DETECTION hint: it says the client believes this message
 * answers a specific task. It is not authority for anything that follows from that - not that the
 * task exists, not who owns it, and not that this person may answer it.
 *
 * IT IS UNTRUSTED, and cannot be otherwise - message metadata is written by the sender. Nothing here
 * validates; the consumer does (`task-answer-repair.ts`), and the turn it dispatches does again:
 *   - the task is READ, and a hint naming a task that does not exist in this channel repairs nothing;
 *   - the assistant comes off that row, never off the hint, so naming one buys nothing;
 *   - the bot identity the turn answers as goes through `isSanctionedBattleBot`, the same gate that
 *     stops a caller-supplied bot ARN becoming an impersonation seam;
 *   - the turn then resolves what the message answers from the chain (ADR-030), so a hint pointing at
 *     someone else's task does not make it this person's answer.
 * So a forged hint buys nothing a member did not already have: they can address any assistant in the
 * conversation directly, which is what a mention is.
 */

/** The hint, once it has survived parsing. */
export interface TaskAnswerHint {
  /**
   * The task this message answers. The WHOLE hint, deliberately.
   *
   * THE ASSISTANT IS NOT CARRIED HERE, and must not be. A task already records `assistantId` - whose
   * work it is, fixed for the task's life - so a copy in message metadata is a second source for one
   * fact, free to disagree with the row it describes. The consumer reads the assistant off the task.
   *
   * That is cheaper as well as sounder, which is what settles it. A wrong copy would not merely be
   * corrected: it would dispatch a turn to the wrong assistant, which then hands over and sends the
   * person a redirection receipt - a whole extra turn. Reading the task costs one point read, on a
   * path that only runs when something is already broken.
   *
   * What the id DOES carry cannot be derived: it is the client stating that this message is an ANSWER
   * to a specific piece of work. Without it, "the sender holds an open task in this channel" would be
   * the trigger, and an ordinary remark would be annexed into work the person was not talking about.
   */
  taskId: string;
}

/**
 * The task-answer hint carried by a message's metadata, or undefined.
 *
 * Undefined on anything malformed rather than throwing, in both directions: unparseable JSON, a
 * missing block, a non-string id. This runs on the path every message crosses, and a metadata blob it
 * cannot read must degrade to "an ordinary message" rather than fail a delivery. The cost of being
 * wrong here is the hang this exists to fix, which is recoverable by addressing an assistant directly;
 * the cost of throwing is every message in the conversation.
 */
export function extractTaskAnswerHint(metadataJson?: string): TaskAnswerHint | undefined {
  if (!metadataJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return undefined;
  }
  const task = (parsed as { task?: unknown } | null)?.task as { id?: unknown } | undefined;
  if (!task || typeof task.id !== 'string' || task.id.length === 0) return undefined;
  // The id and nothing else. Anything further a client puts here is ignored rather than carried, so a
  // second copy of a fact the task already holds cannot enter the system by being sent.
  return { taskId: task.id };
}
