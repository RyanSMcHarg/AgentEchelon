# SPEC: Portable, versioned assistant profiles

**Status:** Implemented and deployed. The versioning lifecycle (create / edit / activate / rollback, and discarding a draft, built and not deployed), A/B and battle over any profile version (`profileRef`), and export / import with manifest signing are built - `lib/profile-lifecycle.ts`, `lib/profile-manifest.ts`, `lib/profile-version-lookup.ts`, `manage-profiles.ts`, and the admin Profiles tab. Extends `SPEC-PER-PROFILE-OWNERSHIP.md` and `SPEC-ASSISTANT-CONFIG.md`, relaxing exactly the non-goals they froze. The forward-looking items (per-intent tool experiments, two-live-version production A/B) are marked inline.

**Coverage:** `tests/e2e/admin-profiles.spec.ts`, `tests/e2e/profile-config.spec.ts`, `tests/e2e/portable-profile-gates.spec.ts`, `tests/e2e/portable-profile-lifecycle.spec.ts` (the lifecycle end to end against the live API: export is instance-agnostic, import lands a DRAFT and never moves the active pointer, a draft edit persists and validates, and activate promotes then rollback restores - each asserted against the SSM `active` label rather than the mutating call's own return)

**Verified by:** `backend/test/lib/profile-manifest.test.ts` - export is instance-agnostic (no ARNs, account ids, or region), export rewrites a stored guardrail id into its portable selection key, an export/import across two instances lands the selection on the **target's own** guardrail, import rejects a model outside the target catalog, rejects an unprovisioned target profile, rejects a guardrail selection the target does not provision (naming its valid keys) and fails closed when that catalog is unreadable, lands every import as a draft never active, and verifies or rejects an optional signature. Lifecycle and resolution are covered by `backend/test/lib/profile-lifecycle.test.ts` and `backend/test/lib/active-profile.test.ts`; the runtime guardrail fallback chain by `backend/test/lib/guardrail-selection.test.ts`. The S3 body store is covered by `backend/test/lib/profile-bodies.test.ts` (the content-addressed key, and the two refusals: no bucket, mismatched configId), `backend/test/lib/profile-bodies-roundtrip.test.ts` (a persona larger than the definition parameter's own limit round-trips through write, activate and resolve; a pre-pointer inline persona still resolves; an unreadable body falls back to the seed; rollback re-points and writes nothing; export stays instance-agnostic and import lands the body in the target's store), and `backend/test/profile-body-store-grant.test.ts` (the synthesized template grants the writer both S3 verbs on the prefix, gives it the bucket, and lets every processor read it). The required import target is covered by `backend/test/manage-profiles.test.ts` (an import with no target, a blank one or a non-string one is refused `400 TARGET_REQUIRED` before anything is read; a manifest named `advisor` imported with `targetProfileName: finance-advisor` writes only `finance-advisor`'s draft; the team route lands on its own assistant with no target in the body). Discarding a draft is covered by `backend/test/lib/a-draft-is-discarded-only-as-it-was-seen.test.ts` (the delete happens only on the named `configId` and touches no definition, label, body or layout; a draft saved since is kept; no draft is its own answer; activation still consumes its draft; the team route is refused another assistant's draft and the team console role holds only the per-assistant route) and `frontend/packages/admin/src/components/admin/DiscardDraft.test.tsx` (the confirm names what is lost, Cancel sends nothing, a discard sends the loaded `configId` and offers New version again, a draft saved since is kept with the reason shown). The import UI is covered by `frontend/packages/admin/src/components/admin/ProfilesTab.import.test.tsx` (the list offers no import; the Versions group previews the source and the target, sends this assistant as the target only on confirm, writes nothing on Cancel, refuses a file that is not a manifest, and shows the server's reasons).

