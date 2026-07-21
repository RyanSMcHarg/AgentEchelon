# ADR-014: Model `workingLanguage` as a catalog attribute

> **Status:** Proposed (design input for `docs/specs/interaction/assistant-config/SPEC-BILINGUAL-CONVERSATIONS.md` Level 2 / pivot). No code yet.

## Context

A user who converses in a non-English language gets better, more accurate answers when their turn is handled by a model that actually reasons well in that language - and letting a deployment optimize model-per-locale that way is the user benefit behind this change. To do it, the bilingual pivot (`docs/specs/interaction/assistant-config/SPEC-BILINGUAL-CONVERSATIONS.md` Level 2, "pivot to the model's strong language") needs to know, per model, **which language that model reasons best in**, so it can decide whether to translate a turn into the model's language before inference and back afterwards. Today nothing in the catalog expresses this.

The model catalog is `backend/lib/config/model-strategy.ts`. A model entry (`BackendModelDefinition`, lines 13 - 32) already carries explicit, exhaustive, parity-testable attributes: `strengths`, `costClass`, `latencyClass`, and a **required** `visionCapable: boolean` (deliberately required "so the catalog stays exhaustive and parity-testable"). AgentEchelon is multi-provider (`docs/guides/developer/MODEL_STRATEGY.md` - Claude, Nova, GPT-OSS, and future CN-tuned Bedrock models) and routes per intent/tier, so the language a model is strongest in is a real per-model property, independent of the user's language.

## Decision

Add a **required** `workingLanguage` attribute to `BackendModelDefinition`, following the `visionCapable` precedent (required → the parity test forces every catalog entry to declare it):

```ts
// in BackendModelDefinition
/**
 * The language this model reasons best in, as a short tag ('en' | 'zh' | …).
 * Consumed by the bilingual pivot (SPEC-BILINGUAL-CONVERSATIONS Level 2): when
 * a turn's userLanguage !== the resolved model's workingLanguage, the input is
 * translated into workingLanguage for inference and the output back. Default
 * 'en' for current models - a no-op for English users, so adding the field
 * changes no current behavior.
 */
workingLanguage: string;
```

- Every current catalog entry declares `workingLanguage: 'en'`. This is a pure no-op today: with all models on `en`, the pivot only ever triggers for a non-`en` user *and* a non-`en` model, of which there are none yet - so Level 1 (reply-in-language) behavior is unchanged until a deployment adds a non-`en` model.
- A deployment that adds, say, a Chinese-tuned Bedrock model declares `workingLanguage: 'zh'` on that entry; the pivot then keeps zh users native on that model and pivots en users through it.
- The tag space matches the host's `userLanguage` normalization (`en` | `zh` today) so comparison is a direct string match.

The companion `translation` routing key (a new `RouteKey` + `INTENT_ROUTE_STRATEGY` entry, so the translation call inherits `model-resolver` tier safety + `bedrock-resilience`) is a separate small change tracked in the spec, not this ADR - this ADR is only about the per-model attribute.

## Consequences

- **Catalog stays exhaustive + parity-testable.** Like `visionCapable`, a missing `workingLanguage` is a type error / parity-test failure, not a silent default - the catalog can't drift.
- **No behavior change on adoption.** Defaulting current models to `en` means the field can land before any pivot code, with zero runtime effect, de-risking the rollout.
- **Locale becomes a routing input.** The pivot reads `workingLanguage` via the already-resolved model definition; no new lookup path. This is what lets a deployment optimize model-per-locale in context (the accuracy benefit in the spec's "User benefits").
- **Frontend mirror.** `frontend/packages/shared/src/config/modelStrategy.ts` mirrors the catalog for the admin "Model Strategy" tab; it gains the field too (read-only display), consistent with how the mirror already shows strengths/tiers.

## Alternatives considered

1. **Infer language from `provider`/`bedrockModelId`.** Rejected - brittle and implicit; provider ≠ strong language (a provider can ship models tuned for different languages), and it hides a routing-relevant property the way the catalog deliberately avoids for `visionCapable`/`strengths`.
2. **A set of strong languages with weights** (`workingLanguages: string[]` or a ranked map). Rejected **for now** as premature - current models are single-strong-language for our purposes, and a single tag is a direct match against `userLanguage`. Revisit when a genuinely multilingual model needs it (tracked as open question 3 in the spec); the upgrade is additive.
3. **Deploy-time config, not the catalog** (e.g. a CDK context map of model→language). Rejected - `workingLanguage` is a property *of the model*, like `strengths` and `latencyClass`; it belongs with the model definition so it travels with the entry and stays parity-tested, not in deploy config that can fall out of sync.

## Related

- `docs/specs/interaction/assistant-config/SPEC-BILINGUAL-CONVERSATIONS.md` - Level 2 pivot, the consumer.
- `docs/guides/developer/MODEL_STRATEGY.md` - the catalog + intent-routing layer.
- `backend/lib/config/model-strategy.ts` - `BackendModelDefinition` (the `visionCapable` precedent this follows).
