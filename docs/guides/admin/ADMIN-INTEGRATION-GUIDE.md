# Bringing Your Own Admin Console and Admin Auth

This guide explains how to run AgentEchelon's operator surface - analytics, administration, evaluations, experiments - **behind your own application's admin console and admin authentication**, instead of the built-in console and the deployment's own Cognito groups.

It is the **operator-plane twin** of [IDENTITY-PROVIDER-GUIDE.md](../user/IDENTITY-PROVIDER-GUIDE.md). That guide covers the **user plane** (who can chat, at which classification). This one covers the **admin plane** (who can see analytics and administer conversations). The two are independent - you can swap one, both, or neither.

> **Summary.** Every admin route, the `GET /feedback` summary included, is `AWS_IAM`-authorized, and API Gateway checks `execute-api:Invoke` on that route's capability before any handler runs. Integrating your own console is therefore a choice of **which AWS principal signs the call**: a console session the credential exchange vends to a person, or a role your own backend holds. The standalone console and its two console roles are the default, not a requirement.

---

## The two planes

| Plane | What it gates | Standalone default | Host-owned option |
|-------|---------------|--------------------|-------------------|
| **User** | Who can chat, at which classification | The deployment's Cognito user pool and clearance groups, the `deployment` entry of the trusted-issuer registry | Any issuer the registry declares - [IDENTITY-PROVIDER-GUIDE.md](../user/IDENTITY-PROVIDER-GUIDE.md) |
| **Admin** | Who can see analytics and administer | A console session on the `admins` or `team-members` console role, and the shipped admin console | **This guide** |

---

## How admin access is enforced

**Admin routes are IAM.** Every admin route is on `AdminApi` (`backend/lib/stacks/admin-api-stack.ts`), one HTTP API on which a route is IAM-authorized unless it declares otherwise (`authOf` in `backend/lib/constructs/http-api.ts`). Every admin route is declared by `admin-services-stack.ts` or one of its two nested stacks, `admin-assistant-administration.ts` (profiles, ownership, the roster, and experiments when `experiments` is declared) and `admin-analytics.ts` (analytics, queue health, classifier replay, membership-audit review, sleep and wake). That covers the admin credential exchange's per-capability credential routes and `GET /admin/access-log`, user management, admin conversations and tasks, and the `GET /feedback` summary; the user-facing `POST /feedback` is a Conversations route on `PersonApi`, behind the edge authorizer. The one admin route that is not IAM is the console session itself, which is how the console obtains the credentials it signs with; it is behind `AdminApi`'s own edge authorizer, which admits only a token whose issuer declares `admin: true`. IAM on the admin routes is always on: no context key changes it, and no admin route opts out of it. The generated route inventory is [`api-contract.md`](../../reference/api-contract.md).

**Two console roles.** The AdminServices stack creates `${RES_PREFIX}-admin-console` and `${RES_PREFIX}-team-console` (`ADMIN_CONSOLE_ROLE_NAME`). In the AdminApi stack, `grantAdminRolesOnApi` grants each role, through one managed policy per catalog surface, `execute-api:Invoke` on exactly the resources its capabilities name in the capability catalog, `backend/lib/config/admin-capabilities.ts`. A role that does not hold a capability is refused at the gateway on that route.

**Console session.** A person obtains credentials on one of those roles by calling `POST /exchange-credentials` on `AdminApi` (the `AdminApiUrl` output) with their id token and the body `{"identity":"console"}` (`admin-credential-exchange.ts`). The person credential exchange (`POST /exchange-credentials` on `PersonApi`) answers `identity: 'console'` and `identity: 'admin'` with `403 ADMIN_VEND_MOVED`. The admin exchange never creates a person: a subject that has not signed in through the person exchange first is refused `409 PERSON_NOT_SIGNED_IN`, and an offboarded person, or one whose account their issuer reports disabled or gone, `403 PERSON_NOT_ACTIVE`; an issuer whose directory cannot be read is `503 DIRECTORY_UNAVAILABLE`, and nothing is vended. An issuer that does not declare `admin: true` holds no admin role. `consoleRoleFor` picks the role: a caller whose groups resolve to the deployment's admin-plane classification gets `admins`; a caller in the `team-members` group gets the team role, narrowed by a session policy to the assistants their team owns within their clearance; anyone else is refused `403 NO_ADMIN_CAPABILITY`. The session is assumed as `console-<personId>` (a team session as `console-<personId>@<clearance>`), named with the person's AppInstanceUser id whatever its shape; only the admin credential exchange's execution role (`AdminCredentialExchangeRole`) may assume the console roles, and the session lasts an hour (`CONSOLE_SESSION_SECONDS`) or fifteen minutes for a team session (`TEAM_CONSOLE_SESSION_SECONDS`). The response lists the capabilities the role holds and the route each one authorizes, which is what the console renders against, and names under `onRequest` which of them are vended per request rather than held by the session, with how long one such credential lasts. Each vend writes an `admin_console_session_vend` audit line.

