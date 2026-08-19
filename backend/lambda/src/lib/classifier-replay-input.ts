/**
 * Validation and window derivation for a classifier replay request
 * (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §5.2).
 *
 * Pure, and in `lib/` rather than beside the replay job, because TWO functions in two different
 * network positions now have to agree about what a valid request is: the non-VPC starter that
 * answers the operator's click, and the batch Lambda inside the VPC that opens the run and does the
 * work. The starter must be able to reject bad input SYNCHRONOUSLY — an `Event` invocation returns
 * before the batch could disagree, so a rule enforced only on the far side would surface as a run id
 * the console then polls for a row that is never written.
 *
 * Importing this instead of the replay module also keeps the starter's bundle free of `pg` and the
 * Bedrock client, neither of which it has any use for.
 */

import { modelCatalogKeys } from '../../../lib/config/model-strategy.js';

export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;
/** The longest window a replay may cover, in days. */
export const MAX_WINDOW_DAYS = 180;

export interface ReplayRequest {
  incumbentModel?: string;
  challengerModel?: string;
  windowDays?: number;
  limit?: number;
}

export interface ValidatedReplayRequest {
  incumbentModel: string;
  challengerModel: string;
  windowStart: Date;
  windowEnd: Date;
  limit: number;
}

/** Shared validation + window derivation, so the open and the execute cannot disagree about either. */
export function validateReplayInput(input: ReplayRequest): ValidatedReplayRequest {
  const incumbentModel = (input.incumbentModel || '').trim();
  const challengerModel = (input.challengerModel || '').trim();
  if (!incumbentModel || !challengerModel) {
    throw new Error('[classifier-replay] both incumbentModel and challengerModel are required');
  }
  // CATALOG KEYS, NOT BEDROCK IDS (owner, 2026-08-10).
  //
  // This took free text and passed it to `ConverseCommand`, so a run only SUCCEEDED if the operator typed
  // a real Bedrock model id. Everything else in the system - profiles and experiment variants alike -
  // speaks catalog keys, so the gate was the only surface with a different vocabulary. The console then
  // compared a stored id against `newExperiment.controlModel`, a key, which can never match: the gate
  // block never cleared and EVERY classification experiment was refused.
  //
  // Requiring keys here makes the two sides comparable and puts this write path under the same rule as the
  // others: confirm the model is in the catalog at the point it is selected. The id is resolved from the
  // key at the model call, where the deployment's own region and account are known.
  //
  // Not a security boundary - `bedrock:InvokeModel` is already scoped to catalog ARNs, so an unknown id
  // AccessDenied rather than reaching an unapproved model. This is about a feature that could not be used.
  const keys = modelCatalogKeys();
  for (const [label, value] of [['incumbentModel', incumbentModel], ['challengerModel', challengerModel]] as const) {
    if (!keys.has(value)) {
      throw new Error(
        `[classifier-replay] ${label} '${value}' is not a model catalog key; one of: `
        + `${[...keys].sort().map((k) => `'${k}'`).join(', ')}`,
      );
    }
  }
  if (incumbentModel === challengerModel) {
    // Not a guard against wasted spend so much as against a meaningless result: one model against
    // itself produces a corpus of agreements and an "indistinguishable" verdict that says nothing.
    throw new Error('[classifier-replay] incumbentModel and challengerModel must differ');
  }
  const windowDays = Math.min(Math.max(Number(input.windowDays) || DEFAULT_WINDOW_DAYS, 1), MAX_WINDOW_DAYS);
  const limit = Math.min(Math.max(Number(input.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);
  return { incumbentModel, challengerModel, windowStart, windowEnd, limit };
}
