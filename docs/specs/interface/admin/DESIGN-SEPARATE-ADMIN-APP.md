# DESIGN: Separate Admin App

**Status:** Partial (frontend workspace split and CORS/env split built through P3; further docs and hardening remain) **Layer:** Interface (admin interface - reference client) **Plane:** admin **Product spec:** [`SPEC-ADMIN-CONSOLE.md`](SPEC-ADMIN-CONSOLE.md) **Summary:** An operator wants the privileged admin surface - its code and its endpoint URLs - kept out of the public chat app that any visitor loads, and wants to deploy, harden, replace, or omit that surface on its own schedule rather than ship one bundle where admin code rides along in every browser. The alternative is to hand-separate admin from public code and manage the split yourself. The admin console ships as its own npm-workspace package (`@ae/admin`) built and deployed to its own CloudFront origin, sharing `@ae/shared` with the chat app (`@ae/chat`); a build-time import-graph assertion keeps admin code out of the public chat bundle.

## 1. Architecture

The frontend is an npm-workspaces monorepo of three packages under `frontend/packages/`:

- **`@ae/chat`** (`packages/chat/`) - the public chat SPA; entry `src/main.tsx`. Carries zero admin code and zero admin endpoint URLs.
- **`@ae/admin`** (`packages/admin/`) - the standalone operator console; entry mounts `AdminDashboard`. Contains `components/admin/*`, the admin services (`analyticsService`, `adminConversationService`, `membershipAuditService`, `adminChime`, `adminAttachmentService`, `profileService`, `awsConsole`, `sigv4Fetch`), and `metricTargets.ts`.
- **`@ae/shared`** (`packages/shared/`) - code both apps import: shared types (`types/analytics.ts`, `types/index.ts`), the `apiCall` helper with an injectable token provider (`api/apiCall.ts`), the credential-exchange client (`services/credentialExchange.ts`), `eventTrackingService`, `experimentService`, `feedbackService`, i18n (`i18n/`), the model-strategy config, and the message parser. The dependency-free chart and table primitives live here too.

Each app is an independent Vite build with its own output, its own origin, and its own env, all against the **same** Cognito pool, app instance, users, and credential-exchange. The admin console container internals are in [`DESIGN-ADMIN-CONSOLE.md`](DESIGN-ADMIN-CONSOLE.md); this doc covers the split, the CORS/env wiring, and the deploy targets.

Platform fit: this split realizes the interface-agnostic goal. The platform foundations (conversation substrate, identity, assistant profiles, admin plane) are the product; the chat SPA and the admin console are two pluggable interfaces on top. AgentEchelon deploys in four ordered layers - core foundations, admin foundations, chat interface, admin interface - so the admin surface can be deployed, hardened, replaced, or omitted independently of the chat surface. The backend admin plane is already separable (one `requireAdmin` gate, an `adminAuthMode` front door, a portable administration identity); this split completes the separation on the frontend and deploy layers.

## 2. Data model

No new datastore. The split is a build-and-deploy concern over existing seams:

- **Two Vite entries / build outputs** - one per app package, each syncing into its own S3 bucket.
- **Two env files** emitted by `backend/scripts/gen-frontend-env.mjs`: the chat env carries only chat-facing `VITE_*` vars; the admin env carries the admin-only vars plus the shared auth vars.
- **Origin config** (`backend/lib/config/app-origins.ts`): `appUrl` (chat) and `adminAppUrl` (admin) CDK context values, with `adminAppUrl` falling back to the chat origin until the admin frontend deploys.
- **Optional dedicated admin Cognito app-client** on the same pool (`cognito-auth-stack.ts`), gated on `enableAdminApp` and opt-out-able with `-c adminAppClient=shared`.

## 3. APIs and interfaces

**Origin-to-API contract** (`app-origins.ts`): each API sets its `ALLOWED_ORIGIN(S)` to the origin(s) that legitimately call it.

- `chatOrigin(scope)` reads `appUrl` (or `APP_URL`, or `http://localhost:5173`).
- `adminOrigin(scope)` reads `adminAppUrl`, falling back to `chatOrigin` until the admin frontend is deployed and `-c adminAppUrl=<AdminDistributionUrl>` is supplied.
- `sharedOrigins(scope)` returns the deduped `[chat, admin]` pair for a surface both apps consume; `sharedOriginsEnv(scope)` is its comma-joined form for the multi-origin echo handlers.

Applied:

| Surface | Origin(s) | Reason |
|---|---|---|
| Analytics query, user-management, admin-conversations, membership-audit | `adminOrigin` only | Admin-only; the chat app never calls them. |
| Credential-exchange, experiments, user-feedback | `sharedOrigins` (both) | Dual-plane: both apps call them (chat vends chat creds, admin vends `${sub}-admin` creds; experiments and feedback are consumed by both). |
| Client-events, deployment-state, messaging, create-conversation | `appUrl` (chat) | Chat-only; do not use `app-origins.ts`. |

