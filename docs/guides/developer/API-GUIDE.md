# API Guide

**Audience:** developers calling a deployed AgentEchelon over HTTP from their own client, instead of using the chat and admin front ends this repo ships.

**Scope.** What a client must do and what the platform does back: how to authenticate, which authorizer each route carries, the four different limits that can refuse a request, what a refusal looks like on the wire, and which behavior is safe to depend on. The route inventory is not here. It is generated from the stacks and lives in [`../../reference/api-contract.md`](../../reference/api-contract.md), so that every method, path, authorizer and throttle is read out of the deployed wiring rather than maintained by hand.

This guide says what to do. For why each rule exists, follow the spec links: [`SPEC-ADMIN-IDENTITY.md`](../../specs/interaction/governance/SPEC-ADMIN-IDENTITY.md) for the two-identity model, [`SPEC-CREDENTIAL-EXCHANGE.md`](../../specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md) for the credential vend, [`SPEC-ABUSE-CONTROLS.md`](../../specs/interaction/governance/SPEC-ABUSE-CONTROLS.md) for the limits and the direction each one fails in, and [`SPEC-CONVERSATION-SECURITY.md`](../../specs/interaction/governance/SPEC-CONVERSATION-SECURITY.md) for the boundary a conversation sits behind.

---

## 1. What you are calling

A deployment serves two API Gateway HTTP APIs (API Gateway v2), built from the routes each stack declares beside its handlers ([ADR-055](../../design/decisions/055-stacks-are-capabilities-in-layers.md), [ADR-056](../../design/decisions/056-two-http-apis-and-no-aws-waf.md)). `PersonApi` (stack `<prefix>PersonApi`, part of the required core) carries every route a person calls, behind the edge authorizer, which verifies the token against the trusted-issuer registry and resolves the caller to their AppInstanceUser. `AdminApi` (stack `<prefix>AdminApi`, present with the `admin` capability) carries every admin route, behind IAM. A route is served exactly when the capability that brings it is declared, and each API publishes the capabilities whose routes it serves (`PersonApiCapabilities`, `AdminApiCapabilities`). Each invoke URL is minted at deploy time and published as a stack output, `PersonApiUrl` and `AdminApiUrl`. Read those URLs from the deployed stack outputs; never compose one from an API id. `backend/scripts/gen-frontend-env.mjs` is the working example of resolving them, and it is what fills the front ends' `.env` files.

Three properties hold across both APIs:

- **Every route is authorized except the few a caller must reach before holding a credential, and none accepts an API key**, so a call carries an identity that belongs to a person rather than to a client build. The routes with no authorizer are listed in the reference's "Routes served with no authorizer" row ([`api-contract.md`](../../reference/api-contract.md)), and each carries its own throttle and checks:
  - `GET /deployment/state`, which exists only when `sleepMode` is set and answers whether the Aurora cluster is paused. A client renders that before a caller holds a credential; it reads a single deployment flag and exposes nothing about any conversation.
  - `POST /invitations/peek`, which reads an invitation for its landing page and consumes nothing (`identity-stack.ts`).
  - `GET` and `POST /email/preferences`, the preference page and one-click unsubscribe, where the token in the emailed link is the credential (`notification-stack.ts`, with `notifications`).
  - `POST /guest/start` and `POST /guest/refresh`, with a guest issuer declared (`guest-issuer.ts`), and `POST /invitations/redeem`, with an `invitation-link` issuer declared (`invitation-link-issuer.ts`).
- **No route declares a gateway request model or validator.** Request shapes are enforced inside the handler, which is why this guide documents shapes by naming the handler that reads them, and why a request that is wrong in a way the handler does not check reaches the code rather than the gateway.
- **The deployment decides part of the surface.** Which analytics routes `AdminApi` serves under `/query` depends on `analyticsMode` (the Aurora mode serves the `/query/analytics/...` routes), and the sleep routes exist only when `sleepMode` is set. The reference's `Served in` column carries both.

## 2. Authentication and authorization

### 2.1 Two identities, not one

A person who administers the platform holds two distinct identities, and a client has to pick the right one per call:

- The **chat identity** is `${appInstanceArn}/user/${personId}` - the caller's own Amazon Chime SDK app instance user, whose id is opaque, created once by the credential exchange and the same whichever identity provider signed the person in. The id is a UUID v7, minted once per (issuer, subject) and never the token's `sub`. It is what reads and sends messages in conversations the person is a member of. An administrator's chat identity is never elevated: it carries no moderation power.
- The **admin identity** is `${appInstanceArn}/user/${personId}-admin`, a separate app instance user that the exchange creates and tags with its owner's AppInstanceUser ARN (`owner`, written by `ensureAdminIdentity` in `backend/lambda/src/admin-credential-exchange.ts`). Moderation (redact, delete, membership changes) and cross-conversation reads are vended only onto this identity, per channel, short-lived and audited.

A client that needs both holds both, and does not try to widen the chat one. The distinction and its reasons are in [`SPEC-ADMIN-IDENTITY.md`](../../specs/interaction/governance/SPEC-ADMIN-IDENTITY.md).

The admin API routes are signed with a third credential, the **console session** (section 2.5). It is an AWS role session on a console role, not an app instance user, and it is what the gateway checks a capability against.

### 2.2 Cognito session

Sign the person in against an issuer the deployment's trusted-issuer registry declares (the deployment's own Cognito user pool, when the registry declares one) and keep the **id token**. Routes behind the edge authorizer take it in the `Authorization` header:

```
Authorization: <id-token>
```

The issuer, client id and region come from the deployment, not from this document. Authentication is a bearer token on every request; no cookie is set, and `Access-Control-Allow-Credentials` is never sent, so a browser client must not send credentialed cross-origin requests.

### 2.3 Credential exchange

`POST /exchange-credentials` on `PersonApi` turns that session into short-lived AWS credentials pinned to the caller. It vends chat-plane credentials, which a client uses to talk to Amazon Chime SDK Messaging directly (which is how messages are read and sent). An administrator's console session comes from the admin credential exchange, `POST /exchange-credentials` on `AdminApi`, which exists with the `admin` capability (section 2.5); that session is what signs the IAM-authorized routes.

