/**
 * Docs / comment DRIFT GUARD.
 *
 * Some facts about the platform are stated in prose (docs, ASCII diagrams, code comments) with no
 * compiler or unit test tying them to the authoritative source. Those claims drift: the code changes,
 * the prose does not, and a coherence-focused doc review does not diff every sentence against config.
 * This test makes a small set of load-bearing facts self-defending — it fails if a known-stale
 * assertion reappears anywhere on the shipped surface (README, docs/, source comments, e2e specs).
 *
 * SCOPE: it guards against a curated list of assertions we have already corrected and know to be
 * wrong. It is NOT a general fact-checker. When you correct a recurring stale claim, add its phrasing
 * here so it cannot silently come back.
 *
 * The authoritative source for every fact below is `backend/lib/config/profiles.ts`
 * (`DEFAULT_PROFILES_CONFIG`) and `backend/lambda/src/lib/intent-pack.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { excludeIgnored } from './helpers/shipped-files';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Roots to scan. Deliberately EXCLUDES backend/test (this file plus unit-test fixtures legitimately
// contain literal values like `taskSupport: 'lightweight'` for synthetic profiles) and any build
// output (*.d.ts / *.js / node_modules / cdk.out).
const SCAN_ROOTS = [
  'README.md',
  'docs',
  'backend/lambda/src',
  'backend/lib',
  'tests/e2e',
];

const SCAN_EXTENSIONS = new Set(['.md', '.ts']);

/**
 * Each entry is a stale assertion (matched case-insensitively as a substring) plus the correct fact.
 * Keep the phrase specific enough that ONLY the wrong assertion matches — the accurate replacements
 * we now ship (and legitimate historical "legacy basic was 'keyword'" / "deliberately NOT
 * keyword-classified" notes) must not trip it.
 */