**Handler layer.** Behind the gateway, `requireAdmin` and `callerIsAdmin` in `backend/lambda/src/lib/auth.ts` trust an IAM-signed call on the routes the CDK marks `ADMIN_IAM_ENFORCEMENT=true`, and derive the actor from the session name (`callerPersonId`). Classification-scoped reads resolve the caller's scope from the assumed role (`scopeForRequest` in `backend/lambda/src/lib/caller-scope.ts`); a role the scope map does not name sees no conversation and no analytics row carrying a classification, while analytics aggregates with no classification column are not narrowed.

**Per-conversation credentials.** Redact, delete, membership changes, message reads, live members and attachments are not standing grants. Each is vended on its own route, `POST /exchange-credentials/admin/<capability>`, SigV4-signed with the console session, narrowed to one conversation, short-lived, and refused without a stated `reason`. The exchange refuses a request on these routes that is not signed by a console session.

---

## Group names

`adminGroups` on the `deployment` entry of the trusted-issuer registry (`issuers` in `deploy.config.json`, `backend/lib/config/issuers.ts`) sets `ADMIN_GROUP_NAMES` on the admin Lambdas (`adminAuthEnv` in `backend/lib/constructs/admin-auth-mode.ts`); the entry must also declare `admin: true`. Its scope is narrower than the name suggests:

- The handler names these groups in the claims it builds for a trusted IAM-signed call (`iamPrincipalClaims` in `auth.ts`). Its token-claim check also reads them, but that check binds only on a call the edge authorizer admitted, which no IAM-authorized admin route is.
- The admin notification channel and the admin conversation sync read its first entry as the group whose members they sync.
- It does **not** change who receives a console session. That comes from the groups the deployment's classification config maps to its admin-plane classification (`admins` in the sample config) and from the `team-members` group (`ADMIN_ROLE_GROUP`).

---

## Approach 1 - Any registry issuer with admin: true

Your operators sign in through an issuer the trusted-issuer registry declares with `admin: true`: the deployment's own pool (the `deployment` entry, by default), a provider federated into it (`cognito-federated`), or another Cognito pool or an `oidc-entra` issuer ([IDENTITY-PROVIDER-GUIDE.md](../user/IDENTITY-PROVIDER-GUIDE.md)). Synth refuses `admin: true` on `guest`, `invitation-link` and `host-assertion`, and refuses the `admin` capability without an issuer that is not the guest. Your console (or the shipped one) requests a console session with the operator's id token and signs every admin call with it.

```
  Operator signs in through an issuer declaring admin: true
          |  (its token resolves to the admins or team-members console role)
          v
  POST /exchange-credentials {"identity":"console"}  (admin credential exchange)
          |  ->  console session on a console role
          |
          v
  SigV4-signed admin call  ->  API Gateway checks execute-api:Invoke for that capability
```

**What changes:** only who authenticates the person. The roles, the per-capability grants, the per-conversation vends and the audit lines are unchanged, and each audit line names the operator's own AppInstanceUser id (`personId` on the vend's audit line in `backend/lambda/src/admin-credential-exchange.ts`).

**Best when:** your operators are people working in a browser console.

