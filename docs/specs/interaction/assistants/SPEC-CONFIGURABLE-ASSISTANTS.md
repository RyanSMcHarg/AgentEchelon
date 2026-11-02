# SPEC: Configurable assistants - three per-assistant config axes on one governed boundary

**Status:** Implemented

**Coverage:** `tests/e2e/profile-config.spec.ts`

**Verified by:** `backend/test/cdk-synth.test.ts` (describe 'Layer 4 / §7 - IAM resource boundaries (deny-by-absence...)' - each classification's S3 context read EXCLUDES every prefix its grants do not declare, the assistant role holds `GetItem` and `UpdateItem` on the channel-context store and never `PutItem`, `DeleteItem`, `Scan` or `Query`, no Cognito/Identity-Pool role references the store at all, and `bedrock:ApplyGuardrail` is scoped to provisioned guardrails, never `*`; plus describe 'Layer 1 - per-tier fail-closed channel-tag allow'), `backend/test/lib/guardrail-catalog.test.ts` (default vs strict guardrail policy - strict adds a blocked term), `backend/test/task-state-machines.test.ts` and `backend/test/lib/task-loop-machines.test.ts` (task-machine graph validation, and the loop honoring exactly the machine set its caller hands it), `backend/test/lib/profile-lifecycle.test.ts` (a version that tries to DEFINE a workflow is refused, and the error says where workflows live), `backend/test/lib/active-profile.test.ts` (a version's models/tools/guardrailId surface on the resolved profile and fail closed to the seed on an invalid version), and `tests/e2e/profile-config.spec.ts` (a strict-selecting profile masks a term the default does not, and config survives export/import; gated `PROFILE_CONFIG_E2E=1`).

**Related:** [`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md) (the versioned artifact these selections ride), [`SPEC-ASSISTANT-CONFIG.md`](./SPEC-ASSISTANT-CONFIG.md) (the bundle they are fields of), [`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md) (the classification whose boundary bounds them), [`SPEC-TASK-STATE-TRANSITIONS.md`](../conversation/SPEC-TASK-STATE-TRANSITIONS.md) (the global workflows a selection narrows).

**Site section:** Interaction layer, assistants.

---

## Overview

**Three things that distinguish one assistant from another - what it may read, what work it may open, and what content policy filters it - are per-assistant configuration that rides the versioned profile definition, and all three are selections bounded by infrastructure a version can never widen.** That is the whole of the invariant these axes share: a profile **selects** among resources the deployment provisions and can never point at an arbitrary one.

| Axis | What a version says | What bounds it |
|---|---|---|
| **Context scope** | Nothing. It is read from the compiled seed | One resolver drives both the object-read IAM grant and the retrieval walk, so they cannot drift |
| **Workflow selection** | Which of the available task graphs this assistant may open, by key | The graphs themselves are the platform's, plus any a classification adds on its intent pack. A selection narrows the reference workflows and never the platform machines |
| **Guardrail selection** | Which provisioned catalog entry to apply, by key | The guardrail-apply grant is per provisioned resource, never a wildcard |

**Widening any of the three fails the synth-time IAM assertions, so a widened boundary breaks the build rather than shipping.** That is the reason these axes can be operator-editable data at all.

**A graph is not a per-assistant definition, and a selection is.** Task graphs are global workflows: the platform owns a set whose queue machinery code depends on by name, and a classification may add its own on its intent pack. A profile version that tries to define one is refused at the write path, with the refusal naming where graphs live, and a version stored with one normalizes away on read rather than being discarded - because the read-path validator fails closed to the compiled seed, and a narrowing must not be able to delete a deployment's whole configuration.

**A fourth selection exists and is specified elsewhere.** Which context sources an assistant draws on, by catalog key, rides the same versioned definition and is bounded the same way ([`SPEC-CONTEXT-SOURCES-AND-STORES.md`](./SPEC-CONTEXT-SOURCES-AND-STORES.md)).

## Business Problem

