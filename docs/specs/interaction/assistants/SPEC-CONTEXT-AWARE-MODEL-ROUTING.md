# SPEC: Context-aware model routing (RoutingContext + provider adapter)

**Status:** Partial, and gated off - the routing feature ships behind an opt-in flag that no deployment in this repo sets, so none of it has run in service. **Built:** `RoutingContext` + `resolveModelPlan` (`lib/resolve-model-plan.ts`), the CN context rule in both of its forms - a Bedrock-served model whose working language is Chinese as the preferred in-AWS path, and an OpenAI-compatible external adapter (`lib/providers/external-llm.ts`) where the classification selects it and not the Bedrock model - the gate on the external path (the classification's own selection of the external model, `models.selected`), the compensating guardrail around it, and per-call external cost computation.

**Coverage:** `tests/e2e/agent-intents.spec.ts`, `tests/e2e/a-route-is-keyed-by-its-intent.spec.ts`, `tests/e2e/a-step-picks-the-model-where-it-overrides-or-delivers.spec.ts`

**Verified by:** `backend/test/lib/resolve-model-plan.test.ts` (the backward-compat matrix across classification and intent, the experiment-override rule, both CN rules including that the in-AWS path is not gated and wins over a configured external provider, and the external-provider gate in both directions: open where the classification selects the external model, and kept on Bedrock and marked withheld where it does not), `backend/test/lib/an-external-model-is-the-classifications-to-select.test.ts` (the processor gate on the classification's selection, the retired version field read as absent through the real read, rolled back to and dropped on the next edit, context routing refused on a classification that selects no Chinese path, the adapter refused where no turn reaches it, and the adapter refused as a profile's or a version's base model), `backend/test/image-gen-iam-parity.test.ts` (the adapter's key secret and environment exist exactly where it is selected, and the in-AWS path is wired exactly where DeepSeek on Bedrock is), `backend/test/external-provider-has-no-deployment-default.test.ts` (the synthesized processor carries no deployment default and the retired context key fails the synth) and `backend/test/lib/external-llm.test.ts` (the message translation, the rate-card cost computation and the environment-config builder).

**Related:** [SPEC-BILINGUAL-CONVERSATIONS.md](./SPEC-BILINGUAL-CONVERSATIONS.md) - the language half of the same problem, which composes with this routing. [SPEC-ASSISTANT-CONFIG.md](./SPEC-ASSISTANT-CONFIG.md) - the per-profile model selection this generalizes over.

**Site section:** Interaction layer, assistants.

---

## Overview

**Model resolution is one pure function over an open bag of per-turn signals, so a new routing variable is a new rule and never a new call site.** One resolver holds both the experiment override the router resolves and the intent-and-classification resolution the processor performs, so no second site can answer the same question differently. The resolver takes a routing context and returns a plan: the model reference, an optional fallback reference, the working language, the tool list, and whether the plan chose a reasoning model.

**The resolver is generic and its first consumer is geography.** A single conversation can span subject matter in two countries, and the right model, language posture and tool set differ per segment within that one conversation. Rather than bolt a geography special case onto the resolver, the signal set is open: data sensitivity, real-time need, user expertise and a cost limit are later consumers of the same seam, each a rule plus optionally a signal key.

**Rule order is first match wins:** the experiment override, then the context rules, then the intent route, then the classification default. The last two run through the classification-aware resolver, which enforces the classification's model allowlist. The context rules do not re-check it - they return the deployment's configured model directly, bounded by IAM instead, because the model ARNs and the environment that names them are wired only for a profile whose topology enables context routing. That distinction has to stay visible: a rule added above the classification-aware path inherits the same gap, and only the IAM wiring backstops it.

**Empty context resolves exactly as it does without the feature, and that is the invariant the whole design rests on.** With no segment and no extra signals the resolver returns the same model the router-and-processor path returns today, which is what makes the generalization safe to land before any rule fires.

**Two layers share that resolver, and both are switched off.** The in-AWS layer selects a Bedrock-served model for a Chinese turn, keeps Bedrock guardrails, resilience and billing, and needs no gate because no conversation content crosses a border. The non-Bedrock layer reaches an OpenAI-compatible provider through one adapter, and it is the fallback rather than the default: it is reached only when the deployment configures an external provider, configures no in-AWS model for the case, and an admin has allowed it on the answering assistant's profile version.

**None of it is switched on.** The whole feature sits behind an opt-in flag that is off unless a deployment sets it, and the external path additionally needs an API key placed in the secret the stack creates. One classification's topology carries the capability; the flag that arms it is not set. With the flag off the processor does not call the resolver at all - it holds a null plan and keeps its original resolution - so read every claim below as shipped and unit-tested rather than as proven in service. No turn on either path has been exercised against a running deployment.

**Model choice and local knowledge are two independent things, and conflating them is the common error.** A model native to a language wins on fluency and on what it reasons about from its own weights; it does not know a specific venue's current hours or prices. That comes from tools, which are provider-independent. The plan's tool list is therefore a first-class resolver output - but no local-knowledge tool exists on any path, so the plan's tool list is empty at every return site and that accuracy win is unclaimed.

## Business Problem

A business running an assistant wants the strongest model that fits each turn and no more. One fixed model is either too weak for the hard turns or too costly for the easy ones, and the right choice depends on more than what the user asked: how sensitive the data is, what it costs, which country the subject matter is in, and which language the person is using. A platform that resolves a model from the user's clearance and the classified intent alone cannot express "route this turn by which region it is about", so the team either hand-rolls per-turn routing inside the turn engine - where every new variable is a new branch in code that already carries the conversation - or pays for the top model on every turn. Neither answer survives a second variable, and the first one makes the routing decision invisible to anybody auditing cost.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Three of them meet routing, and they meet it for three different reasons: the AI developer wants the best model per turn, the platform developer extends the seam to a provider the platform does not serve, and the admin / operator answers for what it spends and whether content crosses a border.

### AI developer

**How this relates to them:** they answer for answer quality within the classification's boundary, so routing is the lever that gets a harder model onto the hard turns and a cheaper one onto the rest. The lever they most need is the tool layer rather than the model layer, because local-fact accuracy is a tool question.

| What they need | Requirement |
|---|---|
| A model resolved from the turn's context rather than from its intent alone | FR1, FR3 |
| Turning the feature on that cannot change an empty-context turn | FR2 |
| A reasoning model that gets the budget it needs and is not offered tools | FR4 |
| A plan that degrades to an in-AWS model rather than failing the turn | FR5 |
| Tools selected per turn, so local knowledge is expressible as data rather than as prompt text | FR9 |
| The routing decision visible on the turn record, sliceable by the signal that caused it | FR10 |

### Platform developer

**How this relates to them:** they own the seam, so their question is whether a provider the platform does not serve can be added without touching the turn engine, and whether that provider inherits every control Bedrock gets for free.

| What they need | Requirement |
|---|---|
| One adapter for every OpenAI-compatible provider, invoked from one place | FR3 |
| Resilience on the non-Bedrock path that the platform does not get for free | FR5 |
| A guardrail on the non-Bedrock path, since an inline guardrail does not apply there | FR6 |
| A key read from a secret store rather than carried as a literal | FR7 |
| A new signal that costs a rule and never a call site | FR1 |

### Admin / operator

**How this relates to them:** they answer for the bill and for the data-handling posture. Non-AWS spend does not appear on the AWS bill, and a turn crossing a border is their decision to enable, so both have to be visible and both have to be reversible.

| What they need | Requirement |
|---|---|
| Every non-AWS call costed and attributed to its provider | FR8 |
| A per-turn limit in money, not only in call count | FR11 |
| A way back to in-AWS models that does not need a redeploy | FR12 |
| Cross-border processing gated at the deployment, by the classification's own model selection | FR7 |
| A console reading of the provider posture, the context rules and the external spend | FR13 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable. `Gap - prioritize` marks a table-stakes capability that is not delivered.

**Read `Delivered` as delivered in code.** No row has live evidence: the feature flag is off in every deployment of this repo, so every row below is shipped and unit-tested rather than proven in service.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | Model resolution is one pure function over an open signal bag, so a new routing variable is a rule and never a new call site | Differentiator | Yes - built, **NOT VERIFIED** on a deployment: the processor resolves every turn through `resolveModelPlan`, once, and the task's type and step are signals on `RoutingContext` ([ADR-064](../../../design/decisions/064-a-turn-takes-its-model-from-the-intent-and-the-step-it-runs.md) slice 2) | `resolve-model-plan` (unit, behavior), `a-step-picks-the-model-where-it-overrides-or-delivers` (unit, behavior and source) |
| FR2 | An empty routing context resolves to exactly the model the unrouted path resolves, so enabling the feature cannot change a turn that carries no signal | Table stakes | Yes | `resolve-model-plan` (unit, behavior) |
| FR3 | A turn routes on the person's language or the request's geographic segment: to an in-AWS model where one is configured, and otherwise through one adapter serving every OpenAI-compatible provider | Differentiator | Yes | `resolve-model-plan` (unit, behavior), `external-llm` (unit, behavior) |
| FR4 | A plan that selects a reasoning model says so, and the caller raises the answer budget and withholds tools | Differentiator | Yes | `resolve-model-plan` (unit, behavior) |
| FR5 | Every plan carries an in-AWS fallback and every non-Bedrock call is bounded: a per-attempt timeout, bounded retries on throttling, server error and timeout, and a throw on anything else so the caller falls back rather than retrying blind | Table stakes | Partly - the fallback and the bounds are built; no test drives the retry, timeout and fallback against a stubbed transport | `resolve-model-plan` (unit, behavior) |
| FR6 | A non-Bedrock call is bracketed by the standalone guardrail on input and on output, so the path is not a guardrail bypass and an input attack short-circuits the turn before the provider sees it | Table stakes | Yes | none - asserted only by reading the code |
| FR7 | Cross-border processing needs two configuration decisions, both the deployment's: the operator making a provider eligible, and the classification selecting the external model from the instance's catalog. The classification's stack holds the provider's key only where it selects it, and the processor checks the same selection on every turn, so no profile version, admin setting or experiment variant opens it | Table stakes | Yes | `an-external-model-is-the-classifications-to-select` (unit, behavior), `resolve-model-plan` (unit, behavior), `image-gen-iam-parity` (synth: the key exists exactly where it is selected), `external-provider-has-no-deployment-default` (unit, synth) |
| FR8 | Every non-AWS call computes its own cost from a per-provider rate card and is tagged as externally billed, because that spend never reaches AWS cost tooling | Table stakes | Partly - computed, tagged and logged; the cost estimator is keyed by catalog model and returns nothing for an external model id, so there is no analytics line, no console total and no budget alarm | `external-llm` (unit, behavior) |
| FR9 | The plan selects the tools for the turn, so local knowledge routes as data rather than as prompt text | Gap - prioritize | No - the field is on the plan and is empty at every return site | none |
| FR10 | The routing decision is on the turn record: the serving provider and model, the signal that caused the rule to fire, and the tools it selected | Differentiator | Partly - the serving provider and model ride the step record, and which rule chose the model rides the turn record as `model_from` with the task's intent and step (ADR-064, migrations 092 and 093); a folded queued message's exchange carries its own classified intent and the completing turn's `task_type`, `task_step`, `model_kind` and `model_from` (built and not deployed, 2026-10-29); the signal that fired a context rule and the tools do not, so per-segment routing is not sliceable | `a-step-picks-the-model-where-it-overrides-or-delivers` (unit, behavior and source), `a-folded-message-keeps-its-own-intent` (unit, behavior and source) |
| FR11 | A per-turn limit bounds a turn in money as well as in calls, and exceeding it ends the turn with a helpful reply and a logged cost event | Gap - prioritize | No - the deployment-level control caps model calls per person per hour and in total, which counts calls rather than dollars and does not distinguish a provider | none |
| FR12 | A spend threshold raises an alarm and can return the deployment to in-AWS models without a redeploy | Gap - prioritize | No - the only lever is removing the provider's configuration, which needs a redeploy | none |
| FR13 | An operator reads the provider posture, the context rules, the external-spend line and which classifications select an external provider in the console | Gap - prioritize | Partly - the Model Strategy tab shows which classifications select each model; the provider posture, the context rules and the external-spend line are not shown | none |
| FR14 | A repeated identical tool call inside a turn is served from cache rather than re-billed | Above bar - optional | No | none |
| FR15 | The geographic segment is derived without a per-turn lookup: resolved once when a location is saved and carried on the existing grounding path | Enabler | Partly - the explicit host-supplied segment is the only live source and rides the existing path; the save-time country resolution is host-side and not built | none |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/`, with the shared-library ones under `backend/test/lib/`; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists.

**The backward-compat matrix is the strongest evidence this document has, and it supports exactly one claim.** With the flag off the processor never calls the resolver, so nothing else here has run. What the matrix proves is that turning the feature on cannot change an empty-context turn, which is the claim the first deployment to switch the flag on relies on most.

**OPEN:** whether a spend kill-switch belongs at the deployment level or on the profile whose topology carries the capability. FR12 names the behavior and not the level.

**OPEN:** what an operator sees when a plan falls back. FR5 degrades silently by design, and a silent degrade that nobody is told about is indistinguishable from the feature not being enabled.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| Replacing the model catalog or the route strategy | The resolver extends them. The catalog is the deployment's set of available models with IAM behind each entry, and the route strategy is what a profile version's per-intent map is seeded from | [MODEL_STRATEGY.md](../../../guides/developer/MODEL_STRATEGY.md), [SPEC-ASSISTANT-CONFIG.md](./SPEC-ASSISTANT-CONFIG.md) |
| Re-checking the classification allowlist inside a context rule | The context rules are bounded by IAM rather than by the resolver: the model ARNs and the environment naming them are wired only for a profile whose topology enables the capability. Restating this as a resolver-level check would describe a guarantee the code does not make | FR3, and the classification-safety invariant in Appendix A |
| Reaching a user physically inside a restricted network | In-country reach is a deployment-topology problem rather than a model swap, and a call from this deployment's region to a provider hosted elsewhere adds a hop either way | Appendix A - why the non-Bedrock seam is its own layer |
| Rate-limiting a turn's outbound calls at the API gateway | Gateway throttling limits inbound requests. A loop calling a provider inside one turn never reaches the gateway, so the protection has to sit at the outbound call sites | FR11, FR14 |
| Choosing the reply language | Language is per person and per turn, and it is a signal this resolver reads rather than one it decides | [SPEC-BILINGUAL-CONVERSATIONS.md](./SPEC-BILINGUAL-CONVERSATIONS.md) |
| Deciding the model from the intent alone | The intent is one rule among four, and it is the third | [SPEC-CONFIGURABLE-INTENT-PACK.md](./SPEC-CONFIGURABLE-INTENT-PACK.md) |
| A circuit breaker on the non-Bedrock path | The in-AWS fallback is what bounds a sustained provider outage, and a breaker in front of a path that already falls back adds a second state machine for the same outcome | FR5 |
| A per-person opt-in to the external provider | Whether conversation content may leave AWS is a data-processing decision the deployment owns, made per classification by its model selection. A per-person flag would let one member's choice decide where a shared conversation's content is processed | FR7 |

## User Experience Description and Mocks

**Routing has no surface of its own beyond the serving model recorded on each turn and which classifications select each model in the Model Strategy tab.** There is no provider posture, no context-rule listing and no external-spend line, which is FR13. What each audience does:

1. **The AI developer sets the models the rules select** and reads the per-turn record to see which model served a turn. The signal that caused the selection is not on the record, so "why this model" is answerable from the code rather than from the console (FR10).
2. **The operator enables the capability on the deployment** and, for the non-AWS path, places a key in the secret the stack creates. Reversing that decision means removing the provider's configuration and redeploying, which is FR12.
3. **The deployment selects the external provider per classification** in the classification's `models`, and deploys that classification's stack (FR7). No admin setting or profile version changes it, and people in the conversation set nothing.
4. **Nothing changes for a turn that carries no signal.** That is the point of FR2 and it is what makes the feature safe to arm.

**OPEN:** this document carries no mocks. The candidates are the model-strategy surface extended with the provider posture and the context rules, and an external-spend line on the analytics overview - both of which are FR13 and neither of which exists.

## Related Documents

- [SPEC-BILINGUAL-CONVERSATIONS.md](./SPEC-BILINGUAL-CONVERSATIONS.md) - the per-model working language and the translation pivot that compose with this routing
- [SPEC-ASSISTANT-CONFIG.md](./SPEC-ASSISTANT-CONFIG.md) - per-profile model selection, which this resolver sits over
- [SPEC-CONFIGURABLE-INTENT-PACK.md](./SPEC-CONFIGURABLE-INTENT-PACK.md) - the intent signal, which is rule three
- [MODEL_STRATEGY.md](../../../guides/developer/MODEL_STRATEGY.md) - the catalog and the route strategy this generalizes
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above
- [TENETS.md](../../../overview/TENETS.md) - tenet P3 for the replaceable model, tenet P5 for per-step cost and quality control
- [SPEC-AURORA-VPC-MODE.md](../../foundations/SPEC-AURORA-VPC-MODE.md) - the deployment mode that makes a non-AWS call a networking question

## Appendix A - The mechanism

### The signals and the plan

The routing context carries the classification, which is mandatory and is today's only input, plus optional signals: the classified intent, the experiment override the router already resolved, the person's language, a geographic segment with a country, a region and coordinates, and a reserved open signal map that no rule reads yet. Absent signals mean today's behavior, unchanged. Whether the external provider is allowed is not a signal on the context: it is a resolver dependency taken from the answering assistant's profile version.

The plan carries the model reference, an optional fallback reference that is always an in-AWS plan, the working language for the translation pivot, the tools for the turn, and whether the plan chose a reasoning model. A model reference is provider-qualified - the serving provider rather than the model's author - so nothing widens to a bare model id.

### Rule order

1. The experiment override, unchanged.
2. The context rules. First a version's own routing rules (`models.routing`, ADR-060 decision 6, built and not deployed 2026-10-28): each is a condition over the turn's deciding values (the language signal, the conversation's type and classification) and a model, and the first whose condition holds and whose model the classification selects (`models.selected`) serves the turn, with the classification default as its fallback. A rule naming a model the classification does not select is passed over, so the classification's IAM grant stays the second layer. They run with or without the context-routing flag, because they select only what the classification's role already invokes. Verified by `backend/test/lib/a-variable-gates-what-runs.test.ts`. Then the built-in rule: a Chinese turn is one whose language signal is Chinese or whose segment names China; it selects the deployment's configured in-AWS chat model, or the configured reasoning model for the intents named as reasoning-heavy, and sets the working language accordingly, with the profile's baseline model as the plan's fallback.
3. The intent route.
4. The classification default.

### The non-Bedrock adapter

One adapter serves every OpenAI-compatible provider, because both providers in scope expose the same completions surface. It is configured per deployment from the environment and invoked from the shared processor when a plan's serving provider is not Bedrock. It is a function rather than a class, and its result carries the reply, an optional tool call, the token counts, the computed cost, the provider and an external-billing tag, so cost is attributable per provider.

Each adapter owns, end to end:

- **Resilience.** Bedrock reuses the platform's resilience layer. The adapter implements the equivalent itself: a per-attempt timeout, bounded retries with backoff on throttling, server errors and timeout, and a throw on anything else so the caller falls back to the in-AWS plan rather than retrying blind. There is no circuit breaker; the fallback is what bounds a sustained outage.
- **Tool-loop translation, partially.** The assistant uses the Bedrock tool-use shape and these providers use OpenAI-style function calling. The adapter passes the work-item tools in the provider's format and turns a returned tool call into a proposal marker, so propose-and-confirm keeps parity. It does not run a multi-turn tool loop: a tool call becomes a proposal for the person rather than an executed step, and a turn that needs the in-function loop stays on Bedrock.
- **The guardrail, out of band.** An inline guardrail does not apply to a non-Bedrock invocation, so the processor brackets the call with the standalone guardrail on the person's message before the provider sees it and on the returned text afterward. That is the compensating control the guardrail-parity invariant requires, and any future adapter does the same before it is enabled.
- **Egress.** In the VPC deployment mode the processor is VPC-attached, so an outbound call needs a network path. Networking is part of enabling a provider rather than an afterthought.
- **Key handling.** The key is read from the secret store and cached in the execution environment, never carried as an environment literal.

### Why the non-Bedrock seam is its own layer

- **Accuracy.** A model native to a language wins on fluency and on what it reasons about from its own weights. Local-fact accuracy belongs to the tool layer on either path (FR9), so the seam's contribution is the fluency and reasoning edge alone.
- **Cost.** One of these providers is markedly cheaper than the frontier tier and the other sits in the middle, so a non-Bedrock plan can lower per-turn cost on the traffic it serves. That spend sits outside AWS and has to be tracked explicitly.
- **Latency.** The deployment's region and these providers' hosting are far apart, so a non-Bedrock call adds a long hop from this infrastructure even where it would be faster for a person physically near the provider.
- **Catalog reality.** The seam exists because the in-AWS catalog is thin for this case. The catalog carries one Bedrock-served entry whose working language is Chinese, and that is what makes the in-AWS path the preferred one. The seam remains for the cases a Bedrock-served model cannot cover - a provider Bedrock does not serve, or reach for a person inside a restricted network.

### Deriving the geographic segment

The source already exists: a conversation's location markers carry coordinates and are already stamped into the conversation's context. Three options, simplest first:

1. **Explicit.** The host passes an active segment when the person is viewing or editing a specific location. Highest precision, no inference, and the only live source: the segment arrives on the federated create-conversation and add-member calls and is stored server-side.
2. **Subject classification.** A cheap classifier maps the turn's subject to a region using the conversation's markers, which handles a question about one leg of a multi-country conversation.
3. **Region-dominant.** Fall back to the conversation's primary country.

Options two and three are design; FR15 states what is delivered.

The country is resolved once when the location is saved rather than on every turn, which is cheaper and is why the explicit option is the only live source - the save-time resolution is host-side. Absent any signal means no segment and default routing.

### What crosses the wire

The segment rides the path the conversation grounding already uses: the host writes it, the server-only channel-context store holds it, the grounding assembler reads it back alongside the person's language, and the processor hands both to the resolver. No new transport. It is stored server-side rather than in channel metadata because it chooses the model, and channel metadata is member-writable. The segment path adds one derived tag; the open signal map ships empty.

### Later consumers, no new call sites

The same resolver routes on data sensitivity (personal data to a residency-constrained model and a stricter guardrail), a real-time need (a tool-heavy plan on a lower-temperature model), the person's expertise (verbosity and model strength), and a cost limit (a cheaper model and a smaller budget). Each is a rule plus optionally a signal key.

### The tool registry, and the half that is missing

What exists is the profile-level registry: the canonical set of Converse tools a profile version may enable, validated at the profile write path and applied at the turn by the allowlist filter. So which tools a profile may call is built and per-version.

Per-turn selection is FR9. The plan's tool list is empty at every return site, so the resolver selects no tools. The design for that half is that the plan's list references the same registry, extended with local-knowledge descriptors - a per-region local-search provider - each descriptor defining its provider call and its tool spec in both formats, so an adapter can present it correctly. The resolver picks which tools; the registry defines what they are.

### Cost safety, and which layer each control belongs to

Cost tracking is detection; this is prevention - stopping a bug or abuse from spiking spend. It matters more here than in a single-provider world, because a non-AWS provider has no AWS quota backstop and an external tool bills per call.

**The bounded-loop contract holds today.** The in-function tool loop caps its iterations, the platform's resilience layer caps retries and breaks the circuit, and the non-Bedrock adapter caps its own retries and per-attempt timeout. The contract requires every provider and every external tool to enforce a maximum iteration count, a retry cap and a breaker, and the cap has to cover the success-cost loop and not only the failure loop.

The rest are FR11, FR12 and FR14: a per-turn limit in money that ends the turn gracefully, a spend threshold that raises an alarm and returns the deployment to in-AWS models, and a tool-result cache keyed by the call and its arguments. Write idempotency is the one already in place: the apply endpoint dedupes a retried request by a client request id, so a resend never double-mutates or double-bills a downstream lookup.

### The external-provider gate

Two configuration decisions open the external path, both made by the deployment, and the classification's own stack enforces the second.

1. **Deployment enablement.** The data-processing agreement and the data-handling posture per provider, done once by the operator, which is what makes a provider eligible at all.
2. **The classification selects the external model.** The instance's model catalog lists the external adapter (`deepseek_api`, `EXTERNAL_MODELS` in `backend/lib/config/model-catalog.ts`) and names no classification; a classification may send content to it exactly when its own selection names it (`models.selected` on its registry entry, [MODEL_STRATEGY](../../../guides/developer/MODEL_STRATEGY.md#three-layers)). The shipped `standard` classification selects DeepSeek on Bedrock and not the adapter, so its Chinese turns take the in-AWS path. Synth refuses `deepseek_api` where no turn reaches it: beside `deepseek_v3`, where the in-AWS path wins, or on a classification that does not route by context. No admin setting, profile version or deployment context opens it: a version that carries the retired `models.externalProviderAllowed` field is read as absent and saved without it, and the retired `externalConsentDefault` key fails the synth with a message naming `models.selected`. Image generation's external providers follow the same rule, through the classification's selection of an image model hosted outside AWS.

**Rule 2a is preferred, so 2b runs only where the classification selects the adapter and not DeepSeek on Bedrock.** A classification that routes by context must select one Chinese path (`deepseek_v3` or `deepseek_api`), and synth refuses one that selects neither.

**The boundary is the classification's stack, and the handler checks the same selection.** The adapter's key secret (`DeepseekApiKey`), its read on the acting role and the processor's `DEEPSEEK_*` environment exist only in the stack of a classification that selects it, so a classification that does not select it holds no key to call it with. `externalProviderSelected` in `assistant-async-processor.ts` checks the selection on every turn as well; where a context rule resolves a non-AWS provider the classification does not select, the plan falls back to the in-AWS plan and is marked withheld, a gate rather than an error, so the person still gets an answer, and the processor logs `external provider withheld` once for the turn with the reason. Every assistant of a classification shares its selection, because a model is the classification's to select ([TENETS](../../../overview/TENETS.md) 12).

**An experiment cannot open it.** A variant serves a version, and no version carries a switch for it.

### Invariants

Each is marked with whether it holds in the code. With the feature flag off the context rules never fire, so the ones about non-Bedrock providers hold vacuously in every deployment of this repo: they are what the first deployment to arm the flag relies on, and none has live evidence.

- **Backward compatible** (holds). No segment and no extra signals resolves identically to the intent, classification and experiment path. Locked by the regression matrix.
- **Classification safety preserved** (holds, one layer down). Rules three and four go through the classification-aware resolver, which enforces the allowlist. The context rules do not re-check it; they return the deployment's configured model directly. What makes that safe is IAM: the model ARNs are added to the invoke grant only for a profile whose topology enables context routing, and the environment naming them is set only there, so a profile without the capability can neither name nor invoke the model. Do not restate this as a resolver-level check.
- **Resilience preserved** (holds). Bedrock keeps the platform's resilience layer; the adapter defines its own timeout and bounded retry and falls back on exhaustion.
- **Guardrail parity** (holds, hard gate). An inline guardrail does not apply to a non-Bedrock provider, so the path brackets the call with the standalone guardrail on input and output. Any future adapter does the same before enablement.
- **Cross-border export gated by two configuration decisions** (holds, in the classification's stack and in the handler). Both are the deployment's. The provider's key exists only in the stack of a classification that selects the external model, and the processor checks the same selection on every turn; a classification that does not select it is withheld. IAM does not separate assistants of one classification, because they share its selection.
- **External spend is always tracked** (partial). Every non-AWS call computes its cost and returns it tagged as externally billed, and the processor logs it. It is not in the analytics ledger, so "never silent" holds for logs and not for the console.
- **No unbounded outbound fan-out** (partial). Every call site is bounded by an iteration cap and, on Bedrock, a breaker. The per-turn limit and the spend cap are FR11 and FR12, so a turn's worst case is bounded in calls and not in dollars.
- **Tools are part of the plan** (structural only). The resolver outputs a tool list, which is what makes local-knowledge routing expressible as data. No descriptor is registered, so the field is empty on every path.

### What the tests owe

The backward-compat regression, the routing-decision matrix, the experiment-override rule, both forms of the context rule and the external-provider gate in both directions are covered, as are the processor's gate on the classification's selection, the refusal of the retired version field, and the key existing exactly where the external model is selected. What is not: the adapter's retry, timeout and fallback against a stubbed transport, and the external-billing tag on a real invocation - both asserted only by reading the code. Beyond that, the remaining console elements of FR13 and an end-to-end multi-country conversation against a deployment do not exist.

### Host and platform split

- **Platform:** the routing context, the resolver, the gate on each classification's selection of the external model, the OpenAI-compatible adapter, the catalog's per-model working language shared with the bilingual spec, the local-knowledge tool registry as design, and the routing telemetry and external cost tracking as far as they go.
- **The host application:** the raw signals it owns - the conversation's location markers, the save-time country on each marker, and an optional explicit segment hint. No host change is needed for the region-dominant fallback.
