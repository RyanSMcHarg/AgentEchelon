# SPEC: Context-aware model routing (RoutingContext + provider adapter)

**Status:** Partial (`RoutingContext` runs on the standard profile; the provider-adapter seam is design)

> `RoutingContext` + `resolveModelPlan` live in `lib/resolve-model-plan.ts` and run in the shared
> `assistant-async-processor.ts`, gated on the standard profile's `contextRouting` topology flag
> (the profile's stack sets `ENABLE_CONTEXT_ROUTING` + the DeepSeek env only for that profile). The provider-adapter seam extends them to
> non-Bedrock providers, and the generic signal consumers (data-sensitivity, cost-ceiling, ...)
> are later consumers of the same seam. The first routing consumer is a domain-specific deployment
> routing by **geographic segment**, but the capability is generic and belongs to the platform.
>
> The TypeScript interfaces below are **illustrative** (shape, not final signatures).

## Why this exists

AgentEchelon resolves a model from **two** signals - user **tier** and classified
**intent** - plus optional **A/B experiment** overrides (`MODEL_STRATEGY.md`,
`lib/model-resolver.ts`, `lib/experiment-manager.ts`). On its own that is a closed set: a turn
routes on nothing else.

Real products need routing on *more* signals. The motivating case: a single conversation spans
subject matter in **US locations (Seattle, Napa)** and **CN locations (Beijing, Xi'an, Chengdu)**.
The right model, language posture, and tool set differ **per geographic segment within one
conversation** - a US-region turn wants English + US local sources; a China-region turn wants
Chinese fluency + China local sources (Amap/Gaode, Dianping) and possibly a Chinese-native model.
A plain intent+tier resolver cannot express "route this turn by *which region* it is about."

Rather than bolt a `geography` special-case onto the resolver, model resolution generalises to an
**open routing context** so geography is the *first* consumer of a reusable seam - and
`data-sensitivity`, `needs-realtime`, `user-expertise`, `cost-ceiling`, etc. are later consumers
with **no new call sites**.

## Relationship to existing work (do not duplicate)

- **`MODEL_STRATEGY.md` / `model-strategy.ts`** - catalog + `INTENT_ROUTE_STRATEGY` + tier
  selection. The resolver that reads them *extends* them; it does not replace the catalog.
- **`lib/model-resolver.ts`** - maps intent to model with tier safety. One rule inside
  the generalised resolver.
- **`lib/bedrock-resilience.ts`** - retry/fallback/circuit-breaker. The provider adapter
  preserves this for Bedrock and defines the analogue for any non-Bedrock provider.
- **`SPEC-BILINGUAL-CONVERSATIONS.md`** - the per-model `workingLanguage` attribute + a
  translation **pivot** are the *language* half of "the China case"; this routing is the
  *routing* half, and they compose.
- **Bilingual reply-language:** `userLanguage` is stamped into channel metadata, forwarded by
  the router, and rendered as a reply-language instruction - the language signal `RoutingContext`
  reuses.

## Core concepts

### 1. `RoutingContext` - an open bag of per-turn signals
```ts
interface RoutingContext {            // illustrative
  tier: 'basic' | 'standard' | 'premium';   // existing
  intent: RouteKey;                           // existing
  userLanguage?: string;                      // existing (bilingual Level 1)
  // NEW — generic, optional signals; absent ⇒ today's behavior unchanged:
  segment?: { country?: string; region?: string; lat?: number; lng?: number };
  externalModelConsent?: boolean;             // per-user gate for non-AWS providers (see §Consent)
  signals?: Record<string, string | number | boolean>; // future variables
}
```
`tier` + `intent` are mandatory (today's inputs); everything else is optional and additive.
Empty `segment`/`signals` ⇒ **the current behavior, unchanged** (safety invariant).

### 2. `resolveModelPlan(ctx): ModelPlan` - the generalized resolver
```ts
type ModelRef = { modelKey: BackendModelKey; provider: 'bedrock' }
              | { modelKey: string; provider: 'deepseek' | 'qwen' }; // provider-qualified, no bare widening
interface ModelPlan {                 // illustrative
  ref: ModelRef;
  workingLanguage: string;            // for the bilingual pivot
  tools: ToolKey[];                   // from the tool registry (see §Tool registry)
  fallback?: ModelRef;
}
```
**This resolver unifies two code paths that were separate before:** experiment resolution in
`router-agent-handler.ts` (which forwards `resolvedModel`) and intent/tier resolution in the
per-tier processor (`getModelCatalog` + `INTENT_ROUTE_STRATEGY`). Merging them into one pure
function is the core of the resolver, and the backward-compat invariant (empty context yields an
identical plan) is what keeps that unification safe.

Rule order (first match wins; every rule re-checks **tier safety** - a basic-tier turn can
never resolve a premium-only model, exactly as `model-resolver.ts` does today):
1. experiment override (unchanged)
2. context rules (NEW - e.g. `segment.country === 'CN'` → CN plan)
3. intent route (today's `INTENT_ROUTE_STRATEGY`)
4. tier default

### 3. Provider adapter - the non-Bedrock seam
```ts
interface ProviderAdapter {           // illustrative
  invoke(plan: ModelPlan, system: string, messages: ConversationMessage[], opts): Promise<InvokeResult>;
}
```
`InvokeResult` MUST carry `{ inputTokens, outputTokens, provider, costUsd }` so cost is
attributable per provider (see §Observability).

Each adapter owns, end-to-end:
- **Resilience** - Bedrock reuses `bedrock-resilience`; every non-Bedrock adapter implements an
  equivalent (retry / fallback / circuit-breaker / fail-fast on auth).
- **Tool-loop translation** - the assistant uses Bedrock Converse **tool-use**.
  DeepSeek/Qwen use OpenAI-style function-calling - a different request schema and loop.
  The adapter MUST translate the in-Lambda tool loop into its provider's format; a provider
  without a working tool loop cannot serve those turns.
- **Guardrail** - `applyOutputGuardrail` / Bedrock `ApplyGuardrail` is **Bedrock-only** and does
  NOT cover external providers. A non-Bedrock adapter MUST supply a compensating control
  (out-of-band PII/prompt-injection check) before enablement (see Invariants).
- **Egress** - in Aurora mode the processor is VPC-attached; outbound calls to DeepSeek/Qwen
  require a NAT path. Networking is part of enabling a provider, not an afterthought.

## Separation of concerns (the accuracy lever)

Two independent things, often conflated:
- **Model choice** - fluency + reasoning over local context, cost, latency.
- **Local knowledge** - current facts (hours, prices, "best X near Y"). This comes from
  **tools/RAG** (Amap/Gaode + Dianping for CN; Google Places/Yelp for US), **not** the base
  model's memory.

**The biggest accuracy win for local answers is the tool/RAG layer, which is
provider-independent.** A CN-native model improves Chinese fluency + parametric China
reasoning; it does not, by itself, know a specific Xi'an venue's current hours or prices. Therefore
`ModelPlan.tools` is a first-class resolver output, and the Bedrock-native base already delivers the
tool layer independent of any provider swap.

## Tool registry

`ModelPlan.tools: ToolKey[]` references a **tool-descriptor registry** (an extension of the
assistant's tool config in `lib/async-processor-core.ts`). The registry carries local-knowledge
tools: `amap` / `dianping` (CN), `google_places` / `yelp` (US). Each descriptor defines its
provider-call + its Converse/function-calling tool spec (so the adapter can present it in the
right format). The resolver picks *which* tools; the registry defines *what* they are.

## The routing generalization and the provider-adapter seam

The architecture has two layers: a Bedrock-native base and a gated non-Bedrock extension. They
share `RoutingContext` and `resolveModelPlan`, so the extension adds no new call sites.

**Routing generalization (Bedrock-native).** `RoutingContext` + `resolveModelPlan` +
`BedrockAdapter` generalize model resolution while leaving Bedrock behavior unchanged for empty
context. A `segment.country === 'CN'` rule selects the best-for-Chinese Bedrock model + CN tools +
the bilingual pivot, and each location marker's `country` is reverse-geocoded at save time (the
prerequisite for the segment signal). This layer captures most of the local-answer accuracy win,
because local-fact accuracy comes from the provider-independent tool/RAG layer, not the base model.
In behavior: a CN-segment turn routes to the configured CN-capable Bedrock model + CN tools and
replies in zh; a US-segment turn is unchanged; an empty-context turn is identical to
intent+tier+experiment routing (the backward-compat invariant); and the routing decision is emitted
to analytics.

**Provider-adapter seam (non-Bedrock, gated).** The `ProviderAdapter` interface admits a
CN-native model (DeepSeek/Qwen) behind two conditions: Bedrock's Chinese options proving
insufficient OR physically-in-China reach becoming a requirement, AND the data-export/guardrail
gates (see Invariants) being satisfied. A `provider:'deepseek'|'qwen'` plan invokes through its
adapter with resilience, a translated tool loop, and a compensating guardrail; external spend is
tracked per turn; and a kill-switch flag reverts to Bedrock.

The seam is a distinct layer rather than folded into the base, for four reasons:
- **Accuracy.** A CN-native model wins on Chinese fluency + parametric China knowledge, but
  local-fact accuracy (hours, prices, "best X near Y") is the tool layer, which the Bedrock-native
  base already provides. The seam adds the fluency/reasoning edge on top of that.
- **Cost.** DeepSeek is markedly cheaper than Sonnet-4-class (Qwen sits in the middle), so a
  non-Bedrock plan can lower per-turn cost on CN traffic. That spend is outside AWS, however, and
  must be tracked explicitly (see §Observability).
- **Latency.** The backend is `us-east-1`; DeepSeek/Qwen are China/SG-hosted, so a non-Bedrock call
  adds a trans-Pacific hop and is slower from our infrastructure even though it is faster for a user
  physically in China. In-country reach is a deployment-topology problem, not a model swap, and is
  out of scope here.
- **Bedrock reality.** First-class Chinese options on Bedrock are thin (Nova is multilingual;
  DeepSeek has appeared via Bedrock Marketplace / custom-model import but is not a first-class
  on-demand catalog entry). A serious CN-native path therefore needs the adapter seam rather than a
  catalog entry, which is why the seam exists as its own layer.

## Observability, cost tracking & flagging

- **Feature flag.** Context routing runs dark behind `ENABLE_CONTEXT_ROUTING` (per-deployment). A
  second kill-switch gates non-Bedrock providers specifically, so they can be reverted to Bedrock
  instantly without redeploy. `EXTERNAL_MODEL_CONSENT_DEFAULT` (host config) seeds the per-user
  consent default - `true` in the private phase, `false` once the site opens (see §Consent).
- **Routing telemetry.** Emit the chosen `{ provider, modelKey, segment, tools }` into analytics
  alongside the existing `wasFallback` / `experimentId`, so operators see per-segment routing and
  the read-only admin Model Strategy tab can surface context rules.
- **Cost tracking - external (non-AWS) spend is first-class.** Bedrock spend lands on the AWS
  bill; **DeepSeek/Qwen spend does NOT** - it is invisible to AWS cost tooling, so it MUST be
  tracked in-app or it is unobservable. Extend the existing per-turn cost accounting
  (`estimateStepCostUsd` in `async-processor-core.ts`) so every turn records
  `{ provider, modelKey, inputTokens, outputTokens, costUsd, billedBy: 'aws' | 'external' }`.
  Per-provider rate cards live next to the model catalog. Surface external spend as its own line
  in analytics (and an admin total / optional budget alarm) so going outside AWS is always
  visible and attributable.

## Cost safety & runaway protection

Cost **tracking** (above) is detection; this is **prevention** - stopping a coding bug or abuse
from spiking spend. It matters more here than in a Bedrock-only world: non-AWS providers have **no
AWS quota backstop**, and external tool APIs (Amap/Dianping/Google Places/Yelp) bill per call.

**Wrong layer (intentionally unchanged):** API Gateway throttling rate-limits *inbound* user
requests - it does nothing about a single turn's *outbound* fan-out of model/tool calls. A loop
calling Bedrock/DeepSeek/Amap within one Lambda turn never reaches the gateway. So inbound
throttling stays as-is; protection lives at the outbound call sites (defense in depth):

1. **Bounded loops at every call site (contract).** The in-Lambda tool loop already caps at
   `MAX_TOOL_ITERATIONS`; `bedrock-resilience` caps retries + circuit-breaks. The adapter contract
   REQUIRES every provider **and every external tool** to enforce a max-iterations + retry cap +
   circuit breaker. No call site may loop unbounded - and the cap covers the *success-cost* loop,
   not only the failure loop.
2. **Per-turn budget ceiling.** A hard cap on model+tool calls (and estimated $) per turn; exceeding
   it **aborts the turn gracefully** (user-facing "couldn't finish that" + a logged cost-event)
   rather than running away. Bounds the blast radius of any single runaway turn - the main defense
   against "a coding change loops on the same API."
3. **Spend caps → alarm → kill-switch.** Tie to the cost tracking: when external (or total) spend
   crosses a threshold over a window (per-conversation / per-user / per-deployment), fire a budget
   alarm and (optionally auto-)trip the non-Bedrock kill-switch back to Bedrock. Backstop for a bug
   that escapes per-turn caps (e.g. a cross-turn poll loop).
4. **Tool-result caching / dedupe.** External tool calls are cached by `(tool, args)` for a TTL and
   deduped within a turn, so repeated identical lookups - from a buggy loop OR normal repetition - 
   don't re-bill. (Reverse-geocode already moved to save-time, not per-turn, for the same reason.)
   This is the direct answer to "hitting the same API repeatedly."
5. **Idempotency on writes.** The apply endpoint dedupes a retried/duplicated POST by a client
   request id so a resend never double-mutates or double-bills downstream lookups.

## Consent & governance (per-user opt-in)

Non-AWS providers are gated by **two layers** (see the cross-border Invariant):

1. **Operator/deployment enablement** - the DPA + data-handling posture per provider. Done once
   by the operator; it's what makes a provider *eligible* at all.
2. **Per-user consent** - `externalModelConsent`, a per-user flag whose default is set by
   deployment config `EXTERNAL_MODEL_CONSENT_DEFAULT`. This is the lever for the private→public
   lifecycle:
   - **Private / single-tenant phase (the operator + a known, consenting set of users):** default
     **`true`**. The operator is the data controller for a known, consenting set of users;
     consent is implicit and expressed by the config default - no per-user click. Chinese / other
     non-AWS models are on by default.
   - **Multi-tenant phase (serving other tenants, entering locales that route to non-AWS
     models):** `EXTERNAL_MODEL_CONSENT_DEFAULT` is **`false`**. New users explicitly **opt
     in**, with copy explaining their conversation may be processed by a provider outside AWS / in
     another region (the data-residency / privacy disclosure). Existing users keep their stored
     value - the flip is not retroactive.

**Enforcement** - `externalModelConsent` is a `RoutingContext` signal. If a context rule resolves
a non-AWS provider but consent is `false`, `resolveModelPlan` **falls back to the Bedrock plan**
(graceful: the user still gets an answer, on an in-AWS model). This mirrors the tier-safety
downgrade - a gate, not an error.

**Plumbing - reuses the bilingual Level-1 path verbatim.** The host application stores the flag on the user
(`USERS` table), exposes it via `PUT /me` + a toggle in its settings page (next to
the language setting), and passes it in the assistant-session POST alongside `userLanguage`.
AgentEchelon stamps it into channel metadata, the router forwards it, and the resolver gates on
it. No new transport.

## Admin console & testing impacts

**AE operator console** (`frontend/packages/admin/src/components/admin/*` - Overview / Conversations / Quality /
Models / Experiments / Users):
- **Models / Model Strategy tab** (read-only mirror `frontend/packages/shared/src/config/modelStrategy.ts`): add
  **provider posture** (which catalog entries are external / non-AWS), `workingLanguage`, and the
  new **context rules** (e.g. `segment.country === 'CN'` → plan). Read-only is fine for v1; the
  mirror config gains `provider` / `workingLanguage` / `external` / `costRateCard` fields to match
  the backend catalog.
- **Overview / analytics:** add the **external-spend line** (from §Observability cost tracking) +
  optional budget alarm, and surface routing-decision telemetry (provider / segment / tools).
- **Users tab:** surface each user's `externalModelConsent` (operator view, read-only - the toggle
  itself is host-side).

**The host application:** the user-facing **consent toggle + disclosure copy** lives in
the host's settings page, i18n'd through the locale system (coordinate with the i18n
session, same as the proposal-card keys).

**Testing:**
- **Backend** - `resolveModelPlan` matrix **including consent-gate cases** (`consent=false` + CN
  segment ⇒ Bedrock fallback); per-provider **cost-emission** tests asserting the
  `billedBy:'external'` tag; the backward-compat regression (empty context ⇒ unchanged plan).
- **AE admin console** - unit + Playwright for the new Models / Overview / Users elements
  (provider posture, external-spend line, consent column).
- **Host** - settings-toggle test for `externalModelConsent` round-trip via `PUT /me` (host-side;
  coordinate with the i18n session that owns that page).
- **E2E** - a multi-country test conversation × a consenting vs non-consenting user, asserting different
  routing (CN model+tools vs Bedrock fallback) per segment.

## Deriving `segment` (the new signal)

Source already exists: the conversation's location markers carry `lat/lng`, and they are already
stamped into the conversation context. Options, simplest first:
1. **Explicit** - the host passes an "active segment" when the user is viewing/editing a
   specific location (highest precision, no inference).
2. **Subject classification** - a cheap classifier maps the turn's subject to a location/region
   using the conversation's markers (handles "what about the Beijing part?").
3. **Region-dominant** - fall back to the conversation's primary country.

`country` is **reverse-geocoded at save time** and stored on the location marker (reusing
the host application's geocoding), which is cheaper than per-turn geocoding. Absent any signal ⇒ no
`segment` ⇒ default routing.

## What context crosses the wire

`segment` rides the **existing** path the conversation grounding already uses (host →
`create-conversation` metadata / `invokeAsync` payload → resolver). No new transport. The segment
path adds one derived tag; `signals` is reserved for future variables and ships empty.

## Generalization (other variables, no new call sites)

The same `RoutingContext` + `resolveModelPlan` also routes on:
- `data-sensitivity` (PII → a residency-constrained model + stricter guardrail)
- `needs-realtime` (→ a tool-heavy plan, lower-temperature model)
- `user-expertise` (novice vs expert → verbosity/model tier)
- `cost-ceiling` (budget signal → cheaper model + smaller `maxTokens`)

Each is a new **rule** + (optionally) a new **signal key**, never a new call site.

## Invariants

- **Backward compatible.** Empty `segment`/`signals` ⇒ identical to today's
  intent+tier+experiment routing. Enforced by a regression test.
- **Tier safety preserved.** Every context rule re-checks `allowedTiers`; a rule can never
  escalate a user above their tier.
- **Resilience preserved.** Bedrock keeps `bedrock-resilience`; every non-Bedrock adapter MUST
  define an equivalent - no provider ships without it.
- **Guardrail parity (hard gate).** Bedrock Guardrails do NOT apply to external providers; a
  non-Bedrock provider MUST ship a compensating PII/prompt-injection control before enablement.
- **Cross-border data export gated (hard gate), two layers.** Sending conversation/context/PII to a
  non-US / non-AWS provider requires BOTH: (a) **operator/deployment enablement** - a DPA +
  data-handling posture (no-train, retention) per provider, satisfied once by the operator; and
  (b) **per-user consent** - `externalModelConsent` (see §Consent). A turn reaches a non-AWS
  provider only when both are true; otherwise it falls back to the Bedrock plan.
- **External spend is always tracked.** Any non-AWS provider call records per-turn cost tagged
  `billedBy: 'external'`; going outside AWS is never silent.
- **No unbounded outbound fan-out.** Every model/tool call site is bounded by an iteration cap, a
  circuit breaker, AND a per-turn budget ceiling; exceeding the ceiling aborts the turn gracefully.
  External providers additionally honor a spend cap that trips the kill-switch. (See §Cost safety.)
- **Tools are part of the plan.** The resolver outputs `tools`, so local-knowledge routing is
  explicit and testable, not implicit in a system prompt.

## Testing

- **Backward-compat regression** (required): empty `RoutingContext` ⇒ the resolver
  returns the same model as the current router+processor path, across the tier×intent matrix.
- **Routing-decision matrix:** `resolveModelPlan` is pure → a table-driven unit matrix of
  context → expected plan (incl. tier-safety downgrades and CN/US segment rules).
- **E2E:** a multi-country test conversation (US + CN locations) asserting per-segment model/tool/language.
- **Adapter (non-Bedrock providers):** per-provider tool-loop + resilience + cost-emission tests; no
  provider enabled without them.
- **Cost safety (runaway):** a turn that would exceed the per-turn budget aborts + emits a
  cost-event; a forced tool-loop stops at the iteration cap; a repeated identical tool call hits the
  cache (no second external bill); a duplicated apply POST is idempotent.

## Host vs AgentEchelon split

- **AgentEchelon (reusable):** `RoutingContext`, `resolveModelPlan`, the provider adapter
  interface + Bedrock/DeepSeek/Qwen adapters, the catalog `workingLanguage` attribute (shared with
  the bilingual spec), the tool registry, routing telemetry + external cost tracking.
- **The host application:** supplies the raw signals it owns - the conversation's location markers (already sent), the
  save-time `country` on each marker, an optional explicit "active segment" hint, and the per-user
  `externalModelConsent` (stored on the user, toggled in the host's settings page, passed in the
  session POST). No host change for the dominant-region fallback.

## Related docs

- `docs/guides/developer/MODEL_STRATEGY.md` - the catalog + intent routing this generalises.
- `docs/specs/assistant-context/SPEC-BILINGUAL-CONVERSATIONS.md` - `workingLanguage` + the language pivot that composes
  with this routing.
- The host application supplies the geographic signal (per-marker coordinates + save-time `country`)
  that sources the `segment` signal.
- `backend/lib/config/model-strategy.ts`, `lib/model-resolver.ts`, `lib/bedrock-resilience.ts`,
  `lib/async-processor-core.ts` (`estimateStepCostUsd`, tool loop) - the code seams extended here.
