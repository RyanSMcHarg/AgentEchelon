/**
 * EVERY MESSAGE AN ASSISTANT SENDS SAYS WHICH ASSISTANT SENT IT.
 *
 * ── WHAT THIS CLOSES ─────────────────────────────────────────────────────────────────────────────
 *
 * The archival writes the four reporting dimensions straight off the message's own metadata
 * (`kinesis-archival.ts`: `agent_type`, `assistant_role`, `profile_version`, `profile_config_id`), and
 * it writes NULL for anything the message did not declare. That is deliberate and stays: an earlier
 * `extractAgentType(senderArn)` guess was removed because every miss "landed as an 'unknown' row that
 * looked like a measurement". A guessed value that reads as real is not discoverable; a missing one is.
 *
 * The consequence was that only the async processor's ANSWER declared anything. Every other message an
 * assistant sends - the acknowledgment the handler posts on a bypass (`postAsAssistant`), the handover
 * receipt, the stop acknowledgment, the reply to a reference that named nothing - stamped
 * `{ botResponse: true }` and no more. The acknowledgment is the one that shows: it carries the
 * `<!--corr:-->` marker, so it counts as an assistant turn, and it reported an unknown assistant, an
 * unknown role and an unknown version on every flow-dispatched turn. Flow dispatch is the standard
 * path, so that was most of the traffic rather than an edge.
 *
 * THE FIX IS DECLARATION, NOT INFERENCE. This module exists so a sender states what it already knows
 * at the moment it sends, in one shape, rather than each call site inventing a subset of it.
 *
 * ── WHY `classification` IS IN HERE, THOUGH IT IS NOT A REPORTING DIMENSION ──────────────────────
 *
 * The S3 archive PARTITIONS on it. Firehose sets `user_type` from this key with a JQ expression over
 * the Chime Metadata and cannot follow the out-of-band hop the archival Lambda can, so a message that
 * omits it lands in `user_type=unknown` permanently. `analytics-metadata.ts` keeps it in
 * `FRONTEND_METADATA_KEYS` for exactly this reason; a message that declares an assistant and not a
 * classification would be attributed in Aurora and unpartitioned in Athena.
 *
 * ── FLAT, NOT NESTED ─────────────────────────────────────────────────────────────────────────────
 *
 * `readMessageAnalytics` accepts `metadata.analytics` or the bare metadata, and the slimmed frontend
 * metadata the processor writes is flat (`pickFrontendMetadata`). Flat here keeps one shape on the
 * wire for every message this platform sends.
 */

/**
 * WHAT KIND OF MESSAGE THIS IS, when it is not a turn.
 *
 * A notice is not an assistant turn: no model ran, there is no TTFF, no intent and no delivery option,
 * and `ASSISTANT_TURN_SQL` already excludes it (no exchange, no `total_ms`, no correlation marker).
 * Declaring the kind makes it positively identifiable rather than merely absent from the population -
 * the difference between "the platform said this" and a row that reads as a turn nobody can attribute.
 *
 * NO `profileVersion` IS INVENTED FOR ONE. No profile produced it, so recording a version would answer
 * "which version said this" with a number that had nothing to do with it. That is the substitution
 * this whole module exists to prevent, and it would be the same defect wearing the opposite sign.
 */
export type NoticeKind =
  /** A duel's own announcements: started, ended, not enabled here, not yours to end. */
  | 'battle-notice'
  /** The platform saying it cannot act: unconfigured, a failed dispatch, a refused spend. */
  | 'notice'
  /**
   * A MESSAGE THE PLATFORM SENT THAT NOBODY ASKED FOR: a task assignment, a reminder, anything
   * one-directional.
   *
   * It is not an exchange. Nobody was waiting on it, so its "reply time" is measured from nothing and
   * its pairing would attach it to whatever message happened to precede it. Declaring the kind is what
   * keeps it out: a turn that names its kind is already excluded from the exchange population, which
   * `turn_kinds` shows directly - `drift` and `reading` both report `exchange_count: 0`.
   *
   * MEASURED BEFORE IT EXISTED: only `answer`, `drift` and `reading` appear in 30 days of live data,
   * so every notification was in the `answer` remainder, which is the bucket that means "declared
   * nothing" rather than "is an answer".
   */
  | 'notification';

/** What a sender declares about itself. Every field is known to the sender at send time or absent. */
export interface BotMessageAttribution {
  /** The ASSISTANT that sent it, never its classification (`agent_type`, migration 055). */
  agentType?: string;
  /** The role that assistant holds. Declared, never defaulted to `primary` (migration 056). */
  assistantRole?: string;
  /** The profile version that produced it. Absent on a notice, which no profile produced. */
  profileVersion?: number;
  /** The fingerprint of what that version says, comparable across deployments. */
  profileConfigId?: string;
  /** The conversation's classification. Carried because the S3 archive partitions on it. */
  classification?: string;
  /** Set when this message is a notice rather than a turn. */
  turnKind?: NoticeKind;
}

/**
 * The Chime `Metadata` for a message an assistant sends.
 *
 * `botResponse: true` is what the frontend reads to render it as the assistant, and it stays exactly
 * where it was; everything else is the declaration. Absent fields are OMITTED rather than sent as null,
 * so the archival's "declared or NULL" rule sees the same thing whether a field was never known or was
 * never sent.
 *
 * `extra` carries the per-message facts that are not attribution - `targetedSender`, a notification
 * envelope - so a caller never has to choose between this helper and its own metadata.
 */
export function botMessageMetadata(
  attribution?: BotMessageAttribution,
  extra?: Record<string, unknown>,
): string {
  const metadata: Record<string, unknown> = { botResponse: true, ...extra };
  if (attribution) {
    if (attribution.agentType) metadata.agentType = attribution.agentType;
    if (attribution.assistantRole) metadata.assistantRole = attribution.assistantRole;
    if (typeof attribution.profileVersion === 'number') metadata.profileVersion = attribution.profileVersion;
    if (attribution.profileConfigId) metadata.profileConfigId = attribution.profileConfigId;
    if (attribution.classification) metadata.classification = attribution.classification;
    if (attribution.turnKind) metadata.turnKind = attribution.turnKind;
  }
  return JSON.stringify(metadata);
}