const BANNED: Array<{ phrase: string; truth: string }> = [
  // --- Class -1: a Lex-materialised message DOES pass through the channel flow. ---
  //
  // This one earned its guard the hard way. The claim was asserted in FOUR places - ADR-022,
  // MESSAGE-FLOW, TROUBLESHOOTING and a code comment - and when it was disproved live, only the code
  // comment was corrected. The docs went on saying the opposite for a week, and a later reader
  // designing around "the normal path is out of the flow's reach" was designing around a constraint
  // that does not exist. The fact is cheap to state and expensive to get wrong, so it is pinned.
  {
    phrase: 'never passes through the flow',
    truth: 'a message Chime materialises from a Lex response runs through the flow like any other; '
      + 'what differs is ORDERING, not reach (MESSAGE-FLOW §5.1)',
  },
  // NOT the bare phrase "bypasses the flow entirely": that is TRUE of a message created before the
  // flow is associated to the channel (`channel-creation.ts`), and banning it outright fails on a
  // correct statement. The guard's own rule - match only the wrong assertion - applies to the guard.
  {
    phrase: 'from a Lex return "bypasses the flow entirely"',
    truth: 'the flow runs on Lex-materialised messages, including targeted ones (MESSAGE-FLOW §5.1)',
  },
  // The duplicate fulfillment REPLAYS the placeholder; it does not go silent. Returning nothing
  // suppressed the only message that reached the channel, because Chime materialises one message per
  // turn from the LAST fulfillment response - so the dedup silenced the winner.
  {
    phrase: 'returns a Lex response with an empty `messages` array, so no placeholder text is produced',
    truth: 'the retry replays the SAME placeholder and marker, doing no work (MESSAGE-FLOW §5.1)',
  },

  // --- Class 0: there are TWO Lex bypasses, and the flow does not run the turn. ---
  {
    phrase: 'only processor-side routing bypass',
    truth: '`@all` and `/battle` are both Lex bypasses (MESSAGE-FLOW §3, §3.1)',
  },
  {
    phrase: 'the only processor-side bypass',
    truth: '`@all` and `/battle` are both Lex bypasses (MESSAGE-FLOW §3, §3.1)',
  },
  // `@all` HANDS THE TURN TO THE HANDLER; it no longer invokes the processor itself, classifies, or
  // picks a delivery option. The old description reads as accurate because the turn still answers,
  // which is exactly why it needs a guard rather than a review.
  {
    phrase: 'the flow dispatches the async processor, which posts one reply',
    truth: '`@all` invokes the classification handler, which classifies and dispatches (MESSAGE-FLOW §3.1)',
  },
  {
    phrase: "@all does not classify",
    truth: '`@all` is classified by the handler, honouring the profile\'s classifierMode (MESSAGE-FLOW §3.1)',
  },
  {
    // Anchored to `@all`. The bare "no classification at all" over-matched: "summary_embeddings has
    // no classification at all" is a true statement about a TABLE lacking a column (ADR-028), not a
    // claim about how an `@all` turn is routed. Since the classification rename that wording turns up
    // legitimately, and the `@all does not classify` entry above already covers the real assertion.
    phrase: '`@all` receives no classification',
    truth: '`@all` is classified by the handler like any other turn (MESSAGE-FLOW §3.1)',
  },
  // --- Class 0b: WHO POSTS the placeholder on a bypass. ADR-025 moved the send from the channel flow
  //     to the turn itself on 2026-08-10, and MESSAGE-FLOW went on describing the old shape in three
  //     places for three days while ANOTHER section of the same file described the new one. The failure
  //     mode is the one a phrase guard exists for: both readings answer the user, so nothing errors and
  //     no review notices. The flow still posts in two legitimate cases - its own rejection notices, and
  //     the hand-back fallback when a turn could not send - so only the assertions that name a BYPASS
  //     placeholder as the flow's are banned. ---
  {
    phrase: 'posts the placeholder the handler returns',
    truth: 'the handler posts its own acknowledgment as the assistant and returns an empty messages array; the flow posts only on hand-back (ADR-025; MESSAGE-FLOW §5.1)',
  },
  // SHORT phrases deliberately. The stale sentences these replace were WRAPPED across two lines
  // ("...and posts the placeholder it gets" / "back."), and this guard matches per line, so a phrase
  // long enough to be split is a guard that cannot fire. The fallback case is written as the flow
  // posting "on the turn's behalf" or "a fresh placeholder", neither of which collides with these.
  {
    phrase: 'the flow posts the placeholder',
    truth: 'the handler posts as the assistant; the flow posts only when the turn hands the message back (ADR-025; MESSAGE-FLOW §3.1, §5.1)',
  },
  {
    phrase: 'placeholder posted by the flow',
    truth: 'on `@all` and `/battle` round 1 the TURN posts, as the assistant (ADR-025; MESSAGE-FLOW §5.1)',
  },
  // NOT banned here, deliberately: "the duplicate-placeholder guard covers every path", the wrong
  // inference ADR-022 §4 now corrects. No document has ever phrased it that way, so a phrase entry
  // would be unfalsifiable - it could never be shown to fire, and an entry that cannot fire reads as
  // protection that is not there. That limit is carried by ADR-022 §4 and MESSAGE-FLOW §5.1
  // "Known limits" instead, and becomes a phrase here the first time someone writes it down wrong.

  // --- Class 0c: the battle prompt adds AWARENESS ONLY (ADR-029, owner 2026-08-13). `29adb2d` deleted
  //     `BATTLE_CONSTRAINTS_ROUND1` and with it FIVE prompt behaviours - one-clarifying-question
  //     permission, a ~150-word focus clause, a long-form deliverable clause, an outline-first clause,
  //     and a no-deflection guard. That deletion COMPLETED the handoff: each was a duel-only copy of
  //     something the ordinary path resolves per intent (`verbosity` / `maxTokens` from the intent
  //     pack, `isDocumentRequest`, and the intent's own task machine, which is why report_generation
  //     asks several questions rather than one). DESIGN-BATTLE went on describing all of it as current
  //     for three weeks, and TROUBLESHOOTING still names `prepareBattleInvocation`, which no longer
  //     exists outside build output. Prose that re-asserts a battle-side prompt rule is prose that
  //     invites re-implementing the divergence the handoff removed. ---
  {
    phrase: 'permit exactly one',
    truth: 'the battle prompt adds awareness only; how many questions a side asks is its INTENT\'s task flow, not a battle rule (DESIGN-BATTLE "Per-bot generation"; ADR-029)',
  },
  {
    phrase: 'emits a ~150-word focus clause',
    truth: 'response length comes from the intent pack (`verbosity`/`maxTokens` -> responseSettings), not from a battle-side clause (intent-pack.ts; ADR-029)',
  },
  {
    // The backtick is part of the phrase on purpose: the committed text is "`prepareBattleInvocation`
    // takes", so a spaced form matches nothing and the entry would be a guard that cannot fire. The
    // BARE name is deliberately not banned - TROUBLESHOOTING names it three times in an incident
    // write-up about a fix that happened, which is history rather than a stale claim about now.
    phrase: 'prepareBattleInvocation` takes',
    truth: 'prepareBattleInvocation no longer exists; a duel side runs the ordinary turn path (removed in 29adb2d)',
  },

  // --- Class A: basic is NOT keyword-classified. All default profiles use the LLM classifier;
  //     `classifierMode: 'keyword'` is an opt-in per-profile mode, not a tier behavior. ---
  { phrase: 'classifyintentbasic', truth: "renamed to classifyIntentByKeyword (the keyword classifier is not tied to the basic tier)" },
  { phrase: 'basic tier is keyword', truth: "basic uses classifierMode: 'llm' (profiles.ts)" },
  { phrase: 'basic is keyword-only', truth: "basic uses classifierMode: 'llm' (profiles.ts)" },
  { phrase: 'keyword-only for basic', truth: "basic uses classifierMode: 'llm' (profiles.ts)" },
  { phrase: 'keyword (basic)', truth: "basic uses the LLM classifier (profiles.ts)" },
  { phrase: 'basic tier skips it', truth: "basic runs the LLM classifier like every default profile (profiles.ts)" },

  // --- Class B: basic has FULL task support (taskSupport: 'full' for every profile). What basic
  //     lacks is the RICH processor output (richProcessor: false) — generated docs / battle / image
  //     gen — NOT task tracking. "lightweight" / "status-only" task support is the stale framing. ---
  { phrase: 'lightweight task support', truth: "basic has taskSupport: 'full' (profiles.ts); it lacks the rich processor output, not task tracking" },
  { phrase: 'basic is lightweight', truth: "basic has taskSupport: 'full' (profiles.ts)" },
  { phrase: 'basic gets lightweight', truth: "basic has taskSupport: 'full' (profiles.ts)" },
  { phrase: 'lightweight tasks (grounds', truth: "basic runs the full task loop (taskSupport: 'full'); richProcessor:false gates generated-doc output, not task tracking" },

  // --- Class C: Layer 5 guardrails are CONTENT SAFETY (content filters + PII + word list), NOT per-tier
  //     TOPIC denial. buildGuardrailPolicy has no topicPolicyConfig; no denied-topics policy is populated
  //     by default. Cross-tier context isolation is Layers 1 (channel-tag IAM) + 4 (S3 prefix), not Layer
  //     5. The guardrail catalog (4.6) is the tuning surface a deployer uses to ADD topic denial. ---
  { phrase: 'deny topic categories', truth: "the guardrail is content/PII/word filtering; no denied-topics policy ships by default. Cross-tier isolation is Layers 1+4 (SPEC-CONVERSATION-SECURITY §8)" },
  { phrase: 'block topic categories', truth: "the guardrail is content/PII/word filtering; no denied-topics policy ships by default (SPEC-CONVERSATION-SECURITY §8)" },
  { phrase: 'denies "financial data"', truth: "no guardrail denies a financial-data topic; Layer 4 S3-prefix IAM is the block, Layer 5 is content safety + agent tier-drift instructions (SPEC-CONVERSATION-SECURITY §8/§11)" },

  // --- Class D: the turn correlation id (ADR-022). The Lex `sessionId` was an input in the first
  //     draft and was REMOVED: it is per channel and per user, both already hashed, so it separates
  //     nothing, while depending on Amazon Chime SDK replaying the same session on a retry - which is
  //     undocumented and was never measured. Prose that still lists it describes a derivation that
  //     would silently disable the control if the session ever varied. ---
  { phrase: 'sender, lex `sessionid`', truth: "turnCorrelationId hashes channel, sender, transcript and a 90s bucket; sessionId is deliberately NOT an input (lib/correlation.ts)" },
  { phrase: 'lex sessionid, transcript', truth: "turnCorrelationId hashes channel, sender, transcript and a 90s bucket; sessionId is deliberately NOT an input (lib/correlation.ts)" },

  // --- Class E: placeholder identification in the conversation history. Placeholders are matched on
  //     the `<!--corr:` marker every one of them carries. Matching the COPY instead deletes real
  //     assistant turns from context, because every placeholder ends in an ellipsis and so does
  //     ordinary prose (async-processor-core.ts isPlaceholderMessage). ---
  //     The phrases are prose ASSERTIONS only. A literal match on the removed expression is
  //     deliberately NOT banned: the code comment and TROUBLESHOOTING §20 both quote it to explain
  //     why it changed, which is the opposite of a stale claim.
  { phrase: 'placeholders are skipped by their text', truth: "loadChannelHistory identifies placeholders by the `<!--corr:` marker, never by wording or punctuation (async-processor-core.ts)" },
  { phrase: 'placeholders are detected by their wording', truth: "loadChannelHistory identifies placeholders by the `<!--corr:` marker (async-processor-core.ts)" },
  { phrase: 'history is consolidated before the current turn', truth: "runSharedPipeline consolidates the history AND the current turn as one array, or the roles stop alternating (async-processor-core.ts)" },

  // --- Class F: the active-experiment cap counts by STATUS only. `countActiveExperimentsExcluding`
  //     scans `status = 'active'` and projects `experimentId`; it never reads `startDate`, so a
  //     future-dated experiment consumes cap from the moment it is saved. It does not resolve
  //     traffic before its start date (isLiveForClassification), which is a separate property. ---
  { phrase: 'excluded from the active-experiment count', truth: "countActiveExperimentsExcluding filters on status='active' only; a future-dated experiment still counts toward MAX_ACTIVE_EXPERIMENTS (admin-experiments.ts)" },

  // --- Class G: a duel is metered ONCE, by the flow. The handler skips its abuse gate on any
  //     battleContext (router-agent-handler.ts), because a rejection landing between the sides leaves
  //     one answer with nothing to compare it against — measurement bias, not a UX wrinkle. Four doc
  //     locations asserted the opposite (per-side charging) while the code did this, and MESSAGE-FLOW
  //     stated it inside a table column headed "what each difference costs", so the wrong value was
  //     the one a deployer would budget from. Fidelity was traded deliberately (owner, 2026-08-09).
  { phrase: 'two rate/spend charges', truth: 'the flow gates a duel once and the handler skips its gate on any battleContext, so a 2-bot duel consumes ONE charge (router-agent-handler.ts; DESIGN-BATTLE "How a duel is metered")' },
  { phrase: 'n rate-limit and spend charges', truth: 'a duel is metered once for the whole duel, not once per side (MESSAGE-FLOW §3.3; DESIGN-BATTLE §5a)' },
  { phrase: 'per-side gate charging: yes', truth: 'per-side gate charging is NO; the duel is gated once, upstream (DESIGN-BATTLE §5a decision 2)' },
  { phrase: 'a battle costs each side the same as an ordinary turn', truth: 'a battle costs ONE charge for the duel, not one per side (MESSAGE-FLOW §3.3)' },

  // --- Class H: the round-1 fan-out and the clarification continuation BOTH dispatch through the
  //     handler entry; only the round-2 orchestrator still runs its own turn logic (ADR-023 A-prime).
  //     The build-state prose survived the handoff that invalidated it, which is the failure mode a
  //     phrase guard catches and a review does not: the duel still answers either way. ---
  { phrase: 'the entry exists; nothing calls it', truth: 'round 1 (channel-flow-processor.ts) and the clarification continuation both dispatch through the handler entry; only round 2 does not (DESIGN-BATTLE §5a)' },
  { phrase: 'have not been switched over, so behaviour is unchanged on both', truth: 'round 1 and the continuation are switched over; round 2 is the remaining caller (DESIGN-BATTLE §5a, ADR-023 A-prime)' },
  // The COUNT, phrased as prose. MESSAGE-FLOW §3.1 said "two paths still run turn logic outside the
  // handler" and named the continuation as one of them, three days after the continuation started
  // dispatching through the handler entry (`handleBattleContinuation` invokes the resume router). The
  // Class H phrases above did not catch it because this sentence says the same wrong thing in different
  // words - which is the argument for banning the COUNT, not just the phrasing.
  { phrase: 'two paths still run turn logic outside the handler', truth: 'ONE path does: round 2 (battle-orchestrator.ts). `@all`, `/battle` round 1 and the battle continuation all dispatch through the handler entry (MESSAGE-FLOW §3.1)' },

  // --- Class I: a task-shaped duel finishes its work with the user BEFORE the next round (ADR-026,
  //     owner 2026-08-10). Three claims were reversed and each reads as reasonable in isolation, which
  //     is why they need phrases rather than a review: a rebuttal still gets written either way.
  //     `WAITING_FOR_USER` is non-terminal, so it suspends round 2 with no new predicate - the
  //     `isBattleRound1Complete` separation is intact and its guard test still passes. ---
  { phrase: 'fire while a side\'s task chain is still running', truth: 'a task-shaped side enters WAITING_FOR_USER between legs and reaches COMPLETED at a terminal task state, so round 2 waits (ADR-026; DESIGN-BATTLE §2a)' },
  { phrase: 'round-1 completion is intent-aware', truth: 'completion is a BATTLE state, not an intent-keyed table: terminal ⇒ COMPLETED, waiting on the user ⇒ WAITING_FOR_USER (ADR-026; ADR-024 removed the intent table)' },
  { phrase: 'a duel never continues an existing task', truth: 'a duel side CONTINUES the chain it owns; getActiveTaskForOwner is owner-scoped so it can never absorb the human\'s or the rival\'s task (ADR-026; ADR-024 D2)' },

  // --- Class J: where a profile version's PERSONA lives. The spec described the S3 indirection for a
  //     year before it existed, and the claim survived several spec-vs-code reviews because it reads as
  //     an implementation detail rather than a promise: nothing misbehaves until a persona lands in the
  //     4096-to-20000-character gap, and then the failure is an opaque AWS ValidationException. Two
  //     directions are banned - claiming the persona still rides inside the parameter (stale in the
  //     other direction now), and claiming the intent pack is on the S3 path (it is not; it still
  //     stores its pack inline in its own per-deployment parameter, which is the open work). ---
  { phrase: 'the persona rides inline in the definition', truth: 'a written definition stores `personaRef` and the body lives at profiles/{name}/{configId}/persona (lib/profile-bodies.ts; SPEC-PORTABLE-PROFILES "Where it lives")' },
  { phrase: 'persona is stored inside the ssm parameter', truth: 'the persona is offloaded to S3 and the parameter holds a pointer (lib/profile-lifecycle.ts:putDefinition)' },
  { phrase: 'persona, intent pack, and any referenced doc-set manifest stay in s3', truth: 'only the PERSONA is on the S3 body path; the intent pack still stores its pack inline in assistant/{classification}/assistant-intent-pack (lib/intent-pack.ts)' },
  { phrase: 'the intent pack is stored in s3', truth: 'the intent pack still resolves per deployment from its own SSM parameter, inline (lib/intent-pack.ts)' },
  { phrase: 'a manifest carries s3 pointers', truth: 'export INLINES bodies; a pointer would name the source instance\'s storage and break portability (profile-manifest.ts)' },

  // --- Class: SYMBOL names the tier->classification migration renamed, still written in docs. ---
  //
  // The `classification-naming-ratchet` guards the BACKEND for this vocabulary and nothing guarded the
  // docs, so six renamed symbols went on being cited across eight documents - 23 occurrences. A reader
  // sent to `tierChannelScopedAllow` finds no such export.
  //
  // `SPEC-PER-PROFILE-OWNERSHIP` made it worse than a stale name by carrying an explicit carve-out:
  // "a few internal helper symbols ... still read `tier` for continuity (`modelArnsForTier`,
  // `tierChannelScopedAllow`, the `context/{tier}/` S3 prefix)". Every one of those had already been
  // renamed, and the prefix is `context/{classification}/`. **A documented exception outlived the thing
  // it excepted**, which reads as deliberate design rather than drift and is the reason nobody looked.
  { phrase: 'tierchannelscopedallow', truth: 'the export is `classificationChannelScopedAllow` (agent-classification-common.ts)' },
  { phrase: 'modelarnsfortier', truth: 'the export is `modelArnsForClassification` (agent-classification-common.ts)' },
  { phrase: 'maketierrole', truth: 'the helper is `makeClassificationRole` (cognito-auth-stack.ts)' },
  { phrase: 'tier_gated_channel_actions', truth: 'the constant is `CLASSIFICATION_GATED_CHANNEL_ACTIONS` (agent-classification-common.ts)' },
  { phrase: 'allowedtiers', truth: 'the model-catalog field is `allowedClassifications` (model-strategy.ts)' },
  { phrase: 'tiermodelselection', truth: 'the type and prop are `ProfileModelSelection` / `profileModelSelection` (assistant-profile-stack.ts)' },
  { phrase: 'context/{tier}/', truth: 'the S3 context prefix is `context/{classification}/` (profile-registry.contextPrefixesAtOrBelow)' },

  // --- Class: a SECURITY DEFAULT stated backwards. ---
  //
  // ADMIN-INTEGRATION-GUIDE said admin IAM enforcement was "Off by default". It is ON by default in
  // all three stacks that read the flag (`admin-plane-stack.ts`, `analytics-stack-aurora.ts`,
  // `experiments-stack.ts` each treat any value other than false/'false' as on), and the code comment
  // beside it says so: "It was never meant to be a toggle you must remember to set."
  //
  // Stated backwards, the sentence tells a deployer their admin API is on the weaker Cognito
  // group-gated authorizer until they act, when the stronger per-capability IAM authorizer is what
  // they already have. That is the direction of error that gets acted on: someone "enables" what is
  // on, or worse, reads the wrong posture into an audit.
  // The phrase is the ENABLEMENT FORM, not the words "off by default" - those are legitimate elsewhere
  // in the same guides (`enableRdsProxy` really is opt-in). Writing `-c adminIamEnforcement=true` is
  // what encodes the false belief, because a flag you must pass to get is a flag that is off.
  { phrase: '-c adminiamenforcement=true', truth: 'the flag is ON by default (any value but false/\'false\' enables it, in admin-plane-stack.ts, analytics-stack-aurora.ts and experiments-stack.ts). Only the opt-OUT `-c adminIamEnforcement=false` needs passing; describe the enabled state as "when admin IAM enforcement is on"' },

  // --- Class: KEYWORD CLASSIFICATION described as the default or as a stage on the default path. ---
  //
  // `classifierMode` is `'llm' | 'keyword'` and every profile this repo ships sets `'llm'`, basic
  // included and deliberately (`lib/config/profiles.ts:83`). The two modes are ALTERNATIVES chosen per
  // profile, not a chain: `router-agent-handler.ts:1693` branches to `classifyIntent` OR
  // `classifyIntentByKeyword`. The only short-circuit on the default path is `fastPathIntent`, which
  // fires on an empty/under-3-character message or an EXACT greeting/acknowledgment token - not the
  // five-category substring table.
  //
  // Positioning keyword matching first understates what the platform does per turn: it reads as a
  // cheap substring router with an LLM backstop, when the shipped behaviour is a model call on
  // essentially every real message. That misleads on cost, on latency and on classification quality
  // at once.
  //
  // The phrases are ones only the wrong belief produces. "keyword fallback" alone is NOT banned:
  // decision 006 legitimately says "there is no substring/keyword fallback by design", and a guard
  // that fires on a correct negation gets switched off.
  { phrase: 'fast-path keyword matching', truth: 'the default path is the LLM classifier; the keyword classifier is opt-in per profile via classifierMode' },
  { phrase: 'keywords, else the llm', truth: 'the LLM classifier is the default for every shipped profile; keyword mode is an opt-in alternative, not a second choice after keywords' },
  { phrase: 'with keyword fallback', truth: 'keyword and llm are alternative classifierMode values, not a chain; no shipped profile uses keyword mode' },
  { phrase: 'llm classifier for unmatched messages', truth: 'the LLM classifier handles essentially every message; only exact greeting/acknowledgment tokens short-circuit before it' },

  // --- Class: A RETRACTED MEASUREMENT that already travelled once. ---
  //
  // "1 in 52" was `correlation.ts`'s duplicate-fulfillment rate and it counted the e2e retry suite's
  // own `Retry probe ...` messages as organic duplicates: 13 of the 14 log lines were the measurer's
  // own traffic. The organic rate over four days is roughly 1 turn in 1000.
  //
  // It is banned rather than merely corrected because it had already spread from the code comment
  // into two tracker rows before anyone re-derived it, and the number sets the STAKES: at 1 in 52 you
  // instrument Lex to chase the trigger, at 1 in 1000 the instrumentation costs more than the defect.
  { phrase: '1 in 52', truth: 'the organic duplicate-fulfillment rate is ~1 turn in 1000 over four days; the 1-in-52 figure counted the e2e retry suite\'s own probes (lib/correlation.ts)' },
  { phrase: '1-in-52', truth: 'the organic duplicate-fulfillment rate is ~1 turn in 1000 over four days; the 1-in-52 figure counted the e2e retry suite\'s own probes (lib/correlation.ts)' },

  // --- Class: CONTEXT ROUTING described as unbuilt, and its safety described in the wrong place. ---
  //
  // Two errors in opposite directions in one spec, which is why they share a class.
  //
  // 1. UNDER-claim. SPEC-CONTEXT-AWARE-MODEL-ROUTING called the provider-adapter seam "design" while
  //    `lib/providers/external-llm.ts` was serving DeepSeek and Qwen, and while the PREFERRED Chinese
  //    path - DeepSeek-on-Bedrock, `resolveModelPlan` rule 2a - was not described at all. An
  //    under-claim is not the harmless direction here: provider-openness is the positioning, so a
  //    deployer evaluating it reads "design" and concludes the platform is tied to one provider.
  //
  // 2. A SAFETY CHECK ATTRIBUTED TO THE WRONG LAYER. The Invariants said "every context rule re-checks
  //    `allowedClassifications`". Rules 3 and 4 do, through `model-resolver.ts`; the CN rules return
  //    the deployment's configured model directly and are bounded by IAM instead - the CN ARNs are
  //    granted only to a profile whose topology enables context routing. The claim is the dangerous
  //    kind of wrong: it is true of the OUTCOME and false of the MECHANISM, so a rule added later
  //    inherits the gap while the document promises it cannot exist.
  // --- Class: WHEN AN AURORA MIGRATION ACTUALLY APPLIES. ---
  //
  // AURORA-MODE-GUIDE said the schema-init custom resource runs every migration on each deploy. Only
  // the BASE bootstrap is Create-only custom-resource work; every later `NNN-*.sql` applies at RUNTIME
  // on the next Lambda cold start (`db-client.ts` `applyPendingMigrations`, recorded in `_migrations`,
  // serialized by a pg advisory lock).
  //
  // Stated as a deploy-time step, the sentence sends someone to CloudFormation to explain a column that
  // is not there yet, when the answer is that nothing has cold-started. It also hides the two
  // constraints that follow from running inside one transaction: idempotent AND transaction-safe, so
  // no CREATE INDEX CONCURRENTLY.
  { phrase: 'the custom resource picks up new files', truth: 'a migration after the base bootstrap applies at RUNTIME on the next Lambda cold start (db-client.ts applyPendingMigrations); the custom resource bootstraps the base schema on Create only' },
  { phrase: 'schema init custom resource runs idempotently on each deploy', truth: 'the custom resource bootstraps the base schema on stack Create; later migrations apply at runtime on cold start (db-client.ts applyPendingMigrations)' },
  // The hand-copied migration list drifted for ELEVEN files before anyone noticed, so the guide now
  // points at the directory instead of reproducing it. This bans the range that made the list look
  // authoritative rather than banning migration filenames generally - naming ONE migration to explain
  // what it added is legitimate and common.
  { phrase: 'through `012-moderation-actions`', truth: 'the schema directory is the authority on which migrations exist (23 files as of 023); AURORA-MODE-GUIDE deliberately does not reproduce the list' },

  { phrase: 'provider-adapter seam is design', truth: 'the seam is built: lib/providers/external-llm.ts serves DeepSeek/Qwen behind resolveModelPlan, and DeepSeek-on-Bedrock is the preferred in-AWS CN path (SPEC-CONTEXT-AWARE-MODEL-ROUTING Status)' },
  { phrase: 'every context rule re-checks', truth: 'the CN context rules do NOT re-check the classification allowlist; they are bounded by the per-profile bedrock:InvokeModel grant. Only rules 3/4 check it, via model-resolver.ts (SPEC-CONTEXT-AWARE-MODEL-ROUTING Invariants)' },
];

