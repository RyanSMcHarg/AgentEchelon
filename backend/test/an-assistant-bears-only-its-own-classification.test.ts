/**
 * THE BEARER IS THE IMPERSONATION BOUNDARY, AND NOTHING SITS BEHIND IT.
 *
 * Amazon Chime SDK does not bind `x-amz-chime-bearer` to the caller. AWS documents the opposite: "The
 * IAM permissions for Amazon Chime SDK messaging APIs require an `app-instance-user-arn` that matches
 * the `chime-bearer` parameter", and widening that resource to `/user/*` is the documented way to let a
 * back-end service act as anybody (dg/call-from-backend.html). What the service enforces on its own is
 * role and channel membership, neither of which asks whether the IAM caller is the bearer.
 *
 * So the bearer statement is the whole of the impersonation control on the assistant path, and an
 * unconditioned `/bot/*` is an open door: any assistant may post as any other assistant in the app
 * instance, under that assistant's name, in a room its own classification may act in.
 *
 * ── WHY THE CONDITION IS A TAG AND NOT A LIST OF ARNs ───────────────────────────────────────────
 *
 * A processor legitimately bears MORE than one bot: its own, and the single alt occupant of its
 * (classification, role) that a duel side posts as. Both are created at deploy and both carry a
 * `classification` tag, so the tag permits exactly that pair. A literal ARN list would also work today
 * and would rot: an assistant is meant to be creatable and assignable at runtime, and a list would need
 * a deploy per creation. It would also need the alt ARNs, which are created in `battle-stack` and are
 * not reachable from the roles' own stack.
 *
 * ── WHAT THIS DOES NOT CLOSE, STATED SO IT IS NOT MISTAKEN FOR DONE ─────────────────────────────
 *
 * Two assistants INSIDE one classification can still bear each other: they share the tag. That needs
 * the per-assistant pin (an `assistant` session tag on an assumed slot, Phase 1b) and arrives with the
 * second assistant that creates the need. This test asserts the cross-classification half only.
 *
 * The live counterpart is `tests/e2e/an-assistant-boundary-refuses-cloudwatch.spec.ts`, which asks AWS
 * rather than the template. This one runs in CI with no deployment, so a regression is caught before it
 * ships rather than after.
 */
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { classificationChannelScopedAllow } from '../lib/stacks/agent-classification-common';

const APP_INSTANCE = 'arn:aws:chime:us-east-1:123456789012:app-instance/11111111-2222-3333-4444-555555555555';
const ACTIONS = ['chime:SendChannelMessage'];

/** The bearer statement out of a built grant, found by its Sid rather than by position. */
function bearerStatement(statements: cdk.aws_iam.PolicyStatement[]): Record<string, unknown> {
  const found = statements
    .map((s) => s.toStatementJson() as Record<string, unknown>)
    .find((s) => s.Sid === 'AllowChannelActionsAsBearerIdentity');
  if (!found) throw new Error('no AllowChannelActionsAsBearerIdentity statement was produced');
  return found;
}

/** The `aws:ResourceTag/classification` values a statement's condition permits, or null if unconditioned. */
function permittedTag(statement: Record<string, unknown>): string[] | null {
  const cond = statement.Condition as Record<string, Record<string, unknown>> | undefined;
  const value = cond?.StringEquals?.['aws:ResourceTag/classification'];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

describe('an assistant may bear only its own classification', () => {
  it('conditions the bearer statement on the classification tag', () => {
    const statements = classificationChannelScopedAllow('standard', APP_INSTANCE, ACTIONS, {
      actor: 'assistant',
      bearerResources: [`${APP_INSTANCE}/bot/*`],
    });
    expect(permittedTag(bearerStatement(statements))).toEqual(['standard']);
  });

  it('permits its own classification ONLY, so a premium bot is not bearable by a standard assistant', () => {
    for (const classification of ['basic', 'standard', 'premium'] as const) {
      const statements = classificationChannelScopedAllow(classification, APP_INSTANCE, ACTIONS, {
        actor: 'assistant',
        bearerResources: [`${APP_INSTANCE}/bot/*`],
      });
      const permitted = permittedTag(bearerStatement(statements));
      expect(permitted).toEqual([classification]);
      // The property that matters, stated directly: no other classification's identities qualify.
      for (const other of ['basic', 'standard', 'premium'].filter((c) => c !== classification)) {
        expect(permitted).not.toContain(other);
      }
    }
  });

  it('still allows the wildcard RESOURCE, because one principal currently carries two identities', () => {
    // NOT because bearing the alt is correct. A primary should never bear the alt: the alt occupancy
    // has its own slot role (six are deployed, live and alt per classification), and the intended
    // shape is that a duel side ASSUMES that slot, whose policy names the one bot it may bear. Until
    // something assumes the slots (Phase 1b), the single shared processor role answers as both, so
    // narrowing the resource to one ARN here would break duels. The tag is what distinguishes "my
    // classification's bots" from "anyone's" while that is true.
    const statements = classificationChannelScopedAllow('premium', APP_INSTANCE, ACTIONS, {
      actor: 'assistant',
      bearerResources: [`${APP_INSTANCE}/bot/*`],
    });
    const resource = bearerStatement(statements).Resource;
    expect(Array.isArray(resource) ? resource : [resource]).toContain(`${APP_INSTANCE}/bot/*`);
  });

  it('leaves a PERSON\'s pinned bearer untouched', () => {
    // The exchange pins the bearer to the caller's own identity, which is strictly stronger. Adding a
    // classification condition there could only widen it to a whole tier, and would turn an untagged
    // or mistagged user into an outage. Proven live by deny-test-credential-exchange.mjs.
    const pinned = `${APP_INSTANCE}/user/` + '${aws:PrincipalTag/person}';
    const statements = classificationChannelScopedAllow('basic', APP_INSTANCE, ACTIONS, {
      actor: 'person',
      bearerResources: [pinned],
    });
    const statement = bearerStatement(statements);
    expect(permittedTag(statement)).toBeNull();
    const resource = statement.Resource;
    expect(Array.isArray(resource) ? resource : [resource]).toContain(pinned);
  });

  it('carries the condition into a synthesized policy, not just the helper\'s return value', () => {
    // The helper is only right if what CloudFormation receives is right. A statement built correctly
    // and then dropped or rewritten by the construct would pass every assertion above.
    const stack = new cdk.Stack(new cdk.App(), 'T');
    const role = new cdk.aws_iam.Role(stack, 'R', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    for (const s of classificationChannelScopedAllow('premium', APP_INSTANCE, ACTIONS, {
      actor: 'assistant',
      bearerResources: [`${APP_INSTANCE}/bot/*`],
    })) {
      role.addToPolicy(s);
    }
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowChannelActionsAsBearerIdentity',
            Condition: { StringEquals: { 'aws:ResourceTag/classification': 'premium' } },
          }),
        ]),
      },
    });
  });
});
