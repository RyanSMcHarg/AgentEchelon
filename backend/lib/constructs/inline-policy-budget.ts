/**
 * NO ROLE CARRIES MORE INLINE POLICY THAN IAM ALLOWS, CHECKED ON THE TEMPLATE THAT DEPLOYS.
 *
 * IAM caps the inline policies on one role at 10,240 bytes combined (the role's own `Policies` plus every
 * `AWS::IAM::Policy` attached to it). Synthesis does not check this; CloudFormation finds out mid-update and
 * rolls the whole stack back. `no-role-exceeds-the-inline-policy-limit.test.ts` guards it in CI, but it
 * synthesizes with fixed props, and the deploy carries statements the test cannot see: context-dependent
 * grants, cross-stack tokens, and the condition `ExcludeOwnerTeamTag` adds to every tagging statement. On
 * 2026-10-15 premium's acting role measured about 9,000 bytes in the test and 10,058 in the synthesized
 * deploy template, 182 bytes under the limit.
 *
 * So the same measure runs as a validation on every stack of the app, after every aspect has applied, with
 * whatever context this synth was given. A deploy whose template would cross the bound fails at synth with
 * the role named, before CloudFormation sees it.
 *
 * THE MEASURE is the guard test's: `JSON.stringify` of each policy document as CloudFormation will receive
 * it, overrides included, before tokens resolve. IAM measures resolved text without whitespace; the margin
 * covers the difference.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';

export const IAM_INLINE_POLICY_LIMIT = 10_240;
export const INLINE_POLICY_MARGIN = 1_200;
export const INLINE_POLICY_BOUND = IAM_INLINE_POLICY_LIMIT - INLINE_POLICY_MARGIN;

/** The resource as CloudFormation will receive it, property overrides included. */
function rendered(stack: cdk.Stack, resource: cdk.CfnResource): { Properties?: Record<string, any> } {
  // `_toCloudFormation` is how CDK itself renders a resource into the template; it applies the overrides
  // aspects add (`addPropertyOverride`), which reading `policyDocument` would miss.
  const out = stack.resolve((resource as unknown as { _toCloudFormation(): Record<string, any> })._toCloudFormation());
  return (Object.values(out.Resources ?? {})[0] ?? {}) as { Properties?: Record<string, any> };
}

/** Inline-policy bytes per role, keyed by the role's logical id. */
export function inlinePolicyBytesByRole(stack: cdk.Stack): Map<string, number> {
  const bytes = new Map<string, number>();
  const add = (role: string, n: number) => bytes.set(role, (bytes.get(role) ?? 0) + n);
  for (const node of stack.node.findAll()) {
    if (cdk.Stack.of(node) !== stack) continue;
    if (node instanceof iam.CfnRole) {
      const props = rendered(stack, node).Properties ?? {};
      const id = stack.getLogicalId(node);
      for (const p of (props.Policies ?? []) as Array<{ PolicyDocument: unknown }>) add(id, JSON.stringify(p.PolicyDocument).length);
    } else if (node instanceof iam.CfnPolicy) {
      const props = rendered(stack, node).Properties ?? {};
      const size = JSON.stringify(props.PolicyDocument).length;
      for (const ref of (props.Roles ?? []) as Array<{ Ref?: string }>) if (ref?.Ref) add(ref.Ref, size);
    }
  }
  return bytes;
}

/** Fail the synth of any stack in `app` whose roles carry more inline policy than the bound. */
export function enforceInlinePolicyBudget(app: IConstruct): void {
  for (const stack of app.node.findAll().filter((c): c is cdk.Stack => cdk.Stack.isStack(c))) {
    stack.node.addValidation({
      validate: () => [...inlinePolicyBytesByRole(stack)]
        .filter(([, n]) => n > INLINE_POLICY_BOUND)
        .map(([role, n]) => `${stack.stackName}: role ${role} carries ${n} bytes of inline policy, over the `
          + `${INLINE_POLICY_BOUND}-byte bound (IAM's limit is ${IAM_INLINE_POLICY_LIMIT}). Move a grant to a managed `
          + 'policy, merge statements, or delete unused ones.'),
    });
  }
}