function walk(abs: string, out: string[]): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return; // a scan root that does not exist in this checkout is skipped, not an error
  }
  if (stat.isFile()) {
    const ext = path.extname(abs);
    if (SCAN_EXTENSIONS.has(ext) && !abs.endsWith('.d.ts')) out.push(abs);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'cdk.out' || entry.name === 'dist') continue;
    walk(path.join(abs, entry.name), out);
  }
}

describe('docs / comment drift guard', () => {
  const collected: string[] = [];
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root), collected);
  // Gitignored files are not the shipped surface. A private working file living under `docs/` would
  // otherwise be scanned, and a forensic note whose job is to QUOTE a stale symbol reads to this
  // guard exactly like the drift it describes.
  const files = excludeIgnored(collected, REPO_ROOT);
  const thisFile = path.resolve(__filename);

  it('scans a non-trivial number of files (guard is actually wired to the tree)', () => {
    // Cheap wiring check: if the scan roots move and nothing is found, the guard would be a silent
    // no-op that always passes. Assert it saw a realistic corpus.
    expect(files.length).toBeGreaterThan(50);
  });

  it('no known-stale assertion appears on the shipped surface', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (path.resolve(file) === thisFile) continue; // the guard names the banned phrases itself
      const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      lines.forEach((line, i) => {
        const lower = line.toLowerCase();
        for (const { phrase, truth } of BANNED) {
          if (lower.includes(phrase)) {
            violations.push(`${rel}:${i + 1}\n    stale: "${line.trim()}"\n    truth: ${truth}`);
          }
        }
      });
    }
    if (violations.length > 0) {
      throw new Error(
        `Stale assertion(s) found. Correct the prose to match the authoritative config, or if a phrase\n` +
          `is now a false positive, tighten its entry in BANNED. Findings:\n\n${violations.join('\n\n')}\n`,
      );
    }
    expect(violations).toEqual([]);
  });
});

