# DESIGN: Admin-Action IAM Enforcement

**Status:** Built, flag-gated (opt-in), deployed and validated on the on-flag path. **Layer:** Interaction **Pillar:** Identity & Access **Plane:** admin **Product spec:** [`SPEC-ADMIN-IDENTITY.md`](SPEC-ADMIN-IDENTITY.md) (the capability model, personas, and fail-closed requirement this implements). **Summary:** Every privileged archive/analytics admin action is expressed as a named capability mapped to a specific API Gateway resource, so a deployer's IAM role can be denied a specific action or specific data at the gateway rather than only by an application group check.

The Amazon Chime SDK plane is already IAM-enforced (the credential exchange vends `chime:*` session policies scoped to exactly the requested capability). The archive and analytics plane was group-gated only. This design brings that plane up to the same enforceability and grounds the boundaries in the personas of the product spec (FR-3, capability-level denial).

Enablement: `-c adminIamEnforcement=true` (backend) plus `VITE_ADMIN_IAM_ENFORCEMENT=true` (admin app) turns it on; the four example persona roles are opt-in behind `-c enableAdminPersonas=true`. With the flag off, the interim Cognito-group gate is the control, unchanged.

## 1. Architecture

The design reuses machinery the platform already has rather than adding a new authorization service.

- **The capability catalog** (`backend/lib/config/admin-capabilities.ts`) is the single source of truth mapping each capability to the API Gateway resource(s) it authorizes, its enforcement plane, and the personas that hold it. The CDK builds IAM role policies and per-resource authorizers from this list; the credential exchange vends against the same keys. It is the `execute-api` analog of the Amazon Chime SDK Messaging plane's `CAPABILITY_ACTIONS` (`credential-exchange.ts`).
- **The handler gates** (`backend/lambda/src/lib/auth.ts`) decide, per request, whether to trust the gateway-vetted IAM principal or fall back to the Cognito-group check. `isAdminIamEnforcedCall`, `isServiceAdminCall`, `callerIsAdmin`, `callerCanReadArchive`, and `callerCanManageProfiles` all fail closed: no env or no IAM identity means the trusted-IAM path is not taken.
- **The scope resolver** (`backend/lambda/src/lib/caller-scope.ts`) resolves the caller's classification ceiling for the `Scoped` cells, with no network call, from the assumed-role ARN the request already carries.
- **The CDK wiring** (`cognito-auth-stack.ts`, `analytics-stack-aurora.ts`, `analytics-stack.ts`) splits the analytics and admin-conversations APIs into per-capability resources, puts an `AWS_IAM` authorizer on each, maps each persona group to a sign-on IAM role via the Identity Pool role attachment, and grants that role `execute-api:Invoke` for exactly its capabilities.
- **The frontend admin client** (`frontend/packages/admin/src/services/`) SigV4-signs archive/analytics calls with the sign-on credentials (`sigv4Fetch.ts`), and vends the content-read capability through the exchange, mirroring the chat client's Amazon Chime SDK Messaging vend.

How it fits the layers: authentication stays at the API Gateway authorizer; the authorization decision moves from an in-handler group check to an IAM policy the gateway evaluates before the handler runs, with the handler trusting the vetted principal and applying only the classification-scope filter.

## 2. Data model

The catalog partitions privileged actions into two enforcement planes (`AdminCapabilityEnforcement`):

- **`signOnRole`** capabilities ride the persona's sign-on Identity-Pool role: `execute-api:Invoke` granted at sign-on, so a member's signed credentials already encode their access. No customer message content rides a standing role.
- **`exchangeVend`** capabilities (customer message content, matrix row A2, the `view-messages` capability) are vended per use by the credential exchange, short-lived and audited. The credential exchange vends two further exchange-only capabilities on a separate **S3 attachment plane** for conversation-attachment review: `attachment-read` (assistant deliverables under `generated-docs/…`, archive grade) and `attachment-read-uploads` (user uploads under `attachments/…`, moderation grade, with a sensitive-audit record). Like the A2 content vend, each is `plane:'admin'`, channel-scoped, and short-lived; its session policy allows `s3:GetObject` on only the named channel's attachment keys. These live in `credential-exchange.ts` (`S3_ATTACHMENT_CAPS`), not the `execute-api` catalog, because they are an `s3:*` session policy rather than an `execute-api:Invoke` grant.

The wired capabilities and their resources:

| Capability | Rows | Plane | Resource(s) | Personas (Full/Scoped) |
|---|---|---|---|---|
| `view-conversations` | A1, A4 | signOnRole | `GET admin/conversations`, `GET admin/conversations/membership-history` | all four |
| `view-messages` | A2 | exchangeVend | `GET admin/conversations/messages` | all four |
| `view-events` | A3 | signOnRole | `POST events-log` | admin, platform dev, AI dev |
| `view-user-activity` (PII) | A13 | signOnRole | `POST user-activity` | admin, platform dev |
| `view-moderation-audit` | A5 | signOnRole | `POST moderation-audit` | admin, platform dev, manager |
| `view-analytics` (with `view-quality`) | A6-A12, A14, A15 | signOnRole | `POST` analytics root | admin, platform dev, AI dev |
| `view-security` | A17, A18 | signOnRole | membership-audit findings/enforce/revoke | admin, platform dev |
| `manage-profiles` | P | signOnRole | `POST admin/profiles` | admin, platform dev, AI dev |
| `view-config` | A16 | signOnRole | none (see below) | admin, platform dev, AI dev |

`view-quality` and `view-analytics` share the same persona column, so they collapse into one capability and one resource (the safe-intersection rule: a capability grants a persona only if the matrix grants that persona every row in it). `view-config` (A16) is unwired by design: the only runtime-writable config is the assistant profile registry, already covered by `manage-profiles`; the rest of A16 is deploy-time config with no runtime API to gate. A18 (infra health, deployment sleep/wake) keeps its Cognito authorizer as cost-ops, not security-sensitive data.

**Persona-to-group map** (`ADMIN_PERSONA_GROUP`): `platform-admin` to `platform-admins`, `platform-dev` to `platform-devs`, `ai-dev` to `ai-devs`, `manager` to `managers`. Created only under `enableAdminPersonas`.

**Role-to-ceiling map** (`CLASSIFICATION_ROLE_CEILINGS`, emitted by the CognitoAuth stack, parsed once in `caller-scope.ts`): a JSON array of `{ role, ceiling }` where `ceiling` is a classification or `full`. A full-access group maps its role to Full (no narrowing); a per-classification role maps to that level; an absent or malformed entry yields an empty map, so every caller fail-closes to the floor.

## 3. APIs and interfaces

- **Per-capability resources.** The analytics API, previously coarse, is split so each capability has its own `execute-api:Invoke` resource (the paths in section 2), each `AWS_IAM`-authorized under the flag. A role whose policy omits a resource is denied at the gateway.
- **The queryType-to-capability partition** (`backend/lambda/src/lib/admin-capability-map.ts`) is the shared contract that stops a caller reaching an out-of-capability query through an in-capability resource: for the analytics plane the handler rejects a `queryType` that does not belong to the resource's capability.
- **The exchange vend request** carries an `identity` (`chat` or `admin`) and a capability set. An archive vend (an `execute-api` session policy) and an Amazon Chime SDK Messaging vend (a `chime:*` session policy) need different session policies, so the exchange rejects a request that mixes archive and Amazon Chime SDK Messaging capabilities. A content-read (A2) vend emits `admin_scoped_credential_vend` and scopes the session policy to the messages resource for its lifetime.
- **The principal contract.** On an `AWS_IAM`-authorized call, API Gateway populates `requestContext.identity.userArn` (the assumed-role ARN, used for the ceiling) and `cognitoAuthenticationProvider` (from which `iamCallerSub` extracts the verified human sub). On a Cognito-JWT call these are absent, which is exactly what makes the fallback fail closed.

## 4. Key flows and algorithms

**Sign-on role teeth (the standing grant).** The Identity Pool maps each admin persona group to its own IAM role at sign-on, and that role's policy carries `execute-api:Invoke` for exactly that persona's `signOnRole` capabilities. The console SigV4-signs an archive/analytics call with the sign-on credentials; API Gateway allows or denies per the role policy; the Lambda derives the actor from the signed principal (`isAdminIamEnforcedCall` true, then `iamPrincipalClaims`). This maps FR-3 (capability-level denial): denying a capability is one `execute-api` statement omitted from a role.

**The cut line.** The sign-on role carries every archive/analytics read except customer message content (A2). A2 and the whole Amazon Chime SDK Messaging plane use the exchange's short-lived, per-use, audited vend. So a standing role never holds customer PII or a mutation, and every content read and every moderation emits an attributable record. The rationale: message content is the only high-sensitivity PII read, and per-conversation "who read this" auditing is worth the round-trip; everything else is metadata, structure, or aggregate.

**Classification-scope resolution (the `Scoped` cells).** Under IAM enforcement the handler calls `ceilingForRequest(event)`, which extracts the role name from the assumed-role ARN and looks it up in the role-to-ceiling map, entirely in-process. This mirrors how the credential exchange bakes clearance into the assumed role rather than re-querying Cognito, so a VPC-attached analytics Lambda needs no network path to the Cognito API (no `cognito-idp` VPC endpoint or NAT). The single seam `ceilingForRequest` is fail-closed: an unresolvable role ARN or a role absent from the map returns the floor, never Full, so the fail-open cannot be reintroduced at a call site.

