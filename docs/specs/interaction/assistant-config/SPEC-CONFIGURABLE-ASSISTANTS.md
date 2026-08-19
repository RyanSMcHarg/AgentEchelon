# SPEC: Configurable assistants - three per-assistant config axes on one governed boundary

**Status:** Implemented

**Coverage:** `tests/e2e/profile-config.spec.ts`

**Verified by:** `backend/test/cdk-synth.test.ts` (describe 'Layer 4 / §7 - IAM resource boundaries (deny-by-absence...)' - each classification's S3 context read EXCLUDES higher classifications, the channel-context store is router `GetItem`-only and unreadable by Cognito/Identity-Pool roles, and `bedrock:ApplyGuardrail` is scoped to provisioned guardrails, never `*`; plus describe 'Layer 1 - per-tier fail-closed channel-tag allow'), `backend/test/lib/guardrail-catalog.test.ts` (default vs strict guardrail policy - strict adds a blocked term), `backend/test/task-state-machines.test.ts` and `backend/test/lib/task-loop-machines.test.ts` (task-machine graph validation + a profile's machines override the deployment pack at loop time), `backend/test/lib/active-profile.test.ts` (a version's models/tools/machines/guardrailId surface on the resolved profile and fail closed to the seed on an invalid version), and `tests/e2e/profile-config.spec.ts` (a strict-selecting profile masks a term the default does not, and config survives export/import; gated `PROFILE_CONFIG_E2E=1`).

**Problem and who it's for:** A business shaping distinct assistants for distinct experiences wants each assistant's readable context, task behavior, and content guardrail to be per-assistant configuration that rides the versioned profile definition, bounded by the same IAM boundary the deployment already enforces, rather than a code fork per variant or a home-grown config layer it builds and secures itself. This is for the AI developer tuning assistants and the admin/operator who governs their scope. It closes the three axes the `AssistantConfig` bundle names ([`SPEC-ASSISTANT-CONFIG.md`](SPEC-ASSISTANT-CONFIG.md)) onto the portable, versioned artifact ([`SPEC-PORTABLE-PROFILES.md`](SPEC-PORTABLE-PROFILES.md)): context scope, task machines, and guardrail selection - each behavior a profile carries, each bounded by infrastructure a profile can never widen.

**Site section:** Interaction layer, Assistant Configuration pillar (core plane).

The three axes share one invariant, the behavior/boundary cut of `SPEC-PORTABLE-PROFILES.md`: a profile SELECTS among resources the deployment provisions and can never point at an arbitrary one. Widening any of the three boundaries fails the synth-time IAM assertions in `cdk-synth.test.ts`, so a widened boundary breaks the build rather than shipping.

## 4.1 Context-scope unification

The S3 `context/{classification}/` IAM grant and the retrieval walk both derive their prefixes from ONE resolver, so a renamed or added classification can never drift the IAM boundary apart from what retrieval actually reads.

- **The resolver:** `ProfileRegistry.contextPrefixesAtOrBelow` / `scopeAtOrBelow` (`backend/lib/profile-registry.ts`), for `contextScope: 'own-rank-and-below'`.
- **IAM (the boundary):** `ContextS3Read` on each profile stack's processor role (`backend/lib/stacks/assistant-profile-stack.ts`), with prefixes from `classificationsAllowedFor` -> `scopeAtOrBelow`. A classification reads its own prefix and every lower one; a higher prefix is absent, so a read against it is denied by absence, not by an explicit Deny.
- **Retrieval:** `backend/lambda/src/lib/company-context.ts` walks the same `contextPrefixesAtOrBelow` (highest-rank-first for the char budget).
- **Asserted by** `backend/test/cdk-synth.test.ts` describe 'Layer 4 / §7 ...': basic excludes standard + premium, standard excludes premium, premium spans the ladder.

## 4.5 Per-assistant task machines

A profile's `machines` override the deployment intent pack's task-state graphs at loop time, so one assistant can run a domain-specific task lifecycle without changing the platform or the deployment pack.

- **Merge at loop time:** `buildTaskLoopContext` merges `{ ...deploymentPack, ...profileMachines }` per `taskType` (`backend/lambda/src/lib/async-processor-core.ts`); an overridden `taskType` runs the profile graph, the rest inherit the pack, and no profile machines is byte-identical to the pre-axis behavior.
- **Surface + validate:** the resolved active version surfaces `machines` and validates them (`backend/lambda/src/lib/active-profile.ts`); an invalid graph fails the whole definition closed to the seed.
- **Asserted by** `backend/test/task-state-machines.test.ts` (graph validation - loud, named failures; the intent-pack machines-carry with a malformed-override fallback) and `backend/test/lib/task-loop-machines.test.ts` (a profile machine overrides the deployment-pack machine for the same `taskType`, inherits the rest, and no-ops when the profile carries none).

## 4.6 Guardrail select and define

A deployment provisions a guardrail CATALOG and a profile SELECTS one via `guardrailId`. The `bedrock:ApplyGuardrail` grant is per provisioned ARN, so a profile can never point at an arbitrary resource.

- **Define (the catalog as data):** `backend/lib/config/guardrail-catalog.ts` - entry 0 is the deployment default; additional entries (the shipped `strict` example adds one blocked term) are selectable alternates. Deployers extend or replace the list with their own industry-specific guardrails.
- **Provision + grant (the boundary):** `backend/lib/stacks/assistant-profile-stack.ts` provisions each catalog entry, grants `bedrock:ApplyGuardrail` per provisioned ARN, and publishes the resolved ids (with their selection keys) to `{SSM_ROOT}/assistant/{profile}/guardrails`.
- **Fallback (what an unusable selection does):** a SELECTED guardrail that cannot be applied for **any** reason falls back to the deployment default and re-applies; only a failure of the DEFAULT itself fails open. The reason is deliberately not narrowed to `AccessDenied`: an unprovisioned id AccessDenies, but a selection key used where an id belongs, or an id carried in from another deployment, raises `ValidationException` or `ResourceNotFoundException` instead. Treating only the first as recoverable left the other two passing the turn through completely **unfiltered**, on both input and output. A selected guardrail that will not apply is a misconfiguration whatever the error name, and the deployment default still applies (`backend/lambda/src/lib/async-processor-core.ts` `runGuardrail`).
- **Select (behavior):** a profile's `guardrailId` picks a catalog entry; undefined inherits the deployment default (`backend/lambda/src/lib/active-profile.ts` / `async-processor-core.ts`).
- **Port (what crosses instances):** the selection travels as its catalog KEY, not the resolved id, and import resolves it against the target's own catalog or rejects it ([`SPEC-PORTABLE-PROFILES.md`](SPEC-PORTABLE-PROFILES.md) section on export and import).
- **Asserted by** `backend/test/lib/guardrail-catalog.test.ts` (the default policy lacks the strict term, the strict alternate carries it over the same base), `backend/test/lib/guardrail-selection.test.ts` (a selected guardrail applies its DRAFT; a selection that AccessDenies, that is a catalog key, or that belongs to another deployment each fall back to the default and still mask or block; only a default outage fails open), `backend/test/lib/profile-manifest.test.ts` (the selection exports as a key and imports onto the target's own guardrail), and `backend/test/cdk-synth.test.ts` describe 'Layer 4 / §7 ...' (`ApplyGuardrail` resources each reference an in-stack provisioned guardrail, never `*` and never a raw arbitrary ARN).

## The server-only Channel Context store (private host grounding)

A conversation's private host grounding - participant profile, domain context, extra context blobs, and resolved display name - lives in a dedicated DynamoDB table (`ChannelContextTable`, `backend/lib/stacks/foundations-stack.ts`) keyed by `channelArn`, deliberately OUT of the member-readable Amazon Chime SDK channel Metadata. Only the conversation-create Lambdas write it (`grantWriteData`); only the router/assistant handler reads it, scoped to `dynamodb:GetItem` (`assistant-profile-stack.ts`). No channel member, Cognito, or Identity-Pool principal is granted any access. Code: `backend/lambda/src/lib/channel-context-client.ts`, `host-grounding.ts`. Asserted by `backend/test/cdk-synth.test.ts` describe 'Layer 4 / §7 ...' (the router holds only `GetItem`, never write/scan; the Cognito auth stack references the store from no role). The security framing is in [`SPEC-CONVERSATION-SECURITY.md`](../identity-access/core/SPEC-CONVERSATION-SECURITY.md) and [`ACCESS-CONTROL-BY-EXAMPLE.md`](../identity-access/core/ACCESS-CONTROL-BY-EXAMPLE.md).

## Related

- [`SPEC-ASSISTANT-CONFIG.md`](SPEC-ASSISTANT-CONFIG.md) - the `AssistantConfig` bundle these axes are fields of.
- [`SPEC-CONFIGURABLE-INTENT-PACK.md`](SPEC-CONFIGURABLE-INTENT-PACK.md) - the intent taxonomy and its optional `machines` block the 4.5 override builds on.
- [`SPEC-PORTABLE-PROFILES.md`](SPEC-PORTABLE-PROFILES.md) - the versioned artifact that carries `guardrailId` and `machines`, and the behavior/boundary cut.
- [`SPEC-CONVERSATION-SECURITY.md`](../identity-access/core/SPEC-CONVERSATION-SECURITY.md) and [`ACCESS-CONTROL-BY-EXAMPLE.md`](../identity-access/core/ACCESS-CONTROL-BY-EXAMPLE.md) - the IAM boundary the context, guardrail, and channel-context grants sit on.