Identity comes only from the claims the edge authorizer verified. A body that names a different user is ignored, and the credentials that come back are pinned to the caller's own AppInstanceUser by the `person` session tag, so a mis-scoped request cannot vend somebody else's reach. The response's `userArn` is the caller's identity: a client derives its own ARN from it and never builds one from the id token. See [`SPEC-CREDENTIAL-EXCHANGE.md`](../../specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md); the wire shape is in section 6.1 below.

### 2.4 Signing IAM routes

Routes the reference shows as `AWS_IAM` (SigV4) are not reachable with the id token. They take a SigV4 signature over the request for service `execute-api` in the deployment's region, computed with the console session, or, for a conversation's messages, with the per-conversation credential vended for that read (section 6.1). The gateway then evaluates the signed principal's `execute-api:Invoke` permission against that specific method resource, so the authorizer is checking a capability rather than a group name.

### 2.5 Which authorizer a route carries

Every admin route is `AWS_IAM`, in every deployment, the admin `GET /feedback` summary included: a route on `AdminApi` is IAM-authorized unless it declares otherwise (`authOf` in `backend/lib/constructs/http-api.ts`), and no context key changes it. The one `AdminApi` route a token reaches is the console session, `POST /exchange-credentials`, behind `AdminApi`'s own edge authorizer on the admin plane, which admits only a token whose issuer declares `admin: true` and is never answered from the authorizer cache. Routes a person's chat client calls are on `PersonApi` behind the edge authorizer, which caches its answer for a token for 300 seconds except on the credential exchange, and the routes listed in section 1 carry none. A route's authorizer does not vary by deployment, so a client can take it from the reference.

An administrator's client obtains a console session by calling `POST /exchange-credentials` on `AdminApi` (the `AdminApiUrl` output) with the id token and the body `{"identity":"console"}`. The admin exchange never creates a person: a subject that has not yet signed in through the person credential exchange is refused `409 PERSON_NOT_SIGNED_IN`, and an offboarded person, or one whose account their issuer reports disabled or gone, `403 PERSON_NOT_ACTIVE`; an issuer whose directory cannot be read is `503 DIRECTORY_UNAVAILABLE`, and nothing is vended. The exchange picks the console role from the caller's groups, and only for an issuer that declares `admin: true`: the `admins` role for a caller whose groups resolve to the deployment's admin-plane classification, the team role for a member of `team-members` (narrowed to the assistants their team owns), and otherwise `403 NO_ADMIN_CAPABILITY`. Success is `200` with `credentials`, `identity: "console"`, `role`, `capabilities` (the capability keys the role holds), `routes` (each admin route and the capability that authorizes it), `onRequest` (`capabilities`: those of the role's keys the session does not carry and the exchange vends per request, the catalog's `exchangeVend` entries; `ttlSeconds`: how long one such credential lasts) and, for a team session, `assistants`. An `admins` session lasts an hour and a team session fifteen minutes (`CONSOLE_SESSION_SECONDS`, `TEAM_CONSOLE_SESSION_SECONDS`), so refresh against `Expiration`. A team session is named `console-<personId>@<clearance>`. Each grant of a capability to a role is generated from `backend/lib/config/admin-capabilities.ts` (`grantAdminRolesOnApi` in `backend/lib/constructs/admin-role-grants.ts`, one managed policy per catalog surface and role), so a role without a capability is refused at the gateway with `403`.

`adminAuthMode` touches no authorizer. It sets `ADMIN_AUTH_MODE` on the admin handlers, and only `service` changes what they do: they then trust any IAM-signed caller as admin (`isServiceAdminCall`).

### 2.6 Handler checks

Getting past the authorizer means the request carries a valid identity. It does not mean the action is permitted. Every privileged handler checks again, server-side, and the second check is the one that decides:

- **Capability, not group.** The gateway checks the route's capability. Behind it, `requireAdmin` in `backend/lambda/src/lib/auth.ts` trusts an IAM-signed call only on the routes the CDK marks `ADMIN_IAM_ENFORCEMENT=true` (and any IAM-signed call under `adminAuthMode=service`, through `isServiceAdminCall`), and derives the actor from the console session's name. The group checks in the same file (`callerCanReadArchive`, `callerCanManageProfiles`, `callerCanSeeUserIdentity`) bind only on a call the edge authorizer admitted, which no admin route is.
- **Names are their own grant.** Every admin conversation read strips participant names for every caller. `GET /admin/conversations/identities` resolves a conversation's ARNs to names, and it is a resource of its own under `see-user-identity`, so the gateway refuses a role without that capability (`admin-conversations.ts`).
- **Scope comes from the session.** Classification-scoped admin reads narrow to the caller's scope, resolved from the assumed role (`scopeForRequest` in `backend/lambda/src/lib/caller-scope.ts`). A role the scope map does not name gets no classified row; analytics aggregates with no classification column are not narrowed.
- **Membership comes from Amazon Chime SDK.** Whether the caller is in a conversation is answered by calling Amazon Chime SDK Messaging under the caller's own bearer, not by reading a stored list. `POST /feedback` refuses with `NOT_A_MEMBER` on that basis, and `GET /turn-state` refuses before it touches any queue state.
- **Reach is a declared set.** Creating a conversation at a classification is permitted when that classification is in the set the caller's groups reach, and refused with `TIER_FORBIDDEN` otherwise. A classification is a declared set of grants, so this is set membership rather than a comparison of levels.

So a client cannot infer permission from a 200 on an earlier call, and must handle a 403 on any route whose authorizer it satisfied.

## 3. Limits

Four different mechanisms can refuse or reshape a request, at four different layers. Only the first produces an HTTP error.

### 3.1 Route throttling

