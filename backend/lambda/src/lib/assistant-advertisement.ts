/**
 * WHAT ONE ASSISTANT PUBLISHES ABOUT ITSELF FOR ANOTHER TO READ.
 *
 * `assistant-capabilities.ts` answers "what does this assistant do" for a PERSON. This is the other
 * consumer that module's header names and declines to serve: a primary reading its roommates in order
 * to route. Same source - the intent pack - and a different shape, because a person needs sentences and
 * a router needs keys.
 *
 * ── WHY IT IS ITS OWN PARAMETER AND NOT A PROJECTION OF THE DEFINITION ───────────────────────────
 *
 * The advertisement could be derived at read time from `/{root}/assistant/{name}/definition`, which is
 * already granted and already cached. It is not, because that grant is wildcarded across every
 * assistant's `definition` parameter and NOT scoped by classification - so a component that read a
 * roommate's summary that way would be a component permitted to read that roommate's `instructions`,
 * its tool selection, its persona and its guardrail selection, across classifications. The design's
 * promise is that what crosses between assistants is "keys and the person-facing line, never
 * `instructions` or `tools`", and a promise kept only by which fields the code happens to touch is a
 * convention rather than a boundary (tenet D3 asks for two layers).
 *
 * So the publisher projects, the consumer reads the projection, and the consumer is granted the
 * projection alone. What an assistant may learn about its roommate is then decided by IAM and not by
 * review. This parameter exists to be READABLE by peers; the definition stays readable only by the
 * paths that need the whole profile.
 *
 * ── IT IS PROJECTED FROM THE STORED PACK, NOT THE RESOLVED ONE ───────────────────────────────────
 *
 * A version carrying no `intentPack` inherits the deployment taxonomy, and an assistant that inherits
 * advertises NOTHING: it is no more specialized than the deployment it sits in, so a primary routing to
 * it would be handing work to a peer with the same taxonomy as itself. Projecting from the STORED pack
 * is what makes that rule hold as a property rather than as a coincidence - deriving it from the
 * RESOLVED pack cannot distinguish an inherited intent from a declared one, so the rule would hold only
 * while no platform default happened to carry a `summary`, and would break silently the day one did.
 *
 * ── ABSENCE IS A VALID ANSWER AT EVERY LAYER ─────────────────────────────────────────────────────
 *
 * No parameter, an unreadable parameter, an empty `intents` list: all mean "this assistant advertises
 * nothing", and a reader treats them identically. Nothing here throws and nothing retries, because the
 * only consumer is on the reply path and a routing improvement must never cost a person their answer
 * (tenet D5).
 */
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { advertisedIntents, type StoredIntentPack, type IntentPack } from './intent-pack.js';
import { defaultProfileRegistry } from '../../../lib/profile-registry';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';

/**
 * What the deployment calls an assistant, or '' when it does not know of one.
 *
 * Wrapped rather than called inline so a registry that does not declare this profile is an empty answer
 * instead of a throw: the projection must not fail because a name is missing.
 */
function registryDisplayName(assistant: string): string {
  try {
    return defaultProfileRegistry.displayNameFor(assistant) || '';
  } catch {
    return '';
  }
}

const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';

/**
 * How long a read advertisement is reused in one warm container.
 *
 * Matched to the profile resolution TTL rather than invented: the advertisement is a projection of a
 * profile version, so it converges on activation the same way every other profile edit does. A
 * SEPARATE lifetime would be a second thing to invalidate, and the one that goes stale exactly when a
 * team withdraws a capability.
 */
const ADVERTISEMENT_TTL_MS = 60_000;

/** What crosses between assistants. Nothing here is private, and nothing here is `instructions`. */
export interface AssistantAdvertisement {
  /** The assistant's handle, which is also its profile name. */
  assistant: string;
  /** The name a person calls it, for copy that names who to ask. */
  displayName: string;
  /** What it recognizes, as `(key, person-facing line)` pairs in declaration order. */
  intents: Array<{ key: string; summary: string }>;
  /** The authored limit line: what it does NOT reach. Absent when the profile carries none. */
  boundary?: string;
}

