---
title: "ADR-048: An assistant is not a classification, and is managed at runtime like a user"
status: Accepted 2026-10-12, amended 2026-10-23 and 2026-10-24. Assistants are read from their assignment records, the alt is an assistant, and every assistant identity is the provisioner's, one principal that builds and retires every assistant, created at runtime from the console or seeded once from a deployment's declaration; a role is withdrawn only once no assistant fills it. The three-layer split and the runtime-managed assistant are recorded here; what a deployment descriptor may hold is ADR-049, and the alt profile depends on both.
date: 2026-09-21
related:
  - "./042-an-assistant-acts-in-exactly-one-classification.md"
  - "./046-classifications-are-a-set-not-a-ladder.md"
  - "./049-a-deployment-descriptor-contains-only-what-is-consumed-before-the-request-runs.md"
  - "./050-the-alt-is-an-assistant-and-a-conversation-is-enrolled-once.md"
  - "../../specs/interaction/assistants/DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md"
  - "../../specs/interaction/assistants/SPEC-PORTABLE-PROFILES.md"
  - "../../specs/interaction/assistants/SPEC-PER-PROFILE-OWNERSHIP.md"
  - "../../guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md"
  - "../../../backend/lib/profile-registry.ts"
  - "../../../backend/lambda/src/lib/profile-lifecycle.ts"
  - "../../../backend/lambda/src/credential-exchange.ts"
  - "../../../backend/lib/stacks/assistant-profile-stack.ts"
tracking: |
  The owner, 2026-09-21: "Some seem like classification infra, not profile like processor and handler. Some are assistant, like the app instance bot then there is the related behavioral profile which also includes intent, tools used, model selection etc", then: "Tasks and tasks management are global not profile or assistant level. No pools should be required. Assistants and their profiles should be managed in runtime like users", and on the layer tasks belong to: "Keep tasks classification level then." This record is that split written down, with the lifecycle question answered the way the owner answered it. It completes DESIGN-SEPARATE-ASSISTANTS section 3.0, which introduced the assignment record so a reader asks which assistant serves a role rather than assuming the classification is the assistant, and names the half of that intent the code has not reached.
---

# ADR-048: An assistant is not a classification, and is managed at runtime like a user

## Status

**Accepted (2026-10-12).** Creating an assistant is on (`manage-assistants`, no flag): an admin creates one, and a team member creates one only for their own team (`POST /admin/teams/{team}/roster`). Retiring stays an admin's. The costs below are read from the tree and cited.

