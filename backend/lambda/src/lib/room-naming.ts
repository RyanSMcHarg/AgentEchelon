/**
 * THE ROOM'S OWN ASSISTANT NAMES A ROOM ANOTHER ASSISTANT ANSWERED IN (`conversation-name.ts`).
 *
 * A room is renamed only by its primary, the one assistant that moderates it, acting as itself (tenet D1). A duel's alt
 * or a member assistant addressed by name answers in the room as an ordinary member and is never granted
 * `UpdateChannel` to rename it. So when a person's message in a room still carrying the placeholder goes to one of
 * those, the router asks the room's primary to name the room from that message: a processor run (`nameRoom`) on the
 * primary's own routed session, which derives the title and renames the room only while it still carries the
 * placeholder (`channel-title.ts`).
 *
 * ONE DERIVATION IN FLIGHT PER ROOM, AND A RETRY WHEN IT NAMED NOTHING. Only a message that can name the room
 * (`namingSeed`) claims the room's naming, on the room's own row (`claimRoomNaming`). A claim holds for longer than any
 * run can last, so a second run cannot start while one is in flight; a run that could not be started gives its claim
 * back at once, and a run that named nothing lets it lapse, so a later message asks again. A claim taken over after a
 * lapse reads the room's name first, and a room found named is recorded as named (`markRoomNamed`), which every later
 * turn reads instead of the Amazon Chime SDK.
 *
 * WHAT A ROUTER CONTAINER REMEMBERS ({@link RoomNamingMemory}): a room it knows is named, and the primary it asked for a
 * room whose claim it saw held, so a turn inside the lease reads nothing and still tells its assistant not to name.
 *
 * The router supplies what it reads (the room's primary, the claim, the dispatch); nothing here reads a store itself.
 */
import { PLACEHOLDER_TITLE, namingSeed } from './conversation-name.js';
import type { RoomNamingClaim } from './channel-context-client.js';

export interface NamingTurn {
  channelArn: string;
  /** The assistant answering this turn. */
  answeringBotArn: string;
  /** The router's own classification: a primary of another is never asked. */
  classification: string;
  /** The room's name as the router's channel read saw it, when it read one. */
  knownName?: string;
  /** A duel side's round and rival, when this turn is one. */
  battle?: { round?: number; rivalBotArn?: string };
}

/**
 * THE ROOM'S PRIMARY, WHEN IT AND NOT THIS TURN'S ASSISTANT NAMES THE ROOM, or null where this turn's own assistant
 * names it as before: it is the primary, the room already has a name, it is a duel's first round whose other side is the
 * primary (which names the room from the prompt), or the primary cannot be read or is another classification's.
 */
export async function roomNamedByItsPrimary(
  turn: NamingTurn,
  primaryOf: (channelArn: string) => Promise<{ botArn: string; classification: string } | null>,
): Promise<string | null> {
  if (!turn.channelArn || !turn.answeringBotArn) return null;
  if (turn.knownName !== undefined && turn.knownName !== PLACEHOLDER_TITLE) return null;
  const primary = await primaryOf(turn.channelArn).catch(() => null);
  if (!primary?.botArn || primary.botArn === turn.answeringBotArn) return null;
  if (turn.classification && primary.classification !== turn.classification) return null;
  if (turn.battle?.round === 1 && turn.battle.rivalBotArn === primary.botArn) return null;
  return primary.botArn;
}

/**
 * WHAT ONE ROUTER CONTAINER KNOWS ABOUT A ROOM'S NAMING, so a later turn reads nothing: `named` for a room it knows has
 * a name, or the primary it found and the time until which that room's naming is in hand (its own claim, or another's).
 */
export type RoomNamingMemory = Map<string, { named: true } | { primary: string; until: number }>;

/** What the router does about naming on this turn: whom to tell the answering assistant names instead, and whether to ask. */
export interface NamingDecision {
  /** The room's primary, which names the room instead of this turn's assistant; null where this turn's own assistant names it. */
  namer: string | null;
  /** Whether this turn asks the primary to name the room (a claim and a dispatch). */
  ask: boolean;
}

/**
 * WHO NAMES THE ROOM ON THIS TURN, read as cheaply as the room allows: a room this container knows is named, or whose
 * naming is in hand, reads nothing; a room whose name the router's own channel read shows is recorded as named; a room
 * the row records as named reads no Amazon Chime SDK at all; only then is the primary read.
 */
