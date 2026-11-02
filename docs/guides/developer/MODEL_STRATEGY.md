# Model Strategy

## Purpose

AgentEchelon treats model routing as a capability-first concern, not a classification-only choice.

The goal is to make it easier to:

- align routing with intent
- reduce model drift across stacks
- reason about provider choice, fallback, cost, and latency
- add models without changing application code

## Three Layers

Which model answers a turn is decided in three layers, each inside the one above it:

| Layer | Who decides | Where | What it holds |
|-------|-------------|-------|---------------|
| The platform allows | The instance | The model catalog: `getModelCatalog` in `backend/lib/config/model-strategy.ts` (Bedrock text models), `EXTERNAL_MODELS` in `backend/lib/config/model-catalog.ts` (adapters outside AWS) and `IMAGE_GEN_MODELS` in `backend/lambda/src/lib/image-gen-models.ts` (image models) | Every model the instance may use, from any provider. The catalog names no classification |
| The classification selects | The deployment | `models: { selected, default }` on each classification in `backend/lib/config/profiles.ts`, or in `profiles` in `deploy.config.json` | The catalog keys this classification may use, and the Bedrock text model its assistant answers on by default |
| The profile uses | An assistant manager | A profile version's `models.default`, `models.classifier` and `models.byIntent` (text routes, and image routes whose primary is an image model), and the legacy `models.image`, read as the `image_generation` route's primary | The models one assistant actually serves, each within its classification's selection |

Each shipped classification declares its own selection: `basic`, `guest`, `customer` and `admin` select Claude Haiku 4.5 alone; `standard` selects Haiku, Sonnet, Amazon Nova Pro, OpenAI GPT-OSS 20B, DeepSeek V3.2 and DeepSeek R1 on Bedrock, with Sonnet as its default, so its Chinese-language turns take the in-AWS path and it holds no external provider key; `premium` selects Haiku, Sonnet, Opus, Amazon Nova Pro, both OpenAI GPT-OSS models, DeepSeek V3.2 and every image model, with Opus as its default.

**Synth refuses a selection that cannot work** (`validateProfilesConfig`): an empty selection, a key the catalog does not list, a key selected twice, a default that is not a Bedrock text model in the selection, a profile whose base model the classification does not select or that is not a Bedrock text model, context routing on a classification that selects neither `deepseek_v3` nor `deepseek_api`, and a selection of `deepseek_api` that no turn reaches. The external adapter serves context routing's external path alone, and the in-AWS path wins wherever `deepseek_v3` is selected, so `deepseek_api` is accepted only on a classification that routes by context and does not select `deepseek_v3`. A profile version that names `deepseek_api` as a model is refused on the write path for the same reason (`validateBody` in `profile-lifecycle.ts`).

**Each classification's stack grants exactly its selection.** `modelArnsForClassification` in `backend/lib/stacks/agent-classification-common.ts` builds the text `bedrock:InvokeModel` resource list from the selection, `imageModelArnsForClassification` in `image-gen-models.ts` builds the image list from it, and the stack creates the external adapter's key secret and its read only where the classification selects that adapter. For image providers hosted outside AWS, the processor reads from the deployment's shared image key secret only the keys of the providers the classification selects (`IMAGE_GEN_KEY_FIELDS`, [IMAGE-GEN-PROVIDERS](../admin/IMAGE-GEN-PROVIDERS.md#storing-provider-keys)). A classification that selects no image model gets no image grant, no image guardrail and no image session-policy edge, and its `produces: image` is false (`ProfileRegistry.produces` reads the same selection). Adding a classification changes no other stack's grants. `backend/test/image-gen-iam-parity.test.ts` synthesizes every classification stack and holds each grant to the selection.

**The platform's utility model is granted beside the selection, for platform utility work only.** `UTILITY_MODEL_ID` (Claude Haiku 4.5, `backend/lib/config/model-strategy.ts`) runs work the platform does on every turn whatever the classification selects, and every grant of it is `utilityModelArns`, `bedrock:InvokeModel` only. The router's role holds it for the intent classifier (`CLASSIFIER_MODEL_ID`). The acting role holds it for the first-turn conversation title (`channel-title.ts`), and the vend adds its `utility` session-policy edge to every session (`grantEdgesFor` in `backend/lambda/src/lib/assistant-grant.ts`). No answer runs on it unless the classification selects it. `backend/test/the-title-runs-on-the-utility-model-whatever-the-selection.test.ts` synthesizes a classification that does not select Claude Haiku and checks both grants.

## Canonical Backend Config

`backend/lib/config/model-strategy.ts` defines, for each Bedrock text model:

