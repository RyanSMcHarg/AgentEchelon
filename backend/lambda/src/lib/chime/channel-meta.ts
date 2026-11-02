/**
 * A channel's Metadata: the one parse and the one merge.
 *
 * NEVER AN AUTHORITY. Metadata is readable by every member and writable by any moderator
 * (`chime:UpdateChannel` writes Name and Metadata in one call), so nothing read here decides who a
 * person is, what a conversation's classification is, or who is in it. Those come from the
 * AppInstanceUser, the `classification` tag (`readChannelTags`, `lib/channel-classification.ts`) and
 * live membership. Metadata carries display hints and context a member may see.
 */

/** Amazon Chime SDK caps channel Metadata at 1024 bytes; this leaves headroom, measured in UTF-8 bytes. */
export const CHANNEL_METADATA_CAP_BYTES = 1000;

export type ChannelMetadata = Record<string, unknown>;

/**
 * Parse a channel's Metadata. Absent or empty is `{}`. Text that is not JSON, or JSON that is not an
 * object, is `undefined`: the caller decides whether that is a read to skip or a base to replace.
 */
export function parseChannelMetadata(raw: string | null | undefined): ChannelMetadata | undefined {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ChannelMetadata) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge `patch` onto the channel's existing Metadata and serialize it. The patch's keys win and every
 * other key survives, because UpdateChannel replaces the whole document.
 *
 * Null means do not write: there is no base to merge onto (`base` is null, a failed read), or the merge
 * exceeds `cap`. Writing the patch alone in either case would erase what the channel carried.
 */
export function mergeChannelMetadata(
  base: ChannelMetadata | null,
  patch: ChannelMetadata,
  cap = CHANNEL_METADATA_CAP_BYTES,
): string | null {
  if (base === null) return null;
  const merged = JSON.stringify({ ...base, ...patch });
  return Buffer.byteLength(merged, 'utf8') > cap ? null : merged;
}

/** The UTF-8 size Amazon Chime SDK measures a Metadata document by. */
export function metadataBytes(serialized: string): number {
  return Buffer.byteLength(serialized, 'utf8');
}