export async function namingDecisionFor(
  turn: NamingTurn,
  memory: RoomNamingMemory,
  deps: {
    primaryOf: (channelArn: string) => Promise<{ botArn: string; classification: string } | null>;
    /** The row's record that the room is named. */
    isNamed: (channelArn: string) => Promise<boolean>;
    markNamed: (channelArn: string) => Promise<void>;
    now?: () => number;
  },
): Promise<NamingDecision> {
  const now = (deps.now ?? Date.now)();
  const known = memory.get(turn.channelArn);
  if (known && 'named' in known) return { namer: null, ask: false };
  if (known && now < known.until) return { namer: known.primary === turn.answeringBotArn ? null : known.primary, ask: false };
  if (turn.knownName !== undefined && turn.knownName !== PLACEHOLDER_TITLE) {
    memory.set(turn.channelArn, { named: true });
    await deps.markNamed(turn.channelArn).catch(() => undefined);
    return { namer: null, ask: false };
  }
  if (await deps.isNamed(turn.channelArn).catch(() => false)) {
    memory.set(turn.channelArn, { named: true });
    return { namer: null, ask: false };
  }
  const namer = await roomNamedByItsPrimary(turn, deps.primaryOf);
  return { namer, ask: namer !== null };
}

/** The processor run that names the room, as the room's primary: the message it is named from and nothing to answer. */
export function roomNamingDispatch(input: { channelArn: string; primaryBotArn: string; userMessage: string; classification: string; now?: number }): Record<string, unknown> {
  return {
    channelArn: input.channelArn,
    // One id per room: the run is the room's naming, whichever message asked for it.
    correlationId: `name-${input.channelArn.split('/channel/')[1] || 'room'}`,
    userMessage: input.userMessage,
    userContent: '',
    classification: input.classification,
    botArn: input.primaryBotArn,
    trigger: 'name_room',
    triggerAtMs: input.now ?? Date.now(),
    nameRoom: true,
  };
}

/** Why the primary was or was not asked to name the room on this turn. */
export type NamingAsk =
  | 'asked'
  /** The message names nothing (empty, or a slash command other than `/battle` and `/md`), so nothing was claimed. */
  | 'not-a-seed'
  /** The room has a name. */
  | 'named'
  /** Another caller's naming run holds the room's claim. */
  | 'held'
  /** The run could not be started; its claim was given back. */
  | 'not-dispatched'
  /** The store failed; nothing was asked. */
  | 'failed';

/**
 * ASK THE ROOM'S PRIMARY TO NAME THE ROOM, by the rules this module's header gives: only for a message that can name
 * it, only by the caller that wins the room's claim, after reading the name when an earlier claim lapsed, and giving
 * the claim back when the run cannot be started. Records what it learned in `memory`. Never throws: a room left unnamed
 * is asked about again by a later message.
 */
export async function askRoomPrimaryToName(
  input: { channelArn: string; primaryBotArn: string; userMessage: string; classification: string },
  deps: {
    claim: (channelArn: string, now: number) => Promise<RoomNamingClaim>;
    release: (channelArn: string, claimedAt: number) => Promise<void>;
    markNamed: (channelArn: string) => Promise<void>;
    /** The room's name, read fresh; undefined when it cannot be read. */
    currentName: (channelArn: string) => Promise<string | undefined>;
    dispatch: (payload: Record<string, unknown>) => Promise<boolean>;
    leaseMs: number;
    now?: () => number;
  },
  memory: RoomNamingMemory = new Map(),
): Promise<NamingAsk> {
  if (namingSeed(input.userMessage) === null) return 'not-a-seed';
  const now = (deps.now ?? Date.now)();
  let claim: RoomNamingClaim;
  try {
    claim = await deps.claim(input.channelArn, now);
  } catch {
    return 'failed';
  }
  if (!claim.claimed) {
    if (claim.named) {
      memory.set(input.channelArn, { named: true });
      return 'named';
    }
    memory.set(input.channelArn, { primary: input.primaryBotArn, until: claim.heldUntil ?? now + deps.leaseMs });
    return 'held';
  }
  try {
    if (claim.lapsed) {
      const name = await deps.currentName(input.channelArn).catch(() => undefined);
      if (name !== undefined && name !== PLACEHOLDER_TITLE) {
        await deps.markNamed(input.channelArn);
        memory.set(input.channelArn, { named: true });
        return 'named';
      }
    }
    if (await deps.dispatch(roomNamingDispatch({ ...input, now }))) {
      memory.set(input.channelArn, { primary: input.primaryBotArn, until: claim.at + deps.leaseMs });
      return 'asked';
    }
  } catch {
    // Given back below, as a run that was never started.
  }
  await deps.release(input.channelArn, claim.at).catch(() => undefined);
  return 'not-dispatched';
}
