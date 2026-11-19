/**
 * Stratum DEMO intent packs, per classification.
 *
 * Extracted from seed-demo.ts so their SIZE can be measured without running a seed. The seeder
 * invokes main() at import, so nothing could import these to check them, and the only way to learn
 * that a pack had outgrown its parameter was to run a deploy and watch the seed die part way through -
 * after basic and standard were already written, so the retry reported those as "already set" and died
 * on the same one. `test/demo-seed-budget.test.ts` measures them here instead, before any deploy.
 *
 * Same split as demo/personas.ts: demo CONTENT lives under demo/, the seeder stays the mechanism.
 */
/**
 * Stratum DOMAIN intent pack (per classification). Each pack declares the WHOLE taxonomy that assistant
 * recognizes: Stratum's own everyday questions, plus the platform intents that assistant actually does,
 * copied in by value with `fromPlatform`. The universal greeting/acknowledgment/general are added
 * implicitly by every reader.
 *
 * WHAT AN ASSISTANT OFFERS IS WHAT ITS PACK DECLARES. Basic answers EXTERNAL conversations from public
 * documentation and hands over no files, so it declares no `report_generation`, no `data_extraction`
 * and no `image_generation`. Standard adds reports and exports, scoped to the directory and internal
 * processes. Premium adds `strategic_analysis`, the financial, account and competitive intents, and the
 * account brief, a workflow whose research step requires its lookup before the task moves on.
 *
 * A PLATFORM INTENT A PACK DOES NOT DECLARE IS REFUSED, NOT ANSWERED AS SOMETHING ELSE
 * (DESIGN-CAPABILITY-REFUSAL). The classifier recognizes a report request on basic, from the platform's
 * own description, and the router refuses it and tells the person where they could get one, rather than
 * answering it inline as `general`.
 *
 * KEY DESIGN POINT (ADR-018): intent and DELIVERY are separate axes. These inline intents carry
 * `delivery: 'PLACEHOLDER_UPDATE'` (one grounded reply, answered in the turn), NOT `TASK_MULTI_STEP`.
 * So a single-fact revenue/account/product question is bucketed AND answered inline (no deferral behind
 * a task), as ADR-018 intends, and keeps its own intent rather than collapsing into `general`: the
 * per-intent delivery field is the lever. Genuinely multi-step work stays on the DEFAULT task intents
 * (report_generation / data_extraction, both TASK_MULTI_STEP), which the per-tier packs keep, so task
 * flows, e2e and taskType routing read the same intents on every tier.
 *
 * Scoped per tier to match each tier's data access (basic sees product info; standard the directory /
 * processes; premium financials / accounts / competitive intel), so a tier's classifier only offers the
 * intents that tier can actually satisfy.
 */
import { type StoredIntentPack, type StoredIntentDef, type IntentDef } from '../../backend/lambda/src/lib/intent-pack.js';
import { type TaskStateMachine } from '../../backend/lambda/src/lib/task-state-machines.js';
/**
 * A demo intent is a full `IntentDef`, not a narrowed one.
 *
 * A narrowed shape such as `{ key, description, keywords, delivery: 'PLACEHOLDER_UPDATE' }` would pin the
 * delivery class and could not express `instructions`, `tools`, `maxTokens` or `verbosity` at all, so the
 * demo would show a taxonomy and none of the behavior an intent carries. An operator reading these as the
 * worked example would conclude an intent is a label.
 */
export type InlineIntent = StoredIntentDef;
/**
 * A PLATFORM intent, materialized into this profile's own pack, with optional per-profile overrides.
 *
 * WHY NOT `extends: 'default'`. Inheriting the platform taxonomy gives EVERY classification every
 * platform intent, including the ones it has no business recognizing. A basic assistant answering an
 * external conversation from public documentation would classify "write me a report on account health"
 * as `report_generation` and ATTEMPT it - declining well, if its instructions are good, but the
 * assistant should not recognize the request as something it does at all. An intent an assistant cannot
 * satisfy is not a capability with a caveat; it is a taxonomy entry that invites the question.
 *
 * So each pack below REPLACES the platform set (no `extends`) and lists what that assistant actually
 * does. This also makes the platform intents genuinely editable: they are IN the profile, by value,
 * where an operator can read and change them, rather than inherited from somewhere else.
 *
 * Copied by value from `DEFAULT_INTENT_PACK` rather than restated, so the platform wording stays the
 * source of truth and a profile overrides only what it means to change.
 */
export declare function fromPlatform(key: string, overrides?: Partial<IntentDef>): InlineIntent;
/** Premium's account brief: the intent, and the workflow of the same name it opens. */
export declare const ACCOUNT_BRIEF_INTENT = "account_brief";
/**
 * THE ACCOUNT BRIEF WORKFLOW: research the account, then draft the brief. The research step requires the
 * company-context lookup (`requiresTool`, ADR-064 decision 3), so the task cannot reach drafting on figures
 * the person typed or the model remembered: `advance_task_state` out of `researching` is refused with
 * `required_tool_not_run` until `load_company_context` returned success since the task entered the step. The
 * lookup is the model's to make, because which document and which account it reads are judgment calls a
 * declared `action` cannot bind.
 */
export declare const ACCOUNT_BRIEF_WORKFLOW: TaskStateMachine;
export declare const STRATUM_INLINE_INTENTS: Record<'basic' | 'standard' | 'premium', InlineIntent[]>;
export declare const OPS_INLINE_INTENTS: InlineIntent[];
/**
 * A classification's pack: its Stratum intents, INHERITING the platform task intents rather than
 * copying them (`extends: 'default'`, resolved in `intent-pack.ts:getIntentPack`). The resolved
 * taxonomy is own intents first, then the platform ones. Universal greeting/acknowledgment/general are
 * added implicitly by the classifier.
 *
 * A copy of the platform intents would cost 3183 characters in each of three 4096-character parameters
 * before the deployment said anything of its own, and premium would not fit. What is stored is only what
 * Stratum ADDS, which is also the more honest description of what it is.
 */
export declare function stratumIntentPack(tier: 'basic' | 'standard' | 'premium'): StoredIntentPack;
/**
 * The templates premium offers a report in (`demo/templates/`), stored by `seed-demo`. The quarterly
 * account review is used when the person names no format.
 */
export declare const PREMIUM_REPORT_TEMPLATES: readonly ["quarterly-account-review", "executive-summary"];
/**
 * A PLATFORM WORKFLOW, MATERIALIZED with its delivering states offering a choice of templates. Copied by
 * value from `DEFAULT_TASK_STATE_MACHINES`, as `fromPlatform` copies an intent, so every other state and
 * every prompt stays the platform's: only the template declaration changes, from the platform's single
 * `report` to a choice the requirements step puts to the person (SPEC-DOCUMENT-TEMPLATES FR3a).
 */
export declare function withTemplateChoice(taskType: string, templates: readonly string[], defaultTemplate: string): TaskStateMachine;
/**
 * The `ops` role's pack. Keyed by nothing: there is one ops assistant and it is named by profile, so the
 * seeder passes this under `ops-premium` the same way it passes a classification's pack under that
 * classification's profile name. No `extends`, for the reason every pack here declines it.
 */
export declare function opsIntentPack(): StoredIntentPack;
