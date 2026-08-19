# SPEC: Context-aware model routing (RoutingContext + provider adapter)

**Status:** Partial, and gated off - the routing feature ships behind an opt-in flag that no deployment in this repo sets, so none of it has run in service. **Built:** `RoutingContext` + `resolveModelPlan` (`lib/resolve-model-plan.ts`), the CN context rule in both of its forms - DeepSeek-on-Bedrock as the preferred in-AWS path and the OpenAI-compatible external adapter (`lib/providers/external-llm.ts`, DeepSeek / Qwen) as the fallback when no Bedrock CN model is configured - the per-user consent gate on the external path, the compensating guardrail around it, and per-call external cost computation.

**None of it is switched on.** The whole feature sits behind `ENABLE_CONTEXT_ROUTING`, which is opt-in (`-c enableContextRouting=true`) and off unless a deployment sets it, and the external path additionally needs an API key placed in the secret the stack creates. So a turn resolves through the unchanged intent+classification path today, and **no CN turn, in-AWS or external, has been exercised against a running deployment.** Read every "built" below as *shipped and unit-tested*, not as *proven in service*. With the flag off the processor does not call `resolveModelPlan` at all - it holds a null plan and keeps its original intent+classification resolution - so the resolver's backward-compat matrix is what stands in for the live evidence, and it is a strong stand-in for exactly one claim: that turning the feature on cannot change an empty-context turn.

**Design, NOT built:** the local-knowledge tool registry (`ModelPlan.tools` is empty at every return site), the per-turn budget ceiling and spend-cap kill-switch, tool-result caching, and the external-spend line in analytics and the admin console. Sections describing those are marked inline.

**Coverage:** `tests/e2e/agent-intents.spec.ts`

**Problem and who it's for:** A business running an assistant wants the strongest model that fits each turn and no more - a single fixed model is too weak for the hard turns or too costly for the easy ones - and the right choice depends on the turn's context (data sensitivity, cost ceiling, geographic segment, language), not just its intent. This is for the AI developer, who wants the strongest model that fits each turn within the classification cap, and the platform developer extending routing to non-Bedrock providers; the alternative is hand-rolling per-turn routing logic or paying for the top model on every turn. It defines the `RoutingContext` signal set and the provider-adapter seam that consumes it, so a deployment can route per turn without forking the processor.

**Site section:** Interaction layer, Assistant Configuration pillar.

> `RoutingContext` + `resolveModelPlan` live in `lib/resolve-model-plan.ts` and run in the shared `assistant-async-processor.ts`, gated on the standard profile's `contextRouting` topology flag (the profile's stack sets `ENABLE_CONTEXT_ROUTING` + the DeepSeek env only for that profile). The provider-adapter seam (`lib/providers/external-llm.ts`) extends them to non-Bedrock providers, and the generic signal consumers (data-sensitivity, cost-ceiling, ...) are later consumers of the same seam. The first routing consumer is a domain-specific deployment routing by **geographic segment**, but the capability is generic and belongs to the platform. The TypeScript shapes below are transcribed from the code; the prose marks what each section still owes.

## Why this exists

AgentEchelon resolves a model from **two** signals - user **tier** and classified **intent** - plus optional **A/B experiment** overrides (`MODEL_STRATEGY.md`, `lib/model-resolver.ts`, `lib/experiment-manager.ts`). On its own that is a closed set: a turn routes on nothing else.

