# Guide: Building and operating assistant context

**Audience:** developers building an assistant for a new use case, and admins/deployers who load and scope the content an assistant reads.

**Reference posture.** This guide documents the reference, open-source implementation. It is not a prescription for where sensitive data must live. A production deployment keeps sensitive data (financials, PII, regulated records) in its **authoritative source of truth** and has the assistant read it there, live, through a connector that carries the source system's own access controls, rather than copying it into the context store. Duplicating sensitive data into S3 or an embedding store is a reference convenience, not the production pattern.

**What is built.** The context *mechanisms* below are built and in use: classification-scoped company context via a tool, project **and** company RAG over pgvector, the **company-context digest** (a per-classification manifest injected into the system prompt), **conversation-summary-as-context** (the running summary folded in for long conversations), per-turn history, welcome composition, **prompt caching** of the stable system-prompt prefix (a Bedrock cachePoint on the persona + standing policy), and an opt-in **onboarding-welcome** intake (a deterministic multi-step flow that gathers required inputs before the assistant proper). Company RAG, project RAG and the summary run only in Aurora mode with `-c enableLiveDrift=true` (see [Athena vs Aurora](#athena-vs-aurora)). The live **connector** tool and **per-intent context selection** are **NOT BUILT**; each section marks its status. Every context source is also inventoried in [`SPEC-WELCOME-AND-CONTEXT.md`](../../specs/interaction/assistants/SPEC-WELCOME-AND-CONTEXT.md); the message path is in [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md); retrieval is in [`RAG.md`](RAG.md).

## Context sources

An assistant answers from a stack of context sources assembled per turn. Pick the source by the kind of content, not by habit:

| Content | Mechanism | Isolation | Cost shape |
|---|---|---|---|
| **Classification-gated business facts** (pricing, plan, product) | Company context: a per-classification **digest** (always present) names what exists; specifics come from the tool **and** deterministic RAG retrieval | Digest + tool scoped by **S3 IAM** on the assistant's declared prefixes; company RAG scoped by the classification's **database reader role** under `FORCE ROW LEVEL SECURITY`, plus the fail-closed **SQL classification filter** | Fetch what's relevant, not the whole corpus |
| **Sensitive records** (financials, PII, regulated) | *Production:* live read from the source of truth via a connector. *Reference:* a classification document. | The source system's own controls | On demand; not duplicated into the store |
| **Reference corpus** (wiki, runbooks, policies, FAQ) | Project RAG over pgvector, top-K by relevance | Reader role + row-level security, plus the SQL classification filter | ~$0.0001/turn embed; skips trivial turns |
| **Live external facts** (ticket status, inventory) | Connector tool (`fetchContext`), **NOT BUILT** | The connector's own auth | On demand only |
| **Always-present small context** (persona, standing policy, the company document menu) | System prompt; prompt caching via a Bedrock cachePoint on supporting models | n/a | Cached prefix, billed once |
| **Who is here** (the people and the other assistants in the conversation) | A `WHO IS HERE` section of the prompt where the router read the roster for the turn (conversations where more than one assistant could answer) | Channel membership; every name sanitized | No read of its own: the router's roster, and absent where the router read none |
| **This conversation so far** | Conversation history (recent turns); running **summary** folded in for older turns | Channel membership | History every turn; summary only when long |
| **Greeting / onboarding** | Welcome composition (static default; opt-in multi-step onboarding intake, once per user) | Channel metadata; in-intake state on the server-only channel context row; durable onboarded flag + facts in the per-user profile store | No model call on either path |
| **Durable per-user facts** (onboarding answers, e.g. company/role) | Per-user profile store (reference stand-in; swappable via `USER_PROFILE_SERVICE_ARN`), read into every turn as the `user-profile` context source every seed selects | Keyed by the person's AppInstanceUser id (`personId`), read from the sender ARN | Read on WelcomeIntent and every turn; written on intake completion |

## Building context

An assistant is defined by its persona, model, tools, guardrail, and **context scope**. The persona, models, tools and guardrail ride the assistant's versioned profile definition (see [`SPEC-ASSISTANT-CONFIG.md`](../../specs/interaction/assistants/SPEC-ASSISTANT-CONFIG.md)) - the persona as an S3 body the definition points at, editable with no deploy. Reach is not part of a version: what an assistant may read is deploy-time infrastructure, set per classification and per role in `backend/lib/config/profiles.ts`. To give a new assistant its context:

1. **Classify the content.** For each thing the assistant must know, choose a row in the table above. Do not paste whole documents into the persona; that is expensive and does not scale.
2. **Set the context scope.** Decide which classification(s) may read each document. Classification scope is the isolation boundary, enforced in infrastructure, not in the prompt.
3. **Load the content:**
   - *Business/financial documents* go under the classification prefixes (`context/{classification}/...`). A document in `context/{c}/` is readable by every classification whose declared grants include `c` (`contextPrefixesAllowedFor` in `agent-classification-common.ts`, which returns `profiles.contextPrefixesGranted`). A role can be narrowed further: a classification's `roleContext` entry limits that role's assistant to a subset of its grants (`contextPrefixesForRole` in `backend/lib/profile-registry.ts`; the shipped premium `ops` role reads only `basic` and `standard`). A role is never widened past its classification's grants; synthesis refuses that.
   - *Reference documents* (wiki, runbooks) go under the RAG prefix (`rag/{source_type}/{classification}/...`, with `wiki` or `doc` as the source type: retrieval reads only the source types in `RAG_SOURCE_TYPES`, and a runbook uploaded under `rag/runbooks/` is embedded but never retrieved) and are embedded automatically on upload (see [`RAG.md`](RAG.md)).
4. **Choose the welcome.** A simple assistant uses the static welcome (instant, no model call). An assistant that onboards or intakes uses the context-gathering welcome pattern (below).
5. **Set response shape and guardrail** on the assistant config as needed.

The mechanisms are shared; a new use case is configuration, not a forked agent loop.

## Loading company context

Drop classification documents under `context/{classification}/`. Two different paths read them, each with its own classification boundary:

- The **company-context tool** (`load_company_context`) returns whole documents from the `context/{c}/` prefixes the assistant holds, scoped by the physical **IAM** prefix boundary: an assistant whose grants do not include `c` cannot read `context/{c}/`. It is **selective, not whole-corpus**: the always-present **per-classification digest** (`context/{classification}/_digest.json`) lists each document's **filename** plus title plus one-line description, and the model names the specific file(s) it needs in the tool's `documents` argument, so it loads only those. It falls back to loading all permitted docs only for a genuinely broad question (or when a digest has no filenames). Use it when the assistant needs a **complete document** (for example a data-extraction task pulling a full table).
- **Company RAG (retrieval):** the same documents are embedded into the pgvector store (stamped with their classification, under `rag/company/{classification}/`) and the asynchronous processor pre-fetches the top-K relevant **chunks** per turn by semantic relevance (`maybeRetrieveContext` in `backend/lambda/src/lib/turn-grounding.ts`). Use it (it runs automatically) when the assistant needs the **relevant facts**, not a whole document. Requires Aurora mode and `-c enableLiveDrift=true`; without that flag the processor returns no retrieval.

So: **digest = the menu** (always present, names what exists); **tool = fetch a whole named document**; **RAG = semantically retrieve the relevant chunks**. Because relevant chunks are already pre-fetched for the turn, the tool is for the whole-document case, not a redundant "load everything." The digest is precomputed at ingestion/seed time and warm-cached, so it is not rebuilt from the corpus every turn.

> **The digest must carry each document's `file`** (its filename) for the tool's selective load to work; the seed writes it from `backend/demo/context-digest-manifest.json`. A digest without `file` degrades safely to the tool loading all permitted docs.

**Isolation posture.** With company RAG active, a document's classification is enforced by IAM on the S3 prefix (tool + digest) and, for retrieval, by two database layers. The query runs as the serving classification's **reader role** (`withReaderRole`, defined in `backend/lambda/src/analytics-aurora/classification-boundary.ts` and called by `backend/lambda/src/analytics-aurora/document-retrieval.ts`), and the embeddings table is under `FORCE ROW LEVEL SECURITY` with one read policy per table that admits a row only when its classification is in the current reader role's declared grants (`ae_classification_scope`, generated by `scopeFunctionSql`; `boundaryStatements` in `backend/lambda/src/analytics-aurora/classification-boundary-sql.ts`; [ADR-028](../../design/decisions/028-vector-store-classification-boundary.md)). The fail-closed SQL classification filter in the query is the second layer on top. Both are database boundaries, not physical prefix boundaries. **For genuinely sensitive records (financials, PII, regulated data), the production pattern is to NOT embed them at all** - keep them in their **source of truth** and read them live through a connector so the source system's own access controls apply. The demo embeds *fictional* financials for illustration.

**Classification scoping rule (both paths):** content tagged for classification `c` is visible to every classification whose declared grants include `c`, and to no other. The shipped sample config nests basic in standard in premium, so content every conversational classification should see goes in `basic` there; a deployment that declares its classifications as peers places shared content in each.

## Conversation history and summary

- **History** is the recent turns of this conversation, read fresh each turn and threaded into the model input. It keeps the assistant coherent within the recent window.
- **Summary (consumable context):** a running summary of the conversation is produced out of band (it also feeds drift detection). Once a conversation grows past the recent-history window (a summary row exists in the store), the processor fetches it from the data-plane Lambda and folds it into the system prompt (`## EARLIER IN THIS CONVERSATION`) so it keeps the earlier thread; on short conversations it is omitted. Consumption is conditional on length (the summary's existence is the length signal), and the fetch runs in parallel with retrieval so it adds no wall-clock. Like retrieval it requires Aurora mode and `-c enableLiveDrift=true` (`maybeGetSummary` in `turn-grounding.ts`).

## Welcome patterns

The welcome is a passthrough: at minimum it greets with the context the system already has; at most it runs a short, context-gathering intake before the assistant proper. Choose the pattern the use case needs.

- **Static greeting (default).** Instant, no model call. Personalizes from what is already on the channel: the user's name, a topic set at creation, or a trigger context carried from another flow. Best for a general assistant where any first turn is a real question. See [`SPEC-WELCOME-AND-CONTEXT.md`](../../specs/interaction/assistants/SPEC-WELCOME-AND-CONTEXT.md).
- **Context-gathering onboarding (opt-in).** A multi-step intake that gathers what the assistant needs before it can help (for example, a sign-up or profile-building flow that collects a few fields, confirms them, and hands off to the working assistant with that context in place). Use it when the assistant cannot do useful work until it has collected structured inputs from the user. The shape is: greet, ask for the minimum required inputs one step at a time, validate and confirm, then transition into the assistant with the collected context available. Required inputs are minimal and the user can skip optional ones.

  Like the static welcome it is **deterministic (no Bedrock call)** on any intake turn, so it is instant and predictable. Progress within a single intake is stored on the conversation's server-only channel context row (`onboardingIntake`), naming the person it belongs to, so only that person's messages advance it and a pause does not lose it; the questions and answers land as normal channel messages, so once the intake confirms, the working assistant sees the collected inputs in its recent-history window with nothing extra to wire.

  **Once per user.** The intake is not per-conversation: the router records that a user completed onboarding (and the collected facts) in a durable per-user profile, and every later conversation for that user skips the intake and answers directly. On WelcomeIntent it resolves who the conversation is FOR from a participant row recorded before the channel was created (`resolveParticipants`, the server-only channel-context store), falling back to live membership only for a channel that has no such row; it never reads channel metadata for this. It then starts the intake only when that person has no `onboardedAt`, and only for a single-subject conversation (a group has nobody to key the gate on); on completion it writes `onboardedAt` plus the facts. Reads fail open (a profile-store outage degrades to starting the intake, never to a broken welcome). The profile store is a reference stand-in an implementer swaps for their own via `USER_PROFILE_SERVICE_ARN`. Full design: [`SPEC-USER-PROFILE-AND-ONBOARDING.md`](../../specs/interaction/conversation/SPEC-USER-PROFILE-AND-ONBOARDING.md).

  **Schema source.** The intake schema in force comes first from the **active version of the addressed assistant's profile** (the turn's assistant profile, `turnAssistantProfile` in `backend/lambda/src/lib/turn-assistant.ts`; its `onboarding` block, `ActiveProfile.onboarding` in `backend/lambda/src/lib/active-profile.ts`). In a classification with several assistants, a conversation with `ops-premium` gets `ops-premium`'s intake, not the primary's. Only when that version carries none, or cannot be read, does the router fall back to the deployment schema described below (`intakeForAssistant` in `backend/lambda/src/router-agent-handler.ts`), and only for the classification's primary: the deployment schema is one per classification, so a second assistant with no intake of its own asks nothing. The welcome and the later answer turns use the same resolution, so a person is never asked one schema's questions and checked against another's fields.

  **Enabling it.** Onboarding is off by default (the generic assistant answers the first turn cold). It turns on when the active profile version carries an `onboarding` block, or when the deployment supplies an intake schema as JSON, either inline via the `ONBOARDING_INTAKE` environment variable or, for a larger schema, via an SSM parameter named by `ONBOARDING_INTAKE_PARAM`:

  ```json
  {
    "greeting": "Welcome! I just need a few details before we begin.",
    "fields": [
      { "key": "company", "prompt": "What company are you with?", "required": true },
      { "key": "email", "prompt": "What is your work email?", "required": true,
        "pattern": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", "example": "you@stratum.example.com" },
      { "key": "goal", "prompt": "What are you hoping to accomplish? (optional)", "required": false }
    ],
    "completion": "Thanks, {name}! You're all set. How can I help?"
  }
  ```

  Each field has a `key` (where the answer is stored), a `prompt` (the question), and `required` (default true; optional fields accept a blank or `skip`). A required field may set a validation `pattern` (a case-insensitive regex) with an `example` shown when an answer does not match. `{name}` in `completion` interpolates the user's display name when known. The router adds the first question after the composed welcome in the same message, so the welcome is still shown and `greeting` is used only when no welcome is passed. A schema may also set `offer` (one yes/no question in place of the fields), `bail` (phrases that end the intake) and `fields[].preference` (a field that sets a reply preference); the full schema is [section 4.2 of the profile guide](HOW-TO-ADD-OR-MANAGE-A-PROFILE.md#42-the-intake-schema). An empty or malformed schema leaves onboarding disabled. The implementation is `backend/lambda/src/lib/onboarding-intake.ts` (a pure FSM engine) wired into the router welcome path.

  **Deployment schema location.** Every classification's router Lambda reads its fallback schema from a per-classification SSM parameter, wired by the classification stack (`assistant-profile-stack.ts` grants and points at it for every profile):

  ```
  /agent-echelon/assistant/basic/onboarding-intake
  /agent-echelon/assistant/standard/onboarding-intake
  /agent-echelon/assistant/premium/onboarding-intake
  ```

  (`/agent-echelon` is `SSM_ROOT`; it changes with the instance prefix.) The parameter is not created by the stack, only granted and pointed at, so this fallback stays off until you write it. Enable or update it with no redeploy; the router caches the loaded schema for 30 seconds (`INTAKE_CONFIG_TTL_MS` in `onboarding-intake.ts`), so a change takes effect within that window:

  ```bash
  aws ssm put-parameter --name /agent-echelon/assistant/standard/onboarding-intake \
    --type String --overwrite --value "$(cat intake.json)"
  ```

  Disable it again by deleting the parameter (`aws ssm delete-parameter --name ...`); the router falls back to the static welcome unless the active profile version carries its own `onboarding`. All classifications run the same shared router code (`router-agent-handler.ts`, deployed as a per-classification Lambda) and the same intake path. For a single small schema you can instead set the `ONBOARDING_INTAKE` env var directly on the router Lambda (read before the SSM param), but the SSM parameter is the deployment-managed path.

## Trust levels

A context source moves external data into the system prompt, which is the highest-trust region of a turn. Every catalog entry therefore declares a `trust` level, and the level is a required field (`ContextSourceTrust` in `backend/lib/config/context-sources.ts`), not an optional annotation.

| `trust` | Written by | May influence |
|---|---|---|
| `platform` | platform code, from an authenticated identity | grounding, never policy |
| `operator` | an admin or deployer, out of band | grounding and standing policy |
| `member` | a conversation participant | grounding only, always delimited |

**A field may declare a lower trust than its entry.** The trust of a store and the trust of what is written into it can differ: the built-in user-profile store is platform code, and every answer in it is text the person typed at onboarding. A field declares its own `trust` (`ContextSourceField.trust`), which may only lower its entry's; validation refuses one that raises it. The shipped `user-profile` entry declares each of its fields `member`. The field's trust is what its variable `ctx:<key>.<field>` decides by (ADR-060), so a condition on an onboarding answer is refused, and the prompt fences the entry at the lowest trust inside it (`entryFenceTrust`), so the `user-profile` block renders `trust="member"` with the participant-supplied instruction. An entry whose fields declare no trust of their own renders exactly as its entry's trust says.

**A source's fields are variables, and its trust decides what they may do** ([ADR-060](../../design/decisions/060-a-variable-is-declared-once-and-its-trust-decides-what-it-may-do.md)). Each field is the variable source `ctx:<key>.<field>` with its field's trust: a platform or operator field may decide a condition (a routing rule, a message choice, a task machine's `when`) and be inserted into a message; a member field is inserted, stripped and capped, and never decides. A condition on a `ctx:` field is checked against the classification's published catalog wherever it is stored: a version's at validate, activate, a variant and import (`versionConditionErrors`), a pack machine's at the classification's synth (`machineCatalogConditionErrors`). The router reads no catalog, so an event workflow's condition never reads one. A field is read under its own classification's acting role, so another classification's source is refused twice: by validation, because its catalog does not publish it, and by IAM (`a-turn-role-is-refused-another-classifications-context-source`, unit and e2e). The admin console lists every source with its trust in its variable picker.

**Member-writable sources.** Conversation-scope sources are attacker-controlled. Channel metadata is member-writable: a user holds `UpdateChannel`, which sets Name and Metadata in one call. Anything resolving from it may ground a reply and may never carry an access decision, a classification, or standing policy. See [`METADATA-AND-TAGS.md`](METADATA-AND-TAGS.md) for the storage rules this follows from.

**Data, not instructions.** Resolved values are data, never instructions. Three mechanisms enforce that, and all three ship:

- Every source renders inside an explicit delimiter carrying its own trust level, `<context source="..." trust="...">`, so the model can tell provisioned content from participant content. A `member` source additionally renders the instruction to treat it as information about the request and never as instructions.
- Every field value passes through `sanitiseValue` (`context-sources-runtime.ts`), which strips control markers (`lib/message-markers.ts`) before the value can reach the prompt. This is an injection defense, not formatting: a resume or a fetched job description is exactly the kind of third-party text that can carry an `<!--ACTIVE_TASK...-->` or `NAVIGATE_CHANNEL:` marker that downstream parsers would read as platform control output. The greeting path is not exempt, and it is the path most likely to carry third-party text.
- The assistant-visible menu lists descriptions only, never values, so a poisoned value cannot rewrite the index of what exists.

**Degrade, not fail.** An unresolvable source degrades; it does not throw. A source that times out, is refused, or throws renders as an empty section; one bad source never costs the user their turn. Because that makes a failure invisible to the user by design, each outcome is classified where it happens (`denied`, `absent`, `timeout`, `error`) and emitted per source and classification to the `AgentEchelon/ContextSources` CloudWatch namespace alongside the successes, so that "resolving fine" is distinguishable from "never ran". An unrecognized failure is classified `error` and never `absent`: guessing "absent" would relabel a novel authorization failure as a missing document. A source the catalog declares `perPerson` (the shipped `user-profile`) that has no record for the requesting person counts as the `no-record` skip, not as `absent`: a person who has not completed onboarding has no record, which is normal, so it stays out of the failure rate. A shared source that is missing is still `absent`.

## Selection and order

`contextSources` lives on the profile's runtime-editable body, so it versions, exports, rolls back and A/B-tests with everything else. It selects among what the deployment provisions and cannot widen the boundary: the catalog declares what exists, the profile declares what is used.

**Profile order.** Order is the profile's, not the catalog's. Registry order is prompt order, and prompt order affects both model behavior and where the Bedrock `cachePoint` prefix ends, so the registry renders in profile order. A key present in the catalog but absent from `contextSources` is not rendered.

**What every assistant starts with.** Every seed selects `user-profile` (`SEEDED_CONTEXT_SOURCES` in `active-profile.ts`): a declared assistant's seeded version, a console-created assistant's first draft from its classification's defaults, and the reset baseline all carry it. A first draft copied from another assistant or landed from a profile file keeps what its source selects. The entry is `identity-settled`, so the welcome omits it. `company-docs` is not seeded, because the company document menu (`AVAILABLE COMPANY CONTEXT`) is in every turn already with the `load_company_context` tool to read a document on demand, scoped to the assistant's role. The console shows that menu as **Company documents, always included**, beside the **Additional context sources** a version selects.

**Who is here.** A turn's prompt carries a `WHO IS HERE` section (`lib/who-is-here.ts`, registered in `createTurnContextRegistry`) naming the people in the conversation by display name and each other assistant by name, role and the one-line summary of what it advertises. The answering assistant is never listed, and a conversation of one person and this assistant has no section. The roster is the live Amazon Chime SDK membership the router reads to offer roommates, which it does in conversations where more than one assistant could answer. The router forwards that roster in the turn's own dispatch payload, built for that conversation and that answering assistant, and the section appears on those turns. Every other turn has no section and makes no membership read for it. Display names are member-controlled, so each is stripped of control markers, control characters and line breaks, has angle brackets removed, and is capped at 80 characters; the roster is capped at 25 people and 8 assistants, with the rest counted. The section changes with membership and differs per conversation, so it renders after the cachePoint and the cached prefix stays shared by every conversation the assistant serves.

Each key's fields, availability and trust are listed in [`context-catalog-reference.md`](../../reference/context-catalog-reference.md), which is generated from the catalog itself rather than maintained by hand.

## Selecting by intent

**NOT BUILT.** `contextSources` selects per PROFILE, and `selectSources` (`backend/lambda/src/lib/context-sources-runtime.ts`) takes the profile's keys and the call site's capabilities, not the turn's intent. Every turn that is not a greeting or an acknowledgment gets the same bundle: relevance retrieval over the corpus, the conversation summary, and recent history. The rest of this section is design guidance for per-intent selection.

**The principle.** The intent classifies the MESSAGE. The context a reply needs is a property of the WORK. AgentEchelon already separates these for model selection, where the resolver takes the turn's own context because the intent does not describe the work the reply has to do (see [SPEC-CONTEXT-AWARE-MODEL-ROUTING.md](../../specs/interaction/assistants/SPEC-CONTEXT-AWARE-MODEL-ROUTING.md)). Context selection deserves the same separation.

**Accuracy, then cost.** Retrieval that returns loosely related chunks spends prompt budget and pulls the model toward material the turn is not about, which is the failure retrieval exists to prevent. Skipping it where it cannot help is an accuracy decision before it is a cost one.

### Starting point per route

These are what the routes plainly imply. They are a starting point for a deployment to tune against its own turns, not a measured result.

| Route | Retrieval | Summary | History | Task record | Why |
|---|---|---|---|---|---|
| `general` | broad | yes | short | if open | The default. The question may be about anything |
| `code_generation` | scoped to code sources | no | short | if open | A summary of chat adds nothing to a code task |
| `code_review` | the artifact under review | no | short | if open | The diff is the context. Corpus search is noise |
| `data_extraction` | no | no | none | yes | The document is supplied. Retrieval competes with it |
| `report_generation` | scoped | yes | long | yes | Needs the thread and the brief |
| `strategic_analysis` | broad | yes | long | yes | The one route that genuinely wants everything |
| `guided_troubleshooting` | no | no | short | yes | The task record is the context |
| A turn continuing open work | no | no | short | yes, primary | The task holds the question, the state and the original request |

### Continuation turns

A turn that answers work already in progress is a TURN CONDITION, not a request category. It cannot be expressed by a route key alone, and the route it lands on is the wrong one.

A short reply that resumes waiting work is relabeled to a general intent so the chain gets a turn at all. A general reply answers through `general` (`ANSWERS_THROUGH_GENERAL` in `backend/lambda/src/lib/model-resolver.ts`), which is the broadest policy in the table. So the cheapest turn in the system is routed to the most expensive policy by default, and the retrieval it runs embeds whatever the person typed. For "yes", that is an embedding and a vector search over a word with no content in it.

When a task awaits this person, the task record is the primary context. It holds what was asked, the state the work is in, and what is being waited for. That is better context than a search keyed on the reply text, and it is already loaded by the time the decision is made.

### Builder guidance

1. **Start from what the reply must produce**, not from what the message looks like. When the answer comes from a supplied document, retrieval is competition rather than help.
2. **Declare context next to model routing**, so the two are read and reviewed together. A route needing a stronger model usually needs different context, and separating them lets them drift.
3. **Treat a continuation of open work as its own case**, above the route.
4. **Absent means the default.** A profile that declares nothing keeps the current behavior.
5. **Validate at the write path**, the way `contextSources` entries and model routes already are. A policy naming a route that does not exist is rejected when the profile is saved, not ignored on a live turn.

The selection seam already carries a call-site notion: `selectSources` takes the capabilities of the site asking and drops sources that site cannot use. A turn condition is the same kind of gate, applied to the same selection, which is where per-intent and per-turn selection belongs rather than in a second mechanism beside it.

## Efficiency notes

- **Do not re-gather unchanged context.** Static, per-classification content should be cached for the warm conversation rather than re-read from storage every turn.
- **Do not re-bill an always-present prefix.** Prompt caching is applied to the stable system-prompt prefix (persona, host context sections, and the company document menu) via a Bedrock cachePoint, so it is billed and processed once and reused across tool-loop iterations and turns. It engages on supporting models (Claude 3.5+/4.x) once the prefix clears the ~1024-token minimum. The menu depends only on the classification and the assistant's role scope, so `invokeBedrock` places it at the end of the cached prefix (`insertIntoCacheablePrefix`) when the company-context tool is on, and a turn with the tool off has no menu. The dynamic suffix (retrieved context, catalog context sources, the who-is-here section, conversation summary, and the history-note) stays after the cachePoint.
- **Retrieve, do not dump.** Relevance retrieval scales with corpus size; a whole-corpus load does not.
- **Skip trivial turns.** A greeting or acknowledgment needs no retrieval.

## Athena vs Aurora

Two context mechanisms, relevance **retrieval** (RAG over pgvector) and the **conversation summary**, require Aurora mode, because pgvector and the summary store live in the Aurora cluster. They also require `-c enableLiveDrift=true` (default off; see `backend/deploy.config.example.json`): that flag wires the data-plane invoke onto the processor, and without it `turn-grounding.ts` returns no retrieval and no summary even in Aurora mode. Athena mode, the default, does not have them.

| Capability | Athena (default) | Aurora + `enableLiveDrift` |
|---|---|---|
| Company context | `load_company_context` tool (loads the specific doc(s) the model names from the digest, classification-scoped by IAM), plus the digest | Plus RAG relevance retrieval, deterministic processor pre-fetch |
| Project docs (wiki, runbooks) | Not retrievable | RAG retrieval |
| Conversation summary | Not available | Consumed for long conversations |
| Drift / cross-conversation | Not available | Available |

This follows the platform rule that **Aurora is a strict superset**: Athena is the baseline (the tool and the digest still work; nothing is removed), and Aurora adds relevance retrieval and the summary on top. Nothing is Athena-only.

**Production recommendation.** Deploy **Aurora mode** with `enableLiveDrift` for any instance whose assistants must answer from a non-trivial or growing body of documents. Relevance retrieval is what keeps context accurate and bounded as a corpus grows; the whole-corpus tool load does not scale, and the digest alone cannot rank relevance. The Aurora cluster is shared across RAG, drift, cross-conversation context, and evaluation, so the incremental cost of retrieval is small once Aurora is deployed (see [`AURORA-MODE-GUIDE.md`](../admin/AURORA-MODE-GUIDE.md), and [`INFRASTRUCTURE-COST.md`](../admin/INFRASTRUCTURE-COST.md) for the per-piece cost model). Retrieval and drift execute in a dedicated VPC-attached data-plane Lambda that the non-VPC assistant path invokes, which adds no new VPC endpoints (ADR-013; see [`RAG.md`](RAG.md)).

**Without Aurora:**
- Keep company documents small and few so the tool load stays within budget, and lean on the digest so the model fetches the right document rather than the whole set.
- For sensitive or high-value data, use the **source-of-truth connector** pattern (read live from the system of record). It works in both modes and does not depend on retrieval.
- The retrieval call is the extension point for a bring-your-own vector store if a deployment already has one; the built-in retrieval is pgvector on Aurora.

## Related

- [`SPEC-WELCOME-AND-CONTEXT.md`](../../specs/interaction/assistants/SPEC-WELCOME-AND-CONTEXT.md) - the context inventory and welcome contract.
- [`SPEC-ASSISTANT-CONFIG.md`](../../specs/interaction/assistants/SPEC-ASSISTANT-CONFIG.md) - the assistant configuration bundle.
- [`RAG.md`](RAG.md) - the pgvector retrieval path and the data-plane Lambda.
- [`INFRASTRUCTURE-COST.md`](../admin/INFRASTRUCTURE-COST.md) - per-piece infrastructure cost model.
- [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md) - where context enters the message path.
- [`SPEC-CONVERSATION-SECURITY.md`](../../specs/interaction/governance/SPEC-CONVERSATION-SECURITY.md) - classification isolation guarantees.
- [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) - per-classification assistant management.
