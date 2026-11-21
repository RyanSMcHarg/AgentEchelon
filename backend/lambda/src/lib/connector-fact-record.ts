/**
 * WHETHER THE CONNECTOR RECEIVER'S OWN RECORD SAYS WHAT A FACT SAYS (DESIGN-EVENT-TARGETS 11.2 and 11.3).
 *
 * Any principal in the account can put an event on the default bus, a connector fact's source included, so a person or a
 * conversation a fact names is trusted only where the receiver's replay record, which no other principal writes, says the same:
 * the event was published, at this classification, admitting exactly that one person, or naming exactly that conversation.
 * A record that cannot be read confirms nothing.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

export interface FactRecordDeps {
  /** The receiver's replay table, by name. */
  table?: () => Promise<string | undefined>;
  get?: (table: string, pk: string) => Promise<Record<string, unknown> | undefined>;
}

const ID = /^[A-Za-z0-9._:@-]{1,256}$/;
let tableName: Promise<string | undefined> | undefined;

async function replayTable(): Promise<string | undefined> {
  // THE PARAMETER THE CONNECTORS STACK WRITES (`CONNECTOR_REPLAY_TABLE_PARAM`), under this deployment's root: derived, not passed, so
  // it costs the router's environment nothing.
  const param = `${process.env.SSM_ROOT || '/agent-echelon'}/connectors/replay-table-name`;
  tableName ??= new SSMClient({}).send(new GetParameterCommand({ Name: param })).then((r) => r.Parameter?.Value, () => { tableName = undefined; return undefined; });
  return tableName;
}

let doc: DynamoDBDocumentClient | undefined;
async function getRecord(table: string, pk: string): Promise<Record<string, unknown> | undefined> {
  doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return (await doc.send(new GetCommand({ TableName: table, Key: { pk }, ConsistentRead: true })))?.Item;
}

/** Whether the receiver published this connector's event at this classification, admitting `person` alone, or naming `conversation`. */
export async function connectorRecordConfirms(
  fact: { connectorId: string; eventId: string; classification: string },
  expect: { person?: string; conversation?: string },
  deps: FactRecordDeps = {},
): Promise<boolean> {
  if (!ID.test(fact.connectorId) || !ID.test(fact.eventId) || (!expect.person && !expect.conversation)) return false;
  const table = await (deps.table ?? replayTable)();
  if (!table) return false;
  const rec = await (deps.get ?? getRecord)(table, `${fact.connectorId}#${fact.eventId}`).catch(() => undefined);
  if (!rec || rec.state !== 'published' || rec.factClassification !== fact.classification) return false;
  if (expect.person !== undefined) {
    const people = Array.isArray(rec.admittedPeople) ? rec.admittedPeople : [];
    if (people.length !== 1 || people[0] !== expect.person) return false;
  }
  if (expect.conversation !== undefined && rec.namedConversation !== expect.conversation) return false;
  return true;
}