/**
 * SPEC-STATUS GATE (PA-3 in docs COE-SPEC-VS-CODE-OVERCLAIM, private). A spec may declare
 * `**Status:** Implemented` only if it names the test(s) that verify its shipped claims, via a
 * `Verified by:` line. For a security/accuracy claim that test must assert real backend state (DB row /
 * IAM allow-deny / audit record / channel Metadata), not a render or a 200 — this gate enforces the
 * PRESENCE of the reference; the reviewer confirms the referenced test asserts backend state.
 *
 * RATCHET: `GRANDFATHERED_IMPLEMENTED` lists specs that were already `Implemented` when this gate landed
 * and do not yet carry a `Verified by:` line. The set may ONLY SHRINK — when you add `Verified by:` to a
 * grandfathered spec, remove it here (the test fails until you do both). A NEW `Implemented` spec, or one
 * removed from the set, must carry `Verified by:` or CI fails. Do NOT add entries: that re-opens the hole
 * this gate exists to close (a capability declared shipped with nothing tying the claim to a test).
 *
 * SIBLING GATE: `e2e-coverage-matrix.test.ts` requires every spec document - Implemented or not - to
 * carry a `**Coverage:**` line naming the END-TO-END specs that prove it, or stating why none exists.
 * This gate asks whether a claim is tied to a test at all; that one asks whether the test is at the only
 * layer that can see a contract with an external system (the EMF `{name, unit}` bug was invisible to
 * every unit test in the repo for months). A grandfathered entry here that now names a real e2e spec in
 * its `**Coverage:**` line is a candidate for shrinking this set.
 */