/** Where one assistant's advertisement lives. */
export function advertisementParamName(ssmRoot: string, assistant: string): string {
  return `${ssmRoot}/assistant/${assistant}/advertisement`;
}

/**
 * Project a profile body down to what a peer may read. PURE, so the projection is testable without SSM
 * and so the writer and any future publisher cannot disagree about what is published.
 *
 * `pack` is the version's OWN stored pack. Passing a resolved pack here would defeat the inherit rule
 * in this module's header, so the parameter is typed to the stored shape to make that hard to do by
 * accident.
 */
export function projectAdvertisement(input: {
  assistant: string;
  displayName?: string;
  pack?: StoredIntentPack;
  boundary?: string;
}): AssistantAdvertisement {
  // The stored pack's declared intents, read through the same advertised-intents rule a person-facing
  // introduction uses, so one definition of "advertised" serves both consumers. `extends` is ignored on
  // purpose: an inherited intent is not this assistant's to advertise.
  const declared = (input.pack?.intents ?? []) as IntentPack['intents'];
  const intents = advertisedIntents({ intents: declared } as IntentPack);
  const boundary = input.boundary?.trim() || undefined;
  return {
    assistant: input.assistant,
    // THE REGISTRY BEFORE THE HANDLE, because the handle is an internal identifier and this name reaches a
    // person. A version that names no display name is the ordinary case - the seeded definitions carry
    // none - and falling straight through to the handle put "ops-premium" into a sentence a person reads
    // ("that one is ops-premium's"), where the name on the reply they then see is "Ops". The registry is
    // the deployment's own answer to what an assistant is called, so it is the right second choice; the
    // handle remains the last resort for an assistant the registry does not know.
    displayName: input.displayName?.trim()
      || registryDisplayName(input.assistant)
      || input.assistant,
    intents,
    ...(boundary ? { boundary } : {}),
  };
}

/**
 * Publish an assistant's advertisement. Called where a version becomes ACTIVE, because that is when
 * what an assistant recognizes changes for everybody.
 *
 * BEST-EFFORT AND LOUD. A failed write leaves the previous advertisement standing, which is stale
 * rather than wrong in a dangerous direction: a roommate may be offered a capability the specialist has
 * withdrawn, and the specialist then classifies the handed-over turn as `general` and says so. Failing
 * the ACTIVATION over it would be worse - it would make a behavior edit depend on a routing projection.
 */
export async function writeAdvertisement(
  ssm: SSMClient,
  ssmRoot: string,
  ad: AssistantAdvertisement,
): Promise<boolean> {
  try {
    await ssm.send(new PutParameterCommand({
      Name: advertisementParamName(ssmRoot, ad.assistant),
      Value: JSON.stringify(ad),
      Type: 'String',
      Overwrite: true,
    }));
    return true;
  } catch (err) {
    console.error('[advertisement] could not publish; roommates will route on the previous version', {
      assistant: ad.assistant, err: (err as Error)?.message,
    });
    return false;
  }
}

let ssmClient: SSMClient | null = null;
function ssm(): SSMClient {
  if (!ssmClient) ssmClient = sessionClient(SSMClient, { requestHandler: BOUNDED_REQUEST_HANDLER });
  return ssmClient;
}

const cache = new Map<string, { at: number; value: AssistantAdvertisement | null }>();

/** Drop the container cache. Tests only; a deployment converges on the TTL. */
export function __resetAdvertisementCacheForTests(): void {
  cache.clear();
}

/**
 * One assistant's advertisement, or null when it advertises nothing.
 *
 * CACHED BY ASSISTANT RATHER THAN BY CONVERSATION. A deployment's assistants are few and its
 * conversations are not, so keying by conversation would hold the same three projections under every
 * room and expire them independently. Keyed by assistant, a busy deployment resolves each specialist
 * once per TTL however many rooms it serves.
 *
 * A NEGATIVE IS CACHED TOO, which is the point of caching here at all: the common deployment has one
 * assistant and no advertisements, and re-reading a parameter that does not exist on every fall-through
 * turn is the cost this exists to avoid.
 */