A business shaping distinct assistants for distinct experiences wants each one's readable context, task behavior and content policy to be configuration rather than a code fork per variant. Without that, an organization that wants a triage assistant and a report assistant ends up with two branches of the same handler, and the difference between them lives in whichever branch was deployed last. Building the config layer instead is not free either: the layer has to be the thing that cannot widen a boundary, or it becomes the easiest way to grant an assistant a read nobody approved. What is wanted is per-assistant configuration bounded by the same IAM boundary the deployment already enforces, where an attempt to widen is a build failure rather than a production incident.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Two use these axes directly, and the split is between shaping an assistant and governing its scope.

### AI developer

**How this relates to them:** this is where one assistant stops being a copy of another. They pick the content policy, the work it may open and the sources it draws on, and they do it as a versioned edit rather than as a branch.

| What they need | Requirement |
|---|---|
| A content policy per assistant, selected from what the deployment provisions | FR4 |
| Only the workflows this assistant should open, selected from what the platform and its classification's pack define | FR8, FR9 |
| Only the work this assistant should offer, and nothing that removes the queue machinery | FR9 |
| A selection that travels with an export and resolves on the target | FR7 |
| Confidence that no selection they write can widen what the assistant reads | FR1, FR2, FR11 |

### Admin / operator

**How this relates to them:** they govern scope, so what they need from these axes is that the boundary is enforced where the request is served, that an unusable selection degrades to the deployment default rather than to no filtering, and that private grounding is unreadable by anyone in the room.

| What they need | Requirement |
|---|---|
| Object reads granted only on the classification's declared grant set | FR1, FR2 |
| A guardrail grant per provisioned resource rather than a wildcard | FR5 |
| A selected guardrail that cannot be applied still filtered by the deployment default | FR6 |
| Private host grounding that no channel member or pool principal can read | FR10 |
| A widened boundary that fails the build rather than the deployment | FR11 |