| Part | State | Code |
|---|---|---|
| A turn serves the profile of the assistant its bot's assignment record names, read from `/assistant-assignments/{classification}/{role}/{live\|alt}` | Built | `assistantOfBot` in `router-agent-handler.ts`; `turn-assistant.ts`; `roleOfAssistant` in `profile-registry.ts` |
| An assistant names its one classification | Built | `classificationOfAssistant` in `profile-registry.ts` |
| The turn path serves an assistant created at runtime from its own record at `{classification}/{role}/assistants/{assistantId}`: its seed from the record, its behavior from its own active version, and a record that is not `active` reads as absent | Built | `runtimeSeedFor` in `runtime-assistant.ts`; the assistant index in `router-agent-handler.ts`, `default-agents.ts` and `assistant-vend.ts`; the vend refuses one with no active version |
| `manage-profiles` lists and versions an active assistant created at runtime, read from its directory entry; its first draft is seeded at create from the starting point the create chose (its classification's defaults, a profile file, or a copy of an assistant in the same classification), with the create's name and models written over it, and its active version must carry its own `intentPack` | Built | `learnRuntimeAssistant`, `aeCheckStartingPoint` and `aeSeedFirstDraft` in `manage-profiles.ts`; `seedFirstDraft` and `copyFirstDraft` in `profile-lifecycle.ts`; `starting-point.ts`; `runtime-directory.ts`; the intent-pack rule in `activateDraft` |
| Archival attributes an assistant created at runtime to its classification | Built | the turn stamps `runtimeClassification`, read by the boundary check in `kinesis-archival.ts` on a bot's row only |
| The alt is an assistant with its own profile | Built | [ADR-050](./050-the-alt-is-an-assistant-and-a-conversation-is-enrolled-once.md) |
| `manage-assistants` creates an assistant at runtime and admits it to one `(classification, role)`: an Amazon Lex bot of its own, a tagged identity, the assignment record and the directory entry, all stamped `provisioner=runtime`; retire deletes the identity and the Lex bot and leaves a tombstone. A console-created assistant may hold the primary role but is never the classification's primary (`primaryAssignmentOf` reads the declared record only). One build runs per create (a build claim, a never-retried invoke), each id is recorded as it is created, and a failed or abandoned build shows as `failed` with its reason until it is removed, which releases the name. The display name is locked per classification | Built | `manage-assistants.ts`; `assistant-lex-bot.ts` and `assistant-identity.ts`, shared with the deploy-time provisioners; `runtimeAssistantProvisioningAllow` in `agent-classification-common.ts`; the owner seeded from the record by `assistant-ownership.ts` |
| The console lists every assistant in one list, however it was created, creates one in steps, shows each one's state, imports its first version, and retires any assistant but a classification's primary, however it was created | Built | `AssistantsList.tsx` and `CreateAssistantFlow.tsx` in the Assistants tab (`ProfilesTab.tsx`), gated on `manage-assistants`; `rosterService.ts`; the listing serves `runtimeAssistants` and `rosterTargets`, and each profile's `origin`. There is one kind of assistant: how it was created is a detail on its row, not a separate section |
| A team member creates an assistant for their own team, and only theirs | Built | `POST /admin/teams/{team}/roster` (`manage-assistants`, team-scoped); the console session names the person's own team paths and the handler refuses another team, a classification their clearance does not reach and an unowned create; retire stays an admin's |
| Every assistant's identity is the provisioner's, and a deploy seeds its declared assistants once (amendment of 2026-10-23, below): no stack creates an `AppInstanceBot`, an Amazon Lex bot, an assignment record or a name applier; each `Assistants-<classification>` stack and `AdminServices` declare their assistants to one seed; a console retire sticks; retire is one path; one record path and one name applier for every assistant | Built; deployed half NOT VERIFIED | `seed-declared-assistants.ts`, `lib/assistant-provisioner.ts`, `DeclaredAssistantsSeed`; `backend/test/a-deploy-seeds-its-declared-assistants-once.test.ts`, `backend/test/no-stack-owns-an-assistant-identity.test.ts`, `backend/test/manage-assistants.test.ts`, `backend/test/declared-assistants-report.test.ts`; `tests/e2e/a-declared-assistant-is-the-registrys-own-name.spec.ts` proves on a deployment that a seed naming an assistant the registry does not hold is refused and builds nothing, and that a declared and a console-created assistant resolve the same links. That a console retire sticks across the next seed is NOT VERIFIED on a deployment: the seed builds only the registry's own names, so a deployed proof would retire an assistant that serves, and it is proven by unit test alone |
| The roster is a store rather than `allProfileNames()` | **NOT BUILT** | |
| Behavioral state re-keys from the classification to the assistant | **NOT BUILT** | |

## The problem, in one example

A deployment wants two assistants for the same audience: an advisor and a specialist, both premium, both reaching exactly the same data, differing in persona, intents and tools.

That cannot be expressed. The two would have to be two classifications, which changes what those people may reach, and reach is the one thing the deployment did not want to change. A builder who wants a second assistant is asked to alter an access boundary to get it.

The reason is not a missing feature. It is that the roster of assistants is the list of classifications, and that an assistant is a deploy-time artifact.

## What the code believed

`allProfileNames()` derives the roster from the classification set (`profile-lifecycle.ts:95`):

```ts
return [...new Set(defaultProfileRegistry.classificationValues().map((c) => defaultProfileRegistry.requireProfileFor(c).name))];
```

`classificationServedBy()` is its inverse (`:86`), and it addresses BEHAVIORAL state by the boundary: the intent pack at `:510` and `:585`, and the guardrail and context-source catalogs from `manage-profiles.ts:133,156`. What an assistant is for is keyed by what it may reach.

`Classification` is a compile-time union of three values (`lib/config/model-strategy.ts:1`), and `bin/backend.ts` creates one `Assistants-<classification>` stack per classification that declares a `topology` in the registry, so the stack is named by the classification and never by a profile. The classification value is the stack's SSM segment, and the profile it serves is resolved from it (`requireProfileFor`).

The exception is already in the tree and already names the problem. `admin-agent` is a profile name that is not a classification value, and the assignment record's comment (`assistant-profile-stack.ts`, as it stood before the amendment of 2026-10-23 moved the record to the provisioner) calls that "exactly the coincidence this record stops being load-bearing."

## The decision

There are three layers, not two, and each owns different things.

**A classification owns infrastructure and boundary.** The async processor, the agent handler, the task service, conversation split, the Lex bot, their IAM roles, and outside the profile stack the Cognito group, the identity-pool role, the credential-exchange role, the Postgres reader role and the Glue partition value. These stay deploy-time. IAM evaluates a grant before the request runs, so a boundary cannot be authored by the request (tenet P4), and grant expansion happens at deploy because an IAM session tag is single-valued and a policy compares strings rather than sets, so the grant set cannot live on the principal (`profile-registry.ts:188-200`).

**An assistant is an identity, created and managed at runtime, the way a person is.** It is an `AppInstanceBot`, admitted to one `(classification, role)`, and its permissions come from that membership rather than from infrastructure of its own.

**A profile is behavior.** The versioned definition in SSM: persona, intents, tools, model selection, guardrail selection, context sources, display name. Already runtime-mutable with a 30 second TTL, and it needs no change to become so.

An assistant is therefore not a classification. N assistants may occupy one classification, sharing its compute and its boundary, differing only in profile.

### Runtime, and why that is not a new risk

**A person's Chime identity is already created at runtime.** `backend/lambda/src/lib/person-identity.ts:248` calls `CreateAppInstanceUserCommand` on demand, from the credential exchange that vends the person their credentials. Creating an assistant's `AppInstanceBot` at runtime is that call on the bot side, at the same point in a lifecycle.

**What the tree refuses is per-INVOCATION creation**, which DESIGN-BATTLE and DESIGN-MULTI-AGENT-ORCHESTRATION both reject: minting a principal to answer one turn drags provisioning into the request path. Creating an assistant when an operator creates one is a lifecycle event, not a request. The two are different questions and only the second is refused.

**No pool, and none is required.** An earlier design provisioned interchangeable bots and was removed twice, deliberately (`battle-stack.ts:342-375`, owner 2026-09-17): first a flat cross-classification pool, because "a cross-classification principal is the shape ADR-042 says cannot exist", and then the `altBotSlotCount` knob, because "an alt is the alternate occupant of ONE role, so the number of alts a classification needs is the number of roles it declares". Provisioning ahead of need is the pooled shape wearing a different label. An assistant is created when someone creates one.

**No per-assistant IAM role, which is what makes this cheap.** One acting role exists per classification (`assistantActingRole`, `agent-classification-common.ts`), and the assistant and its assistant role are session tags the vend sets per turn (`assistant-vend.ts`; [DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION](../../specs/interaction/assistants/DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md), Phase 1b). Admitting an assistant to one is the analogue of adding a person to a Cognito group, and a person does not get an IAM role of their own either. The number of roles is a deployment declaration; the number of assistants is not.

**Task management stays at the classification, not the assistant** (owner, 2026-09-21). Tasks are not an assistant's property, and the task service keeps its own deployment per classification because that is where a second enforcement layer lives: `SERVICE_CLASSIFICATION` is an env "impossible for a caller to influence" (`task-service.ts:28`), and the refusal `grantsFor(SERVICE_CLASSIFICATION).includes(tag)` is a fact about the deployment rather than a claim in the request. N assistants in a classification share that one service, which is the same sharing they already do for the processor and the handler.

**Creating an assistant is `manage-assistants`**, already named in DESIGN-SEPARATE-ASSISTANTS section 3.6 as a capability distinct from `manage-profiles`, on the stated ground that behavior is data and a boundary is infrastructure. Authoring what an assistant does and admitting one to a boundary are different permissions, and this ADR keeps them different.

## What this costs, stated once

**The 1:1 map goes.** `allProfileNames()` and `classificationServedBy()` stop deriving one from the other, and the roster becomes data rather than a projection of the classification set. There is no runtime store for it today.

**Behavioral state re-keys from the boundary to the assistant.** The intent pack (`profile-lifecycle.ts:510,585`) and the guardrail and context-source catalogs (`manage-profiles.ts:133,156`) are addressed by classification. Keys already written must keep resolving, so this is an additive read path and not a rename.

**The `Classification` union stays where it means classification and goes where it means assistant.** The two uses are the same type today, so each site has to be read for which one it meant.

**The record's `assistant` field becomes load-bearing.** It is written (`assistant-profile-stack.ts:1916`) and no reader takes it; `resolvePrimaryBotArn` reads `botArn` alone. It is filled as `requireProfileFor(classification).name`, which is the collapse this ADR removes, so it has to stop being derived from the classification before anything can trust it.

**Tagging a bot on create has a known wrinkle.** `backend/lambda/src/lib/vend.ts:234-237` records that `CreateAppInstanceUser` with `Tags` also requires `chime:TagResource`, so the tag is a separate best-effort call. An assistant's classification tag is what ADR-042 and the battle roster filter on, so the runtime creation path has to establish that tag by whatever route the user path settled on.

**A correction this ADR carries.** `assistant-profile-stack.ts:1900` states "NOTHING READS THIS YET, deliberately" and names `resolvePrimaryBotArn` as the reader that would move onto it. That move has happened (`channel-flow-processor.ts:215-252`). The comment is stale and is corrected as part of this work.

**Surfaces that change.** `GET /admin/profiles` returns `allProfileNames()`, so the console's assistant roster is the compiled classification set and becomes a list read from a store. `HOW-TO-ADD-OR-MANAGE-A-PROFILE.md` describes adding a profile as a deploy and becomes wrong.

## What proves it

**The built half, by unit test.** `backend/test/a-turn-runs-on-its-assistants-profile.test.ts` (a turn serves its assigned assistant's profile, and an unknown assistant is refused rather than given the primary's); `backend/test/lib/an-assistant-is-assigned-one-classification.test.ts`; `backend/test/profile-registry.test.ts`; `backend/test/lib/a-runtime-assistant-runs-on-its-own-profile.test.ts` (the seed, and every record that names nothing); `backend/test/lib/a-turn-acts-as-the-assistant-it-was-routed-to.test.ts` (the vend admits a runtime assistant with an active version, refuses one without, and refuses a retiring or reserved one); `backend/test/manage-profiles.test.ts` (an active runtime assistant is listed and a retired one is not, an unreadable directory is reported, the first version is imported, and activation without its own intent pack is refused). `backend/test/manage-assistants.test.ts` (the capability gate; reserved, taken, tombstoned, not-enabled, unreachable-model and duplicate-display-name refusals; the build tags and records both bots, seeds the owner and goes active; consecutive hyphens refused so ids map one-to-one onto Lex bot names; a second create showing a display name already being built refused; a duplicated build invoke builds nothing; the Lex bot id recorded before the build finishes; a per-create identity token; text conversation logs on the alias; a failed build undoes itself and stays visible as failed, and removing it releases the name and display name; a build past its deadline reads as failed and retire removes what it recorded; retire stops admission first, leaves a tombstone and releases the display name); `backend/test/a-room-is-spoken-for-by-its-primary.test.ts` (a runtime assistant in the primary role, listed first, is not the classification's primary); `backend/test/a-runtime-provisioner-cannot-touch-a-deployed-assistant.test.ts` (synthesis: every identity and Lex action requires `provisioner=runtime`, `UpdateAppInstanceBot` only through the one call that re-sends the identity's own configuration, no `iam:*` beyond passing its Lex bot role to Amazon Lex, no write under `/assistant/*`, and the profile editor cannot write the directory or the records). `frontend/packages/admin/src/components/admin/AssistantsList.test.tsx` (declared and console-created assistants in one table with how each was created as a detail, every state shown, the first-version import offered only where no version is active, retire offered to an admin only, and a declined retire sends nothing) and `CreateAssistantFlow.test.tsx` (the steps, the deploy step said behind the first step's help with its guides rather than as a field, only the models its classification may reach, and a team member's create on its own team's route). The deployed half is the runtime e2e recorded below.

**Recorded evidence, 2026-10-12, read-only against the development deployment.**
- **Every assistant identity can carry a runtime assistant's shape.** `chime-sdk-identity list-app-instance-bots` then `describe-app-instance-bot` and `list-tags-for-resource` per bot: seven assistant bots, every one with a `Configuration.Lex` alias and `InvokedBy` `StandardMessages=NONE`, `TargetedMessages=ALL`; every conversational bot tagged `classification`, `role` and `assistant`. Targeted messages go to Amazon Lex, so a runtime assistant needs a Lex bot of its own to be told apart (the Amazon Chime SDK does not say which bot was addressed, section "What the code believed").
- **Tag-conditioned bot calls succeed, so retire can delete the bot rather than only vacate the record.** `cloudtrail lookup-events` for `CreateAppInstanceBot`, `UpdateAppInstanceBot`, `DeleteAppInstanceBot` and `TagResource` over the 90-day window: tagged creates from every classification's `CreateBotRole` return OK, and so do updates and deletes from the same roles under `aws:ResourceTag` conditions. The one `AccessDenied`, on 2026-09-25, is followed by a successful create from the same role four minutes later.
- **Capacity.** Amazon Lex V2 allows 100 bots per account (adjustable). `lexv2-models list-bots --max-results 100` on 2026-10-13: the account holds 70, of which about 50 are this deployment's - one live Lex bot per assistant and the rest orphans of earlier teardowns and redeploys (11 copies of each classification's, 12 of the Battle stack's alt bots'), because the deploy-time Lex handler's Delete branch logs a failure and returns. Each runtime assistant takes one more, so a deployment near the quota raises it or clears its orphans first. The 43 orphans - AgentEchelon-named Lex bots that no `AppInstanceBot` in any app instance pointed at and no CloudFormation stack in the account owned - were deleted on 2026-10-13, leaving 25. The Delete branch that strands them is unchanged, so they recur with each teardown until it is fixed.

**The runtime half, against the development deployment, 2026-10-13.** `tests/e2e/a-runtime-assistant-answers-as-itself.spec.ts`, 4 passed: IAM's simulator allows the admin console role and refuses the team console role on both roster routes; an admin's create builds a Lex bot and an identity tagged `provisioner=runtime` and goes active in about half a minute; after its first version is imported and activated, a private message is answered by the runtime assistant's own identity with its own version's persona, through its own Lex bot; retire removes the identity and the Lex bot and a second create of the name answers `ASSISTANT_NAME_TAKEN`. The first runs measured four things the policy shape had not, each fixed and recorded at its grant or reader: `CreateBot` authorizes against `bot-alias/*`, the owner-team aspect stripped the runtime stamp's `assistant` and `role` keys, `DeleteBot` authorizes every child it deletes, and a deleted identity answers Describe with `Forbidden`. Rerun after the review fixes of the same day (the deploy-time primary only, the build claim, the display-name lock, the conversation logs), 4 passed; the spec creates its assistant in premium's primary role, which no longer displaces the classification's primary. The build claim, the abandoned-build retire and the display-name race are proven by unit test only.

**What is still unproven.** A deny-test that an assistant created at runtime reaches nothing its role's live assistant does not, against the deployed policies, which is the property the split exists to preserve; the console's create flow driven end to end; and a team member's create on its team route against a deployment (`tests/e2e/a-runtime-assistant-answers-as-itself.spec.ts` asserts the refusals, not yet run against one).

## What this does not decide

**An assistant cannot be scoped below its classification.** Scope is the role's and not the assistant's (DESIGN-SEPARATE-ASSISTANTS section 3.0), so a second assistant in a classification reaches exactly what the first does. That is deliberate and unchanged here, but it means per-assistant restriction is not expressible and should not be expected.

**What a deployment descriptor may contain.** ADR-049.

**The alt profile.** An alt is the alternate assistant of a `(classification, role)`, created from experiment settings: ADR-050.

## Amended 2026-10-23: one kind of assistant, and the provisioner owns every identity

> **Amended 2026-10-23 (owner).** "One kind of assistant": an assistant can be asked for in more than one way, and every assistant behaves the same once it exists. Then: "I don't want any assistants owned by the stack if possible. I'm not worried about migrations."
>
> **Amended 2026-10-24 (owner).** "Let's be consistent": one principal builds and retires every assistant, and a role and the assistants filling it are separate.

### The decision

**The provisioner owns every assistant's identity.** An assistant's identity is its `AppInstanceBot`, its own Amazon Lex bot, its assignment record, its directory entry, its name binding and its `owner-team` tag. Every one of them is created by the provisioner, stamped `provisioner = runtime`, and reached afterwards only through grants that require that stamp. No CloudFormation resource creates, updates or deletes an assistant identity: not a classification's primary, not a role's assistant, not a duel's alt, not the admin assistant, and not an outside classification's assistant (the guest's `greeter`, the customer's `liaison`). Nothing in the tree needs an assistant to exist before the provisioner can run, and no stack resource needs an assistant's ARN at synth: the two places that read one (the classification's `bot-arn` parameter and the admin channel's owner) read it from the seed's answer at deploy.

**A deploy declares infrastructure, and asks.** What CloudFormation keeps is what an assistant runs in, never who it is:

| Kept by `Messaging` (the core) | Kept by a classification's stack (`Assistants-<classification>`) | Kept by `AdminServices` |
|---|---|---|
| The provisioner (`AssistantProvisionerFunction`, under a fixed name) and its session role (`RuntimeAssistantProvisionerRole`) | The router and handler Lambda, the asynchronous processor, the task service, the vend and their execution roles | The admin assistant's silent Amazon Lex fulfillment function |
| The one Amazon Lex runtime role (`RuntimeAssistantLexBotRole`) and conversation log group every assistant's bot uses | The acting role and its permissions boundary, with each deployed role's reach (`assistantActingRole`) | The admin notification channel and the alert rule |
| | The registry row, the classification's parameters, and `/assistant/{classification}/bot-arn`, written from the seed's answer | The runtime name applier and the console's roster (`manage-assistants`), which asks the provisioner |
| | The seed: one custom resource that names the declared assistants, the alts included where the duel is wired | The seed that names `admin-agent`, and `/assistant/admin-agent/bot-arn` written from its answer |

**The Amazon Lex bot is per assistant.** It already was in effect: a classification's primary answered on the classification's Lex bot, each role's assistant and each alt on one of its own, and a console-created assistant on one of its own, because a Lex turn from Amazon Chime SDK names the Lex bot and nothing else (DESIGN-ADDING-AN-ASSISTANT-ROLE §10a). It is now said once: every assistant has one Lex bot, created with its identity, tagged the same way and deleted with it. Every bot runs as the provisioner's one Amazon Lex runtime role and writes its text logs to its one log group; Amazon Lex invokes each fulfillment through that function's own resource policy, so the role grants nothing a turn needs.

### One principal builds and retires every assistant

**The provisioner** is `backend/lambda/src/assistant-provisioner-function.ts`, built by `backend/lib/constructs/assistant-provisioner.ts` in `Messaging`. It does every identity and Amazon Lex write on a session of `RuntimeAssistantProvisionerRole` tagged with the classification the work is at, and that role is the only one in the app that holds the provisioner's grant (`runtimeAssistantProvisioningAllow`, written as the session's `classification` tag). Only the provisioner function's role may assume it. The app instance's own provider (from `cdk-amazon-chime-resources`, which holds `chime:*AppInstance*`) is denied every bot action.

