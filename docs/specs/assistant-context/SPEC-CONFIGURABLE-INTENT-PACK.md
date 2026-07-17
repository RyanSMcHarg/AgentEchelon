# SPEC: Configurable intent pack (per-deployment intent taxonomy)

**Status:** Implemented (the taxonomy mechanism; the domain taxonomy is per-deployment config)

> Reusable AE capability: the taxonomy *mechanism* is platform; the *domain*
> taxonomy is a deployment's config.
>
> **Code:** `backend/lambda/src/lib/intent-pack.ts` (the pack + loader),
> `backend/lambda/src/lib/intent-classifier.ts` (classifier built from the pack),
> `backend/lambda/src/lib/delivery-options.ts` (delivery mapping from the pack),
> `backend/test/lib/intent-pack.test.ts` (back-compat + override + malformed-fallback).

## Why this exists

AgentEchelon classifies each turn into an **intent** before choosing a delivery option and a model
route (`MODEL_STRATEGY.md`, rule 3 of `resolveModelPlan`). Historically that intent taxonomy was
**baked into the platform** as a fixed enum - `GUIDED_TROUBLESHOOTING`, `DATA_EXTRACTION`,
`REPORT_GENERATION` (+ greeting / acknowledgment / general). Those are enterprise-support intents.

But **AE is generic and the domain belongs to the deployment.** A support assistant cares about
password resets, billing questions, and ticket triage - never "report generation." With a baked-in
enum it classified "reset my password" as the catch-all `GENERAL`, so the intent signal was dead
weight: it never reflected what the user wanted, and it never fed the per-deployment model/telemetry
routing usefully.

The fix mirrors the persona seam (`ASSISTANT_SYSTEM_PROMPT`): make the **domain intent taxonomy a
per-deployment config value**, not code. AE ships a generic default; a deployment supplies its own
pack. Nothing domain-specific is baked into the platform.

## The model

```ts
interface IntentDef {
  key: string;          // stable id — the classified value + INTENT_ROUTE_STRATEGY key (e.g. 'find_recipe')
  description: string;  // one line the LLM classifier sees ("when does this intent apply")
  keywords: string[];   // lowercase substrings for the no-LLM fallback (basic tier / LLM failure)
  delivery: 'DIRECT' | 'PLACEHOLDER_UPDATE' | 'TASK_MULTI_STEP';
  // Per-intent response shaping (P3, optional). Tune answer size per intent via config, no code.
  maxTokens?: number;                          // positive int; clamped to the tier ceiling + reasoning floor
  verbosity?: 'tight' | 'normal' | 'long';     // coarse hint
}
interface IntentPack { intents: IntentDef[]; }   // domain intents only
```

### Per-intent response settings (P3)