**Related:** [`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md) (the deployment configuration a version binds into), [`SPEC-PER-PROFILE-OWNERSHIP.md`](./SPEC-PER-PROFILE-OWNERSHIP.md) (the stack topology this layers over), [`SPEC-ASSISTANT-CONFIG.md`](./SPEC-ASSISTANT-CONFIG.md) (the behavioral bundle and the `configId` fingerprint), [`SPEC-CONFIGURABLE-ASSISTANTS.md`](./SPEC-CONFIGURABLE-ASSISTANTS.md) (the per-assistant axes that ride the versioned definition).

**Site section:** Interaction layer, assistants.

---

## Overview

**An assistant is a portable, versioned artifact on a governed platform, and the whole design rests on one line: behavior is data, a boundary is infrastructure.** Activating a new version, rolling one back, importing a profile that binds to an existing classification, or battling two versions is a data change - an SSM parameter version plus content-addressed bodies. New infrastructure is required only at a genuinely new boundary: a new classification, or a new instance or region.

Four things are kept apart, and keeping them apart is what makes the rest safe:

| Layer | What it is |
|---|---|
| **Classification** | A deployed security boundary: a data and sensitivity label that declares the set of classifications it grants, the immutable `classification` tag on a channel, and the IAM keyed on it. Adding one provisions a new boundary ([`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md), [ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md)) |
| **Assistant identity** | A named bot principal with its own IAM role, context scope, guardrail grants and model allowlist, provisioned inside a classification's boundary. It is the real per-principal boundary, and a classification may host more than one |
| **Profile** | What an assistant is: model bundle, persona, intent pack, onboarding, tools, guardrail selection, workflow selection, context-source selection, message templates (`messages`), the event workflows it declares (`eventWorkflows`), variables (`variables`), display name. Behavior, and therefore data |
| **Version** | An immutable snapshot of a profile's definition carrying a `configId` fingerprint. A profile is a named identity with an ordered history of versions; exactly one is served |

A **profile** is what an assistant is: model, persona/system prompt, intent pack, onboarding, tools, guardrail selection, classifier mode, timeouts and limits. **Only part of that rides a version.** Everything in the Profile row of the table above rides a version and is edited and exported. `classifierMode`, `timeoutSeconds`, `rateLimitPerHour` and `battleEligible` do not (Appendix A): each binds a cost or a resource the deployment owns rather than a thing the assistant says, and `versioned-profile-omits-deploy-time-fields.test.ts` fails if any of them reaches the versioned body.

**The versioned, portable unit is a named assistant, never a classification.** An assistant acts in exactly one classification ([ADR-042](../../../design/decisions/042-an-assistant-acts-in-exactly-one-classification.md)), and a profile belongs to that assistant rather than to the label the room carries.

**Portability and runtime editing are safe only because a version is behavior and never a principal.** A version changes what the assistant does, never who it is or what it may do. The bot identity, its ARN, its bearer pinning and its IAM role are deploy-time and stable, so activating, editing or importing a version never recreates a bot, mints IAM or rebinds an identity. Co-resident assistants at one classification are distinct principals, so a version of one can never widen into another's scope.

**One honest note, and it is not per-profile.** A battle needs a second assistant in the channel. It populates the classification's existing `alt` occupancy of the same role with an ordinary assistant whose version is derived from the live assistant plus the variant delta ([`DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md`](./DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md) section 3.0, [ADR-050](../../../design/decisions/050-the-alt-is-an-assistant-and-a-conversation-is-enrolled-once.md), [`SPEC-BATTLE.md`](../quality/SPEC-BATTLE.md)). Adding a profile adds no identity; battling any profile or version assigns it to the alt occupancy that already exists.

## Business Problem

A team that builds assistants wants to treat one like a product it iterates on: version it, test or battle a new version against the one in production, promote or roll it back, and move a proven assistant from staging to production or to another region. Doing any of that on a platform where the assistant's behavior is deploy-time configuration means an infrastructure change per prompt edit, which puts every wording change behind a release and makes a rollback a redeploy. The alternatives on the market are a single-tenant chatbot builder with no portability, or a versioning-and-promotion pipeline the team builds, secures and operates itself. What is wanted is an artifact that carries the behavior, leaves the boundary alone, and refuses to land on a deployment that cannot honor its references.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Three use this artifact, and they use it at different points in its life: authoring, promoting and comparing.

### AI developer

**How this relates to them:** they author the assistant, so the version is their unit of work. Every behavioral field they care about moves without a deploy, and every field they must not move is absent from the artifact rather than merely discouraged.

| What they need | Requirement |
|---|---|
| Edit an assistant's behavior and see it served, with no infrastructure change | FR1, FR2 |
| A persona and an intent pack that are not bounded by a parameter size limit | FR4 |
| A version history they can compare, and an immutable snapshot behind every analytics row | FR3, FR6 |
| A model, tool, guardrail, workflow and context-source selection validated at the write path rather than failing at runtime | FR7 |
| Two versions differing only in which tools the assistant may call, to answer whether a tool earns its place | FR11 |
| Certainty that nothing they can edit widens the boundary | FR8 |

### Admin / operator

**How this relates to them:** they promote, roll back and import, so what they need is that promotion is an explicit act, that rollback is instant, and that nothing lands active without a person looking at it.

