/**
 * THE ASSISTANT A TURN IS ACTING AS, HELD AS A SESSION (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
 *
 * A turn acts as the assistant it was routed to. The session comes from the vend (`assistant-vend.ts`),
 * which mints it only for a turn the router routed, and everything the turn does after that goes out
 * on it: every AWS client a turn uses is wrapped by `turnAware`, which sends through a client built on
 * the session while one is held and through the Lambda's own role otherwise.
 *
 * THE LAMBDA'S OWN ROLE IS BOOTSTRAP ONLY. It can invoke the vend and little else, so a call made
 * before the session is held, or on a path that never asked for one, is refused by IAM rather than
 * quietly made as some wider identity. That is what makes "fail closed" a property of the deployment
 * and not a promise of this code.
 *
 * ONE TURN, ONE SESSION. `releaseAssistantSession` runs between turns so a warm container never lets
 * one turn's identity serve the next.
 */
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, type TranslateConfig } from '@aws-sdk/lib-dynamodb';
import { SPEAK_ROUTE_PREFIX } from './assistant-grant.js';
import type { AssistantProfile } from '../../../lib/config/profiles.js';

const REGION = process.env.AWS_REGION || 'us-east-1';

/** On the Lambda's own role, deliberately: asking the vend is the one thing the bootstrap role is for.
 *  Built on first use, so importing this module constructs no client. */
let bootstrapLambda: LambdaClient | null = null;
const bootstrap = (): LambdaClient => (bootstrapLambda ??= new LambdaClient({ region: REGION }));

export interface AssistantSession {
  assistant: string;
  role: string;
  botArn: string;
  credentials: AwsCredentialIdentity;
  /**
   * The routing record this session was minted from. A service that serves a turn on the assistant's
   * behalf (the classification's turn data plane) is handed this id and checks the record itself, so it
   * acts only for a turn something routed.
   */
  routeId?: string;
  /** The approved definition version the vend narrowed the session by; the turn serves exactly this. */
  definition?: { profileName: string; version: number };
  /** A runtime assistant's seed from its own record (ADR-048), as the vend built it. */
  seed?: AssistantProfile;
}

let current: AssistantSession | null = null;
/**
 * WHAT THE SESSION COVERS.
 *
 * `turn`: every wrapped client - the processor, which runs the turn as the assistant end to end.
 * `messaging`: only the conversation clients - the router and the channel flow, which decide routing
 * on their own roles and speak in the conversation as the assistant they routed to.
 */
export type SessionScope = 'turn' | 'messaging';
let scope: SessionScope = 'turn';
/** Bumped whenever the session changes, so wrapped clients rebuild rather than reuse a stale one. */
let epoch = 0;

export class AssistantSessionRefused extends Error {
  constructor(public readonly reason: string) {
    super(`the vend refused an assistant session: ${reason}`);
    this.name = 'AssistantSessionRefused';
  }
}

/**
 * Ask the vend for the session this turn was routed to. Throws when it refuses or cannot be reached:
 * there is no fallback identity to answer with.
 */
export async function vendAssistantSession(
  correlationId: string,
  deps?: { lambda?: Pick<LambdaClient, 'send'>; vendArn?: string },
): Promise<AssistantSession> {
  const vendArn = deps?.vendArn ?? process.env.ASSISTANT_VEND_ARN ?? '';
  if (!vendArn) throw new AssistantSessionRefused('no vend configured for this function');
  if (!correlationId) throw new AssistantSessionRefused('no correlation id');
  const res = await (deps?.lambda ?? bootstrap()).send(new InvokeCommand({
    FunctionName: vendArn,
    InvocationType: InvocationType.RequestResponse,
    Payload: Buffer.from(JSON.stringify({ correlationId })),
  }));
  if (res.FunctionError) {
    throw new AssistantSessionRefused(`the vend failed (${res.FunctionError})`);
  }
  const body = JSON.parse(Buffer.from(res.Payload ?? new Uint8Array()).toString('utf8') || '{}') as {
    ok?: boolean; reason?: string; assistant?: string; role?: string; botArn?: string;
    definition?: { profileName?: string; version?: number };
    seed?: AssistantProfile;
    credentials?: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; expiration?: string };
  };
  const c = body.credentials;
  if (!body.ok || !body.assistant || !body.role || !body.botArn || !c?.accessKeyId || !c.secretAccessKey || !c.sessionToken) {
    throw new AssistantSessionRefused(body.reason || 'the vend returned no session');
  }
  return {
    assistant: body.assistant,
    role: body.role,
    botArn: body.botArn,
    routeId: correlationId,
    ...(body.definition?.profileName && typeof body.definition.version === 'number'
      ? { definition: { profileName: body.definition.profileName, version: body.definition.version } }
      : {}),
    ...(body.seed?.name === body.assistant ? { seed: body.seed } : {}),
    credentials: {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
      ...(c.expiration ? { expiration: new Date(c.expiration) } : {}),
    },
  };
}

