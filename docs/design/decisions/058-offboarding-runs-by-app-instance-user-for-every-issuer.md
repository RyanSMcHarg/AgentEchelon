---
title: "ADR-058: Offboarding runs by AppInstanceUser for every issuer, and is not user administration"
status: Accepted 2026-10-27, the code runs on dev (whether a deletion reaches the archive and the votes, decision 5, stays OPEN). Deployed to dev on 2026-10-27 (Identity and AdminApi stacks), NOT VERIFIED on a deployment. `offboardPerson` (`backend/lambda/src/lib/offboarding.ts`) offboards by AppInstanceUser for every issuer, from `POST /users/delete` (`backend/lambda/src/user-management.ts`) and from the issuer's own delete events (`backend/lambda/src/offboarding-events.ts`); a disabled account is refused at its next vend rather than suspended (SPEC-CREDENTIAL-EXCHANGE §4b); votes and feedback are kept; nothing to remove is 404. The invitations a person issued or is named by and their per-person connector grants are removed with them (`PERSON_TOKEN_KINDS` and `connectorGrants` in `backend/lambda/src/lib/offboarding.ts`). Decision 5's deletion policy is OPEN. Narrows ADR-021 and leaves its user-lifecycle decision in place.
date: 2026-10-17
related:
  - "./021-user-administration-is-not-idp-abstracted.md"
  - "./059-the-admin-identity-provider-is-any-registry-issuer.md"
  - "../../specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md"
  - "../../specs/interaction/governance/IDENTITY-AND-ACCESS-MODEL.md"
  - "../../specs/interaction/governance/SPEC-ADMIN-IDENTITY.md"
  - "../../guides/user/IDENTITY-PROVIDER-GUIDE.md"
  - "../../overview/TENETS.md"
  - "../../../backend/lambda/src/user-management.ts"
  - "../../../backend/lambda/src/lib/offboarding.ts"
  - "../../../backend/lambda/src/offboarding-events.ts"
tracking: |
  ADR-021 records that user lifecycle administration (list, approve, enable, set a group) is a Cognito reference implementation and is not abstracted across identity providers. Offboarding shares that handler but not that boundary: it is keyed on the AppInstanceUser (README.md, the founding principle), so it works for a person of every issuer (`backend/lambda/src/lib/offboarding.ts`).
---

# ADR-058: Offboarding runs by AppInstanceUser for every issuer, and is not user administration

## Status

**Accepted (2026-10-27), proposed 2026-10-17; whether a deletion reaches the archive and the votes (decision 5) stays OPEN. Deployed to dev on 2026-10-27 (Identity and AdminApi stacks), NOT VERIFIED on a deployment.**

- **By AppInstanceUser.** `POST /users/delete` takes `personArn`, or `username` for an account of this deployment's pool (`backend/lambda/src/user-management.ts`), and runs `offboardPerson` (`backend/lambda/src/lib/offboarding.ts`) over every store in decision 2 that exists, then replaces each `Identities` row with a `revoked` marker so the subject is never minted again.
- **Event-driven.** A Cognito account deleted offboards the person by its CloudTrail event, on the same code, with a daily sweep as the backstop (`backend/lambda/src/offboarding-events.ts`).
- **Disable is not offboarding.** A pool's disable and re-enable write nothing to the `Identities` row: the table keeps no copy of the identity provider's state, and the credential exchange asks the issuer live at every vend and refuses a disabled or gone account (SPEC-CREDENTIAL-EXCHANGE §4b, "An account disabled at its issuer"). The lifecycle rule hears deletes only.
- **Votes and feedback kept.** No erasure of battle votes or thumbs runs, and no index finds either by voter.
- **404 when nothing existed.** Nothing to remove answers 404.
- **The list is the AppInstanceUsers.** The console lists people from the AppInstanceUsers, with each pool account that has not signed in yet after them, and states what offboarding keeps from the admin console catalog.

## Context

ADR-021 drew a boundary: the pluggable identity boundary covers authentication and authorization by group, and does not cover user lifecycle administration. That boundary stands. Offboarding sits on the administration side of it only because it shares a handler.

Offboarding is not administration. Administration changes a person's record in their identity provider; offboarding removes a person's data from this platform. The platform's data is keyed by the AppInstanceUser, whichever issuer signed the person in, so offboarding needs no knowledge of the identity provider at all, except to remove a Cognito user when one exists.

## Decision

**1. ADR-021 is narrowed, not reversed.** Approve, reject, enable, disable and set a group stay a Cognito reference implementation, and a deployment on another identity provider administers users there.

**2. Offboarding takes an AppInstanceUser id and runs for every issuer.** It removes, store by store:

- the AppInstanceUser and its admin-plane twin, found by the twin's owner tag, never by parsing a suffix;
- the person's channel memberships;
- their user profile, user tasks and turn state;
- the attachments under `attachments/<conversationId>/<personId>/`;
- their rows in the `Identities` index;
- the pending invitations they issued;
- their per-person connector grants;
- the Cognito user, only when one exists.

**3. Nothing to remove is 404, never 200.** The response names what was removed.

**4. The console lists people from AppInstanceUsers**, so a person from any issuer can be found and offboarded. A Cognito user with no AppInstanceUser yet is handled, and removed.

**5. The console states what offboarding keeps.** Battle votes and feedback stay, carrying the AppInstanceUser id, so tallies and quality signals do not change when a person leaves. The archive is the system of record and also stays. An erasure request reaches those through the redact and delete path; whether a deletion also reaches them is a policy decision for the deployment and is **OPEN**.

## Consequences

- One code path offboards a pool person, a person from another pool, an OIDC person and a guest who became a customer.
- The inventory of stores keyed by the person becomes the checklist offboarding is tested against, so a new store keyed by the person is a visible gap until offboarding covers it.
- Every deletion writes an audit record naming the AppInstanceUser and what was removed.

## What is not built

Every store of decision 2 is covered. The invitations a person issued and their per-person connector grants are removed with them: every invitation the person issued or is named by is deleted from `Tokens` (step 4c, `PERSON_TOKEN_KINDS`), so a pending one can no longer be redeemed, and a redemption also refuses an invitation none of whose inviter's sign-ins is active at its issuer, which covers an inviter who is offboarded or disabled at their issuer; their connector grants are revoked at the vendor and deleted (step 4b). Whether a deletion also reaches the votes, the feedback and the archive (decision 5) is still **OPEN**.

## What proves it

Unit: `backend/test/user-management-delete.test.ts` (a pool person, a person of another issuer, an id that does not exist and the 404 after a deletion, votes and feedback unchanged, a marker per removed row, one `offboarding` event per deletion, and no re-mint) and `backend/test/offboarding-events.test.ts` (a delete, replayed and out of order, a disable and an enable ignored, a foreign pool ignored, and the sweep). Synth: `backend/test/offboarding-is-event-driven.test.ts`. Live: `backend/scripts/deny-test-offboarded-sign-in.mjs` signs an offboarded person in again for each issuer and asserts the refusal and that no AppInstanceUser is created; it is written and has not been run. The end-to-end run that offboards a non-pool person (200, then 404) does not exist yet.