It answers three direct invokes and nothing else:

| Request | Caller | What it does |
|---|---|---|
| `{ op: 'build', assistantId, claim }` | `manage-assistants`, after a console create takes the name | Builds the assistant whose directory entry is `provisioning`, created in the console, at a conversational classification other than the admin plane; records each id on the entry as it exists, and removes what it built when the build fails |
| `{ op: 'remove', assistantId, botArn?, lexBotId?, claim }` | `manage-assistants`, for a retire or a build being undone | Removes the identity, then the Amazon Lex bot, of an assistant that is not `active` (a retire marks it `retiring` first), and only ids its own entry or record carries |
| `{ op: 'seed-declared', callerClassification, requestType, logicalResourceId, physicalResourceId?, fulfillmentArn, declaration, oldDeclaration?, rollback?, claim }` | A stack's seed | Seeds the declaration (below) and answers `PrimaryBotArn` and the per-assistant summary, the retired-in-console report included |

**Who may ask is IAM, twice; what they may ask for is the directory and the registry.** `lambda:InvokeFunction` on the provisioner is held by `manage-assistants`' role and by each seed's role, and by no other role in the app, and no route targets it. The provisioner refuses any request that is not exactly one of the three shapes (an API Gateway event included) before it reads anything.

**A request proves its caller with a claim.** A Lambda function cannot see who invoked it, and several principals may invoke this one, so a request does not say who it is from; it proves it (`backend/lambda/src/lib/provisioner-claim.ts`). Before invoking, the caller writes a claim, an SSM parameter whose value is the SHA-256 digest of the exact request, under the one path IAM lets it write: `{root}/provisioner-claims/seed/{classification}/{claimId}` for a classification's seed, granted on that seed's role in the classification's own stack, or `{root}/provisioner-claims/console/{claimId}` for `manage-assistants`. The provisioner derives the path from the request (a `seed-declared` request's `callerClassification`, the console's for `build` and `remove`), reads the claim, deletes it so it answers one request, and refuses the request when the claim is missing, more than fifteen minutes old, or carries the digest of another request. So the `standard` seed, which may invoke the provisioner, cannot ask it to remove `premium`'s declared assistants: naming `premium` sends the provisioner to `seed/premium/`, where only `premium`'s seed can write. A seed cannot ask for the console's `build` or `remove`, and `manage-assistants` cannot ask for a declaration. The provisioner's own role reads and deletes claims and writes none. A seed's role holds three grants: the invoke, its own claim path, and `cloudformation:DescribeStacks` on its own stack (below); no identity, Amazon Lex, directory or record write.