Each route carries its own rate and burst, set on its API's stage - 10 and 20 on the admin conversation, user management and admin exchange routes, 100 and 200 on the analytics routes, and others in between; the reference's Routes table has every one. This limit is **shared by every caller of that route**, so it bounds the deployment rather than the person, and a client should treat a `429` as a signal to back off rather than as a statement about the user. The person credential exchange deliberately carries no throttle of its own and the stage sets none, so it has only the account's limit: it is the call every client makes before it can make any other.

Whether a browser client can read a gateway `429` depends on the CORS headers the API adds to it (section 4.5).

### 3.2 Hourly request limit

`rateLimitPerHour` on the assistant profile bounds how many messages one person may send in a clock hour: **60** on the `concierge` profile, **120** on `analyst` and on `ops-premium`, **240** on `advisor` (`backend/lib/config/profiles.ts`). It is a profile field, not a deployment knob, and it is enforced at the assistant path in `backend/lambda/src/lib/abuse-controls.ts` rather than at the gateway.

**A client will not see an HTTP error for this.** The request succeeds; the refusal arrives as an ordinary assistant message in the conversation, saying the limit is reached and roughly how many minutes remain in the hour. A client that wants to render it distinctly has nothing structured to key on: a structured refusal frame is **NOT BUILT**.

### 3.3 Hourly dispatch budgets

Two more limits bound how many model turns the deployment dispatches in a clock hour: `bedrockUserHourlyBudget` (**100**) and `bedrockGlobalHourlyBudget` (**500**), both on by default, each disabled by setting it explicitly to `0`. They are **counts of dispatched turns, not money and not tokens**. Both are enforced in the same place as the rate limit.

When either trips, the reply is one canned sentence about unusually high demand, delivered the same way - in the conversation, not as an HTTP status. The two are indistinguishable from the client: which limit tripped is visible only in the logs. With `-c abuseExemptAdmins=true`, a sender in an exempt admin group (`admins` unless `-c abuseExemptAdminGroups` names others) is exempt from the per-user budget and the per-user hourly limit; no one is exempt from the global budget. The exemption is off by default.

### 3.4 Message length cap

Text over `maxUserMessageLength` (**16000** characters, roughly four thousand tokens) is **silently truncated**, not refused. There is no status code, no notice and no marker: the turn proceeds on the first 16000 characters. A client that accepts long input should tell the person about the cap itself rather than expect the platform to.

### 3.5 Other limits

| Limit | Value | What a client sees |
|---|---|---|
| Attachment bytes a model can read | 3,000,000 raw (4,000,000 base64, the limit Bedrock enforces) | The turn is answered without the attachment, and the person is told |
| Upload size for a presigned POST | 10 MiB, returned as `maxBytes` | S3 rejects a larger body against the signed policy |
| Per-IP edge rate limit (WAF, on the front end distribution) | `wafRateLimit`, default 3000 | A blocked request at the edge, before any API |
| Turn queue depth, when the queue is enabled | 5, `-c turnQueueMax` | The oldest queued message is dropped and the person is told |

### 3.6 Failure directions

The directions differ deliberately, and a client should not assume one rule:

| Control | On its own failure |
|---|---|
| Duplicate suppression (dedup) | **Fails open** - the turn proceeds rather than being lost |
| Per-user hourly request limit | **Fails closed** - the rate-limit notice is served |
| Global hourly dispatch budget | **Fails closed** - the canned response is served |
| Per-user dispatch budget | **Fails closed** - the canned response is served |
| Turn lock and queue claim | **Fails open** - a table fault never blocks a turn. Enqueueing is the exception: it reports failure so the caller can retract an acknowledgement rather than lose the message silently |
| Attachment byte check | **Fails closed** - an unreadable length is rejected |

## 4. Errors

### 4.1 The envelope

Every refusal is a JSON body. The floor is one field:

```json
{ "error": "human-readable sentence" }
```

Some refusals add a stable machine code beside it, which is the field to branch on:

```json
{ "error": "Caller is not a member of the conversation", "code": "NOT_A_MEMBER" }
```

A few carry extra context relevant to the refusal - `TIER_FORBIDDEN` also returns `userTier` and `requestedTier`, so a client can say what was asked for and what is reachable. Server faults never echo an exception message; a `500` is a fixed sentence.

Not every refusal carries a code. Treat `code` as present-or-absent, key on it when it is there, and fall back to the status.

### 4.2 The statuses

| Status | Means | What to do |
|---|---|---|
| `400` | Malformed body, missing required field, or an argument the handler rejects | Fix the request; do not retry unchanged |
| `401` | No usable identity on the request | Refresh the Cognito session, then retry |
| `403` | Identity is valid and the action is not permitted, or the Origin is not allowed | Do not retry; surface it |
| `404` | The conversation is absent or not reachable by this caller | Treated as absent on purpose; do not probe |
| `405` | Method not supported on that route | Fix the client |
| `409` | A conflicting state, for example a challenger already named by another experiment | Re-read state, then decide |
| `429` | Route throttle | Back off and retry |
| `500` | Server fault or missing configuration | Retry once; the body carries no detail |
| `204` | A preflight answered | n/a |

### 4.3 The named codes

Read off the handlers under `backend/lambda/src/` and `backend/lambda/`. A client that renders refusals should handle at least these.