| What they need | Requirement |
|---|---|
| Activation and rollback as a pointer move, instant and lossless | FR2, FR3 |
| A draft they decide against thrown away, without activating it and without losing an edit someone saved since | FR18 |
| An import that lands as a draft and never moves the active pointer | FR10 |
| An import that refuses a reference this deployment cannot honor, naming what it does offer | FR9 |
| Every mutating step gated on a capability that can be denied independently, and attributed to them | FR5 |
| A resolution path that falls back to the shipped seed rather than to no assistant | FR6 |
| Provenance saying which instance, profile and version an imported assistant came from | FR10 |

### QA / test engineer

**How this relates to them:** they gate a change on evidence, so they need the comparison to be over whole versions rather than over a model key, and they need the artifact to move between environments unchanged.

| What they need | Requirement |
|---|---|
| An experiment or battle variant that runs an entire profile version | FR11 |
| A comparison that cannot widen either side's access | FR8, FR12 |
| An export that is byte-identical in meaning on the target, with no source-instance identifiers in it | FR7 |
| A signature they can require, so an unverifiable manifest is refused | FR13 |
| An attribution key that names exactly the configuration that answered | FR3 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | An assistant's behavioral fields resolve from a versioned store at runtime, so editing and serving a new version is a data change with no infrastructure deploy | Differentiator | Yes | `active-profile` (unit, behavior), `profile-lifecycle` (unit, behavior), `portable-profile-lifecycle` (e2e, behavior) |
| FR2 | Editing never mutates a served version: an edit writes a draft, activation promotes it, and rollback re-points at a prior version with no data migration | Table stakes | Yes | `profile-lifecycle` (unit, behavior), `portable-profile-lifecycle` (e2e, behavior) |
| FR3 | Version numbers, history, the active pointer and rollback come from the parameter store's own native versions and labels, with no new datastore, and every analytics row maps to one immutable `configId` | Enabler | Yes | `profile-lifecycle` (unit, behavior), `active-profile` (unit, behavior), `profile-version-lookup` (unit, behavior) |
| FR4 | A large body - the persona and the intent pack - lives in object storage keyed by `configId`, the definition carries a pointer, nothing deletes an older body, and a version's `configId` is unchanged by where its body is kept | Enabler | Yes | `profile-bodies` (unit, behavior), `profile-bodies-roundtrip` (unit, behavior), `profile-body-store-grant` (unit, behavior), `portable-profile-gates` (e2e, behavior) |
| FR5 | Every mutating step requires `edit-profiles` (draft, discard, import) or `activate-profiles` (activate, rollback, promote), enforced where the request is served and distinct from every read capability, and is recorded against the server-verified actor | Differentiator | Yes | `manage-profiles` (unit, behavior) - **deny-test:** a caller without the capability is refused with 403; `admin-profiles` (e2e, behavior) |
| FR6 | Resolution fails closed to the compiled seed and never to "no profile": an unresolvable, invalid or unreadable active version, and an unreadable body, all serve the seed | Table stakes | Yes | `active-profile` (unit, behavior), `profile-bodies-roundtrip` (unit, behavior) |
| FR7 | Export is logical and instance-agnostic: models by catalog key, the guardrail by its catalog selection key, tools by name, bodies inlined, and no ARN, account id, secret or region anywhere in it | Differentiator | Yes | `profile-manifest` (unit, behavior), `portable-profile-lifecycle` (e2e, behavior) |
| FR8 | A version can carry no boundary field: the context scope, the guardrail as a resource and the model allowlist are taken from the compiled seed and the deployment's IAM, never from the stored definition | Table stakes | Yes | `versioned-profile-omits-deploy-time-fields` (unit, behavior), `active-profile` (unit, behavior), `portable-profile-gates` (e2e, behavior) - **deny-test:** activation is refused for a context key the deployment does not publish |
| FR9 | Import treats the manifest as untrusted and rejects rather than degrades: a model outside the target catalog, an unprovisioned target profile, a guardrail selection the target does not provision, a guardrail catalog that cannot be read, an unknown tool, a workflow key naming no available workflow, or a persona over the cap | Table stakes | Yes | `profile-manifest` (unit, behavior), `profile-lifecycle` (unit, behavior), `portable-profile-gates` (e2e, behavior) |
| FR10 | An import lands as a draft, never as the active version, and records where it came from - source instance, profile and version, plus the original content hash | Differentiator | Yes | `profile-manifest` (unit, behavior), `portable-profile-lifecycle` (e2e, behavior) |
| FR11 | An experiment or battle variant may reference a whole profile version rather than a model key, and the admin surface can pit any two profiles or versions against each other within a battle-capable classification | Differentiator | Yes | `experiment-manager.profile-ref` (unit, behavior), `variant-profile-resolved-once` (unit, behavior), `variant-model-key-in-catalog` (unit, behavior) |
| FR12 | A comparison cannot widen access: both sides run inside one channel's classification boundary | Table stakes | Yes | `experiment-manager.battle` (unit, behavior), `task-shaped-battle-parity` (unit, behavior) |
| FR13 | A manifest signature is optional, verified whenever present, requirable by policy, and an unverifiable or unsigned-where-required manifest is refused rather than silently trusted | Above bar - optional | Yes | `profile-manifest` (unit, behavior) |
| FR14 | Cross-region movement needs no extra mechanism: the manifest carries no region-bound identifier and import re-resolves every reference against the target | Differentiator | Partly - the manifest is region-agnostic and import re-resolves; actual cross-region use is bounded by Amazon Chime SDK Messaging region availability and is not exercised | `profile-manifest` (unit, behavior) |
| FR15 | Two versions of one profile serve live traffic under a weighted split, for in-production A/B rather than an operator-launched battle | Above bar - optional | Yes - by conversation: every experiment armed with two pinned versions (all four types) enrolls each conversation created while it runs in one arm and serves it that arm's version whole while the experiment is active; a pause or an end returns the conversation to the live active version (amended 2026-10-15) ([ADR-050](../../../design/decisions/050-the-alt-is-an-assistant-and-a-conversation-is-enrolled-once.md)) | `a-conversation-is-enrolled-once`, `an-ended-experiment-releases-its-conversations` (unit, behavior) |
| FR16 | An experiment axis of `intent -> tools`, so a tool's value is measured per intent rather than per assistant | Above bar - optional | No | none |
| FR17 | A multi-assistant scenario exports as one composition manifest - the conversation type's assistant list plus each referenced assistant's profile manifest | Differentiator | No | none |
| FR18 | A draft can be discarded without activating it, and only the draft the caller saw: `POST /admin/profiles/discard` (and the team route `/admin/assistants/{assistant}/profiles/discard`, both `edit-profiles`) names the draft's `configId`; the draft parameter is deleted only while it still holds that `configId` (the compare `consumeDraft` makes at activation), a draft saved since is kept and refused `409 DRAFT_CHANGED` with its `configId`, no draft is `404 NO_DRAFT`, and the content-addressed bodies and layout stay because a version may share them. The console offers Discard draft on the draft's banner, on an assistant's page and as the creation wizard's last step, behind a confirm naming what is lost | Table stakes | Yes, built and not deployed - `discardDraft` (`lib/profile-lifecycle.ts`), the `/discard` branch of `manage-profiles.ts`, `DiscardDraft` (`DraftControls.tsx`, `AssistantPage.tsx`, `ProfilesTab.tsx`) | `a-draft-is-discarded-only-as-it-was-seen` (unit, behavior) - **deny-test:** a team route scoped to one assistant is refused another's draft (`403 ASSISTANT_MISMATCH`, the draft kept), the team console role is granted only the per-assistant route and never `POST /admin/profiles/discard` (synthesized), and a session naming one assistant does not reach another's route; `DiscardDraft` (unit, behavior) |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/`, with the shared-library ones under `backend/test/lib/`; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists.

**Acceptance criteria.** An edit followed by an activation changes what a turn serves with no stack deployed. A rollback restores the prior behavior with no write to the body store. An export from one instance imports on another as a draft whose guardrail resolves to the target's own provisioned resource. A manifest naming a model, tool, guardrail or workflow the target does not have is refused with the target's valid options named. A caller without `edit-profiles` or `activate-profiles`, as the route requires, is refused at the gateway on every mutating route. An invalid stored version serves the seed rather than nothing. A discard deletes the draft the caller named and keeps one saved since.

**OPEN:** whether a per-assistant **workflow selection** belongs in this document's field list or wholly in [`SPEC-TASK-STATE-TRANSITIONS.md`](../conversation/SPEC-TASK-STATE-TRANSITIONS.md). The selection rides the versioned definition and is validated at the write path; the graphs it selects from are the platform's and a classification's, and are not part of a version.

**OPEN:** the version identifier. A monotonic integer is simple and ordered; a semantic version would convey compatibility. The store supplies integers.

**OPEN:** whether the runtime-editable store and a git-tracked, reviewable manifest should coexist, with git as the source for seeded and reviewed profiles and the parameter store as the runtime-active pointer.

**OPEN:** manifest residency and retention. A manifest carries persona and intent-pack bodies, so exporting one moves that content across an instance and possibly a region boundary. The provenance chain is the audit hook and the optional signature is the integrity one; the residency posture is not settled.

**OPEN:** corpus portability. A manifest references a document-set manifest rather than the corpus, because corpora are large and classification-bound. How much travels with the profile and how much is re-ingested on the target is its own design.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| A new datastore for versions | The parameter store already supplies monotonic versions, history and labels. A table would duplicate all three, add a resource to provision and secure, and split the source of truth from the keys the runtime already reads | This document's appendix on storage; the only reason to revisit is an edit frequency an operator-edited artifact does not reach |
| Task graphs as a per-assistant definition | Graphs are global: the platform owns a set, and a classification may add its own on its intent pack. A version selects from what exists and can never define one, or a selection would silently strip the queue machinery from the assistant that made it | [`SPEC-TASK-STATE-TRANSITIONS.md`](../conversation/SPEC-TASK-STATE-TRANSITIONS.md) - the reference workflows, the platform machines, and why a selection narrows only the former |
| Changing a classification, a context scope, a guardrail resource or a model allowlist from a version | These are the boundary, so they are infrastructure. A version selects among provisioned resources and never points at an arbitrary one | FR8, and [`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md) decision D-3 |
| Auto-activating an import | An import is reviewed and then activated by a person. Landing active is how an unreviewed artifact starts serving traffic | FR10 |
| Changing the intent pack inside an experiment variant | An experiment compares two implementations of the same assistant; a side serving different use cases produces a score the other side cannot be compared against | FR11 - a variant may change the model, persona, tools, guardrail, context sources or workflow selection |
| Carrying a storage pointer in a manifest | A stored bucket would aim the target instance at the source account's storage. Export follows the pointer and inlines the body; import writes it into the target's own store | FR7, and the appendix on storage |
| Shipping the corpus with the profile | Corpora are large and classification-bound. A referenced document-set manifest travels; the documents do not | The corpus-portability OPEN above |