A `seed-declared` request is then refused when its classification (the one its claim proved) is not the declaration's, when the registry does not declare the classification, and when any declared name is not the registry's own name for its classification, role and occupancy; the provisioner reads the registry afresh for it, and each classification's seed is ordered after its registry row. A removal touches only directory entries recorded as declared at that classification.

**Why a claim, and not an alias or the CloudFormation stack.** Three designs give a boundary the caller cannot forge. An alias per classification, each invokable by one seed's role, puts every classification on the core stack (an alias pins a version the core publishes), so adding a classification would change the core. Asking CloudFormation (`DescribeStackResource` on the `StackId` and `LogicalResourceId` the event carries) proves that a stack holds a seed, not that the stack's seed sent the request: both values can be read by anyone who can describe the stack, so a forged invoke can name them. A claim needs no new infrastructure in the core, puts each classification's grant in its own stack, and proves the request by a write IAM refuses every other principal; adding a classification adds its seed's grant and changes nothing in `Messaging`. Guarded at synthesis by `backend/test/one-principal-builds-every-assistant.test.ts` (each claim path is writable by one role, and no role holds a parameter write over the deployment's root), by unit test in `backend/test/the-provisioner-builds-and-retires-every-assistant.test.ts` (another classification's seed asking in `premium`'s name is refused and removes nothing; a missing, stale, spent or mismatched claim is refused), and on the deployed policies by `backend/scripts/deny-test-provisioner-claims.mjs`, not yet run against a deployment.

**Order.** `Messaging` deploys before every stack that holds a seed: each `Assistants-<classification>` declares the edge (and already reached `Messaging` through `Conversations`), and `AdminServices` declares it. The provisioner is core, not part of `admin`, because every deployment has assistants and a deployment need not declare `admin`; without it, the console routes do not exist and the seeds still build every declared assistant. Nothing in `Messaging` refers back to a classification or to `AdminServices`, so no cycle forms. Guarded by `backend/test/one-principal-builds-every-assistant.test.ts` (the whole app, with and without `admin`) and `backend/test/the-provisioner-builds-and-retires-every-assistant.test.ts` (the three operations and their refusals).

### Seed once

Each stack that declares assistants holds one custom resource, the seed, whose properties are the declaration: the classification, its deployed roles, and each declared assistant's id, role, occupancy (`live`, or `alt` for a duel's challenger), the name it shows and whether it greets on join. Its handler (`lambda/src/seed-declared-assistants.ts`) is a thin CloudFormation adapter: it invokes the provisioner with `op: 'seed-declared'` and hands CloudFormation the answer or the refusal. What the provisioner does with a declaration is `lambda/src/lib/declared-assistants.ts`.

