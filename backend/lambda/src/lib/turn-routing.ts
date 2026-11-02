/**
 * THE ROUTING RECORD: WHICH ASSISTANT A TURN WAS ROUTED TO (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
 *
 * The router decides which assistant answers a message. That decision has to reach the processor, which
 * runs the turn in another invocation, in a form the processor cannot rewrite. Credentials do not
 * cross an invoke, and a field in the invoke payload is whatever the invoker put there. So the router
 * writes the decision here, keyed by the turn's correlation id, and the vend - the only principal that
 * may mint an assistant session - reads it back. The processor never names an assistant; it hands the
 * vend a correlation id and gets the session the router's decision allows.
 *
 * WHO WRITES IT: the router, and the battle orchestrator for a duel's rebuttal round, which is the
 * routing decision for that round. Nothing else holds `PutItem` on the table, and IAM is what says so.
 *
 * ONE DECISION PER TURN. A second write for the same correlation id must name the same bot, so a turn
 * already in flight cannot be re-pointed at another assistant by a later write.
 */
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import type { GrantVariant } from './assistant-grant.js';

/**
 * How long a record outlives the turn that wrote it. Long enough for every re-entry of that turn - a
 * failure retry, a parked turn resumed after the person answers, a triage pass - and short enough that
 * the table holds days, not history.
 */
export const TURN_ROUTING_TTL_SECONDS = 7 * 24 * 3600;

export interface TurnRouting {
  correlationId: string;
  /** The AppInstanceBot the turn answers as. The assistant and its role are read from the assignment
   *  records by the vend, not trusted from here. */
  botArn: string;
  classification: string;
  /**
   * The conversation the turn is in, when the writer knows it. The classification's turn data plane
   * serves a channel-keyed read only for the channel the routed turn names, so a session of one
   * classification cannot read another conversation's summary or drift state by naming it.
   */
  channelArn?: string;
  /**
   * What a running experiment or battle variant adds to this turn: its model, image model, and for a
   * `profileRef` variant its whole definition. The vend narrows the session to the variant's reach
   * rather than the assistant's, because the variant is what the turn serves (`assistant-grant.ts`).
   */
  variant?: GrantVariant;
  createdAt: string;
  /** Epoch seconds; the table's TTL attribute. */
  expiresAt: number;
}

export async function recordTurnRouting(
  client: Pick<DynamoDBClient, 'send'>,
  tableName: string,
  input: { correlationId: string; botArn: string; classification: string; channelArn?: string; variant?: GrantVariant; now?: number },
): Promise<void> {
  if (!tableName) throw new Error('recordTurnRouting: no routing table configured');
  if (!input.correlationId || !input.botArn || !input.classification) {
    throw new Error('recordTurnRouting: a routing record needs a correlation id, a bot and a classification');
  }
  const now = input.now ?? Date.now();
  try {
    await client.send(new PutItemCommand({
      TableName: tableName,
      Item: {
        correlationId: { S: input.correlationId },
        botArn: { S: input.botArn },
        classification: { S: input.classification },
        ...(input.channelArn ? { channelArn: { S: input.channelArn } } : {}),
        ...(input.variant ? { variant: { S: JSON.stringify(input.variant) } } : {}),
        createdAt: { S: new Date(now).toISOString() },
        expiresAt: { N: String(Math.floor(now / 1000) + TURN_ROUTING_TTL_SECONDS) },
      },
      ConditionExpression: 'attribute_not_exists(correlationId) OR botArn = :bot',
      ExpressionAttributeValues: { ':bot': { S: input.botArn } },
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException
      || (err as { name?: string })?.name === 'ConditionalCheckFailedException') {
      throw new Error(`recordTurnRouting: turn ${input.correlationId} is already routed to another assistant`);
    }
    throw err;
  }
}

export async function readTurnRouting(
  client: Pick<DynamoDBClient, 'send'>,
  tableName: string,
  correlationId: string,
  now: number = Date.now(),
): Promise<TurnRouting | null> {
  if (!tableName || !correlationId) return null;
  const res = await client.send(new GetItemCommand({
    TableName: tableName,
    Key: { correlationId: { S: correlationId } },
    // Strongly consistent: the router writes immediately before it invokes, and an eventually
    // consistent read could miss the record and refuse a legitimate turn.
    ConsistentRead: true,
  }));
  const item = res.Item;
  if (!item?.botArn?.S || !item.classification?.S) return null;
  const expiresAt = Number(item.expiresAt?.N || '0');
  // TTL deletion is lazy, so an expired record can still be read. It is refused here instead.
  if (expiresAt && expiresAt * 1000 < now) return null;
  return {
    correlationId,
    botArn: item.botArn.S,
    classification: item.classification.S,
    ...(item.channelArn?.S ? { channelArn: item.channelArn.S } : {}),
    ...(item.variant?.S ? { variant: parseVariant(item.variant.S) } : {}),
    createdAt: item.createdAt?.S || '',
    expiresAt,
  };
}

/** A stored variant, or nothing when it cannot be read: an unreadable variant narrows by the assistant's own definition. */
function parseVariant(raw: string): GrantVariant | undefined {
  try {
    const v = JSON.parse(raw) as GrantVariant;
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}
