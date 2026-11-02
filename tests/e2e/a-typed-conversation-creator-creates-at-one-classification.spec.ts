/**
 * A TYPED-CONVERSATION CREATOR CREATES AT ONE CLASSIFICATION AND READS NO OTHER.
 *
 * `typed-conversation-from-event` is the first conversation creator in this system that can be invoked
 * directly: the payload names the conversation type, the conversation an event concerned, and the person
 * it is for. What it does NOT name is the classification - that comes from the deployment - and this
 * spec is the reason that distinction can be believed rather than read.
 *
 * ── WHY A SIMULATION AND NOT AN ATTEMPT ──────────────────────────────────────────────────────────
 *
 * The role's trust policy admits `lambda.amazonaws.com` and no human principal, so it cannot be assumed
 * from a terminal to be caught failing. `iam simulate-principal-policy` evaluates the DEPLOYED policy
 * with the context a real call would carry, which is the same mechanism
 * `an-ops-role-reaches-only-its-own-classification.spec.ts` uses for the assistant boundaries. Simulating
 * the deployed role is not the same as reading the CDK that produced it: a condition that failed to
 * render, a statement that lost its condition to a Sid collision, or a permissions boundary that
 * narrows it all show up here and in no test of the source.
 *
 * ── THE THREE AXES, AND WHY ALL THREE ARE NEEDED ─────────────────────────────────────────────────
 *
 * Each one alone is bypassable. Tagging bounds what the conversation BECOMES; the absent membership read
 * bounds whose PEOPLE can be carried into it; the assignment subtree bounds which ASSISTANT can be added
 * to it. The people come from the type's membership source, never from a roster, so the role reads no
 * conversation's membership at any classification. A role that could read a higher classification's
 * roster could carry those people into a conversation at its own - which is a disclosure rather than an
 * escalation, and is exactly as unacceptable.
 *
 * ── WHAT IS DELIBERATELY ALLOWED, so its absence is not read as a gap ────────────────────────────
 *
 * `chime:CreateChannel` carries no tag condition and cannot: the tag that would gate it does not exist
 * until the channel does. The role can therefore create an UNTAGGED channel, and that is accounted for
 * rather than overlooked - every per-classification identity is fail-closed on the tag, so an untagged
 * channel is reachable by nobody. It is inert, not a way in.
 *
 * **Coverage:** `e2e/a-typed-conversation-creator-creates-at-one-classification.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors } from './helpers/turn-guards';
import { SSM_ROOT, physicalIdsInClassificationStacks } from './helpers/stack-prefix';
import { awsOrNull as aws } from './helpers/aws';

guardBackendErrors('typed-conversation-classification-pin');

const REGION = process.env.AWS_REGION || 'us-east-1';

/** The classification this creator is deployed at. Everything else must be refused. */
const OWN = 'premium';
/** The classifications it must not reach. `admin` is included because it is the admin plane, which no member classification grants. */
const OTHERS = ['basic', 'standard', 'admin'];

/**
 * THE AUDIENCE A CREATE CARRIES BESIDE ITS CLASSIFICATION (`createOwnClassificationOnly`): a create without it is
 * refused, so every probe below that should be allowed names one, and every refusal names one too, so it is
 * refused for its classification rather than for the missing audience.
 */
const MEMBERS = () => ctx('aws:RequestTag/audience', 'members');

const ctx = (key: string, value: string) =>
  `ContextKeyName=${key},ContextKeyValues=${value},ContextKeyType=string`;

/** One decision from the deployed principal, with the request or resource context supplied. */
function decide(roleArn: string, action: string, resourceArn: string, context: string[] = []): string {
  const entries = context.length ? `--context-entries ${context.join(' ')} ` : '';
  const res = aws(
    `iam simulate-principal-policy --policy-source-arn ${roleArn} `
    + `--action-names ${action} --resource-arns "${resourceArn}" ${entries}`
    + '--query "EvaluationResults[0].EvalDecision"',
  );
  return typeof res === 'string' ? res : 'unknown';
}

