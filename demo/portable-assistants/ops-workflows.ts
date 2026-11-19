/**
 * THE PREMIUM PRIMARY'S WELCOMES FOR THE OPS ROOMS, PUT ON ITS VERSION ONLY ONCE THE OPS ROLE EXISTS.
 *
 * An ops room (`ops`) and the operations team's standing room (`ops-team`) are conversation types the premium ops role
 * makes real: the ops assistant owns their workflows (`workflowOwner` on both types) while the room's primary stays the
 * classification's, so the ops room's opening (`ops-room`) and the team room's incident (`incident-triage`) ride the ops
 * assistant's own version (`opsEventWorkflows`, ops-assistant-manifest.ts). The premium primary, the Advisor, is a member
 * of both, and carries one welcome for each (`ADVISOR_WELCOME`, demo/welcomes.ts). A primary whose version declares
 * welcomes for those rooms while no ops role is deployed shows a console workflow list for rooms the deployment cannot
 * open, so the seed leaves them off, and `npm run ops-workflows -- add` puts them on once `npm run add-assistant-role`
 * has deployed the role; `remove` takes them back off before the role is withdrawn.
 *
 * Both modes also take off the Advisor any workflow the ops assistant now owns, so a version written before the ops
 * rooms' workflows moved to the ops assistant is brought in line by one `add`. `add` also reads the ops assistant's active
 * version and reports each of those workflows it lacks or holds unlike its manifest (`opsAssistantGap`), with the import
 * that brings it in line, since an ops room whose owner's version lacks `ops-room` opens with no run.
 */
import { ADVISOR_WELCOME } from './welcomes.js';
import { OPS_ROOM_WORKFLOW_KEYS, opsEventWorkflows } from './ops-assistant-manifest.js';
import type { EventWorkflow } from '../../backend/lambda/src/lib/event-workflow.js';

/** The ops rooms' welcomes the premium primary carries once the ops role is deployed, by the key each has on the version. */
export function opsWorkflows(): Record<string, EventWorkflow> {
  return JSON.parse(JSON.stringify(ADVISOR_WELCOME)) as Record<string, EventWorkflow>;
}

/** The keys `opsWorkflows` writes. */
export const OPS_WORKFLOW_KEYS: readonly string[] = Object.keys(opsWorkflows());

/** The keys the ops assistant owns, which the premium primary's version never carries. */
export const OWNED_BY_OPS_KEYS: readonly string[] = OPS_ROOM_WORKFLOW_KEYS;

/**
 * The version's event workflows with the ops rooms' welcomes added or removed, and every workflow the ops assistant owns
 * taken off. Every other workflow is kept as it is. `changed` is false when there is nothing to do, so a second `add` or
 * `remove` writes no version. `keys` names what was added or removed; `moved` what was taken off because the ops assistant
 * owns it.
 */
export function withOpsWorkflows(
  current: Readonly<Record<string, unknown>> | undefined,
  mode: 'add' | 'remove',
): { eventWorkflows: Record<string, unknown>; changed: boolean; keys: string[]; moved: string[] } {
  const base = { ...(current ?? {}) };
  const moved = OWNED_BY_OPS_KEYS.filter((k) => k in base);
  for (const k of moved) delete base[k];
  const ops = opsWorkflows();
  if (mode === 'add') {
    const missing = Object.keys(ops).filter((k) => JSON.stringify(base[k]) !== JSON.stringify(ops[k]));
    for (const k of missing) base[k] = ops[k];
    return { eventWorkflows: base, changed: missing.length > 0 || moved.length > 0, keys: missing, moved };
  }
  const present = OPS_WORKFLOW_KEYS.filter((k) => k in base);
  for (const k of present) delete base[k];
  return { eventWorkflows: base, changed: present.length > 0 || moved.length > 0, keys: present, moved };
}

/**
 * WHAT THE OPS ASSISTANT'S ACTIVE VERSION LACKS OF THE OPS ROOMS' WORKFLOWS (`OPS_ROOM_WORKFLOW_KEYS`): each it does not
 * carry (`missing`), and each it carries unlike its manifest writes it (`differs`). An ops room opens with no run while
 * `ops-room` is missing, and a team room opens no incident while `incident-triage` is.
 */
export function opsAssistantGap(active: Readonly<Record<string, unknown>> | undefined): { missing: string[]; differs: string[] } {
  const shipped = opsEventWorkflows();
  const own = active ?? {};
  const missing = OPS_ROOM_WORKFLOW_KEYS.filter((k) => !Object.hasOwn(own, k));
  const differs = OPS_ROOM_WORKFLOW_KEYS.filter((k) => Object.hasOwn(own, k) && JSON.stringify(own[k]) !== JSON.stringify(shipped[k]));
  return { missing, differs };
}
