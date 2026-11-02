---
title: "ADR-057: Assistant stacks come from the classification registry"
status: >-
  Accepted 2026-10-18 by the owner, amended 2026-10-22 (decisions 3 and 6 to 9). Decisions 1 to 9 are built at synth: `backend/bin/backend.ts` creates one `Assistants-<classification>` stack per classification the deployment declares with a `topology` (`resolveDeploymentProfiles`, `backend/lib/config/profiles.ts`); each publishes its row of the runtime registry and holds every resource and grant its classification adds; every handler reads the set from the rows at runtime; and adding or removing a classification changes no other stack, which the deploy matrix checks in both directions. Every invoke granted on a function-name pattern names the instance prefix and is conditioned on the `Instance` tag. The runtime registry is deployed to dev; no deployed check of it is recorded here (NOT VERIFIED).
date: 2026-10-17
related:
  - "./054-compute-is-per-classification-and-an-assistant-is-data.md"
  - "./046-classifications-are-a-set-not-a-ladder.md"
  - "./042-an-assistant-acts-in-exactly-one-classification.md"
  - "./055-stacks-are-capabilities-in-layers.md"
  - "../../overview/STACKS.md"
  - "../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md"
  - "../../../backend/bin/backend.ts"
  - "../../../backend/lib/config/profiles.ts"
  - "../../../backend/lib/stacks/assistant-profile-stack.ts"
  - "../../../backend/lib/stacks/agent-classification-common.ts"
  - "../../../backend/lib/config/capabilities.ts"
  - "../../../backend/lib/stacks/conversations-stack.ts"
tracking: |
  ADR-054 places compute and its execution role on the classification axis. A CDK app that hard-codes its classifications deploys every one of them in every deployment, and adding one means editing `bin` and writing a stack file. A deployment with no accounts (ADR-055) needs only the outside classifications it serves.
---

# ADR-057: Assistant stacks come from the classification registry

## Status

**Accepted (2026-10-18, by the owner).** What ships:

- **One stack per registry topology.** `backend/bin/backend.ts` maps `deployedAssistantClassifications` (`backend/lib/config/profiles.ts`) to one `AssistantsStack` each, named `Assistants-<classification>`. A conversational classification with no `topology` is refused at synth, and the admin plane may not declare one.
- **Topology is registry data.** `AssistantTopology` is a field of the classification's entry in the deployment's set (the shipped catalog, `DEFAULT_PROFILES_CONFIG`, or a custom set); `AssistantsStack` takes only the classification and reads the rest (`defaultProfileRegistry.requireTopology`). There is no stack file per classification.
- **Lookups at runtime, by name.** A shared function reads the named classification's router and task-service ARNs from the parameters its classification stack publishes, at call time (`resolveRouterArn`, `lambda/src/lib/router-arn.ts`), and the set of classifications from the runtime registry, so no shared stack takes a deploy-time value from a classification stack.
- **A runtime registry.** Each classification's stack publishes its row under `${SSM_ROOT}/registry/classification/<classification>`, and every handler reads the rows (`loadProfileRegistry`, `lib/profile-registry.ts`).
- **Pattern grants name the instance.** The task-service, router, vend and name-applier patterns start with the instance prefix and carry the `Instance` tag condition (`ownInstanceFunctions`), so one instance's role cannot invoke another instance's function in the same account, including one whose prefix starts with this one.

## Context

ADR-054 settles that compute is per classification, reach is per role, and behavior is per assistant as data. It does not settle where the list of classifications comes from at deploy time, and the CDK app answers with a constant. ADR-046 settles that classifications are a set, so nothing about the three shipped values is structural; they are the default set, not the only one.

## Decision

**1. One `Assistants-<classification>` stack per declared classification.** The CDK app reads the classification registry and creates one stack for each conversational classification the deployment declares. A deployment that declares one classification gets one stack.

**2. A classification's topology is registry data.** Timeout, memory, reserved concurrency, token limit, streaming, context routing and the rich-processor switch are fields of the classification's registry entry, not of a stack file, and so is the classification's model selection (`models`: the catalog keys it selects and its default). `AssistantsStack` takes them from there.

**3. Every lookup is a runtime lookup by name.** A consumer outside a classification's stack resolves that classification's router, task service and vend from the parameters the classification's own stack publishes, when it needs them, and the set of classifications from the runtime registry (decision 8). No consumer holds a deploy-time reference to any classification, so a classification added or removed changes nothing in it. A classification the registry does not declare has no router to the reader, and nothing substitutes another classification's.

**4. Grants name the instance.** Every function wildcard carries the stack prefix, so one instance's role cannot invoke another instance's function in the same account.

**5. The guest is a classification like any other.** A deployment with no accounts declares `guest`, with its own assistant and its own model selection, through the same registry entry, and `customer` beside it, since a visit's upgrade path B opens its conversation at `customer`.

**6. A grant names a tag, never a list.** A grant in a stack other than the classification's own reaches classifications through a tag condition (`aws:ResourceTag/classification`, `aws:PrincipalTag`, the conversation's `audience`) or a name pattern, never through a list of the deployment's classifications. A list in a shared grant is a coupling: it changes the shared stack every time a classification is added. `backend/test/a-shared-grant-names-no-classification-list.test.ts` holds it.