## User Experience Description and Mocks

An AI developer works in the admin console's Profiles surface, and the whole point of the design is that nothing they do there waits on a deploy.

1. **Open the list of profiles, and see each one's versions.** The surface loads the portable artifacts from the live management API, so what it lists is what is actually stored.
2. **Create a version.** It clones the served version into a draft with the next number, copying its definition.
3. **Edit the draft.** Behavioral fields only: the model bundle, the persona, the intent pack, the tool allowlist, the guardrail selection, the workflow selection, the context-source selection, onboarding, the boundary line, the message templates (`messages`), the event workflows (`eventWorkflows`), the variables (`variables`) and the display name. A retired `copy` or `welcome` field is refused (`retiredCopyErrors`, `retiredWelcomeErrors`, `lib/profile-copy-fields.ts`). The write path validates the draft and re-computes its `contentHash` and `configId`.
4. **Be refused early where a selection cannot be honored.** A model outside the allowlist, an unknown tool, a workflow key naming no available workflow, a context key the deployment does not publish, or a persona over the cap each fail at the write rather than at the next turn.
5. **Activate.** The served pointer moves to this version, and readers converge within the resolution cache's short lifetime. Renaming is an ordinary versioned edit, and activation also puts the name onto the assistant's identity, so the name in the room and the name in the console move together.
6. **Roll back.** Re-activating a prior version is itself an activation: a pointer move, instant and lossless, writing no body.
7. **Compare before promoting.** An experiment compares the version that is serving with a published candidate version (not a draft): a `profile` experiment references the candidate, and the other types derive it from the live version by their recipe into the alt's history. The operator reads the objective's verdict, attributed by `configId`. The Promote action copies the measured candidate into the live assistant as a new version and activates it, refused unless the live version is still the experiment's control and the copy hashes to the measured `configId`; the new version records `promotedFrom` ([DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP](../quality/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md) §3.6). Between instances, export and import as a draft stays the path.
8. **Export, and import elsewhere.** Export produces one instance-agnostic JSON document. Import on the target validates it against that deployment's own catalogs, lands it as a draft, and records where it came from. A person activates it.

