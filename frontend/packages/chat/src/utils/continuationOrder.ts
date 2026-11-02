import type { Message } from '@ae/shared';

/**
 * THE MESSAGE A CONTINUATION PART CONTINUES, or undefined when this is not a part. The one statement of
 * the rule, read by the ordering below and by the battle anchor (components/battleScorecardAnchor.ts).
 */
export function continuationParentId(m: { id?: string; continuation?: boolean; parentMessageId?: string }): string | undefined {
  return m.continuation && m.parentMessageId && m.parentMessageId !== m.id ? m.parentMessageId : undefined;
}

/**
 * SHOW A CONTINUATION WITH THE MESSAGE IT CONTINUES.
 *
 * A long answer is posted as the answer message plus continuation parts, and the parts are NEW
 * messages created when the answer is delivered. Anything created in between - a queue notice posted
 * while the turn was running - sorts between them by time, so the first half of the answer, the
 * notice, and then the second half render in that order, and the grouping (which only looks at the
 * message directly above) breaks. Measured live: the answer ended on a heading and its content
 * appeared below "Caught up - I have read those 3 messages."
 *
 * So each continuation is moved to directly after its parent (and after any earlier parts of the same
 * parent), keyed on the `parentMessageId` the backend declares. A part whose parent is not in the list
 * stays where time put it.
 */
export function orderContinuations<T extends Pick<Message, 'id' | 'continuation' | 'parentMessageId' | 'part'>>(
  messages: T[],
): T[] {
  const ids = new Set(messages.map((m) => m.id));
  const partsByParent = new Map<string, T[]>();
  for (const m of messages) {
    const parent = continuationParentId(m);
    if (parent && ids.has(parent)) {
      const parts = partsByParent.get(parent) ?? [];
      parts.push(m);
      partsByParent.set(parent, parts);
    }
  }
  if (!partsByParent.size) return messages;
  const moved = new Set<T>();
  for (const parts of partsByParent.values()) {
    parts.sort((a, b) => (a.part ?? 0) - (b.part ?? 0));
    for (const p of parts) moved.add(p);
  }
  const out: T[] = [];
  for (const m of messages) {
    if (moved.has(m)) continue;
    out.push(m);
    const parts = partsByParent.get(m.id);
    if (parts) out.push(...parts);
  }
  return out;
}
