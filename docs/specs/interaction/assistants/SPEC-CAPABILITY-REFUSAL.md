# SPEC: Refusing what a classification cannot produce

**Status:** Partial - the refusal itself (FR1-FR6, FR8, FR9, FR14, FR16-FR19) is built and deployed; FR20 and FR21 (platform questions and off-topic requests) are built and unit-tested, not exercised against a deployment; FR7 (the stacks reading `produces`) and FR11 (reading back the archived exchange row) are partly built; the read surfaces (FR12, FR13), the configuration guards (FR15) and per-language copy (FR10) are not. **Verified by:** `capability-refusal.spec.ts` (two members' own channel views, task table read back) and `backend/test/lib/capability-refusal.test.ts`.

**Coverage:** `tests/e2e/capability-refusal.spec.ts` (`validate.mjs --only=capability-refusal`); `tests/e2e/subjects-and-intents.spec.ts` (FR20 and FR21: platform questions at each classification depth, an off-topic request declined; written, not yet run against a deployment).

**Related:** [DESIGN-CAPABILITY-REFUSAL.md](./DESIGN-CAPABILITY-REFUSAL.md) - the mechanics: the one declared fact about what a classification produces, how a refused intent is still recognized, where the router refuses, and how the reply is composed. [SPEC-CONFIGURABLE-INTENT-PACK.md](./SPEC-CONFIGURABLE-INTENT-PACK.md) - the taxonomy this extends. [ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md) - classifications are a set of grants, which is how "a classification you can reach" is computed.

**Site section:** Interaction layer, assistants.

## Overview

Each classification is designed to produce a fixed set of outputs: basic answers in the conversation and hands over no files, standard also delivers generated documents, premium also generates images. When a person asks an assistant for something it does not offer (a platform capability its intent pack does not declare, such as a report on basic), the assistant is designed to recognize the request for what it is, refuse it plainly, and tell the person where they can get it: a classification they already reach that produces it, or, if they reach none, their administrator.

The refusal is designed to happen before any task opens or any model runs, and to be recorded, so the deployment can see what people asked for and did not get.

## Business Problem

A person who asks for a report and receives a chat answer, or asks for an image and receives an error, cannot tell whether the assistant misunderstood, failed, or was never able to do it, and does not learn where to go instead. Teams that build assistants by hand patch this with "I can't do that" lines in each prompt, which drift from what each assistant can actually deliver and which a model honors inconsistently. This feature gives every assistant a clear, consistent answer to requests outside its role, pointing the person at an option they already have or at the administrator who can grant one.

## Personas

### Person in a conversation

Wants an answer to what they asked, and when it cannot be given here, to know where it can.

| Use case | What happens |
|---|---|
| Asks a basic assistant for a report, and holds standard clearance | Told this assistant does not produce report documents, and that Standard does |
| Asks a basic assistant for an image, and holds only basic clearance | Told this assistant does not generate images, and to request access from an administrator; no classification is named |
| Asks while their clearance cannot be resolved | Told this assistant does not produce that output; nothing is said about their access |

### Administrator

Wants to know what people need that their classification does not give them, so access requests arrive for a reason.

| Use case | What happens |
|---|---|
| Sees how often each classification refuses each output | A refusals view in the admin console, read from the recorded refusals |
| Is asked for access by a person who was refused | The person was told to ask, and why; the request itself travels outside the platform |

### AI developer

Configures assistants and their intent packs, and wants a configuration that cannot promise what its classification does not produce.

| Use case | What happens |
|---|---|
| Sees what a classification produces | The profile editor shows the classification's outputs beside the intent pack |
| Authors the wording of a refusal for an assistant | Sets the refusal lines on the profile's copy; unset lines fall back to shipped defaults |
| Declares a custom intent that delivers a document | Declares the output it needs, so it is refused where that output is not produced |

## Functional Requirements and Acceptance Criteria

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | In LLM classification, a request matching a platform intent the assistant's pack does not declare (for example a report, a data export or an image on basic) is classified as that intent and refused, not answered as a general question; nothing needs listing in a pack to be refused | Table stakes | Yes | `capability-refusal.spec.ts` (a report and an image request on basic are recognized and refused) |
| FR2 | Such a request is refused before a turn is claimed: no task row is written, no async processing is dispatched, no model generates an answer | Table stakes | Yes | `capability-refusal.spec.ts` (no report task row opened) |
| FR3 | When the person's clearance reaches one or more conversational classifications that produce the output, the refusal lists those classifications by display label and says to start a conversation there | Differentiator | Yes | `capability-refusal.spec.ts` (a premium-cleared asker reads Standard and Premium) |
| FR4 | When the person's clearance reaches no classification that produces the output, the refusal tells them to request access from an administrator and names no classification | Differentiator | Yes | `capability-refusal.spec.ts` (a basic-only asker is sent to an administrator, no classification named) |
| FR5 | When the person's clearance cannot be resolved, the refusal states only that this assistant does not produce the output, and says nothing about their access | Table stakes | Yes | unit only: `capability-refusal.test.ts` (clearance that did not resolve yields the refusal line alone) |
| FR6 | When classification cannot be done by a model (keyword mode, or the model call fails), nothing is refused: the turn proceeds as it does without this feature | Table stakes | Yes | unit only: `capability-refusal.test.ts` |
| FR7 | What a classification produces is ONE declared fact, read by the stack that grants the output and by the runtime that refuses without it | Enabler | Partly | unit only: `capability-refusal.test.ts` reads `produces`; the stacks still read their own flags (DESIGN §2) |
| FR8 | Any intent, platform or custom, may declare the output it needs, which is what lets a refusal name where the request would be served | Enabler | Yes | unit only: `capability-refusal.test.ts` |
| FR9 | The refusal is worded by the assistant: refusal lines are part of the profile's authored copy, with shipped defaults for any line left unset | Table stakes | Yes | unit only: `capability-refusal.test.ts` (authored lines win) |
| FR10 | The refusal is in the language of the conversation | Gap - prioritize | No | none - depends on per-language authored copy (SPEC-BILINGUAL-CONVERSATIONS FR8) |
| FR11 | Each refusal is recorded once, as the turn's exchange, carrying the refused intent and the `REFUSED` delivery | Differentiator | Partly | `capability-refusal.spec.ts` (the refusal declares the REFUSED delivery); the archived exchange row is not read back |
| FR12 | The admin console shows refusals per classification and output over a date range | Differentiator | No | none - no view built |
| FR13 | The profile editor shows what the profile's classification produces | Table stakes | No | none - no view built |
| FR14 | The demo deployment's basic assistant serves no `report_generation`, `data_extraction` or `image_generation`, and recognizes all three for refusal | Table stakes | Yes | `intent-pack-extends.test.ts` (basic declares no `image_generation`); `capability-refusal.spec.ts` (an image request is refused) |
| FR15 | Activation of a profile version is refused when its pack serves an intent needing an output its classification does not produce, and an experiment variant cannot select an image model on a classification that produces no images | Table stakes | No | none - deferred; standard's demo pack serves `image_generation` without producing images, by owner decision, so the guard would refuse it |
| FR16 | The refusal is as visible as the request: a request targeted at the assistant gets a refusal targeted at the person alone, and a request the whole conversation can read gets a refusal it can read | Table stakes | Yes | `capability-refusal.spec.ts` (a public request is refused publicly, a targeted one privately) |
| FR17 | What the refusal says about the person's access (FR3, FR4) reaches the person alone: in a refusal to a public request, the access lines follow as a second message targeted at the person, so the conversation never reads what their clearance reaches | Table stakes | Yes | `capability-refusal.spec.ts` (the other member does not read the asker's access lines) |
| FR18 | A refused request that names no output any classification is declared to produce (for example a code request on basic) says the assistant does not do it, and adds the administrator line only when the person reaches no other conversational classification | Table stakes | Yes | unit only: `capability-refusal.test.ts` |
| FR19 | Summarizing, recapping or catching someone up on the conversation they are in is a platform capability every assistant has: it is classified as `conversation_summary`, never as a report, and never refused | Table stakes | Yes | `capability-refusal.spec.ts` (a summary request on basic is answered, not refused); `capability-refusal.test.ts` |
| FR20 | A question about AgentEchelon itself is the platform intent `platform_question`: a pack that declares it answers at the depth it declares, and a pack that does not refuses it. The demo's basic assistant explains what the platform is and does, with no recommendations, configuration steps, code or architecture advice; standard and premium give configuration and code examples and the architecture and its trade-offs. Basic's depth is enforced by what it can read as well as by its instructions: it reads only `platform-knowledge/basic/`, a public overview, and the documentation corpus is `standard` | Table stakes | Yes (unit); the end-to-end check is written, not yet run against a deployment | `platform-question-and-off-topic.test.ts` (unit: it is a platform intent, every Stratum pack declares it with `load_platform_info`, basic's and the internal packs' instructions); `the-platform-knows-its-own-provenance.test.ts` and `a-role-reads-only-its-own-context.test.ts` (unit: basic's overview has no document index, and both IAM layers scope `platform-knowledge/` by grant); `subjects-and-intents` (e2e, behavior: platform questions answered at each classification depth; written, not yet run) |
| FR21 | A request unrelated to everything the assistant offers, and not ordinary conversation, is classified `off_topic`, a universal intent: it is never refused by the router, and the turn is told to decline in one sentence and name what the assistant helps with, rather than leaving the decline to the model's judgment | Table stakes | Yes (unit); the end-to-end check is written, not yet run against a deployment | `platform-question-and-off-topic.test.ts` (unit: universal, recognized by the classifier, the decline block is in the answer prompt); `subjects-and-intents` (e2e, behavior: an off-topic request is declined, not answered; written, not yet run) |

## Non-Goals - Out of Scope

| Item | Why | Where it is covered |
|---|---|---|
| Wording for an external participant (a visitor through a host integration) | No external participants exist on a deployment yet. Their clearance is the conversation's own classification, so under the default grants they would always take FR4, whose administrator wording does not fit them | Revisit with the first host integration |
| An in-platform access request that an administrator approves | No access-request workflow exists; building one is its own feature. The refusal points the person to their administrator in words | [DESIGN-ADMIN-AGENT-NOTIFICATIONS.md](../governance/DESIGN-ADMIN-AGENT-NOTIFICATIONS.md) is the channel such a request would use |
| A link that opens a new conversation of a named classification | The chat app has no deep link for a new conversation of a given classification; the refusal names the classification instead | [SPEC-CHAT-APP.md](../../interface/SPEC-CHAT-APP.md) |
| Answering the rest of a message that also asks for a refused output | Classification assigns one intent per message; a refused message is refused whole, and the person asks the rest again | [SPEC-CONFIGURABLE-INTENT-PACK.md](./SPEC-CONFIGURABLE-INTENT-PACK.md) |
| Handing the request to another assistant in the conversation | Every assistant in a conversation acts in its one classification (ADR-042), so none present produces what the classification does not | [ADR-042](../../../design/decisions/042-an-assistant-acts-in-exactly-one-classification.md) |
| Refusing a request because of its subject (for example, general code questions on a company assistant) | Subject scope is the intent pack's: an intent the pack declares is answered, and its instructions say how. It is not a missing output, so it is not a capability refusal. A `general` turn outside the pack's intents is declined by the model through the `WHAT YOU OFFER` prompt block (`intent-answer.ts`). That decline is prompt-level user experience, not a control, and is not recorded as `REFUSED`. | [SPEC-CONFIGURABLE-INTENT-PACK.md](./SPEC-CONFIGURABLE-INTENT-PACK.md) |
| Refusing on content policy | Guardrails decide that | [SPEC-CONVERSATION-SECURITY.md](../governance/SPEC-CONVERSATION-SECURITY.md) |
| Raising a person's clearance | Clearance changes only through an administrator's action | [IDENTITY-AND-ACCESS-MODEL.md](../governance/IDENTITY-AND-ACCESS-MODEL.md) |

## User Experience Description and Mocks

The refusal is one short message from the assistant, in the conversation, as visible as the request was (FR16), answering the request directly. It does not apologize at length or restate the request. No task card appears, no progress placeholder is posted, and the turn closes on the refusal.

**Clearance reaches classifications that produce it** (a person holding premium clearance, in a basic conversation):

> **You:** Compile a one-page report on the StratumFlow product.
>
> **Concierge:** I don't produce report documents in this conversation. You have access to conversations that do:
> - Standard
> - Premium
>
> Start a new conversation there and ask again.

**Clearance reaches none** (a person holding only basic clearance):

> **You:** Generate an image of our logo on a billboard.
>
> **Concierge:** I don't produce images in this conversation.
>
> If you need images, ask your administrator for access.

**Clearance unresolved:**

> **Concierge:** I don't produce images in this conversation.

**The refusal is user experience, not enforcement.** A basic assistant cannot produce a document or an image because its role holds no grant to write generated documents or invoke an image model; the refusal tells the person so before anything is attempted. **OPEN:** no synth test asserts that basic's role lacks `generated-docs/*` write or image `InvokeModel`.


## Related Documents

- [DESIGN-CAPABILITY-REFUSAL.md](./DESIGN-CAPABILITY-REFUSAL.md) - how this is built.
- [SPEC-CONFIGURABLE-INTENT-PACK.md](./SPEC-CONFIGURABLE-INTENT-PACK.md) - the intent taxonomy.
- [SPEC-PORTABLE-PROFILES.md](./SPEC-PORTABLE-PROFILES.md) - the profile lifecycle the activation guard joins.
- [SPEC-BILINGUAL-CONVERSATIONS.md](./SPEC-BILINGUAL-CONVERSATIONS.md) - per-language authored copy, which FR10 waits on.
- [ADR-042](../../../design/decisions/042-an-assistant-acts-in-exactly-one-classification.md), [ADR-046](../../../design/decisions/046-classifications-are-a-set-not-a-ladder.md) and [ADR-049](../../../design/decisions/049-a-deployment-descriptor-contains-only-what-is-consumed-before-the-request-runs.md) - one classification per assistant, grants as a set, and a capability read by both the stack and the runtime.
