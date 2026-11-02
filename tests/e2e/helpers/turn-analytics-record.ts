/**
 * A TURN'S OWN RECORD OF WHAT IT DID, as the processor writes it to the message-analytics table under the reply's
 * message id: the turn's `steps[]`, each with its start and end and the outcome of every tool the model called in it
 * (`name`, `ok`, and for a failure the bounded `errorClass`, with `refusal` naming the rule a workflow refusal ran
 * into). This is the record the archive projects, read before it is projected, and it does not depend on how the
 * model phrased the reply. Aurora mode writes it; a deployment without the table has no such record.
 */
import { awsv } from './aws';
import { physicalIdsIn, stackName } from './stack-prefix';
import { unmarshalItem } from './task-backend';
import { noteProgress } from './watchdog/current';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One tool call's outcome on a step. */
export interface ToolOutcome { name: string; ok: boolean; errorClass?: string; refusal?: string }
/** One step of a turn. */
export interface TurnStep { stepLabel?: string; startedAt?: string; endedAt?: string; tools?: ToolOutcome[] }
/** The record, with the fields a spec reads. */
export interface TurnAnalyticsRecord { messageId: string; channelArn: string; steps: TurnStep[]; [k: string]: unknown }

let cachedTable = '';
/** The message-analytics table, read from the Archive stack by type and logical id. Throws when it has none. */
export function messageAnalyticsTable(): string {
  if (cachedTable) return cachedTable;
  const [name] = physicalIdsIn([stackName('Archive')], { type: 'AWS::DynamoDB::Table', logicalId: /^MessageAnalyticsTable/ });
  if (!name) throw new Error(`${stackName('Archive')} has no message-analytics table (it is written in Aurora mode)`);
  cachedTable = name;
  return name;
}

/**
 * The record for one reply, once it is written. Read on an interval: it is written beside the reply, and its write
 * raises no event the runner can subscribe to. Undefined when it does not appear within `ms`.
 */
export async function turnAnalyticsRecord(messageId: string, ms = 60_000): Promise<TurnAnalyticsRecord | undefined> {
  const table = messageAnalyticsTable();
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(3_000)) {
    let item: Record<string, any> | undefined;
    try {
      item = awsv(['dynamodb', 'get-item', '--table-name', table, '--key', JSON.stringify({ messageId: { S: messageId } })], { quiet: true })?.Item;
    } catch { /* read again */ }
    if (item) {
      noteProgress('harness', `the turn record of ${messageId} is written`);
      const record = unmarshalItem(item);
      return { ...record, messageId, channelArn: String(record.channelArn ?? ''), steps: Array.isArray(record.steps) ? record.steps : [] };
    }
  }
  return undefined;
}

/** Every tool outcome of the given turns, in the order the steps ran (by start, then by position within a step). */
export function toolOutcomesInOrder(records: TurnAnalyticsRecord[]): Array<ToolOutcome & { at: string; messageId: string }> {
  const steps = records.flatMap((r) => r.steps.map((s, i) => ({ s, i, messageId: r.messageId })));
  steps.sort((a, b) => String(a.s.startedAt ?? '').localeCompare(String(b.s.startedAt ?? '')) || a.i - b.i);
  return steps.flatMap(({ s, messageId }) => (s.tools ?? []).map((t) => ({ ...t, at: String(s.startedAt ?? ''), messageId })));
}
