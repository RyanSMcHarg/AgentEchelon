# Bringing Your Own Admin Console & Admin Auth

This guide explains how to run AgentEchelon's operator surface - analytics,
administration, evaluations, experiments - **behind your own application's admin
console and admin authentication**, instead of AgentEchelon's built-in Cognito
`admins` group and React dashboard.

It is the **operator-plane twin** of
[IDENTITY-PROVIDER-GUIDE.md](../user/IDENTITY-PROVIDER-GUIDE.md). That guide covers the
**user plane** (who can chat, at which tier). This one covers the **admin plane**
(who can see analytics and administer conversations). The two are independent - you can swap one,
both, or neither.

> **TL;DR.** AgentEchelon ships standalone with its own admin (a Cognito `admins`
> group + its own dashboard) because a self-contained deployment needs an
> operator out of the box. That is a **default, not a requirement.** If you embed
> AgentEchelon inside a product that already has admins, you point the admin APIs
> at your auth and consume them from your own console.

---

## The two planes (read this first)

A standalone AgentEchelon deployment owns both planes with Cognito:

| Plane | What it gates | Standalone default | Host-owned option |
|-------|---------------|--------------------|-------------------|
| **User** | Who can chat, at which tier | AE Cognito user pool + tier groups | Your IdP - [IDENTITY-PROVIDER-GUIDE.md](../user/IDENTITY-PROVIDER-GUIDE.md) |
| **Admin** | Who can see analytics / administer | AE Cognito `admins` group + AE dashboard | **This guide** |

The same principle from the IdP guide - *the access-control model is
identity-provider-agnostic* - applies here: **admin is a claim you choose, not
AgentEchelon's literal `admins` group.** Everything below is about (a) telling AE
which claim means "admin" and (b) deciding which front door the admin requests
come through.

---

## What "admin" actually controls in the backend

Every admin/analytics endpoint authenticates the same way today:

1. An **API Gateway Cognito authorizer** bound to AE's user pool validates the JWT.
2. The handler calls **`requireAdmin()`** (`backend/lambda/src/lib/auth.ts`),
   which checks the `cognito:groups` claim against the configured admin groups.

The authorizers that gate the operator plane:

| Surface | CDK authorizer location |
|---------|-------------------------|
| Analytics query (Athena) | `backend/lib/stacks/analytics-stack.ts` (`AnalyticsAuthorizer`) |
| Analytics query (Aurora) | `backend/lib/stacks/analytics-stack-aurora.ts` |
| User management | `backend/lib/stacks/cognito-auth-stack.ts` (`UserMgmtAuthorizer`) |
| Admin conversations / administration | `backend/lib/stacks/cognito-auth-stack.ts` (`AdminConversationAuthorizer`) |
| User feedback (admin GET summary) | `backend/lib/stacks/cognito-auth-stack.ts` |

To host-own the admin plane you change **two things**: the *claim* that
`requireAdmin()` trusts, and the *authorizer* (or front door) those endpoints sit
behind. Pick one of the two approaches below for the front door.

### Step 0 (both approaches): tell AE which claim means "admin"

The shared admin gate (`callerIsAdmin` / `requireAdmin` in
`backend/lambda/src/lib/auth.ts`) reads the admin group(s) from the
`ADMIN_GROUP_NAMES` env var (comma-separated), defaulting to `admins`. Set it
once with CDK context and it flows to every admin/analytics Lambda automatically
(via `adminAuthEnv()`):

```bash
cdk deploy --all -c adminAuthMode=federated -c hostAdminPoolId=us-east-1_XXXX \
  -c adminGroupNames=operators
```

All admin handlers route through this one gate, so the membership check is
IdP-neutral everywhere - no per-handler edits required.

---

## Approach 1 - Federate your admin pool

Point the admin/analytics API authorizers at **your** Cognito pool (or any OIDC
issuer an API Gateway authorizer can validate) instead of AE's user pool. Your
operators authenticate in your pool, get a token with an admin group/role claim,
and call AE's admin APIs directly. This mirrors the existing user-plane
federation that the `federatedUserPoolId` context already enables for chat.

```
  Operator signs in to YOUR admin pool / IdP
          │  (token carries an admin group claim, e.g. cognito:groups=["operators"])
          ▼
  AE admin/analytics API Gateway authorizer  ← points at YOUR pool
          │
          ▼
  requireAdmin() trusts ADMIN_GROUP_NAMES=operators  →  allowed
```