**7. A classification's resources live in its own stack.** Everything a classification adds is created by `Assistants-<classification>`: its compute, Lex bot and `AppInstanceBot`, its acting roles and their model grants (exactly its model selection), its clearance groups, the external adapter's key where it selects one, and the Battle alts, Battle grants, host-context role grants and Experiments grants a declared capability attaches to it (`attachBattle` and `attachExperiments`, `lib/stacks/classification-capabilities.ts`). A capability stack keeps only what it shares across classifications.

**8. The registry is read at runtime.** Each `Assistants-<classification>` stack publishes its row of the registry (the classification, the profiles that serve it, its clearance and membership groups) to `${SSM_ROOT}/registry/classification/<classification>` (`publishRegistryRow`, `lib/constructs/registry-row.ts`); the Identity stack publishes the admin plane's row, which grants itself alone. The same call writes the same value to the registry bucket the Identity stack creates, at `registry/classification/<classification>`, and the stack delete removes that object with the parameter. Every handler loads the rows before it reads the registry (`loadProfileRegistry`, cached for five minutes), and no handler reads it at module load. A handler outside the analytics VPC reads the parameters; a VPC-attached handler reads the S3 copy (`AE_PROFILE_REGISTRY_S3`, granted `s3:ListBucket` on the prefix and `s3:GetObject` on its objects), because that VPC is NAT-free and reaches S3 through its gateway endpoint but has no route to SSM. The rows are the deployment's to write: every runtime principal is denied `ssm:PutParameter` and every other write on the path (`ProfileRegistryWriteDenial`, `lib/constructs/profile-registry-readers.ts`), and only the publishing stack's own custom resource holds a write on a row's S3 object, so only a deploy publishes a row. IAM never reads the registry; a grant is decided at synth by the classification's own stack. The clients read the set from `GET /classifications` once signed in. The chat app's registration screen renders before sign-in, so the chat build carries a fallback, `VITE_CLASSIFICATIONS`, generated from the same rows; the admin console carries none.

**9. A classification is added and removed by one stack.** Adding one deploys `Assistants-<classification>` and nothing else; removing one deletes that stack and nothing else. What the delete leaves (tagged conversations, `context/<classification>/`, `assistant-assignments/<classification>/`, archive rows and retained resources) is listed in [HOW-TO-ADD-OR-MANAGE-A-PROFILE](../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md#5c-removing-a-classification).

## Consequences

- Adding a classification is a registry entry and a deploy of its own stack, with no new stack file, no edit to `bin` and no deploy of any other stack.
- A handler sees a classification added or removed within the registry's five-minute cache, not at the instant the stack finishes.
- The per-classification IAM boundary ADR-054 relies on is unchanged: each stack still has its own execution role, derived from its classification.
- `ImageGuardrail-<region>` is still derived per region, as today.
- HOW-TO-ADD-OR-MANAGE-A-PROFILE changes from "create a stack file" to "declare a classification".

## What is not built

Nothing in decisions 1 to 5. What decision 5 rests on:

- The `guest` classification, with `audience: 'outside'`, the `greeter` profile and its own model selection (Claude Haiku 4.5 alone, `models`). It grants only itself and nothing else grants it, so no member's clearance reaches a visitor's conversation.
- A per-deployment source for the registry, `profiles` in `deploy.config.json` (`resolveDeploymentProfiles`): declared as nothing, the shipped catalog minus `guest` and `customer`, so `Assistants-guest` and `Assistants-customer` deploy only where declared, and synth refuses a guest issuer without both. Verified by `backend/test/a-deployment-declares-its-classifications.test.ts` and the deploy matrix (`C1-custom`, and the outside-classification check every configuration runs).

## What proves it

- `backend/test/a-deployment-stands-up-only-what-it-declares.test.ts`: the app creates exactly one `Assistants-<classification>` stack per classification the registry declares, and refuses a conversational classification with no topology.
- `backend/test/lib/router-arn.test.ts`: a deployment with one classification resolves that classification's router and task service and no other parameter.
- `backend/test/a-pattern-invoke-reaches-only-its-own-instance.test.ts` and `backend/test/invoke-grants-stay-inside-this-deployment.test.ts`: no function-name pattern starts with a wildcard, and every pattern grant carries the `Instance` tag condition.

- The deploy matrix's classification-independence pairs, `C1-custom+enterprise` and `C7-custom+research` (`backend/test/deploy-matrix/`): in both analytics modes, the stack set is the base's plus `Assistants-<classification>`, and adding the classification or removing it changes nothing outside that stack, environment variables included. `C7-custom+research` adds a battle-capable classification beside a deployment with Battle, Experiments and a guest issuer.
- `backend/test/lib/the-runtime-registry-is-its-rows.test.ts` (the rows round-trip to the set, and the admin row grants itself alone), `backend/test/lib/no-handler-reads-the-registry-at-module-load.test.ts`, `backend/test/every-function-reads-the-registry-and-none-writes-it.test.ts` (every function role reads the path, and every role is denied writing it) and `backend/test/a-shared-grant-names-no-classification-list.test.ts`.

These are synth and unit checks. The deployed layout is not yet verified on a live instance, and these hold only there: `GetParametersByPath` authorized on the path ARN, a compressed row above 4096 bytes on the advanced tier, the managed-policy attachment count per role and the boundary policy's size, a VPC-attached handler's read of the S3 copy over the gateway endpoint, and a handler converging on an added or removed row within the cache.