The credential-exchange being dual-origin is the load-bearing case: it is the one API both apps call, so a single-origin assumption there breaks either chat messaging or admin actions. The `GET /feedback` admin summary shares the user-feedback authorizer with the user-facing `POST /feedback` (the documented `adminAuthMode` exception), so `user-feedback.ts` echoes the matching request Origin from the shared comma list rather than pinning one.

**Env split** (`gen-frontend-env.mjs`): the admin env carries `VITE_ANALYTICS_API_URL`, `VITE_ADMIN_CONVERSATIONS_API_URL`, `VITE_USER_MANAGEMENT_API_URL`, `VITE_EXPERIMENTS_API_URL`, `VITE_USER_FEEDBACK_API_URL`, `VITE_ANALYTICS_MODE`, the shared auth vars, and `VITE_CREDENTIAL_EXCHANGE_API_URL`. Dropping the admin-only vars from the chat env is what removes the admin endpoint URLs from the public bundle. `VITE_CREDENTIAL_EXCHANGE_API_URL` is required by both apps.

**Configurable link-out** (`VITE_ADMIN_APP_URL`): when set, the chat Header shows an admin a plain `<a href>` link out to the console (admin-only, new tab). It is a URL string, not admin code or an admin endpoint, so the chat bundle stays admin-free and the invariant assertion still passes. Unset means no link. A deployer can override it to point at their own admin surface built on the same admin APIs.

## 4. Key flows and algorithms