/** The app instance every ARN below is built from, derived from the published admin identity. */
function appInstanceArn(): string | null {
  const adminArn = aws(
    `ssm get-parameter --name "${SSM_ROOT}/app-instance-admin-arn" --query "Parameter.Value"`,
  );
  if (typeof adminArn !== 'string' || !adminArn.includes('/user/')) return null;
  return adminArn.split('/user/')[0];
}

/**
 * THE DEPLOYED ROLE, found by name rather than by a published pointer.
 *
 * The function is wired from the conversation-type registry: it exists where a type names this
 * classification and is absent otherwise, and nothing publishes its role ARN because nothing else needs
 * it. A deployment that declares no non-classification type has no such role, which is a SKIP and not a
 * failure - the same distinction the ops-role spec preserves for its opt-in assistant.
 */
function creatorRoleArn(): string | null {
  let roleName: string | undefined;
  try {
    // Read from the classification stacks, not matched on the generated name: see helpers/stack-prefix.ts.
    [roleName] = physicalIdsInClassificationStacks({ type: 'AWS::IAM::Role', logicalId: /^TypedConversationFromEventRole/ });
  } catch {
    return null;
  }
  if (!roleName) return null;
  const arn = aws(`iam get-role --role-name ${roleName} --query "Role.Arn"`);
  return typeof arn === 'string' && arn.startsWith('arn:') ? arn : null;
}