**What to change:**

1. **Step 0** - set `ADMIN_GROUP_NAMES` to your admin claim value.
2. **Authorizers** - swap each authorizer in the table above from
   `cognitoUserPools: [props.userPool]` to your pool, imported with
   `cognito.UserPool.fromUserPoolId(...)`. Gate this behind a new context flag so
   it stays config, not a fork (see [Configuration](#configuration-flag) below).
3. **Console** - consume the AE admin APIs from your own admin UI (see
   [Consuming the APIs](#consuming-the-apis-from-your-own-console)).

**Best when:** your operators already have accounts in a Cognito/OIDC pool and
you want them to call AE directly from a browser-based console.

**Trade-off:** the admin token travels to the AE API from the browser; the trust
boundary is your pool's issuer. If you want the AE admin surface to never accept a
browser token at all, use Approach 2.

---

## Approach 2 - Service-credential proxy (host owns auth entirely)

Your backend authenticates the operator in **your** admin pool, then calls AE's
admin/analytics endpoints **server-to-server** with a service credential
(SigV4/IAM, or a shared secret). AE trusts the *service principal*, not a user
token. Your app owns 100% of admin auth; AE becomes pure backend infrastructure
and its own admin pool can be removed.

```
  Operator signs in to YOUR admin pool  →  YOUR admin API (your authorizer)
          │  your backend enforces "is this operator an admin?"
          ▼
  YOUR backend proxies to AE admin/analytics endpoint
          │  signed with a service credential (IAM SigV4 / shared secret)
          ▼
  AE endpoint trusts the service principal  →  returns analytics / performs conversation administration
```

**What to change:**

1. **Step 0** - still set `ADMIN_GROUP_NAMES` (the proxy can forward a synthetic
   admin claim, or AE can switch the admin endpoints to an IAM authorizer so no
   group claim is needed at all).
2. **Front door** - change the admin/analytics authorizers from a Cognito
   authorizer to an **IAM authorizer** (`AuthorizationType.IAM`) or a shared-secret
   Lambda authorizer, so only your signed service calls are accepted.
3. **Proxy** - add routes to your own admin API that forward to the AE endpoints
   (list in [API Endpoints](../../README.md#api-endpoints)) with the service credential,
   after your handler has verified the caller is an admin in your pool.

**Best when:** you want a single trust boundary (your app), strict isolation
(e.g. a separate admin Cognito pool that never touches AE), or you intend to
remove AE's own user/admin pool entirely.

**Trade-off:** more backend code (the proxy layer), but the cleanest separation - 
this is the recommended path when "AE = infrastructure, my app = identity."

---

## Admin identity is already portable

Whichever approach you choose, **admin actions don't depend on which pool
authenticated the operator.** Redact / delete / add-member run as the operator's
own `${sub}-admin` app-instance-admin identity, vended per action via the
credential-exchange admin plane (the dedicated **service** app-instance-admin is
used only for no-human automation, e.g. membership-audit auto-revoke), and are
audit-logged to CloudWatch (`_auditEvent: admin_redact | admin_delete |
admin_add_member | …`). So you keep the full admin audit trail no matter who owns
admin auth - the operator's admin claim resolves to an AE-side `${sub}-admin`, so
you are only changing *who is allowed to ask*, not the AE app-instance identity the
action runs as.

---

## What moves to the host (and what stays)

When your app owns admin auth, some AE features become redundant - they manage
*AE's own* user lifecycle, which you no longer use:

| Feature | Standalone | Host-owned |
|---------|-----------|------------|
| Analytics, evaluations, latency, experiments | AE | **Stays in AE** (consume via API) |
| Conversation moderation (redact/delete/members) | AE | **Stays in AE** (runs as app-instance-admin) |
| `scripts/create-admin-user.sh` | Bootstraps first admin | **Skip** - your app provisions admins |
| "Manage Users" tab / user-management API (approve, tier, enable) | AE | **Disable / ignore** - your app owns user lifecycle |

If you've also moved the **user** plane to your IdP (per the IdP guide) and
removed AE's user pool, the user-management API has no pool to act on - disable
those routes or leave them unused.

---

## Consuming the APIs from your own console

AgentEchelon's dashboard tabs are plain React + custom SVG charts (no charting
dependency) that fetch JSON from the analytics/admin endpoints with a bearer
token. There are two ways to reuse them:

- **Port the tabs.** Copy `frontend/packages/admin/src/components/admin/*` into your app and make
  two things injectable: the **API base URL** (today `VITE_*_API_URL`) and the
  **token/credential provider** (today `localStorage.idToken`). Point them at your
  proxy (Approach 2) or directly at AE (Approach 1). The chart/table primitives
  (`DataTable`, `LineChart`, `Sparkline`, `FunnelChart`, `MetricCard`) are
  dependency-free and port as-is.
- **Build your own UI** against the documented endpoints
  ([API Endpoints](../../README.md#api-endpoints)). The analytics responses are stable
  JSON; you only need the query endpoints and a token/credential.

Either way the contract is the same: **a base URL + a way to authorize the call.**
Keep both configurable and the console is portable across both approaches.

---

## Configuration flag

The front-door choice is a CDK context flag, alongside the existing
`federatedUserPoolId` user-plane federation flag:

```jsonc
// cdk.context.json (or -c on the CLI)
{
  "adminAuthMode": "federated",       // "ae-cognito" (default) | "federated" | "service"
  "hostAdminPoolId": "us-east-1_XXXX", // federated: the pool the authorizers trust
  "adminGroupNames": "operators"       // the cognito:groups value that denotes admin
  // service mode uses an IAM authorizer instead of a pool id — grant your proxy
  // role execute-api:Invoke on the admin/analytics APIs.
}
```

The `adminApiMethodOptions()` helper (`backend/lib/constructs/admin-auth-mode.ts`)
reads `adminAuthMode` and attaches the right authorizer; `adminAuthEnv()` stamps
`ADMIN_AUTH_MODE` (+ `ADMIN_GROUP_NAMES`) onto each admin Lambda so the handler
honors the same mode. `ae-cognito` reproduces the standalone authorizers exactly,
so it is the default.

> **Fine-grained IAM (`adminIamEnforcement`).** Where `service` mode puts the
> *whole* admin API behind one IAM authorizer, `-c adminIamEnforcement=true`
> generalizes that to **per resource**: each privileged action is its own
> `AWS_IAM`-authorized API resource, and a sign-on group role (or the opt-in
> example personas, `-c enableAdminPersonas=true`) carries `execute-api:Invoke`
> for exactly the capabilities it holds, so a role can be denied a *specific*
> action at the gateway. The admin console SigV4-signs those calls with its
> sign-on creds (customer message content is exchange-vended, short-lived +
> audited). Off by default; see `SPEC-ADMIN-ACTION-IAM-ENFORCEMENT.md`. Set
> `VITE_ADMIN_IAM_ENFORCEMENT=true` on the admin app to match.

> **Coverage.** `adminAuthMode` is wired into the **Analytics**
> (Athena + Aurora), **User Management**, **Admin Conversations**, and
> **Experiments** APIs, and the admin handlers share one `callerIsAdmin` gate
> (`lib/auth.ts`) that honors `ADMIN_GROUP_NAMES` + service mode. Covered by
> `backend/test/lib/auth-admin-mode.test.ts`.
>
> **One exception - admin feedback summary.** `GET /feedback` (admin summary)
> shares an API/authorizer with the user-facing `POST /feedback`, so it is *not*
> switched by `adminAuthMode` (doing so would break user feedback submission). In
> a host-owned deployment, surface feedback via the Aurora model-effectiveness
> analytics instead, or proxy `GET /feedback` separately.
>
> Run `npm run build` before `cdk deploy` so the recompiled Lambda picks up the
> shared gate (build-before-deploy convention).

---

## Related documentation

- [IDENTITY-PROVIDER-GUIDE.md](../user/IDENTITY-PROVIDER-GUIDE.md) - the user-plane twin
  of this guide (swap who can chat / at which tier).
- [SPEC-ADMIN-CONSOLE.md](../../specs/admin-console/SPEC-ADMIN-CONSOLE.md) - the admin console design.
- [SPEC-MODERATION.md](../../specs/identity-access/SPEC-MODERATION.md) - the full moderation model and its
  surfaces.
- [ADMIN-GUIDE.md](ADMIN-GUIDE.md) - how an operator uses the dashboard.
- [SPEC-FEDERATED-PARTICIPANTS.md](../../design/SPEC-FEDERATED-PARTICIPANTS.md) - the
  user-plane federation primitives this guide's Approach 1 mirrors.
</content>
</invoke>