| Code | Status | Returned by | Means |
|---|---|---|---|
| `TIER_FORBIDDEN` | 403 | `create-conversation` | The requested classification is not in the set the caller's groups reach |
| `CLASSIFICATION_REQUIRED` | 400 | `create-conversation` | No `modelTier`. There is no default classification to fall back to |
| `CLASSIFICATION_NOT_CONVERSATIONAL` | 400 | `create-conversation` | An admin-plane classification cannot hold a conversation, for anyone |
| `MISSING_CLAIMS` | 401 | `create-conversation` | The request names no person |
| `MISSING_REQUIRED_FIELDS` | 400 | `create-conversation` | `title` or `modelId` absent |
| `INVALID_EXPIRATION_DAYS`, `INVALID_EXPIRATION_CRITERION` | 400 | `create-conversation` | Expiration arguments out of range, or one sent without the other |
| `CONVERSATION_CREATION_FAILED` | 500 | `create-conversation` | Server fault, including a malformed body |
| `SERVER_MISCONFIG` | 500 | `create-conversation` | The deployment is missing configuration |
| `NOT_A_MEMBER` | 403 | `user-feedback`, and the battle routes | The caller is not a member of the conversation |
| `NOT_MODERATOR` | 403 | `channel-battle` | The action needs channel-moderator standing |
| `CLASSIFICATION_UNREADABLE` | 403 | `channel-battle` | The channel's classification cannot be read under the caller's reach |
| `CLASSIFICATION_UNKNOWN` | 403 | `share-conversation` | The conversation's classification is not one this deployment declares, so no grant set can be resolved for it. Refused before any assistant is looked up, and a different code from `CLASSIFICATION_UNREADABLE` on purpose: the classification was read, and it is unknown |
| `MEMBERSHIP_FROM_SOURCE` | 409 | `share-conversation` | `POST /share-conversation` returns `409` with `code: MEMBERSHIP_FROM_SOURCE` when the conversation's type sources its membership from a group or list; membership follows the source, so it cannot be shared by hand. The source is read from the conversation's stored `membershipSource`; when that read fails, the share is allowed rather than refused |
| `NOT_A_MEMBERSHIP_GROUP` | 400 | `user-management` | `POST /users/group` names a group that is not one of the deployment's membership groups (`membershipGroups` in the profiles config). A clearance group is set through `POST /users/tier`, which keeps a person in exactly one; this route never touches one |
| `CLEARANCE_BELOW_GROUP` | 409 | `user-management` | `POST /users/group` with `member: true` for a user whose clearance does not already reach what the group requires (`requires` in the body), or who is not approved or is disabled. A membership group grants nothing, so the clearance is changed first, through `POST /users/tier` |
| `MEMBER_REQUIRED` | 400 | `user-management` | `POST /users/group` without a boolean `member` (true adds the person to the group, false removes them) |
| `CLEARANCE_REQUIRED` | 400 | `user-management` | `POST /users/approve` names no clearance group: `tier` must be one of the deployment's clearance groups, and there is no default to approve at |
| `NO_PROVISIONED_ISSUER` | 404 | `user-management` | `POST /users/provision` on a deployment whose registry declares no `provisioned-only` issuer |
| `ISSUER_NOT_PROVISIONABLE`, `INVALID_REQUEST` | 400 | `user-management` | `POST /users/provision` names an issuer that is not `provisioned-only`, or no subject. A subject that already has a row answers `409` with `state: exists`, and nothing is changed |
| `UNKNOWN_PERSON` | 404 | `user-management` | `POST /users/provision` links the subject to a `personArn` that names no AppInstanceUser of this app instance |
| `CHALLENGER_BOUND` | 409 | `channel-battle` | Another active battle experiment names the same challenger |
| `CHALLENGER_CLASSIFICATION_MISMATCH` | 400 | `channel-battle` | The experiment runs in a different classification than the conversation |
| `BATTLE_CHALLENGER_REQUIRED`, `BATTLE_CHALLENGER_MISMATCH`, `ALT_NOT_PROVISIONED` | 400 | `admin-experiments` | A battle names no challenger, names one that is not its classification's alt (`alt-{role}-{classification}`), or its classification provisions no alt |
| `NO_BATTLE_EXPERIMENT`, `EXPERIMENT_NOT_BATTLE`, `EXPERIMENT_NO_CHALLENGER`, `EXPERIMENT_NOT_ACTIVE`, `EXPERIMENT_WINDOW_ENDED`, `EXPERIMENT_TERMINAL`, `EXPERIMENT_LIVE_EDIT_LOCKED`, `EXPERIMENT_CONCURRENT_MODIFICATION`, `EXPERIMENT_TYPE_CONFLICT`, `MAX_ACTIVE_EXPERIMENTS`, `INVALID_TRANSITION` | 400 or 409 | `channel-battle`, `admin-experiments` | The experiment is not in a state that admits the request |
| `BATTLE_NOT_CAPABLE`, `BATTLE_ABANDONED`, `INVALID_WINNER`, `DECISION_OUTCOME_INVALID`, `OUTCOME_STORE_UNAVAILABLE` | 400, 409 or 500 | `channel-battle`, `battle-outcome-api` | The battle cannot be run, or its outcome cannot be recorded as asked |
| `MISSING_CHANNEL_ARN`, `INVALID_CHANNEL_ARN` | 400 | battle and outcome routes | The channel ARN is absent or not from this deployment |
| `RANGE_TOO_WIDE` | 400 | `analytics-query` (Athena analytics) | The requested `dateRange` exceeds 365 days |
| `UNSAFE_FILENAME`, `INVALID_CONVERSATION_ID`, `UNSUPPORTED_MIME`, `MISSING_FILE_KEY`, `FILE_KEY_NOT_OWNED` | 400 or 403 | `presigned-url` | The upload or download request is rejected before any URL is signed |
| `ADMIN_VEND_MOVED` | 403 | `credential-exchange` | `identity: "admin"` on the person exchange. An admin credential is requested on `exchange-credentials/admin/<capability>` with a console session (section 6.1) |
| `NO_ADMIN_CAPABILITY` | 403 | `credential-exchange` | A console session was requested by a sign-in whose groups name no console role |
| `NO_TEAM`, `TEAM_SCOPE_TOO_LARGE` | 403, 409 | `credential-exchange` | A team console session: the caller is in `team-members` but in no `team-<name>` group, or the team owns more assistants than one session policy can name (about 30 to 35; the inline policy names one wildcard per owned assistant within AWS's 2,048-character limit). A team that owns no assistant yet gets a session naming its team routes only |
| `TARGET_REQUIRED` | 400 | `manage-profiles` | `POST /admin/profiles/import` names no `targetProfileName`. An import lands on the assistant the request names, never on the one its manifest names |
| `DRAFT_CHANGED`, `NO_DRAFT`, `CONFIG_ID_REQUIRED` | 409, 404, 400 | `manage-profiles` | `POST /admin/profiles/discard`: the draft was saved again since the caller read it (kept; the body carries its `configId`), there is no draft, or the request names no `configId` |
| `REASON_REQUIRED` | 400 | `credential-exchange` | A per-conversation admin credential was requested without a `reason` |
| `CHANNEL_NOT_LITERAL` | 400 | `credential-exchange` | `channelArn` does not name exactly one conversation (a wildcard or path in the channel id) |
| `ASSISTANT_NOT_OWNED`, `CONVERSATION_NOT_FOUND` | 403, 404 | `credential-exchange` | A team attachment read names an assistant the team does not own, or a conversation none of its identities is a member of |

Codes are added as handlers are added. Branch on the ones a client acts on, and fall back to status plus `error` for the rest.

### 4.4 Non-HTTP refusals

Three of the four limits in section 3 answer with a `200` and an in-conversation message, not a status code: the hourly request limit, both dispatch budgets, and the length cap (which answers normally on truncated text). A client that treats `200` as "the request was accepted in full" will be wrong in all three cases.

### 4.5 Gateway errors

A refusal from the authorizer or the throttle never reaches a handler, so it carries none of the shapes above: it is API Gateway's own body. CORS is configured on each API (`RouteTableApi` in `backend/lib/constructs/http-api.ts`), so the gateway answers every preflight and adds the API's CORS headers to the responses it returns, echoing the one allowed origin a request names; no gateway response is overridden.

Whether a refusal the gateway answers itself (an authorizer's `401` or `403`, a throttle's `429`) carries those headers is a property of the deployed API, not of the synthesized template. A browser client should treat a network failure with no status on an authorized call as a possible gateway refusal. Outside the browser, where CORS does not apply, the status is always readable.

## 5. CORS and origins

Allowed origins are configured, not wildcarded, and they come from two deployment context values resolved in `backend/lib/config/app-origins.ts`:

- `appUrl` is the chat client's origin. Unset, it falls back to `http://localhost:5173`, which is a development default rather than a permissive one.
- `adminAppUrl` is the admin console's origin, and falls back to `appUrl` when unset. The admin console's URL is not known until its own distribution deploys, so a deployment sets it on a second pass.

Which origins an API allows follows what calls it: `PersonApi` allows the chat origin, the admin origin (the console resolves its person there before it asks for a console session) and every origin an issuer in the trusted-issuer registry declares in `allowedOrigins`; `AdminApi` allows the admin origin. Preflight on both allows `Authorization`, `Content-Type`, `X-Amz-Date`, `X-Amz-Security-Token` and `X-Amz-Content-Sha256`, because a SigV4-signed call sends the last three. Allowed methods are the ones the API's routes use, and the preflight is the binding answer: `backend/lambda/src/lib/auth.ts` sets `GET,POST,OPTIONS` on handler responses regardless, and the API's own CORS configuration answers in its place.

Two behaviors to build against rather than around:

- **An unrecognized `Origin` can be refused by the handler, not just by the browser.** `user-feedback`, `admin-conversations` and `user-management` answer `403 {"error":"Origin not allowed"}` before doing any work.
- **Deploying without these values resets the allowlist.** They are treated as destructive to omit (`backend/lib/config/deploy-context.ts`), because an absent value silently narrows every API's allowlist back to localhost.

A non-browser client is unaffected by all of this and should send no `Origin`.

## 6. Request and response shapes

No gateway request model exists, so these were read from the handlers by hand. **Only the routes below are documented here; the rest are not.** For a route that is not below, read the handler named in the `Integration` column of the reference - that column carries the construct id precisely so the handler can be found.

### 6.1 `POST /exchange-credentials` and `POST /exchange-credentials/admin/<capability>`

Two handlers serve these routes. The person credential exchange, `backend/lambda/src/credential-exchange.ts` on `PersonApi`, answers the token-authorized `POST /exchange-credentials` with chat-plane credentials; every field is optional, and an absent body vends the default chat credentials. The admin credential exchange, `backend/lambda/src/admin-credential-exchange.ts` on `AdminApi`, answers `POST /exchange-credentials` with `identity: "console"` (a console session, section 2.5) and every `POST /exchange-credentials/admin/...` route.

| Field | Type | Meaning |
|---|---|---|
| `capabilities` | `string[]` | Defaults to `['view','participate']` on the chat plane. An unknown value is a `400` |
| `channelArn` | `string` | Must begin with `${appInstanceArn}/channel/` and name exactly one conversation, or `400 CHANNEL_NOT_LITERAL`. Absent on the chat plane, the session reaches `${appInstanceArn}/channel/*` |
| `identity` | `'console'` | On the person exchange, `'console'` and `'admin'` are refused with `403 ADMIN_VEND_MOVED`, and anything else, including absent, means the chat plane. On the admin exchange, `'console'` is required, or `400 CONSOLE_SESSION_ONLY` |

An administrator's per-conversation credential (redact, delete, membership, message reads, live members, task reads, attachments) is not vended on this route. It is requested on `POST /exchange-credentials/admin/<capability>`, one `AWS_IAM` route per capability (the reference lists them), SigV4-signed with the console session. The gateway refuses a session whose role lacks that capability, and the exchange refuses a request on these routes that is not signed by a console session. The route names the capability; the body supplies the scope:

| Field | Type | Meaning |
|---|---|---|
| `reason` | `string` | Required, or `400 REASON_REQUIRED`. Why the credential is being issued, in the operator's words, capped at 500 characters and recorded on the audit line |
| `channelArn` | `string` | The one conversation the credential is narrowed to, under the same rule as above. Required for every capability except the principal-scoped task reads |
| `principalId` | `string` | Required for the principal-scoped capabilities `tasks-read-assignee` and `tasks-read-owned-by` |
| `ownerId` | `string` | Accepted in place of `principalId` |

A team member's attachment read has its own route under the assistant, `POST /exchange-credentials/admin/assistants/{assistant}/attachment-read`, and is refused unless the team owns that assistant and one of its identities is a member of the conversation.

The vended capabilities fall into three families, each with its own session policy: Amazon Chime SDK messaging (`view`, `participate`, `rename` on the chat plane; `redact`, `delete`, `manage-membership`, `manage-channel` only on an admin credential), archive capabilities served over `execute-api` (`view-messages`, `tasks-read`, `tasks-manage`, `tasks-reassign-owner`, `tasks-read-assignee`, `tasks-read-owned-by`), and attachment capabilities on S3 (`attachment-read`, `attachment-read-uploads`). A request on the chat plane that names an admin-only capability, or that mixes families, is a `400`.

Chat-plane and per-conversation success is `200` with:

```json
{
  "credentials": { "AccessKeyId": "...", "SecretAccessKey": "...", "SessionToken": "...", "Expiration": "ISO-8601" },
  "userArn": "arn:aws:chime:...:app-instance/.../user/<personId>",
  "tier": "standard",
  "identity": "chat",
  "scopedTo": null
}
```

`userArn` carries the `-admin` suffix on a per-conversation admin credential, because it acts as the operator's `${personId}-admin` identity; a team attachment read is the exception, returning the person's own ARN and `tier: "team"`. `identity` is `chat` or `admin`. `tier` is the wire field name, and its value is the caller's resolved classification token; on an archive vend it reads `admin` rather than the caller's own. `scopedTo` is the channel the session is narrowed to, or `null` - note that a principal-scoped task vend returns `null` here even though it is scoped, because the scope is the principal rather than a channel. An attachment vend returns the same fields **plus** `bucket` and `region`, which the client needs to sign its own scoped `GetObject`. A chat-plane session lasts an hour and a per-conversation admin credential half that (`EXCHANGE_SESSION_SECONDS` on the person exchange, `EXCHANGE_MODERATION_SESSION_SECONDS` on the admin exchange), so a client refreshes against `Expiration` rather than against a single assumed lifetime. The console session's own response is described in section 2.5.

Each console session writes an `admin_console_session_vend` audit line and each per-conversation credential an `admin_scoped_credential_vend` line (a team attachment read, `team_scoped_credential_vend`). A console session line names the operator, role and capabilities; a per-conversation line also names the conversation, the capability and the reason.

Notable refusals: `401` with no `sub`; `400` for an unknown capability, a mixed request, a channel ARN from another app instance, a missing required scope, `CHANNEL_NOT_LITERAL` or `REASON_REQUIRED`; `403 ADMIN_VEND_MOVED` for `identity: "admin"` or `"console"` on the person exchange; `409 PERSON_NOT_SIGNED_IN` and `403 PERSON_NOT_ACTIVE` on a console session request; `403 NO_ADMIN_CAPABILITY` for a console session requested by a sign-in whose groups name no console role; `403` on an admin route that is not signed by a console session, or whose role does not hold the capability; `404` for an admin route naming no vendable capability; `403 {"error":"no credential is configured for this combination of groups"}` when the deployment declares no classification for the caller's groups, which vends nothing rather than falling back to a floor; `403 {"error":"admin plane requires the admins group"}`. A host assertion (a `host-assertion` issuer) is accepted on the person exchange alone and once: `401 ASSERTION_REFUSED` for one whose `jti` was already used, never recorded or expired, `503 ASSERTION_UNAVAILABLE` when its `jti` cannot be checked, and `403 PERSON_NOT_PROVISIONED` for a subject of a `provisioned-only` issuer nobody pre-assigned, for which nothing is created.

### 6.2 `POST /create-conversation`

Handler: `backend/lambda/src/create-conversation.ts`.

| Field | Type | Meaning |
|---|---|---|
| `title` | `string` | Required. Sanitized into the channel name |
| `modelId` | `string` | Required. Recorded on channel Metadata for display. Nothing routes on it |
| `modelTier` | `string` | Required, and it has NO DEFAULT. The requested classification. An absent or empty value answers `400 CLASSIFICATION_REQUIRED` rather than falling back to `basic`, because a classification is a declared set of grants rather than a ladder and a deployment need not declare `basic` at all (ADR-046) |
| `modelName` | `string` | Optional display label |
| `topic` | `string` | Optional. What the conversation is about, in the caller's own words. Control-marker stripped and capped at 240 characters, then written to both the channel-context row and channel Metadata; the welcome grounds on it |
| `triggerContext` | `string` | Optional. What brought the conversation into existence. Sanitized the same way and stored server-side as `priorSubject`, which the welcome weighs above `topic` |
| `expirationDays` | `integer` | Optional, and must be sent WITH `expirationCriterion`. From 1 to this deployment's `MAX_CONVERSATION_TTL_DAYS` limit, which ships as 270. Absent means the conversation TYPE's own retention applies |
| `expirationCriterion` | `string` | `CREATED_TIMESTAMP` or `LAST_MESSAGE_TIMESTAMP` |

A body-supplied `userArn` is ignored - identity comes from the token, and the classification the caller may request is bounded by the grant set their groups resolve to.

```json
{
  "title": "Q2 revenue planning",
  "modelId": "anthropic.claude-sonnet-4-5",
  "modelName": "Sonnet 4.5",
  "modelTier": "premium",
  "topic": "the Q2 revenue plan and which accounts carry it",
  "expirationDays": 90,
  "expirationCriterion": "LAST_MESSAGE_TIMESTAMP"
}
```

Success is `200` with `{ "success": true, "conversation": { "id", "conversationArn", "title", "modelId", "modelName", "modelTier", "createdAt", "updatedAt" } }`, where `modelTier` is the resolved classification.

Notable refusals, by `code`, because a client reads the code rather than the message:

| Status | `code` | When |
|---|---|---|
| `401` | `MISSING_CLAIMS` | No `sub` on the authorizer claims |
| `400` | `MISSING_REQUIRED_FIELDS` | No `title` or no `modelId` |
| `400` | `CLASSIFICATION_REQUIRED` | No `modelTier`. There is no floor to fall back to |
| `400` | `CLASSIFICATION_NOT_CONVERSATIONAL` | An admin-plane classification. Refused for everyone, including an administrator who reaches it, because its assistant has no conversational runtime |
| `400` | `INVALID_EXPIRATION_DAYS` | Not an integer from 1 to the deployment limit |
| `400` | `INVALID_EXPIRATION_CRITERION` | Not one of the two criteria |
| `403` | `TIER_FORBIDDEN` | The caller's groups do not resolve to a grant set containing `modelTier`. A combination this deployment has not declared reaches nothing rather than falling back |
| `500` | `SERVER_MISCONFIG` | No `APP_INSTANCE_ARN`, or no assistant published for that classification |
| `500` | `CONVERSATION_CREATION_FAILED` | Anything else, including a malformed body |

Two behaviors here differ from the other handlers and are worth coding against rather than assuming away: a malformed body answers `500 CONVERSATION_CREATION_FAILED` rather than a `400`, and the handler sets wildcard CORS headers on its response, and the API's own CORS configuration answers in their place.

### 6.3 `POST /tasks`

Handler: `backend/lambda/src/user-tasks-api.ts`. Opens a work item in a conversation the caller is a member of.

| Field | Type | Meaning |
|---|---|---|
| `channelArn` | `string` | Required. The conversation the item belongs to, and must name one in this deployment |
| `taskType` | `string` | Required, and must be a type this deployment's state-machine registry declares. An unknown value answers `400 UNKNOWN_TASK_TYPE` with the declared set in `declared` |
| `requestExcerpt` | `string` | What is being asked for, in the person's words. Capped at 600 characters |
| `visibility` | `string` | `conversation` or `private`. **No default is applied**: an absent value reads as `private`, so an item is room-visible only when the request says so. A private item is still visible to the room as EXISTENCE through its `taskRef` |
| `priority` | `string` | `high`, `normal` or `low` |
| `dueBy` | `string` | ISO-8601 |
| `details` | `object` | The collected-information bag an assistant renders when it continues the item |

`owner`, `assigneeId`, `taskId` and `taskRef` on the body are ignored: the owner is the token's caller, and the identifiers are the server's. The item's TTL is bounded by the conversation's remaining retention, so a work item cannot outlive the conversation it belongs to.

```json
{
  "channelArn": "arn:aws:chime:us-east-1:<account>:app-instance/<instance>/channel/conv-1791086190864-a78ae41c19da",
  "taskType": "action_item",
  "requestExcerpt": "chase the Northwind renewal before the quarter closes",
  "priority": "high",
  "visibility": "conversation"
}
```

Success is `201`:

```json
{
  "task": {
    "taskId": "746ff127-2b04-4d7d-b2fd-55b8be4d8b41",
    "channelArn": "arn:aws:chime:...",
    "taskType": "action_item",
    "taskRef": 3,
    "status": "pending",
    "visibility": "conversation"
  }
}
```

Notable refusals: `401` with no `sub`; `400 INVALID_CHANNEL` for a channel outside this deployment; `400 MISSING_TASK_TYPE` or `400 UNKNOWN_TASK_TYPE`; `403 NOT_A_MEMBER`, which is proven by describing the channel AS THE CALLER rather than by any stored roster; `409 CONVERSATION_ARCHIVED` read from the authoritative tag rather than the non-authoritative Metadata mirror; `409 CONVERSATION_UNCLASSIFIED`; `503 CHANNEL_STATE_UNREADABLE` when the tags cannot be read, because "could not tell" must not mean "go ahead"; and `503 TASK_SERVICE_UNAVAILABLE` when the conversation's classification publishes no task service.

### 6.4 `POST /presigned-url`

Handler: `backend/lambda/presigned-url/index.js`. `action` is required and is `upload` or `download`.

An upload also requires `fileName` (1 to 255 characters, no path separators), `conversationId` and `fileType`, which must be one of an explicit allowlist of text, JSON, PDF, Office and common image types - `application/octet-stream` is deliberately absent. Success returns `{ "uploadUrl", "fields", "fileKey", "expiresIn", "maxBytes" }`. This is a presigned **POST**, not a PUT: post `fields` verbatim as form fields ahead of the file part. The key is composed server-side and is not a client's to choose.

A download requires `fileKey` and `conversationId`, and returns `{ "downloadUrl", "fileKey", "expiresIn" }`. The key must sit under the caller's own upload prefix, or under the conversation's generated-documents or battle-images prefix, or the answer is `403 FILE_KEY_NOT_OWNED`.

```json
{
  "action": "upload",
  "fileName": "q2-forecast.pdf",
  "fileType": "application/pdf",
  "conversationId": "conv-1791071525742-deae3c0a5549"
}
```

```json
{
  "action": "download",
  "fileKey": "attachments/conv-1791071525742-deae3c0a5549/<personId>/1791071600000-q2-forecast.pdf",
  "conversationId": "conv-1791071525742-deae3c0a5549"
}
```

The upload reply is posted as a form, not a PUT - `fields` goes in verbatim ahead of the file part. The key is `attachments/<conversationId>/<personId>/<timestamp>-<fileName>`, where `<personId>` is the uploader's AppInstanceUser id (`callerPersonId`), and the URL lasts an hour (`EXPIRATION_SECONDS`, set in `conversations-stack.ts`):

```json
{
  "uploadUrl": "https://<bucket>.s3.amazonaws.com/",
  "fields": { "key": "attachments/<conversationId>/<personId>/<timestamp>-q2-forecast.pdf", "policy": "...", "x-amz-signature": "..." },
  "fileKey": "attachments/<conversationId>/<personId>/<timestamp>-q2-forecast.pdf",
  "expiresIn": 3600,
  "maxBytes": 10485760
}
```

### 6.5 `GET /turn-state`

Handler: `backend/lambda/src/turn-state-api.ts`. Two required query parameters, `channelArn` and `responderId`, and no body. `responderId` is required rather than defaulted because busy is a property of a responder; defaulting it would return an empty state that a client would read as "nothing is queued".

```
GET /turn-state?channelArn=arn%3Aaws%3Achime%3Aus-east-1%3A<account>%3Aapp-instance%2F<instance>%2Fchannel%2Fconv-1791071525742-deae3c0a5549&responderId=advisor
```

Success is `200`. `queued` carries message **ids only, never content**, already filtered to what this caller may see. `noticeId` and `dispatchFailed` are omitted rather than null when absent, and `dispatchFailed` is a fixed reason code rather than prose:

```json
{
  "busy": true,
  "queued": ["a1b2c3d4-0000-0000-0000-000000000001"],
  "noticeId": "e5f6a7b8-0000-0000-0000-000000000002"
}
```

A quiet conversation answers `{ "busy": false, "queued": [] }` - note that this is also what a deployment with `TURN_QUEUE_ENABLED` unset returns, so a client cannot tell "nothing queued" from "the queue is off" and must not infer the feature's state from it.

Refusals: `400` for a missing parameter or a channel ARN from another deployment; `403 {"error":"Not a member of this conversation"}`; `405` for any method but `GET`; and `500 {"error":"Could not read the conversation state"}`, which is returned deliberately instead of an empty `200` so a client keeps whatever waiting state it is already showing.

### 6.6 `POST /feedback` and `GET /feedback`

Handler: `backend/lambda/src/user-feedback.ts`. `POST` requires `messageId`, `channelArn` and `feedback` (`up`, `down` or `clear`); `reason` is kept only on a `down` and only for a recognized value; `modelId`, `intent`, `note`, `experimentId`, `variantId` and `assignmentMode` are optional. Success is `200` with `{ "success": true, "feedbackId", "feedback" }`. Every vote appends, including a change and a `clear`, and only the latest vote per person per message counts. Deleting the person (`POST /users/delete`) deletes every record they wrote.

```json
{
  "messageId": "a1b2c3d4-0000-0000-0000-000000000001",
  "channelArn": "arn:aws:chime:us-east-1:<account>:app-instance/<instance>/channel/conv-1791071525742-deae3c0a5549",
  "feedback": "down",
  "reason": "inaccurate",
  "note": "cited a figure that is not in the source",
  "modelId": "anthropic.claude-sonnet-4-5",
  "intent": "analysis"
}
```

`reason` is kept only on a `down` and only for a recognized value, so an unrecognized one is dropped rather than refused. A `clear` needs only the three required fields.

`GET /feedback` is admin-only and takes a `days` query parameter (default 30). A `days` value that is not a whole number from 1 to 180 is refused with `400`, rather than read as some other window. It is an admin catalog route like any other: `AWS_IAM`, held by the `view-analytics` capability, and called SigV4-signed with an admin console session. It has no team route, because the summary counts every assistant together, so a team console session is refused at the gateway, and the handler refuses any signed principal that is not an admin console session (or, under `adminAuthMode=service`, the deployer's trusted proxy) with `403`. `POST /feedback` is on `PersonApi`, behind the edge authorizer. `approval_rate` is a percentage rounded to one decimal place.

```json
{
  "data": [
    { "model_name": "Sonnet 4.5", "intent": "analysis", "thumbs_up": 41, "thumbs_down": 3, "feedback_count": 44, "approval_rate": 93.2 }
  ]
}
```

Note one inconsistency to code against: a request with no usable `sub` answers `400 {"error":"Unable to determine user"}` here, where most handlers answer `401`.

### 6.7 What was not verified

The shapes above were read from their handlers. The remaining routes in the reference were not, so this guide does not state their bodies. Guessing one would be worse than leaving it out: a client built against an invented shape fails at runtime with no way to tell whether the document or the code is wrong.

## 7. Not a stable contract

Do not build on any of the following. Each is either derived, deployment-specific, or an implementation detail that is expected to move.

- **Invoke URLs, API ids and stage names.** Minted per deployment. Read them from stack outputs.
- **Which analytics routes exist.** `analyticsMode` decides which `/query` routes `AdminApi` serves.
- **A participant's name on an admin conversation read.** The reads carry no `senderName`, `memberName`, `invitedBy` or `moderatedByName` for any caller, so a client reads the participant from `senderArn` or `memberArn` (last segment, the person's AppInstanceUser id) and resolves names, where its role holds `see-user-identity`, through `GET /admin/conversations/identities`. A client that requires a name to render a row breaks.
- **Error sentences.** The `error` string is for a person to read. Branch on `code` and on the status; both are stable, the wording is not.
- **The absence of a `code`.** Codes are added with handlers. A refusal that carries none may carry one in a later release, so a client must not treat "no code" as a distinguishing signal.
- **Lambda construct and function names.** The `Integration` column exists to help a reader find a handler, not to be called. Nothing invokes these functions directly.
- **In-conversation refusal wording.** The rate-limit and budget messages are copy, they are configurable per deployment, and no structured control frame stands behind them. Do not parse them.
- **Ordering and shape of analytics rows.** Athena and Aurora are different query engines behind the same intent; the reference for what each returns is the handler, not this guide.
- **The CORS headers a handler sets.** `create-conversation` sets wildcard ones and others set the configured origin; on both APIs the API's own CORS configuration is what a browser sees.
- **Anything a synthesized template does not carry.** Request and response bodies are handler behavior. They change with the handler, and only the shapes in section 6 have been read against it.

---

**Related:** [`../../reference/api-contract.md`](../../reference/api-contract.md) for the generated route inventory, [`DEVELOPER-GUIDE.md`](DEVELOPER-GUIDE.md) for the wider development hub, [`MESSAGE-DELIVERY-GUIDE.md`](MESSAGE-DELIVERY-GUIDE.md) for what happens to a message after it is sent, and [`CHIME_SDK_INTEGRATION.md`](CHIME_SDK_INTEGRATION.md) for using the vended credentials against Amazon Chime SDK Messaging.