- provider ownership
- Bedrock model IDs
- foundation model and inference profile ARNs
- what the model is for (`output: 'text'`)
- strengths, cost class, and latency class

and the platform's intent routes (`INTENT_ROUTE_STRATEGY`) with primary and fallback models. `backend/lib/config/model-catalog.ts` lists the image model keys and the external adapters, and `modelKindOf` names each key's kind (`bedrock`, `external` or `image`). Image models carry `output: 'image'` in the image registry.

## One Rule for Every Model

`backend/lib/config/model-availability.ts` states the rule every model selection follows, text and image alike (`modelFits`):

1. **A classification uses only what it selects.** A model serves a classification exactly when the classification's `models.selected` names it (`ProfileRegistry.selectsModel`). Selecting an image model elsewhere is an edit to that classification's selection.
2. **A model serves only what it is for.** An intent that `needs` an image (`intent-pack.ts`; the platform's `image_generation`) is served only by an image model, and every other intent only by a text model.
3. **An assistant manager selects within that.** A profile version's `models.default`, `models.classifier`, each `models.byIntent` route and the legacy `models.image` are each refused on the write path (validate, activate, the experiment derivation, import) unless the classification selects the model and it fits its use: a text route takes text models, an image route takes image models for both its primary and its fallback, and a route never mixes the two. The refusal reads `'<key>' is not selected by the <classification> classification`. A body stored before the rule is read without the offending selection, with a logged reason (`confineModelsToClassification` in `active-profile.ts`); an import lands without the per-intent routes the target cannot invoke. Experiments refuse a variant `modelKey` or `imageGenModelKey` that breaks it (`VARIANT_MODEL_NOT_ALLOWED`, `VARIANT_IMAGE_MODEL_NOT_ALLOWED`).
4. **No image model an assistant did not choose.** A body that names no image model gets none. A seed preselects only models its classification selects: the premium seed carries `stability_image_core`, and the basic and standard seeds carry no image model and only the routes their classification selects. A legacy body with no routes is given the platform routes its classification selects, written as served on its base model (`platformRoutesServedOn` in `active-profile.ts`), and any selection its classification does not make is dropped by name in the log.
5. **A model hosted outside AWS is the classification's to select.** An image model with `hosting: 'external-http'` (`openai_gpt_image_1`, `fal_flux_pro_1_1`) and the external text adapter (`deepseek_api`) send content out of AWS, and IAM cannot bound the call itself. Whether a classification may is whether it selects that model, which is also exactly where its stack holds the provider's key. A profile version enables nothing: the retired `models.externalProviderAllowed` field is read as absent (`parseDefinition` in `active-profile.ts`) and dropped from every version a write produces (`bodyFrom`), so a version stored with it still serves, edits and rolls back.

At runtime no source can return a model the rule refuses: the response-model resolver checks the classification's selection for every route a served version names, and `resolveTurnImageGenModelId` resolves an image model only for an intent that needs one and only one the classification selects, whether the live version, an experiment arm's version or a duel side's pinned version names it.

No deploy-time context key picks a model. The retired keys (`basicModelKey`, `standardModelKey`, `premiumModelKey`, `guestModelKey`, `customerModelKey`, `cnBedrockChatModel`, `cnBedrockReasoningModel`, `deepseekModel`) fail the synth with a message naming `models.selected`.

## Routing Shape

`INTENT_ROUTE_STRATEGY` ships these routes:

- general Q&A -> Haiku primary, Sonnet fallback
- code generation -> Sonnet primary, OpenAI GPT-OSS 20B fallback
- code review -> OpenAI GPT-OSS 20B primary, Sonnet fallback
- document extraction -> Haiku primary, Sonnet fallback
- report generation -> Amazon Nova primary, Sonnet fallback
- strategic analysis -> Opus primary, Sonnet fallback
- workflow actions -> Sonnet primary, Haiku fallback

Catalog entries:

- `haiku`
- `sonnet`
- `opus`
- `titan` (displayName `Amazon Nova Pro`, `amazon.nova-pro-v1:0`; the catalog key stays `titan`)
- `gpt_oss_20b`
- `gpt_oss_120b`
- `deepseek_v3` (DeepSeek V3.2 on Bedrock, `workingLanguage` `zh`)
- `deepseek_r1` (DeepSeek R1 on Bedrock, the reasoning model context routing uses)
- `deepseek_api` (the external DeepSeek adapter, `EXTERNAL_MODELS` in `model-catalog.ts`)
- the image models: `titan_image`, `nova_canvas`, `stability_image_core`, `stability_image_ultra`, `openai_gpt_image_1`, `fal_flux_pro_1_1`

To change which models a classification uses, edit its `models` (in `deploy.config.json` `profiles` for a custom set, or in `lib/config/profiles.ts` for the shipped catalog) and deploy that classification's stack alone (`<prefix>` is the instance name in PascalCase; `npx cdk list` under the deploy context prints the exact name):

```bash
cd backend && npm run deploy:stack -- <prefix>Assistants-standard --diff-only   # then without --diff-only
```

## Why One Catalog

- every classification selects from the same list, so the console, the grants and the resolver agree on what a key means
- the admin console describes routing from the same data operators deploy
- cost and latency tradeoffs are explicit per entry
- adding a Bedrock model is a catalog entry, not an application change, and no classification uses it until it selects it

Every text catalog entry is a Bedrock model or a named external adapter: OpenAI GPT-OSS, Amazon Nova, and DeepSeek fit the same routing model alongside Anthropic.

## External Provider

Two paths leave AWS, and both are the classification's selection: rule 2b for text, below, and an image model with `hosting: 'external-http'` (One Rule, rule 5). Rule 2b of `resolveModelPlan` (`backend/lambda/src/lib/resolve-model-plan.ts`) routes a Chinese turn (user language `zh` or a `CN` geographic segment) to the external adapter through `backend/lambda/src/lib/providers/external-llm.ts`. It applies only when all of these hold:

- the classification stack has the `contextRouting` topology (only the standard classification's `topology` in `lib/config/profiles.ts` sets it)
- the deployment passes `--context enableContextRouting=true` (`ENABLE_CONTEXT_ROUTING` on the processor)
- the classification does not select DeepSeek on Bedrock (`deepseek_v3`): rule 2a is preferred and stays in AWS, so a classification that selects it never reaches 2b
- the classification selects the external adapter (`deepseek_api`), whose endpoint and model are its catalog entry (`EXTERNAL_MODELS`)

**The deployment decides, per classification.** Selecting `deepseek_api` is a classification's configuration, and the classification's stack is where the adapter's key secret (`DeepseekApiKey`), its read on the acting role and the processor's `DEEPSEEK_*` environment exist; a classification that does not select it has none of them. No end user, admin setting or profile version opens the path, and an experiment variant cannot either. The processor (`externalProviderSelected`) checks the selection and, when it withholds the path, keeps the turn on the in-AWS Bedrock baseline and logs `external provider withheld` once with the reason.

The retired `externalConsentDefault` context key fails the synth with a message naming `models.selected`. The external path is text-only (no tools).

## Admin Console

The frontend mirrors this strategy in:

- `frontend/packages/shared/src/config/modelStrategy.ts`

That mirrored config powers the read-only `Model Strategy` tab in the admin dashboard, which shows:

- provider posture
- model strengths
- which classifications select each model (each classification's own selection, from `GET /classifications`)
- each classification's default model
- intent routing
- fallback paths

## Runtime Model Resolution

At runtime, `backend/lambda/src/lib/model-resolver.ts` bridges the intent classifier output to the strategy config:

1. Looks up the route keyed by the classified intent itself ([ADR-064](../../design/decisions/064-a-turn-takes-its-model-from-the-intent-and-the-step-it-runs.md) decision 1: a route is keyed by the intent it serves, and there is no rename table).
2. With no route of its own, an intent in `ANSWERS_THROUGH_GENERAL` (`general`, `greeting`, `acknowledgment`, `conversation_summary`, `set_preference`, `show_preferences`, `off_topic` and `platform_question`, in `model-resolver.ts`) is answered through the `general` route; any other intent resolves to the classification's default model. A version or experiment naming a retired key (`general_qa`, `workflow_actions`, `document_extraction`) is refused, naming the intent that keys the route now (`retiredRouteKeyError`).
3. Checks that the conversation's classification selects the primary model (`models.selected`). The async processor is deployed per classification, so this is the classification of the conversation it serves, not the sender's clearance.
4. If it does not, falls back to the classification's default model (`models.default`, or the profile's base model where it chose one).
5. Serves the route **as written**. The served model is the saved route: a version that routes a simple intent to a cheaper model than its base model is answered on that model, because an assistant manager chose it. There is no classification floor. A classification minimum, if one is ever wanted, is an explicit admin setting refused on the write path, never a silent swap at resolution: **NOT BUILT**, not planned.
6. Same logic for the fallback model.

IAM is the boundary: the processor's acting role can invoke only the ARNs `modelArnsForClassification` returns for its classification, so Bedrock refuses a model outside that list whatever the resolver picks. The resolver check is defense in depth for rules 3 and 4. The context rules (2a, 2b) do not re-check the selection: rule 2a is wired only where the classification selects DeepSeek on Bedrock, and its ARNs are in the same grant; rule 2b only where it selects the external adapter.

**Greeting and acknowledgment routes.** A standalone `greeting` or `acknowledgment` is answered through a route of its own (`greeting`, `acknowledgment`, `TRIVIAL_ROUTE_KEYS`) when the version has one, and otherwise through `general`. It is a property of the TURN, not of the message: a turn that continues work already in flight is answered through `general`, because the reply owes the task's work whatever the incoming message looks like. The caller states this with `TurnContext.continuesActiveWork` (`RoutingContext.continuesActiveWork` on `resolveModelPlan`), which the async processor derives from facts already on its event - the router's `isTaskContinuation` and the turn's `taskId` - so the rule costs no extra read.

**Routes say what they serve.** A seed, and the backfill of a body with no routes, write each platform route whose model is cheaper than the version's base model as the base model, and give `greeting` and `acknowledgment` routes of their own carrying the `general` route as the platform writes it (`routesAsServedByTheFloor` in `model-resolver.ts`, `platformRoutesServedOn` in `active-profile.ts`). A version with no routes at all is served the platform routes written the same way. Stored versions are not rewritten: a deployment whose versions predate this is torn down and deployed fresh.

**Pack intents.** The classified-intent set is configurable per deployment (`docs/specs/interaction/assistants/SPEC-CONFIGURABLE-INTENT-PACK.md`). The classifier emits the universal three (`greeting`/`acknowledgment`/`general`) plus whatever domain intents the deployment's `ASSISTANT_INTENT_PACK` defines (`DEFAULT_INTENT_PACK` is the default enterprise set). A pack intent such as `find_recipe` passes through step 1 as its own route key and resolves to the classification default (step 2) until `INTENT_ROUTE_STRATEGY` carries an entry for it; no rename is needed. The intent is **rule 3** of `resolveModelPlan`; geography (`segment`) and language run ahead of it (`docs/specs/interaction/assistants/SPEC-CONTEXT-AWARE-MODEL-ROUTING.md`).

## Bedrock Resilience

`backend/lambda/src/lib/bedrock-resilience.ts` wraps every Bedrock invocation with:

- **Retry**: Up to 2 retries with exponential backoff (200ms, 800ms) for `ThrottlingException` and `ServiceQuotaExceededException`
- **Fallback**: If all retries fail, tries the strategy's fallback model (one attempt)
- **Circuit breaker**: After 5 failures within 60s, skips directly to fallback (prevents wasting Lambda time)
- **Fail-fast**: `AccessDeniedException` (IAM config bugs) never retries or falls back

All resilience metadata (`wasFallback`, `fallbackReason`, `retryCount`) is tracked in analytics for monitoring.

## A/B Testing

`backend/lambda/src/lib/experiment-manager.ts` provides a DynamoDB-backed experiment framework:

- **Experiment config**: Stored in DynamoDB (`ExperimentsTable`), cached 60s in-memory
- **Variant assignment**: Deterministic MD5 hash of `channelArn + experimentId`, decided once per conversation. A conversation created while an experiment runs is enrolled in it and its arm is pinned on the conversation's context row at its first turn; a conversation that existed before is never enrolled. The pin is served only while the experiment is active: a pause, an end, a deletion or a passed end date returns the conversation to the live active version from its next turn (`enrollmentHolds`) ([ADR-050](../../design/decisions/050-the-alt-is-an-assistant-and-a-conversation-is-enrolled-once.md))
- **What a variant serves**: every experiment compares two versions of one assistant. The control is the live assistant's active version, pinned by number when the experiment is armed; the treatment is a candidate the type's recipe derives into the alt's history (`intent`: one route's primary; `base_model`: the base model; `classification`: the classifier; `profile`: a referenced version). An enrolled conversation is served its arm's version whole, routes included, under the live identity, and no model is forced beside it ([DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP](../../specs/interaction/quality/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md) §3.5). Only an `intent` or `base_model` experiment armed before versions were pinned still overrides the turn's model with its variant's `modelKey`, until it is paused and resumed
- **Classification safety**: an experiment cannot name a model its classification does not select, or a model unfit for its use (a text model as `imageGenModelKey`); the write path refuses it, and resolution never serves one
- **Analytics**: `experimentId` and `variantId` flow through to Aurora for side-by-side comparison via a SigV4-signed `POST /query` on `AdminApi` with `{"queryType":"experiment_results"}` (the admin console's `queryAnalytics` in `frontend/packages/admin/src/services/analyticsService.ts`; [api-contract](../../reference/api-contract.md)); there is no `/analytics/experiments` GET resource

The admin Experiments tab allows creating, pausing, completing and promoting experiments with a configurable intent, treatment model, traffic split and target classification. Promote copies the measured candidate into the live assistant as a new version (§3.6 of the design).