The operator view of the comparison step is [`GUIDE-AB-TESTING-AND-BATTLES.md`](../../../guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md).

**OPEN:** this document carries no mocks. The surface exists, and whether it warrants a rendered mock alongside the console's other views is unsettled.

## Related Documents

- [`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md) - the deployment configuration a version binds into, and the declared-grant classification model
- [`SPEC-PER-PROFILE-OWNERSHIP.md`](./SPEC-PER-PROFILE-OWNERSHIP.md) - the per-classification stack topology this layers over
- [`SPEC-ASSISTANT-CONFIG.md`](./SPEC-ASSISTANT-CONFIG.md) - the behavioral bundle and the `configId` fingerprint this extends to a per-version identity
- [`SPEC-CONFIGURABLE-ASSISTANTS.md`](./SPEC-CONFIGURABLE-ASSISTANTS.md) - the per-assistant axes that ride the versioned definition
- [`SPEC-CONFIGURABLE-INTENT-PACK.md`](./SPEC-CONFIGURABLE-INTENT-PACK.md) - the taxonomy a version may carry
- [`SPEC-CONTEXT-SOURCES-AND-STORES.md`](./SPEC-CONTEXT-SOURCES-AND-STORES.md) - the storage keys this uses, and the context-source catalog a version selects from
- [`SPEC-TASK-STATE-TRANSITIONS.md`](../conversation/SPEC-TASK-STATE-TRANSITIONS.md) - global workflows, and what a version's selection narrows
- [`SPEC-BATTLE.md`](../quality/SPEC-BATTLE.md) - the duel that assigns a version to the alt occupancy
- [`DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md`](../governance/DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md) - how the profile capabilities (`edit-profiles`, `activate-profiles`) become IAM-enforceable
- [`GUIDE-AB-TESTING-AND-BATTLES.md`](../../../guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md) - the operator view of a comparison
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above
- [ADR-042](../../../design/decisions/042-an-assistant-acts-in-exactly-one-classification.md), [ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md), [ADR-049](../../../design/decisions/049-a-deployment-descriptor-contains-only-what-is-consumed-before-the-request-runs.md)

## Appendix A - What a version stores

The stored definition is the runtime-editable subset of the behavioral bundle, not the whole of it. `ProfileDefinitionBody` in `backend/lambda/src/lib/active-profile.ts` carries the model bundle, the tool allowlist, the guardrail selection, the intent pack, onboarding, the boundary line, the message templates it selects (`messages`), the event workflows it declares (`eventWorkflows`, ADR-061 decision 1), its variables (`variables`), the display name, the workflow selection, the context-source selection and the persona. `ProfileDefinition` wraps that body with `schemaVersion`, `profileName` and `configId`, plus the pointers that replace an offloaded body and, on a version a duel derived, the experiment and variant it came from.

**Deploy-time fields are deliberately absent from what a version stores and from what identifies it.** The classifier mode, the processor timeout, the rate limit and the battle capability are consumed before the request runs and are read from the deployment descriptor, not from a version ([ADR-049](../../../design/decisions/049-a-deployment-descriptor-contains-only-what-is-consumed-before-the-request-runs.md)). Storing them hashed two versions differing only in one of them to two `configId` values for the same behavior.

**Boundary fields are never stored or served from a version.** Above all the context scope, which is an object-read IAM grant: resolution always takes it from the compiled seed.

**Lifecycle metadata is the store's, not the JSON's.** Version numbers, the served label, the distinction between a served and a superseded version, and rollback are the parameter's own native versions plus its label. Provenance that the store cannot supply - where an imported draft came from, and its original content hash - is written onto the draft.

**The pointers are envelope rather than body.** An offloaded persona or intent pack is referenced by a pointer that is excluded from the hash, so the same persona hashes identically inline or offloaded. Migrating a deployment onto the body store therefore neither re-keys its analytics nor invalidates an exported manifest.

**The model selection is itself per-profile and per-intent.** A version's model field is a bundle: a base model, a classifier model, an image model, and per-intent overrides each carrying an intent's primary plus an optional resilience fallback. Per-intent model routing therefore lives on the profile version rather than in a global strategy table. Every model in the bundle is bounded by the classification's model allowlist, validated at the write path. A `'default'` sentinel records "follow the classification-set default" as an explicit choice that tracks the platform default over time rather than pinning today's model into the version; the seed uses it for the classifier.

**The bundle carries no switch for leaving AWS.** Whether an assistant may send a turn to a provider outside AWS is its classification's model selection ([SPEC-CONTEXT-AWARE-MODEL-ROUTING.md](./SPEC-CONTEXT-AWARE-MODEL-ROUTING.md)): the deployment decides it for the classification, and every assistant of the classification shares it. A stored version or an imported manifest that names the retired `models.externalProviderAllowed` field is read as if it did not, and the version written from it leaves the field out. An import into another classification re-checks every model the bundle names against the target's selection, so a manifest cannot carry a model the target does not select.

**The tool surface is likewise data.** A version's tool allowlist is validated against the tool registry at the write path, and the seed writes the full registry set, so an operator restricts a profile by removing tools. Because the definition includes the allowlist, two versions can differ only in which tools the assistant may call, which is how a tool is asked to earn its place.

## Appendix B - Where it lives

Profiles already publish to `assistant/{name}` parameters in AWS Systems Manager Parameter Store, and the deployment already owns an object store that large bodies can live in. This design reuses both and adds no new datastore.

- **Versioning is the parameter store, natively.** A profile's definition, minus the large bodies, is a single parameter `/{instance}/assistant/{name}/definition`. Every edit is a write, which the store stamps with a monotonic version number, and that is the version history. A label points at the served version; resolving by label reads it, parameter history lists the versions, and rollback is re-labeling a prior version.
- **Drafts** are a sibling `/{instance}/assistant/{name}/draft` parameter until activation promotes them.
- **Bodies are object storage.** A version's large bodies live under `profiles/{profileName}/{configId}/` in the attachments bucket, content-addressed and immutable, and the definition carries a pointer plus `configId`. This covers the persona and the intent pack, and the console's workflow layout (where each event workflow step sits on the builder's canvas), which is not hashed into `configId` and so is keyed `profiles/{profileName}/{configId}/layout/{contentId}`: one key per layout, still written once and never overwritten, read only by the console and carried inline beside the body by an export (`workflow-layout.ts`, verified by `backend/test/lib/a-workflow-layout-rides-the-version.test.ts`). Content-addressing is what makes activation and rollback re-point at an existing body instead of rewriting one, and nothing deletes: an older version's body has to survive for a rollback to it to mean anything. The bucket is deliberately not stored in the pointer, because a stored bucket name would travel with an export and aim a target instance at the source account's storage.
- **Why the indirection is load-bearing.** One definition is one standard-tier parameter, capped at 4096 characters for the whole serialized value, while a persona is allowed considerably more. Without the pointer, a persona in that gap passes schema validation and then fails at the write.
- **Why the intent pack is on the same path.** It is content an operator writes and it grows with what they have to say. Held inline, the parameter cap became the binding constraint on the taxonomy, which is how the platform intents ended up inherited but not practically editable: restating one of them cost most of the remaining budget. Its structure is still validated inline before offload, so the write path that reconciles the per-intent model map against the pack's keys has both halves in hand.
- **The stored pack keeps its `extends` declaration** rather than being resolved at the write, so a pack declares only what it adds and a partial override can change one field of an inherited intent without restating the rest. It is resolved at read time, so every reader downstream takes a pack it can use directly. A version carrying no pack inherits the per-classification parameter, which stays the fallback seam.
- **Onboarding, the boundary line, the message selections and the variables ride the definition inline**, each bounded by its own field list and small enough not to warrant a body.
- **The event workflows ride it inline too**, bounded in count, steps and size (`versionEventWorkflowsErrors`). They name templates, tools and conversation types only, never an ARN, so they travel with an export as written. An import validates them in the target: the platform's workflow rules, the target's templates of the kind each step needs, and the tools the version holds (`eventWorkflowTemplateErrors`, `welcomeWorkflowErrors`, `profile-manifest.ts`), verified by `backend/test/lib/a-version-declares-its-event-workflows.test.ts`.
- **Bodies are fetched in one pass** rather than serially, because resolution sits on the per-turn cold path.
- **Seed is the shipped default.** Each profile's shipped config is written once as version 1 and labeled as served, so a deployment that never edits a profile behaves exactly as the compiled configuration says.
- **Resolution** reads the labeled definition, cached per execution environment with a short lifetime; an activation re-labels and readers converge within it.

## Appendix C - Lifecycle, export and import

Every mutating step requires `edit-profiles` (draft, discard, import) or `activate-profiles` (activate, rollback, promote), enforced where the request is served, and is recorded against the server-verified actor.

- **create-version** - clone the served version into a new draft with the next number.
- **edit-draft** - modify behavioral fields on a draft only; re-hash the content hash and recompute `configId`.
- **validate** - the synth-time checks of [`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md) plus the boundary checks: every model within the deployment's allowlist, the context scope and guardrail provisioned, tools a subset of the registry, workflow keys naming workflows that exist.
- **activate** - move the served label to this version; the previous one is retained for history and rollback.
- **rollback** - re-activate a prior version, which is itself an activation and needs no data migration.
- **discard** - delete the draft without activating it, named by the `configId` the caller saw. A draft saved since is kept and refused `409 DRAFT_CHANGED`; no draft is `404 NO_DRAFT`. Bodies and the layout object are content-addressed and stay. Nothing serving changes (FR18).

