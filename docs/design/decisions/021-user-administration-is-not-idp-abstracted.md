---
title: "ADR-021: User administration is not IdP-abstracted; the console points at the configured provider"
status: Accepted 2026-07-29
date: 2026-07-29
related:
  - "../../guides/user/IDENTITY-PROVIDER-GUIDE.md"
  - "../../specs/interaction/identity-access/core/IDENTITY-AND-ACCESS-MODEL.md"
  - "../../../backend/lambda/src/user-management.ts"
  - "../../../frontend/packages/admin/src/components/admin/UserManagementTab.tsx"
tracking: |
  Implemented 2026-07-29: `identityProvider` CDK context -> `IdentityProvider` CfnOutput ->
  `VITE_IDENTITY_PROVIDER`; `UserManagementTab` renders `ExternalIdpNotice` and skips its fetch when
  the value is not `cognito`. Documented as Step 9 of IDENTITY-PROVIDER-GUIDE.md.
---

# ADR-021: User administration is not IdP-abstracted; the console points at the configured provider

## Status

Accepted. Raised by the question of why identity-adjacent APIs sit in a Cognito-named stack when the
platform positions the IdP as pluggable.

## Context

AgentEchelon authenticates through a pluggable identity provider: `IDENTITY-PROVIDER-GUIDE.md`
describes replacing Cognito User Pools with your own SAML or OIDC provider, and the authorization
model reads GROUP MEMBERSHIP rather than anything Cognito-specific.

`user-management.ts` - the Lambda behind the admin console's User Management tab (list, approve,
reject, change tier, enable, delete) - does not follow that model. It calls Cognito User Pool admin
APIs directly: `AdminListGroupsForUser`, `AdminUpdateUserAttributes`, `AdminDisableUser`,
`AdminAddUserToGroup`, `AdminDeleteUser`.

That leaves a contradiction. A deployment that takes the documented BYO-IdP path has no user-management
implementation at all, and the guide did not say so - it kept citing `user-management.ts` as the admin
override for tier changes, which cannot work once User Pools are not the directory. The tab would
render, its buttons would act on a directory nobody uses, and the operator would have no signal.

Two options were considered:

1. **Abstract user administration** behind a provider interface, as the user-profile store is
   abstracted. Correct in principle, but it means defining a cross-provider contract for user
   lifecycle, group assignment, and disable/delete across arbitrary IdPs. That is a large surface, and
   every real deployment already administers users in its own IdP's console.
2. **Declare the boundary and make it visible.** Keep the Cognito implementation as the bundled
   provider's reference implementation and have the product say so.

## Decision

**User administration is NOT abstracted across identity providers. It is a bundled-Cognito reference
implementation, and the product states this rather than implying otherwise.**

- A descriptive `identityProvider` CDK context value (default `cognito`) names the provider that
  actually governs end users. It changes no authorization behaviour.
- It surfaces as a `CfnOutput` mapped to `VITE_IDENTITY_PROVIDER`, the same pattern as `analyticsMode`
  and `adminIamEnforcement`, so the deployed value and the console can never disagree.
- When it is not `cognito`, the User Management tab renders a short notice that users are administered
  in that provider, and **skips its fetch entirely** - the endpoint is Cognito-backed, so calling it
  would show a spurious error on a correctly-configured deployment.
- `IDENTITY-PROVIDER-GUIDE.md` Step 9 states the boundary and that tier still follows group
  membership, so the group-sync step remains required.

`UserManagementApi` therefore stays in the identity stack. It is genuinely Cognito-coupled, so that is
where it belongs - unlike the feedback API, which had no identity relationship and moved out.

## Consequences

- A BYO-IdP deployer gets an honest, self-explanatory surface instead of a broken one.
- AgentEchelon does not claim an abstraction it does not have. The pluggable boundary covers
  AUTHENTICATION and authorization-by-group; it does not cover user lifecycle administration.
- If a deployer does want in-product administration of an external IdP, that is a new capability with
  its own spec, not a bug in this one.
- **Revisit when** a deployment needs to administer users from within AgentEchelon against a non-Cognito
  provider. At that point the contract is worth defining properly, informed by a real provider rather
  than speculatively.
