# SPEC: Portable, versioned assistant profiles

**Status:** Implemented and deployed. The versioning lifecycle (create / edit / activate / rollback), A/B and battle over any profile version (`profileRef`), and export / import with manifest signing are built - `lib/profile-lifecycle.ts`, `lib/profile-manifest.ts`, `lib/profile-version-lookup.ts`, `manage-profiles.ts`, and the admin Profiles tab. Extends `SPEC-PER-PROFILE-OWNERSHIP.md` and `SPEC-ASSISTANT-CONFIG.md`, relaxing exactly the non-goals they froze. The forward-looking items (per-intent tool experiments, two-live-version production A/B) are marked inline.

**Coverage:** `tests/e2e/admin-profiles.spec.ts`, `tests/e2e/profile-config.spec.ts`, `tests/e2e/portable-profile-gates.spec.ts`, `tests/e2e/portable-profile-lifecycle.spec.ts` (the lifecycle end to end against the live API: export is instance-agnostic, import lands a DRAFT and never moves the active pointer, a draft edit persists and validates, and activate promotes then rollback restores - each asserted against the SSM `active` label rather than the mutating call's own return)

**Verified by:** `backend/test/lib/profile-manifest.test.ts` - export is instance-agnostic (no ARNs, account ids, or region), export rewrites a stored guardrail id into its portable selection key, an export/import across two instances lands the selection on the **target's own** guardrail, import rejects a model outside the target catalog, rejects an unprovisioned target profile, rejects a guardrail selection the target does not provision (naming its valid keys) and fails closed when that catalog is unreadable, lands every import as a draft never active, and verifies or rejects an optional signature. Lifecycle and resolution are covered by `backend/test/lib/profile-lifecycle.test.ts` and `backend/test/lib/active-profile.test.ts`; the runtime guardrail fallback chain by `backend/test/lib/guardrail-selection.test.ts`. The S3 body store is covered by `backend/test/lib/profile-bodies.test.ts` (the content-addressed key, and the two refusals: no bucket, mismatched configId), `backend/test/lib/profile-bodies-roundtrip.test.ts` (a persona larger than the definition parameter's own limit round-trips through write, activate and resolve; a pre-pointer inline persona still resolves; an unreadable body falls back to the seed; rollback re-points and writes nothing; export stays instance-agnostic and import lands the body in the target's store), and `backend/test/profile-body-store-grant.test.ts` (the synthesized template grants the writer both S3 verbs on the prefix, gives it the bucket, and lets every processor read it).

**Problem and who it's for:** A team that builds assistants wants to treat one like a product it iterates on - version an assistant, test or battle a new version against the one in production, promote or roll it back, and move a proven assistant from staging to production or to another region - without redeploying infrastructure each time or hand-rolling its own versioning-and-promotion tooling. This is for the AI developer iterating on assistants and the admin/operator who promotes, rolls back, or imports them; the alternative on the market is a single-tenant chatbot builder with no portability, or a DIY pipeline they own and secure themselves. It makes an assistant a **portable, versioned artifact** on the governed platform, preserving every security invariant. (Current state: this relaxes the deploy-time-only, single-version, one-to-one-with-a-classification constraints the earlier profile model deliberately froze - see `SPEC-PER-PROFILE-OWNERSHIP.md`.)

**Site section:** Interaction layer, Assistant Configuration pillar (core plane).

## The reframe: behavior is data, a boundary is infrastructure

The whole design rests on one distinction between a deployed security boundary and the data that runs inside it:

- A **classification** is a *deployed security boundary* - a data/sensitivity label with a declared rank (the sample ships `basic < standard < premium`), the immutable `classification` tag on a channel, and the IAM keyed on it. Adding one provisions a new boundary.
- An **assistant identity** is a *named bot principal* (an `AppInstanceBot` with its own IAM role, context scope, guardrail, and `bedrock:InvokeModel` allowlist) provisioned at or below a classification's ceiling. It is the real per-principal boundary. A classification may host more than one - a `primary` and a `meeting` assistant cooperating in one conversation - each its own principal with its own scope no wider than the shared ceiling. Today's shipped deployment is the degenerate case of exactly one assistant per classification.
- A **profile** is *what an assistant is*: model, persona/system prompt, intent pack, tools, guardrail selection, classifier mode, timeouts, limits (the `AssistantConfig` bundle of `SPEC-ASSISTANT-CONFIG.md`). A profile is behavior = data.
- A **version** is an immutable snapshot of a profile's definition carrying a `configId` fingerprint. A profile is a named identity with an ordered history of versions; exactly one is `active` (served), the rest are draft or archived for editing, comparison, rollback, and battle.

The load-bearing line: **a classification is the deployed ceiling; an assistant identity is the per-principal boundary inside it; a profile version is the behavior data one identity runs; a conversation type composes which assistants are present.** The versioned, portable unit is a **named assistant** (keyed `assistant/{name}`), never a classification.

From this, one rule settles every "do I deploy?" question: **behavior is data (no deploy); a boundary is infrastructure (deploy).** Activating a new version, rolling back, importing a profile that binds to an existing classification, or battling two versions is a **data change** (a parameter version plus content-addressed bodies), not an infrastructure deploy. New infrastructure is required only at a genuinely new boundary: a new classification (a new scope/role/guardrail/bot is a real new boundary) or a new instance/region.

> **One honest note, and it is not per-profile.** A battle needs a second bot in the channel. That is a per-classification **alt-slot bot** - a generic, persona-less `AppInstanceBot` that reads its config at runtime from the variant it is bound to (`SPEC-BATTLE.md`). Adding a *profile* adds zero bots; battling any profile or version binds it to the classification's existing alt bot. `AppInstanceBot`s are cheap, so more alt bots (for more concurrent or N-way battles at a classification) is a trivial per-classification config bump, bounded by channel legibility, not cost.

## A profile version is a versioned artifact

The behavioral bundle is the `AssistantConfig` of `SPEC-ASSISTANT-CONFIG.md` (model, persona, intent pack, tools, guardrail selection, context scope, classifier mode, timeouts, limits, battle eligibility). A **version** wraps it with lifecycle and attribution metadata:

```ts
interface ProfileVersion {
  profileName: string;            // stable identity ACROSS versions (the assistant/{name} key)
  version: number;                // monotonic; a version is immutable once activated
  status: 'draft' | 'active' | 'archived';
  configId: string;               // fingerprint of the definition - the analytics + battle attribution key
  definition: AssistantProfile;   // the behavioral bundle (model, prompt, tools, guardrail, scope, ...)
  provenance: {
    createdAt: string;
    createdBy: string;            // server-verified admin identity (audited)
    createdFrom?: { instanceId: string; profileName: string; version: number };  // set on import/clone
    contentHash: string;          // hash of the canonicalized definition (import integrity, dedup)
  };
  schemaVersion: string;          // for cross-version import compatibility
}
```

Editing never mutates an `active` version; it creates a new `draft`. So every analytics row, battle result, and audit entry that references a `configId` maps to an exact, reproducible configuration. This extends the `configId` fingerprint of `SPEC-ASSISTANT-CONFIG.md` from a deployment-level identity to a per-version one - a deliberate widening, called out so it is intentional.

**As-built shape.** The stored definition is the runtime-editable subset of the bundle, not the full `AssistantProfile`: the model bundle, tool allowlist, guardrail selection (`guardrailId`), per-assistant task machines (`machines`), classifier mode, timeouts, limits, battle eligibility, and the persona - as a `personaRef` pointer into the body store rather than the text itself (see "Where it lives") - plus `schemaVersion`, `profileName`, and `configId` (`lib/active-profile.ts` `ProfileDefinitionBody` / `ProfileDefinition`). Boundary fields - above all the context scope, an IAM `s3:GetObject` grant - are never stored or served from the version; resolution always takes them from the compiled seed (`lib/active-profile.ts:resolveActiveProfile`). Version numbers, the `active` label, the archived-versus-active distinction, and rollback are the SSM parameter's own native versions plus the `active` label (see the next section), not fields in the JSON.

**The model selection is itself per-profile and per-intent.** A version's model field is a bundle - a base model, a classifier model, an optional heavier `complex` model, and per-intent overrides (`models.byIntent`, each an intent's primary plus an optional resilience fallback) - so per-intent model routing lives on the profile version, not a global strategy table (`lib/active-profile.ts:ProfileModels`, `buildIntentStrategy`). Every model in the bundle is bounded by the classification's `bedrock:InvokeModel` allowlist, validated at the write path (`lib/profile-lifecycle.ts:validateBody`). A `'default'` sentinel (`lib/active-profile.ts:DEFAULT_MODEL`) records "follow the classification-set default" as an explicit, self-documenting choice that tracks the platform default over time rather than pinning today's model into the version; the seed uses it for the classifier. The per-profile tool surface is likewise data: a version's `tools` allowlist is validated against the tool registry at the write path (`lib/tool-registry.ts:unknownTools`), and the seed writes the full registry set so an operator restricts a profile by removing tools.

