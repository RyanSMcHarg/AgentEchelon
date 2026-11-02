/**
 * A ROLE'S LIMIT, AS A PERMISSIONS BOUNDARY (tenet D3, two layers; docs/overview/STACKS.md "Permissions
 * boundaries").
 *
 * A boundary is a customer managed policy the role carries as its `PermissionsBoundary`: whatever its
 * identity policy holds now or is given later, by this stack or by another stack attaching a grant to it,
 * and whatever a session policy leaves standing, the role reaches no further than the boundary allows. The
 * guest and `link` session roles and every assistant acting role take one; so does every role a credential is
 * vended on and every role that sits on a request path a person reaches (the edge authorizer, the connector
 * runtime).
 *
 * Two shapes are used, as the existing boundaries use them:
 *
 *  - THE SAME STATEMENTS AS THE IDENTITY POLICY, for a role whose reach is written in one place (a vend role, a
 *    session role): the boundary is today's reach, so a grant added to the role later changes nothing until the
 *    boundary changes with it;
 *  - THE SERVICES A ROLE USES, WITH DENIES, for a role whose grants several helpers add (the assistant acting
 *    role, the connector runtime): the allow names services, never `*`, and each Deny names what the role must
 *    never reach whatever its grants become.
 *
 * Applied with `iam.PermissionsBoundary.of(role).apply(boundary)` where the role is one CDK creates for a
 * function, and with the role's `permissionsBoundary` where the stack creates the role.
 */
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/** What every Lambda execution role writes: its own log group and stream (`AWSLambdaBasicExecutionRole`). */
export function functionLogsBoundary(): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'BoundaryItsOwnLogs',
    actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
    resources: ['*'],
  });
}

/** A permissions boundary: what a role cannot exceed, named by what it is for. */
export function permissionsBoundary(
  scope: Construct,
  id: string,
  description: string,
  statements: iam.PolicyStatement[],
): iam.ManagedPolicy {
  return new iam.ManagedPolicy(scope, id, { description, statements });
}

/** The boundary each role `boundRole` bounded, so an aspect that adds to every function role's reach finds it. */
const bounded = new WeakMap<iam.IRole, iam.IManagedPolicy>();

/** Bound a role CDK created for a function (or any role it did not create here) by `boundary`. */
export function boundRole(role: iam.IRole | undefined, boundary: iam.IManagedPolicy): void {
  if (!role) throw new Error('boundRole: the function has no role to bound');
  iam.PermissionsBoundary.of(role).apply(boundary);
  bounded.set(role, boundary);
}

/** The permissions boundary a role carries: the one `boundRole` applied, or the one the role was created with. */
export function boundaryOf(role: iam.IRole | undefined): iam.IManagedPolicy | undefined {
  if (!role) return undefined;
  return bounded.get(role) ?? (role instanceof iam.Role ? role.permissionsBoundary : undefined);
}