const IMPLEMENTED_RE = /\*\*Status:\*\*\s*Implemented/i;
const VERIFIED_BY_RE = /verified by:/i;

/**
 * TOTALISING STATUS CLAIMS.
 *
 * THE FAILURE THIS EXISTS FOR. `SPEC-ABUSE-CONTROLS.md` read `**Status:** Implemented (all phases)`
 * while three of its controls - both spend budgets and the SSM circuit breaker - were opt-in and
 * OFF on the deployed environment. Every individual statement in the document was true; the
 * TOTALISER was the lie, and it is the part a reader acts on. "All phases" reads as protection you
 * have, and what was actually deployed was a request-rate ceiling and no spend ceiling at all.
 *
 * The rest of this corpus is disciplined about this - `Partial (X ships; Y is design)`,
 * `Implemented (opt-in deployment mode)`, `Implemented (with a small set of tracked gaps)`. A
 * qualifier that ENUMERATES survives contact with a reader checking it; one that TOTALISES does not,
 * because it makes a claim about everything the document covers at once and nobody re-checks it when
 * a phase is later added or switched off.
 *
 * So: a Status line may not claim completeness in the abstract. Say which parts ship and which are
 * opt-in, and a reader can verify each one. This is scoped to `**Status:**` lines deliberately -
 * "all phases" is ordinary prose elsewhere (DEMO-AND-VALIDATION.md means the validation phases), and
 * a whole-file ban would fire on legitimate text and get suppressed.
 */
