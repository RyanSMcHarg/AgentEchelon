# Identity & Access - anyone participates at the right capability, only as themselves

**Status:** Implemented. The **Identity & Access** pillar of the interaction layer (`docs/specs/conversation-messaging/SPEC-INTERACTION-LAYER.md` is the map), built as a backend **Credential Exchange Service** (see §9).

**Related:** `docs/specs/conversation-messaging/SPEC-INTERACTION-LAYER.md` (the model) · `docs/specs/conversation-messaging/SPEC-CONVERSATION-TYPES.md` (sets the `classification` this enforces) · `docs/design/SPEC-FEDERATED-PARTICIPANTS.md` (external humans) · `docs/guides/user/IDENTITY-PROVIDER-GUIDE.md` (deployer guide - Approach 2 is this) · `docs/specs/identity-access/SPEC-CONVERSATION-SECURITY.md` (the channel-join boundary) · AWS blog *"Integrate your Identity Provider with Amazon Chime SDK Messaging"* (June 2021) - the public token-vending pattern.

---

## 1. Why

For an interaction layer to be safe and open at the same time, every actor - a tiered user, an external person routed in from a connector, a guest, the assistant itself - must participate **at exactly the capability they should, and only as themselves.** Because AgentEchelon is built on AWS-native services (Amazon Chime SDK + Cognito + STS), it can make that an **IAM decision, not application logic**: a backend exchange vends short-lived AWS credentials **scoped by IAM** to the caller's own identity at the caller's capped classification. Identity becomes infrastructure-enforced, evaluated before any request is processed.

## 2. Who benefits

- **The business** plugs in any identity provider (its SSO, a service login, or the built-in Cognito) and gets a uniform, capped, audited access model without writing access logic per integration.
- **Every participant** is provably acting *as themselves* - they cannot impersonate another identity or exceed their classification, regardless of a client bug or a routing mistake.
- **Operators** get one credential chokepoint to reason about (and to revoke at), instead of access scattered across the frontend and the IdP.

## 3. Experiences enabled

- **Tiered users** sign in and act within their classification (and below), bearer-bound to their own identity.
- **Federated externals** (a routed support agent, an on-call engineer) join from the business's IdP, capped to the conversation's classification, scoped to the one conversation they're invited to (`SPEC-FEDERATED-PARTICIPANTS.md`).
- **Guests** get a deliberately minimal, single-conversation access level.
- **The assistant** acts as its own identity (never as a user) - see §7.

## 4. The model - a backend credential exchange

The frontend (or a connector, for externals) presents an identity token to `POST /exchange-credentials`. The Lambda:
1. **validates the token** (Cognito authorizer for native users; external-IdP verification for federated),
2. derives `sub` + classification from the **validated claims** (never the request body - IDOR guard),
3. ensures the caller's `AppInstanceUser` exists (idempotent),
4. `sts:AssumeRole`s the matching capped role **with a `sub` session tag**, and
5. returns short-lived credentials + the caller's own `userArn`.

The assumed role then **pins the bearer** to the caller's own identity in IAM:

```ts
// the role's channel-action grant, bearer scoped to the session's own AppInstanceUser:
resources: [ `${appInstanceArn}/user/${'${aws:PrincipalTag/sub}'}` ]   // not …/user/*
```

So the credentials are capped two ways at once: the **classification** (which role) and the **bearer** (which AppInstanceUser ARN). The role's trust policy permits the exchange to `sts:AssumeRole` + `sts:TagSession` and requires the `sub` tag, so a role can never be assumed un-pinned.

## 5. The restriction spectrum (access is a ladder, not one policy)

Every rung is bearer-pinned; the action set and channel scope grow with trust:

| Rung | Who | Channel scope | Actions (all bearer-pinned, beyond session connect) |
|---|---|---|---|
| **restricted / guest** | federated externals, unauth widget visitor | **only channels they're a member of** (no discovery) | Send/Get/List messages, DescribeChannel, ListChannelMemberships(ForUser), UpdateChannelReadMarker |
| **basic / standard / premium** | tiered users | classification ≤ tier (the IAM tag-gate) | the above + leave (`DeleteChannelMembership` own) + own-profile read/update |
| **admin** | admins | cross-tier channel actions, still **bearer-pinned to own** identity | the above |

**Never on any end-user rung** (backend operations, not user credentials): `CreateChannel`, `CreateChannelMembership`, `CreateAppInstanceUser`, `UpdateChannelMessage`, `RedactChannelMessage`, `UpdateChannel`, `DeleteChannel` - channel creation / member admission / administration flow through the create-conversation, share, and admin paths (their own roles). The exchange selects the rung by the caller's **lifecycle state** (§6), not just their group.

## 6. Full user lifecycle (create → promote → role-change → offboard)

The **same `AppInstanceUser` (`= sub`) persists**; what changes is the rung the exchange hands out and the memberships. Each transition has a definite owner:

| Transition | Owner / trigger | Effect |
|---|---|---|
| **Create** (native / federated) | sign-up trigger / first SSO / connector resolve | AppInstanceUser created (idempotent) + group set; federated → admitted to the routed channel only at a capped classification |
| **Promote** (guest → authenticated) | admin approve / sign-in | higher rung on next vend; same AppInstanceUser |
| **Role change** (tier ↑/↓) | admin sets the authoritative group | **new rung on the next exchange** (it reads the live group); in-flight creds carry the old rung until they expire (≤ session TTL). **Immediate downgrade** = disable the user and/or remove memberships - don't rely on creds expiring |
| **Offboard** | admin delete | see §6a |

### 6a. Offboard mode - hard-delete vs deactivate
Two ways to offboard; the right one is **conversation/user-type dependent**:
- **Hard delete** - `DeleteAppInstanceUser` + delete the auth user + remove memberships. The ARN stops resolving, so historical messages must render a **placeholder** ("Former member"), never blank. Fits external-customer/engagement cases where surfacing that someone left is undesirable.
- **Deactivate** - keep the `AppInstanceUser`, rename it to a placeholder + flag it deactivated, remove memberships, delete the auth user. Historical messages still attribute to a named (deactivated) author. Fits internal-collaboration (support/service/triage) where "who said what" must survive offboarding.

**Requirement either mode:** the name resolver needs a deleted/unknown-sender fallback (no blank authors). Ship an OSS **default** (hard-delete + "Former member"), **overridable per conversation type / user type** via `offboardMode`. The default is hard-delete; deactivate is the overridable alternative.

## 7. How it composes with the other pillars

- **← Conversation Configuration** sets the `classification` this layer enforces; effective capability = **rung ∧ conversation-type policy**.
- **The assistant is also an identity** - it acts as its own per-tier assistant identity (bearing an assistant identity, never a user), classification-gated like everyone else, with its behavior defined by Assistant Configuration. So the assistant lives in two pillars (Identity + Assistant Config).
- **Connectors** that resolve external humans hand the exchange a verified external identity → it issues a capped, bearer-pinned credential (`SPEC-FEDERATED-PARTICIPANTS.md`).

## 8. Security invariants

- **Bearer-pinned** - an actor can only ever act as itself (`…/user/${aws:PrincipalTag/sub}`), enforced by IAM.
- **IDOR-safe** - identity comes only from validated token claims, never the request body.
- **Per-tenant credential isolation** for connector-resolved externals (`SPEC-CONVERSATION-TYPES.md` §6).
- **Tier gating is keyed on the global `aws:ResourceTag/classification`** in a fail-closed **Allow** - Amazon Chime SDK exposes no service-specific condition keys, so a `chime:ResourceTag/...` condition would be a silent no-op. The Amazon Chime SDK calls use the `chime-sdk-identity` / `chime-sdk-messaging` SDK namespaces (see `IDENTITY-PROVIDER-GUIDE.md` for the IdP-integration sample, and §4 here for the bearer pin).

## 9. Implementation

**The exchange is the sole source of Amazon Chime SDK credentials.** There is no Identity-Pool fallback.
- **Exchange:** the Lambda + API + the bearer-pinned role spectrum + full-lifecycle delete (incl. membership cleanup) are in `AgentEchelonCognitoAuth`.
- **Bearer pin:** `backend/scripts/deny-test-credential-exchange.mjs` provisions a real `classification=basic` channel and demonstrates that a basic user's exchange creds can send bearing their **own** ARN but are **AccessDenied** bearing the **premium** user's ARN - only the bearer differs, so the pin (not the tag-gate) is what enforces it.
- **API contract:** `tests/e2e/credential-exchange.spec.ts` covers it (no-auth → 401; authed → own-ARN creds + tier; body-supplied sub/tier ignored - IDOR-safe).
- **Assistant pin:** the per-tier `ProcessorRole`/`AgentHandlerRole` bearer is `/bot/*` only (no `/user/*`).
- **Frontend:** `VITE_CREDENTIAL_EXCHANGE_API_URL` is **REQUIRED**; the authenticated Identity-Pool roles carry no Amazon Chime SDK grant (they remain bare principals so the pool still resolves). The Playwright signin + agents suites run against the frontend with no Identity-Pool fallback - the round-trip (sign-in → exchange → Amazon Chime SDK WebSocket → send → agent reply) runs entirely on bearer-pinned exchange creds.

## 10. Design note: the bearer pin is tag-coupled
The bearer pin resolves `…/user/${aws:PrincipalTag/sub}` from a session tag the exchange sets on `AssumeRole`. `${aws:PrincipalTag/sub}` only resolves for a credential the exchange itself vended (it is the thing that sets the tag), so a credential from any other source cannot satisfy the pin - which is why the exchange is the sole Amazon Chime SDK credential source, with no fallback.
