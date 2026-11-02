---
title: "ADR-021: User administration is not IdP-abstracted; the console points at the configured provider"
status: >-
  Accepted 2026-07-29. Amended by ADR-058 (accepted 2026-10-27): offboarding is not administration and runs by AppInstanceUser for every issuer.
date: 2026-07-29
related:
  - "../../guides/user/IDENTITY-PROVIDER-GUIDE.md"
  - "./058-offboarding-runs-by-app-instance-user-for-every-issuer.md"
  - "../../specs/interaction/governance/IDENTITY-AND-ACCESS-MODEL.md"
  - "../../../backend/lambda/src/user-management.ts"
  - "../../../frontend/packages/admin/src/components/admin/UserManagementTab.tsx"
tracking: |
  Implemented 2026-07-29: the trusted-issuer registry (`issuers`) -> `IdentityProvider` CfnOutput ->
  `VITE_IDENTITY_PROVIDER`; `UserManagementTab` renders `ExternalIdpNotice` and skips its fetch when
  the value is not `cognito`. Documented as Step 9 of IDENTITY-PROVIDER-GUIDE.md.
---

# ADR-021: User administration is not IdP-abstracted; the console points at the configured provider

## Status

Accepted. Raised by the question of why identity-adjacent APIs sit in a Cognito-named stack when the platform positions the IdP as pluggable.

## Context

AgentEchelon authenticates through a pluggable identity provider: `IDENTITY-PROVIDER-GUIDE.md` describes replacing Cognito User Pools with your own SAML or OIDC provider, and the authorization model reads GROUP MEMBERSHIP rather than anything Cognito-specific.

`user-management.ts` - the Lambda behind the admin console's User Management tab (list, approve, reject, change tier, enable, delete) - does not follow that model. It calls Cognito User Pool admin APIs directly: `AdminListGroupsForUser`, `AdminUpdateUserAttributes`, `AdminDisableUser`, `AdminAddUserToGroup`, `AdminDeleteUser`.

That leaves a contradiction. A deployment that takes the documented BYO-IdP path has no user-management implementation at all, and the guide did not say so - it kept citing `user-management.ts` as the admin override for tier changes, which cannot work once User Pools are not the directory. The tab would render, its buttons would act on a directory nobody uses, and the operator would have no signal.

Two options were considered:

1. **Abstract user administration** behind a provider interface, as the user-profile store is abstracted. Correct in principle, but it means defining a cross-provider contract for user lifecycle, group assignment, and disable/delete across arbitrary IdPs. That is a large surface, and every real deployment already administers users in its own IdP's console.
2. **Declare the boundary and make it visible.** Keep the Cognito implementation as the bundled provider's reference implementation and have the product say so.

## Decision

**User administration is NOT abstracted across identity providers. It is a bundled-Cognito reference implementation, and the product states this rather than implying otherwise.**

- A descriptive `IdentityProvider` stack output (default `cognito`, otherwise the provider a `cognito-federated` entry of the trusted-issuer registry names) names the provider that actually governs end users. It changes no authorization behavior.
- It surfaces as a `CfnOutput` mapped to `VITE_IDENTITY_PROVIDER`, the same pattern as `analyticsMode`, so the deployed value and the console can never disagree.
- When it is not `cognito`, the User Management tab renders a short notice that users are administered in that provider, and **skips its fetch entirely** - the endpoint is Cognito-backed, so calling it would show a spurious error on a correctly-configured deployment.
- `IDENTITY-PROVIDER-GUIDE.md` Step 9 states the boundary and that tier still follows group membership, so the group-sync step remains required.

User management (`UserManagementFunction`) is an admin handler, so it is in the `AdminServices` stack with the `IdentityProvider` output, and its routes are on `AdminApi`. It is genuinely Cognito-coupled, which makes it the bundled-provider reference implementation; erasing a person stays identity, in the `Identity` stack's `OffboardingFunction`, which user management invokes.

## Consequences

- A BYO-IdP deployer gets an honest, self-explanatory surface instead of a broken one.
- AgentEchelon does not claim an abstraction it does not have. The pluggable boundary covers AUTHENTICATION and authorization-by-group; it does not cover user lifecycle administration.
- If a deployer does want in-product administration of an external IdP, that is a new capability with its own spec, not a bug in this one.
- **Revisit when** a deployment needs to administer users from within AgentEchelon against a non-Cognito provider. At that point the contract is worth defining properly, informed by a real provider rather than speculatively.

## Amendment proposed 2026-10-17: offboarding is not administration

Proposed in [ADR-058](./058-offboarding-runs-by-app-instance-user-for-every-issuer.md); this decision's user-lifecycle scope is unchanged until ADR-058 is accepted.

**What changes.** This decision covers user lifecycle administration: list, approve, reject, enable and disable, and setting a group. That stays a bundled-Cognito reference implementation, and the reasoning above stands for it. Offboarding is removed from its scope. Deleting a person is not administering an identity provider's record: it erases the person's data, and a person is one AppInstanceUser whichever identity provider signed them in ([IDENTITY-AND-ACCESS-MODEL.md](../../specs/interaction/governance/IDENTITY-AND-ACCESS-MODEL.md) §1a).

**The narrowed decision.** Offboarding runs by AppInstanceUser id for every issuer. It removes every store ADR-058 lists, the admin-plane twin found by its owner tag, and the identity provider's user only when the bundled pool holds one. Battle votes and feedback stay, carrying the AppInstanceUser id. Nothing to delete is a 404, never a 200. The console lists people from AppInstanceUsers, so a person from another issuer can be found and offboarded.

**Why.** Erasure is a property of the platform's records, and those records are keyed by the AppInstanceUser. Tying it to one provider's admin API leaves every person from another issuer impossible to offboard, which is a data-handling gap rather than a missing convenience, and it is the case "Revisit when" above anticipated for lifecycle administration but not for erasure.

**Offboarding is outside this decision.** The delete in `user-management.ts` offboards by AppInstanceUser for a person of every issuer and keeps their battle votes and feedback (ADR-058, `backend/lambda/src/lib/offboarding.ts`, deployed to dev on 2026-10-27, **NOT VERIFIED** on a deployment).
