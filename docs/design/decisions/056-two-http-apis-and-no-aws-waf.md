---
title: "ADR-056: Two HTTP APIs carry every route, and abuse control on the unauthenticated routes runs in the handler"
status: Accepted 2026-10-17. Decisions 1 to 4 are built. Every person route is served by `PersonApi` (`backend/lib/stacks/person-api-stack.ts`) and every admin route by `AdminApi` (`backend/lib/stacks/admin-api-stack.ts`), both HTTP APIs built from route tables (`RouteTableApi`, `backend/lib/constructs/http-api.ts`); no stack builds an API Gateway REST API. No API carries an AWS WAF association; the only web ACL in the tree is on the CloudFront distributions (`backend/lib/constructs/frontend-distribution.ts`). The unauthenticated routes (guest start, guest refresh, `link` redemption and the invitation landing read) run their abuse controls in the handler and fail closed, and the existing per-person budget, global budget and rate limit refuse when their store errors or their table is unset (`backend/lambda/src/lib/abuse-controls.ts:180-182,206-207,267-280`). `IngressApi` is NOT BUILT.
date: 2026-10-17
related:
  - "./055-stacks-are-capabilities-in-layers.md"
  - "../../overview/STACKS.md"
  - "../../overview/TENETS.md"
  - "../../specs/interaction/governance/SPEC-ABUSE-CONTROLS.md"
  - "../../specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md"
  - "../../specs/interface/SPEC-EMBEDDABLE-WIDGET.md"
  - "../../specs/communication/SPEC-TELEPHONY.md"
  - "../../../backend/lambda/src/lib/abuse-controls.ts"
  - "../../../backend/lib/constructs/frontend-distribution.ts"
  - "../../../backend/lib/stacks/identity-stack.ts"
  - "../../../backend/lib/stacks/conversations-stack.ts"
tracking: |
  Layering the stacks (ADR-055) needs a route to exist exactly when its capability is declared. An API per feature, each building its own authorizer, cannot express that, and each one is a separate place a token is checked. The smallest deployment with no accounts serves an unauthenticated person-facing route, guest start, so abuse on it lands on the smallest installation. The owner decided on 2026-10-17 that the API carries no AWS WAF and that the limits run in the handler.
---

# ADR-056: Two HTTP APIs carry every route, and abuse control on the unauthenticated routes runs in the handler

## Status

**Accepted (2026-10-17).** Decisions 1 to 4 are built. No vendor reaches an HTTP API. What ships:

- **Two HTTP APIs, built from route tables.** `PersonApi` (`backend/lib/stacks/person-api-stack.ts`, part of the required core) and `AdminApi` (`backend/lib/stacks/admin-api-stack.ts`, part of `admin`). Each stack that owns a handler declares its routes as data (`RouteSpec`), and `RouteTableApi` in `backend/lib/constructs/http-api.ts` builds an API from the routes of the stacks it is built on, with a `$default` stage, a throttle per route and payload format 1.0 to every handler.
- **One edge authorizer per API.** One function (`backend/lambda/src/edge-authorizer.ts`, `aws-jwt-verify`) attached through `backend/lib/constructs/edge-authorizer.ts`. On `PersonApi` it verifies the token against the trusted-issuer registry, resolves its subject through `Identities` and answers with a policy naming the routes it may call, cached 300 seconds, the credential exchange uncached; `GET /deployment/state` has no authorizer. On `AdminApi` it guards only the console session and admits only an issuer that declares `admin: true`; every other admin route is IAM, and the console roles' grants come from the capability catalog (`grantAdminRolesOnApi`, `backend/lib/constructs/admin-role-grants.ts`). Handlers read the caller from the authorizer's context (`callerPersonId`, `backend/lambda/src/lib/auth.ts`) and do no `Identities` lookup of their own.
- **No vendor route.** A connector that subscribes to vendor events receives them through the vendor's Amazon EventBridge partner event source (Salesforce Event Relay, the PagerDuty EventBridge integration), on one rule per connector in `Connectors` (`backend/lib/stacks/connectors-stack.ts`), pinned to the declared source; the receiver may be invoked by those rules alone ([SPEC-CONNECTORS.md](../../specs/communication/SPEC-CONNECTORS.md)). `IngressApi`, an HTTP API for a vendor with no EventBridge integration (Twilio), is **NOT BUILT**.
- **No AWS WAF on any API (decision 2).** No API has an AWS WAF association, a usage plan or a request validator. Every route carries its own throttle except the person credential exchange, which has only the account's limit. CORS is configured on each API from the declared origins.
- **Unauthenticated routes that fail closed (decision 3).** Guest start and guest refresh (`backend/lib/constructs/guest-issuer.ts`, `GUEST_START_THROTTLE` 5 requests per second and `GUEST_REFRESH_THROTTLE` 20) and `link` redemption (`backend/lib/constructs/invitation-link-issuer.ts`, `LINK_REDEEM_THROTTLE`) carry no authorizer and their own throttles. Each runs its issuer's kill switch, per-address limit and server-side captcha before anything else, and each answers `unavailable` when a control cannot answer (`backend/lambda/src/lib/guest-abuse.ts`, `backend/lambda/src/lib/invitation-redemption.ts`). Production refuses the captcha vendor's test keys and any setting the issuer block does not know (`issuerErrors`, `backend/lib/config/issuers.ts`). The landing page's read (`POST /invitations/peek`) consumes nothing and carries its own throttle (`backend/lib/stacks/identity-stack.ts:675`).
- **Abuse limits that fail closed (decision 4).** The per-person budget, the global budget and the rate limit refuse when their store errors or their table is unset (`backend/lambda/src/lib/abuse-controls.ts:180-182,206-207,267-280`), and synthesis refuses a wiring without the table (`abuseControlsWiring`, `backend/lib/stacks/agent-classification-common.ts`).