**Export** serializes the definition with its bodies inlined, its schema version, its provenance and its content hash into one JSON document. The manifest is logical and instance-agnostic: a model by catalog key rather than by model ARN, a guardrail by its catalog selection key rather than by the id resolved on the authoring instance, and tools by name. It contains no ARN, no account id, no secret and no region.

Inlining is a deliberate asymmetry with storage rather than an inconsistency: storage keeps the persona in object storage and the definition holds a pointer, but a manifest carrying that pointer would describe the source instance's storage, which is exactly what a portable artifact must not do. So export follows the pointer and emits the body, and import writes the body into the target's own store and keeps a target-local pointer. The manifest size bound is derived from the persona cap for the same reason: a bound that could not hold a full persona would make export produce manifests import refuses.

The guardrail is the one field whose stored form is instance-bound, because a version records the id resolved at deploy time. Export rewrites it to the catalog key before serializing. Without that rewrite the manifest carries an opaque id that names nothing on any other instance, and it evades the "no ARNs, no account ids, no region" check precisely because it is none of those things. When the selection cannot be mapped - an unreadable catalog, or an id predating it - export emits it verbatim and warns rather than failing: export is read-only, and import is the gate that fails closed.

**Import** treats the manifest as untrusted input. It validates against the schema and bounds the size, verifies a signature where one is present or required, then validates against the target's own capabilities, then lands the result as a new draft:

