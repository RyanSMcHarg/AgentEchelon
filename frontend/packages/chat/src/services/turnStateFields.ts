import type { Message } from '@ae/shared';

/** The message fields that say where a turn and its queue stand, as the backend declared them. */
export type TurnStateFields = Pick<Message, 'responsePhase' | 'turnKind' | 'queueDepth' | 'queueStatus' | 'queueStatusLabel'>;

/**
 * Lift the turn and queue state out of a message's metadata.
 *
 * ONE DEFINITION FOR BOTH PATHS. The live WebSocket parse lifted these and the history load
 * (`chimeService.listMessages`) did not, so the queue indicator vanished on reload - and the person it
 * vanished for was the one who had waited longest, because their notice is the oldest message in the
 * window. Shared here so a field added to one path cannot be missing from the other.
 *
 * - `responsePhase`: the step of the answer this message is, so a reader does not guess from the text
 *   whether the turn has settled.
 * - `turnKind`: what the turn declared this message to be, so a placeholder that became a receipt is
 *   read as one.
 * - `queueDepth`: the queue's state token, so a client need not re-parse metadata to notice that what
 *   is waiting has changed.
 * - `queueStatus` / `queueStatusLabel`: the stage the drain has reached, because the prose is
 *   deployment-configurable and may be in any language.
 */
export function liftTurnStateFields(metadata: Record<string, unknown>): TurnStateFields {
  const queueDepth = typeof metadata.queueDepth === 'number' ? metadata.queueDepth : undefined;
  return {
    responsePhase: typeof metadata.respPhase === 'string' ? metadata.respPhase : undefined,
    turnKind: typeof metadata.turnKind === 'string' ? metadata.turnKind : undefined,
    queueDepth,
    // ── AN EMPTY QUEUE HAS NO STAGE, ON BOTH PATHS (review, 2026-09-17) ──────────────────────────
    //
    // The live merge already enforces this (`ConversationProvider.chime.tsx`): `queueDepth === 0`
    // clears `queueStatus`, because a stage arrives on one message among many and a settled notice
    // that carried none would leave the last one pulsing under a notice saying the opposite.
    //
    // This lift copied the stored value verbatim, so the rule held live and broke on reload - and the
    // settle write stores exactly `{queueDepth: 0, queueStatus: 'settled'}`, so EVERY drained notice
    // rendered a queue chip after a refresh that the live session had never shown. Worse when a
    // settle update lost its retries: the stored `clearing` then rendered as a permanently pulsing
    // chip, where a reload used to be the thing that cleared it.
    //
    // Enforced HERE rather than at each caller because this function exists to stop exactly this
    // divergence: it is the one definition both paths read.
    queueStatus: queueDepth === 0
      ? undefined
      : (typeof metadata.queueStatus === 'string' ? metadata.queueStatus : undefined),
    queueStatusLabel: typeof metadata.queueStatusLabel === 'string' ? metadata.queueStatusLabel : undefined,
  };
}