**Two layers on the issuer.** `AdminApi`'s edge authorizer, on the admin plane, admits a token on the console session route only when its issuer declares `admin: true`, and denies every other issuer every route (`backend/lambda/src/edge-authorizer.ts`); the admin credential exchange refuses again on the registry entry the token resolves to, so an issuer that does not declare `admin: true` holds no admin role whatever its tokens' groups say (`backend/lambda/src/admin-credential-exchange.ts`). The operator's token is resolved at the edge, through the `Identities` index, to their AppInstanceUser, and the console session carries that id whatever issuer signed them in ([ADR-059](../../design/decisions/059-the-admin-identity-provider-is-any-registry-issuer.md), Proposed). The console role a token reaches is `admins` when its issuer's clearance resolves to the admin-plane classification (`admin` in the sample config), and `team-members` when its groups include `team-members` (`consoleRoleFor`, `backend/lambda/src/lib/vend.ts`). **NOT RUN:** an issuer other than the deployment's own pool reaching the console is the "step 5" test of `tests/e2e/a-providers-groups-give-the-access-the-guide-describes.spec.ts` (an `oidc` fixture issuer declaring `admin: true`, a provider group mapped to `admins` given a console session, an unmapped `admins` group refused one), which has not yet passed against a deployment. **NOT VERIFIED:** a `cognito-federated` provider or a live Okta, Auth0 or Entra tenant reaching the console.

---

## Approach 2 - Host principal

Your backend authenticates the operator in your own system, then calls the admin routes server-to-server, SigV4-signed by an IAM role your backend holds. Grant that role `execute-api:Invoke` on the capability routes it needs, in its own identity policy. `AdminApi` carries no resource policy, so the role must be in the deployment's account.

```
  Operator signs in to YOUR admin app  ->  YOUR backend decides "is this operator allowed?"
          |
          v
  YOUR backend role, SigV4-signed  ->  API Gateway checks execute-api:Invoke on the route
          |
          v
  requireAdmin trusts the signed call; the actor is the role's principal ARN
```

**Best when:** you need automation or a single trust boundary in your own app, and the routes you call are ones this option serves.

Three limits, each **OPEN**:

- **Scoped reads return nothing.** Classification-scoped reads (conversations, analytics) resolve the caller's scope from `CLASSIFICATION_ROLE_SCOPES`, which the AdminServices stack builds from the classification roles the person credential exchange vends. A host role is not in it, so `scopeForRequest` resolves no scope: conversation reads and every analytics row carrying a classification are dropped, while analytics aggregates with no classification column still pass through. No context key adds a role to that map.
- **No per-conversation credentials.** The `exchange-credentials/admin/<capability>` routes require a console session (`consoleSessionCaller`) and refuse any other principal with `403`, so redact, delete, membership changes, message reads and attachment reads are unavailable to a host role.
- **The audit names your role, not your operator.** Without a console session the handler has no person to record, so your backend must keep its own record of which operator asked.

---

## adminAuthMode

`-c adminAuthMode` (`ae-cognito` by default, or `service`) is read by `backend/lib/constructs/admin-auth-mode.ts`, and it switches one thing only:

- **`ADMIN_AUTH_MODE` on the admin Lambdas.** `adminAuthEnv` stamps it, and in `service` mode `isServiceAdminCall` in `auth.ts` trusts any IAM-signed call.

It selects no authorizer. Every admin route, `GET /feedback` included, is `AWS_IAM` whatever this is set to. Handler behavior per mode is covered by `backend/test/lib/auth-admin-mode.test.ts`. `federated` is refused at synth (`FEDERATED_ADMIN_MODE_RETIRED`): a host identity provider reaches the console as a registry issuer with `admin: true` (Approach 1, [ADR-059](../../design/decisions/059-the-admin-identity-provider-is-any-registry-issuer.md)).

---

## Admin identity and audit

Per-conversation actions run as the operator's own admin-plane AppInstanceUser, an app-instance-admin identity vended per action. It is the one second principal a human holds: the admin credential exchange creates it and tags it with its owner's AppInstanceUser ARN, and analytics, audit and erasure attribute it to the owner through that tag, never by parsing a suffix. **PARTIAL:** it is `${personId}-admin` and carries the `owner` tag (`ensureAdminIdentity` in `backend/lambda/src/admin-credential-exchange.ts`, the suffix from `adminTwinIdFor` in `backend/lambda/src/lib/person-arn.ts`); archival attributes it by its id rather than the tag. The dedicated **service** app-instance-admin is used only for no-human automation such as membership-audit auto-revoke. Changing who owns admin auth changes who may ask, not the identity an action runs as.

What is recorded, and where:

- **The vend, server-side.** `admin-credential-exchange.ts` writes `admin_console_session_vend` for each console session, `admin_scoped_credential_vend` for each per-conversation credential (the capability, the conversation, the stated reason, the lifetime), and `team_scoped_credential_vend` for a team member's attachment read.
- **The action itself.** The console performs redact, delete and membership changes directly against Amazon Chime SDK Messaging with the vended credential, so the call is recorded by AWS CloudTrail as an Amazon Chime SDK management event under that session. The platform trail in `identity-stack.ts` is on by default; `-c platformTrail=false` defers to an organization trail that already captures these events. Requests to the admin APIs themselves are recorded in each API's access log, not in CloudTrail.
- **Moderation record.** After a redact or delete the console posts `moderation-record`; the actor is taken from the signed request (best-effort, Aurora `moderation_actions`).
- **Client telemetry, not an audit control.** `adminChime.ts` sends `admin_message_redacted`, `admin_message_deleted`, `admin_conversation_deleted`, `admin_member_added` and `admin_member_removed` through `trackEvent`. These are reported by the browser after the call succeeds.

---

## What moves to the host (and what stays)

| Feature | Standalone | Host-owned |
|---------|-----------|------------|
| Analytics, evaluations, latency, experiments | AgentEchelon | **Stays** (consume via the API) |
| Conversation administration (redact, delete, members) | AgentEchelon | **Stays** (runs as the operator's admin-plane AppInstanceUser; requires a console session, so Approach 1) |
| `npm run provision-admin` (`backend/scripts/provision-admin.mjs`) | Bootstraps the first admin | **Skip** if your app provisions admins into the groups |
| Manage Users tab and the user-management API (approve, classification, enable) | AgentEchelon | **Disable or ignore** if your app owns user lifecycle |
| Offboarding (delete a person's data) | AgentEchelon | **Stays.** It erases by AppInstanceUser for every issuer, whoever owns lifecycle ([ADR-058](../../design/decisions/058-offboarding-runs-by-app-instance-user-for-every-issuer.md), Proposed). The console's delete names the person's AppInstanceUser ARN, and user management sends it to the Identity stack's `OffboardingFunction` (`invokeOffboardingFunction` in `backend/lambda/src/user-management.ts`, `backend/lambda/src/lib/offboarding-console.ts`) |

If you have also moved the **user** plane to your IdP and removed the deployment's user pool, the user-management API has no pool to act on, and no console session can be vended either.

---

## Consuming the APIs from your own console

The shipped console tabs are React with custom SVG charts and no charting dependency. Every admin call they make is SigV4-signed: `frontend/packages/admin/src/services/sigv4Fetch.ts` requests the console session once (`consoleSession`), signs standing reads with it (`consoleCredentials`), and requests a per-conversation credential on the capability's route for an action (`vendAdminCapability`). Two ways to reuse them:

- **Port the tabs.** Copy `frontend/packages/admin/src/components/admin/*` into your app with `sigv4Fetch.ts`, and make the two API base URLs (`VITE_PERSON_API_URL`, `VITE_ADMIN_API_URL`) and the credential provider injectable. The chart and table primitives (`DataTable`, `LineChart`, `Sparkline`, `FunnelChart`, `MetricCard`) carry no dependency and port as they are.
- **Build your own UI** against the routes in [`api-contract.md`](../../reference/api-contract.md) and the request rules in [API-GUIDE.md](../developer/API-GUIDE.md).

Either way the contract is the same: **the `AdminApi` base URL and a credential that can SigV4-sign for the capability.**

---

## Related documentation

- [IDENTITY-PROVIDER-GUIDE.md](../user/IDENTITY-PROVIDER-GUIDE.md) - the user-plane twin of this guide.
- [DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md](../../specs/interaction/governance/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md) - the per-capability IAM design.
- [SPEC-ADMIN-CONSOLE.md](../../specs/interface/SPEC-ADMIN-CONSOLE.md) - the admin console design, including the console session and stated reasons.
- [SPEC-MODERATION.md](../../specs/interaction/governance/SPEC-MODERATION.md) - the moderation model and its surfaces.
- [ADMIN-GUIDE.md](ADMIN-GUIDE.md) - how an operator uses the console.
- [SPEC-FEDERATED-PARTICIPANTS.md](../../specs/interaction/governance/SPEC-FEDERATED-PARTICIPANTS.md) - the user-plane federation primitives.