A domain intent may carry `maxTokens` (a positive integer) and a coarse `verbosity`
(`'tight' | 'normal' | 'long'`). `coerceIntentDef` keeps a valid pair and **drops invalid values**
(negative/zero `maxTokens`, unknown `verbosity`) rather than silently keeping them. At classification
time `responseSettingsForIntent(intent)` returns the settings; the handler **forwards them in the
dispatch event** (D2); the processor resolves the turn's budget with `clampResponseMaxTokens(requested,
ceiling, reasoning)` - the per-intent value WINS but can never exceed the tier ceiling
(`CONFIG.maxTokens`), and reasoning turns keep a higher floor. Absent settings ⇒ the processor's
default budget (today's behavior, unchanged). E.g. `logistics` → `maxTokens: 700` (tight),
`research` → `maxTokens: 1600` (longer). Pinned by `test/lib/intent-pack.test.ts`
("P3 per-intent response settings").

> **Config attribution (P4).** The raw pack JSON - including these per-intent settings - is hashed
> into the deployment's `configId` (`lib/config-identity.ts`), so changing a pack (or its response
> settings) yields a new fingerprint and quality can be sliced by config. See `SPEC-ASSISTANT-CONFIG.md`.

**Three universal intents - `greeting`, `acknowledgment`, `general` - are domain-independent and
always present.** A pack declares only its *domain* intents; the universal three are added
implicitly and cannot be overridden (an override entry is dropped). Their string values are stable
because consumers compare `classification.intent === IntentType.GREETING`.

### How a pack drives the three decisions

1. **Classification (LLM).** `intentPackCategoryLines()` renders the pack as the category list in the
   Haiku classifier prompt (universal three + domain intents). The model returns a category name;
   it's matched against `knownIntentKeys()` (universal + pack); unknown ⇒ `general`.
2. **Classification (fallback).** Basic tier and LLM-failure paths use `classifyByPackKeywords()` - 
   first domain intent whose keyword appears in the message, else `general`.
3. **Delivery.** `deliveryClassForIntent(key)` maps the classified key → `DIRECT` /
   `PLACEHOLDER_UPDATE` / `TASK_MULTI_STEP` via the pack (universal: greeting/ack ⇒ DIRECT,
   general ⇒ PLACEHOLDER_UPDATE). `selectDeliveryOption` and `planBattleTaskDelivery` read this.

The classified `intent` is also a **`RoutingContext` signal (rule 3, `INTENT_ROUTE_STRATEGY`)**, so a
deployment's own intents can drive model resolution. Unknown-to-the-strategy keys fall to the tier
default in `resolveModelForIntent` (no crash) - a deployment that wants per-intent model routing
extends `INTENT_TYPE_TO_KEY` / `INTENT_ROUTE_STRATEGY`; absent that, all its intents use the tier
default model, which is correct for v1.

The classified key also rides the **existing classified-intent telemetry** (the value logged per turn
alongside `wasFallback` / `experimentId`), so a deployment's analytics show its real domain intents
instead of everything collapsing to `general`. No analytics schema
change is needed - the field was already a free string; only its *values* become domain-meaningful.

### Worked example: corporate-travel booking (intent + tool, on the generic task engine)

A deployment can turn the generic `action_item` task lifecycle (gather → present options →
`awaiting_completion` → `completed`) into a concrete, useful capability **without changing the
platform** - by supplying a domain intent plus enabling a mock tool. This is the canonical example
of the seam: the *platform* stays domain-neutral; the *deployment* adds the flavor.

**1. Intent (in the deployment's pack):**
```json
{ "key": "book_travel",
  "description": "Book or arrange business travel — flights, hotels, a corporate trip.",
  "keywords": ["flight", "hotel", "book travel", "trip", "itinerary"],
  "delivery": "TASK_MULTI_STEP" }
