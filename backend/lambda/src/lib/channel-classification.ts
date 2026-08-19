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
 * (`chime:UpdateChannel`), so a moderator could tamper it up to make a higher-classification assistant
 * respond or open premium battles on a lower channel. The tag cannot be changed by UpdateChannel.
 *
 * Fail-closed: a missing, invalid, or unreadable tag resolves to `profiles.failClosedValue` (the floor
 * classification) — never a hardcoded literal, so a change to the floor propagates everywhere at once.
 */
import { ChimeSDKMessagingClient, ListTagsForResourceCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry.js';

export async function resolveChannelClassificationTag(
  client: ChimeSDKMessagingClient,
  channelArn: string,
  logPrefix: string,
): Promise<string> {
  try {
    const resp = await client.send(new ListTagsForResourceCommand({ ResourceARN: channelArn }));
    const tag = (resp.Tags || []).find((t) => t.Key === 'classification')?.Value;
    if (profiles.isKnownClassification(tag)) return profiles.resolveClassification(tag);
    console.warn(`${logPrefix}[SecurityEvent] channel missing/invalid classification tag; failing closed`, {
      channelArn,
      tag,
      failClosedTo: profiles.failClosedValue,
    });
    return profiles.failClosedValue;
  } catch (err) {
    console.warn(`${logPrefix} failed to read channel classification tag; failing closed:`, err);
    return profiles.failClosedValue;
  }
}