1. **Model** - the catalog key exists in the target and is within its model allowlist, or the operator explicitly remaps it. Unresolvable, reject.
2. **Guardrail** - the selection resolves against the target's own published catalog: a catalog key remaps to the id this instance provisioned for it, an id already provisioned here passes through unchanged, and anything else is rejected with the target's valid keys named so an operator can remap it. A catalog that cannot be read is also a reject, because a selection that cannot be verified is never landed. An absent selection inherits the deployment default. IAM is the backstop: the guardrail-apply grant is per provisioned resource.
3. **Tools** - every tool is in the registry. Unknown, reject.
4. **Workflows** - every key in the selection names a workflow this deployment has, listing what it does offer otherwise.
5. **Context sources** - every key resolves against the target's own published catalog.
6. **Target profile** - the profile the manifest lands on is provisioned here. Unprovisioned, reject. The target is named by the request (`targetProfileName`), or by the path on a team route, and is required: the manifest's own `profileName` records where it came from and never decides where it lands, so a request without a target is refused (`400 TARGET_REQUIRED`).
7. **Schema** - the schema version is compatible. Additive changes that both spellings of a field accept do not bump it, because bumping would reject every earlier export for no gain in safety.

On success the draft records where the assistant came from - source instance, profile and version, plus the original content hash - a full audit chain. **Cross-region falls out of the same property:** the manifest carries no region-bound identifier and import re-resolves everything against the target, so another region is another import target, bounded only by Amazon Chime SDK Messaging's own region availability. **Import cannot escalate:** an imported profile carries no identity and no IAM. It is behavior only, validated against the target's authoritative identities, roles, classifications, guardrails and catalogs, and it fails closed when a reference is unprovisioned.

