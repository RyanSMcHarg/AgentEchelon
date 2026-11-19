/**
 * THE TURN'S OWN RECORD of what it did, written by the processor to the message-analytics table under the
 * reply's message id: the model that ran, its tokens, whether a guardrail stopped it or a fallback answered
 * for it, the tools that ran and the passages retrieved. This is the evidence a reply rests on, and it does
 * not depend on how the model phrased the reply. Waited for, because the record is written beside the reply
 * rather than before it.
 */
import { aws, awsv } from './aws';

/** A DynamoDB item as the service returns it (`{ field: { S | N | BOOL | L | M: ... } }`). */
export type RecordItem = Record<string, any>;

let table: string | undefined;

function analyticsTable(): string {
  if (table) return table;
  const names: string[] = aws('dynamodb list-tables --query "TableNames"') || [];
  table = names.find((n) => /MessageAnalytics/i.test(n));
  if (!table) throw new Error('no message-analytics table in this deployment');
  return table;
}

/** The record for one reply, waited for up to `timeoutMs`. Throws when none arrives. */
export async function turnRecord(messageId: string, timeoutMs = 60_000): Promise<RecordItem> {
  const t = analyticsTable();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // argv, not a shell string: the key is JSON, and a shell would eat its quotes.
    let r: any = null;
    try { r = awsv(['dynamodb', 'get-item', '--table-name', t, '--key', JSON.stringify({ messageId: { S: messageId } })]); } catch { /* read again */ }
    if (r?.Item) return r.Item as RecordItem;
    await new Promise((res) => setTimeout(res, 3_000));
  }
  throw new Error(`no analytics record for message ${messageId} in ${t} within ${Math.round(timeoutMs / 1000)}s`);
}

/** One field of a record as a plain value: a string, number, boolean or list of strings; undefined when absent. */
export function field(item: RecordItem, name: string): string | number | boolean | string[] | undefined {
  const v = item[name];
  if (!v) return undefined;
  if ('S' in v) return v.S;
  if ('N' in v) return Number(v.N);
  if ('BOOL' in v) return v.BOOL;
  if ('L' in v) return (v.L as any[]).map((e) => e.S ?? JSON.stringify(e));
  if ('SS' in v) return v.SS;
  return JSON.stringify(v);
}