const TOTALISING_STATUS = [
  'all phases',
  'every phase',
  'all controls',
  'fully implemented',
  'complete implementation',
  'fully built',
  '100% implemented',
];

const GRANDFATHERED_IMPLEMENTED = new Set<string>([
  'docs/specs/applications/SPEC-DEMO-COMPANY.md',
  'docs/specs/capabilities/SPEC-BATTLE.md',
  'docs/specs/capabilities/DESIGN-BATTLE.md',
  'docs/specs/ops/SPEC-AURORA-VPC-MODE.md',
  'docs/specs/ops/SPEC-COST-SLEEP-MODE.md',
  'docs/specs/interface/chat/SPEC-CHAT-APP.md',
  'docs/specs/interface/chat/DESIGN-CHAT-APP.md',
  'docs/specs/interaction/conversation/SPEC-NOTIFICATION-BRIDGE.md',
  'docs/specs/interaction/conversation/SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md',
  'docs/specs/interaction/conversation/CROSS-CHANNEL-TASKS.md',
  'docs/specs/interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md',
  'docs/specs/interaction/identity-access/core/SPEC-CREDENTIAL-EXCHANGE.md',
  'docs/specs/interaction/identity-access/core/IDENTITY-AND-ACCESS-MODEL.md',
  'docs/specs/interaction/identity-access/core/ACCESS-CONTROL-BY-EXAMPLE.md',
]);

