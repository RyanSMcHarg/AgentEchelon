/**
 * A vended credential is pinned to a bearer, and the pin cannot be opted out of.
 *
 * SPEC-CREDENTIAL-EXCHANGE and SPEC-CONVERSATION-SECURITY both state that a classification role cannot be
 * assumed un-pinned and takes the same shape as the per-assistant roles. Those sentences were true
 * of the per-assistant roles and not of the classification roles: `assumedBy` with a bare `ArnPrincipal` emits an
 * UNCONDITIONED `sts:AssumeRole`, and the `person`/`classification` conditions sat on a separate
 * `sts:TagSession` statement beside it.
 *
 * THOSE TWO ARRANGEMENTS LOOK EQUIVALENT AND ARE NOT. Conditions on `sts:TagSession` bite only on a
 * call that tags. An exchange that assumed the role WITHOUT tags was permitted by the unconditioned
 * statement and skipped the pin entirely - the resulting session bore nothing, so
 * `${aws:PrincipalTag/person}` resolved to nothing and the credential reached nothing, which is why this
 * was a false claim rather than an escalation. A false claim about a pin is still worth refusing:
 * the specs were read as a description of enforcement.
 *
 * READ FROM THE SYNTHESIZED TEMPLATE, not from the construct, because the gap was invisible in the
 * source and visible in the trust document. This asserts the shape a reviewer would have to diff two
 * statements by hand to see.
 */
import { adminServicesTemplate, identityTemplate } from './helpers/synth';


interface TrustStatement {
  Action?: string | string[];
  Condition?: Record<string, Record<string, unknown>>;
}

/**
 * Every exchange role, by logical id, with its trust statements: the person exchange's classification roles
 * (Identity) and the admin plane's (AdminServices, assumed only by the admin credential exchange).
 */
function exchangeRoles(): Array<{ id: string; statements: TrustStatement[] }> {
  const roles = { ...identityTemplate().findResources('AWS::IAM::Role'), ...adminServicesTemplate().findResources('AWS::IAM::Role') };

  return Object.entries(roles)
    // The classification roles and the admin-plane role. `CredentialExchangeRole` itself is the Lambda's own
    // execution role and is assumed by the service, not by a bearer, so it is not one of these.
    .filter(([id]) => id.startsWith('ExchangeRole'))
    .map(([id, resource]) => ({
      id,
      statements: ((resource as { Properties?: { AssumeRolePolicyDocument?: { Statement?: TrustStatement[] } } })
        .Properties?.AssumeRolePolicyDocument?.Statement ?? []),
    }));
}

const actionsOf = (s: TrustStatement): string[] =>
  Array.isArray(s.Action) ? s.Action : s.Action ? [s.Action] : [];

describe('an exchange role cannot be assumed un-pinned', () => {
  it('synthesizes the classification roles and the admin plane, so the assertions below are not vacuous', () => {
    const found = exchangeRoles().map((r) => r.id);
    // One per declared classification, plus `restricted`, plus the admin plane. The exact names
    // depend on the deployment's declared classifications, so this asserts the shape rather than a
    // list that a rename would break.
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found.some((id) => id.includes('AdminPlane'))).toBe(true);
    expect(found.some((id) => id.includes('Restricted'))).toBe(true);
  });

  it('conditions sts:AssumeRole itself on the bearer and the classification, on every one', () => {
    for (const { id, statements } of exchangeRoles()) {
      const assumes = statements.filter((s) => actionsOf(s).includes('sts:AssumeRole'));
      expect({ id, count: assumes.length }).toEqual({ id, count: 1 });

      const condition = assumes[0].Condition ?? {};
      // THE BEARER. Without this the session carries no `person`, and every policy written in terms of
      // `${aws:PrincipalTag/person}` silently resolves to nothing.
      expect({ id, person: condition.StringLike?.['aws:RequestTag/person'] })
        .toEqual({ id, person: '*' });
      // THE CLASSIFICATION. This is what stops a session asserting one classification being minted on
      // the role carrying another's grant set - the role choice and the clearance computation are
      // made separately, and this is what turns their agreement into something AWS refuses to violate.
      expect(typeof condition.StringEquals?.['aws:RequestTag/classification']).toBe('string');
    }
  });

  it('repeats the same conditions on sts:TagSession, so assuming WITH tags is gated identically', () => {
    // Assuming with tags needs both actions permitted. A TagSession statement conditioned differently
    // from the assume would leave one of the two paths looser than the other.
    for (const { id, statements } of exchangeRoles()) {
      const assume = statements.find((s) => actionsOf(s).includes('sts:AssumeRole'));
      const tag = statements.find((s) => actionsOf(s).includes('sts:TagSession'));
      expect({ id, hasTagStatement: Boolean(tag) }).toEqual({ id, hasTagStatement: true });
      expect({ id, condition: tag!.Condition }).toEqual({ id, condition: assume!.Condition });
    }
  });

  it('leaves no trust statement that permits an assume without conditions', () => {
    // The regression this guards: adding a principal back as a bare `ArnPrincipal` appends an
    // unconditioned statement beside the conditioned one, and permissive statements OR together - so
    // the pin would still be present, and still be optional.
    for (const { id, statements } of exchangeRoles()) {
      const unconditioned = statements
        .filter((s) => actionsOf(s).some((a) => a.startsWith('sts:')))
        .filter((s) => !s.Condition || Object.keys(s.Condition).length === 0);
      expect({ id, unconditioned }).toEqual({ id, unconditioned: [] });
    }
  });
});
