/**
 * Battle image-attachment extraction (SPEC-BATTLE.md §"Image Battles —
 * Vision-In").
 *
 * A `/battle` turn that carries an image rides the same attachment
 * pipeline as any message: the frontend sets the Chime message
 * `Metadata` to `{"attachment":{fileKey,name,size,type}}` (see
 * ConversationProvider.chime sendMessage + the Attachment type). This
 * pure helper pulls an *image* attachment out of that Metadata string
 * so channel-flow can thread it into each per-bot battle payload.
 *
 * Pure (no AWS imports) → unit-testable on its own; the async path's
 * Converse-image / reject branching is downstream of this.
 */

export interface BattleImageAttachment {
  fileKey: string;
  contentType: string;
}

export function extractImageAttachment(
  metadataJson?: string,
): BattleImageAttachment | undefined {
  if (!metadataJson) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return undefined;
  }

  const att = (parsed as { attachment?: unknown } | null)?.attachment as
    | { fileKey?: unknown; type?: unknown }
    | undefined;

  if (
    !att ||
    typeof att.fileKey !== 'string' ||
    att.fileKey.length === 0 ||
    typeof att.type !== 'string'
  ) {
    return undefined;
  }

  // Only images participate in vision-in; other attachments (PDFs etc.)
  // are out of scope here and ignored.
  if (!att.type.startsWith('image/')) return undefined;

  return { fileKey: att.fileKey, contentType: att.type };
}

/** Any attachment on a message (image or document). Parsed from the message Metadata's `attachment`. */
export interface MessageAttachment {
  fileKey: string;
  contentType: string;
  name?: string;
}

/**
 * General attachment extractor (image OR document), unlike {@link extractImageAttachment} it does
 * NOT filter by type — the consumer decides (the standard attachment-in path accepts images as a
 * Converse image block and documents as a Converse document block). Pure (no AWS imports).
 */
export function extractAttachment(metadataJson?: string): MessageAttachment | undefined {
  if (!metadataJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return undefined;
  }
  const att = (parsed as { attachment?: unknown } | null)?.attachment as
    | { fileKey?: unknown; type?: unknown; name?: unknown }
    | undefined;
  if (!att || typeof att.fileKey !== 'string' || att.fileKey.length === 0 || typeof att.type !== 'string') {
    return undefined;
  }
  return {
    fileKey: att.fileKey,
    contentType: att.type,
    name: typeof att.name === 'string' ? att.name : undefined,
  };
}
