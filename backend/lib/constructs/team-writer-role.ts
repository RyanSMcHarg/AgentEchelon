/**
 * A FUNCTION'S TEAM WRITER ROLE: WHAT A TEAM ROUTE WRITES, BOUND BY IAM TO THE ASSISTANT ITS PATH NAMES
 * (DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT 5.1, tenets D3 and D12).
 *
 * A function that serves both an administrator's routes and a team's (`/admin/assistants/{assistant}/...`) keeps the
 * reach an administrator needs on its own execution role. On a team route it writes on a session of this role instead
 * (`lambda/src/lib/team-scoped-writer.ts`), tagged with the path's assistant, and every grant here names
 * `${aws:PrincipalTag/assistant}`. So a write the handler aims at another team's assistant is refused by IAM, behind
 * the gateway's narrowing of the console session and the handler's own ownership check.
 *
 * ONE ROLE PER FUNCTION: the principal is the unit (tenet D12), so each role names the one execution role that may
 * assume it, and holds that function's team writes and nothing else.
 *
 * THE TRUST: that execution role alone, on `sts:AssumeRole` and `sts:TagSession`, each requiring an `assistant` tag
 * that is present and holds no `/`, and refusing any tag key the role does not read. The full assistant id pattern is
 * not expressible in an IAM condition; the handler checks it before it assumes (`ASSISTANT_ID_PATTERN`).
 *
 * A credential is minted on it, so it carries a permissions boundary of its own statements (STACKS.md
 * "Permissions boundaries").
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { permissionsBoundary } from './permissions-boundary';
import { TEAM_WRITER_ROLE_ARN_ENV, TEAM_WRITER_TAG } from '../../lambda/src/lib/team-writer-tags';

/** The policy variable a team writer's grants name: the assistant the session is tagged with. */
export const TEAM_ASSISTANT = `\${aws:PrincipalTag/${TEAM_WRITER_TAG.assistant}}`;
/** The policy variable an alt's candidate grant names: the alt of that assistant's role, when the session carries one. */
export const TEAM_ALT = `\${aws:PrincipalTag/${TEAM_WRITER_TAG.alt}}`;
/** The condition every alt grant carries, so it applies only to a session tagged with an alt. */
export const WHEN_TAGGED_WITH_AN_ALT = { StringLike: { [`aws:PrincipalTag/${TEAM_WRITER_TAG.alt}`]: 'alt-*' } };

export interface TeamWriterRoleProps {
  /** The one execution role that may assume it: the function serving the team routes. */
  assumedBy: iam.IRole;
  /** The role's grants, every one naming `TEAM_ASSISTANT` (or `TEAM_ALT`). Called twice: the policy and the boundary. */
  statements: () => iam.PolicyStatement[];
  /** Whether a session may also carry an `alt` tag (a candidate version published into the assistant's role's alt). */
  alt?: boolean;
  description: string;
}

/** The trust conditions: an `assistant` tag that is present and one path segment, and no tag key the role does not read. */
function tagPin(alt: boolean): Record<string, unknown> {
  const keys = alt ? [TEAM_WRITER_TAG.assistant, TEAM_WRITER_TAG.alt] : [TEAM_WRITER_TAG.assistant];
  return {
    StringLike: { [`aws:RequestTag/${TEAM_WRITER_TAG.assistant}`]: '?*' },
    StringNotLike: {
      [`aws:RequestTag/${TEAM_WRITER_TAG.assistant}`]: '*/*',
      ...(alt ? { [`aws:RequestTag/${TEAM_WRITER_TAG.alt}`]: '*/*' } : {}),
    },
    'ForAllValues:StringEquals': { 'aws:TagKeys': keys },
  };
}

export class TeamWriterRole extends Construct {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: TeamWriterRoleProps) {
    super(scope, id);
    const pin = tagPin(props.alt === true);
    const assumer = new iam.ArnPrincipal(props.assumedBy.roleArn);
    // THE CONDITIONS GO ON THE ASSUME ITSELF, not only on `sts:TagSession`, so an untagged assume is refused.
    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.PrincipalWithConditions(assumer, pin),
      inlinePolicies: { TeamWrites: new iam.PolicyDocument({ statements: props.statements() }) },
      permissionsBoundary: permissionsBoundary(this, 'Boundary', `${props.description} (its own statements)`, props.statements()),
      maxSessionDuration: cdk.Duration.hours(1),
      description: props.description,
    });
    this.role.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      principals: [assumer],
      actions: ['sts:TagSession'],
      conditions: pin,
    }));
    // A policy of the execution role's own, apart from the role, so the two roles do not name each other.
    props.assumedBy.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'WriteAsTheRoutesTeam',
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: [this.role.roleArn],
    }));
  }

  /** Name this role to the function that assumes it. */
  wire(fn: { addEnvironment: (key: string, value: string) => unknown }): void {
    fn.addEnvironment(TEAM_WRITER_ROLE_ARN_ENV, this.role.roleArn);
  }
}
