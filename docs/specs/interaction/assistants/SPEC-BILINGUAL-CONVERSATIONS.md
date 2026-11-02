# SPEC: Bilingual conversations (reply-language, pivot, dual delivery)

**Status:** Partial (reply-language ships; the deployment's closed language map, a person's own language and messages said in the reader's language are built and not deployed; the inference pivot and dual delivery are design).

**Coverage:** `tests/e2e/bilingual-conversations.spec.ts` - covers the shipped half. It drives the opposite case to the obvious one: the user writes in ENGLISH in a conversation configured `userLanguage=zh` and must still be answered in Chinese, which is what meeting the assistant in your own language means and rules out the model simply mirroring the language it was addressed in. The assertion counts Han characters rather than judging prose, so it is objective: it asserts a Han-character majority with `zh` and none with `en`. `tests/e2e/a-person-who-joins-is-welcomed-once-in-their-language.spec.ts` (phase `welcome-workflows`) sets a person's language through `POST /me/language` and asserts that a workflow send addressed to them is the written variant in that language (ADR-062 decision 4). Verified on dev 2026-10-29, 3/3 passed (`node scripts/validate.mjs --only=welcome-workflows`). `tests/e2e/a-welcome-is-said-in-the-assistants-voice.spec.ts` (same phase) covers the `voice` fill: a targeted workflow welcome written only in the deployment's language, sent to a person who chose another declared language, is said by the model in that language, carries `voiceFill` with `outcome: voice`, and adds no link or handle; a render held to a one-millisecond deadline posts the written text with `outcome: fallback:deadline`. Verified on dev 2026-10-29, 2/2 passed (`node scripts/validate.mjs --only=welcome-workflows --spec=a-welcome-is-said-in-the-assistants-voice`).

**Verified by:** `backend/test/lib/context-framework.test.ts` (a non-English language preference surfaces a reply-language instruction in the assembled prompt), `backend/test/lib/host-grounding.test.ts` (the routing signals come from the server-only store, and a member-writable metadata value is ignored even when the store row is missing entirely - a deny-test against a member steering model selection), `backend/test/lib/a-message-reaches-a-person-in-their-language.test.ts` (the closed map, the language order, written variants, plurals per language and the bounded `voice` render) and `backend/test/a-person-sets-their-own-language.test.ts` (a person's language is set only by them, among the declared languages - a deny-test on the setting's role).

**Related:** [SPEC-CONTEXT-AWARE-MODEL-ROUTING.md](./SPEC-CONTEXT-AWARE-MODEL-ROUTING.md) - the routing half of the same problem, which reads this language signal. [SPEC-WELCOME-AND-CONTEXT.md](./SPEC-WELCOME-AND-CONTEXT.md) - the grounding path the language preference rides.

**Site section:** Interaction layer, assistants.

---

## Overview

**Three languages are in play on every turn and the platform holds none of them constant: the deployment's, the person's, and the model's working language** (tenet D11). A person's language preference is a per-person, per-turn value, never a fixed string a decision depends on, and the assistant honors it on three escalating levels:

1. **Reply in the person's language** - answer in their chosen language whichever model serves the turn.
2. **Pivot to the model's working language for inference** - where the resolved model reasons better in another language, translate in, infer, translate back.
3. **Deliver both languages** - the original with the person's-language version beneath it, opt-in.

**The point is not translation for its own sake; it is that language becomes a routing signal in an already multi-model router.** That buys two things a single-model assistant cannot have. The assistant meets the person end to end in their own language - greeting, reasoning, reply - so the experience reads as native rather than bolted on, and language sits alongside the other per-person signals the assistant is already grounded in. And a deployment can route a locale to the model strongest in it, using the pivot to keep a cross-language turn inside each model's strongest language instead of forcing one model to work outside it. The person's language and the model's working language are independent variables the router can optimize together, and the catalog now carries a model whose working language is not English, so that is a live pairing rather than a hypothetical one.

**The language preference is a routing signal, so it is held where a member cannot write it.** It lives in the server-only channel-context store and is read from there by the grounding assembler, never from channel metadata - which every member can write with the same capability the conversation-rename control holds. That is not a tidiness preference: the same value selects the reply language and, where context routing is enabled, the model, so a member able to override it could choose which model serves their own conversation. The end-to-end test drives exactly that: it writes a conflicting value into member-writable metadata and requires the reply to follow the store.

**The language name reaching the prompt comes from a closed map, never from the stored tag.** The deployment declares the languages it speaks (`languages` in `deploy.config.json`, `backend/lib/config/languages.ts`), each a tag the platform's catalog names; a tag outside that list falls through to a generic phrasing that carries no part of it, so a crafted preference value cannot inject prompt text. The same list is the closed value set of the language signals a condition decides on, and of the language a person may choose for themselves.

**What the platform says, and not only what the model answers, follows the reader's language** ([ADR-062](../../../design/decisions/062-a-message-is-a-template-stored-and-versioned-like-a-document.md) decision 4). A message template carries a written variant per language; a message one person reads is said in their own preferred language, then the conversation's, then the deployment's, and a message the room reads in the conversation's. Where no variant is written, a template whose call site may wait on a model is said in the assistant's voice by one bounded model call, and every other is said as written.

**Translation stays inside one provider posture.** It is a model call routed through the existing catalog and resilience layer rather than a second translation service, so it inherits the classification's model allow-list, the retry and fallback behavior, and the guardrails. The reply-language instruction remains as a backstop, so the assistant answers in-language even when the pivot is skipped.

## Business Problem

A person who has set a language for the whole product expects the assistant inside it to speak that language, and a business serving several locales wants each one answered by the model strongest in it. What is on offer instead is a monolingual assistant with a translation layer bolted on the outside: the reply arrives in the right language and reads like a translation, the model reasoned in a language it was weakest in, and the business has no way to route a locale to a better model because language never became a signal the router could see. Bolting on a translation service also doubles the provider posture a security review has to cover, and it puts the person's words through a step that nothing holds to the same guardrail as the conversation. This spec makes the language preference a first-class per-person signal carried on the path the grounding already uses.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Three of them meet this, and they meet it at three levels: the end user experiences it, the AI developer routes on it, and the admin / operator pays for it.

### AI developer

**How this relates to them:** language is the signal that lets them pair a locale with the model that serves it best, and the pivot is what keeps a cross-language turn inside each model's strongest language. Their concern is that it is a signal rather than a post-processing step.

| What they need | Requirement |
|---|---|
| A per-person language preference the prompt builder honors for every assistant, with no per-classification duplication | FR1 |
| That preference held where a member cannot overwrite it, because it selects the model too | FR2 |
| A working language on each catalog entry, so a locale can be paired with a model | FR4 |
| A pivot that costs nothing when the two languages already match | FR5 |
| Translation routed through the existing catalog and resilience layer rather than a second provider | FR6 |
| A guardrail on the translation hop, so the pivot is not a bypass | FR7 |

### End user

**How this relates to them:** they set one preference in the product and expect everything inside it to follow, including the parts they cannot see. What they should never experience is a reply that mirrors whichever language they happened to type in.

| What they need | Requirement |
|---|---|
| A reply in their own language whichever model served it, and whichever language they wrote in | FR1 |
| A greeting that arrives instantly and still in their language | FR8 |
| A conversation that never blocks because a language could not be resolved | FR3 |
| Optionally, the original beside the version in their language, for trust | FR9 |
| A long reply that arrives whole rather than truncated by an encoding budget | FR10 |
| A language of their own for what is addressed to them, set once in the product, never inferred from what they typed | FR14 |
| A notice, a welcome step and a workflow message in their language, not only the model's answer | FR15 |

### Admin / operator

**How this relates to them:** a pivot is a second model call and dual delivery is a second message, so both are costs they carry. Their requirement is that the default path costs nothing extra and that what the translation layer spends is visible where they already read spend.

| What they need | Requirement |
|---|---|
| A default path with no added model call and no doubled message | FR5, FR9 |
| Translation cost and translation health in the analytics they already read | FR11 |
| A conversation created before the signal moved that degrades to the default rather than failing | FR12 |
| The languages the deployment speaks declared once, so every reader holds the same closed set | FR3 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable. `Gap - prioritize` marks a table-stakes capability that is not delivered.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | A non-English language preference produces a reply-language instruction in the shared prompt builder, so every assistant honors it with no per-classification duplication | Table stakes | Yes | `context-framework` (unit, behavior), `bilingual-conversations` (e2e, behavior) |
| FR2 | The language preference is read from the server-only store and never from member-writable channel metadata, because the same value selects the model | Table stakes | Yes | `host-grounding` (unit, behavior) - **deny-test:** a routing signal in metadata is ignored, and is still ignored when the store row is missing; `bilingual-conversations` (e2e, behavior) - **deny-test:** a conflicting metadata value written with the rename capability does not change the reply |
| FR3 | The language name in the prompt comes from a closed map, the languages the deployment declares (`lib/config/languages.ts`): an unknown or absent preference falls through to a generic phrasing and never blocks the turn, and the tag is never interpolated raw | Table stakes | Yes | `context-framework` (unit, behavior), `a-message-reaches-a-person-in-their-language` (unit, behavior: a crafted tag carries no part of itself into the prompt) |
| FR4 | Every catalog entry declares the language it works best in, so a locale can be paired with a model rather than guessed at | Enabler | Yes | none |
| FR5 | Where the person's language and the model's working language differ, the turn translates in, infers, and translates back; where they match, no translation call is made | Gap - prioritize | No | none |
| FR6 | Translation is a model call through the existing catalog and resilience layer, so it inherits the classification boundary, the retry and fallback behavior, and needs no second provider | Gap - prioritize | No | none |
| FR7 | The translation hop treats the person's text as data rather than instructions, and the guardrail applies to the translation call and to the translated output | Gap - prioritize | No | none |
| FR8 | The greeting is instant and per-language, from stored copy rather than a runtime translation call | Table stakes | Partly - the greeting is composed without a model call, and a workflow welcome's sends are message templates said from the written variant in the reader's language; a structured welcome's opening text is one deployment-authored field per version. **NOT BUILT:** language variants for a welcome's opening step, because its text (`opening.text`) is a field of the version's welcome workflow and not a message template, so it has no variants; a welcome's sends do ([ADR-062](../../../design/decisions/062-a-message-is-a-template-stored-and-versioned-like-a-document.md)) | `a-message-reaches-a-person-in-their-language` (unit, behavior: a workflow's opening refuses a `voice` template) |
| FR9 | Dual delivery is opt-in and, when on, sends the second language as a linked sibling message rather than as concatenated content, with the original always preserved | Above bar - optional | No | none |
| FR10 | A reply in a language that encodes expensively is chunked against the encoded length rather than the character count, and a long deliverable rides the attachment path | Table stakes | Yes | none |
| FR11 | Translation cost and translation health reach the analytics the model layer already emits, with no new pipeline | Enabler | No | none |
| FR12 | A conversation created before the signal moved to the server-only store degrades to the deployment default rather than reading a member-writable value, and each such turn is reported | Table stakes | Yes | `host-grounding` (unit, behavior) |
| FR13 | The non-federated conversation-creation path accepts and persists the language preference, so reply-language does not depend on the federated handler | Gap - prioritize | No | none |
| FR14 | A person chooses their own language among the languages the deployment declares, stored with their reply preferences and read as `person:preferredLanguage`: a closed enum about the person, so it decides and is inserted only where that one person reads the message | Table stakes | Yes, built and not deployed | `a-message-reaches-a-person-in-their-language` (unit, behavior), `a-person-sets-their-own-language` (synth, **deny-test**: the setting's role reads and writes only a profile row's preferences), `LanguagePreference.test.tsx` (component, behavior) |
| FR15 | A message template is said in its reader's language: a written variant per language, chosen in the order person, conversation, deployment, template; plural forms by `Intl.PluralRules` per language; and, where no variant is written and the call site may wait, the assistant's voice by one bounded, metered model call that falls back to the written text | Differentiator | Yes, built and not deployed. **NOT BUILT:** a `voice` render at task assignment and in the briefing, which ADR-062 decision 4 names, because neither call site hands a render to the processor (`voice` is wired for a workflow's targeted sends only); a `voice` send at an invitation's event naming `invitation:reason`, because the processor's voice render resolves no event value; and the language of the notification bridge's wrapper and of the stand-alone emails (the invitation, the claim, the briefing and the preference page), which are said in their template's own language because the Notifications functions read neither the channel-context row nor the person's profile row, each a read grant with its deny test to add | `a-message-reaches-a-person-in-their-language` (unit, behavior: each step of the order, Polish, Arabic and Japanese plurals, each fallback of the voice render) |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/`, with the shared-library ones under `backend/test/lib/`; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists.

**A row marked deny-test carries the strongest evidence this document has.** FR2 is the row the design rests on, and it is the one with a deny-test on both the unit and the end-to-end side: a member-writable value is proven not to steer the reply, rather than reviewed as though it could not.

**Known limits on the delivered rows.** FR3's map held two languages and interpolated any other tag raw until the deployment's declared list replaced it (ADR-062 slice 3); the row now says what the code does. FR15's emails carry the posted line in the language it was said in, but an email's wrapper and the stand-alone emails (an invitation, a claim, a briefing, the preference page) are in their template's own language: the notification bridge reads neither the conversation's language nor a recipient's preference (ADR-062, "What is not built"). FR1's exercised chain is production code end to end - the store, the grounding assembler, the dispatch event, the prompt instruction - and only the stored value itself is arranged by the test, because the host path that normally writes it is gated on a federated pool a non-federated deployment does not configure. FR4's field is required on every catalog entry and asserted nowhere. FR10's encoding-aware chunking is the existing message-delivery machinery rather than anything this spec adds, and nothing exercises it with a CJK payload.

**OPEN:** whether the pivot should be one hop or two. A one-hop variant translates the person's message in and relies on the reply-language instruction to bring the answer back; a two-hop variant translates the answer back explicitly. The one-hop variant is cheaper and the two-hop variant is the one that makes the guardrail's coverage of translated output meaningful.

**OPEN:** what an operator sees when the pivot is skipped. FR5 skipping is the common case and the desirable one, so a rate that reads as zero is ambiguous between "the languages matched" and "the feature is off".

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| Translating the classification-scoped context documents | Those are authored once against a classification's prefix; per-language context is a separate concern with its own storage and review | [SPEC-WELCOME-AND-CONTEXT.md](./SPEC-WELCOME-AND-CONTEXT.md) - the grounding sources |
| Integrating a dedicated translation service | Translation routes through the existing catalog and resilience layer instead. A model call at chat-message sizes is markedly cheaper per token, preserves tone, and keeps the pivot and the reply inside one provider posture a review already covers. A dedicated service stays available if latency ever forces it | FR6 |
| Translating the host application's own interface copy | The host owns its interface strings and their locale files. This spec is the conversation pipeline only | The host application's own locale system |
| Choosing the model from the language | Language is a signal the resolver reads, and it is one input among several. Selecting the model is the routing spec's decision | [SPEC-CONTEXT-AWARE-MODEL-ROUTING.md](./SPEC-CONTEXT-AWARE-MODEL-ROUTING.md) |
| Holding the language preference in channel metadata | Metadata is member-writable with the same capability the rename control holds, and this value selects the model | FR2, and [METADATA-AND-TAGS.md](../../../guides/developer/METADATA-AND-TAGS.md) - what belongs where |
| Deciding anything by recognizing a phrase in what a person wrote | A language judgement wearing a pattern match is wrong in every language nobody tested. Where something must be understood, the model resolves it once and records it as data | [TENETS.md](../../../overview/TENETS.md) - tenet D11 |
| A per-reader lazy translation cache | Dual delivery materializes the translation as a real sibling message, so re-reads read it rather than re-translating. A cache would only matter for translating per reader at read time, which this design avoids | FR9 |
| Re-deriving a language preference from what the person typed | The preference is theirs to set, and inferring it from one message means the assistant switches language on a single quoted sentence | FR1 |

## User Experience Description and Mocks

**The person sets one preference in the host application and never touches this again.** What they experience:

1. **The assistant answers in their language from the first turn**, including the greeting, and including when they themselves write in another language. That last case is the one the end-to-end test drives, because a reply that mirrors the language it was addressed in is the failure that looks like success (FR1).
2. **Nothing blocks when the language cannot be resolved.** An absent or unrecognized preference falls through to a generic phrasing and the turn proceeds (FR3).
3. **A long reply in a language that encodes expensively still arrives whole**, chunked against the encoded length and linked as continuation parts, with a long deliverable offered as an attachment behind a short inline lede (FR10).
4. **Optionally, both languages side by side.** Where a deployment turns dual delivery on, the original sits above the version in the person's language, and the second line is dropped where it would repeat the first (FR9).

**The AI developer's side is configuration rather than a screen:** pair a locale with the catalog entry whose working language matches it, and leave the reply-language instruction as the backstop for every turn the pivot skips.

**OPEN:** this document carries no mocks. The candidate is the dual-delivery rendering, because the grouping and the deduplication rule are the parts a reader has to see rather than read, and the renderer is the host's.

## Related Documents

- [SPEC-CONTEXT-AWARE-MODEL-ROUTING.md](./SPEC-CONTEXT-AWARE-MODEL-ROUTING.md) - the routing half: the signal set this preference is part of, and the resolver that reads it
- [SPEC-WELCOME-AND-CONTEXT.md](./SPEC-WELCOME-AND-CONTEXT.md) - the grounding path and the router-and-processor split this extends
- [SPEC-ASSISTANT-CONFIG.md](./SPEC-ASSISTANT-CONFIG.md) - the per-profile model selection a locale pairing sits inside
- [SPEC-PER-PROFILE-OWNERSHIP.md](./SPEC-PER-PROFILE-OWNERSHIP.md) - the shared processor that applies the reply-language instruction for every assistant
- [MESSAGE-DELIVERY-GUIDE.md](../../../guides/developer/MESSAGE-DELIVERY-GUIDE.md) - the size, encoding and chunking pattern FR10 reuses; read before extending any message
- [METADATA-AND-TAGS.md](../../../guides/developer/METADATA-AND-TAGS.md) - what belongs in member-writable metadata and what belongs in the server-only store
- [MODEL_STRATEGY.md](../../../guides/developer/MODEL_STRATEGY.md) - the catalog carrying each entry's working language
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above
- [TENETS.md](../../../overview/TENETS.md) - tenet D11, which this spec is the worked example of
- `backend/ARCHITECTURE.md` - the channel, router and processor flow the levels hook into

## Appendix A - The three levels and where each hooks in

### The message path

```
User -> Amazon Chime SDK channel -> Lex (AUTO) -> router handler (one fulfillment)
   - resolve the person's name, the conversation's tags, the person's classification
   - a welcome turn composes stored copy, with no model call
   - an ordinary turn classifies the intent and dispatches the shared processor
        -> the prompt builder emits the reply-language instruction
        -> the Converse tool loop
        -> the long-response handler
        -> back to the Amazon Chime SDK channel
```

| Level | Hook point |
|---|---|
| Reply language | The shared prompt builder, plus the grounding forward that carries the preference to it |
| Pivot | Around the Converse call: translate the inbound text into the model's working language, infer, translate the output back. Routed through the catalog and the resilience layer |
| Dual delivery | The send path: the second language goes as a linked sibling message sharing one response group, which the renderer groups |

### Level 1 - reply language

| Stage | Where |
|---|---|
| The host sends the preference in the create-conversation body | The host's session endpoint, into `POST /create-conversation` as a context request |
| The platform persists it to the server-only channel-context store | `backend/lambda/src/create-conversation-at-classification.ts` (a host's context conversation), deliberately not to channel metadata |
| The router forwards it from the store | `backend/lambda/src/lib/host-grounding.ts`, which reads it from the store and never from metadata |
| The shared prompt builder emits the instruction | `replyLanguageInstruction` in `backend/lambda/src/lib/async-processor-core.ts`, naming the language from the deployment's declared list (`backend/lib/config/languages.ts`), for a declared tag other than English only |

Two properties are worth calling out. The instruction lives in the shared prompt builder, so every assistant applies it with no per-classification duplication. And the tag is never interpolated raw: the language name comes from the closed map and an unknown tag falls through to a generic phrasing, so a crafted value cannot inject prompt text.

**A conversation created before the signal moved** has neither the language preference nor the geographic segment, because the router reads both only from the store, and it falls back to the deployment default language and model. Each such turn is reported rather than recovered by reading metadata; recovery is a one-shot operator run of `backend/scripts/backfill-channel-context.ts`, which promotes what metadata still carries after re-validating the tag shape. See [METADATA-AND-TAGS.md](../../../guides/developer/METADATA-AND-TAGS.md) section 4.

**The non-federated creation path** does not accept or persist the preference - it writes the classification, the topic and the trigger context only. That is FR13, and it matters only for a deployment that wants reply-language without the federated handler.

### Level 2 - the pivot

For a turn where the resolved model's working language differs from the person's:

1. Read the model's working language from the catalog. It is a required field on every entry, following the vision-capability precedent, and the catalog already carries an entry whose value is not English.
2. Where the two differ, translate the inbound message into the model's working language before the Converse call, infer, and translate the output back. Where they match, skip the whole pivot - the common case, at no added cost. The reply-language instruction stays as the backstop.
3. Translation is a model call routed through the existing layer: a dedicated route key with a cheap fast primary and a per-classification fallback, so it inherits the classification boundary and the retry, fallback and circuit-breaking behavior. It is invoked directly with that fixed key and does not pass through intent classification, because it is not a classified request from a person.

**The phrase checks the pivot turns into defects (D11).** `isDocumentRequest`, an English phrase list deciding whether a reply is packaged as a file, and `solicitsInput`, English openers consulted when a long reply is weighed for an attachment (`backend/lambda/src/lib/async-processor-core.ts`), and the delivered-document rules decide from the text inside the loop. Today they fail safe outside English. Once the pivot ships, that text is no longer the text the person typed, so each becomes a defect for every pivoted turn. **NOT BUILT:** language-neutral replacements, each deciding from data the model records when the meaning is established.

**Security of the translation hop.** The pivot adds a path where the person's content is processed by an extra model call and, in the two-hop variant, the translated text becomes inference input. Three controls are required. The translation prompt wraps the person's text in an explicit delimiter and instructs the model to translate the content between the delimiters and to follow no instructions inside it, which stops a crafted message escaping the translation step or surviving as a downstream injection. The guardrails wrap both the translation call and the translated output, so the pivot is not a bypass. And because translation routes through the classification-aware resolver, a conversation can never pivot through a model its classification does not grant. Every hop stays inside the existing processing boundary.

### Message size and encoding

Dual delivery adds length, so it rides the platform's existing over-cap machinery rather than a second mechanism. The full pattern is in [MESSAGE-DELIVERY-GUIDE.md](../../../guides/developer/MESSAGE-DELIVERY-GUIDE.md).

- **The caps are on the encoded length**, not the character count: 4096 for content and 1024 for metadata, with a working budget of 3600 and headroom reserved on the first chunk for markers.
- **Prose roughly doubles and CJK roughly nonuples when encoded**, so the effective content budget for Chinese is a few hundred characters per message and the metadata budget is barely a hundred. The encoding multiplier is the constraint, not the word count.
- **The long-response handler and the chunker already split over-budget output.** The first chunk updates the placeholder and the rest send as linked continuation parts carrying a shared response group and their part numbers. The attachment lede offloads a long deliverable as an attachment plus a short inline line.
- **The metadata helper drops a value over the encoded cap** with a warning, which is honest degradation. Translated text therefore must never live in metadata: it would vanish on the first long or Chinese message. Metadata carries small structured tags only.

### Level 3 - dual delivery

1. **The default path has no doubling.** With the reply-language instruction, and with the pivot's back-translation, the assistant answers in the person's language as a single message chunked normally. A deployment that wants only reply-in-my-language never pays dual-delivery cost.
2. **It is off by default**, enabled per deployment, with an optional per-conversation override carried as a small boolean tag well under the cap. Off means identical to the default path.
3. **When on, the second language is a linked sibling message rather than concatenated content.** The primary carries the person's-language text; the secondary is its own send sharing the same response group and tagged with its language and its role. Each language chunks independently against the working budget, because concatenating both would inflate one message's chunk count and spend the CJK budget twice as fast.
4. **No separate translation cache is needed**, because the translation is materialized as a real message. Re-reads read it rather than re-translating.
5. **The renderer groups by response group**, showing the original on top with the sibling beneath and dropping the second line where it equals the first. It already reassembles continuation parts and strips markers, so this extends existing grouping rather than adding a parser.
6. **A long deliverable uses the attachment path**, with a short lede per language, so the bilingual case never walls the conversation.

### Cost

With a cheap fast model doing the translation:

- Level 1 is free: it is a system-prompt instruction.
- The pivot costs a fraction of a cent per turn, and only where the person's language and the model's working language differ. The one-hop variant is about half the two-hop variant.
- Dual delivery costs a fraction of a cent per message, paid once because it is persisted as a message.

At ten thousand cross-language turns a month this is low single-digit dollars. Batching is irrelevant because the path is latency-sensitive; caching the translation system prompt shaves the per-call input cost.

### Testing owed

- **Encoded size:** a few hundred characters of Simplified Chinese chunks correctly, every chunk's encoded length within budget, and nothing is rejected.
- **Pivot no-op:** matching languages make no translation call.
- **Metadata drop:** an over-cap metadata value is dropped and the message still posts.
- **Language fallback:** an unknown or absent preference resolves to English and the pipeline never blocks. Level 1 already exercises this through the closed map's fallthrough.
- **Sibling grouping:** the original and the translation share one response group, their part numbers do not collide across languages, and the renderer regroups them.
- **Injection:** a translation input containing an instruction to ignore previous instructions is translated as text and does not alter downstream inference.

### Invariants

- **Language always resolved.** An unknown or missing preference resolves to English and never blocks. Already true at Level 1.
- **The pivot is a no-op in the common case.** No translation call where the two languages match.
- **One provider posture.** Translation routes through the catalog and the resilience layer; no second translation client and no assumption about which vendor serves the model.
- **The original is never lost under dual delivery.** The source text is always the primary message and the translated sibling is additive, deduplicated against it. Levels 1 and 2 deliver a single message in the person's language by design.
- **The welcome stays instant.** The greeting uses stored per-language copy rather than a runtime translation call: a workflow's opening is never a `voice` template.
- **Untrusted tag, closed map.** The preference selects from a fixed language-name map and is never interpolated raw into a prompt.

### Host and platform split

- **Platform:** the signal's handling on the server-only path, the reply-language instruction, the pivot and its translation helper, each catalog entry's working language, and the bilingual sibling send.
- **The host application:** already sends the preference and renders the conversation. Deployment-authored copy choices, such as per-language welcome wording, live in the deployment's own welcome copy rather than in a platform default.
