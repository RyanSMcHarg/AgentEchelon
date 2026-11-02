/**
 * Shared channel-classification resolver (SPEC-CONVERSATION-SECURITY Layer 1).
 *
 * The fail-closed read of a channel's IMMUTABLE `classification` tag is the Layer-1 boundary that
 * decides which per-classification assistant may answer and whether premium battles run. It is read by
 * four independent Lambdas (the Lex router, the channel-flow processor, the /battle config API, and the
 * membership auditor); this is the SINGLE implementation they all call, so the tag key, the fail-closed
 * value, and the SecurityEvent logging can never drift between them.
 *
 * Why the tag and not `metadata.modelTier`: metadata is mutable via the owner rename capability
 * (`chime:UpdateChannel`), so a moderator could rewrite it to make another classification's assistant
 * respond or open premium battles on a channel not cleared for them. The tag cannot be changed by UpdateChannel.
 *
 * THERE IS ONE FUNCTION HERE, AND THERE USED TO BE TWO (ADR-045 decision 2). The other,
 * `resolveChannelClassificationTag`, substituted `profiles.failClosedValue` for a tag it could not
 * read. That looked fail-closed and was not: on an assistant-plane component the floor is not a safe
 * value, it is a DIFFERENT classification, so an unreadable tag meant a premium queue dispatched to
 * the basic router, a premium transcript re-driven through the basic model, and two callers guarding
 * on a falsy value their resolver could never return. It is deleted rather than deprecated, because
 * the next person to want "just give me a classification" would otherwise find it and use it.
 *
 * Unreadable is not a value. A caller that cannot act without a classification refuses.
 */
import { ListTagsForResourceCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';

/** The tag a channel's classification is read from. Immutable after creation. */
export const CLASSIFICATION_TAG = 'classification';

/**
 * THE TAG A CHANNEL'S AUDIENCE IS CARRIED IN, beside its classification and stamped in the same `CreateChannel`
 * (`members` or `outside`, the classification's declared audience, `ProfileRegistry.audienceOf`). Immutable
 * like the classification: every creator's grant pins the requested value to its own classification's
 * audience, and no grant removes it. A role that serves the deployment's own people in every conversation
 * (the share, Battle Mode, invitations) is denied a channel whose audience is `outside` or absent, so an
 * outside conversation is held by a second layer under the handler without the shared stack naming a list.
 */
export const AUDIENCE_TAG = 'audience';

/** The `audience` tag a channel of `classification` is created with. Throws for an undeclared value. */
export function audienceTagFor(classification: string): { Key: string; Value: string } {
  return { Key: AUDIENCE_TAG, Value: profiles.audienceOf(classification) };
}

/** Anything that sends `ListTagsForResource`: a messaging client, or a memoized reader over one. */
export type TagReader = {
  send: (cmd: ListTagsForResourceCommand) => Promise<{ Tags?: Array<{ Key?: string; Value?: string }> }>;
};

/** A tag list as a map from key to value. A tag with no key is dropped. */
export function tagMap(tags: Array<{ Key?: string; Value?: string }> | undefined): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const t of tags || []) if (t.Key) out[t.Key] = t.Value;
  return out;
}

/**
 * THE ONE CHANNEL TAG READ: a channel's tags as a map, read live. `classification` and
 * `primaryAssistant` are the two tags access and routing decide on; the map carries the rest.
 *
 * Throws when the read fails. What an unreadable tag means (a refusal, `undefined`, an outage) is
 * the caller's decision, and every caller in this tree refuses or fails closed on it. A tag is not
 * member-writable, so this, never channel Metadata, is the source for both.
 */
export async function readChannelTags(client: TagReader, channelArn: string): Promise<Record<string, string | undefined>> {
  const resp = await client.send(new ListTagsForResourceCommand({ ResourceARN: channelArn }));
  return tagMap(resp?.Tags);
}

/**
 * The channel's classification tag, or `undefined` when it is missing, invalid or unreadable.
 *
 * For a caller where the floor is NOT a safe answer. Answering a turn at the floor classification is
 * safe: the least-privileged assistant responds. CREATING something at the floor because the parent's
 * tag could not be read is not, because the new resource's classification would be a guess. Such a
 * caller refuses on `undefined`. Same read, same tag key, same SecurityEvent log as the resolver above.
 */
export async function readChannelClassificationTag(
  client: TagReader,
  channelArn: string,
  logPrefix: string,
  onFailure = 'refusing',
): Promise<string | undefined> {
  try {
    const tag = (await readChannelTags(client, channelArn))[CLASSIFICATION_TAG];
    if (profiles.isKnownClassification(tag)) return profiles.resolveClassification(tag);
    console.warn(`${logPrefix}[SecurityEvent] channel missing/invalid classification tag; ${onFailure}`, {
      channelArn,
      tag,
    });
    return undefined;
  } catch (err) {
    console.warn(`${logPrefix} failed to read channel classification tag; ${onFailure}:`, err);
    return undefined;
  }
}