The durable record of a seed is the directory entry, `{root}/assistant-directory/{assistantId}`, which carries `origin: 'declared'` beside the console's `origin: 'console'`. For each declared assistant:

- **No entry:** the provisioner builds it (Amazon Lex bot, identity, assignment record, entry, owner seed) and the entry becomes `active`.
- **An `active` entry:** nothing, apart from its declared name. When the declaration names it otherwise than its entry does, the provisioner locks the new name in the classification (refusing the deploy when another assistant holds it), puts it on the identity's `Name` unless an active profile version named the identity (the version's name wins), records it on the entry and releases the old lock. The Amazon Lex bot, the record and the role stay as they were. The console owns the rest: renaming through a profile version, owner, retire.
- **A `retired` or `retiring` entry:** nothing, and it is reported as declared but retired in the console. A console retire sticks.
- **An entry the console created under the same name, or one at another classification or role:** the deploy fails and says which, rather than taking over an assistant somebody else made.
- **A build that died** (`provisioning` past the build deadline, or `failed`): what it recorded is removed and it is built again.

The seed runs when its properties change: an assistant or a role declared or withdrawn, or a declared name or greeting changed. A build that fails removes what it built and fails the deploy, so CloudFormation rolls back and a rerun builds again.

**A rollback is not a withdrawal.** CloudFormation undoes a failed update by sending the seed another update with the properties swapped, so a role that update added reads as withdrawn while the assistant the update built still fills it, and refusing it would leave the stack `UPDATE_ROLLBACK_FAILED`. The seed reads its own stack's status, and when it is `UPDATE_ROLLBACK_IN_PROGRESS` it says so (`rollback`); the provisioner then removes the declared assistants of the roles the rollback withdraws instead of refusing, and logs any created in the console there for an admin to retire.

