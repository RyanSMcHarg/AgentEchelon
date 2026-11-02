/**
 * AN EXPERIMENT IS CREATED IN ONE CALL, A BATTLE INCLUDED (DESIGN-SEPARATE-ASSISTANTS §3.7, ADR-050).
 *
 * A battle's two sides are pinned versions: the control's under the live assistant and the treatment's
 * under the alt `alt-{role}-{classification}`, each its role's live body plus that side's variant. The
 * server derives both when the battle is armed (created `active`, or activated later) and stores the pins
 * on the variants (`controlPin`, `altPin`), so the console sends the experiment as the operator set it and
 * nothing else.
 */
import type { Experiment } from '@ae/shared';
import { createExperiment } from './experimentsService';

export interface ArmDeps {
  createExperiment: typeof createExperiment;
}

const DEFAULT_DEPS: ArmDeps = { createExperiment };

export async function createOrArmExperiment(
  payload: Omit<Experiment, 'createdAt'>,
  deps: ArmDeps = DEFAULT_DEPS,
): Promise<void> {
  await deps.createExperiment(payload);
}