## Where it lives: reuse SSM and S3, no new datastore

Profiles already publish to `assistant/{name}` parameters in AWS Systems Manager (SSM) Parameter Store, and the deployment already owns an S3 bucket that large bodies can live in. This spec reuses both, so it adds **no new datastore**:

- **Versioning is SSM, natively.** A profile's definition (the JSON bundle minus the large bodies) is a single SSM parameter `assistant/{name}/definition`. Every edit is a `PutParameter`, which SSM stamps with a monotonic version number - that *is* the version history. An `active` label points at the served version; resolving by label reads it, parameter history lists the versions, and rollback is re-labeling a prior version. Version numbers, history, the active pointer, and rollback all come from SSM with no new table.
- **Bodies are S3.** A version's large bodies live in S3, keyed by `configId` so they are content-addressed and immutable; the SSM definition stores a pointer plus `configId` rather than the body. As built, this covers the **persona**: `manage-profiles` writes it to `profiles/{profileName}/{configId}/persona` in the attachments bucket and the definition carries a `personaRef` (`lib/profile-bodies.ts`, `lib/profile-lifecycle.ts:putDefinition`). Content-addressing is what makes activation and rollback re-point at an existing body instead of rewriting one, and nothing deletes - an older version's body has to survive for a rollback to it to mean anything. The bucket is deliberately **not** stored in the pointer: a stored bucket name would travel with an export and aim a target instance at the source account's storage. The intent pack is not on this path yet - it still resolves per deployment from `assistant/{classification}/assistant-intent-pack`, which is read by `lib/intent-pack.ts` and holds the pack inline; doc-set manifests are likewise out of scope here.
  - *Verified by:* `test/lib/profile-bodies-roundtrip.test.ts` (a persona larger than the parameter limit round-trips through write, activate and resolve; a pre-indirection inline persona still resolves; an unreadable body falls back to the seed; rollback writes no body) and `test/profile-body-store-grant.test.ts` (the synthesized template grants and wires both sides).
  - *Why the indirection is load-bearing:* one definition is one SSM `Standard`-tier parameter, capped at 4096 characters for the whole serialized value, while a persona is allowed 20000 (`MAX_PERSONA_LENGTH`). Without the pointer a persona in that gap passes schema validation and then fails at `PutParameter`. A version's `configId` is unchanged by where its body is kept - it hashes the body including the persona - so moving a deployment onto the body store neither re-keys its analytics nor invalidates an exported manifest.
