/**
 * WHO MAY ASK `manage-profiles` FOR EACH OF ITS DIRECT OPERATIONS, BY THE ALIAS IT IS GRANTED.
 *
 * `manage-profiles` is the one writer of the profile namespace, and two functions ask it for work outside its
 * routes: `manage-assistants` for a new assistant's first draft, and `admin-experiments` for an experiment's
 * versions, an alt's battle name and a promotion. Each caller is granted `lambda:InvokeFunction` on its own alias
 * of the function and on nothing else, so IAM binds the caller to the alias; Lambda names the alias it was invoked
 * through in `context.invokedFunctionArn`, and the handler serves an operation only through the alias that
 * operation belongs to. An invoke through the unqualified function, or another caller's alias, is refused.
 *
 * Shared by the stack, which creates each alias and grants it, and by the handler, which reads it.
 */

/** Each alias, and the direct operations a request through it may ask for. */
export const PROFILE_DIRECT_CALLERS = {
  /** `manage-assistants`: checks a create's starting point, then seeds the built assistant's first draft. */
  'assistant-builds': ['aeCheckStartingPoint', 'aeSeedFirstDraft'],
  /** `admin-experiments`: derives an experiment's versions, names an alt for a battle, promotes a measured candidate. */
  experiments: ['aeDeriveExperimentVersions', 'aeDeriveBattleSides', 'aeApplyAltAlias', 'aePromoteCandidate'],
} as const;

export type ProfileDirectCaller = keyof typeof PROFILE_DIRECT_CALLERS;
export type ProfileDirectOp = (typeof PROFILE_DIRECT_CALLERS)[ProfileDirectCaller][number];

/** Every direct operation, whichever alias serves it. */
export const PROFILE_DIRECT_OPS: readonly ProfileDirectOp[] =
  (Object.values(PROFILE_DIRECT_CALLERS) as ReadonlyArray<readonly ProfileDirectOp[]>).flat();

/** The alias an invoke came through, from Lambda's `invokedFunctionArn`; empty for an unqualified invoke. */
export function invokedAliasOf(invokedFunctionArn: string | undefined): string {
  // arn:aws:lambda:<region>:<account>:function:<name>[:<qualifier>]
  const parts = (invokedFunctionArn || '').split(':');
  return parts.length === 8 ? parts[7] : '';
}

/** Every direct operation a payload names, whatever its value: the handler serves the payload only when it may serve each. */
export function directOpsOf(payload: unknown): ProfileDirectOp[] {
  if (!payload || typeof payload !== 'object') return [];
  return PROFILE_DIRECT_OPS.filter((op) => Object.prototype.hasOwnProperty.call(payload, op));
}

/** Whether `op` is served through the alias `invokedFunctionArn` names. */
export function directOpAllowed(op: ProfileDirectOp, invokedFunctionArn: string | undefined): boolean {
  const alias = invokedAliasOf(invokedFunctionArn);
  if (!Object.prototype.hasOwnProperty.call(PROFILE_DIRECT_CALLERS, alias)) return false;
  return (PROFILE_DIRECT_CALLERS[alias as ProfileDirectCaller] as readonly string[]).includes(op);
}

/** The first operation a payload names that the alias does not serve, or undefined when it serves them all. */
export function directOpRefused(payload: unknown, invokedFunctionArn: string | undefined): ProfileDirectOp | undefined {
  return directOpsOf(payload).find((op) => !directOpAllowed(op, invokedFunctionArn));
}