## Context

- **A route must exist exactly when its capability is declared** (ADR-055). That needs one route table per API, filled from the capability stacks below it, not an API per feature.
- **A token should be checked in one place.** An authorizer per API is one more place to miss an `aud` check, and a Cognito user pool authorizer trusts only Cognito pools.
- **The minimal deployment has an unauthenticated route.** An anonymous visitor starts a guest session in the widget with no account, so the first deploy any operator runs is open to the internet.
- **AWS WAF associates with REST APIs and CloudFront, not with HTTP APIs** (verified 2026-10-17 against the AWS WAF resource list).

## Decision

**1. Two HTTP APIs (API Gateway v2).**

- `PersonApi` carries every person-facing route behind one edge authorizer. The authorizer verifies the token against the trusted-issuer registry, resolves the caller to their AppInstanceUser once, and passes it in the authorizer context, so no handler parses a token.
- `AdminApi` carries every admin route behind IAM.
- A vendor is not a person, so it belongs on neither API. A vendor with an Amazon EventBridge integration needs no API at all; a third, `IngressApi`, would serve a vendor without one, and is **NOT BUILT**.

HTTP API because its `$default` stage deploys routes automatically, it is cheaper and has lower latency, and none of the REST-only features is in use. Route and stage throttling carry over.

**2. No AWS WAF on the API.** `PersonApi` stays one HTTP API.

**3. The unauthenticated routes enforce abuse control in the handler, and every control fails closed.** The routes are guest start and `link` invitation redemption. Each enforces:

- a captcha verified server-side;
- a per-IP limit;
- a per-person message limit;
- a kill switch;
- HTTP API route throttling, tighter than the stage's.

When a limit's store or the captcha verifier is unavailable, the request is refused. Production configuration carries no bypass token. The guest issuer also sets an expiration on the guest's AppInstanceUser and channel, so an abandoned session cleans itself up.

**4. The existing limits fail closed too.** The per-person budget and the rate limit refuse when their store errors or is unset. Deduplication and the placeholder mapping are idempotency, not limits, and keep their policy.

**5. The recorded fallback.** If traffic shows the in-handler limits are not enough, a small REST API with AWS WAF carries only the unauthenticated routes. Everything else stays on the two HTTP APIs.

## Consequences

- **Accepted cost:** an abusive request still reaches and bills the Lambda, and a flood throttles legitimate visitors on that route.
- **CORS** for `PersonApi` and the widget's `frame-ancestors` are generated from the declared host sites and issuers, never `*`.
- **HTTP API differs from REST** in CORS handling, payload limits and the authorizer context shape. Attachments already go to S3 by presigned URL, so payload limits do not reach the API, and the context shape is read in one function.
- **A route is lost only visibly.** The route table is the single source, and a test compares it with every URL the chat app, the console and the e2e helpers call.

## What is not built

- `IngressApi`, for a vendor with no EventBridge integration.
- The REST API with AWS WAF of decision 5, which is a fallback, not a plan.

## What proves it

Synth: each route appears once, on the right API, with the right authorizer (`backend/test/each-route-is-served-once-on-its-api.test.ts`); the route table is every URL the clients call (`backend/test/the-route-table-is-every-url-a-client-calls.test.ts`); each API allows the origins that call it (`backend/test/each-http-api-allows-the-origins-that-call-it.test.ts`). Live deny-tests: a token from an undeclared issuer gets 401 on every `PersonApi` route (`backend/scripts/deny-test-edge-authorizer.mjs`, not yet run against a deployment); a burst from one address is refused on guest start, a missing captcha is refused and an unreadable or paused kill switch refuses (`backend/scripts/deny-test-guest.mjs`, rows 5 and 7), with a captcha verifier or limit store that cannot answer proven by `backend/test/the-guest-session-fails-closed.test.ts`; `link` redemption is redeemed once in its declared mode (`backend/scripts/deny-test-invitations.mjs`), and its controls are declared and refused in production without a real captcha (`backend/test/an-invitation-link-issuer-is-declared-with-its-controls.test.ts`) and refuse in the handler (`backend/test/lib/an-invitation-is-redeemed-once-in-its-mode.test.ts`), with no live deny-test of its burst, captcha or kill switch yet; a vendor event reaches the receiver only through its connector's rule, and no route serves a vendor (`backend/scripts/deny-test-connector-events.mjs`, not yet run against a deployment; the unit evidence is `backend/test/lib/a-vendor-event-is-received-only-from-its-source.test.ts`).

## Revisit when

Measured abuse on an unauthenticated route exceeds what the in-handler limits absorb at an acceptable Lambda cost. The fallback in decision 5 is the answer, scoped to those routes.