**Also served, and not a persona in `PERSONAS.md`:** the **deployer**, who extends or replaces the shipped guardrail catalog with their own industry-specific entries.

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | The object-read IAM grant and the retrieval walk derive their context prefixes from one resolver, so a renamed or added classification cannot drift the boundary apart from what retrieval reads | Table stakes | Yes | `cdk-synth` (unit, behavior), `classification-context` (e2e, behavior) |
| FR2 | A prefix outside the classification's declared grant set is absent from the policy rather than explicitly denied, so an unexpected value is refused by absence | Table stakes | Yes | `cdk-synth` (unit, behavior) - **deny-test by absence** |
| FR3 | Retrieval orders the prefixes so the serving classification's own documents survive a character budget first | Enabler | Yes | none |
| FR4 | A deployment provisions a guardrail catalog and a profile selects an entry from it; an absent selection inherits the deployment default | Differentiator | Yes | `guardrail-catalog` (unit, behavior), `active-profile` (unit, behavior), `profile-config` (e2e, behavior) |
| FR5 | The guardrail-apply grant is scoped per provisioned resource, never a wildcard and never a raw arbitrary ARN | Table stakes | Yes | `cdk-synth` (unit, behavior) - **deny-test by absence** |
| FR6 | A selected guardrail that cannot be applied for any reason falls back to the deployment default and re-applies; only a failure of the default itself fails open | Table stakes | Yes | `guardrail-selection` (unit, behavior) |
| FR7 | The guardrail selection travels across instances as its catalog key rather than a resolved id, and import resolves it against the target's own catalog or rejects it | Differentiator | Yes | `profile-manifest` (unit, behavior), `profile-config` (e2e, behavior) |
| FR8 | A version selects which task graphs the assistant may open and can never define one: a version carrying a graph is refused at the write path with the refusal naming where graphs live, and a version stored with one normalizes away on read rather than discarding the definition | Table stakes | Yes | `profile-lifecycle` (unit, behavior), `task-state-machines` (unit, behavior), `task-loop-machines` (unit, behavior) |
| FR9 | The selection gate applies at every door that opens work - the ordinary intent path and the comparison path alike - and exempts the platform machines, so a selection can never strip the queue machinery | Table stakes | Yes | `battle-turn` (unit, behavior), `profile-lifecycle` (unit, behavior) - a selection naming a graph that does not exist is refused |
| FR10 | A conversation's private host grounding lives in a server-only store: the conversation-create, member-add and conversation-split paths and the assistant handler patch it, the assistant handler reads it, and it is granted to no channel member, user-pool or identity-pool principal | Differentiator | Yes | `cdk-synth` (unit, behavior) - **deny-test by absence:** the handler holds `GetItem` and `UpdateItem` and never `PutItem`, `DeleteItem`, `Scan` or `Query`, and the authentication stack references the store from no role |
| FR11 | Widening any of these boundaries fails the synth-time IAM assertions, so a widened boundary breaks the build rather than shipping | Enabler | Yes | `cdk-synth` (unit, behavior) |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/`, with the shared-library ones under `backend/test/lib/`; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists.

**Acceptance criteria.** A profile selecting the strict guardrail masks a term the default does not, and keeps doing so after an export and an import onto another instance. A profile whose guardrail selection cannot be applied still has the deployment default applied to both input and output. A version that declares a task graph is refused at the write path, and one stored earlier with a graph still activates and serves. A profile whose workflow selection omits a reference workflow cannot open it from either door, and can still open every platform machine. No classification's role carries an object read on a sibling's context prefix, and no pool principal carries any access to the private grounding store.

**OPEN:** what asserts FR3. The retrieval walk and the IAM generator take the same prefix list, and the ordering that protects the serving classification's own documents under a character budget is not asserted separately.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| A per-assistant task-graph definition | Graphs are global. Code depends on the platform machines by name, and a per-assistant definition would let a narrowing break the turn queue for a reason nobody would connect to a workflow list | [`SPEC-TASK-STATE-TRANSITIONS.md`](../conversation/SPEC-TASK-STATE-TRANSITIONS.md) - the two kinds of shipped machine, and what a selection narrows |
| A context scope a version may set | It is an object-read IAM grant, so it is the boundary. Resolution always takes it from the compiled seed | FR1, and [`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md) on the behavior-versus-boundary cut |
| Pointing at an arbitrary guardrail resource | The apply grant is per provisioned resource, so an arbitrary id is refused by IAM even where a selection got through | FR5, FR6 |
| Narrowing the guardrail fallback to one error class | An unprovisioned id, a selection key used where an id belongs, and an id carried in from another deployment each raise a different error. Treating only the first as recoverable let the other two pass a turn through unfiltered on both input and output | FR6 - a selection that will not apply is a misconfiguration whatever the error is named |
| Private grounding in member-readable channel metadata | Members hold the update permission on channel metadata, so nothing private and nothing trusted can be sourced from it | [`SPEC-CONVERSATION-SECURITY.md`](../governance/SPEC-CONVERSATION-SECURITY.md), [`ACCESS-CONTROL-BY-EXAMPLE.md`](../governance/ACCESS-CONTROL-BY-EXAMPLE.md) |
| The context-source selection | It is a fourth per-assistant selection on the same terms, specified with the catalog it selects from | [`SPEC-CONTEXT-SOURCES-AND-STORES.md`](./SPEC-CONTEXT-SOURCES-AND-STORES.md) |

## User Experience Description and Mocks

**These axes have no surface of their own: they are fields on the versioned definition an AI developer edits in the admin console's Profiles surface** ([`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md)). What is specific here is what the developer sees when a selection is wrong.

1. **Pick a guardrail** from the keys the deployment publishes for this profile. An absent selection means the deployment default, stated as such rather than left blank.
2. **Pick the workflows this assistant may open**, from the graphs this deployment has. An absent selection means every available workflow.
3. **Be refused at the write, with the alternatives named.** A guardrail selection the target does not provision, or a workflow key naming no available graph, fails the edit and the error lists what this deployment does offer, so remapping is a choice rather than a guess.
4. **Try to define a graph, and be told where graphs live.** A version carrying a task graph is refused with the reason, rather than accepted and silently ignored.
5. **Read the result as behavior.** A strict-selecting profile masks a term the default does not, and keeps masking it after the profile is exported and imported onto another instance.

**OPEN:** this document carries no mocks, and the surface it would mock is the Profiles editor rather than anything of its own.

## Related Documents

