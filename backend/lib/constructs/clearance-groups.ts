/**
 * THE GROUPS ON THE DEPLOYMENT'S OWN POOL THAT CLEAR FOR ONE CLASSIFICATION (`groupClearance`), built by the
 * stack that owns the classification: `Assistants-<classification>` for a conversational one, `Identity` for
 * the admin plane. Each group's precedence is the classification's declared `groupPrecedence`, so declaring a
 * classification adds its groups with its own stack and renumbers no other group (the
 * classification-independence plan, step 4).
 *
 * A GROUP CARRIES NO ROLE. Nothing assumes a role from a group: every credential a person holds is vended by
 * the credential exchange, which reads the groups as clearance through the registry.
 */
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { defaultProfileRegistry as profiles } from '../profile-registry';

/** The `groupClearance` groups that clear for `classification`, in declaration order. */
export function clearanceGroupsFor(classification: string): string[] {
  return Object.entries(profiles.groupClearance).filter(([, c]) => c === classification).map(([g]) => g);
}

/**
 * One `CfnUserPoolGroup` per group that clears for `classification`, on `userPoolId`. The construct id is
 * `<group>Group`, as it has always been. Returns the groups built.
 */
export function clearanceGroups(scope: Construct, classification: string, userPoolId: string): cognito.CfnUserPoolGroup[] {
  const precedence = profiles.groupPrecedenceOf(classification);
  return clearanceGroupsFor(classification).map((group) => new cognito.CfnUserPoolGroup(scope, `${group}Group`, {
    userPoolId,
    groupName: group,
    description: `${classification} classification — ${profiles.requireProfileFor(classification).modelKey}`,
    ...(typeof precedence === 'number' ? { precedence } : {}),
  }));
}