/** Act as this session for the rest of the turn, over every client or over conversation clients only. */
export function adoptAssistantSession(session: AssistantSession, sessionScope: SessionScope = 'turn'): void {
  current = session;
  scope = sessionScope;
  epoch += 1;
}

/** Drop the session. Called between turns. */
export function releaseAssistantSession(): void {
  current = null;
  scope = 'turn';
  epoch += 1;
}

/** The session this turn is acting as, or null when none is held. */
export function currentAssistantSession(): AssistantSession | null {
  return current;
}

/**
 * WORK A TURN STARTED AND STOPPED WAITING FOR, which still finishes on the turn's session.
 *
 * A call that loses a race against its deadline keeps running: its model reply arrives later and its output
 * guardrail and any fallback model call are sent after it. Every one of those sends reads the session at the
 * moment it is made. So the turn keeps its session until that work has settled (`heldWorkSettled`, awaited
 * before the session is released): a late call finishes as the assistant that started it, never on the
 * Lambda's own role and never on the next turn's session in a warm container.
 */
const held = new Set<Promise<void>>();

/** Keep the session for this work: the turn's end waits for it to settle. Its result and error are discarded. */
export function holdSessionFor(work: Promise<unknown>): void {
  const settled: Promise<void> = work.then(() => undefined, () => undefined);
  held.add(settled);
  void settled.then(() => { held.delete(settled); });
}

/** Resolves once every piece of held work has settled, including work held while waiting. */
export async function heldWorkSettled(): Promise<void> {
  while (held.size) await Promise.all([...held]);
}

/**
 * End an invocation's identity: held work settles, then the session is released. The one end of a turn for every
 * function that adopts a session (the processor's `endAssistantTurn`, the router's handler), so nothing an invocation
 * started runs after its session ends or inside the next invocation's.
 */
export async function releaseAfterHeldWork(): Promise<void> {
  await heldWorkSettled();
  releaseAssistantSession();
}

/**
 * Wrap a client so its `send` goes out on the turn's session while one is held.
 *
 * `make` builds the same client with given credentials; it is called once per session and the result
 * is reused for the rest of that turn. Everything other than `send` - config, middleware, `destroy` -
 * is the ambient client's, which is what a caller reading configuration expects.
 *
 * WHY NOT A CREDENTIAL PROVIDER ON ONE CLIENT: the SDK memoizes a resolved identity until it nears
 * expiry, so a provider that changes per turn would keep serving the first turn's session to the next.
 * A client per session cannot.
 */