## Appendix D - What this relaxes, and what it does not

[`SPEC-PER-PROFILE-OWNERSHIP.md`](./SPEC-PER-PROFILE-OWNERSHIP.md) froze four things, and these are the four this document relaxes:

| That document's constraint | What it becomes here |
|---|---|
| Deploy-time configuration only, with no runtime editing | Behavioral fields resolve from the served version at runtime; a version is created, edited and activated with no redeploy |
| A profile is a single implicit thing | A profile is a named identity with an ordered history of versions, one of them served |
| A profile is a code constant and is not portable | A version serializes to a self-contained, instance-agnostic manifest that exports and imports across instances and regions |
| One profile per classification | The one-to-one is profile-to-assistant-identity, not profile-to-classification. A classification hosts one assistant in the shipped sample and N in a multi-assistant conversation, each its own identity with a scope no wider than the boundary |

Nothing about enforcement changes. The tag key and its immutability, fail-closed resolution, and assistant bearer pinning are the same on either side of this layer, and the fields a version may not carry are the reason that is true.

## Appendix E - Delivery phases

Each phase is independently deployable, and each builds on the one before it. Delivery status for every requirement is in the requirements table; this appendix records the dependency order of the phases.

| Phase | Contents |
|---|---|
| **0 - Store and decouple** | Definitions in the parameter store with native versions and a served label, bodies in object storage, the runtime reading its profile-varying fields from the served version, and a seed identical to the compiled configuration |
| **1 - Versioning** | create and edit behind `edit-profiles`, activate and rollback behind `activate-profiles`, and an admin surface listing profiles and versions |
| **2 - Comparison over any version** | Variants that reference a whole version, and a comparison over any two within a battle-capable classification |
| **3 - Portability** | The export manifest, an import that lands a validated draft and fails closed, and the provenance chain |
| **4 - Region-agnostic manifests and hardening** | Import re-resolving every reference against the target, and manifest signing |
| **5 - Per-assistant axes** | The guardrail selection, the workflow selection and the context-source selection riding the versioned definition and traveling with it, each selecting among deployment-provisioned resources ([`SPEC-CONFIGURABLE-ASSISTANTS.md`](./SPEC-CONFIGURABLE-ASSISTANTS.md)) |
