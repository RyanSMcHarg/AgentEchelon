/**
 * HOW DEEP CONVERSATIONS NEST (DESIGN-PROCESSES O32, WT120): the one rule every way of opening a conversation from another one
 * asks, a workflow's `open` step (the router, before it asks the creator), an `open_conversation` proposal and an event opener
 * (the typed creator, before it creates anything).
 *
 *  - a conversation of a leaf type (`leaf: true`) opens nothing;
 *  - a conversation another one opened (a child) opens only one of a leaf type;
 *  - a conversation whose opener was itself opened (a grandchild) opens nothing.
 *
 * A child whose opener has no row is nested, so no chain grows from a record that cannot be followed; a row that cannot be
 * read throws, and the caller fails the open rather than deciding from a missing answer.
 */
import { isLeafType } from '../../../lib/config/conversation-types.js';
import { parentConversationOf } from './held-run.js';

/** Reads a conversation's server-side row for its type and the parent it records; throws where it could not be read. */
export type NestingRowReader = (channelArn: string) => Promise<{ conversationType?: string; parentRef?: string } | null | undefined>;

/** Whether opening a conversation of `openedType` from `channelArn` is refused as nested. */
export async function openIsNestedBy(channelArn: string, openedType: string, readRow: NestingRowReader): Promise<boolean> {
  const row = await readRow(channelArn);
  if (isLeafType(row?.conversationType)) return true;
  if (!row?.parentRef) return false;
  const parent = parentConversationOf(row.parentRef, channelArn);
  if (!parent || !isLeafType(openedType)) return true;
  const parentRow = await readRow(parent);
  return !parentRow || !!parentRow.parentRef;
}