```
`TASK_MULTI_STEP` routes the turn to the generic `action_item` task (the router maps the
`action_item` intent key → the `action_item` task type; `book_travel` reuses that task via the
strategy map). The state machine, prompts, hand-off notice, and cross-channel continuity are all the
generic platform code - nothing travel-specific there.

**2. Tool (a mock "corporate travel API"):** `search_corporate_travel`
(`lambda/src/lib/corporate-travel-tool.ts`) is an **executed** Converse tool (same pattern as
`load_company_context`): the assistant gathers origin/destination/dates, **calls the tool**, and gets
back policy-checked flight + hotel options - each with an in-policy flag, price, and a **booking
deep-link** into the corporate travel portal. The assistant presents them; the traveler completes the
booking in the portal (off-platform), which drives the task to `awaiting_completion` → `completed`.
It is a MOCK (deterministic options, no network call) - swap `searchCorporateTravel` for a real
Concur / TravelPerk / Navan client to make it live.

**3. Enablement (platform-neutral by default):** the tool is **off** unless the deployment sets
`ENABLE_TRAVEL_TOOL=true` (optionally `CORPORATE_TRAVEL_PORTAL_URL` for the deep-link host). Unset
deployments never see the tool and stay generic. Tested in
`test/lib/corporate-travel-tool.test.ts`.

The same recipe generalizes: any deployment vertical (procurement, IT provisioning, expense
approval, …) is *its own intent + its own executed tool* on the unchanged `action_item` engine.

> **Note on geography routing.** The intent pack is the *what the user wants* signal; it does NOT
> drive the China→DeepSeek + reply-language routing. That is the **geography** signal
> (`segment.country`) + the **language** signal (`userLanguage`), rules 1 - 2 in
> `SPEC-CONTEXT-AWARE-MODEL-ROUTING.md`, which run ahead of the intent route. The two are
> orthogonal: a turn about the Beijing leg routes to the CN model because of its
> segment, not its intent.

## Configuration

A JSON array of `IntentDef` (or `{ "intents": [...] }`), supplied via CDK context
`assistantIntentPack` (same injection pattern as `assistantSystemPrompt`).

**Transport - SSM, not a raw env var (this matters).** AWS caps a Lambda's **total** env-var size at
**4 KB**. A realistic pack (~3 KB) plus the AgentHandler's existing table/ARN vars (~1.5 KB) blows
that - and the persona (`ASSISTANT_SYSTEM_PROMPT`, ~1.6 KB) can't share a Lambda with it either. So
the shared `assistant-profile-stack.ts` writes the pack JSON to an **SSM parameter**
(`${SSM_ROOT}/assistant/{profile}/assistant-intent-pack`, e.g. `/agent-echelon/assistant/standard/assistant-intent-pack`)
and passes the AgentHandler only the small param **name** in `ASSISTANT_INTENT_PACK_PARAM` (+ an
`ssm:GetParameter` grant). At cold start the handler calls `hydrateIntentPackFromSsm()` (once, cached)
before classifying. `getIntentPack()` prefers the hydrated value, then the inline
`ASSISTANT_INTENT_PACK` env (still honored for small packs / tests), then `DEFAULT`.

**Profile scope:** provisioned for profiles whose `ProfileTopology` sets `intentPackParam` (basic and
standard by default) - on the AgentHandler (where the classifier runs; the AsyncProcessor consumes the
already-classified `event.intent` and needs no pack). The premium profile does not provision the param
by default (`intentPackParam: false`) and uses `DEFAULT`; flipping the flag in its descriptor
provisions the same SSM-param + grant wiring, with no other change.

**Injecting the context** (the JSON can exceed the Windows ~8 KB command-line limit, so don't inline
it on the command - merge it into `cdk.context.json`, deploy, then revert):
```js
// node — merge into backend/cdk.context.json (minify to stay well under the 4 KB SSM/Std-param cap)
c['assistantIntentPack'] = JSON.stringify(JSON.parse(fs.readFileSync('.../intent-pack.json','utf8')));
```
A small pack *may* still be passed inline (`-c assistantIntentPack='[…]'` / PowerShell
`-c assistantIntentPack=(Get-Content -Raw …)`), but the SSM path is the robust default.

**Trust boundary:** the pack is **operator/deploy-time config, never user input** - so the
`description` / `keywords` strings interpolated into the classifier prompt are not a prompt-injection
surface (the same trust posture the routing/bilingual specs apply to deploy-config vs user-supplied
tags). A compromised deploy config is already game-over; a *user* cannot influence the taxonomy.

**Robustness (a bad env var must never break classification):** absent/empty, invalid JSON, wrong
shape, empty array, or all-entries-invalid ⇒ the loader logs and falls back to `DEFAULT_INTENT_PACK`
(the historical enterprise pack). The pack is memoised per env value; `_resetIntentPackCache()` is a
test seam.

## Backward-compatibility invariant

`DEFAULT_INTENT_PACK` mirrors the default enterprise intents exactly. **A deployment that
does not set `ASSISTANT_INTENT_PACK` uses the default** - same categories, same keyword
fallback, same delivery mapping, same premium task-state-machine keys
(`guided_troubleshooting` / `data_extraction` / `report_generation`).

Pinned by `test/lib/intent-pack.test.ts` (the pack primitives + keyword fallback + delivery map for
DEFAULT) and the existing routing/delivery suites (45 tests) staying green. **Scope of the
regression:** it asserts the pack-level primitives, not the LLM classifier prompt assembly or
`classifyIntentBasic`'s full return (the LLM path needs a Bedrock `Converse` mock) - a classifier
integration test is a recommended follow-up.

## Host (deployment) vs AgentEchelon split

- **AgentEchelon (reusable):** the `IntentPack` shape, the loader + memoisation + fallback, the
  classifier/delivery wiring that reads the pack, the universal-three guarantee, the `DEFAULT` pack.
- **Deployment:** its domain pack JSON (`intent-pack.json`), injected via `-c assistantIntentPack`
  at deploy time. The persona prompt (`persona.txt`) and the pack are the two halves of "what this
  assistant is."

## Testing

- **Back-compat:** no env ⇒ `DEFAULT` pack; default delivery classes + keyword fallback unchanged.
- **Override:** a custom domain pack replaces the domain intents; universal three remain; category lines,
  keyword fallback, and delivery map come from the pack; object form `{ intents: [...] }` accepted;
  a universal-key override is dropped.
- **Malformed ⇒ DEFAULT:** invalid JSON / empty array / wrong shape all fall back.

## Related docs

- `docs/design/SPEC-CONTEXT-AWARE-MODEL-ROUTING.md` - geography/language routing (rules 1 - 2); intent is rule 3.
- `docs/guides/developer/MODEL_STRATEGY.md` - `INTENT_ROUTE_STRATEGY` / `INTENT_TYPE_TO_KEY` the intent key feeds.
- `docs/specs/assistant-context/SPEC-ASSISTANT-CONFIG.md` - the broader "what the assistant *is*" config pillar this is part of.
- `docs/specs/assistant-context/SPEC-BILINGUAL-CONVERSATIONS.md` - the reply-language ("translation") feature, language signal.
