import type { EventWorkflow } from '../../backend/lambda/src/lib/event-workflow.js';
/** The ops rooms' welcomes the premium primary carries once the ops role is deployed, by the key each has on the version. */
export declare function opsWorkflows(): Record<string, EventWorkflow>;
/** The keys `opsWorkflows` writes. */
export declare const OPS_WORKFLOW_KEYS: readonly string[];
/** The keys the ops assistant owns, which the premium primary's version never carries. */
export declare const OWNED_BY_OPS_KEYS: readonly string[];
/**
 * The version's event workflows with the ops rooms' welcomes added or removed, and every workflow the ops assistant owns
 * taken off. Every other workflow is kept as it is. `changed` is false when there is nothing to do, so a second `add` or
 * `remove` writes no version. `keys` names what was added or removed; `moved` what was taken off because the ops assistant
 * owns it.
 */
export declare function withOpsWorkflows(current: Readonly<Record<string, unknown>> | undefined, mode: 'add' | 'remove'): {
    eventWorkflows: Record<string, unknown>;
    changed: boolean;
    keys: string[];
    moved: string[];
};
/**
 * WHAT THE OPS ASSISTANT'S ACTIVE VERSION LACKS OF THE OPS ROOMS' WORKFLOWS (`OPS_ROOM_WORKFLOW_KEYS`): each it does not
 * carry (`missing`), and each it carries unlike its manifest writes it (`differs`). An ops room opens with no run while
 * `ops-room` is missing, and a team room opens no incident while `incident-triage` is.
 */
export declare function opsAssistantGap(active: Readonly<Record<string, unknown>> | undefined): {
    missing: string[];
    differs: string[];
};
