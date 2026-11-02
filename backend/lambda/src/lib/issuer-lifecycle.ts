/**
 * The Cognito calls that delete a subject's account, as CloudTrail records them. An EventBridge rule on
 * these, for this deployment's pools, runs offboarding (`offboarding-events.ts`). One list, read by the
 * rule (`identity-stack.ts`) and by the handler, so the two cannot disagree.
 *
 * A DISABLE OR AN ENABLE IS NOT ON IT. The platform keeps no copy of whether an account may sign in: the
 * credential exchange asks the issuer at every vend (SPEC-CREDENTIAL-EXCHANGE §4b), so a disable needs
 * nothing recorded and an enable nothing restored.
 *
 * `DeleteUser` is a person deleting their own account with an access token; its record may name no pool,
 * in which case the rule does not match it and the sweep is what offboards them.
 */
export const COGNITO_LIFECYCLE_EVENTS = ['AdminDeleteUser', 'DeleteUser'] as const;