- **Drafts** are a sibling `assistant/{name}/draft` parameter until activation promotes them to a new labeled version.
- **Seed = the shipped default.** Each profile's shipped config is written once as version 1, labeled `active`. A deployment that never edits a profile behaves exactly as before - additive, with deploy-time config still a valid way to pin or seed.
- **Resolution** reads the `active`-labeled definition, cached per Lambda container with a short TTL; an activation re-labels and readers converge within the TTL. Fail-closed: an unresolvable or invalid active version falls back to the seed, never to "no profile."

A dedicated table is deliberately avoided: it would duplicate the versioning, history, and labels SSM gives for free, add a resource to provision and secure, and split the profile's source of truth from the keys the runtime already reads. The only reason to revisit is edit frequency high enough to hit SSM throughput or version limits - untrue for an operator-edited artifact.

## Lifecycle

Every mutating step requires the `manage-profiles` admin capability (IAM-enforced, see Security) and is audited with the server-verified actor:

- **create-version** - clone the active version into a new `draft` (next number), copying its definition.
- **edit-draft** - modify behavioral fields on a `draft` only; re-hash `contentHash`, recompute `configId`.
- **validate** - the synth-time checks of `SPEC-PER-PROFILE-OWNERSHIP.md` plus the boundary checks below (model within the `InvokeModel` allowlist, context scope and guardrail provisioned, tools a subset of what the conversation type allows).
- **activate** - atomically swap the `active` pointer to this version; the previous active becomes `archived`, retained for history and rollback.
- **rollback** - re-activate a prior archived version (itself an activate; no data migration).