### A role and the assistants filling it are separate

A role is infrastructure; an assistant filling it is data. So withdrawing a role removes no assistant:

- **A role is withdrawn only once no assistant fills it.** An update whose declaration no longer deploys a role is refused, before anything is built or removed, while any assistant fills that role, declared or created in the console: every live directory entry at that classification and role that is `active`, `provisioning` or `retiring`. The refusal names them and says to retire them in the console first. A declared assistant retired in the console no longer fills it.
- **The withdrawal releases the retired declared assistant.** Once the role is withdrawn, each declared assistant of that role that a console retire left as a tombstone is released: whatever its retire could not remove is removed, and its directory entry is deleted, so declaring the role again seeds a fresh assistant under the same name. Its profile versions (`/assistant/{name}/*`) are kept, as every retire keeps them, so the fresh assistant resolves the same versions. A console-created assistant's tombstone is never released: its name is never reused.
- **A duel's alt is the duel's.** It is not an assistant a person retires (`ASSISTANT_IS_ALT`), so when its classification no longer wires the duel it is removed with it.
- **Removing a classification** (its seed's delete) removes every assistant its declaration names, the alts and retired tombstones included, and NEVER FAILS the stack, because a stack's delete (and a create's rollback) must always be able to finish. What it cannot remove (a declaration that does not parse, a refusal, a failed invoke, an identity that will not delete) is logged and reported in its response, and the teardown sweep removes what the directory still records. No seed removes an assistant created in the console, so the refusal that keeps one from being orphaned comes before anything is deleted: `npm run deploy` and `npm run deploy:stack` refuse a configuration that no longer declares a classification an assistant created in the console is still active in, naming them (`consoleAssistantsOrphanedBy`, `backend/scripts/lib/declared-assistants.cjs`).

A removal deletes the identity, the Amazon Lex bot, the assignment record, the display-name lock and the directory entry. What it cannot remove stays on the entry (`failed`, with `leftover`), so the console says what is left.

**An already-deleted resource counts as removed only when a listing confirms it.** The provisioner's grant is conditioned on tags a deleted identity or Amazon Lex bot no longer carries, so a Describe or Delete of one answers with an access denial (`AccessDeniedException` from IAM, `ForbiddenException` from Amazon Chime SDK), never NotFound. A denial says only that the session may not act, so the provisioner settles it with a read that names nothing it could change: `ListAppInstanceBots` for the identity and `ListBots` for the Amazon Lex bot (`deleteIdentity` and `deleteLexBot`, `backend/lambda/src/lib/assistant-provisioner.ts`). Absent from the listing is removed; still listed, or a listing that fails, stays `leftover`. An entry left `retiring` or `failed` is finished by retiring it again in the console, which runs the same removal.

**What the deploy says.** The provisioner logs every declared assistant's state, and `npm run deploy` and `npm run deploy:stack` print, after a successful deploy, each declared assistant that is retired in the console ("declared, but retired in the console; a deploy does not recreate it"), read from the directory. The console lists it in the retired state like any other retired assistant.

### One kind of assistant, read one way

- **One record path for every live assistant:** `{root}/assistant-assignments/{classification}/{role}/assistants/{assistantId}`. A duel's alt keeps `{classification}/{role}/alt`, because an experiment writes the alt's occupant there for the life of a battle (ADR-050). `{classification}/{role}/live` is no longer written.
- **The record says where its descriptor comes from, not who asked for it.** `source: 'declared'` is a declared assistant, described by the deployment's profile, so every reader that treats a non-`runtime` record as the registry's reads it unchanged. `source: 'runtime'` is a console-created one, described by its record (`runtimeSeedFor`).
- **The classification's primary** is the declared assistant in the `primary` role (`primaryAssignmentOf`: a primary-role record that is not `runtime`), as before.
- **A role is enabled when it is deployed**, read from the registry row its classification's stack publishes (`rolesFor`), not from the existence of a record.
- **Rename** goes through the one runtime name applier for every provisioner-owned assistant, alts included. No stack deploys a per-assistant applier.
- **Infrastructure links** (`profile-infra.ts`) resolve the record and directory paths, the identity, its Amazon Lex bot and alias, and the classification's shared resources the same way for every assistant.

### Retire

Retire is one path, `POST /admin/roster/{assistantId}/retire`, with its reason prompt, for every assistant that has a directory entry, however it was asked for. `manage-assistants` marks it `retiring`, asks the provisioner to remove its identity and Amazon Lex bot, and leaves the tombstone. Its guards keep a room answerable; none of them reads how an assistant was created:

- **A classification's primary is not retired** (`ASSISTANT_IS_PRIMARY`). Every room has a primary (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8), and the primary is what a conversation is created for, so retiring it would leave its classification unable to open or answer a room. The admin assistant is the admin plane's primary and is refused by the same rule. A primary is replaced by declaring another, and removed with its classification.
- **A duel's alt is not retired** (`ASSISTANT_IS_ALT`). It exists while its classification wires the duel, and is removed with it.
- A build still in progress is refused, as before.

The console offers Retire wherever the route accepts it, and shows how the assistant was asked for (declared in `deploy.config.json`, or created in the console) as a quiet detail on its row and nothing more.

### Roles stay a deploy

"A new role and assistant is a deploy" stays true for roles. A role brings reach, context, tags and IAM, which are infrastructure and are proven by a deny-test, so a role is declared and deployed. An assistant filling a deployed role is data: declared once and seeded, or created in the console. `npm run add-assistant-role` declares `ops-premium` and deploys `Assistants-premium`, which deploys the `ops` role and seeds `ops-premium` when it is absent. `--remove` withdraws the role: it reads the directory first and refuses, before writing anything, while any assistant fills the role (the deploy's provisioner refuses the same withdrawal), and once every one is retired in the console it withdraws the role, which releases the retired `ops-premium`, so a later add seeds it afresh.

### Existing deployments

There is no in-place migration. A deployment whose assistants were created by CloudFormation moves by a teardown (`backend/scripts/teardown.mjs`) and a fresh deploy, which is also the fresh-install path. The same teardown and fresh deploy resolve the Amazon Lex bots built before this amendment: each names a per-stack Lex runtime role that the amended stacks no longer hold, and an update deletes that role, so such a bot is removed and rebuilt on the provisioner's one role rather than repaired in place. A full teardown removes every provisioner-owned identity: it removes the console-created assistants still active first, because no seed removes one, and deletes each one's directory entry only once its identity and its Amazon Lex bot are gone (one still standing keeps its entry, is reported, and is tried again after the stacks); each stack's seed then removes what it declared as its stack is deleted; and the teardown removes whatever identity the directory still records after the stacks. An assistant still standing at the end keeps its directory entry through the purge, and the teardown reports itself incomplete, so a rerun finds it again.

### What this costs

**The deploy waits on Amazon Lex.** A fresh deploy builds each declared assistant's Lex bot inside the provisioner, about a minute each, one after another within a declaration, while the seed waits on it.

**Every request costs a parameter write and a read.** A caller writes its claim and the provisioner reads and deletes it, one standard SSM parameter per request, which is the price of identifying a caller without a provisioner principal per classification.

**Withdrawing a role takes a retire first.** A role that any assistant fills cannot be withdrawn by a deploy alone; the operator retires its assistants in the console, with a reason, and then withdraws it.