export function turnAware<C extends { send: (...args: never[]) => unknown }>(
  ambient: C,
  make: (credentials: AwsCredentialIdentity) => C,
  opts: { conversation?: boolean } = {},
): C {
  let built: { epoch: number; client: C } | null = null;
  const pick = (): C => {
    if (!current) return ambient;
    if (scope === 'messaging' && !opts.conversation) return ambient;
    if (!built || built.epoch !== epoch) built = { epoch, client: make(current.credentials) };
    return built.client;
  };
  return new Proxy(ambient, {
    get(target, prop, receiver) {
      if (prop === 'send') {
        return (...args: never[]) => (pick().send as (...a: never[]) => unknown)(...args);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * A client that sends on the turn's session while one is held: `new Ctor(config)` otherwise, and
 * `new Ctor({ ...config, credentials })` per session.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sessionClient<T extends new (...args: any[]) => { send: (...args: never[]) => unknown }>(
  Ctor: T,
  config: NonNullable<ConstructorParameters<T>[0]>,
): InstanceType<T> {
  return turnAware(
    new Ctor(config) as InstanceType<T>,
    (credentials) => new Ctor({ ...config, credentials }) as InstanceType<T>,
    // The conversation clients: what a messaging-scoped session covers.
    { conversation: Ctor.name === 'ChimeSDKMessagingClient' },
  );
}

/** The DynamoDB document client form of `sessionClient`. */
export function sessionDocumentClient(
  config: DynamoDBClientConfig = {},
  translateConfig?: TranslateConfig,
): DynamoDBDocumentClient {
  return turnAware(
    DynamoDBDocumentClient.from(new DynamoDBClient(config), translateConfig),
    (credentials) => DynamoDBDocumentClient.from(new DynamoDBClient({ ...config, credentials }), translateConfig),
  );
}

/**
 * FOR A ROUTING SERVICE (the router, the channel flow): record which bot this invocation speaks as, and
 * act as that assistant in the conversation for the rest of the invocation.
 *
 * The service is the routing authority, so it writes its own decision under an invocation-scoped id and
 * asks the vend for the session that decision allows. Only conversation clients switch to it; the
 * service's routing reads stay on its own role.
 */
export async function speakAsRoutedAssistant(
  input: { routeId: string; botArn: string; classification: string; tableName: string; vendArn?: string; channelArn?: string },
  deps: { ddb: Pick<DynamoDBClient, 'send'>; lambda?: Pick<LambdaClient, 'send'> },
): Promise<AssistantSession> {
  const { recordTurnRouting } = await import('./turn-routing.js');
  await recordTurnRouting(deps.ddb, input.tableName, {
    correlationId: input.routeId,
    botArn: input.botArn,
    classification: input.classification,
    ...(input.channelArn ? { channelArn: input.channelArn } : {}),
  });
  const session = await vendAssistantSession(input.routeId, {
    ...(deps.lambda ? { lambda: deps.lambda } : {}),
    ...(input.vendArn ? { vendArn: input.vendArn } : {}),
  });
  adoptAssistantSession(session, 'messaging');
  return session;
}

/**
 * FOR A ROUTING SERVICE THAT SPEAKS AS SEVERAL ASSISTANTS IN ONE INVOCATION (the channel flow, the battle
 * orchestrator): a session for one assistant, minted from a decision this service records itself, without
 * adopting it. The caller builds its own client on the credentials, so two assistants answering in
 * parallel never share one.
 *
 * `vendArn` and `tableName` are the target classification's: a service serving several classifications
 * resolves them per conversation.
 */
export async function sessionForRoutedAssistant(
  input: { routeId: string; botArn: string; classification: string; tableName: string; vendArn: string; channelArn?: string; variant?: import('./assistant-grant.js').GrantVariant },
  deps: { ddb: Pick<DynamoDBClient, 'send'>; lambda?: Pick<LambdaClient, 'send'> },
): Promise<AssistantSession> {
  const { recordTurnRouting } = await import('./turn-routing.js');
  await recordTurnRouting(deps.ddb, input.tableName, {
    correlationId: input.routeId,
    botArn: input.botArn,
    classification: input.classification,
    ...(input.channelArn ? { channelArn: input.channelArn } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
  });
  return vendAssistantSession(input.routeId, {
    ...(deps.lambda ? { lambda: deps.lambda } : {}),
    vendArn: input.vendArn,
  });
}

/** Per container: each classification's vend, which does not change between deploys. */
const vendArnCache = new Map<string, string>();

/**
 * A CLIENT THAT SPEAKS AS ONE ASSISTANT, FOR A PLATFORM SERVICE OUTSIDE A USER TURN: a scheduled
 * briefing, a join notice, a Battle Mode notice, a conversation split's link in its parent.
 *
 * The service decides who speaks, records that decision in the classification's routing table under an
 * id of its own, and asks that classification's vend for the session the decision allows. The session can
 * act as this one bot, in this classification's conversations; the service's own role holds no Amazon
 * Chime SDK bearer grant at all (`speakAsAssistantStatements` in `agent-classification-common.ts`).
 *
 * Reads `TURN_ROUTING_TABLE_PREFIX` and `SSM_ROOT` from the environment, and refuses without them rather
 * than falling back to the function's own role.
 */
type SpeakAsDeps = {
  ddb?: Pick<DynamoDBClient, 'send'>;
  lambda?: Pick<LambdaClient, 'send'>;
  ssm?: { send: (cmd: unknown) => Promise<{ Parameter?: { Value?: string } }> };
};

export async function messagingClientAsAssistant(
  input: { botArn: string; classification: string; purpose: string },
  deps: SpeakAsDeps = {},
): Promise<import('@aws-sdk/client-chime-sdk-messaging').ChimeSDKMessagingClient> {
  const session = await sessionAsAssistant(input, deps);
  const { ChimeSDKMessagingClient } = await import('@aws-sdk/client-chime-sdk-messaging');
  return new ChimeSDKMessagingClient({ region: REGION, credentials: session.credentials });
}

/**
 * The same session, ADOPTED for this invocation's conversation clients (`messaging` scope): for a
 * service whose reads and edits run through shared modules that already send on `sessionClient`.
 * The caller releases it with `releaseAssistantSession` when it is done speaking.
 */
export async function adoptSessionAsAssistant(
  input: { botArn: string; classification: string; purpose: string },
  deps: SpeakAsDeps = {},
): Promise<AssistantSession> {
  const session = await sessionAsAssistant(input, deps);
  adoptAssistantSession(session, 'messaging');
  return session;
}

async function sessionAsAssistant(
  input: { botArn: string; classification: string; purpose: string },
  deps: SpeakAsDeps,
): Promise<AssistantSession> {
  const tablePrefix = process.env.TURN_ROUTING_TABLE_PREFIX || '';
  const ssmRoot = process.env.SSM_ROOT || '';
  if (!tablePrefix || !ssmRoot) {
    throw new AssistantSessionRefused('this function is not wired to speak as an assistant (TURN_ROUTING_TABLE_PREFIX, SSM_ROOT)');
  }
  if (!input.botArn || !input.classification) throw new AssistantSessionRefused('no assistant named to speak as');
  let vendArn = vendArnCache.get(input.classification) ?? '';
  if (!vendArn) {
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const ssm = deps.ssm ?? new SSMClient({ region: REGION });
    const res = await ssm.send(new GetParameterCommand({ Name: `${ssmRoot}/assistant/${input.classification}/vend-arn` }));
    vendArn = res.Parameter?.Value ?? '';
    if (!vendArn) throw new AssistantSessionRefused(`no vend published for ${input.classification}`);
    vendArnCache.set(input.classification, vendArn);
  }
  const { randomUUID } = await import('crypto');
  return sessionForRoutedAssistant({
    // ALWAYS A SPEAK ROUTE (Phase 1c): every service that speaks outside a turn sends, reads and edits
    // messages and nothing else, so the vend gives it the speak edge alone. Arrival triage included: its
    // session covers only its conversation clients (`messaging` scope), and those make the same three calls.
    routeId: `${SPEAK_ROUTE_PREFIX}${input.purpose}-${randomUUID()}`,
    botArn: input.botArn,
    classification: input.classification,
    tableName: `${tablePrefix}${input.classification}`,
    vendArn,
  }, { ddb: deps.ddb ?? new DynamoDBClient({ region: REGION }), ...(deps.lambda ? { lambda: deps.lambda } : {}) });
}