Because activation is a pointer swap and versions are immutable, rollback is instant and lossless.

## Portability: export and import across instances and regions

The point of a version being a self-contained artifact is that it can leave the instance that made it.

**Export** serializes the definition with its bodies **inlined**, `schemaVersion`, provenance, and `contentHash` into one JSON document. The manifest is **logical and instance-agnostic**: it references a model by catalog key (not a Bedrock ARN), a guardrail by its catalog **selection key** (`default`, `strict`) rather than the id resolved on the authoring instance, a context scope by classification, and tools by name. It contains **no ARNs, no account IDs, no secrets, no region** - nothing that binds it to the source instance.

Inlining is a deliberate asymmetry with storage, not an inconsistency: storage keeps the persona in S3 and the definition holds a pointer, but a manifest that carried that pointer would describe the source instance's storage, which is exactly what a portable artifact must not do. So export follows the pointer and emits the body (`profile-manifest.ts:readDefinition`), and import writes the body into the **target's** store and keeps a target-local pointer. The manifest size bound is derived from `MAX_PERSONA_LENGTH` for the same reason - a bound that could not hold a full persona would make export produce manifests import refuses. A referenced doc-set *manifest* travels; the corpus itself does not.

The guardrail deserves a note, because it is the one field whose stored form is instance-bound: a profile version records the guardrail id **resolved at deploy time**, so export rewrites it to the catalog key before serializing (`toPortableGuardrail`). Without that rewrite the manifest carries an opaque id that names nothing on any other instance, and it evades the "no ARNs, no account IDs, no region" check precisely because it is none of those things. When the selection cannot be mapped (an unreadable catalog, or an id predating it) export emits it verbatim and warns rather than failing: export is read-only, and import is the gate that fails closed.

**Import** treats the manifest as **untrusted input**: validate against the schema and bound its size, then validate against the target's capabilities, then land it as a **new draft** (never auto-active - an import is reviewed, then activated by a human):

1. **Model** - the catalog key exists in the target and is within its `bedrock:InvokeModel` allowlist, or the operator explicitly remaps it. Unresolvable, reject.
2. **Context scope** - the referenced classification/scope exists on the target; a manifest can never import a *broader* scope than the target's IAM grants. Mismatch, reject or remap.
3. **Guardrail** - the selection resolves against the target's own published catalog (`{SSM_ROOT}/assistant/{profile}/guardrails`): a catalog **key** remaps to the id this instance provisioned for it, an id already provisioned here passes through unchanged, and anything else is **rejected** with the target's valid keys named in the error so an operator can remap it. A catalog that cannot be read is also a reject: a selection that cannot be verified is never landed. Absent selection inherits the deployment default. A manifest cannot point at an arbitrary guardrail resource, and IAM is the backstop - `bedrock:ApplyGuardrail` is granted per provisioned guardrail.
4. **Tools** - every tool is available on the target and a subset of what the target conversation type allows. Missing, reject.
5. **Schema** - `schemaVersion` is compatible; older manifests upgrade through a documented migration. The guardrail change above did **not** bump it: the field's shape is unchanged and import accepts both forms (a key remaps, a provisioned id passes through), so a manifest exported before the change still imports correctly. Bumping would have rejected every earlier export for no gain in safety.

