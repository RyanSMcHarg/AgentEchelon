/**
 * WHAT A CONVERSATION'S TYPE TURNS OFF IS REFUSED BY THE ROUTE THAT WOULD DO IT.
 *
 * A type declares the capabilities its people have (`capabilities` in `lib/config/conversation-types.ts`): a guest's
 * room and a customer's room declare `attachments`, `sharing` and `tasks` off, because those are the deployment's
 * own people's tools. The declaration binds at the route: the presigner refuses to sign an upload, sharing refuses
 * to add a person, and the task API refuses to open a work item, in a conversation whose type turns it off. A
 * guest's narrow route set already refused those routes; a customer signs in through an ordinary issuer and reaches
 * every route, so without this the declaration enforced nothing for them.
 *
 * The type is read from the channel context row the creator wrote (never the member-writable channel Metadata), and
 * a row that cannot be read refuses: whether the capability is on is then unknown, and the route says so (503)
 * rather than acting. A conversation with no row is the ordinary type, whose capabilities are on.
 *
 * A MEETING'S CONVERSATION ALLOWS NO MORE THAN ITS ROOM. It is opened from the conversation the meeting was started in
 * (`meetingOf`), so what that room's type turns off is off in its meeting's conversation too: a meeting held from a
 * customer's room carries no attachments, sharing or tasks. The room's row is read the same way, and one that cannot be
 * read refuses.
 */
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { getConversationTypeConfig, meetingSettingsOf, resolveConversationTypeKey } from '../../../lib/config/conversation-types.js';

export type TypeCapability = 'attachments' | 'sharing' | 'tasks';

export type CapabilityAnswer =
  | { ok: true }
  | { ok: false; statusCode: 403; code: 'CAPABILITY_OFF_FOR_TYPE'; conversationType: string; capability: TypeCapability }
  | { ok: false; statusCode: 503; code: 'CONVERSATION_TYPE_UNREADABLE'; capability: TypeCapability };

type Sender = { send(command: GetItemCommand): Promise<{ Item?: Record<string, { S?: string }> }> };

let client: Sender | undefined;
const ddb = (): Sender => (client ??= new DynamoDBClient({}) as unknown as Sender);

/** May a conversation carry out `capability`, by the type its creator recorded? */
export async function typeAllows(
  channelArn: string,
  capability: TypeCapability,
  opts: { table?: string; doc?: Sender } = {},
): Promise<CapabilityAnswer> {
  const table = opts.table ?? process.env.CHANNEL_CONTEXT_TABLE ?? '';
  if (!table) {
    console.error('[TypeCapability] no channel context table is configured; refusing', { capability });
    return { ok: false, statusCode: 503, code: 'CONVERSATION_TYPE_UNREADABLE', capability };
  }
  const unreadable = (err: unknown): CapabilityAnswer => {
    console.error('[TypeCapability] the conversation type could not be read; refusing', { capability, err: (err as Error)?.name });
    return { ok: false, statusCode: 503, code: 'CONVERSATION_TYPE_UNREADABLE', capability };
  };
  const rowOf = async (arn: string): Promise<{ type: string; meetingOf?: string }> => {
    const res = await (opts.doc ?? ddb()).send(new GetItemCommand({
      TableName: table,
      Key: { channelArn: { S: arn } },
      ProjectionExpression: 'conversationType, meetingOf',
    }));
    return { type: resolveConversationTypeKey({ explicitType: res.Item?.conversationType?.S }), meetingOf: res.Item?.meetingOf?.S };
  };
  const types: string[] = [];
  try {
    const here = await rowOf(channelArn);
    types.push(here.type);
    if (meetingSettingsOf(here.type) && here.meetingOf) types.push((await rowOf(here.meetingOf)).type);
  } catch (err) {
    return unreadable(err);
  }
  const off = types.find((t) => getConversationTypeConfig(t).capabilities?.[capability] === false);
  if (off !== undefined) return { ok: false, statusCode: 403, code: 'CAPABILITY_OFF_FOR_TYPE', conversationType: off, capability };
  return { ok: true };
}

/** The response body a refusal answers with: a code the client localizes, and an English line for a caller with no locale. */
export function capabilityRefusal(answer: Exclude<CapabilityAnswer, { ok: true }>): { error: string; code: string } {
  return answer.code === 'CAPABILITY_OFF_FOR_TYPE'
    ? { error: `${answer.capability} is turned off for this kind of conversation`, code: answer.code }
    : { error: 'what this conversation allows could not be read; retry', code: answer.code };
}

/** Test seam: replace the DynamoDB client. */
export function __setTypeCapabilityClient(c: Sender | undefined): void {
  client = c;
}
