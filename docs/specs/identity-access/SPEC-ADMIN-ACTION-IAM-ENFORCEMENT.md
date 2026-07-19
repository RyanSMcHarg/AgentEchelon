# Making admin-console actions IAM-enforceable

**Status:** Proposed (design). Not yet built. An interim Cognito-group gate ships today
(`callerCanReadArchive`); this spec replaces it with an IAM-enforceable capability set, driven by
the persona/data matrix in section 3.

**Related:** [`SPEC-ADMIN-IDENTITY.md`](SPEC-ADMIN-IDENTITY.md) (admin identity + capability table),
[`SPEC-MODERATION.md`](SPEC-MODERATION.md) (moderation surfaces),
[`IDENTITY-AND-ACCESS-MODEL.md`](IDENTITY-AND-ACCESS-MODEL.md) (one pool, the credential exchange is
the only path to Chime), [`ACCESS-CONTROL-BY-EXAMPLE.md`](ACCESS-CONTROL-BY-EXAMPLE.md)
(classification-capped access), [`SPEC-ACCESS-AND-CONTROLS-AUDITING.md`](SPEC-ACCESS-AND-CONTROLS-AUDITING.md)
(who could act), [`../analytics-eval/SPEC-AURORA-VPC-MODE.md`](../analytics-eval/SPEC-AURORA-VPC-MODE.md)
and [`../../guides/admin/AURORA-MODE-GUIDE.md`](../../guides/admin/AURORA-MODE-GUIDE.md) (Aurora vs
Athena data sources), [`../../guides/admin/ADMIN-INTEGRATION-GUIDE.md`](../../guides/admin/ADMIN-INTEGRATION-GUIDE.md).

## 1. Purpose

Every privileged admin-console action should be enforceable through IAM, so a deployer can build
finer roles where a **specific** action or **specific data** is denied by an IAM policy rather than
by an application group check. The Chime plane is already IAM-enforced; the archive and analytics
plane is not. This spec closes that gap, and grounds the boundaries in real personas.

## 2. Personas

- **Platform admin.** Platform operator and security owner. The break-glass, full-access level.
- **Platform developer.** Builds and debugs AgentEchelon itself. Needs technical telemetry and the
  raw event structure; does not need customer message bodies by default (scoped, opt-in, audited).
- **AI developer.** Builds and tunes the assistants. Needs quality signals (intent, evaluations,
  tools, model, drift, ground truth) and prompt/reply pairs, scoped to the assistants and tiers they own.
- **Manager.** Monitors the use case: interactions between their team and customers. Needs the
  conversation content and the redact (moderation-level) capability for their scope, and none of the
  platform internals or config.

> **Implementer note - these are a starting point, not a prescription.** The four personas above, the
> capabilities each holds (section 4), and the `Scoped` boundaries are all **deployment choices**.
> Deployers should **review them and define their own roles** for their organization; nothing here
> ships enabled as a default.
>
> **Scope can and should be tightened further, in many places.** IAM capability gating is one layer,
> not the whole story. Beyond it, restrict access by: exposing only **purpose-built, minimal views**
> (for example a redacted or aggregate view rather than raw message content) so a role sees only what
> it needs; requiring **peer approval and a recorded request, based on demonstrated need**, before
> sensitive access is granted (the just-in-time, requested-recorded-temporary model in
> [`SPEC-ADMIN-IDENTITY.md`](SPEC-ADMIN-IDENTITY.md) section 10, plus the archive proof-of-need decrypt
> gate); **time-boxing** and auto-expiring elevated access; and **separating duties** so the role that
> grants access is not the role that uses it. Treat this matrix as the ceiling to narrow, not the
> access to hand out.

## 3. Data-access matrix (this drives the design)