describe('spec-status gate: Implemented requires a Verified-by test reference (PA-3)', () => {
  const docFiles: string[] = [];
  walk(path.join(REPO_ROOT, 'docs'), docFiles);
  const specDocs = docFiles.filter((f) => path.extname(f) === '.md');

  it('scanned a realistic number of spec docs (gate is wired to the tree)', () => {
    expect(specDocs.length).toBeGreaterThan(15);
  });

  it('no Status line claims completeness in the abstract', () => {
    const violations: string[] = [];
    for (const file of specDocs) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!/\*\*Status:\*\*/i.test(line)) return;
        const lower = line.toLowerCase();
        for (const phrase of TOTALISING_STATUS) {
          if (lower.includes(phrase)) {
            violations.push(
              `${rel}:${i + 1}\n    claim: "${line.trim().slice(0, 160)}"\n`
              + `    "${phrase}" asserts completeness without saying what is complete. Enumerate `
              + `instead: which parts ship by default, and which are opt-in and inert until `
              + `configured. A reader can check an enumeration; they cannot check a totaliser.`,
            );
          }
        }
      });
    }
    if (violations.length > 0) {
      throw new Error(
        `Totalising Status claim(s) found:\n\n${violations.join('\n\n')}\n`,
      );
    }
    expect(violations).toEqual([]);
  });

  // Falsification: the detector must be able to say "no". Without this the assertion above passes
  // whether the scan works or the phrase list is silently empty.
  it('the totaliser detector actually fires on a totalising line', () => {
    const sample = '**Status:** Implemented (all phases).';
    const hit = TOTALISING_STATUS.filter((p) => sample.toLowerCase().includes(p));
    expect(hit).toEqual(['all phases']);
    const clean = '**Status:** Implemented (opt-in deployment mode).';
    expect(TOTALISING_STATUS.filter((p) => clean.toLowerCase().includes(p))).toEqual([]);
  });

  it('every Implemented spec cites a verifying test, or is a shrinking grandfather entry', () => {
    const violations: string[] = [];
    const seenGrandfathered = new Set<string>();

    for (const file of specDocs) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      const content = fs.readFileSync(file, 'utf-8');
      if (!IMPLEMENTED_RE.test(content)) continue;

      const grandfathered = GRANDFATHERED_IMPLEMENTED.has(rel);
      if (grandfathered) seenGrandfathered.add(rel);
      const hasVerified = VERIFIED_BY_RE.test(content);

      if (hasVerified && grandfathered) {
        violations.push(
          `${rel}\n    now has a "Verified by:" line — REMOVE it from GRANDFATHERED_IMPLEMENTED ` +
            `(the baseline only shrinks).`,
        );
      } else if (!hasVerified && !grandfathered) {
        violations.push(
          `${rel}\n    is "**Status:** Implemented" but has no "Verified by:" line. Add a "Verified by:" ` +
            `line naming the test(s) that prove its shipped claims. For a security/accuracy claim, that ` +
            `test must assert real backend state, not a render or a 200 (COE PA-1/PA-3).`,
        );
      }
    }

    // Keep the baseline honest: a grandfather entry that is gone or no longer Implemented is stale.
    for (const rel of GRANDFATHERED_IMPLEMENTED) {
      if (!seenGrandfathered.has(rel)) {
        violations.push(
          `${rel}\n    is in GRANDFATHERED_IMPLEMENTED but is not a current "**Status:** Implemented" ` +
            `spec (moved, renamed, or downgraded). Remove the stale entry.`,
        );
      }
    }

    if (violations.length > 0) {
      throw new Error(`Spec-status gate (PA-3) findings:\n\n${violations.join('\n\n')}\n`);
    }
    expect(violations).toEqual([]);
  });
});
