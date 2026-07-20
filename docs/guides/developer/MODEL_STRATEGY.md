# Model Strategy

## Purpose

Agent Echelon treats model routing as a capability-first concern, not a tier-only choice.

The goal is to make it easier to:

- align routing with intent
- reduce model drift across stacks
- reason about provider choice, fallback, cost, and latency
- prepare the product for broader model support over time

## Canonical Backend Config

The source of truth lives in:

- `backend/lib/config/model-strategy.ts`

That file defines:

- model catalog entries
- provider ownership
- Bedrock model IDs
- foundation model and inference profile ARNs
- tier access
- strengths, cost class, and latency class
- intent routing with primary and fallback models
- deploy-time tier selection (`basicModelKey`, `standardModelKey`, `premiumModelKey`)

## Current Routing Shape

Examples of the current strategy:

- general Q&A -> Haiku primary, Sonnet fallback
- code generation -> Sonnet primary, OpenAI GPT-OSS 20B fallback
- code review -> OpenAI GPT-OSS 20B primary, Sonnet fallback
- document extraction -> Haiku primary, Sonnet fallback
- report generation -> Amazon Nova primary, Sonnet fallback
- strategic analysis -> Opus primary, Sonnet fallback
- workflow actions -> Sonnet primary, Haiku fallback

Current catalog entries:

- `haiku`
- `sonnet`
- `opus`
- `titan` (displayName `Amazon Nova Pro`, `amazon.nova-pro-v1:0`; the catalog key stays `titan`)
- `gpt_oss_20b`
- `gpt_oss_120b`
- `deepseek_v3` (DeepSeek V3.2 on Bedrock, `workingLanguage` `zh`)

Example deploy command:

```bash
cd backend
cdk deploy --all --context standardModelKey=gpt_oss_20b --context premiumModelKey=gpt_oss_120b
```

## Why This Helps

This improves the system in a few ways:

- bot stack and IAM policy stack can now use the same model metadata
- admin UX can describe routing in a way operators understand
- cost and latency tradeoffs become explicit
- future provider expansion becomes easier
- Bedrock-native OpenAI options can be enabled without rewriting the app

The implementation is Bedrock-native and multi-provider: OpenAI GPT-OSS, Amazon Nova, and DeepSeek fit the same routing model alongside Anthropic.

## Admin Console

The frontend mirrors this strategy in:

- `frontend/packages/shared/src/config/modelStrategy.ts`

That mirrored config powers the `Model Strategy` tab in the admin dashboard. It is currently read-only, but it gives admins a clear view of:

- provider posture
- model strengths
- tier availability
- which model family is deployed per tier
- intent routing
- fallback paths

## Runtime Model Resolution

At runtime, `backend/lambda/src/lib/model-resolver.ts` bridges the intent classifier output to the strategy config:

1. Maps the classified intent key to a fine-grained `RouteKey` via `INTENT_TYPE_TO_ROUTE_KEY`
2. Looks up the `INTENT_ROUTE_STRATEGY` for the matched key
3. Checks that the primary model is in `allowedTiers` for the current user tier
4. If not allowed, falls back to the tier's default model
5. Same logic for the fallback model

This enforces IAM safety at the code level - a basic-tier request will never resolve to a premium-only model even if the strategy says so.

> **The classified-intent set is per-deployment configurable** (`docs/specs/assistant-context/SPEC-CONFIGURABLE-INTENT-PACK.md`).
> The classifier emits the universal three
> (`greeting`/`acknowledgment`/`general`) plus whatever *domain* intents the deployment's
> `ASSISTANT_INTENT_PACK` defines (the `DEFAULT_INTENT_PACK` is the default enterprise set). An
> intent key not present in `INTENT_TYPE_TO_KEY` simply falls to the tier default here (step 4) - so
> a custom deployment's `find_recipe` resolves the tier default model unless `INTENT_TYPE_TO_KEY` /
> `INTENT_ROUTE_STRATEGY` are extended for it. The intent is **rule 3** of `resolveModelPlan`;
> geography (`segment`) and language run ahead of it (`docs/design/SPEC-CONTEXT-AWARE-MODEL-ROUTING.md`).

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
- **Variant assignment**: Deterministic MD5 hash of `channelArn + experimentId` - same conversation always gets the same variant without storing assignments
- **Tier safety**: Experiments can't assign a model not allowed for the user's tier
- **Analytics**: `experimentId` and `variantId` flow through to Aurora for side-by-side comparison via `GET /analytics/experiments`

The admin Experiments tab allows creating, pausing, and completing experiments with configurable intent, models, traffic split, and target tiers.