Two planes. **Source** is where the data lives (some archive data is in **both** Aurora and Athena;
some is an Aurora-only enhancement, inert in Athena mode; some is Chime live, DynamoDB, or config;
Aurora is a strict superset of Athena, so nothing is Athena-only). **IAM action** is what grants
access: `chime:*` for the Chime plane (already enforced), the target `execute-api:Invoke` resource
for the archive/analytics plane (this spec). **Access** per persona: `Full`, `Scoped` (limited to the
persona's tier / assistants / use-case channels, and/or read-only), or `None`.

### 3a. Chime live plane (already IAM-enforceable)

The credential exchange vends these as `chime:*` session policies (`credential-exchange.ts`
`CAPABILITY_ACTIONS`), so a plane role whose policy omits the action is denied. This is the model
section 6 extends.

| ID | Data / action | Source | IAM action(s) | Sens. | Plat admin | Plat dev | AI dev | Mgr |
|---|---|---|---|---|---|---|---|---|
| C1 | Live channel messages (current, non-deleted) | Chime | `chime:GetChannelMessage`, `chime:ListChannelMessages` | High | Full | Scoped | Scoped | Scoped |
| C2 | Channel description (name, mode, privacy) | Chime | `chime:DescribeChannel` | Low | Full | Full | Scoped | Scoped |
| C3 | Live memberships (current members) | Chime | `chime:ListChannelMemberships` | Low-Med | Full | Full | Scoped | Scoped |
| C4 | Channel moderators | Chime | `chime:ListChannelModerators` | Low | Full | Full | Scoped | Scoped |
| C5 | Redact a message | Chime | `chime:RedactChannelMessage` | High | Full | None | None | Scoped |
| C6 | Delete a message (app-instance-admin only) | Chime | `chime:DeleteChannelMessage` | High | Full | None | None | None |
| C7 | Add / remove members, grant moderator | Chime | `chime:CreateChannelMembership`, `chime:DeleteChannelMembership`, `chime:CreateChannelModerator` | High | Full | None | None | None |
| C8 | Update / delete a channel | Chime | `chime:UpdateChannel`, `chime:DeleteChannel` | High | Full | None | None | None |

The `view` capability also grants `chime:ListChannelMembershipsForAppInstanceUser` (the caller's own
conversation-list discovery), which is out of scope for this admin-channel table.

### 3b. Archive and analytics plane (IAM enforcement proposed here)

Today group-gated (`callerIsAdmin` / `callerCanReadArchive`), NOT IAM. The IAM-action column is the
target `execute-api:Invoke` resource (section 6); wiring it is the work this spec proposes.

| ID | Data | Source | Target IAM action | Sens. | Plat admin | Plat dev | AI dev | Mgr |
|---|---|---|---|---|---|---|---|---|
| A1 | Conversation list (channels, tiers, counts) | Aurora + Athena | `execute-api` `POST /admin/conversations` | Low | Full | Full | Scoped | Scoped |
| A2 | Message content, full history incl. redacted/deleted (PII) | Aurora + Athena | `execute-api` `GET /admin/messages` | High | Full | Scoped | Scoped | Scoped |
| A3 | Complete raw event log (all event types) | Aurora + Athena | `execute-api` `POST /admin/events` | Med | Full | Full | Scoped | None |
| A4 | Membership history (joins / leaves / moderator grants) | Aurora + Athena | `execute-api` `GET /admin/membership-history` | Low-Med | Full | Full | Scoped | Scoped |
| A5 | Moderation-action audit (who redacted / deleted, when) | Aurora (`moderation_actions`); events also in Athena archive | `execute-api` `POST /admin/moderation-audit` | Med | Full | Scoped | None | Scoped |
| A6 | Intent classification + distribution | Aurora + Athena | `execute-api` `POST /admin/quality` | Low | Full | Full | Full | None |
| A7 | Evaluations (Pass A relevance, Pass B flow scores) | Aurora only | `execute-api` `POST /admin/quality` | Low | Full | Scoped | Full | None |
| A8 | Tool usage / execution steps (ConverseStep tools) | Aurora only | `execute-api` `POST /admin/quality` | Low-Med | Full | Full | Full | None |
| A9 | Model attribution / cost / latency | Aurora + Athena | `execute-api` `POST /admin/analytics` | Low | Full | Full | Full | None |
| A10 | Drift events (topic drift, embeddings) | Aurora only (pgvector) | `execute-api` `POST /admin/quality` | Low | Full | Full | Full | None |
| A11 | Experiments (A/B results) | DynamoDB + Aurora | `execute-api` `POST /admin/analytics` | Low | Full | Scoped | Full | None |
| A12 | Feedback (thumbs) | DynamoDB + Aurora | `execute-api` `POST /admin/analytics` | Low | Full | Scoped | Full | None |
| A13 | User activity / signup + signin funnels (identities) | Aurora + Athena | `execute-api` `POST /admin/user-activity` | Med (PII) | Full | Scoped | None | None |
| A14 | Flagged responses / ground truth | Aurora only | `execute-api` `POST /admin/quality` | Low | Full | Scoped | Full | None |
| A15 | Task tracking / flows (task_state, intent_flows) | Aurora only | `execute-api` `POST /admin/quality` | Low | Full | Full | Full | None |
| A16 | Configuration (profiles, classifications, connectors, tiers) | Deploy config / SSM | `execute-api` `POST /admin/config` | High | Full | Read | Scoped | None |
| A17 | Security / access audit (who could act) | Logs + Aurora | `execute-api` `POST /admin/security` | High | Full | Scoped | None | None |
| A18 | Infra health (RDS, cost, sleep mode) | CloudWatch / CDK | native IAM (`cloudwatch:*`) | Med | Full | Full | None | None |

Notes:
- **Aurora-only** rows (A7, A8, A10, A14, A15) have no data in Athena mode; the console shows a
  "requires Aurora" notice. The capability still exists; only the data differs by mode. A5's
  queryable `moderation_actions` view is Aurora-only, though the redact/delete events themselves also
  flow to the Athena archive (the moderation tap, `SPEC-ACCESS-AND-CONTROLS-AUDITING.md`).
- **C1 vs A2.** Chime C1 is the live channel (current, non-deleted) and is already IAM-enforced. A2
  is the archive: the full history including redacted/deleted, the sensitivity pivot, and the surface
  this spec makes IAM-enforceable.
- **Scoped** reuses the platform's existing axes: channel `classification` tag (tier), assistant /
  profile ownership, channel membership. It is not a new mechanism (`ACCESS-CONTROL-BY-EXAMPLE.md`).

## 4. Capabilities derived from the matrix

Each persona is a set of capabilities. `view`, `redact`, `delete`, `manage-membership`,
`manage-channel` are the **existing** Chime capability keys (`credential-exchange.ts`
`CAPABILITY_ACTIONS`); the rest are new (`execute-api`, section 6). **A capability grants a persona
only if the matrix grants that persona every row in the capability** (the safe intersection: bundling
never loosens a per-row denial). Where that intersection is coarser than a persona deserves, split
the capability finer (section 12.1); this is why the PII row A13 is its own capability rather than
bundled into analytics.

| Capability | Rows | Enforcement | Plat admin | Plat dev | AI dev | Mgr |
|---|---|---|---|---|---|---|
| `view` (live channel) | C1-C4 | `chime:*` (existing key) | Full | Scoped | Scoped | Scoped |
| `redact` | C5 | `chime:RedactChannelMessage` (existing) | Full | None | None | Scoped |
| `delete` | C6 | `chime:DeleteChannelMessage` (existing) | Full | None | None | None |
| `manage-membership` | C7 | `chime:*` (existing) | Full | None | None | None |
| `manage-channel` | C8 | `chime:*` (existing) | Full | None | None | None |
| `view-conversations` | A1, A4 | `execute-api` (new) | Full | Full | Scoped | Scoped |
| `view-messages` | A2 | exchange vend (new) | Full | Scoped | Scoped | Scoped |
| `view-events` | A3 | `execute-api` (new) | Full | Full | Scoped | None |
| `view-moderation-audit` | A5 | `execute-api` (new) | Full | Scoped | None | Scoped |
| `view-quality` | A6-A8, A10, A14, A15 | `execute-api` (new) | Full | Scoped | Full | None |
| `view-analytics` | A9, A11, A12 | `execute-api` (new) | Full | Scoped | Full | None |
| `view-user-activity` (PII) | A13 | `execute-api` (new) | Full | Scoped | None | None |
| `view-config` / `manage-config` | A16 | `execute-api` (new) | Full | Read | Scoped | None |
| `view-security` | A17, A18 | `execute-api` / native (new) | Full | Scoped | None | None |

**Enforcement path (section 6).** `view-messages` (A2) and the Chime capabilities (`view`, `redact`,
`delete`, `manage-membership`, `manage-channel`) are vended per use by the credential exchange
(short-lived, audited). Every other capability here is granted on the persona's **sign-on group
role**.

## 5. What is and is not IAM-enforced today

- **IAM-enforced (3a).** The credential exchange maps each Chime capability to `chime:*` actions and
  vends a session policy scoped to exactly those, intersected with the plane role ceiling. A role
  whose policy omits `chime:RedactChannelMessage` cannot redact.
- **NOT IAM-enforced (3b).** The archive and analytics reads and the moderation-audit write are
  Cognito-JWT authorized with an application group check (`callerIsAdmin`, and the interim
  `callerCanReadArchive`). Any admin holds all of them.
- **Precedent.** `adminAuthMode=service` already runs the admin and analytics API behind an IAM
  authorizer; `isServiceAdminCall` / `serviceAdminClaims` derive the actor from the signed principal.

## 6. Enforcement mechanism (bringing 3b up to 3a)

Reuse the sign-on role mapping AE already has. The Identity Pool maps each Cognito group to an IAM
role at sign-on (`IdentityPoolRoleAttachment` `roleMappings`, so the ID token carries
`cognito:preferred_role`) and vends signed credentials for it. The `AdminAuthenticatedRole` is
**empty today** (Chime goes through the exchange; the archive/analytics APIs are JWT-authorized, so
the role grants nothing). The design gives that structure teeth:

1. **Per-persona group roles.** Give each admin persona (section 2) its own group and IAM role via
   the existing role mapping. The role's policy carries the `execute-api:Invoke` statements for
   exactly that persona's capabilities (section 4). **The grant is assigned at sign-on**, so a
   member's signed Identity-Pool credentials already encode their access.
2. **IAM-authorize the archive/analytics endpoints, per resource** (the 3b IAM-action column),
   generalizing service mode from all-or-nothing to per-resource.
3. **Sign the request.** The console SigV4-signs archive/analytics calls with the sign-on
   credentials; API Gateway allows or denies per the group role's policy; the Lambda derives the
   actor from the principal.
4. **Scope** (the `Scoped` cells): the role uses IAM conditions on the caller's claims passed as
   session/principal tags (tier, ownership), the same per-classification structure the tier roles
   already use; the read also filters on the verified identity.
5. **The cut line (drawn).** The sign-on group role carries every archive/analytics read **except
   customer message content (A2)**. **A2 and the Chime plane (C1-C8)** use the credential exchange's
   short-lived, per-use, **audited** vend. So a standing role never holds customer PII or a mutation,
   and every content read (once A2 is on the exchange) and every moderation emits an
   `admin_scoped_credential_vend` log line (section 11). The
   rationale: message content is the only high-sensitivity PII read, and per-conversation auditing of
   "who read this customer's messages" is worth the round-trip; everything else is metadata,
   structure, or aggregate. Revisitable (section 12.6).
6. **Result.** A group whose role omits a capability's resource is denied at the gateway, decided by
   IAM at sign-on, with no per-read exchange round-trip.

## 7. Example roles map straight to the personas

Each persona (section 2) is its matrix column expressed as a capability set (section 4). `moderator`
is a useful extra role (`view-live` + `view-messages` + `moderate`, no config). Denying `view-events`
to a role is a single `execute-api` statement omitted from its policy.

## 8. Concrete updates

- **Credential exchange** (`credential-exchange.ts`, CognitoAuth stack): add the 3b capabilities;
  vend `execute-api:Invoke` session policies; entitlement + scope conditions; extend
  `admin_scoped_credential_vend`.
- **API Gateway** (`analytics-stack-aurora.ts`, `cognito-auth-stack.ts`): split the analytics and
  admin-conversations APIs into the per-capability resources in 3b; `AWS_IAM` authorizer on each.
- **Handlers** (`analytics-query.ts`, `admin-conversations.ts`, data-plane): accept IAM-signed calls,
  derive the actor, apply the scope condition, stop treating the app group check as the sole control
  (keep `callerCanReadArchive` only as the `ae-cognito` fallback).
- **Frontend** (`services/`): an admin API client that vends the capability credential and SigV4-signs
  archive/analytics calls, mirroring `chimeService`.
- **Roles and policies** (CDK): the persona role definitions and per-capability IAM policies, wired to
  the `adminAuthMode` helper.
- **Docs:** `SPEC-ADMIN-IDENTITY.md` (fold sections 2-4 into the capability-ceiling table, and update
  the "gated by `requireAdmin`" and "not yet shipped" notes to point here); `SPEC-ACCESS-AND-CONTROLS-AUDITING.md`
  (the archive-capability extension of the vend log line); `AURORA-MODE-GUIDE.md` (the Aurora/Athena
  source split, and fix the migrations table which stops at `011` though `012-moderation-actions.sql`
  ships); `ADMIN-INTEGRATION-GUIDE.md` (the per-resource IAM authorizer generalizing service mode).

## 9. The `ae-cognito`-mode question (decision needed)

Default `ae-cognito` mode authenticates with a Cognito JWT; per-request IAM needs the frontend to
present a vended, SigV4-signed credential. Either (a, recommended) adopt the exchange-vended
`execute-api` credentials for archive calls in all modes; or (b) keep the group gate as the ceiling
in `ae-cognito` mode and require the IAM plane only in `service` / `federated` modes.

## 10. Migration and phasing

- **P0.** This matrix + capability catalog; IAM authorizer on `POST /admin/events`; exchange vend for
  `view-events`; frontend signing for the event view (plan item A13). Proves the pattern.
- **P1.** `view-conversations` + `view-messages` with the scope condition.
- **P2.** `view-quality` + `view-analytics` + the persona roles and IAM policies; docs.
- **P3.** Retire the interim `callerCanReadArchive` group gate (or demote to the `ae-cognito` fallback).

## 11. Audit tie-in

Today the credential exchange emits a CloudWatch **structured log line** (`admin_scoped_credential_vend`,
`console.log(JSON.stringify(...))` in `credential-exchange.ts`) on every admin-plane **Chime** vend,
queryable via Logs Insights (it is a log line, not a database table, and it is emitted only for the
Chime plane, not for any archive read today). This spec extends that emission to the archive-capability
vends (message content A2 and any other surface on the exchange path), so "who could read a customer
conversation" becomes auditable next to "who could moderate", with the same short-lived, attributable
record (`SPEC-ACCESS-AND-CONTROLS-AUDITING.md`).

## 12. Open decisions

1. Capability granularity (the section 4 split, or coarser).
2. The `ae-cognito` adoption question (section 9).
3. Whether the `Scoped` conditions for AI developer (by assistant) and manager (by use case) reuse
   the classification tag alone or need a new ownership tag.
4. Whether the moderation-audit write is its own capability or rides on `moderate`.
5. Interaction with plan item D (a separate admin app), whose distribution is a natural place to
   require these capabilities per persona.
6. **Sign-on group role vs on-demand exchange vend.** RESOLVED (section 6.5): the sign-on role
   carries every archive/analytics read except customer message content (A2); A2 and the Chime plane
   use the per-use audited vend. Open only to revisit if the per-conversation vend for A2 proves too
   chatty in practice (fallback: A2 on the role with a per-read audit-log write instead of a vend).