- **Conversations plane:** the list is filtered and the per-channel message and membership-history reads are guarded by `channelClassificationAllowed` (fail-closed).
- **Analytics plane:** `scopeAnalyticsRows` drops result rows whose classification dimension exceeds the ceiling. It is generic (no per-query SQL): a row is filtered only if it carries a field that both names a classification axis and holds a real classification value, so a global aggregate with no classification column passes through unscoped, and a field named `classification` holding a quality grade is not mistaken for a level.

**Fail modes.** A mis-set enforcement env on a Cognito API leaves `requestContext.identity` empty, so `isAdminIamEnforcedCall` returns false and the call falls through to the group check. A malformed `CLASSIFICATION_ROLE_CEILINGS` yields an empty map, so every IAM-enforced caller narrows to the floor. A role that omits a capability's resource is denied at the gateway before the handler runs.

## 5. Security and IAM

- **Fail-closed ceiling** as above: a control that cannot identify the caller narrows, never widens.
- **Vend-scope vs read-scope asymmetry.** The Amazon Chime SDK Messaging plane's session policy pins the channel ARN as the IAM resource, so a moderation credential literally cannot touch another channel. IAM cannot condition `execute-api:Invoke` on a query parameter, so the A2 archive credential scopes to the messages resource for its lifetime, not to one channel. Two mechanisms close the gap: a scoped persona is still held below its classification ceiling per channel by the fail-closed handler check, and the actual per-channel reads are captured independently by the API Gateway access log on the messages resource. A full admin, entitled to every channel, is not narrowed by the credential, by design.
- **Precedent.** `adminAuthMode=service` already runs the admin and analytics API behind an IAM authorizer; this design generalizes that from all-or-nothing to per-resource, deriving the actor from the signed principal the same way.
- **Audit tie-in.** The exchange already emits `admin_scoped_credential_vend` on every admin-plane Amazon Chime SDK Messaging vend; this design extends the emission to archive-capability (content, A2) vends, so "who could read a customer conversation" becomes auditable next to "who could moderate", with the same short-lived, attributable record.

## 6. Testing

- **Unit:** `caller-scope.ts` ceiling/filter logic (`ceilingFromGroups`, `classificationAllowed`, `scopeAnalyticsRows`) is unit-tested; the multi-group claim parsing that underlies the group fallback is pinned by `backend/test/lib/auth.test.ts`.
- **Integration:** the capability catalog wiring (per-resource authorizer, sign-on role teeth) and the queryType-to-capability rejection are exercised against the split analytics and admin-conversations APIs.
- **End-to-end:** the on-flag runtime path (SigV4-signed call, gateway allow/deny per role, handler actor derivation, ceiling narrowing) is verified on deploy.
- **Deferred / gaps:** the ownership/membership scope axis has no generic test because it is a deployment choice with no platform model; Athena-mode analytics parity for the events-log and user-activity sub-paths is a handler/stack gap noted in section 7.

## 7. Migration / phasing / rollout

- **P0 (built).** The capability catalog and the analytics queryType partition; the flag-gated `AWS_IAM` authorizer on the admin-conversations reads; the sign-on role teeth.
- **P1 (built).** `view-conversations` on the sign-on role; `view-messages` (A2) exchange-vended, short-lived and audited; frontend SigV4 signing.
- **P2 (built).** `view-events`, `view-user-activity`, `view-moderation-audit` on their own analytics resources; `view-quality` plus `view-analytics` bundled on the analytics root; `manage-profiles` on the profile routes; the four example persona roles and their per-capability IAM policies (opt-in).
- **P3 (built).** The interim `callerCanReadArchive` and `callerCanManageProfiles` group gates are demoted to the `ae-cognito` fallback: under IAM enforcement the gateway is the control and the handler trusts the signed principal; a Cognito-JWT call still resolves through the group gate.

**Remaining (by design or deploy-validated):** the ownership/membership `Scoped` axis stays a deployment choice; Athena-mode parity for the events-log and user-activity sub-paths (the Athena analytics API is a single `POST /query` with no per-capability split and does not yet expose the `channel_events` queryType) brings both modes level; the classification-ceiling axis is built for both planes.

## 8. Open technical questions

- **The default-mode enforcement question.** In `ae-cognito` mode, either adopt exchange-vended `execute-api` credentials for archive calls in all modes (uniform, recommended), or keep the group gate as the ceiling in `ae-cognito` and require the IAM plane only in `service` / `federated` modes.
- **Capability granularity.** Whether the section-2 split is the right resolution or should be coarser.
- **Ownership scoping.** Whether the AI developer (by assistant) and manager (by use case) `Scoped` conditions reuse the classification tag alone or need a new ownership tag.
- **A2 vend chattiness.** Whether the per-conversation content vend proves too chatty in practice, with the fallback being A2 on the sign-on role plus a per-read audit-log write instead of a vend.
- **Binding the A2 credential to one channel.** If a deployment needs the credential itself bound to a single conversation, carry the channel as a session tag and re-check it in the handler (a follow-up, not wired).