On success the import records where the assistant came from (`createdFrom` plus the original `contentHash`), a full audit chain. **Cross-region falls out for free**: because the manifest carries no region-bound identifiers and import re-resolves everything against the target, another region is just another import target - the only gate is Amazon Chime SDK Messaging's own region availability. **Import cannot escalate**: an imported profile carries no identity and no IAM - it is behavior only, validated against the target's authoritative identities, roles, classifications, and guardrails, and fails closed when a reference is unprovisioned.

A multi-assistant scenario (a conversation type enrolling `primary` + `meeting`) exports as a **composition manifest**: the type's `defaultAgents` list plus each referenced assistant's profile manifest. Importing it resolves each named assistant against the target on its own boundary - no new escalation surface.

## A/B and battle over any version

Today an experiment variant varies a model key and an optional system-prompt addendum. This extends a variant to reference a whole profile version:

```ts
interface ExperimentVariant {
  variantId: string;
  modelKey?: string;              // existing lightweight knobs, still valid for model-only experiments
  systemPromptAddendum?: string;
  profileRef?: { profileName: string; version?: number };  // NEW - run an ENTIRE profile version (version omitted = active)
  weight: number;
}
```

A variant with `profileRef` runs that version's **complete** definition - model, prompt, intent pack, tools, classifier mode, guardrail within limits - not just a model and an addendum (`modelKey` and `profileRef` are mutually exclusive per variant). The admin A/B and battle surface **lists all profiles and versions** and can pit **any two** against each other: two versions of one profile (the "edit a new version and test it against the current one" flow) or two different profiles. The `battleEligible` flag demotes from a gate to a default-participation hint - an operator-driven comparison may target any profile or version. The rival binds to the classification's persona-less alt-slot bot exactly as a model-only variant does, so battling any profile costs no new bot. The winner is decided by the experiment's objective (cost / accuracy / quality / latency), attributed by `configId` like any other version ([`SPEC-ASSISTANT-CONFIG.md`](SPEC-ASSISTANT-CONFIG.md) defines that fingerprint; [`GUIDE-AB-TESTING-AND-BATTLES.md`](../../../guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md) is the operator view).

**The classification ceiling still binds.** A battle runs inside one channel and cannot let either profile exceed that channel's classification; comparing profiles never widens access.

Because a version's definition includes `tools`, the experiment axis is no longer only "which model": two versions can differ **only in which tools the assistant may call**, to answer whether a tool earns its place. Modeling `tools` so a later `intent -> tools` mapping is an additive refinement keeps per-intent tool experiments open.

## Security: the behavior/principal cut

Portability and runtime editing are safe **only** because a profile version is behavior, never a principal. A version changes what the assistant **does**, never who it **is** or what it **may do**. The `AppInstanceBot` identity, its ARN, its bearer-pinning, and its IAM role are deploy-time and stable; activating, editing, or importing a version never recreates a bot, mints IAM, or rebinds an identity. Those durable per-assistant-identity resources *are* the security boundary; a version is behavior they read - so swapping versions for an existing assistant is both zero-infra and zero-escalation, which are the same property. Co-resident assistants at one classification are distinct principals, so a version of one can never widen into another's scope.

Fields split into two classes, enforced at edit / activate / import:

- **Runtime-editable (behavioral):** persona, intent pack, the model bundle (base, classifier, `complex`, and per-intent models) *each within the deployment's allowlisted catalog*, the tool allowlist *within the registered set*, classifier mode, timeouts, max tokens, rate-limit values *within a ceiling*, display name, battle eligibility. These move output, cost, and latency - not the boundary.
- **Deploy-time-only (boundary):** context scope (an IAM `s3:GetObject` grant - a version may only *select among* provisioned classification scopes, never widen), the guardrail as a resource (select among provisioned guardrails, never an arbitrary one), and the model boundary (every model in a version's bundle must resolve within the catalog the deployment's IAM already permits `bedrock:InvokeModel` on - a model outside it is a validation reject, not a runtime `AccessDenied`).

