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
  // The operator scripts, which is where the DEMO COPY lives: `seed-demo.ts` writes the suggested
  // prompts a person reads before they have seen any output. "board-ready" sat there, unscanned,
  // while every doc making the same claim would have been caught - the guard was watching the
  // surfaces we write ABOUT the product and not the one the product speaks WITH.
  'backend/scripts',
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
  // --- The Cognito triggers are the one raw asset; share-conversation is bundled. ---
  {
    phrase: 'several lambdas are deployed with `lambda.code.fromasset`',
    truth: 'Only `lambda/cognito-triggers` is a raw asset; `share-conversation` is a bundled `NodejsFunction` that loads the registry (`lib/classification-admission.ts`).',
  },
  // --- An OIDC provider is verified directly or federated, and its groups are translated; email is SES v2 SendEmail; the banner is not on a timer. ---
  {
    phrase: 'oidc" entries are refused',
    truth: 'A production `oidc` entry is accepted, and a pool is needed only when an entry declares one (SPEC-CREDENTIAL-EXCHANGE §4b, `issuerErrors`, `lib/config/issuers.ts`).',
  },
  {
    phrase: 'every generic oidc provider (okta',
    truth: 'An OIDC provider is verified directly (`oidc`) or federated into the pool (`cognito-federated`), and the deployment chooses (IDENTITY-PROVIDER-GUIDE, "Choosing a kind").',
  },
  {
    phrase: 'only a `cognito-pool` declares `groups`',
    truth: 'A `cognito-pool` declares `groups: true`; `oidc`, `oidc-entra` and `cognito-federated` translate their provider\'s groups (`groups.map`, SPEC-CREDENTIAL-EXCHANGE §4b).',
  },
  // --- An import names its target; the manifest's own name never decides where it lands. ---
  {
    phrase: 'optional `targetprofilename`',
    truth: '`POST /admin/profiles/import` requires `targetProfileName` (`400 TARGET_REQUIRED` without it); the team route lands on the assistant in its path.',
  },
  {
    phrase: '{manifest, targetprofilename?}',
    truth: 'The import body is `{manifest, targetProfileName}`, and the target is required.',
  },
  {
    phrase: 'npm run assistant -- draft standard',
    truth: 'The profile CLI takes an assistant profile name (`npm run assistant -- draft analyst`); a classification name is refused with 400 unknown or missing profileName.',
  },
  {
    phrase: 'backfill-tier-groups',
    truth: 'A person is placed in their clearance group by the seed, the provisioning scripts, post-confirmation or the Users tab; there is no group backfill, and a fresh deployment needs none.',
  },
  {
    phrase: 'backfill-channel-flow',
    truth: 'Every channel is associated with the channel flow when it is created; there is no channel-flow backfill, and a fresh deployment needs none.',
  },
  {
    phrase: 'each mail is sent raw',
    truth: 'Each mail is one SES v2 `SendEmail` request with Simple content, its headers and its reply address (`lib/email-message.ts`).',
  },
  {
    phrase: 'polls it once a minute',
    truth: 'The paused banner reads `GET /deployment/state` on load and when a person returns to the tab (`DeploymentStatusBanner.tsx`), never on a timer.',
  },
  // --- Membership on the creators is conditioned, and a creation never falls back to an assistant. ---
  {
    phrase: 'driftmembershipnottaggatable',
    truth: 'The creators hold membership changes on a channel of their own classification bearing the service admin by its exact ARN (`membershipAsServiceAdminStatements`).',
  },
  {
    phrase: 'falls back to the assistant as bearer',
    truth: 'With no service admin configured, creation is refused (`NoServiceAdminError`, `channel-creation.ts`); no conversation is created as an assistant (step 33).',
  },
  {
    phrase: 'membership writes authorize against the user resource',
    truth: 'Membership changes authorize against the channel and the bearer (`scripts/deny-test-assistant-membership.mjs`); the member is a request parameter IAM never sees.',
  },
  // --- A step's instructions are its declared `prompt`, for every machine. ---
  {
    phrase: 'no hand-written prose for',
    truth: 'Every machine, the shipped ones included, renders the state\'s declared `prompt` (`buildTaskSystemPrompt`, `lib/task-step-prompt.ts`); no task type has step text in code.',
  },
  {
    phrase: 'task types with hand-written prose',
    truth: 'Every machine, the shipped ones included, renders the state\'s declared `prompt` (`buildTaskSystemPrompt`, `lib/task-step-prompt.ts`); no task type has step text in code.',
  },
  // --- One classification tag key. ---
  //
  // The stacks write and condition on `classification` only. The matcher folds case, so the key itself
  // cannot be banned; these are the assertions that described two keys.
  {
    phrase: 'the key case differs',
    truth: 'One key, `classification`, everywhere (SPEC-CONVERSATION-SECURITY); `only-declared-speakers-can-speak.test.ts` refuses a `Classification` tag or condition.',
  },
  {
    phrase: 'the assistant role tag is `classification`',
    truth: 'Classification stack resources are tagged `classification`, the same key as sessions, channels and identities.',
  },
  // --- The per-person MIN-CAP is gone, and four documents still described it as live. ---
  //
  // It capped the serving classification at min(channel, caller clearance), which made "a downgraded
  // answer" a real operating mode: two members of one conversation could be answered at different
  // classifications, which is not a property a conversation can coherently have.
  //
  // It also decided nothing Layer 1 had not. The channel-scoped allow is applied to the Cognito USER
  // roles as well as the assistant roles and is fail-closed, so a message reaching the router is
  // itself proof IAM permitted this person to act on this channel. What the cap added was a failure
  // mode: the clearance lookup answers the fail-closed floor for ANY Cognito fault, so a throttle
  // during a turn in a premium conversation routed it to the basic assistant - an outage presenting
  // as a policy decision.
  //
  // The phrases below are the specific stale ASSERTIONS. The bare word "min-cap" is deliberately not
  // banned: SPEC-CONVERSATION-SECURITY and the metadata codebook now explain its removal by name, and
  // a guard that forbids naming the thing forbids describing why it went.
  {
    phrase: 'the min-cap defense-in-depth',
    truth: 'there is no min-cap; one conversation is served at one classification and Layer 1 decides '
      + 'who may be in it',
  },
  {
    phrase: 'min-cap that serves a lower assistant into a higher room, and layer 1',
    truth: 'Layer 1 making a wrongly-added member inert is the backstop; the min-cap was removed',
  },
  {
    phrase: 'the min-cap that serves a lower assistant into a higher room remains',
    truth: 'the min-cap was removed; a participant who does not reach the channel classification is '
      + 'not admitted rather than served a downgraded answer',
  },
  {
    phrase: 'an attendee below that classification is capped to it in-channel',
    truth: 'an attendee who does not reach the channel classification is not admitted; Layer 1 '
      + 'refuses them the channel rather than capping what they are served',
  },
  {
    phrase: "effectiveclassification` (the min-cap of the channel's classification and the caller's clearance)",
    truth: "effectiveClassification is the channel's classification; the router takes it directly",
  },

  // --- Class -3: "board-ready" grades the answer before anyone has seen it (maintainer, 2026-08-20). ---
  //
  // It sat in the premium demo's SUGGESTED PROMPTS, which is the first thing a person reads and the
  // last place a claim should outrun the product. The assistant writes a structured, grounded report;
  // nothing here establishes that it is fit to put in front of a board, and the delivered document has
  // failed shape checks in this very session. Describe the ask, never grade the answer in advance.
  {
    phrase: 'board-ready',
    truth: 'describe what is asked for ("a report on Q2 ARR performance for the leadership team"); '
      + 'the reader judges whether the output clears their bar',
  },
  // --- Class -2: `place_item.placed` records the APPROVAL, not a host apply (maintainer, 2026-08-19). ---
  //
  // The claim lived in the machine's code comment and was copied into the spec from there, which is
  // how it survived: both readings looked mutually confirming. It describes a system this is not -
  // nothing outside a model turn can move a machine, so on that reading no task could ever reach
  // `placed`. Pinned because the deferred capability it points at (an out-of-band advance) will be
  // designed later, and whoever picks that up must not start from a state that already claims to be
  // the landing.
  // Both phrases are lowercase and fit on ONE line, because the matcher tests
  // `line.toLowerCase().includes(phrase)` per line: a phrase carrying a newline or a capital can
  // never fire, and a guard that cannot fire is the failure this file exists to prevent.
  // "the host apply" alone is deliberately NOT banned - DESIGN-ASSISTANT-MEETINGS uses it correctly
  // for its host apply ENDPOINTS, which is a real thing that design proposes.
  {
    phrase: 'placed` (the host apply',
    truth: '`placed` records the person\'s approval; the host-apply landing is a DEFERRED capability '
      + 'waiting on the out-of-band advance (SPEC-TASK-STATE-TRANSITIONS, "an advance from outside a '
      + 'model turn")',
  },
  {
    phrase: 'until the apply lands',
    truth: 'a confirmation completes the step and the model advances it to `placed`; nothing waits '
      + 'for a host apply, because no return path exists',
  },
  // --- Class -1: a Lex-materialized message DOES pass through the channel flow. ---
  //
  // This one earned its guard the hard way. The claim was asserted in FOUR places - ADR-022,
  // MESSAGE-FLOW, TROUBLESHOOTING and a code comment - and when it was disproved live, only the code
  // comment was corrected. The docs went on saying the opposite for a week, and a later reader
  // designing around "the normal path is out of the flow's reach" was designing around a constraint
  // that does not exist. The fact is cheap to state and expensive to get wrong, so it is pinned.
  {
    phrase: 'never passes through the flow',
    truth: 'a message Chime materialises from a Lex response runs through the flow like any other; '
      + 'what differs is ORDERING, not reach (MESSAGE-FLOW §8)',
  },
  // NOT the bare phrase "bypasses the flow entirely": that is TRUE of a message created before the
  // flow is associated to the channel (`channel-creation.ts`), and banning it outright fails on a
  // correct statement. The guard's own rule - match only the wrong assertion - applies to the guard.
  {
    phrase: 'from a lex return "bypasses the flow entirely"',
    truth: 'the flow runs on Lex-materialised messages, including targeted ones (MESSAGE-FLOW §8)',
  },
  // The duplicate fulfillment REPLAYS the placeholder; it does not go silent. Returning nothing
  // suppressed the only message that reached the channel, because Chime materializes one message per
  // turn from the LAST fulfillment response - so the dedup silenced the winner.
  {
    phrase: 'returns a lex response with an empty `messages` array, so no placeholder text is produced',
    truth: 'the retry replays the SAME placeholder and marker, doing no work (MESSAGE-FLOW §8)',
  },

  // --- Class 0: there are TWO Lex bypasses, and the flow does not run the turn. ---
  {
    phrase: 'only processor-side routing bypass',
    truth: '`@all` and `/battle` are both Lex bypasses (MESSAGE-FLOW §4.8, §4.9)',
  },
  {
    phrase: 'the only processor-side bypass',
    truth: '`@all` and `/battle` are both Lex bypasses (MESSAGE-FLOW §4.8, §4.9)',
  },
  // `@all` HANDS THE TURN TO THE HANDLER; it no longer invokes the processor itself, classifies, or
  // picks a delivery option. The old description reads as accurate because the turn still answers,
  // which is exactly why it needs a guard rather than a review.
  {
    phrase: 'the flow dispatches the async processor, which posts one reply',
    truth: '`@all` invokes the classification handler, which classifies and dispatches (MESSAGE-FLOW §6.1)',
  },
  {
    phrase: "@all does not classify",
    truth: '`@all` is classified by the handler, honouring the profile\'s classifierMode (MESSAGE-FLOW §6.1)',
  },
  {
    // Anchored to `@all`. The bare "no classification at all" over-matched: "summary_embeddings has
    // no classification at all" is a true statement about a TABLE lacking a column (ADR-028), not a
    // claim about how an `@all` turn is routed. Since the classification rename that wording turns up
    // legitimately, and the `@all does not classify` entry above already covers the real assertion.
    phrase: '`@all` receives no classification',
    truth: '`@all` is classified by the handler like any other turn (MESSAGE-FLOW §6.1)',
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
    truth: 'the handler posts its own acknowledgment as the assistant and returns an empty messages array; the flow posts only on hand-back (ADR-025; MESSAGE-FLOW §8)',
  },
  // SHORT phrases deliberately. The stale sentences these replace were WRAPPED across two lines
  // ("...and posts the placeholder it gets" / "back."), and this guard matches per line, so a phrase
  // long enough to be split is a guard that cannot fire. The fallback case is written as the flow
  // posting "on the turn's behalf" or "a fresh placeholder", neither of which collides with these.
  {
    phrase: 'the flow posts the placeholder',
    truth: 'the handler posts as the assistant; the flow posts only when the turn hands the message back (ADR-025; MESSAGE-FLOW §6.1, §8)',
  },
  {
    phrase: 'placeholder posted by the flow',
    truth: 'on `@all` and `/battle` round 1 the TURN posts, as the assistant (ADR-025; MESSAGE-FLOW §8)',
  },
  // No conversation type is named after a classification. The ordinary type is
  // `general`; a classification is an input to it, never its name.
  {
    phrase: 'classification-named type',
    truth: 'the ordinary conversation type is `general`, which takes the classification as an input; no type key is a classification value (SPEC-CONVERSATION-TYPES Appendix A)',
  },
  {
    phrase: 'where type equals classification',
    truth: 'no path resolves a type from a classification; the drift, federated and person paths pass `general` (SPEC-CONVERSATION-TYPES FR1, FR4)',
  },
  // The abuse gate (§6.19) runs AFTER the LLM classifier (§6.9), so it refuses the answer model, not
  // every model: an over-limit sender is still classified, uncounted.
  {
    phrase: 'over limit, nothing reaches a model',
    truth: 'over limit, the answer model is not called; the 6.9 classifier call has already run, uncounted (MESSAGE-FLOW §6.19)',
  },
  // An assistant's grant is not a "floor": the assistant either acts in its own classification's channels or
  // holds nothing, and a floor reads as a lesser grant to fall back to, which ADR-046 rules out.
  {
    phrase: 'the seat is the floor',
    truth: "the assistant's own policy grants bearing its bot in its own classification's channels only, and the boundary caps it; there is no lesser grant (SPEC-CREDENTIAL-EXCHANGE; ADR-046)",
  },
  // NOT banned here, deliberately: "the duplicate-placeholder guard covers every path", the wrong
  // inference ADR-022 §4 now corrects. No document has ever phrased it that way, so a phrase entry
  // would be unfalsifiable - it could never be shown to fire, and an entry that cannot fire reads as
  // protection that is not there. That limit is carried by ADR-022 §4 and MESSAGE-FLOW §8
  // "Known limits" instead, and becomes a phrase here the first time someone writes it down wrong.

  // --- Class 0c: the battle prompt adds AWARENESS ONLY (ADR-029, owner 2026-08-13). `29adb2d` deleted
  //     `BATTLE_CONSTRAINTS_ROUND1` and with it FIVE prompt behaviors - one-clarifying-question
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
    phrase: 'preparebattleinvocation` takes',
    truth: 'prepareBattleInvocation no longer exists; a duel side runs the ordinary turn path (removed in 29adb2d)',
  },

  // --- Class A: basic is NOT keyword-classified. All default profiles use the LLM classifier;
  //     `classifierMode: 'keyword'` is an opt-in per-profile mode, not a tier behavior. ---
  // --- Class B: no stack owns an assistant identity (ADR-048, amended 2026-10-23). ---
  { phrase: 'cannot touch an assistant a deploy created', truth: 'every assistant identity is the provisioner\'s, declared or created in the console; a deploy seeds a declared one once and creates no identity of its own' },
  { phrase: 'a console-created one is retired from its row', truth: 'retire is one path for every assistant but a classification\'s primary (ADR-048, amended 2026-10-23)' },
  { phrase: 'classifyintentbasic', truth: "renamed to classifyIntentByKeyword (the keyword classifier is not tied to the basic tier)" },
  { phrase: 'basic tier is keyword', truth: "basic uses classifierMode: 'llm' (profiles.ts)" },
  { phrase: 'basic is keyword-only', truth: "basic uses classifierMode: 'llm' (profiles.ts)" },
  { phrase: 'keyword-only for basic', truth: "basic uses classifierMode: 'llm' (profiles.ts)" },
  { phrase: 'keyword (basic)', truth: "basic uses the LLM classifier (profiles.ts)" },
  { phrase: 'basic tier skips it', truth: "basic runs the LLM classifier like every default profile (profiles.ts)" },

  // --- Class B: every profile runs the FULL task loop. What basic lacks is the RICH processor output
  //     (richProcessor: false) — generated docs / battle / image gen — NOT task tracking.
  //     "lightweight" / "status-only" task support is the stale framing.
  //
  //     THE FIELD THAT CAUSED THIS IS GONE. These four phrases were written by readers who saw a
  //     `taskSupport: 'lightweight' | 'full'` field and reasonably concluded basic had less task
  //     tracking. Nothing read it, every conversational profile set 'full', and it is deleted
  //     (ADR-049). The phrases stay banned because the CLAIM is still writable and still wrong; the
  //     truths below now point at the switch that is real instead of at a field that is not. ---
  { phrase: 'lightweight task support', truth: 'every profile runs the full task loop; basic lacks the rich processor output (richProcessor: false), not task tracking' },
  { phrase: 'basic is lightweight', truth: 'basic runs the full task loop; richProcessor:false gates generated-doc output' },
  { phrase: 'basic gets lightweight', truth: 'basic runs the full task loop; richProcessor:false gates generated-doc output' },
  { phrase: 'lightweight tasks (grounds', truth: 'basic runs the full task loop; richProcessor:false gates generated-doc output, not task tracking' },

  // --- Class B2: BATTLE ELIGIBILITY IS TWO FACTS, NOT ONE (ADR-049). Whether a duel can run is the
  //     classification's `battleCapable` (standard + premium; basic is NOT, and its stack wires no
  //     battle plumbing) AND a runtime per-classification setting that is OFF by default.
  //
  //     These phrases are banned because each was written down while the single `battleEligible` flag
  //     existed, and they contradicted EACH OTHER even then: some docs said premium was the only
  //     eligible profile while the config had marked all three eligible. A claim that was wrong in two
  //     opposite directions is exactly the kind that comes back. ---
  { phrase: 'battle-eligible profile', truth: "battle capability is per CLASSIFICATION (`battleCapable`), not per assistant profile" },
  { phrase: 'premium is the only eligible', truth: 'standard and premium are battle-capable; battle is off by default for both' },
  { phrase: 'only battle-eligible', truth: 'capability is standard + premium; being capable does not turn battle on' },
  { phrase: 'every conversational classification is battle-eligible', truth: 'basic is NOT battle-capable (its stack wires no battle plumbing)' },
  { phrase: "profile's `battleeligible`", truth: '`battleEligible` is deleted from AssistantProfile (ADR-049); capability is the classification\'s `battleCapable`' },

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
  //     the one a deployer would budget from. Fidelity was traded deliberately (maintainer, 2026-08-09).
  { phrase: 'two rate/spend charges', truth: 'the flow gates a duel once and the handler skips its gate on any battleContext, so a 2-bot duel consumes ONE charge (router-agent-handler.ts; DESIGN-BATTLE "How a duel is metered")' },
  { phrase: 'n rate-limit and spend charges', truth: 'a duel is metered once for the whole duel, not once per side (MESSAGE-FLOW §4.8; DESIGN-BATTLE §5a)' },
  { phrase: 'per-side gate charging: yes', truth: 'per-side gate charging is NO; the duel is gated once, upstream (DESIGN-BATTLE §5a decision 2)' },
  { phrase: 'a battle costs each side the same as an ordinary turn', truth: 'a battle costs ONE charge for the duel, not one per side (MESSAGE-FLOW §4.8)' },

  // --- Class H: the round-1 fan-out and the clarification continuation BOTH dispatch through the
  //     handler entry; only the round-2 orchestrator still runs its own turn logic (ADR-023 A-prime).
  //     The build-state prose survived the handoff that invalidated it, which is the failure mode a
  //     phrase guard catches and a review does not: the duel still answers either way. ---
  { phrase: 'the entry exists; nothing calls it', truth: 'round 1 (channel-flow-processor.ts) and the clarification continuation both dispatch through the handler entry; only round 2 does not (DESIGN-BATTLE §5a)' },
  { phrase: 'have not been switched over, so behaviour is unchanged on both', truth: 'round 1 and the continuation are switched over; round 2 is the remaining caller (DESIGN-BATTLE §5a, ADR-023 A-prime)' },
  // The COUNT, phrased as prose. MESSAGE-FLOW §3.1 said "two paths still run turn logic outside the
  // handler" and named the continuation as one of them, three days after the continuation started
  // dispatching through the handler entry (it now reaches the handler as an ordinary Lex turn). The
  // Class H phrases above did not catch it because this sentence says the same wrong thing in different
  // words - which is the argument for banning the COUNT, not just the phrasing.
  { phrase: 'two paths still run turn logic outside the handler', truth: 'ONE path does: round 2 (battle-orchestrator.ts). `@all` and `/battle` round 1 dispatch through the handler entry, and a battle continuation arrives at it as an ordinary Lex turn (MESSAGE-FLOW §6.1)' },

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
  //     other direction now), and claiming a doc-set manifest is on the S3 body path (no such body
  //     exists; the persona and the intent pack are the bodies). ---
  { phrase: 'the persona rides inline in the definition', truth: 'a written definition stores `personaRef` and the body lives at profiles/{name}/{configId}/persona (lib/profile-bodies.ts; SPEC-PORTABLE-PROFILES "Where it lives")' },
  { phrase: 'persona is stored inside the ssm parameter', truth: 'the persona is offloaded to S3 and the parameter holds a pointer (lib/profile-lifecycle.ts:putDefinition)' },
  { phrase: 'persona, intent pack, and any referenced doc-set manifest stay in s3', truth: 'the bodies on the S3 store are a version persona and intent pack (profiles/) and a classification intent pack (classification-packs/); there is no doc-set manifest body (lib/profile-bodies.ts)' },
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
  { phrase: 'maketierrole', truth: 'no per-tier role exists: a person is vended a credential-exchange role, built by `makeExchangeRole` (identity-stack.ts)' },
  { phrase: 'tier_gated_channel_actions', truth: 'the constant is `CLASSIFICATION_GATED_CHANNEL_ACTIONS` (agent-classification-common.ts)' },
  { phrase: 'allowedtiers', truth: 'the catalog names no classification: each classification selects its models (`models.selected` in profiles.ts)' },
  { phrase: 'tiermodelselection', truth: 'a classification declares its own selection and default (`models` in profiles.ts, `ClassificationModels`)' },
  // THE PLATFORM ALLOWS, THE CLASSIFICATION SELECTS, THE PROFILE USES. The catalog names no
  // classification, no topology key names a model, and no version switch opens a provider outside AWS.
  { phrase: 'profilemodelselection', truth: 'a classification declares its own selection and default (`models` in profiles.ts, `ClassificationModels`)' },
  { phrase: 'default_profile_model_selection', truth: 'a classification declares its own default (`models.default` in profiles.ts); no deployment-wide selection exists' },
  { phrase: 'modelselectionkey', truth: 'a classification declares its own selection (`models` in profiles.ts); no topology key names a model' },
  { phrase: 'image_model_classifications', truth: 'an image model is selected by the classification (`models.selected`); the image catalog names no classification' },
  { phrase: 'externalproviderallowedforturn', truth: 'the processor checks the classification\'s selection of the external model (`externalProviderSelected`)' },
  { phrase: 'context/{tier}/', truth: 'the S3 context prefix is `context/{classification}/` (profile-registry.contextPrefixesGranted)' },

  // --- Class: a SECURITY SWITCH that does not exist. ---
  //
  // Docs described `adminIamEnforcement` as a context flag, on by default, whose opt-out returned the
  // admin APIs to the Cognito-group gate. No stack reads that key: every admin route is built with
  // `ADMIN_IAM_METHOD_OPTIONS` (admin-role-grants.ts), and the handlers that trust the signed caller
  // through `isAdminIamEnforcedCall` carry `ADMIN_IAM_ENFORCEMENT=true` unconditionally (the credential
  // exchange and `assistant-ownership` read the person from the console session instead).
  //
  // Stated as a switch, the sentence tells a deployer the weaker group-gated authorizer is one flag
  // away, and tells an auditor the posture depends on the deployment. It does not. That is the
  // direction of error that gets acted on: someone passes the flag believing it does something, or
  // reads the wrong posture into an audit. The phrase is the ASSIGNMENT FORM, which covers both the
  // opt-out (`=false`) and the enablement (`=true`); naming the flag to say it does not exist stays legal.
  { phrase: 'adminiamenforcement=', truth: 'there is no `adminIamEnforcement` context flag and no opt-out: no stack reads the key, and every admin route is AWS_IAM via `ADMIN_IAM_METHOD_OPTIONS` (backend/lib/constructs/admin-role-grants.ts) in every deployment' },

  // --- Class: THE COST CONTROLS DESCRIBED AS OPT-IN. ---
  //
  // `agent-classification-common.ts` defaults `bedrockGlobalHourlyBudget` to 500 and
  // `bedrockUserHourlyBudget` to 100, and because a global budget is set the SSM circuit parameter
  // and its grant are wired too. An EXPLICIT 0 is what turns them off. `cdk-synth.test.ts` asserts
  // exactly that and carries its own note recording that the default was inverted once already.
  //
  // The direction of error is the dangerous one: an operator who reads "opt-in" believes an
  // unbounded spend is possible on a default deployment and goes looking for a flag to set, or
  // worse, budgets for a limit that is already enforced.
  { phrase: 'spend budgets and the ssm circuit are opt-in', truth: 'both budgets are ON by default (global 500, per-user 100, in agent-classification-common.ts) and an explicit 0 turns them off. Describe the disabled state as "set to 0", never the enabled state as opt-in' },

  // --- Class: A LOSING DUPLICATE FULFILLMENT DESCRIBED AS RETURNING AN EMPTY ENVELOPE. ---
  //
  // Amazon Chime SDK materializes one message per turn from the LAST response, so returning an
  // empty `messages` array for the losing attempt silenced the WINNER. The router replays the same
  // placeholder carrying the same correlation marker instead. The empty envelope survives for one
  // different case only: the winner was gate-blocked.
  { phrase: 'empty `messages` array, which the client suppresses', truth: 'a losing duplicate replays the SAME placeholder with the same correlation marker; an empty envelope is returned only when the winner was gate-blocked. Amazon Chime SDK renders the LAST response, so an empty losing reply silences the winner' },

  // --- Class: CLASSIFICATION DESCRIBED AS AN ORDERED LADDER. ---
  //
  // ADR-046 removed `rank` from the configuration schema on 2026-09-17 and made `grants` the only
  // model: a classification reaches exactly what it declares, an undeclared set is an unknown
  // classification that reaches nothing, and `failClosedTo` is gone. `profile-registry.ts` records
  // why a rank fallback was removed - it "quietly re-imposed the ladder on a deployment that had not
  // asked for one".
  //
  // The stale word survived in tenet P4 for nine days after the code changed, and from there into
  // eight specs, two decision records and PERSONAS.md, because `.claude/hooks/tenets.js` reads tenet
  // P4 from the document and injects it into every planning turn. That is the specific way this
  // particular error propagates: each new document inherits it from the tenet rather than from the
  // code. A deployment declaring PEER classifications is the case the ladder wording silently
  // mis-describes, and it is exactly the case an implementer is most likely to reach for.
  { phrase: 'ordered axis', truth: 'a classification is a declared SET of grants, not a ladder (ADR-046). There is no rank. Write "the only closed axis IAM evaluates" and, where the distinction matters, say the classification reaches exactly what its `grants` declare' },
  { phrase: 'closed, ordered', truth: 'a classification is a declared SET of grants, not a ladder (ADR-046). Drop "ordered": write "the only closed axis IAM evaluates"' },
  // The compound adjectives place one classification above another, which is the ladder in two words.
  // A peer deployment (`legal` beside `finance`) has no higher or lower classification to name.
  { phrase: 'higher-classification', truth: 'a classification is a declared SET of grants, not a ladder (ADR-046). Write "a classification they are not cleared for", "another classification" or "a classification outside its set"' },
  { phrase: 'lower-classification', truth: 'a classification is a declared SET of grants, not a ladder (ADR-046). Write "a classification they are not cleared for", "another classification" or "a classification outside its set"' },
  { phrase: 'lower-clearance', truth: 'a clearance is a declared SET of grants, not a ladder (ADR-046). Write "a person not cleared for it"' },

  // Same class, found in CODE COMMENTS rather than docs by the 2026-09-28 tracker sweep - which is why
  // both are banned as phrases: the drift outlived every document fix by hiding one directory over,
  // in the files a reader trusts most because they sit beside the mechanism.
  //
  // `failClosedValue` is deleted with nothing replacing it, so prose telling a reader to fall back to
  // it is not merely stale, it prescribes a guess about which data a person may see. The write
  // direction does have an answer (`failClosedContentValue`, because a stamp must be some value); the
  // READ direction does not, and must refuse.
  // Lowercase, per the matcher's contract above - the first draft of these two carried the camelCase
  // symbol name and so could never fire, which the lowercase-phrase test below now refuses outright.
  { phrase: 'fall back to `failclosedvalue`', truth: '`failClosedValue` is DELETED and nothing replaces it (ADR-046). For a READ there is no fallback - refuse. For a WRITE, stamp `failClosedContentValue`, the classification the fewest holders reach' },
  { phrase: 'failclosedvalue, the lowest', truth: 'there is no lowest: `legal` and `finance` are peers (ADR-046). `failClosedValue` is deleted. An access decision with an unreadable tag refuses rather than defaulting' },
  // --- Class: A HEADER THAT TELLS A DEVELOPER TO PUT A PRIVATE FIELD IN MEMBER-WRITABLE STORAGE. ---
  //
  // `channel-context-client.ts` is the module header read to decide where a new conversation field
  // belongs, and it said channel Metadata still carried `userLanguage`, `segment` and the participant
  // roster, with "only the four private grounding fields" in the server-only store. All of that was
  // contradicted further down the same file: those fields moved precisely because Metadata is
  // member-WRITABLE. Banned because the cost is not a misled reader, it is the NEXT private field being
  // put somewhere a member can rewrite it.
  // --- Class: A HEADER SAYING A TABLE IS NEVER WRITTEN, WHILE THE ARCHIVAL PATH WRITES IT. ---
  //
  // `cross-conversation-context.ts` carried a block titled "NOT WIRED. READ THIS BEFORE BUILDING ON
  // IT" asserting that neither export had a caller and the table was never written. `kinesis-archival`
  // imports and calls `updateConversationContext` on the live path, and has since before that header
  // was written, and the comment was never corrected. Banned because a reader
  // acting on it concludes an accumulating table of raw user content is empty - and that table has no
  // classification column, no row-level security and no redaction carry-through.
  // One phrase, on one line, lowercase - the wrapped "is NEVER WRITTEN at runtime" form spans two
  // lines and so could never fire, which is the inert-entry mistake the lowercase/single-line test
  // above exists to refuse. This clause sat on one line in the original and is the load-bearing claim.
  { phrase: 'neither export has a caller', truth: '`updateConversationContext` IS called from kinesis-archival on the archival path, so the table is written continuously. Only `findRelatedConversations` (the READ) is unwired' },

  { phrase: 'only the four private grounding fields', truth: 'the channel-context store holds 13 fields. `userLanguage`/`segment` (they select the model), the participant roster (a member could add a `sub` and have content emailed out of band) and `priorMessage` all moved out of Metadata because Metadata is member-WRITABLE. Metadata keeps only the model fields, the drift pointers and a sanitized topic label' },

  // THE BAN IS INVERTED, because the claim it forbade is now true. `makeExchangeRole` and
  // `ExchangeRoleAdminPlane` build with `PrincipalWithConditions` carrying the `sub` and
  // `classification` tag pin, so the rung roles do take the assistant roles' shape and the two specs that
  // always said so are no longer describing an intention. What is worth guarding is the REGRESSION:
  // a bare `ArnPrincipal` on an exchange role emits an unconditioned `sts:AssumeRole` again, and the
  // TagSession statement beside it makes that look handled. So the banned phrase is now the sentence
  // a reader would write on the way back.
  { phrase: 'rung roles do not yet take this shape', truth: 'they DO, as of the tag pin on the assume itself. `makeExchangeRole` and `ExchangeRoleAdminPlane` in `identity-stack.ts` both use `PrincipalWithConditions` with the `sub`/`classification` pin, matching the assistant roles in `agent-classification-common.ts`. If this sentence is true again, an exchange role has been reverted to a bare `ArnPrincipal` and can be assumed un-pinned' },

  // --- Class: AN ACCESS PROPERTY THAT HOLDS ONLY BECAUSE THE EVIDENCE WAS INCOMPLETE. ---
  //
  // The API guide claimed no route is served without an authorizer, and a test asserted the same set
  // was empty. Both passed, because the inventory they read synthesized no `sleepMode` deployment and
  // `GET /deployment/state` - the one unauthenticated route in the platform - was therefore absent
  // from the evidence rather than authorized. The guard is on the SENTENCE because the sentence is
  // what a reader acts on, and an absolute claim about access is the kind most worth re-checking: it
  // is the easiest to write from a summary count and the least likely to be questioned later.
  { phrase: 'no route is served without an authorizer', truth: '`GET /deployment/state` is served with no authorizer when `sleepMode` is set - a client must render the paused banner before it can hold a credential. Say "every route but one", and name it' },

  // --- Class: THE OPPOSITE OF THE MEASUREMENT. Membership removal does NOT clear moderator status. ---
  //
  // MEASURED 2026-09-28 on a scratch RESTRICTED/PRIVATE channel: a member was added, made a
  // ChannelModerator, and had their membership deleted. `ListChannelMemberships` then omitted them and
  // `ListChannelModerators` STILL LISTED THEM. So dropping a membership leaves the ChannelModerator
  // record standing, and a demoted admin keeps the role unless something revokes it explicitly.
  //
  // THIS ENTRY REPLACES A BAN ON THE TRUE SENTENCE. The claim was asserted in a code comment without
  // evidence, challenged, and then withdrawn - and the withdrawal was banned into this file, so the
  // accurate statement became unwriteable. Deferring to a challenge is not the same as measuring, and
  // the cost of confusing them is a guard that enforces the wrong fact. What is banned now is the
  // reading the measurement rules out.
  { phrase: 'deleting a membership also clears moderator', truth: 'measured 2026-09-28: it does NOT. The member is removed from ListChannelMemberships and still appears in ListChannelModerators, which is why the admin reconcile revokes moderation explicitly' },
  { phrase: 'membership removal clears moderator', truth: 'measured 2026-09-28: it does NOT. The ChannelModerator record survives, so a demoted admin keeps the role until something revokes it' },
  // --- Class: A CONTROL CLAIMED TO PROTECT SOMETHING A LIVE TEST SHOWED IT DOES NOT. ---
  //
  // A Deny on every bot ARN was written, unit-tested, shipped and deployed to stop a vended
  // credential removing the assistant. `deny-test-assistant-membership.mjs` then removed the
  // assistant with exactly that credential. Amazon Chime SDK authorizes these actions on the CHANNEL
  // and does not evaluate the targeted member, so the sentence below cannot be made true in IAM at
  // all - it is banned rather than corrected because four green unit tests already made it look true
  // once.
  { phrase: 'assistant is out of reach of every vended credential', truth: 'measured 2026-09-28: a vended manage-membership credential removed the assistant AND promoted it to moderator. Chime authorizes on the channel and ignores the target, so this belongs in the handler, not IAM' },


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
  // cheap substring router with an LLM backstop, when the shipped behavior is a model call on
  // essentially every real message. That misleads on cost, on latency and on classification quality
  // at once.
  //
  // The phrases are ones only the wrong belief produces. "keyword fallback" alone is NOT banned:
  // decision 006 legitimately says "there is no substring/keyword fallback by design", and a guard
  // that fires on a correct negation gets switched off.
  { phrase: 'fast-path keyword matching', truth: 'the default path is the LLM classifier; the keyword classifier is opt-in per profile via classifierMode' },
  { phrase: 'keywords, else the llm', truth: 'the LLM classifier is the default for every shipped profile; keyword mode is an opt-in alternative, not a second choice after keywords' },
  // The "no shipped profile uses keyword mode" half of this truth went stale and was corrected on
  // 2026-09-26. `ops-premium` in profiles.ts sets `classifierMode: 'keyword'` on purpose, with the
  // reasoning in its own comment: the ops questions are narrow and repetitive, so a frontier model
  // plus a model-backed classifier on them is the cost that tenet P5 asks a builder to control. The
  // banned phrase is still right - keyword is an ALTERNATIVE, never a fallback behind llm - but a
  // correction text that denies a shipped profile exists teaches the wrong fact while fixing another.
  { phrase: 'with keyword fallback', truth: 'keyword and llm are alternative classifierMode values, not a chain. The three default classification profiles set llm; the opt-in `ops-premium` role sets keyword deliberately as a cost control. Never describe keyword as a fallback behind llm, and never as the default path' },
  { phrase: 'llm classifier for unmatched messages', truth: 'the LLM classifier handles essentially every message; only exact greeting/acknowledgment tokens short-circuit before it' },

  // --- Class: A RETRACTED MEASUREMENT that already traveled once. ---
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

  // --- The archival path publishes no member count, and the channel-context store holds none. ---
  //
  // This claim survived in FOUR places at once - a spec's writer table, the store's own header, an IAM
  // grant comment and a CloudWatch alarm description - for a value that had no reader anywhere. Each
  // one made the others look corroborated, which is exactly the shape a guard is for. The count also
  // cannot serve the decision it was written for: derived from archived membership events it collapses
  // assistants into the human roster, so a battle channel of three reports 2.
  { phrase: 'the archival path writes `membercount`', truth: 'the archival path publishes no member count; @all size is resolved live by lib/channel-size.ts (resolveChannelSize)' },
  // --- The effective classification is the CHANNEL's (router-agent-handler.ts). ---
  //
  // The handler once capped a turn at min(caller clearance, channel classification). That cap decided
  // nothing IAM had not already decided, answered two members of one conversation at different
  // classifications, and downgraded a premium conversation to basic on any clearance-lookup outage.
  // It was removed, and the claim then survived in a dozen documents and comments at once.
  { phrase: 'min(usertier, channeltier)', truth: "the effective classification is the channel's; IAM refuses a sender without clearance for it, and a mismatch logs a SecurityEvent (router-agent-handler.ts)" },
  { phrase: 'min(usertier,channeltier)', truth: "the effective classification is the channel's (router-agent-handler.ts)" },
  { phrase: 'min(callerclearance, channelclassification)', truth: "the effective classification is the channel's (router-agent-handler.ts)" },
  { phrase: 'min(userclearance, channelclassification)', truth: "the effective classification is the channel's (router-agent-handler.ts)" },
  { phrase: 'min(channel, user)', truth: "the effective classification is the channel's (router-agent-handler.ts)" },
  { phrase: 'a membership signal the archival path records', truth: 'the channel-context store holds no member count; nothing reads one (lib/channel-size.ts)' },
  // --- An Aurora analytics window reads BOTH bounds (analytics-aurora/analytics-query.ts queryWindow). ---
  //
  // Reducing a dateRange to a day count served a past window as the trailing one, and the latency turn
  // count is named for what it counts. Either stale claim sends a reader to the wrong number.
  { phrase: 'derives a day count from the span', truth: 'Aurora binds both bounds as one tstzrange and every window predicate reads lower() and upper() (analytics-query.ts queryWindow)' },
  { phrase: 'latency_metrics.exchange_count', truth: 'the column is latency_metrics.assistant_turn_count; the exchange count is conversation_volumes.paired_exchange_count' },
  // --- A classification reaches only its own router (lib/router-arn.ts, ADR-046). ---
  //
  // The router table let premium fall back to standard's router and sent any classification it did not
  // know to standard's, and the battle orchestrator answered an absent classification as standard. A
  // classification is set or not: each resolves to its own router or the turn is declined.
  { phrase: 'falls back to the standard router', truth: "each declared classification resolves only to its own router; an unset one declines the turn (lib/router-arn.ts)" },
  { phrase: 'may fall back down to standard', truth: "no classification falls back to another's router (lib/router-arn.ts, ADR-046)" },
  { phrase: 'absent resolves to standard', truth: 'an absent or undeclared duel classification fires nothing (battle-orchestrator.ts classificationKeyFor)' },
  { phrase: 'absent classification degrades to standard', truth: 'an absent or undeclared duel classification fires nothing (battle-orchestrator.ts classificationKeyFor)' },
  // --- A model outside AWS is the classification's to select: no person, version or deploy default opens it. ---
  //
  // The classification's `models.selected` decides it (the platform allows, the classification selects, the
  // profile uses), and the same selection is where its stack holds the provider's key. A profile version's
  // retired `models.externalProviderAllowed` is read as absent.
  { phrase: 'per-user consent', truth: 'the external provider is used exactly where the classification selects deepseek_api (models.selected; externalProviderSelected in assistant-async-processor.ts)' },
  { phrase: 'per-person consent', truth: 'the external provider is used exactly where the classification selects deepseek_api (models.selected; externalProviderSelected in assistant-async-processor.ts)' },
  { phrase: 'allowed an external provider on the live assistant', truth: 'an external image model is used exactly where the classification selects it (modelFits); no version setting opens it' },
  { phrase: 'models they have always used', truth: 'each shipped classification declares its own selection (lib/config/profiles.ts); describe it as it is' },
  { phrase: 'externalmodelconsent', truth: 'removed; RoutingContext carries no end-user consent field (resolve-model-plan.ts)' },
  { phrase: 'external_model_consent_default', truth: 'removed; no deployment default opens the external provider (assistant-profile-stack.ts sets no such env)' },
  // --- The analytics mode is chosen at first deploy; switching is not supported. ---
  //
  // The guide carried an OPEN "no verified switch procedure", which reads as a gap waiting to be
  // filled. It is a decision: both analytics stacks create the same fixed-name resources, so
  // deploy.mjs refuses a switch (deploy-guards.cjs checkAnalyticsModeLock) and a mode change is a
  // teardown and a fresh deployment.
  { phrase: 'there is no verified switch procedure', truth: 'switching an existing deployment between Athena and Aurora is not supported; deploy.mjs refuses it (AURORA-MODE-GUIDE.md, Switching modes)' },
  // --- deploy.mjs resolves adminAppUrl, and each frontend target is derived on its own. ---
  { phrase: 'but does not resolve `adminappurl`', truth: 'deploy.mjs resolves adminAppUrl from AdminDistributionUrl when admin is a declared capability, the same way it resolves appUrl' },
  { phrase: 'set it on a second backend deploy once the admin console', truth: 'npm run deploy resolves adminAppUrl from the admin distribution; set it only for a custom domain or a hand-run cdk deploy' },
  { phrase: 'so the admin origin is untrusted until step 2', truth: 'npm run deploy closes the admin CORS loop in the same run (FRONTEND-DEPLOY.md)' },
  { phrase: '`frontend_stack_name` takes precedence over the prefix', truth: 'FRONTEND_STACK_NAME overrides the chat target only and ADMIN_FRONTEND_STACK_NAME the admin target only (deploy-guards.cjs resolveFrontendTargets)' },
  { phrase: 'which otherwise looks up `agentechelonfrontend`', truth: 'deploy.mjs derives both frontend targets from AE_INSTANCE_NAME / AE_STACK_PREFIX, the variables the CDK app names its stacks from' },
  // --- The feedback summary refuses a window it cannot honor (user-feedback.ts summarizeFeedback). ---
  { phrase: 'clamped to 180', truth: 'GET /feedback refuses a `days` value that is not a whole number from 1 to 180 with 400; nothing is clamped (user-feedback.ts)' },
  // --- No admin route reads a host admin pool (constructs/admin-auth-mode.ts). ---
  //
  // Every admin route is AWS_IAM in every deployment, so no admin auth mode selects an authorizer or
  // takes a pool id; the context key that named one has no reader. The phrase is the stale deploy
  // instruction, not the bare key: deploy-context.ts names the key to refuse it as retired.
  { phrase: '-c hostadminpoolid=', truth: 'retired; adminAuthMode selects no authorizer, and a host identity provider federates into the deployment\'s own pool (deploy-context.ts, ADMIN-INTEGRATION-GUIDE Approach 1)' },
  // --- One path per feature for every issuer: the trusted-issuer registry (lib/config/issuers.ts). ---
  //
  // The host-pool copies of the exchange, the create and the membership changes are deleted, and the
  // six context keys that configured them are retired (RETIRED_CONTEXT_KEYS in deploy-context.ts, which
  // names each bare key to refuse it, so the phrases here are the stale instruction or the removed name).
  { phrase: 'federated-credential-exchange', truth: 'one exchange serves every issuer: credential-exchange.ts, with the one-conversation vend for a oneChannel issuer' },
  { phrase: 'federated-create-conversation', truth: 'one create path: create-conversation.ts, which dispatches a oneChannel caller\'s context request to its classification\'s creator' },
  { phrase: 'federated-add-member', truth: 'a host\'s add and remove: membershipHandler in conversation-management.ts (ConversationMembershipFunction)' },
  { phrase: 'federated-remove-member', truth: 'a host\'s add and remove: membershipHandler in conversation-management.ts (ConversationMembershipFunction)' },
  { phrase: 'lib/federated-identity', truth: 'a person from any issuer is minted and resolved by lib/person-identity.ts, keyed on the issuer\'s registry id' },
  { phrase: '/exchange-credentials/federated', truth: 'POST /exchange-credentials serves every issuer the registry declares' },
  { phrase: '/create-conversation/federated', truth: 'POST /create-conversation serves every issuer the registry declares' },
  { phrase: 'federatedexchangeapiurl', truth: 'a host pool\'s people use CredentialExchangeApiUrl, the one exchange' },
  { phrase: 'federatedaddmemberfunctionarn', truth: 'the host\'s membership changes go to ConversationMembershipFunctionArn ({ op: add | remove })' },
  { phrase: '-c federateduserpoolid=', truth: 'retired; a host app\'s pool is an issuers entry in deploy.config.json (lib/config/issuers.ts)' },
  { phrase: '-c assistanttier=', truth: 'retired; a context conversation\'s classification is its issuer\'s clearance.oneChannel' },
  { phrase: '-c notifyuserpoolid=', truth: 'retired; the email bridge resolves recipients in the pools the trusted-issuer registry declares, on with the notifications capability' },
  { phrase: '-c notifyadditionaluserpoolids=', truth: 'retired; every cognito-pool entry in the trusted-issuer registry is a pool recipients are resolved in' },
  { phrase: '-c admingroupnames=', truth: 'retired; adminGroups on the registry\'s deployment entry names the admin group' },
  { phrase: '-c identityprovider=', truth: 'retired; the IdentityProvider output is derived from the trusted-issuer registry' },
  { phrase: 'enabled by `federateduserpoolid`', truth: 'retired; a second issuer is an entry in the trusted-issuer registry' },
  // --- Battle round two is measured from the instant round two was triggered (migration 071). ---
  //
  // The orchestrator declares the duel's last round-1 terminal state as the rebuttal's trigger_at, and
  // both its ack_ms and its own e2e_ms start there. The rival's answer is that instant only for the
  // side that finished round one first.
  { phrase: "began at the rival's answer", truth: "a rebuttal's wait and end to end start when round two was triggered, the duel's last round-1 terminal state (migration 071, battle-orchestrator.ts)" },
  // --- A battle has no alias (experiment-manager.ts battleSideNames). ---
  //
  // A variant carries no `displayName`; each duel side is named from its profile, the challenger's marked
  // with `battleAltName` when the two names match. The phrases are the retired concept's own names.
  { phrase: 'treatment alias', truth: "a duel side is named from its profile; the treatment's name is its version's, else the control's, marked `{name} (alt)` when they match (experiment-manager.ts battleSideNames)" },
  { phrase: 'battle alias', truth: 'a battle has no alias; each duel side is named from its profile (experiment-manager.ts battleSideNames)' },
  // --- A person key says it is a person (migration 079, conversations-stack.ts, identity-stack.ts). ---
  //
  // The bearer pin reads the `person` session tag, and the task mirror's indexes are keyed on `personId`
  // and `ownerPersonId`. The old names are the stale assertions.
  { phrase: 'principaltag/sub', truth: 'the bearer pin is `${aws:PrincipalTag/person}`, the person session tag carrying the AppInstanceUser id (identity-stack.ts)' },
  { phrase: 'usersub-tasktype-index', truth: 'the active-task GSI is `principalId-taskType-index` (conversations-stack.ts)' },
  // The task mirror's partition holds an assistant's id while an assistant holds the work, so its key
  // says it holds a principal.
  { phrase: 'personid-tasktype-index', truth: 'the active-task GSI is `principalId-taskType-index` (conversations-stack.ts)' },
  { phrase: 'ownersub-index', truth: 'the owner GSI is `ownerPersonId-index` (conversations-stack.ts)' },
  // --- A person is minted by the exchange, never named by a token's `sub` (person-identity.ts). ---
  //
  // The person id is a UUID v7 minted once per (issuer, subject), and the admin twin is named from it.
  // The phrases are the retired names: the `sub` the id once was, and the twin named after it.
  { phrase: 'minted as the cognito `sub`', truth: 'the credential exchange mints the person id as a UUID v7, once per (issuer, subject), in the Identities table (person-identity.ts mintOrResolvePerson)' },
  { phrase: '`${sub}-admin`', truth: 'the admin twin is `${personId}-admin`, tagged `owner` with its owner\'s AppInstanceUser ARN (person-arn.ts adminTwinIdFor, credential-exchange.ts)' },
  // --- The layers are labels; the component rule is what binds (STACKS.md, ADR-055 decision 2). ---
  //
  // A strict per-stack layer rule was proposed and rejected. The phrase is that rule's own wording.
  { phrase: 'depends only on its own layer', truth: 'no per-stack layer dependency is checked; the rule is the four components in order: the core, then the chat interface and the admin backend on it, then the admin interface on the admin backend (STACKS.md "Component rule", backend/test/deploy-matrix/)' },
  // --- The core is Messaging, Identity, Conversations and Archive (STACKS.md "The stacks"). ---
  //
  // The stacks these names belonged to were merged or renamed; a doc or comment naming one points a
  // reader at a stack no deployment creates.
  { phrase: 'agentechelonchimemessaging', truth: 'the app instance and the message stream are `AgentEchelonMessaging` (messaging-stack.ts)' },
  { phrase: 'agentecheloncognitoauth', truth: 'identity is `AgentEchelonIdentity` (identity-stack.ts)' },
  { phrase: 'agentechelonfoundations', truth: 'the shared conversation state is `AgentEchelonConversations` (conversations-stack.ts)' },
  { phrase: 'agentechelons3storage', truth: 'the attachments bucket is in `AgentEchelonConversations` (conversations-stack.ts)' },
  { phrase: 'agentechelonanalyticsaurora', truth: 'the archive is `AgentEchelonArchive` in both modes; its `AnalyticsMode` output names the mode' },
  // --- There is no Identity Pool: the credential exchange is the only source of a person's AWS credentials. ---
  { phrase: 'identitypoolid', truth: 'the deployment creates no Identity Pool, so no stack outputs one (identity-stack.ts)' },
  { phrase: 'identity-pool roles carry no', truth: 'there are no Identity-Pool roles: the deployment creates no Identity Pool, and no group carries a role (identity-stack.ts)' },
  { phrase: 'keeps a cognito identity pool', truth: 'the deployment creates no Identity Pool (identity-stack.ts)' },
  // --- The message stream and its streaming configuration are Messaging's, once, in both archive modes. ---
  { phrase: 'single messaging streaming configuration', truth: 'the Messaging stack holds the app instance\'s one streaming configuration; the Archive stack consumes the stream in either mode (messaging-stack.ts)' },
  // --- The host-assertion issuer and provisioned-only provisioning are built (A9, P-13). ---
  { phrase: 'the host-assertion issuer is not built', truth: 'a host-assertion entry is verified at the edge against its pinned keys, its jti spent once, and bound to a pre-assigned person (lib/config/issuers.ts, edge-authorizer.ts)' },
  { phrase: 'provisioning "provisioned-only" is not built', truth: 'provisioned-only is built: provisionSubject writes a pending row the exchange binds once (person-identity.ts, provision-subject.ts)' },
  // --- Offboarding keeps votes and thumbs; a person key is the AppInstanceUser id (SPEC-CREDENTIAL-EXCHANGE §5b). ---
  //
  // Deleting a person keeps their battle votes and thumbs feedback, still carrying their AppInstanceUser id,
  // and the id is minted by the exchange, never a claim one identity provider issues. The phrases are the
  // retired assertions, not the bare words: "Cognito sub" stays legal in a sentence that says it is not the key.
  { phrase: 'erases their votes', truth: "offboarding keeps a person's battle votes and thumbs feedback, still carrying their AppInstanceUser id (lib/offboarding.ts, SPEC-CREDENTIAL-EXCHANGE §5b)" },
  { phrase: 'appinstanceuser id is the cognito sub', truth: 'the AppInstanceUser id is a UUID v7 the credential exchange mints once per (issuer, subject) (person-identity.ts mintPersonId)' },
  { phrase: 'keyed by the cognito sub', truth: 'a record a person makes or owns is keyed by their AppInstanceUser id (TENETS.md tenet D14)' },
  { phrase: 'one cognito user pool.**', truth: 'a deployment trusts the issuers its trusted-issuer registry declares (lib/config/issuers.ts); its own pool is one of them, declared as pool "self"' },
  // --- The deploy order is four components, declared as capabilities (STACKS.md, ADR-055). ---
  //
  // The admin backend was never separable by default and "admin foundations" was a deploy layer of the
  // retired vocabulary; Foundations is a layer. The four keys that switched stacks are refused at synth
  // (RETIRED_CONTEXT_KEYS, deploy-context.ts), which names each bare key, so the phrases are the stale
  // instructions to set one.
  { phrase: 'admin plane is already separable', truth: 'the admin backend is AdminServices plus AdminApi, omitted as one unit when admin is not a declared capability (STACKS.md "Component rule")' },
  { phrase: 'admin backend is already separable', truth: 'the admin backend is AdminServices plus AdminApi, omitted as one unit when admin is not a declared capability (STACKS.md "Component rule")' },
  { phrase: 'admin foundations', truth: 'the four components are the core, the chat interface, the admin backend and the admin interface; Foundations is a layer (STACKS.md "Component rule")' },
  { phrase: 'enablebattle=', truth: 'retired; declare "battle" (with "experiments") in capabilities in deploy.config.json (deploy-context.ts refuses the key)' },
  { phrase: '"enablebattle"', truth: 'retired; declare "battle" (with "experiments") in capabilities in deploy.config.json' },
  { phrase: 'enablemeetings=', truth: 'retired; meetings is the meetings capability, NOT BUILT and refused at synth (capabilities.ts)' },
  { phrase: '"enablemeetings"', truth: 'retired; meetings is the meetings capability, NOT BUILT and refused at synth (capabilities.ts)' },
  { phrase: 'additionalroles=', truth: 'retired; a declared role is deployed: name its assistant in profiles (ops-premium), or run npm run add-assistant-role (deploy-context.ts refuses the key)' },
  { phrase: '"additionalroles"', truth: 'retired; a declared role is deployed: name its assistant in profiles (ops-premium), or run npm run add-assistant-role' },
  { phrase: '`additionalroles` set to', truth: 'retired; a declared role is deployed: name its assistant in profiles (ops-premium), or run npm run add-assistant-role' },
  { phrase: 'enabledroles', truth: 'the Assistants stack builds every declared role (deployedRoles, assistant-profile-stack.ts); no switch filters them' },
  { phrase: 'enableadminapp=', truth: 'retired; declare "admin" in capabilities in deploy.config.json' },
  { phrase: '"enableadminapp"', truth: 'retired; declare "admin" in capabilities in deploy.config.json' },
  { phrase: '`enableadminapp` is set', truth: 'retired; the admin console is published when "admin" is a declared capability' },
  { phrase: '`enableadminapp` set', truth: 'retired; the admin console is published when "admin" is a declared capability' },
  { phrase: 'enableadminnotificationchannel=', truth: 'retired; the admin notification channel is part of the admin capability' },
  { phrase: '"enableadminnotificationchannel"', truth: 'retired; the admin notification channel is part of the admin capability' },
  // --- The minimal set and the declared classifications are built (STACKS.md "The minimal set"). ---
  { phrase: 'minimal deployment is nine stacks', truth: 'the smallest deployment with no accounts is the seven core stacks plus Assistants-guest, Assistants-customer and Widget (STACKS.md "The minimal set")' },
  { phrase: 'cannot declare its own classifications', truth: 'a deployment declares its classifications in profiles (resolveDeploymentProfiles, lib/config/profiles.ts)' },
  { phrase: "retiring the battle stack's alt bots", truth: "the alt of each duel is built in Battle through its classification's own provisioners (ADR-050, battle-stack.ts)" },
  { phrase: 'guest issuer is refused at synth', truth: 'the guest issuer is built: guest start signs with its KMS key and the edge verifies its tokens (GUEST-ISSUER.md, lib/config/issuers.ts)' },
  // --- The retired stack names (stack-names.json `retired`), as a default-instance stack name. ---
  //
  // retired-stack-names-are-refused.test.ts refuses them in backend/ and tests/ code; these refuse them in
  // prose. Two retired shapes are left to that test alone: `Meeting` is a prefix of the current `Meetings`,
  // and `Classification-` appears in decision records' evidence queries, which quote the log groups of the
  // layout they were measured on.
  { phrase: 'agentecheloniampolicies', truth: 'no IAM policies stack: each stack holds the roles and policies of what it owns (STACKS.md "The stacks")' },
  { phrase: 'agentechelonadminplane', truth: 'the admin backend is `AgentEchelonAdminServices` plus `AgentEchelonAdminApi` (STACKS.md)' },
  { phrase: 'agentechelonadminnotification', truth: 'the admin notification channel is in `AgentEchelonAdminServices` (STACKS.md)' },
  { phrase: 'agentechelonanalytics', truth: 'the archive is `AgentEchelonArchive` in both modes; its `AnalyticsMode` output names the mode' },
  { phrase: 'agentechelonfrontend', truth: 'the chat app hosting is `AgentEchelonChatApp` (chat capability)' },
  { phrase: 'agentechelonadminfrontend', truth: 'the admin console hosting is `AgentEchelonAdminApp` (admin capability)' },
  { phrase: 'agentechelonbedrockbot', truth: "each classification's assistants are `AgentEchelonAssistants-<classification>` (STACKS.md)" },
  { phrase: 'agentechelonbedrockagents', truth: "there is no Bedrock Agent; each classification's assistants are `AgentEchelonAssistants-<classification>`" },
  { phrase: 'agentechelontier-', truth: "each classification's assistants are `AgentEchelonAssistants-<classification>` (STACKS.md)" },
  // --- The admin classification grants itself alone (SPEC-ADMIN-IDENTITY FR1). ---
  // Docs said the `admin` classification granted every member classification and that its chat role was
  // `channel/*` with no tag condition. A chat identity is membership-gated and tag-gated like any user's;
  // reach across every conversation is admin access, on the console and the `${personId}-admin` identity.
  { phrase: '`admin` grants all four', truth: 'the `admin` classification grants itself alone (lib/config/profiles.ts); admin access is the console and the admin twin' },
  { phrase: 'marked as the admin plane, granting all four', truth: 'the admin plane grants itself alone (lib/config/profiles.ts)' },
  { phrase: 'classification boundary lifted to all classifications', truth: 'an admin chat identity reaches admin-plane channels, plus its member classification\'s set through the adminPlane session tag (exchange-role.ts)' },
  { phrase: 'the `admin` role gets **unconditioned** channel access', truth: 'the admin plane\'s chat vend role is tag-gated to admin-plane channels (exchange-role.ts)' },
  // --- A delivered document is DECLARED, never promoted from the reply (SPEC-TASK-STATE-TRANSITIONS §4). ---
  // The loop kept text written beside an advance and the gate promoted it to the file, and the delivering
  // prompt told the model its whole reply became the document. A live extraction shipped its greeting and
  // an apology about files as the table. The document is the `document` argument; the reply is chat.
  { phrase: 'textbesidetaskadvance', truth: 'the file is the document declared in the `document` argument of advance_task_state (or deliver_document); nothing beside the call is kept' },
  { phrase: 'whole reply becomes the document', truth: 'the document is declared as an argument and the reply posts as chat (deliveringContract, task-tracking.ts)' },
  { phrase: 'trailing-question veto', truth: 'an in-state rewrite declares its document with deliver_document; nothing reads the shape of the reply' },
  // --- The ops assistant reads metrics and alarm state, and no logs (deployment-health.ts). ---
  { phrase: 'reads cloudwatch and logs', truth: 'read_deployment_health reads CloudWatch metrics and this deployment\'s alarm state (DescribeAlarms, scoped to its alarm ARNs); no CloudWatch Logs client exists under lambda/src' },
  // --- A version's `copy` is retired: selection reads none, and the console has one Message templates section (ADR-062, 2026-10-29). ---
  { phrase: 'read as the assistant\'s own template until', truth: 'selection reads no `copy`; `npm run migrate-legacy-copy` writes a version\'s retired lines as the assistant\'s own templates (ADR-062 decision 3)' },
  { phrase: 'one field per named message', truth: 'the console edits no `copy`; what an assistant says is its Message templates section, which also picks `messages`' },
  { phrase: 'the draft\'s message choices', truth: 'the template each message uses is picked in the Message templates section, under Used in this version' },
  // --- A version's `welcome` is retired: the welcome is its assistant-joined workflow (ADR-061 decision 9, W1). ---
  { phrase: 'a welcome in workflow mode', truth: 'the welcome is the version\'s assistant-joined workflow, selected by the room\'s conversation type; there is no welcome mode (ADR-061 decision 9)' },
  { phrase: 'the welcome mode (`structured`', truth: 'the welcome\'s opening is a template step, a prompt step after it, or steps that greet and then continue, in its assistant-joined workflow (ADR-061 decision 9)' },
  { phrase: '`welcome.mode`, set on the version', truth: '`welcome` is retired; `npm run migrate-legacy-welcome` carries it into the version\'s welcome workflows' },
  // --- A draft is edited one card per area, and the old draft form's parts are gone. ---
  { phrase: '`draftextras`', truth: 'the draft form is split into one editor per area (`DraftAreaFields.tsx`, `WelcomeFields`, `EventWorkflowsFields`), each rendered inline in its section by `DraftStep` in `DraftControls.tsx`' },
  { phrase: 'new version → event workflows', truth: 'event workflows are the draft\'s Events card: Assistants → New version → Events' },
  { phrase: 'new version → message templates', truth: 'what an assistant says is the draft\'s What it says card: Assistants → New version → What it says' },
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

  /**
   * A BANNED PHRASE THAT CANNOT FIRE IS THE FAILURE THIS FILE EXISTS TO PREVENT.
   *
   * The matcher is `line.toLowerCase().includes(phrase)` and does NOT lowercase the phrase, so one
   * capital letter makes an entry permanently inert - it is added in good faith, the suite goes green,
   * and the drift it was written for ships unchecked. A newline does the same, because matching is
   * per line.
   *
   * This was documented in a comment above the list and it still happened: two entries added in the
   * 2026-09-28 sweep carried a camelCase symbol name (`failClosedValue`) and neither could ever match.
   * They were caught by deliberately re-injecting the stale text and noticing the guard stayed green,
   * not by reading the warning. So the warning is now a refusal - the same nudge-plus-test pairing the
   * rest of the repo uses, applied to the guard itself.
   */
  it('every banned phrase can actually fire (lowercase, single line)', () => {
    const inert = BANNED.filter(({ phrase }) => phrase !== phrase.toLowerCase() || /[\r\n]/.test(phrase));
    expect(inert.map(({ phrase }) => phrase)).toEqual([]);
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
 * RETIRED VOCABULARY: "SEAT".
 *
 * An assistant's identity, its infrastructure and the assignment record that gives it a role is an
 * ASSISTANT; its role and whether it is the live assistant or the alt are attributes of it. "Seat" named
 * a slot that existed apart from whoever filled it, and nothing does any more: a live bot belongs to one
 * assistant, the alt is the fixed assistant `alt-{role}-{classification}` (ADR-050), and a runtime
 * assistant has a bot of its own (ADR-048). A second noun for the same thing is how two documents come to
 * describe two different things.
 *
 * Matched as a whole word, so "Seattle" passes. Applied migrations under `analytics-aurora/schema/` are
 * outside the scan: they are applied once and their text is a record, not a description.
 */
const RETIRED_WORD = /\b(re-?)?seat(s|ed|ing|ings)?\b/i;
const VOCABULARY_ROOTS = [...SCAN_ROOTS, 'frontend/packages/admin/src', 'frontend/packages/chat/src', 'frontend/packages/shared/src'];
const VOCABULARY_EXTENSIONS = new Set(['.md', '.ts', '.tsx', '.mjs']);

describe('retired vocabulary', () => {
  const collected: string[] = [];
  const visit = (abs: string): void => {
    if (!fs.existsSync(abs)) return;
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      if (VOCABULARY_EXTENSIONS.has(path.extname(abs)) && !abs.endsWith('.d.ts')) collected.push(abs);
      return;
    }
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (['node_modules', 'cdk.out', 'dist', 'schema'].includes(entry.name)) continue;
      visit(path.join(abs, entry.name));
    }
  };
  for (const root of VOCABULARY_ROOTS) visit(path.join(REPO_ROOT, root));
  const files = excludeIgnored(collected, REPO_ROOT);
  const thisFile = path.resolve(__filename);

  it('the detector fires on the word and passes a city', () => {
    expect(RETIRED_WORD.test('the alt seat')).toBe(true);
    expect(RETIRED_WORD.test('a classification seats nothing')).toBe(true);
    expect(RETIRED_WORD.test('re-seating the alt')).toBe(true);
    expect(RETIRED_WORD.test('round-trip from Seattle')).toBe(false);
    expect(files.length).toBeGreaterThan(50);
  });

  it('no shipped file calls an assistant a seat', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (path.resolve(file) === thisFile) continue;
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      fs.readFileSync(file, 'utf-8').split(/\r?\n/).forEach((line, i) => {
        if (RETIRED_WORD.test(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });

  /**
   * RETIRED VOCABULARY: "SLOT", for the same reason as "seat". A battle's
   * challenger is the assistant `alt-{role}-{classification}`, named by its id (`challengerAssistant`), and
   * an assistant's IAM identity is its acting role; "slot" named a numbered position in a pool that no longer
   * exists. Other meanings of the word in this tree were renamed to what they are (a notice claim, reserved
   * concurrency, a field), so the word is reserved for the two meanings that are not ours to rename.
   *
   * Matched anywhere in a line, case-insensitively, so an identifier (`altSlotArn`, `slotId`) is caught as
   * well as prose. A line passes when, after removing these, no "slot" remains:
   *   - AMAZON LEX SLOTS: an IAM action (`lex:CreateSlotType`), a slot type, the `"slots"` key of a Lex
   *     event, or "Lex slot";
   *   - CALENDAR AND TIME SLOTS: "time slot" and its kin, the `find_meeting_slot` tool, any line about a
   *     meeting, a calendar, attendees, booking or scheduling, and PostgreSQL's "connection slots" error;
   *   - PERSISTED NAMES, kept because renaming them in code would stop old data being read: the DynamoDB
   *     attributes `altBotSlotId` and `altBotSlotArn` on battle rows of the earlier shape, which the readers
   *     still accept, and the names of the Battle stack's former bots and roster (`AltSlot*`, `alt-bot-slots`),
   *     which the records of their measurement quote.
   */
  const SLOT = /slot/i;
  const SLOT_ALLOWED_TOKENS: RegExp[] = [
    /\blex:\w+/gi,
    /\bslot ?types?\b/gi,
    /"slots"/g,
    /\b(?:amazon )?lex(?: v2)? slots?\b/gi,
    /\b(?:time|calendar|meeting|scheduling|booking|free) ?slots?\b/gi,
    /\bfind_meeting_slot\b/g,
    /\bconnection slots\b/gi,
    /\baltBotSlot(?:Id|Arn|Count)\b/g,
    /\bAltSlot[\w-]*/g,
    /\balt-bot-slots\b/g,
  ];
  const CALENDAR_LINE = /\b(?:calendar|meetings?|attendees?|book(?:s|ed|ing)?|schedul\w*)\b/i;
  const slotForAnAssistant = (line: string): boolean => {
    if (!SLOT.test(line) || CALENDAR_LINE.test(line)) return false;
    return SLOT.test(SLOT_ALLOWED_TOKENS.reduce((rest, token) => rest.replace(token, ''), line));
  };

  it('the slot detector fires on an assistant and passes Amazon Lex, calendar time and persisted names', () => {
    expect(slotForAnAssistant('binds the treatment to an alt slot')).toBe(true);
    expect(slotForAnAssistant('const altSlotArn = row.botArn;')).toBe(true);
    expect(slotForAnAssistant('each role gets its own IAM slots')).toBe(true);
    expect(slotForAnAssistant("altBotSlotId: 'slot-0',")).toBe(true);
    expect(slotForAnAssistant("'lex:CreateBot', 'lex:CreateSlotType',")).toBe(false);
    expect(slotForAnAssistant('{ "intent": { "name": "FallbackIntent", "slots": {} } }')).toBe(false);
    expect(slotForAnAssistant('If the slot went between the proposal and the apply, the meeting is not created')).toBe(false);
    expect(slotForAnAssistant('return config?.challengerBotArn || config?.altBotSlotArn || undefined;')).toBe(false);
    expect(slotForAnAssistant('every AppInstanceBot named `Alt-*` or `AltSlot*`')).toBe(false);
  });

  it('no shipped file calls an assistant a slot', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (path.resolve(file) === thisFile) continue;
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      fs.readFileSync(file, 'utf-8').split(/\r?\n/).forEach((line, i) => {
        if (slotForAnAssistant(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });

  /**
   * RETIRED VOCABULARY: "CEILING", "RUNG", "OVER-TIER", "UNDER-CLEARED" (ADR-046). A classification is access to
   * that one classification, and each declares the set it grants; nothing sits above or below another.
   * "Ceiling" is vertical, so it read as a ladder wherever it appeared, whatever the code meant: an
   * issuer declares the `classifications` it may grant, a permissions boundary is a boundary, a caller's
   * admin read has a scope, and a rate, spend or retention bound is a limit. A member who is not cleared
   * for a conversation's classification is uncleared, not over or under anything. A "rung" is a step
   * on a ladder: a person is vended on a classification's role, and an evaluation runs checks.
   *
   * `ceiling` is matched anywhere in a line, case-insensitively, so an identifier (`CeilingNoBot...`) is
   * caught as well as prose; the others as whole words, so `runGuardrail` is not a rung.
   */
  const LADDER_WORD = /ceiling|\brungs?\b|\bover-tier\b|\bunder-cleared\b|\bover-classification\b/i;

  it('the ladder detector fires on each retired word and passes the words that replaced them', () => {
    expect(LADDER_WORD.test('the issuer\'s ceiling')).toBe(true);
    expect(LADDER_WORD.test("sid: 'CeilingNoBotOutsideThisClassification'")).toBe(true);
    expect(LADDER_WORD.test('flags an over-tier member')).toBe(true);
    expect(LADDER_WORD.test('an under-cleared member')).toBe(true);
    expect(LADDER_WORD.test('vended on the restricted rung')).toBe(true);
    expect(LADDER_WORD.test('Rungs of the evaluation')).toBe(true);
    expect(LADDER_WORD.test('runGuardrail is strung across call sites')).toBe(false);
    expect(LADDER_WORD.test('the classifications this issuer may grant, within its boundary and its rate limit')).toBe(false);
  });

  it('no shipped file uses ladder vocabulary for a classification', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (path.resolve(file) === thisFile) continue;
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      fs.readFileSync(file, 'utf-8').split(/\r?\n/).forEach((line, i) => {
        if (LADDER_WORD.test(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });

  /**
   * RETIRED VOCABULARY: "ADMIN AGENT". What a person reads calls the admin plane's assistant the Admin Assistant
   * (a name) or the admin assistant (running prose). Prose only: matched with a space, so the identifiers that keep
   * the old spelling (`admin-agent`, `ADMIN_AGENT_BOT_ARN`, `adminAgentOf`, DESIGN-ADMIN-AGENT-NOTIFICATIONS) pass.
   *
   * A SHRINKING LIST: the e2e files below still carry the phrase in comments and assertion messages, and leave this
   * list as each is reworded. A file not on it is held to the rule.
   */
  const ADMIN_AGENT_PROSE = /\badmin\s+agents?\b/i;
  const ADMIN_AGENT_PENDING = new Set([
    'tests/e2e/an-operator-notice-is-worded-by-the-admin-agent.spec.ts',
    'tests/e2e/helpers/template-pointer.ts',
    'tests/e2e/notification-bridge.spec.ts',
  ]);

  /**
   * A ROUTE IS KEYED BY THE INTENT IT SERVES (ADR-064 decision 1). The retired route keys appear only where they are
   * refused or recorded: the refusal table in `model-resolver.ts`, the ADR, and a line that says the key is retired.
   */
  const RETIRED_ROUTE_KEY = /\b(general_qa|workflow_actions|document_extraction)\b/;
  const RETIRED_ROUTE_KEY_HOMES = new Set([
    'backend/lambda/src/lib/model-resolver.ts',
    'docs/design/decisions/064-a-turn-takes-its-model-from-the-intent-and-the-step-it-runs.md',
  ]);

  it('the retired-route-key detector fires on each key and passes the intent keys', () => {
    for (const k of ['general_qa', 'workflow_actions', 'document_extraction']) expect(RETIRED_ROUTE_KEY.test(`byIntent.${k}`)).toBe(true);
    for (const k of ['general', 'guided_troubleshooting', 'data_extraction']) expect(RETIRED_ROUTE_KEY.test(`byIntent.${k}`)).toBe(false);
  });

  it('no shipped file names a retired route key except to refuse it', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (path.resolve(file) === thisFile) continue;
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      if (RETIRED_ROUTE_KEY_HOMES.has(rel)) continue;
      fs.readFileSync(file, 'utf-8').split(/\r?\n/).forEach((line, i) => {
        if (RETIRED_ROUTE_KEY.test(line) && !/retired/i.test(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });

  it('the admin-agent detector fires on prose and passes the identifiers', () => {
    expect(ADMIN_AGENT_PROSE.test('posted as the admin agent')).toBe(true);
    expect(ADMIN_AGENT_PROSE.test('THE ADMIN AGENT OWNS IT')).toBe(true);
    expect(ADMIN_AGENT_PROSE.test("{ name: 'admin-agent', displayName: 'Admin Assistant' }")).toBe(false);
    expect(ADMIN_AGENT_PROSE.test('process.env.ADMIN_AGENT_BOT_ARN')).toBe(false);
    expect(ADMIN_AGENT_PROSE.test('DESIGN-ADMIN-AGENT-NOTIFICATIONS.md')).toBe(false);
  });

  it('no shipped file calls the admin assistant an admin agent', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (path.resolve(file) === thisFile) continue;
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      if (ADMIN_AGENT_PENDING.has(rel)) continue;
      fs.readFileSync(file, 'utf-8').split(/\r?\n/).forEach((line, i) => {
        if (ADMIN_AGENT_PROSE.test(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });
});

/**
 * ONE WORD FOR ONE THING: A BATTLE, NEVER A DUEL. The product's word is battle (`/battle`, Battle Mode): an
 * experiment may run battles, and a battle is one run in a conversation in which someone gets both versions'
 * answers over a few turns and picks the better one. "Duel" named the same run a second way, and a reader
 * meeting both took them for two things.
 *
 * WHAT A PERSON READS is held to it: every string in the locale files, the reply templates the assistants
 * send, the README, the admin and user guides, and the specs and designs the console and the guides cite.
 * The developer record (ADRs, other designs, code comments) is not in scope here.
 *
 * CODE IDENTIFIERS PASS, because renaming stored fields and APIs would stop old data being read: anything in a
 * backtick code span, and any word that joins "duel" to other letters (`duelRound`, `DUEL_ROLE`,
 * `a-duel-is-found-from-every-carrier.test.ts`). What fails is the word on its own.
 */
const DUEL_WORD = /(?<![\w-])duels?(?![\w-])/i;
const withoutCode = (line: string): string => line.replace(/`[^`]*`/g, '');
const saysDuel = (line: string): boolean => DUEL_WORD.test(withoutCode(line));

const BATTLE_WORD_DOCS = [
  'README.md',
  'docs/guides/admin',
  'docs/guides/user',
  'docs/specs/interface/SPEC-ADMIN-CONSOLE.md',
  'docs/specs/interaction/quality/DESIGN-BATTLE.md',
  'docs/specs/interaction/quality/SPEC-BATTLE.md',
  'docs/specs/interaction/quality/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md',
];
const LOCALE_DIR = 'frontend/packages/shared/src/locales';
const REPLY_TEMPLATES = 'backend/lambda/src/lib/shipped-message-templates.ts';

describe('battle, not duel, in what a person reads', () => {
  const docs: string[] = [];
  const visitDocs = (abs: string): void => {
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isFile()) {
      if (abs.endsWith('.md')) docs.push(abs);
      return;
    }
    for (const entry of fs.readdirSync(abs)) visitDocs(path.join(abs, entry));
  };
  for (const root of BATTLE_WORD_DOCS) visitDocs(path.join(REPO_ROOT, root));
  const docFiles = excludeIgnored(docs, REPO_ROOT);

  /** Every string value of a locale file, with the key path it sits at. Keys are code, so they are not read. */
  const localeStrings = (): Array<{ at: string; text: string }> => {
    const out: Array<{ at: string; text: string }> = [];
    const walk = (node: unknown, at: string): void => {
      if (typeof node === 'string') out.push({ at, text: node });
      else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, at ? `${at}.${k}` : k);
    };
    const dir = path.join(REPO_ROOT, LOCALE_DIR);
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      walk(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')), f);
    }
    return out;
  };

  it('the detector fires on the word and passes code identifiers', () => {
    expect(saysDuel('Each duel is one run.')).toBe(true);
    expect(saysDuel('## Duels')).toBe(true);
    expect(saysDuel("the duel's challenger")).toBe(true);
    expect(saysDuel('the round is read from `duelRound`')).toBe(false);
    expect(saysDuel('const side = duelSideName(experiment, id);')).toBe(false);
    expect(saysDuel('DUEL_ROLE names the alt')).toBe(false);
    expect(saysDuel('see a-duel-is-found-from-every-carrier.test.ts')).toBe(false);
    expect(docFiles.length).toBeGreaterThan(10);
    expect(localeStrings().length).toBeGreaterThan(1000);
  });

  it('no locale string says duel', () => {
    expect(localeStrings().filter((s) => saysDuel(s.text)).map((s) => `${s.at}: ${s.text}`)).toEqual([]);
  });

  it('no reply template says duel', () => {
    const lines = fs.readFileSync(path.join(REPO_ROOT, REPLY_TEMPLATES), 'utf-8').split(/\r?\n/);
    const violations = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /\btext:/.test(line) && saysDuel(line))
      .map(({ line, i }) => `${REPLY_TEMPLATES}:${i + 1}: ${line.trim()}`);
    expect(violations).toEqual([]);
  });

  it('no user-facing document says duel', () => {
    const violations: string[] = [];
    for (const file of docFiles) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      let fenced = false;
      fs.readFileSync(file, 'utf-8').split(/\r?\n/).forEach((line, i) => {
        if (/^\s*```/.test(line)) { fenced = !fenced; return; }
        if (!fenced && saysDuel(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
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
 * have, and what was actually deployed was a request-rate limit and no spend limit at all.
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
  'docs/specs/demos/SPEC-DEMO-COMPANY.md',
  // SPEC-BATTLE.md and DESIGN-BATTLE.md left this set on 2026-09-26 by earning it: both now carry a
  // Verified by line naming the turn, outcome and orchestrator tests, and the spec was demoted to
  // Partial because three of its rows are partly delivered. Nothing left to grandfather.
  // SPEC-COST-SLEEP-MODE.md left this set on 2026-09-26, by being demoted rather than by earning a
  // test. It claimed `Implemented`; the requirements pass found the activity stamp is written by
  // archival rather than by user traffic, that three scheduled jobs touch Aurora and not four, and
  // that no synthesis test asserts the stack at all. `Partial` is what it is, so the grandfather
  // entry has nothing left to grandfather.
  // SPEC-CHAT-APP.md left this set on 2026-09-11: the ADR-034 addressing entries it gained cite the
  // tests that cover them, so the document now ties its claims to something that can fail.
  // THIS SET IS KEYED ON THE PATH, which makes it fragile in a way worth knowing about: on 2026-09-22
  // this directory was moved and then moved back, and while it sat elsewhere the entry stopped
  // matching, so the gate reported a document nobody had touched. Nothing was wrong with the document.
  // Any future reorganization does the same, and the fix is to re-path the entry rather than to add a
  // "Verified by:" line the document has not earned.
  'docs/specs/interface/DESIGN-CHAT-APP.md',
  // SPEC-NOTIFICATION-BRIDGE.md and SPEC-CONVERSATION-ARCHIVE-AND-MEMBERSHIP.md left this set on
  // 2026-09-26, both by demotion. The bridge claimed Implemented while its own table carried the
  // inbound rows as not delivered and its Status line said 'Planned' in prose; the archive spec
  // described a Leave control that no client component renders. Both are Partial now, so there is
  // nothing left to grandfather.
  'docs/specs/interaction/conversation/CROSS-CHANNEL-TASKS.md',
  'docs/specs/interaction/governance/SPEC-ADMIN-IDENTITY.md',
  // SPEC-CREDENTIAL-EXCHANGE.md and IDENTITY-AND-ACCESS-MODEL.md left this set by demotion: both now
  // state the person-identity contract (one opaque AppInstanceUser per person, the issuer registry and
  // the Identities index) with its unbuilt parts marked, so `Partial` is what they are.
  'docs/specs/interaction/governance/ACCESS-CONTROL-BY-EXAMPLE.md',
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

/**
 * EVERY STORE IS IN THE ERASURE INVENTORY, OR SAYS WHY IT NAMES NOBODY.
 *
 * SPEC-CREDENTIAL-EXCHANGE §5b is the inventory offboarding erases from and the retention record a derived
 * copy declares its expiry in (tenet D7). An inventory is only as good as its coverage: a table added beside
 * it with a person in its key is a store offboarding never reaches, and nothing else would notice. So every
 * DynamoDB table and S3 bucket the CDK app constructs is named in §5b by its construct id, or is listed
 * below with the reason it holds no person's record. A new store fails here until somebody decides which.
 */
const STORE_ROOTS = ['backend/lib/stacks', 'backend/lib/constructs'];
const STORE_RE = /new (?:s3\.Bucket|dynamodb\.Table|dynamodb\.TableV2)\(this, '([A-Za-z0-9]+)'/g;
/** A construct's generic id (`Bucket`) is named by the construct that wraps it. */
const STORE_ALIASES: Record<string, string> = {
  'conversation-archive.ts:Bucket': 'ConversationArchive',
};
/** Stores that hold no person's record, each with why. Adding one is a decision a reviewer reads. */
const NAMES_NO_PERSON: Record<string, string> = {
  'frontend-distribution.ts:Bucket': 'a web app\'s static build, the same for every visitor',
  'test-inbox-stack.ts:Bucket': 'the opt-in test inbox (TestInbox): mail sent to the e2e test users only',
  DeploymentStateTable: 'the deployment\'s sleep and wake state, one row per deployment',
  TurnRoutingTable: 'a turn\'s routing record keyed by correlation id, naming assistants and the conversation',
  BattleStateTable: 'a duel\'s state per side, keyed by battle and assistant',
  ConnectorReplayTable: 'a vendor event id seen once, for replay refusal; the event body is not kept',
};

describe('every store is in the erasure inventory (SPEC-CREDENTIAL-EXCHANGE §5b)', () => {
  const spec = fs.readFileSync(path.join(REPO_ROOT, 'docs/specs/interaction/governance/SPEC-CREDENTIAL-EXCHANGE.md'), 'utf-8');
  const start = spec.search(/^#+ .*5b\b/m);
  const rest = start >= 0 ? spec.slice(start) : '';
  // The section runs from its heading to the next heading of level 1 to 3 (its own is level 3).
  const firstLine = rest.indexOf('\n');
  const nextHeading = firstLine >= 0 ? rest.slice(firstLine).search(/^#{1,3} /m) : -1;
  const inventory = nextHeading >= 0 ? rest.slice(0, firstLine + nextHeading) : rest;

  const stores: Array<{ key: string; at: string }> = [];
  const walkStores = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walkStores(abs); continue; }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) continue;
      const src = fs.readFileSync(abs, 'utf-8');
      for (const m of src.matchAll(STORE_RE)) {
        const local = `${e.name}:${m[1]}`;
        const key = STORE_ALIASES[local] ?? (m[1] === 'Bucket' ? local : m[1]);
        stores.push({ key, at: path.relative(REPO_ROOT, abs).split(path.sep).join('/') });
      }
    }
  };
  for (const root of STORE_ROOTS) walkStores(path.join(REPO_ROOT, root));

  it('finds the inventory and a realistic number of stores (the check is wired to the tree)', () => {
    expect(inventory.length).toBeGreaterThan(500);
    expect(stores.length).toBeGreaterThan(15);
  });

  it('names every store by its construct id, or records why it names nobody', () => {
    const missing = stores
      .filter(({ key }) => !NAMES_NO_PERSON[key] && !inventory.includes('`' + key + '`'))
      .map(({ key, at }) => `${key} (${at})`);
    expect(missing).toEqual([]);
  });

  it('keeps no reason for a store that no longer exists', () => {
    const keys = new Set(stores.map((s) => s.key));
    expect(Object.keys(NAMES_NO_PERSON).filter((k) => !keys.has(k))).toEqual([]);
  });
});