export async function readAdvertisement(assistant: string): Promise<AssistantAdvertisement | null> {
  if (!assistant) return null;
  const hit = cache.get(assistant);
  if (hit && Date.now() - hit.at < ADVERTISEMENT_TTL_MS) return hit.value;
  let value: AssistantAdvertisement | null = null;
  try {
    const res = await ssm().send(new GetParameterCommand({
      Name: advertisementParamName(SSM_ROOT, assistant),
    }));
    const parsed = JSON.parse(res.Parameter?.Value || 'null') as AssistantAdvertisement | null;
    // An advertisement with no intents and no boundary says nothing, so it reads as absent rather than
    // as an empty offer a caller then has to special-case.
    value = parsed && (parsed.intents?.length || parsed.boundary) ? parsed : null;
  } catch {
    // ParameterNotFound is the ordinary case for an assistant that has never published one, and an
    // access or parse failure is the same answer to this caller: nothing to offer. Not logged at error,
    // because on a single-assistant deployment this is every turn.
    value = null;
  }
  cache.set(assistant, { at: Date.now(), value });
  return value;
}

/** One roommate a turn could route to: who it is, what it advertises, and the bot to hand over to. */
export interface Roommate {
  assistant: string;
  botArn: string;
  role: string;
  advertisement: AssistantAdvertisement;
}

/**
 * THE ASSISTANTS IN THIS CONVERSATION OTHER THAN THE ONE ANSWERING, with what each advertises.
 *
 * Membership is the INDEX and never the payload: an Amazon Chime SDK membership row carries an ARN and
 * a display name, so the roster answers only WHICH assistants are present - the question it is
 * authoritative for - and each advertisement is read from that assistant's own published projection.
 *
 * THE ROSTER IS PASSED IN, NOT READ. The turn has already read it, and reading it again would be a
 * second ANSWER rather than a second copy: two reads moments apart can disagree about who is present,
 * and then the addressing decision and the routing decision would be made against different rooms.
 *
 * BOUNDED BY THE ROSTER AND BY THE CLASSIFICATION, both. A bot in the room that is not a live assistant
 * of this classification resolves to nothing, so a member that is not one of this deployment's
 * assistants cannot become a routing target.
 */
export async function roommatesInConversation(input: {
  /** Bot ARNs present in the conversation, from the roster the turn already holds. */
  botArnsInRoom: string[];
  /** The bot answering this turn, excluded from its own roommates. */
  selfBotArn: string;
  /** Live assistants for this classification, as `assistant -> {botArn, role}`. Read by the caller, which
   *  already resolves assignments for other reasons, so this function adds no SSM read of its own. */
  liveAssistants: Array<{ handle: string; botArn: string; role: string }>;
}): Promise<Roommate[]> {
  const inRoom = new Set(input.botArnsInRoom.filter(Boolean));
  const candidates = input.liveAssistants.filter(
    (s) => s.botArn && s.botArn !== input.selfBotArn && inRoom.has(s.botArn),
  );
  if (candidates.length === 0) return [];
  const resolved = await Promise.all(candidates.map(async (s) => {
    const advertisement = await readAdvertisement(s.handle);
    return advertisement ? { assistant: s.handle, botArn: s.botArn, role: s.role, advertisement } : null;
  }));
  return resolved.filter((r): r is Roommate => r !== null);
}

/**
 * WHICH ROOMMATE OWNS AN ADVERTISED KEY, or a refusal to choose.
 *
 * `'none'` means nobody advertises it and the answering assistant keeps the turn. `'ambiguous'` means
 * more than one roommate advertises the same key, and the design's rule is that a primary **refuses to
 * choose and asks** - silently picking one would make the answer depend on which assistant was listed
 * first, which is an order nobody can see and nothing records.
 */
export function roommateForKey(
  roommates: Roommate[],
  key: string,
): { kind: 'one'; roommate: Roommate } | { kind: 'ambiguous'; roommates: Roommate[] } | { kind: 'none' } {
  if (!key) return { kind: 'none' };
  const owners = roommates.filter((r) => r.advertisement.intents.some((i) => i.key === key));
  if (owners.length === 0) return { kind: 'none' };
  if (owners.length > 1) return { kind: 'ambiguous', roommates: owners };
  return { kind: 'one', roommate: owners[0] };
}
