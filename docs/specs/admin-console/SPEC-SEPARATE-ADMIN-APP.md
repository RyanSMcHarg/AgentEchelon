# SPEC: Separate Admin Console App

**Status:** P0-P1 BUILT (the standalone admin app and the chat-app cutover); P2-P4 pending (shared-code factoring, a dedicated admin app-client, further docs/hardening). This document specifies extracting the admin console into its own independently-deployable frontend app on its own origin. The backend admin plane is already separable today (see Design Anchor); this spec completes the split on the frontend and deploy layers. Nothing here changes the admin authorization model.

**Scope:** Ship the operator surface (analytics, conversation administration, evaluations, experiments, user management, membership audit) as a standalone admin app - its own Vite build, its own S3 plus CloudFront origin, gated on the `admins` group - that consumes the existing admin APIs. The public chat SPA contains zero admin code and zero admin endpoint URLs. The admin console is **always its own app: there is no bundled-into-chat mode.** Deploying an AE admin UI at all is optional (a headless or host-owned-console deployment may skip it), but when present it is the separate app - never code inside the chat SPA.

**Author:** Ryan McHarg

**Related:**
- `frontend/src/App.tsx:15` - `AdminDashboard` is statically imported; `App.tsx:78-99,183-190` - the `?admin` URL state and the inline admin-vs-chat branch that bundles both into one SPA
- `frontend/src/components/Header.tsx` - the Admin button (a chat-app component); the chat app drops it entirely after the split
- `frontend/src/components/admin/AdminDashboard.tsx` - the console container (7 sections, 17 sub-tabs, `QUERIES_BY_TAB` fan-out)
- `frontend/src/providers/AuthProvider.tsx:211-218` - `isAdmin` decoded from `cognito:groups` (present but unused as a UI gate)
- `frontend/src/services/chimeService.ts:82-125,777-837` - `vendAdminCreds` / `adminClientFor` / the client-side admin-action ops (admin plane) sharing the chat client module
- `backend/lib/stacks/frontend-stack.ts`, `backend/lib/constructs/frontend-distribution.ts` - the single S3 plus CloudFront origin the split is modeled on
- `backend/lib/constructs/admin-auth-mode.ts` - `adminApiMethodOptions()` / `adminAuthEnv()`; the `adminAuthMode` front-door flag (`ae-cognito` | `federated` | `service`)
- `backend/lambda/src/lib/auth.ts:170,204` - the shared `callerIsAdmin` / `requireAdmin` gate every admin endpoint already routes through
- `backend/scripts/gen-frontend-env.mjs:30-66` - the CloudFormation-output-to-`VITE_*` map the env split extends
- `backend/bin/backend.ts:140,327,340,428` - `appUrl` threaded into every API's `ALLOWED_ORIGIN` (the single-origin CORS coupling)
- `docs/guides/admin/ADMIN-INTEGRATION-GUIDE.md` - the existing BYO-console guide this app becomes the reference implementation of
- `docs/specs/admin-console/SPEC-ADMIN-CONSOLE.md` - the console design (sections, tabs, data sources, admin-action identity)
- `docs/specs/identity-access/SPEC-ADMIN-IDENTITY.md` - **the admin identity / auth spec** (the authority for this split's auth model): the Amazon Chime SDK app-instance-admin identity, the `${sub}-admin` per-human admin identity vended via credential-exchange `plane:'admin'`, admins-in-one-pool, and the `adminAuthMode` front door
- `docs/specs/identity-access/SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md` - the follow-up work: make admin analytics and every admin action IAM-enforceable per capability (see Follow-up below)

## Why

Today the chat SPA and the admin console are one Vite build served from one CloudFront origin. `AdminDashboard` is statically imported into `App.tsx:15` and rendered inline when the URL carries `?admin`, so the operator console is welded to the user-facing chat app.

**The primary driver is aligning with a stated project goal: AgentEchelon is meant to be agnostic of its interface layer.** The platform's foundations - the conversation substrate, identity, the assistant profiles, and the admin plane - are the product; the chat UI and the admin console are two *interfaces* on top of it. An interface-agnostic platform should let the admin surface be deployed, hardened, replaced, or omitted independently of the chat surface (see **Deployment layering** above). Bundling the console into the chat SPA is the concrete divergence from that goal, and splitting it out makes the platform's own operator surface a peer of any host-owned console rather than a corner of the chat app.

Two concrete benefits follow from the split, but they are supporting, not the driver:

- **Smaller public attack surface.** Every anonymous visitor currently downloads a bundle that contains all of `components/admin/*`, the admin-action client code, and (through the generated `frontend/.env`) the URLs of every admin API (analytics query, admin-conversations, user-management, experiments, feedback summary). Server-side `requireAdmin` still protects the data, so this is not a data breach, but it is an unnecessary and discoverable surface baked into a public asset. After the split the chat bundle carries no admin code and no admin endpoints.
- **Independent deploy and hardening.** Admin and chat share an origin, a CloudFront distribution, a WAF, a cache policy, and a single CORS `ALLOWED_ORIGIN`. Separated, an operator can put the admin surface behind stricter network controls and iterate on it without redeploying the public app.

The split also makes the platform's own operator surface the reference implementation of the BYO-console path documented in `ADMIN-INTEGRATION-GUIDE.md`.

## Design Anchor

**The backend admin plane is already separable; this spec completes the split on the frontend and deploy layers only, reusing every existing backend seam.** No new authorization model, no new gate, no per-handler change.

What already exists and is reused unchanged:
- **One admin gate.** Every admin endpoint routes through `callerIsAdmin` / `requireAdmin` (`auth.ts:170,204`), honoring `ADMIN_GROUP_NAMES`. Whether the request comes from the bundled console or a standalone app is irrelevant to it.
- **A front-door flag.** `adminAuthMode` (`admin-auth-mode.ts`) already attaches the right authorizer per mode (`ae-cognito` default, `federated` to a host pool, `service` to an IAM authorizer) to the Analytics, User Management, Admin Conversations, and Experiments APIs.
- **A console-portability contract.** `ADMIN-INTEGRATION-GUIDE.md` already states the tabs need exactly two injectables: the API base URL (`VITE_*_API_URL`) and the token or credential provider (`localStorage.idToken`). The chart and table primitives are dependency-free and port as-is.
- **Portable admin identity.** Admin actions on chat resources run as the operator's `${sub}-admin` app-instance-admin identity (vended per action via credential-exchange `plane:'admin'`) or the service app-instance-admin, independent of which origin or pool authenticated the operator (`SPEC-ADMIN-IDENTITY.md`, `ADMIN-INTEGRATION-GUIDE.md`).

What this spec adds is entirely on the frontend and deploy side: a second build target that contains only the admin surface, a second origin to serve it, an env split so each app carries only its own endpoints, and a CORS split so each API trusts only the origin that legitimately calls it.

## Deployment layering (the ordering goal)

The split serves a larger goal: **AgentEchelon deploys in four ordered layers - foundations before interfaces, and admin separable from user at both - so the platform stands on its own and each interface is a pluggable, independently deployable (and replaceable) surface on top.** The intended deploy order is:

1. **Core foundations (the AE platform).** The shared backend every conversation needs, independent of any interface: `AgentEchelonChimeMessaging`, `AgentEchelonCognitoAuth`, `AgentEchelonS3Storage`, `AgentEchelonFoundations` (task tables, abuse-controls, create-conversation and conversation-management APIs + their SSM contract), the per-profile assistant stacks (`AgentEchelonTier-*`), `AgentEchelonChannelFlow`, and the analytics / experiments / notifications backends. Nothing in this layer assumes a chat UI or an admin UI exists.
2. **Admin foundations (the admin backend plane).** The operator plane that is already separable today (see Design Anchor): the admin APIs (analytics query, admin-conversations, user-management, experiments), the `adminAuthMode` front door and its authorizers, the shared `requireAdmin` gate, and the `plane:'admin'` credential-exchange that vends the `${sub}-admin` admin identity. It depends only on core foundations and is fully usable with no AE frontend at all - a host can drive it from its own console.
3. **User-facing chat interface.** The chat SPA (`AgentEchelonFrontend`), a pluggable surface over the core foundations. It carries zero admin code or endpoints (the outcome of this split) and can be swapped for any interface that speaks the same platform seams.
4. **Admin interface.** The standalone admin console (`AgentEchelonAdminFrontend`, this spec), a pluggable surface over the admin foundations, gated on the `admins` group at its own origin, deployed last as its own step.

**Why the order.** Each layer consumes only the SSM / API contracts the layers before it publish, so foundations come up first and interfaces last. Because admin is a distinct layer at **both** the foundation and the interface level, an operator can deploy or harden the admin plane and its console without touching the user-facing chat surface, and vice versa. The two interface layers (3 and 4) are the interface-agnostic platform's plug-in points, which is exactly why the foundations (1 and 2) must be deployable and complete before either interface exists. This spec delivers layer 4 and, by removing admin from the chat bundle, sharpens the 1-2 (foundations) versus 3-4 (interfaces) boundary the platform is meant to have.

## Current coupling (what the split must sever)

1. **Single Vite bundle plus single CloudFront origin.** `AdminDashboard` imported at `App.tsx:15`, rendered at `App.tsx:183`; one distribution (`frontend-distribution.ts`). Admin components are statically imported (`AdminDashboard.tsx` top), so nothing tree-shakes them out today.
2. **`appUrl` is the single CORS `ALLOWED_ORIGIN`.** `appUrl` (`bin/backend.ts:140`) is threaded to every API Lambda's `ALLOWED_ORIGIN` (for example `analytics-stack-aurora.ts` around line 1597). A second origin is rejected by CORS until the allowlist is widened.
3. **Shared `AuthProvider` plus `localStorage.idToken`.** Every admin service reads `localStorage.getItem('idToken')` directly (`analyticsService.ts`, `adminConversationService.ts`, `experimentService.ts`, `membershipAuditService.ts`, `feedbackService.ts`). The whole app is wrapped in one provider tree (`App.tsx:220-234`).
4. **`chimeService.ts` mixes chat and admin.** The admin-action ops (`vendAdminCreds`, `adminClientFor`, `adminRedactMessage` / `adminDeleteMessage` / `adminRemoveMember` / `adminAddMember` / `adminListMembers`, `chimeService.ts:82-125,777-837`) live in the same module as chat messaging.
5. **Shared types and i18n.** `frontend/src/types/analytics.ts` (imported by roughly 15 admin files) and `frontend/src/types/index.ts` are shared with chat; `frontend/src/locales/en.json` holds both chat and `admin.*` strings.
6. **Admin entry gating lives in the chat app's Header.** The Admin button is a chat-app component; the standalone admin app must establish its own `admins`-group gate at its entry rather than inherit the chat Header.

## Target architecture

Two frontend apps built from one source tree, each with its own entry and its own build output, deployed to two origins.

```
frontend/
  index.html            -> chat entry  (main.tsx)     -> dist/       -> AgentEchelonFrontend origin
  admin.html            -> admin entry (admin-main.tsx)-> dist-admin/ -> AgentEchelonAdminFrontend origin
  src/
    shared/             (types, chart primitives, api client, auth, credential-exchange) - imported by both
    (chat sources)      imported ONLY by main.tsx
    components/admin/*  imported ONLY by admin-main.tsx
```

- **Two Vite entries in one package (recommended first step).** Add `admin.html` and `src/admin-main.tsx` that mounts only `AdminDashboard` inside the auth and credential providers it needs. Vite builds each entry to its own output directory. The chat entry (`main.tsx`) no longer imports any admin module, so the chat bundle tree-shakes all admin code out. This is the smallest change that achieves the bundle separation.
- **Endgame: a workspace split.** If the admin app grows its own dependencies and cadence, promote `src/shared/*` to a `@ae/shared` workspace package and move the admin app to its own `admin/` package. Deferred; Option A delivers the security win immediately with far less churn.
- **The security-relevant invariant is one line:** the chat entry imports nothing under `components/admin/` and no admin-only service. A build assertion (grep the chat chunk for `components/admin` or an admin endpoint marker) pins it so a future refactor cannot silently re-couple them.

## Frontend split

**Moves to the admin app:** `components/admin/*`; the admin services (`adminConversationService`, `experimentService`, `membershipAuditService`, `feedbackService` admin-summary path, the admin-query use of `analyticsService`); the admin half of `chimeService` (admin actions + `vendAdminCreds`); `AdminDashboard.css` and sibling admin styles; the `admin.*` i18n keys.

**Factored into `src/shared/` (imported by both):** `types/analytics.ts` and the shared members of `types/index.ts`; the dependency-free chart and table primitives (`DataTable`, `LineChart`, `Sparkline`, `FunnelChart`, `DistributionBar`, `MetricCard`); a small shared `apiCall` helper with an **injectable token provider** (today every service re-implements `fetch` + `Bearer idToken` + `VITE_*`; centralizing it realizes the portability contract the integration guide names and de-duplicates five near-identical call sites); the credential-exchange client used by both planes; `eventTrackingService`; the design tokens.

**`chimeService` split.** The admin-action surface moves into an admin-scoped module the admin app imports; the chat app keeps only chat messaging. Both still call the shared credential-exchange endpoint (chat vends chat creds, admin vends `${sub}-admin` creds), so `VITE_CREDENTIAL_EXCHANGE_API_URL` is required by **both** apps (`SPEC-CREDENTIAL-EXCHANGE.md` marks it required).

## Auth and gating

The admin identity model is defined in [`SPEC-ADMIN-IDENTITY.md`](../identity-access/SPEC-ADMIN-IDENTITY.md), the admin/auth spec. This split does not change it; it only moves where the console is served and gated.

- **The admin app gates on the `admins` group.** It uses the `isAdmin` claim `AuthProvider` already decodes (`AuthProvider.tsx:211-218`) as its entry gate: a non-admin who authenticates sees an access-denied screen, never the console. There is no chat Header in the admin app; the admin app gates its own entry on the `admins` claim.
- **Admin actions run as the Amazon Chime SDK `app-instance-admin` identity, and it is origin-independent.** The admin console performs **administration**: it acts on chat resources across conversations (read any conversation, redact, delete, add or remove members) as an Amazon Chime SDK **`AppInstanceAdmin`**. This is distinct from channel-level **moderation** - an Amazon Chime SDK **`ChannelModerator`** scoped to a single conversation, which is a conversation-level concern (a channel's creator or a promoted member managing that one channel) and is NOT what the admin console does (see the Amazon Chime SDK Messaging identity model: AppInstanceAdmin vs ChannelModerator). Per `SPEC-ADMIN-IDENTITY.md`, an operator's admin actions do NOT run as their chat `${sub}` identity; they run as a distinct **app-instance-admin** identity: the per-human `${sub}-admin`, whose short-lived, scoped, audited credentials are vended per action through the credential-exchange `plane:'admin'` (a separate no-human **service** app-instance-admin covers automation such as the Layer-6 membership audit). Because that identity is minted by the credential-exchange from the operator's token - independent of which origin or pool served the page - admin actions work identically from the standalone admin app once the exchange API's CORS allows the admin origin. `VITE_CREDENTIAL_EXCHANGE_API_URL` is therefore required by the admin app too.
- **Cognito app-client.** Two options on the same pool (admins are the same pool as users, `SPEC-ADMIN-IDENTITY.md`):
  - Reuse the existing app-client and add the admin origin to its callback and logout URL list (simplest; the admin app just enforces the `admins` claim on render).
  - Provision a dedicated admin app-client (`adminUserPoolClientId`) whose callback and logout URLs are the admin origin only (recommended: isolates the admin session from the chat session, allows a distinct token or refresh policy, and keeps the admin token audience separate; still one pool, one `admins` claim).
- **Federation with a non-Cognito IdP is supported by the design, but untested.** The admin front door is governed by `adminAuthMode` (`ae-cognito` default, `federated` to a host IdP/pool, `service` to an IAM authorizer), and the admin identity comes from the credential-exchange rather than from Cognito specifically. So by design a host can federate admin identities from an IdP other than Cognito (SSO / OIDC / SAML, per [`IDENTITY-PROVIDER-GUIDE.md`](../../guides/user/IDENTITY-PROVIDER-GUIDE.md)) and still drive the admin plane and its console. This path is **designed for but not yet validated end to end**: the tested configuration today is the built-in `ae-cognito` `admins` group. Treat non-Cognito admin federation as a supported-by-design, verify-before-relying capability. Under `service` mode the host proxies and the AE admin app is typically not deployed at all.

## Backend and deploy

- **A new `AgentEchelonAdminFrontend` stack**, mirroring `FrontendStack` plus `FrontendDistribution`: a private S3 bucket with OAC, a CloudFront distribution with the SPA 403/404-to-`index.html` fallback and security headers, an optional dedicated WAF, and its own `AdminDistributionUrl` / `AdminDistributionBucketName` / `AdminDistributionId` outputs. It is a **separate stack deployed as its own step** (`enableAdminApp`). Deploying an admin UI is optional (a deployment may run headless or host its own console), but there is **no bundled-into-chat alternative** - the chat app never carries admin code. As with the chat frontend, the **admin stack** (the hosting: bucket + distribution) and the **admin UI** (the built admin SPA, synced into that bucket) are **two separate deployment steps**: the stack provisions the empty bucket + distribution, then `npm run deploy-frontend` (admin target) syncs the build in.
- **Env split in `gen-frontend-env`.** Emit two env files: the chat env keeps only chat-facing vars (`VITE_CREDENTIAL_EXCHANGE_API_URL`, `VITE_CLIENT_EVENTS_API_URL`, `VITE_CREATE_CONVERSATION_API_URL`, the user pool and client, the app-instance ARN, and the like); a new admin env carries the admin-only vars (`VITE_ANALYTICS_API_URL`, `VITE_ADMIN_CONVERSATIONS_API_URL`, `VITE_USER_MANAGEMENT_API_URL`, `VITE_EXPERIMENTS_API_URL`, `VITE_USER_FEEDBACK_API_URL`, `VITE_ANALYTICS_MODE`, plus the shared auth vars and `VITE_CREDENTIAL_EXCHANGE_API_URL`). Dropping the admin-only vars from the chat env is what removes the admin endpoint URLs from the public bundle.
- **CORS split via `adminAppUrl`.** Introduce an `adminAppUrl` context. Each API sets its `ALLOWED_ORIGIN` to the origin that legitimately calls it: the admin-only APIs (analytics query, admin-conversations, user-management, experiments) trust `adminAppUrl`; the chat-facing APIs keep `appUrl`. The **credential-exchange API is dual-plane** (both apps call it) and must allow **both** origins, so its `ALLOWED_ORIGIN` becomes a list. The `GET /feedback` admin summary shares an authorizer with the user-facing `POST /feedback` (the documented `adminAuthMode` exception, `ADMIN-INTEGRATION-GUIDE.md`), so its origin handling is called out explicitly rather than assumed.
- **Deploy ordering.** Follow the four-layer sequence in **Deployment layering (the ordering goal)** above: core foundations, then admin foundations, then the user-facing chat interface, then the admin interface. Concretely for the frontends, the chat app deploys after the foundations, and the admin interface deploys last as **two steps of its own**: deploy the `AgentEchelonAdminFrontend` stack (its bucket + distribution), then build and sync the admin UI into it. Backend redeploys with `--context adminAppUrl=<AdminDistributionUrl>` so the admin APIs' CORS trusts the admin origin (the same appUrl-to-CORS step the chat app already requires, now for the second origin).

## What the chat SPA loses

The change that delivers the security win: remove `AdminDashboard` from `App.tsx:15`, delete the `?admin` state and the admin branch (`App.tsx:78-99,183-190`), and remove the Admin button from `Header.tsx:39-47`. The chat app no longer imports any admin module, so the chat bundle carries no admin code; and with the admin-only `VITE_*` vars dropped from the chat env, it carries no admin endpoint URLs. A build assertion verifies the chat chunk contains no `components/admin` reference.

## Interaction with the BYO-console guide

The separate app is the reference realization of `ADMIN-INTEGRATION-GUIDE.md`'s "port the tabs" path: the tabs already take an injectable base URL and token provider, which the shared `apiCall` formalizes. `adminAuthMode` continues to govern the backend front door (`ae-cognito` for a standalone AE-pool admin app, `federated` for a host admin pool, `service` for a host proxy). Nothing in this spec forecloses a host from replacing the AE admin app entirely; it makes the default deployment match the shape a host-owned console would take.

## Follow-up: IAM-gate the admin actions (admin-foundations hardening)

A direct follow-up, tracked separately, hardens the **admin foundations** layer (layer 2 in Deployment layering): make every admin action - admin analytics / query, admin-conversations reads, user management, experiments, and the redact / delete / membership actions - **IAM-enforceable per capability**, so a role can be denied a *specific* admin action rather than being gated only by membership in the `admins` group. The two efforts reinforce each other: this spec gives the admin plane its own front door (its own origin, its own app-client), and that front door is the natural place to require per-persona capabilities - the dedicated admin app-client (P3) is where the persona roles attach. Design: [`SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md`](../identity-access/SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md).

## Phased build

- **P0 - Stand the admin app up (chat not yet cut over).** Add the `admin.html` plus `admin-main.tsx` entry mounting `AdminDashboard`; add the `AgentEchelonAdminFrontend` stack; split `gen-frontend-env` to emit the admin env; add `adminAppUrl` and widen the admin APIs' CORS (and the credential-exchange list); gate the admin entry on the `admins` group. During this step the chat app still carries admin so the standalone app can be proven working first; this coexistence is a **build-time migration step, not a supported deployment mode** - P1 removes admin from chat to reach the end state.
- **P1 - Remove admin from the chat app (the attack-surface reduction).** Delete the admin import, `?admin` branch, and Header button from the chat app; drop the admin-only `VITE_*` vars from the chat env; add the build assertion that the chat chunk has no admin code. This is the step that shrinks the public surface.
- **P2 - Factor `src/shared/`.** Extract the shared types, chart primitives, the `apiCall` helper with the injectable token provider, and the credential-exchange client both apps use; de-duplicate the per-service fetch boilerplate.
- **P3 - Dedicated admin Cognito app-client.** Provision the admin app-client with admin-origin callback and logout URLs; isolate the admin session; enforce the `admins`-group gate at sign-in.
- **P4 - Docs and hardening.** Fold the separate app into `ADMIN-INTEGRATION-GUIDE.md` as the reference own-console; apply stricter security headers or WAF on the admin origin; document the two-origin CORS and env model in the deploy guide.

## Open questions and risks

1. **Option A (two Vite entries) versus Option B (workspace split).** Start with A for the immediate bundle separation; revisit B if the admin app diverges enough to warrant its own dependency set and release cadence.
2. **Credential-exchange CORS is dual-origin.** It is the one API both apps call, so its `ALLOWED_ORIGIN` must be a list of both origins; a single-origin assumption there breaks either chat messaging or admin actions.
3. **Cognito callback URL management.** Whether to reuse the app-client (add the admin origin to its callback list) or provision a dedicated admin app-client; the dedicated client is cleaner but adds a stack resource and a second redirect configuration.
4. **The `GET /feedback` exception.** It is not switched by `adminAuthMode` (shares the user-feedback authorizer); confirm the admin app calls it with a user token and that its origin handling is correct under the split.
5. **Cutover, not backward-compatibility.** There is no bundled-mode fallback: removing admin from the chat app (P1) is a one-way cutover, so anyone who currently reaches the console via the chat origin must move to the admin origin. Sequence P1 after the standalone admin app is proven (P0), and communicate the new admin URL.
6. **Second distribution cost.** A second CloudFront distribution and bucket are a small fixed addition; acceptable for the isolation, and only provisioned when an admin UI is deployed.