Real products need routing on *more* signals. The motivating case: a single conversation spans subject matter in **US locations (Seattle, Napa)** and **CN locations (Beijing, Xi'an, Chengdu)**. The right model, language posture, and tool set differ **per geographic segment within one conversation** - a US-region turn wants English + US local sources; a China-region turn wants Chinese fluency + China local sources and possibly a Chinese-native model. A plain intent+tier resolver cannot express "route this turn by *which region* it is about."

Rather than bolt a `geography` special-case onto the resolver, model resolution generalizes to an **open routing context** so geography is the *first* consumer of a reusable seam - and `data-sensitivity`, `needs-realtime`, `user-expertise`, `cost-ceiling`, etc. are later consumers with **no new call sites**.

## Relationship to existing work (do not duplicate)

- **`MODEL_STRATEGY.md` / `model-strategy.ts`** - catalog + `INTENT_ROUTE_STRATEGY` + tier selection. The resolver that reads them *extends* them; it does not replace the catalog.
- **`lib/model-resolver.ts`** - maps intent to model with tier safety. One rule inside the generalized resolver.
- **`lib/bedrock-resilience.ts`** - retry/fallback/circuit-breaker. The provider adapter preserves this for Bedrock and defines the analog for any non-Bedrock provider.
- **`SPEC-BILINGUAL-CONVERSATIONS.md`** - the per-model `workingLanguage` attribute + a translation **pivot** are the *language* half of "the China case"; this routing is the *routing* half, and they compose.
- **Bilingual reply-language:** `userLanguage` is written to the server-only Channel Context store, forwarded by the router, and rendered as a reply-language instruction - the language signal `RoutingContext` reuses. It is kept out of member-writable channel metadata precisely because it selects the model, not only the wording.

## Core concepts

### 1. `RoutingContext` - an open bag of per-turn signals
As built, in `backend/lambda/src/lib/resolve-model-plan.ts`:

```ts
interface RoutingContext {
  classification: Classification;             // existing (the platform-internal name for tier)
  intent?: string;                            // existing
  experimentModelId?: string;                 // existing - the override the router already resolved
  userLanguage?: string;                      // existing (bilingual Level 1)
  // Generic, optional signals; absent ⇒ today's behavior unchanged:
  segment?: { country?: string; region?: string; lat?: number; lng?: number };
  externalModelConsent?: boolean;             // per-user gate for non-AWS providers (see §Consent)
  signals?: Record<string, string | number | boolean>; // reserved; no rule reads it yet
}
```
`classification` is mandatory (today's input); everything else is optional and additive. Empty `segment`/`signals` ⇒ **the current behavior, unchanged** (safety invariant).

### 2. `resolveModelPlan(ctx): ModelPlan` - the generalized resolver
```ts
type ServingProvider = 'bedrock' | 'deepseek' | 'qwen';   // who SERVES the model, not who made it
interface ModelRef {
  modelKey: BackendModelKey | string;
  modelId: string;                    // the provider invoke id (a Bedrock model / inference-profile id today)
  provider: ServingProvider;          // provider-qualified, no bare widening
}
interface ModelPlan {
  ref: ModelRef;
  fallback?: ModelRef;                // always a Bedrock plan, so a CN rule degrades rather than fails
  workingLanguage: string;            // for the bilingual pivot
  tools: string[];                    // from the tool registry - EMPTY on every path today (see §Tool registry)
  reasoning?: boolean;                // the plan chose a reasoning model: raise maxTokens, skip tool-use
}
```
**This resolver unifies two code paths that were separate before:** experiment resolution in `router-agent-handler.ts` (which forwards `resolvedModel`) and intent/classification resolution in the per-profile processor (`getModelCatalog` + `INTENT_ROUTE_STRATEGY`). Merging them into one pure function is the core of the resolver, and the backward-compat invariant (empty context yields an identical plan) is what keeps that unification safe.

Rule order (first match wins):
1. experiment override (unchanged)
2. context rules (e.g. a Chinese turn → the CN plan)
3. intent route (today's `INTENT_ROUTE_STRATEGY`)
4. classification default

Rules 3 and 4 run through `model-resolver.ts`, which enforces the classification allowlist - a
basic-classification turn can never resolve a premium-only model. Rule 2 returns the deployment's
configured CN model without that check, and is bounded by IAM instead; see the classification-safety
Invariant, which explains why that distinction has to stay visible.

### 3. Provider adapter - the non-Bedrock seam

**Built, and never yet enabled here** (see Status). The operational experience behind this design comes
from another project; in this repo the adapter is shipped, unit-tested code that no deployment has
switched on.

The seam is `backend/lambda/src/lib/providers/external-llm.ts`: one adapter for every OpenAI-compatible
provider (DeepSeek and Qwen both expose `/chat/completions`), configured per deployment by
`externalProviderFromEnv` and invoked from `assistant-async-processor.ts` when the plan's
`ref.provider` is not `bedrock`. It is a function rather than a class:

```ts
invokeExternalLlm(cfg: ExternalProviderConfig, systemPrompt: string,
                  messages: ConversationMessage[], opts): Promise<ExternalInvokeResult>
```

`ExternalInvokeResult` carries `{ response, toolCall?, inputTokens, outputTokens, costUsd, provider,
billedBy: 'external' }` so cost is attributable per provider (see §Observability).

Each adapter owns, end-to-end:
- **Resilience** (built) - Bedrock reuses `bedrock-resilience`; the external adapter implements the
  equivalent itself: a per-attempt timeout, bounded retries with backoff on 429/5xx and on timeout, and
  a throw on anything else so the caller falls back to the Bedrock plan rather than retrying blind.
  There is no circuit breaker on the external path; the Bedrock fallback is what bounds a sustained
  outage.
- **Tool-loop translation** (partial) - the assistant uses Bedrock Converse **tool-use**. DeepSeek/Qwen
  use OpenAI-style function-calling. The adapter passes the work-item tools in OpenAI format and
  translates a returned `tool_calls[0]` into a proposal marker, so propose-and-confirm keeps parity on
  the external path. It does NOT run a multi-turn tool loop: a tool call becomes a proposal for the
  user rather than an executed step, and turns that need the in-Lambda loop stay on Bedrock.
- **Guardrail** (built, out of band) - Bedrock Guardrails do not apply *inline* to a non-Bedrock
  invocation, so the processor brackets the external call with the standalone `ApplyGuardrail` API:
  `applyInputGuardrail` runs on the user message **before** the provider sees it (a prompt attack
  short-circuits the turn with no external call) and `applyOutputGuardrail` runs on the returned text.
  That is the compensating control the Invariant requires.
- **Egress** - in Aurora mode the processor is VPC-attached; outbound calls to DeepSeek/Qwen require a
  NAT path. Networking is part of enabling a provider, not an afterthought.
- **Key handling** (built) - the API key is read from Secrets Manager and cached in the execution
  environment, never carried as an env literal.

## Separation of concerns (the accuracy lever)

Two independent things, often conflated:
- **Model choice** - fluency + reasoning over local context, cost, latency.
- **Local knowledge** - current facts (hours, prices, "best X near Y"). This comes from **tools/RAG** (a per-region local-search provider), **not** the base model's memory.

**The biggest accuracy win for local answers is the tool/RAG layer, which is provider-independent.** A CN-native model improves Chinese fluency + parametric China reasoning; it does not, by itself, know a specific Xi'an venue's current hours or prices. Therefore `ModelPlan.tools` is a first-class resolver output. **The local half of that layer is design, not built:** the Bedrock path delivers the profile-level tool surface (company context, work-item edits, task advance), and no local-knowledge tool exists on any path, so this accuracy win is unclaimed today (see §Tool registry).

## Tool registry

**Design, not built.** `ModelPlan.tools` is `[]` at every return site in `backend/lambda/src/lib/resolve-model-plan.ts` today, so the resolver selects no tools per turn.

What DOES exist is the profile-level tool registry: `backend/lambda/src/lib/tool-registry.ts` is the canonical set of Converse tools a profile version may enable, validated at the profile write path and applied at the turn by `filterToolSpecsByProfile` in `lib/async-processor-core.ts`. So *which tools a profile may call* is built and per-version; *which tools a turn selects from routing context* is not.

The design for the missing half: `ModelPlan.tools` references the same registry, extended with local-knowledge descriptors (a per-region local-search provider). Each descriptor defines its provider call and its Converse/function-calling tool spec, so an adapter can present it in the right format. The resolver picks *which* tools; the registry defines *what* they are. No local-knowledge descriptor is implemented today.

## The routing generalization and the provider-adapter seam

The architecture has two layers: a Bedrock-native base and a gated non-Bedrock extension. They share `RoutingContext` and `resolveModelPlan`, so the extension adds no new call sites. **Both layers are built and both are switched off** (see Status); what each still owes is marked below.

**Routing generalization (Bedrock-native).** `RoutingContext` + `resolveModelPlan` generalize model resolution while leaving Bedrock behavior unchanged for empty context, and the backward-compat invariant is locked by `backend/test/lib/resolve-model-plan.test.ts`. A Chinese turn - `userLanguage === 'zh'` OR `segment.country === 'CN'` - selects the deployment's CN Bedrock models (`CN_BEDROCK_CHAT_MODEL`, with `CN_BEDROCK_REASONING_MODEL` for the intents named in `CN_BEDROCK_REASONING_INTENTS`) and sets `workingLanguage: 'zh'`, with the profile's baseline model as the plan's fallback. A reasoning plan raises `maxTokens` and skips tool-use, because a reasoning model spends its budget on the chain of thought and is unreliable at tools. This layer is the **preferred** CN path: it stays in AWS, so it keeps Bedrock guardrails, resilience and billing and needs no consent gate. Still owed: the CN tool set (see §Tool registry) and per-marker save-time reverse geocoding, without which the `segment` signal only arrives when the host supplies it explicitly.

**Provider-adapter seam (non-Bedrock, gated).** A `provider:'deepseek'|'qwen'` plan invokes through `external-llm.ts` with its own resilience, the OpenAI-format work-item tools, a bracketing guardrail, and per-call cost computation; a failed call falls back to the Bedrock plan in the same turn. It is reached only when the deployment configures an external provider and **no** CN Bedrock model, and only when per-user consent is satisfied - so the cross-border path is the fallback, not the default. Still owed: a dedicated kill-switch flag (today the lever is removing the provider's env config, which needs a redeploy) and the external-spend line described in §Observability.

The seam is a distinct layer rather than folded into the base, for four reasons:
- **Accuracy.** A CN-native model wins on Chinese fluency + parametric China knowledge, but local-fact accuracy (hours, prices, "best X near Y") is the tool layer. That layer is not built on either path yet (see §Tool registry), so the seam's contribution today is the fluency/reasoning edge alone.
- **Cost.** DeepSeek is markedly cheaper than Sonnet-4-class (Qwen sits in the middle), so a non-Bedrock plan can lower per-turn cost on CN traffic. That spend is outside AWS, however, and must be tracked explicitly (see §Observability).
- **Latency.** The backend is `us-east-1`; DeepSeek/Qwen are China/SG-hosted, so a non-Bedrock call adds a trans-Pacific hop and is slower from the deployment's infrastructure even though it is faster for a user physically in China. In-country reach is a deployment-topology problem, not a model swap, and is out of scope here.
- **Bedrock reality.** First-class Chinese options on Bedrock are thin, which is why the seam exists as its own layer. It is thinner than it was: the catalog now carries a DeepSeek entry served by Bedrock (`deepseek_v3` in `backend/lib/config/model-strategy.ts`), and that is what makes the in-AWS CN path preferable to crossing the border. The seam remains for the cases a Bedrock-served model cannot cover - a provider Bedrock does not serve, or reach for users physically in China.

## Observability, cost tracking & flagging

- **Feature flag** (built). Context routing runs dark behind `ENABLE_CONTEXT_ROUTING` (per-deployment), and a turn resolves an external provider only when that deployment also configures one. `EXTERNAL_MODEL_CONSENT_DEFAULT` (host config) seeds the per-user consent default - `true` in the private phase, `false` once the site opens (see §Consent). **Not built:** a kill-switch that reverts non-Bedrock providers to Bedrock without a redeploy.
- **Routing telemetry** (partial). The turn's step record carries the serving provider and model in `modelUsed` (`deepseek:<model>` on the external path, the CN model id on the in-AWS path), so provider attribution reaches analytics. **Not built:** emitting `segment` and `tools` alongside `wasFallback` / `experimentId`, so per-segment routing is not sliceable and the admin Model Strategy tab surfaces no context rules.
- **Cost tracking - external (non-AWS) spend is first-class** (partial). Bedrock spend lands on the AWS bill; **DeepSeek/Qwen spend does NOT** - it is invisible to AWS cost tooling, so it MUST be tracked in-app or it is unobservable. The adapter computes `costUsd` from a per-provider rate card (`ExternalProviderConfig.usdPerMTok*`, seeded from env with per-provider defaults) and returns it tagged `billedBy: 'external'`; the processor writes it to the turn log. **Not built:** the ledger half. `estimateStepCostUsd` is keyed by `BackendModelKey` and honestly returns `null` for an external model id, so external spend has no analytics line, no admin total, and no budget alarm - it is attributable only from logs.

## Cost safety & runaway protection

Cost **tracking** (above) is detection; this is **prevention** - stopping a coding bug or abuse from spiking spend. It matters more here than in a Bedrock-only world: non-AWS providers have **no AWS quota backstop**, and external tool APIs bill per call.

**Build status: item 1 only.** The bounded-loop contract holds today - the in-Lambda tool loop caps at `MAX_TOOL_ITERATIONS` (3), `bedrock-resilience` caps retries and circuit-breaks, and the external adapter caps its own retries and per-attempt timeout. Items 2 to 4 - the per-turn budget ceiling, the spend-cap alarm and kill-switch, and tool-result caching - are **design, not built**; the deployment-level abuse controls (`backend/lambda/src/lib/abuse-controls.ts`) cap model CALLS per user per hour and globally, which is a coarser backstop than a per-turn ceiling: it counts calls rather than dollars and does not distinguish an external provider from Bedrock.

**Wrong layer (intentionally unchanged):** API Gateway throttling rate-limits *inbound* user requests - it does nothing about a single turn's *outbound* fan-out of model/tool calls. A loop calling a model provider or an external tool within one Lambda turn never reaches the gateway. So inbound throttling stays as-is; protection lives at the outbound call sites (defense in depth):

1. **Bounded loops at every call site (contract).** The in-Lambda tool loop already caps at `MAX_TOOL_ITERATIONS`; `bedrock-resilience` caps retries + circuit-breaks. The adapter contract REQUIRES every provider **and every external tool** to enforce a max-iterations + retry cap + circuit breaker. No call site may loop unbounded - and the cap covers the *success-cost* loop, not only the failure loop.
2. **Per-turn budget ceiling.** A hard cap on model+tool calls (and estimated $) per turn; exceeding it **aborts the turn gracefully** (user-facing "couldn't finish that" + a logged cost-event) rather than running away. Bounds the blast radius of any single runaway turn - the main defense against "a coding change loops on the same API."
3. **Spend caps → alarm → kill-switch.** Tie to the cost tracking: when external (or total) spend crosses a threshold over a window (per-conversation / per-user / per-deployment), fire a budget alarm and (optionally auto-)trip the non-Bedrock kill-switch back to Bedrock. Backstop for a bug that escapes per-turn caps (e.g. a cross-turn poll loop).
4. **Tool-result caching / dedupe.** External tool calls are cached by `(tool, args)` for a TTL and deduped within a turn, so repeated identical lookups - from a buggy loop OR normal repetition - don't re-bill. (Reverse-geocode already moved to save-time, not per-turn, for the same reason.) This is the direct answer to "hitting the same API repeatedly."
5. **Idempotency on writes.** The apply endpoint dedupes a retried/duplicated POST by a client request id so a resend never double-mutates or double-bills downstream lookups.

## Consent & governance (per-user opt-in)

Non-AWS providers are gated by **two layers** (see the cross-border Invariant):

1. **Operator/deployment enablement** - the DPA + data-handling posture per provider. Done once by the operator; it's what makes a provider *eligible* at all.
2. **Per-user consent** - `externalModelConsent`, a per-user flag whose default is set by deployment config `EXTERNAL_MODEL_CONSENT_DEFAULT`. This is the lever for the private→public lifecycle:
 - **Private / single-tenant phase (the operator + a known, consenting set of users):** default
     **`true`**. The operator is the data controller for a known, consenting set of users;
     consent is implicit and expressed by the config default - no per-user click. Chinese / other
     non-AWS models are on by default.
 - **Multi-tenant phase (serving other tenants, entering locales that route to non-AWS
     models):** `EXTERNAL_MODEL_CONSENT_DEFAULT` is **`false`**. New users explicitly **opt
     in**, with copy explaining their conversation may be processed by a provider outside AWS / in
     another region (the data-residency / privacy disclosure). Existing users keep their stored
     value - the flip is not retroactive.

**Enforcement** (built) - `externalModelConsent` is a `RoutingContext` signal. If a context rule resolves a non-AWS provider but consent is `false`, `resolveModelPlan` **falls back to the Bedrock plan** (graceful: the user still gets an answer, on an in-AWS model). This mirrors the tier-safety downgrade - a gate, not an error. The preferred CN path needs no such gate by construction: DeepSeek-on-Bedrock stays in AWS, so no conversation content crosses the border.

**Plumbing - designed to reuse the bilingual Level-1 path verbatim, and NOT built.** The design: the host application stores the flag on the user (`USERS` table), exposes it via `PUT /me` + a toggle in its settings page (next to the language setting), and passes it in the assistant-session POST alongside `userLanguage`; AgentEchelon writes it to the server-only Channel Context store, the router forwards it, and the resolver gates on it. No new transport. **What runs today** is the deployment default alone: `RoutingContext.externalModelConsent` has no writer, so `resolveModelPlan` falls through to `EXTERNAL_MODEL_CONSENT_DEFAULT` for every user. That is sufficient for the private phase, where the default expresses a known and consenting set of users, and it is **not** sufficient for the multi-tenant phase, which is what the per-user half exists for. Until the plumbing lands, setting the default to `false` is what keeps a non-consenting deployment in AWS.

## Admin console & testing impacts

**None of the console work below is built.** Routing is invisible to an operator today beyond the
serving model recorded on each turn: no provider posture, no context rules, no external-spend line, no
consent column. Most of the backend testing below DOES exist; the console, host and e2e tests do not.

**AE operator console** (`frontend/packages/admin/src/components/admin/*` - Overview / Conversations / Quality / Models / Experiments / Users):
- **Models / Model Strategy tab** (read-only mirror `frontend/packages/shared/src/config/modelStrategy.ts`): add **provider posture** (which catalog entries are external / non-AWS), `workingLanguage`, and the new **context rules** (e.g. `segment.country === 'CN'` → plan). Read-only is fine for v1; the mirror config gains `provider` / `workingLanguage` / `external` / `costRateCard` fields to match the backend catalog.
- **Overview / analytics:** add the **external-spend line** (from §Observability cost tracking) + optional budget alarm, and surface routing-decision telemetry (provider / segment / tools).
- **Users tab:** surface each user's `externalModelConsent` (operator view, read-only - the toggle itself is host-side).

**The host application:** the user-facing **consent toggle + disclosure copy** lives in the host's settings page, i18n'd through the locale system (coordinate with the i18n session, same as the proposal-card keys).

**Testing:**
- **Backend** (built) - `backend/test/lib/resolve-model-plan.test.ts` holds the backward-compat regression across the classification x intent matrix, the experiment-override rule, both CN rules (external and DeepSeek-on-Bedrock, including that the in-AWS path is NOT consent-gated and wins over a configured external provider), and the consent-gate cases in both directions. `backend/test/lib/external-llm.test.ts` covers the message translation, the rate-card cost computation and the env-config builder. **Not covered:** the adapter's retry / timeout / fallback behaviour against a stubbed HTTP layer, and the `billedBy:'external'` tag on a real invocation - both of those are asserted only by reading the code.
- **AE admin console** (not built) - unit + Playwright for the new Models / Overview / Users elements (provider posture, external-spend line, consent column).
- **Host** (not built) - settings-toggle test for `externalModelConsent` round-trip via `PUT /me` (host-side; coordinate with the i18n session that owns that page).
- **E2E** (not built) - a multi-country test conversation × a consenting vs non-consenting user, asserting different routing (CN model+tools vs Bedrock fallback) per segment. Nothing exercises the CN path against a deployment today.

## Deriving `segment` (the new signal)

Source already exists: the conversation's location markers carry `lat/lng`, and they are already stamped into the conversation context. Options, simplest first:
1. **Explicit** (built) - the host passes an "active segment" when the user is viewing/editing a specific location (highest precision, no inference). This is the only source wired today: `segment` arrives on the federated create-conversation and add-member calls and is stored server-side.
2. **Subject classification** (not built) - a cheap classifier maps the turn's subject to a location/region using the conversation's markers (handles "what about the Beijing part?").
3. **Region-dominant** (not built) - fall back to the conversation's primary country.

`country` is **reverse-geocoded at save time** and stored on the location marker (reusing the host application's geocoding), which is cheaper than per-turn geocoding. That geocoding is host-side and not built, which is why option 1 is the only live source. Absent any signal ⇒ no `segment` ⇒ default routing.

## What context crosses the wire

**Built.** `segment` rides the **existing** path the conversation grounding already uses (host → the server-only Channel Context store → `invokeAsync` payload → resolver): `federated-create-conversation.ts` and `federated-add-member.ts` write it, `lib/host-grounding.ts` reads it back out of the store with `userLanguage`, and the processor hands both to `resolveModelPlan`. No new transport. It is stored server-side rather than in channel metadata because it chooses the model, and metadata is member-writable. The segment path adds one derived tag; `signals` is reserved for future variables and ships empty.

## Generalization (other variables, no new call sites)

The same `RoutingContext` + `resolveModelPlan` also routes on:
- `data-sensitivity` (PII → a residency-constrained model + stricter guardrail)
- `needs-realtime` (→ a tool-heavy plan, lower-temperature model)
- `user-expertise` (novice vs expert → verbosity/model tier)
- `cost-ceiling` (budget signal → cheaper model + smaller `maxTokens`)

Each is a new **rule** + (optionally) a new **signal key**, never a new call site.

## Invariants

Each invariant is marked with whether it HOLDS in the code today. An invariant that does not yet hold
is a requirement on the increment that lands the feature, not a description of the system.

Read "holds" as *holds in the code*. With `ENABLE_CONTEXT_ROUTING` off, the CN rules never fire, so
the ones about external providers hold vacuously in every deployment of this repo - they are what the
first deployment to switch the flag on will be relying on, and none of them has live evidence.

- **Backward compatible** (holds). Empty `segment`/`signals` ⇒ identical to today's intent+tier+experiment routing. Enforced by the regression matrix in `backend/test/lib/resolve-model-plan.test.ts`.
- **Classification safety preserved** (holds, one layer down). Rules 3 and 4 go through `resolveModelForIntent`, which enforces the classification's allowlist. The CN rules do NOT re-check it: they return the deployment's configured CN model directly. What makes that safe is IAM rather than the resolver - the CN model ARNs are added to `bedrock:InvokeModel` only for a profile whose topology enables context routing, and the env that names them is set only there, so a profile without the capability can neither name nor invoke the model. **Do not restate this as a resolver-level check**: a rule added above the classification-aware path would inherit the same gap with none of the IAM backstop.
- **Resilience preserved** (holds). Bedrock keeps `bedrock-resilience`; the external adapter defines its own timeout + bounded retry, and falls back to the Bedrock plan on exhaustion.
- **Guardrail parity (hard gate)** (holds). Bedrock Guardrails do not apply inline to external providers; the external path brackets the call with the standalone `ApplyGuardrail` API on input and output. Any future adapter MUST do the same before enablement.
- **Cross-border data export gated (hard gate), two layers** (holds at the deployment layer only). Sending conversation/context/PII to a non-US / non-AWS provider requires BOTH: (a) **operator/deployment enablement** - a DPA + data-handling posture (no-train, retention) per provider, satisfied once by the operator; and (b) **per-user consent** - `externalModelConsent` (see §Consent). Layer (a) holds: an external provider is reachable only when the deployment configures one AND no CN Bedrock model is set. Layer (b) is enforced in the resolver but fed only by the deployment default, because the per-user signal has no writer - so today the second layer is deployment-wide rather than per-user.
- **External spend is always tracked** (partial). Every external call computes `costUsd` and returns it tagged `billedBy: 'external'`, and the processor logs it. It is not yet in the analytics ledger, so "never silent" holds for logs and not for the console.
- **No unbounded outbound fan-out** (partial). Every model/tool call site is bounded by an iteration cap and, on Bedrock, a circuit breaker. The per-turn budget ceiling and the external spend cap are **not built** (see §Cost safety), so a single turn's worst case is bounded in CALLS but not in dollars.
- **Tools are part of the plan** (structural only). The resolver outputs `tools`, which is what makes local-knowledge routing expressible as data rather than as a system prompt. No descriptor is registered, so the field is empty on every path and nothing routes on it yet.

## Testing

- **Backward-compat regression** (required): empty `RoutingContext` ⇒ the resolver returns the same model as the current router+processor path, across the tier×intent matrix.
- **Routing-decision matrix:** `resolveModelPlan` is pure → a table-driven unit matrix of context → expected plan (incl. tier-safety downgrades and CN/US segment rules).
- **E2E:** a multi-country test conversation (US + CN locations) asserting per-segment model/tool/language.
- **Adapter (non-Bedrock providers):** per-provider tool-loop + resilience + cost-emission tests; no provider enabled without them.
- **Cost safety (runaway):** a turn that would exceed the per-turn budget aborts + emits a cost-event; a forced tool-loop stops at the iteration cap; a repeated identical tool call hits the cache (no second external bill); a duplicated apply POST is idempotent.

## Host vs AgentEchelon split

- **AgentEchelon (reusable):** `RoutingContext`, `resolveModelPlan`, the OpenAI-compatible external adapter that serves DeepSeek and Qwen, the catalog `workingLanguage` attribute (shared with the bilingual spec), the local-knowledge tool registry (design), routing telemetry + external cost tracking (partial - see §Observability).
- **The host application:** supplies the raw signals it owns - the conversation's location markers (already sent), the save-time `country` on each marker, an optional explicit "active segment" hint, and the per-user `externalModelConsent` (stored on the user, toggled in the host's settings page, passed in the session POST). No host change for the dominant-region fallback.

## Related docs

- `docs/guides/developer/MODEL_STRATEGY.md` - the catalog + intent routing this generalizes.
- `docs/specs/interaction/assistant-config/SPEC-BILINGUAL-CONVERSATIONS.md` - `workingLanguage` + the language pivot that composes with this routing.
- The host application supplies the geographic signal (per-marker coordinates + save-time `country`) that sources the `segment` signal.
- `backend/lib/config/model-strategy.ts`, `lib/model-resolver.ts`, `lib/bedrock-resilience.ts`, `lib/async-processor-core.ts` (`estimateStepCostUsd`, tool loop) - the code seams extended here.
