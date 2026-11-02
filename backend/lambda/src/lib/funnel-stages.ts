/**
 * THE GUEST-TO-CUSTOMER FUNNEL'S STAGES (B12), as data: pure, so the analytics query in either mode reads
 * the same list the recorders write. The recorder and the journey rule are `lib/funnel.ts`.
 */
/** Where a stage is recorded. */
export type FunnelSource =
  /** An event the platform appends to the archive at the transition (`appendServerEvent`). */
  | 'server'
  /** A browser event through the client-events allow-list. */
  | 'browser';

export interface FunnelStageDefinition {
  stage: string;
  source: FunnelSource;
  /** Who records it, or why nothing does. */
  recordedBy: string;
  /** False for a stage whose recorder is not built: declared, so its absence is not read as zero. */
  built: boolean;
  /** The upgrade path the stage belongs to, when it is one path's alone. */
  path?: 'A' | 'B';
}

/** The stages, in funnel order. */
export const FUNNEL_STAGES: readonly FunnelStageDefinition[] = [
  { stage: 'guest_started', source: 'server', recordedBy: 'guest start (guest-session.ts)', built: true },
  { stage: 'guest_refused', source: 'server', recordedBy: 'guest start, by reason (guest-session.ts)', built: true },
  { stage: 'registration_offered', source: 'browser', recordedBy: 'the widget, when the assistant offers to register: NOT BUILT (no offer_registration tool)', built: false },
  { stage: 'registration_started', source: 'browser', recordedBy: 'the registration form in the widget conversation: NOT BUILT (the form records no stage)', built: false },
  { stage: 'claim_sent', source: 'server', recordedBy: 'path B registration, when its claim is issued (guest-upgrade.ts)', built: true, path: 'B' },
  { stage: 'claim_redeemed', source: 'server', recordedBy: 'path B claim (guest-upgrade.ts)', built: true, path: 'B' },
  { stage: 'guest_bound', source: 'server', recordedBy: 'path A bind, on the credential exchange (lib/guest-bind.ts)', built: true, path: 'A' },
  { stage: 'rep_added', source: 'server', recordedBy: 'the hand-off to a person: NOT BUILT (V8, V21)', built: false },
  { stage: 'rep_first_reply', source: 'server', recordedBy: 'the hand-off to a person: NOT BUILT (V8, V21)', built: false },
  { stage: 'handoff_unassigned', source: 'server', recordedBy: 'the hand-off window: NOT BUILT (V8)', built: false },
];

/** The server stages a component records today: the archive's event types for the funnel. */
export const RECORDED_FUNNEL_STAGES = ['guest_started', 'guest_refused', 'claim_sent', 'claim_redeemed', 'guest_bound'] as const;
export type RecordedFunnelStage = (typeof RECORDED_FUNNEL_STAGES)[number];
