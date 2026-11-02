/**
 * THE ROOM'S PRIMARY ASSISTANT (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8, ADR-030).
 *
 * A room has one primary. It takes every turn nobody addressed, answers `@all`, and says everything said
 * for the room: the welcome, join and share notices, Battle Mode's notices, the archive notice, a briefing.
 * Every other assistant in the room speaks only when addressed, handed the work, or for work it owns.
 *
 * WHERE IT IS RECORDED. The `primaryAssistant` channel tag names the primary's assistant handle. It is
 * written in the same `CreateChannel` call as `classification` (`primaryTagFor`), so no room exists
 * without it, and members cannot change a channel tag. A handle rather than a bot ARN: reassigning an
 * assistant moves every room that names it, with no re-tagging. Channel Metadata is member-writable and
 * is never read for this.
 *
 * WHERE IT IS RESOLVED. Here, and only here: `primaryAssistantOf` reads the room's tags and resolves the
 * handle through the assignment records, the authority on which assistant holds which role. Never
 * `/assistant/{classification}/bot-arn`, which is a deployment pointer, not an assignment.
 *
 * A ROOM ALWAYS HAS ONE. A room whose tag is missing (one created before the tag existed and not yet
 * backfilled) or names an assistant the classification no longer assigns falls back to the classification's
 * primary assistant, and the fault is logged so the backfill (`scripts/backfill-primary-assistant.mjs`) is run.
 * It does not repair the tag itself: a role able to write channel tags could rewrite `classification`.
 * A classification with no primary assistant at all throws `RoomHasNoPrimary`, which is a deployment fault.
 */
import { ListTagsForResourceCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { liveAssistantsByHandleOrThrow } from './default-agents.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { readChannelTags, tagMap, CLASSIFICATION_TAG, type TagReader } from './channel-classification.js';

/** The channel tag that names a room's primary assistant, by handle. */
export const PRIMARY_TAG = 'primaryAssistant';
/** The role whose live assistant is a classification's default primary. */
export const PRIMARY_ROLE = 'primary';

export interface RoomPrimary {
  /** The assistant's handle, as the assignment records name it. */
  assistant: string;
  botArn: string;
  classification: string;
  /** How it was found: the room's own tag, or the classification's primary assistant because the tag failed. */
  source: 'tag' | 'record';
}

export class RoomHasNoPrimary extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomHasNoPrimary';
  }
}


/**
 * The classification's primary assistant, from its assignment record. Throws when there is none: every
 * conversational classification must have one.
 *
 * THE DECLARED ASSISTANT ONLY. A console-created assistant (ADR-048) can hold the primary role, and answers
 * there when addressed, but it never becomes the classification's primary: its record sits beside the declared
 * primary's under `{c}/primary/assistants/`, so a first-match read could bind every new conversation to it,
 * and before its first version is active the vend refuses it, leaving those conversations with no answer.
 * The declared primary's record says `source: 'declared'`, which carries no runtime seed.
 */
export async function primaryAssignmentOf(classification: string): Promise<{ assistant: string; botArn: string }> {
  const assistants = await liveAssistantsByHandleOrThrow(classification);
  const primary = [...assistants.values()].find((s) => s.role === PRIMARY_ROLE && !s.runtimeSeed);
  if (!primary?.botArn) throw new RoomHasNoPrimary(`classification '${classification}' has no live ${PRIMARY_ROLE} assistant`);
  return { assistant: primary.handle, botArn: primary.botArn };
}

/**
 * THE TAG A NEW ROOM IS CREATED WITH, for the assistant it is created for. Refuses (throws) when that bot
 * is not a live assistant of the room's classification, so no room is created without a primary.
 */
export async function primaryTagFor(classification: string, botArn: string): Promise<{ Key: string; Value: string }> {
  const assistants = await liveAssistantsByHandleOrThrow(classification);
  const assistant = [...assistants.values()].find((s) => s.botArn === botArn);
  if (!assistant) {
    throw new RoomHasNoPrimary(`the bot a '${classification}' room is created for is not a live assistant of '${classification}'`);
  }
  return { Key: PRIMARY_TAG, Value: assistant.handle };
}

const cache = new Map<string, { at: number; value: RoomPrimary }>();
const CACHE_TTL_MS = 60_000;

/** Tests only. */
export function __resetRoomPrimaryCache(): void {
  cache.clear();
}

/**
 * THE ROOM'S PRIMARY ASSISTANT. Every path that speaks FOR the room resolves its bot here.
 *
 * Throws `RoomHasNoPrimary` when the room has no readable classification, or its classification has no
 * primary assistant. A caller on a best-effort path (a notice) catches it and says nothing; a turn path lets
 * it fail the turn, as an unreadable classification already does.
 */
export async function primaryAssistantOf(channelArn: string, chime: TagReader, logPrefix = '[conversation-primary]'): Promise<RoomPrimary> {
  const hit = cache.get(channelArn);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const tags = await readChannelTags(chime, channelArn);
  const rawClassification = tags[CLASSIFICATION_TAG];
  if (!profiles.isKnownClassification(rawClassification)) {
    throw new RoomHasNoPrimary(`room ${channelArn} has no readable classification`);
  }
  const classification = profiles.resolveClassification(rawClassification) as string;
  const named = tags[PRIMARY_TAG];

  const assistants = await liveAssistantsByHandleOrThrow(classification);
  const tagged = named ? assistants.get(named) : undefined;
  let value: RoomPrimary;
  if (tagged?.botArn) {
    value = { assistant: tagged.handle, botArn: tagged.botArn, classification, source: 'tag' };
  } else {
    const primary = await primaryAssignmentOf(classification);
    // A FAULT, not a branch: every room is tagged at creation and the backfill tags the rest. Logged so
    // it is seen; the room keeps answering through its classification's primary assistant (tenet D5).
    console.error(`${logPrefix}[PrimaryAssistantFault] the room's primary tag is ${named ? 'not a live assistant of its classification' : 'missing'}; using the classification's primary assistant. Run scripts/backfill-primary-assistant.mjs`, {
      channelArn, classification, tagged: named ?? null, using: primary.assistant,
    });
    value = { ...primary, classification, source: 'record' };
  }
  cache.set(channelArn, { at: Date.now(), value });
  return value;
}

/**
 * ONE TAG READ PER CONVERSATION PER CONTAINER, shared by a caller's classification read and the room's
 * primary, which read the same tags. Only a response carrying a recognized classification is kept, so a
 * failed or invalid read is retried rather than pinned. Bounded, because the key is a conversation.
 */
export function memoizedTagReader(client: TagReader, limit = 1000): TagReader {
  const memo = new Map<string, Awaited<ReturnType<TagReader['send']>>>();
  return {
    send: async (cmd: ListTagsForResourceCommand) => {
      const arn = cmd.input.ResourceARN || '';
      const hit = memo.get(arn);
      if (hit) return hit;
      const res = await client.send(cmd);
      if (profiles.isKnownClassification(tagMap(res?.Tags)[CLASSIFICATION_TAG])) {
        if (memo.size >= limit) {
          const oldest = memo.keys().next().value;
          if (oldest !== undefined) memo.delete(oldest);
        }
        memo.set(arn, res);
      }
      return res;
    },
  };
}