**The security-relevant invariant.** The chat entry's import graph must never resolve a module physically under `packages/admin/`. `frontend/scripts/assert-no-admin-in-chat.mjs` enforces it: it does a BFS over the chat entry's static import graph starting at `packages/chat/src/main.tsx`, following relative imports and the `@ae/shared` package import (resolved to its real source, mirroring `@ae/shared`'s `exports` map so an admin-only module smuggled into shared is also caught). Any resolved path under `packages/admin/` is a violation; the script reports the offending import chain and exits non-zero. It asserts on the source import graph, not the minified bundle, because minification mangles identifiers and drops module paths - walking the static graph is deterministic and fails a re-coupling refactor at build time. The check is wired into the chat deploy so a regression cannot ship silently.

**Admin actions are origin-independent.** The console performs **administration** (acting on chat resources across conversations as an app-instance-admin), distinct from channel-level **moderation** (a ChannelModerator scoped to one channel, which the console does not do). Per [`SPEC-ADMIN-IDENTITY.md`](../../interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md), an operator's admin actions run as the per-human `${sub}-admin` identity, whose short-lived, scoped, audited credentials are vended per action through credential-exchange `plane:'admin'`. Because that identity is minted by the credential-exchange from the operator's token - independent of which origin or pool served the page - admin actions work identically from the standalone admin origin once the credential-exchange API's CORS allows it. This is why the split changes where the console is served and gated, but not the admin authorization model.

**Entry gating.** The admin app gates on the `admins` group using the `isAdmin` claim the shared `AuthProvider` decodes: a non-admin who authenticates sees an access-denied screen, never the console. There is no chat Header in the admin app; it gates its own entry.

**Deploy flow.** Following the four-layer order, the admin interface deploys last as two steps of its own: (1) deploy the `AgentEchelonAdminFrontend` stack (its bucket and distribution), then (2) build and sync the admin UI into it. The backend then redeploys with `--context adminAppUrl=<AdminDistributionUrl>` so the admin APIs' CORS trusts the admin origin - the same appUrl-to-CORS bootstrap the chat app already uses, now for the second origin. Fail modes: until `adminAppUrl` is wired, `adminOrigin` falls back to the chat origin, so admin APIs would only trust the chat origin (admin actions from the admin origin are CORS-rejected until the redeploy); a missing `enableAdminApp` skips the dedicated admin app-client, and the admin app falls back to the shared `VITE_CLIENT_ID`.

## 5. Security and IAM

- **Smaller public attack surface.** After the split the chat bundle carries no `components/admin/*` code and, with the admin-only `VITE_*` vars dropped from its env, no admin endpoint URLs. Server-side `requireAdmin` already protected the data, so this removes a discoverable surface, not a data breach.
- **One admin gate, unchanged.** Every admin endpoint routes through `callerIsAdmin` / `requireAdmin` (`backend/lambda/src/lib/auth.ts`), honoring `ADMIN_GROUP_NAMES`. Whether the request comes from the standalone app or (historically) the bundled console is irrelevant to it.
- **Front-door flag.** `adminAuthMode` attaches the right authorizer per mode (`ae-cognito` default, `federated` to a host pool, `service` to an IAM authorizer) to the admin APIs. Non-Cognito admin federation is designed for but not yet validated end to end; the tested configuration is the built-in `ae-cognito` `admins` group.
- **Dedicated admin app-client (P3).** An admin app-client on the same pool, with admin-origin-only callback and logout URLs, isolates the admin session and token from the chat session and is the natural attachment point for the per-persona capability roles the A14 follow-up adds ([`DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md`](../../interaction/identity-access/admin/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md)).
- **CORS isolation.** Each admin-only API trusts only `adminAppUrl`; the dual-plane APIs trust both origins explicitly rather than assuming one.

## 6. Testing

- **Unit:** the admin package's Vitest suite (see [`DESIGN-ADMIN-CONSOLE.md`](DESIGN-ADMIN-CONSOLE.md) section 6) runs against `@ae/admin` in isolation, proving the package builds and renders without the chat app.
- **Build assertion:** `frontend/scripts/assert-no-admin-in-chat.mjs` is the split's own test - it fails the chat build if the chat entry's import graph reaches `packages/admin/`.
- **End-to-end (Playwright, `tests/e2e/`):** `admin-dashboard.spec.ts`, `admin-nav.spec.ts`, `admin-dashboard-render.spec.ts` drive the standalone console; they target the admin origin via `E2E_ADMIN_BASE_URL`.
- **Deferred / gaps:** the dual-origin CORS and env model are exercised by deploy, not by an automated multi-origin test; non-Cognito admin federation is unvalidated end to end; stricter admin-origin security headers or WAF (P4) are not yet applied.

## 7. Migration / phasing / rollout

- **P0 - Stand the admin app up.** The `@ae/admin` package and the `AgentEchelonAdminFrontend` stack; `gen-frontend-env` emits the admin env; `adminAppUrl` and the widened admin-API CORS (and the credential-exchange list); the `admins`-group entry gate. (Built.)
- **P1 - Remove admin from chat.** Drop the admin import, the `?admin` branch, and the Header admin button from the chat app; drop the admin-only `VITE_*` vars from the chat env; add the import-graph assertion. This is the step that shrinks the public surface. (Built.)
- **P2 - Factor `@ae/shared`.** Extract shared types, chart primitives, the `apiCall` helper with the injectable token provider, and the credential-exchange client both apps use; de-duplicate the per-service fetch boilerplate. (Built.)
- **P3 - Dedicated admin Cognito app-client.** Provision the admin app-client with admin-origin callback and logout URLs (`enableAdminApp`; opt out with `-c adminAppClient=shared`). (Built.)
- **P4 - Docs and hardening.** Fold the standalone app into the BYO-console integration guide as the reference own-console; apply stricter admin-origin security headers or WAF; document the two-origin CORS and env model in the deploy guide. (Remaining.)
- **Cutover, not backward-compatibility.** Removing admin from the chat app (P1) is a one-way cutover; there is no bundled-into-chat mode. Anyone who reached the console via the chat origin moves to the admin origin. Deploying an admin UI at all is optional (a headless or host-owned-console deployment may skip it), but when present it is always the separate app.

## 8. Open technical questions

- **Option A (two Vite entries) versus Option B (workspace split).** The workspace split (B) is built; the open question is whether the admin app diverges enough to warrant its own dependency set and release cadence beyond the shared workspace.
- **Cognito callback URL management.** Reuse the shared app-client (add the admin origin to its callback list) versus the dedicated admin app-client (cleaner isolation, one more stack resource and redirect config).
- **The `GET /feedback` exception.** It shares the user-feedback authorizer rather than switching on `adminAuthMode`; confirm the admin app calls it with a user token and that its origin echo is correct under the split.
- **Non-Cognito admin federation.** Designed for via `adminAuthMode: federated`, but not validated end to end; treat as verify-before-relying.
- **Second distribution cost.** A second CloudFront distribution and bucket are a small fixed addition, provisioned only when an admin UI is deployed.

## Related

- [`SPEC-ADMIN-CONSOLE.md`](SPEC-ADMIN-CONSOLE.md) / [`DESIGN-ADMIN-CONSOLE.md`](DESIGN-ADMIN-CONSOLE.md) - the console the split serves.
- [`SPEC-ADMIN-IDENTITY.md`](../../interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md) - the admin identity and auth model this split does not change.
- [`DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md`](../../interaction/identity-access/admin/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md) - the per-capability IAM follow-up whose roles attach at the admin app-client.
- [`ADMIN-INTEGRATION-GUIDE.md`](../../../guides/admin/ADMIN-INTEGRATION-GUIDE.md) - the BYO-console path this app is the reference implementation of.
