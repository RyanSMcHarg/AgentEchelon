---
title: "ADR-059: The admin plane accepts every issuer the chat plane accepts, and the federated admin mode is removed"
status: >-
  Accepted 2026-10-17. Decisions 1, 2, 3 and 5 are built. `hostAdminPoolId` is refused at synth (`backend/lib/config/deploy-context.ts:121`), every admin route is `AWS_IAM`, and `adminAuthMode=federated` is refused at synth (`getAdminAuthMode`, `backend/lib/constructs/admin-auth-mode.ts`). A console session is vended to any registry issuer that declares `admin: true`, admitted by the admin plane's edge authorizer and checked again by the admin exchange (`backend/lambda/src/admin-credential-exchange.ts:396`), and synth refuses `admin: true` on the guest, invitation-link and host-assertion kinds and the `admin` capability without another issuer that declares it (`backend/lib/config/issuers.ts`). The admin-plane identity is `<personId>-admin`, created by the admin exchange alone and tagged with its owner (`adminTwinIdFor`, `backend/lambda/src/lib/person-arn.ts`). Decision 4 is a deployment's choice; no stack creates a staff pool.
date: 2026-10-17
related:
  - "./021-user-administration-is-not-idp-abstracted.md"
  - "./052-the-console-is-four-surfaces-and-one-of-them-is-privileged.md"
  - "./055-stacks-are-capabilities-in-layers.md"
  - "./058-offboarding-runs-by-app-instance-user-for-every-issuer.md"
  - "../../guides/admin/ADMIN-INTEGRATION-GUIDE.md"
  - "../../guides/user/IDENTITY-PROVIDER-GUIDE.md"
  - "../../specs/interaction/governance/SPEC-ADMIN-IDENTITY.md"
  - "../../specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md"
  - "../../specs/interface/DESIGN-SEPARATE-ADMIN-APP.md"
  - "../../../backend/lib/constructs/admin-auth-mode.ts"
  - "../../../backend/lib/config/deploy-context.ts"
  - "../../../backend/lambda/src/lib/auth.ts"
  - "../../../backend/lambda/src/credential-exchange.ts"
tracking: |
  Every admin route is AWS_IAM, and `hostAdminPoolId` and `adminAuthMode=federated` are refused at synth. This record accepts that state and states which identity providers an administrator may sign in through.
---

# ADR-059: The admin plane accepts every issuer the chat plane accepts, and the federated admin mode is removed

## Status

**Accepted (2026-10-17).** What ships:

- **No admin authorizer reads a host pool, and the `federated` admin mode is refused.** Every admin route is `AWS_IAM`, and `hostAdminPoolId` and `adminAuthMode=federated` are each refused at synth with a message pointing at the trusted-issuer registry (`backend/lib/config/deploy-context.ts:121`, `backend/lib/constructs/admin-auth-mode.ts`).
- **Any `admin: true` issuer reaches the console.** A console session is requested from the admin credential exchange with a token from a registry issuer. `AdminApi`'s edge authorizer admits it only on the console session route and only when its issuer declares `admin: true`, uncached, and the exchange refuses again on the registry entry (`backend/lib/stacks/admin-api-stack.ts`, `backend/lambda/src/admin-credential-exchange.ts:396`). Synth refuses `admin: true` on the `guest`, `invitation-link` and `host-assertion` kinds (`NEVER_ADMIN_KINDS`) and refuses the `admin` capability unless another issuer declares it (`backend/lib/config/issuers.ts`).
- **The twin derives from the person.** The admin-plane AppInstanceUser is `<personId>-admin` (`adminTwinIdFor`, `backend/lambda/src/lib/person-arn.ts`), created only by the admin exchange (`ensureAdminIdentity`, `backend/lambda/src/admin-credential-exchange.ts:235`) and tagged `owner` with its owner's AppInstanceUser ARN, and the console session name carries the person id (`CONSOLE_SESSION_ARN`, `backend/lambda/src/lib/auth.ts:416`).

## Context

An administrator is a person. Every person is an AppInstanceUser, whichever identity provider signed them in, and the credential exchange is the only place a session is vended. So the admin plane does not need an identity provider of its own; it needs the same edge the chat plane has, plus the admin authority check that already exists.

The two-identity split stays: an administrator holds a second, admin-plane AppInstanceUser, so the standing elevation an admin action needs never attaches to their chat credential (SPEC-ADMIN-IDENTITY).

## Decision

**1. The retirement is accepted.** No admin route takes a token authorizer, and no admin authorizer reads a host pool. A host identity provider reaches the console by being a declared issuer, not through a separate admin pool setting.

**2. `adminAuthMode=federated` is removed.** It is refused at synth like every retired key, with a message naming the issuer registry. `ae-cognito` and `service` keep their meaning.

**3. The admin exchange accepts every issuer in the trusted-issuer registry except the guest issuer.** An administrator from the deployment's pool, a second pool, a SAML or OIDC provider federated into a pool (`cognito-federated`), or an allowlisted Entra tenant (`oidc-entra`) is resolved at the edge to their AppInstanceUser, and the admin authority check decides what they hold. Synth refuses the `admin` capability unless a non-guest issuer is declared.

**4. Staff and customers sign in through separate pools.** A deployment with both declares a staff pool (no self sign-up, SAML only, with a pool domain) and a customer pool. A self-registered customer therefore cannot land in the pool administrators use. IAM Identity Center reaches the staff pool over SAML, which needs an organization instance of Identity Center, not an account instance.

**5. The admin-plane identity derives from the person.** It is `<personId>-admin`, created only by the exchange, and tagged with its owner's AppInstanceUser ARN. The console session name carries the person id, not a UUID pattern. Analytics, audit and offboarding attribute the twin to its owner through the tag, never by parsing the suffix.

## Consequences

- One edge serves both planes, so a new issuer reaches the console with no admin-specific setting.
- The admin integration guide's two-approach description collapses to one: declare the issuer.
- An administrator from another issuer can be offboarded with their twin (ADR-058).
- User lifecycle administration stays a Cognito reference implementation (ADR-021): an administrator from another issuer is administered in that issuer.

## What is not built

Decision 4 is a deployment's own choice: no stack creates a staff pool, and nothing refuses a deployment whose administrators and customers share one pool.

## What proves it

Decision 2: `backend/test/removed-dead-code-stays-removed.test.ts` (synth refuses `adminAuthMode=federated`, and `ae-cognito` and `service` resolve as before). Decision 3: `backend/test/the-admin-exchange-admits-only-admin-issuers.test.ts` (synthesized: an `admin: true` issuer from a second pool is admitted on the console session, and a one-conversation issuer and a full-reach issuer without `admin` are refused on every admin route), `backend/test/an-issuer-declares-its-reach.test.ts` (the kinds that cannot declare `admin: true`, and `admin` refused without a staff issuer), and the live `backend/scripts/deny-test-admin-exchange.mjs` (a guest token and a host assertion refused). Decision 5: `backend/test/lib/person-arn.test.ts` (the twin id) and `backend/test/admin-credential-exchange.test.ts` (the twin created by the exchange and tagged with its owner). Not yet written: an OIDC administrator synthesized through the admin plane, and an admin-plane message removed with its owner.