The lifecycle is itself an IAM-enforced admin action: `manage-profiles` (create / edit / activate / import) is a distinct capability from the read capabilities, wired the way `identity-access/admin/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md` enforces every admin action, so *who* may version or import an assistant is fine-grained and denyable. And because the active version lives in SSM, write access to `assistant/*` is privileged: only the `manage-profiles` role and the seed step may write or label there; the runtime processor role stays read-only. Unchanged throughout: the `classification` tag key and its immutability, fail-closed resolution, assistant bearer-pinning, and the min-cap defense-in-depth.

## Relationship to per-profile ownership

`SPEC-PER-PROFILE-OWNERSHIP.md` deliberately froze three things this spec relaxes - and only these:

| That spec said | This spec makes it |
|---|---|
| Deploy-time config only (no runtime editing) | The registry resolves the **active version** from a store at runtime; a new version can be created, edited, and activated without a redeploy, for behavioral fields only. |
| A profile is a single implicit thing | A profile is a **named identity with an ordered history of versions**, one `active`. |
| Not portable (a code constant) | A version serializes to a **self-contained, instance-agnostic manifest** that exports and imports across instances and regions. |
| One profile per classification (1:1) | Reframed: 1:1 is **profile-to-assistant-identity**, not profile-to-classification. A classification hosts one assistant today, N in a multi-assistant conversation, each its own identity and scope no wider than the ceiling; a conversation type composes which are present. |

Nothing about enforcement changes: an additive lifecycle layer over an unchanged security design.

## Phases (each independently deployable)

| Phase | Contents | Status |
|---|---|---|
| **0 - Store and decouple** | Definitions in SSM (native versions + `active` label) + S3 bodies; the runtime reads its profile-varying fields from the active version instead of deploy-time env; seed is byte-identical to today | Built. S3 bodies cover the persona (`personaRef`); the per-deployment intent pack still stores its pack inline in its own parameter |
| **1 - Versioning** | create / edit / activate / rollback behind `manage-profiles`; admin Profiles tab lists profiles + versions | Built |
| **2 - A/B + battle any version** | `profileRef` variants; pick any two; `battleEligible` demoted to a hint | Built |
| **3 - Portability** | export manifest; import to a validated draft (fail-closed); provenance chain; manifest signing | Built |
| **4 - Cross-region + hardening** | region-agnostic manifest (import re-resolves against the target); manifest signing | Manifest is region-agnostic and signed; actual cross-region use is gated only by Amazon Chime SDK Messaging region availability |
| **5 - Per-assistant config axes** | per-assistant guardrail selection (`guardrailId`) and per-assistant task machines (`machines`) ride the versioned definition and export/import with it; each SELECTS among deployment-provisioned resources, never widens the boundary ([`SPEC-CONFIGURABLE-ASSISTANTS.md`](SPEC-CONFIGURABLE-ASSISTANTS.md)) | Built |

## Open questions

- **Version identifier:** monotonic integer (simple, ordered) vs semver (conveys compatibility). Leaning integer plus a human note.
- **SSM vs git:** the runtime-editable SSM store here vs git-tracked, reviewable manifests. A hybrid (git as the source for seeded/reviewed profiles, SSM as the runtime-active pointer) may be best.
- **Manifest residency:** a manifest carries persona/pack bodies, so exporting one moves that content across an instance (and possibly region) boundary; decide the residency and retention posture, with the provenance chain as the audit hook and optional signing as the integrity one.
- **Two live versions (production A/B):** relax the 1:1 serving binding to a weighted split of two active versions per classification, for in-production experiments rather than operator-launched battles.
- **Corpus portability:** a manifest references a doc-set manifest, not the corpus (corpora are large and classification-bound); how much travels with the profile vs is re-ingested on the target is its own design.
- **Roster as a portable unit:** whether export ships the composition (a conversation type plus its assistant manifests) as one bundle or stays per-assistant with the type re-authored on the target.