test.describe('the typed-conversation creator is pinned to one classification', () => {
  let roleArn: string | null = null;
  let app: string | null = null;
  let account = '';

  test.beforeAll(() => {
    roleArn = creatorRoleArn();
    app = appInstanceArn();
    account = app ? app.split(':')[4] : '';
  });

  /** Skipped BY NAME when the creator is not deployed, so "absent" never reads as "broken". */
  const needCreator = () => {
    test.skip(!roleArn, 'no typed-conversation creator is deployed (no non-classification type declares this classification)');
    test.skip(!app, 'the app-instance ARN could not be read; nothing can be addressed');
  };

  test('it may stamp its own classification on a conversation it creates', () => {
    needCreator();
    // A CONVERSATION, by its channel ARN. The grant names `channel/*` (plus the bearer leg for the
    // tag-on-create authorization against the service admin), so a literal `${app}/*` names nothing it
    // grants and the simulator denies it for the wrong reason.
    expect(
      decide(roleArn!, 'chime:TagResource', `${app}/channel/probe`, [ctx('aws:RequestTag/classification', OWN), MEMBERS()]),
    ).toBe('allowed');
  });

  test('it may stamp NO other classification, whatever its payload said', () => {
    needCreator();
    // The pin. An invoke supplies the type, the concerned conversation and the person; if this were
    // permitted the function would be a create-at-any-classification primitive, and the tag is the only
    // axis IAM evaluates.
    for (const other of OTHERS) {
      expect(
        decide(roleArn!, 'chime:TagResource', `${app}/channel/probe`, [ctx('aws:RequestTag/classification', other), MEMBERS()]),
        `tagging a new conversation ${other} must be refused`,
      ).not.toBe('allowed');
    }
  });

  test('it may read the membership of no conversation, at any classification', () => {
    needCreator();
    // It adds the people its type's membership source admits and posts nothing into the concerned
    // conversation, so it has no roster to read. A read of a higher classification's roster would let it
    // carry those people into a conversation at its own.
    for (const classification of [OWN, ...OTHERS]) {
      expect(
        decide(roleArn!, 'chime:ListChannelMemberships', `${app}/channel/probe`,
          [ctx('aws:ResourceTag/classification', classification)]),
        `reading a ${classification} conversation's membership must be refused`,
      ).not.toBe('allowed');
    }
  });

  test('it may resolve assistant handles in its own classification only', () => {
    needCreator();
    const key = (c: string) =>
      `arn:aws:ssm:${REGION}:${account}:parameter${SSM_ROOT}/assistant-assignments/${c}`;
    expect(decide(roleArn!, 'ssm:GetParametersByPath', key(OWN))).toBe('allowed');
    // `(premium, ops)` and `(standard, ops)` are different role instances with different scopes. A
    // creator that could enumerate another classification's assignment records could add the wrong one.
    for (const other of OTHERS) {
      expect(
        decide(roleArn!, 'ssm:GetParametersByPath', key(other)),
        `enumerating ${other}'s assignment records must be refused`,
      ).not.toBe('allowed');
    }
  });

  test('only its own declared rules may invoke it through EventBridge, and nothing else may at all', () => {
    needCreator();
    // THE RESOURCE POLICY, AS DEPLOYED. The declared ops event reaches the creator through one rule per
    // declaration (`lib/constructs/event-opened-conversations.ts`), and `targets.LambdaFunction` scopes each
    // permission to that rule's ARN. A statement admitting any other principal, or EventBridge without a
    // source rule, would let an event nobody declared open a conversation.
    let fn = '';
    let rules: string[] = [];
    try {
      [fn] = physicalIdsInClassificationStacks({ type: 'AWS::Lambda::Function', logicalId: /^TypedConversationFromEvent/ });
      rules = physicalIdsInClassificationStacks({ type: 'AWS::Events::Rule', logicalId: /^OpensTypedConversation/ });
    } catch {
      fn = '';
    }
    test.skip(!fn, 'the creator function could not be found in the classification stacks');
    test.skip(!rules.length, 'no declared event rule is deployed on this classification stack yet (openedBy); deploy the stack that builds it');
    const raw = aws(`lambda get-policy --function-name ${fn} --query Policy`);
    expect(typeof raw, 'the creator has a resource policy once a rule targets it').toBe('string');
    const statements = (JSON.parse(raw as string).Statement ?? []) as Array<Record<string, any>>;
    expect(statements.length, 'one permission per declared rule').toBe(rules.length);
    for (const s of statements) {
      expect(s.Principal?.Service, `${s.Sid}: only EventBridge is admitted`).toBe('events.amazonaws.com');
      const source = String(s.Condition?.ArnLike?.['AWS:SourceArn'] ?? '');
      expect(rules.some((name) => source.endsWith(`:rule/${name}`)), `${s.Sid}: admitted only from a declared rule of this stack (${source || 'no source'})`).toBe(true);
    }
  });

  test('it creates a conversation only when it requests its own classification', () => {
    needCreator();
    // CreateChannel IS CONDITIONED: the creation must REQUEST this
    // classification's tag (`createOwnClassificationOnly`), so an untagged create and another
    // classification's create are both refused. The live deny-test proves the same on a real call
    // (`deny-test-assistant-membership.mjs`, 2026-10-16).
    // AGAINST THE APP INSTANCE: CreateChannel authorizes the app instance and the bearer, not a channel that
    // does not exist yet, so a channel ARN here would be denied for the wrong reason.
    const channel = app!;
    expect(decide(roleArn!, 'chime:CreateChannel', channel, [ctx('aws:RequestTag/classification', OWN), MEMBERS()]),
      'a create at its own classification is allowed').toBe('allowed');
    expect(decide(roleArn!, 'chime:CreateChannel', channel),
      'an untagged create is refused').not.toBe('allowed');
    expect(decide(roleArn!, 'chime:CreateChannel', channel, [ctx('aws:RequestTag/classification', OWN)]),
      'a create at its own classification with no audience is refused').not.toBe('allowed');
    for (const other of OTHERS) {
      expect(decide(roleArn!, 'chime:CreateChannel', channel, [ctx('aws:RequestTag/classification', other), MEMBERS()]),
        `a create at ${other} is refused`).not.toBe('allowed');
    }
  });
});