- [`SPEC-ASSISTANT-CONFIG.md`](./SPEC-ASSISTANT-CONFIG.md) - the bundle these axes are fields of
- [`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md) - the versioned artifact that carries the selections, and the behavior-versus-boundary cut
- [`SPEC-CAPABILITY-PROFILES.md`](./SPEC-CAPABILITY-PROFILES.md) - the classification whose declared grants bound the context read
- [`SPEC-CONFIGURABLE-INTENT-PACK.md`](./SPEC-CONFIGURABLE-INTENT-PACK.md) - the intent taxonomy, and the graphs a classification may add on it
- [`SPEC-TASK-STATE-TRANSITIONS.md`](../conversation/SPEC-TASK-STATE-TRANSITIONS.md) - global workflows, the platform machines, and the wait declaration
- [`SPEC-CONTEXT-SOURCES-AND-STORES.md`](./SPEC-CONTEXT-SOURCES-AND-STORES.md) - the context-source catalog and the storage keys
- [`SPEC-CONVERSATION-SECURITY.md`](../governance/SPEC-CONVERSATION-SECURITY.md) and [`ACCESS-CONTROL-BY-EXAMPLE.md`](../governance/ACCESS-CONTROL-BY-EXAMPLE.md) - the IAM boundary the context, guardrail and grounding grants sit on
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above

## Appendix A - The three axes in detail

Sub-section numbers here match the informal references code comments use and are kept.

### 4.1 Context-scope unification

The object-read IAM grant on `context/{classification}/` and the retrieval walk both derive their prefixes from one resolver, so a renamed or added classification can never drift the IAM boundary apart from what retrieval actually reads.

- **The resolver:** `ProfileRegistry.contextPrefixesGranted` in `backend/lib/profile-registry.ts`, which derives the prefixes from `grantsFor`, for `contextScope: 'granted'`.
- **IAM, the boundary:** the `ContextS3Read` document on each classification stack's processor role in `backend/lib/stacks/assistant-profile-stack.ts`, with prefixes from `classificationsAllowedFor`, itself `grantsFor`. A classification reads the prefixes of its declared grant set and no others; a prefix outside it is absent, so a read against it is denied by absence rather than by an explicit deny.
- **Retrieval:** `backend/lambda/src/lib/company-context.ts` walks the same resolver, asking for the reversed order so the serving classification's own documents survive a character budget first.
- **Asserted by** `backend/test/cdk-synth.test.ts` in its Layer 4 resource-boundary block: `basic` excludes `standard` and `premium`, `standard` excludes `premium`, and `premium` covers the set its grants name.

### 4.5 Per-assistant workflow selection

A profile version says which of the available task graphs the assistant may open. It cannot say what a graph is.

- **Selection, not definition:** `workflows` on the stored definition is a list of keys. `editDraft` in `backend/lambda/src/lib/profile-lifecycle.ts` refuses a patch carrying a graph, with the refusal saying that graphs are global, defined by the platform and by a classification's intent pack, and that a version selects from them.
- **Validated against what exists:** `workflowSelectionErrors` resolves the available set from the deployment's intent pack and refuses a key naming no workflow, listing what the deployment does offer. A duplicate key is reported too, because it signals a list assembled from two sources.
- **Refused at the write, normalized on read:** the read-path validator deliberately does not refuse a stored graph, because it also fails closed to the compiled seed - and refusing there would discard the whole version, persona, models, tools and all, over a field the deployment cannot act on. The read path drops the field instead, so a version stored earlier simply normalizes away.
- **Gated at every door:** the router declares one gate used by both the ordinary intent path and the comparison path, because a gate on one of them is a gate an assistant can be walked around by asking for a duel. A variant with no selection of its own inherits the serving version's, so a comparison does not change what either side may open by accident.
- **The platform machines are exempt.** The queue opens its own task types directly, and a selection must not remove them.
- **A state says who it awaits:** `awaits: { party: 'requester' }` is the declaration that moves ownership to the person and tells the pre-model decisions a continuation comes from a new subject ([`SPEC-TASK-STATE-TRANSITIONS.md`](../conversation/SPEC-TASK-STATE-TRANSITIONS.md) sections 4 and 12.6). `requester` is the only reference that ships, and the deprecated boolean spelling is accepted and normalized to the same reference.
- **Asserted by** `backend/test/lib/profile-lifecycle.test.ts` (a version that tries to define a workflow is refused and told where they live; a selection naming a graph that does not exist is refused; a selection of graphs that exist, and none at all, are accepted), `backend/test/lib/battle-turn.test.ts` (a deselected workflow is not opened and a reply is planned instead; the gate is not simply off), and `backend/test/task-state-machines.test.ts` plus `backend/test/lib/task-loop-machines.test.ts` (graph validation with loud, named failures, and a turn using exactly the machines it is handed).

### 4.6 Guardrail select and define

A deployment provisions a guardrail catalog and a profile selects one from it. The apply grant is per provisioned resource, so a profile can never point at an arbitrary one.

- **Define, the catalog as data:** `backend/lib/config/guardrail-catalog.ts`. The first entry is the deployment default; additional entries, of which the shipped `strict` example adds one blocked term, are selectable alternates. Deployers extend or replace the list with their own industry-specific guardrails.
- **Provision and grant, the boundary:** `backend/lib/stacks/assistant-profile-stack.ts` provisions each catalog entry, grants the apply action per provisioned resource, and publishes the resolved ids with their selection keys to the classification's guardrails parameter.
- **Select, the behavior:** a profile's `guardrailId` picks a catalog entry; undefined inherits the deployment default.
- **Fallback, what an unusable selection does:** a selected guardrail that cannot be applied for **any** reason falls back to the deployment default and re-applies, and only a failure of the default itself fails open. The reason is deliberately not narrowed to an access denial: an unprovisioned id denies access, but a selection key used where an id belongs, or an id carried in from another deployment, raises a validation or not-found error instead. Treating only the first as recoverable left the other two passing the turn through completely unfiltered, on both input and output. A selected guardrail that will not apply is a misconfiguration whatever the error is named.
- **Port, what crosses instances:** the selection travels as its catalog key, not the resolved id, and import resolves it against the target's own catalog or rejects it ([`SPEC-PORTABLE-PROFILES.md`](./SPEC-PORTABLE-PROFILES.md)).
- **Asserted by** `backend/test/lib/guardrail-catalog.test.ts` (the default policy lacks the strict term, and the strict alternate carries it over the same base), `backend/test/lib/guardrail-selection.test.ts` (a selected guardrail applies its draft; a selection that denies access, that is a catalog key, or that belongs to another deployment each fall back to the default and still mask or block; only a default outage fails open), `backend/test/lib/profile-manifest.test.ts` (the selection exports as a key and imports onto the target's own guardrail), and `backend/test/cdk-synth.test.ts` in its Layer 4 resource-boundary block (each apply resource references an in-stack provisioned guardrail, never a wildcard and never a raw arbitrary ARN).

## Appendix B - The server-only channel-context store

A conversation's private host grounding - participant profile, domain context, extra context blobs and the resolved display name - lives in a dedicated DynamoDB table, `ChannelContextTable` in `backend/lib/stacks/conversations-stack.ts`, keyed by the channel ARN, deliberately outside the member-readable Amazon Chime SDK channel metadata.

The conversation-create, member-add and conversation-split Lambdas and the assistant handler write it, each holding at most `GetItem` and `UpdateItem` on the table, so a writer patches the fields the store owns and can neither replace nor enumerate a row. The assistant handler reads it, scoped to a single-item read, and holds `UpdateItem` because the drift-confirm flow creates conversations from inside it and the router records an onboarding intake in progress. No principal holds `PutItem`, `DeleteItem`, `Scan` or `Query`, and no channel member, user-pool or identity-pool principal is granted any access. The code is `backend/lambda/src/lib/channel-context-client.ts` and `backend/lambda/src/lib/host-grounding.ts`.

Asserted by `backend/test/cdk-synth.test.ts` in its Layer 4 resource-boundary block: the handler holds `GetItem` and `UpdateItem` and never `PutItem`, `DeleteItem`, `Scan` or `Query`, and the authentication stack references the store from no role. The security framing is in [`SPEC-CONVERSATION-SECURITY.md`](../governance/SPEC-CONVERSATION-SECURITY.md) and [`ACCESS-CONTROL-BY-EXAMPLE.md`](../governance/ACCESS-CONTROL-BY-EXAMPLE.md).
