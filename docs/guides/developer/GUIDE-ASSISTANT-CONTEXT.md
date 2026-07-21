# Guide: Building and operating assistant context

**Audience:** developers building an assistant for a new use case, and admins/deployers who load and scope
the content an assistant reads.

**Reference posture.** This guide documents the reference, open-source implementation. It is not a
prescription for where sensitive data must live. A production deployment keeps sensitive data (financials,
PII, regulated records) in its **authoritative source of truth** and has the assistant read it there, live,
through a connector that carries the source system's own access controls, rather than copying it into the
context store. Duplicating sensitive data into S3 or an embedding store is a reference convenience, not the
production pattern.

**What's built today vs target.** The context *mechanisms* below are built and in use: tier-scoped company
context via a tool, project **and** company RAG over pgvector, the **company-context digest** (a per-tier
manifest injected into the system prompt), **conversation-summary-as-context** (the running summary folded in
for long conversations), per-turn history, welcome composition, and **prompt caching** of the stable
system-prompt prefix (a Bedrock cachePoint on the persona + standing policy), and an opt-in **onboarding-welcome**
intake (a deterministic multi-step flow that gathers required inputs before the assistant proper). The
**connector / config-bundle** items marked "target" are the intended direction, **not current behavior**; each
section marks its status. Every context source is also inventoried in
[`SPEC-WELCOME-AND-CONTEXT.md`](../../specs/conversation-messaging/SPEC-WELCOME-AND-CONTEXT.md); the message path is in
[`MESSAGE-FLOW.md`](MESSAGE-FLOW.md); retrieval is in [`RAG.md`](RAG.md).

## The model in one picture

An assistant answers from a stack of context sources assembled per turn. Pick the source by the kind of
content, not by habit:

| Content | Mechanism | Isolation | Cost shape |
|---|---|---|---|
| **Tier-gated business facts** (pricing, plan, product) | Company context: a per-tier **digest** (always present) names what exists; specifics come from the tool **and** deterministic RAG retrieval | Digest + tool scoped by **S3 IAM**; company RAG scoped by the fail-closed **SQL tier filter** | Fetch what's relevant, not the whole corpus |
| **Sensitive records** (financials, PII, regulated) | *Production:* live read from the source of truth via a connector. *Reference:* a tier document. | The source system's own controls | On demand; not duplicated into the store |
| **Reference corpus** (wiki, runbooks, policies, FAQ) | Project RAG over pgvector, top-K by relevance | SQL tier filter, fail-closed | ~$0.0001/turn embed; skips trivial turns |
| **Live external facts** (ticket status, inventory) | Connector tool (`fetchContext`) *(target)* | The connector's own auth | On demand only |
| **Always-present small context** (persona, standing policy) | System prompt; prompt caching (built) via a Bedrock cachePoint on supporting models | n/a | Cached prefix, billed once |
| **This conversation so far** | Conversation history (recent turns); running **summary** folded in for older turns | Channel membership | History every turn; summary only when long |
| **Greeting / onboarding** | Welcome composition (static default; opt-in multi-step onboarding intake, once per user, built) | Channel metadata; in-intake state in sessionAttributes; durable onboarded flag + facts in the per-user profile store | No model call on either path |
| **Durable per-user facts** (onboarding answers, e.g. company/role) | Per-user profile store (reference stand-in; swappable via `USER_PROFILE_SERVICE_ARN`) | Keyed by Cognito sub | Read on WelcomeIntent + first turn; written on intake completion |

## Building context for a new assistant

An assistant is defined by its persona, model, tools, guardrail, and **context scope**. The unified
configuration bundle a conversation type selects is the design *target* (see
[`SPEC-ASSISTANT-CONFIG.md`](../../specs/assistant-context/SPEC-ASSISTANT-CONFIG.md)); today these settings live per tier (stack IAM +
SSM persona + tool flags). To give a new assistant its context:

1. **Classify the content.** For each thing the assistant must know, choose a row in the table above. Do not
   paste whole documents into the persona; that is expensive and does not scale.
2. **Set the context scope.** Decide which tier(s) may read each document. Tier scope is the isolation
   boundary, enforced in infrastructure, not in the prompt.
3. **Load the content:**
   - *Business/financial documents* go under the tier prefixes (`context/{tier}/...`). A document placed in
     a tier's folder is readable by that tier and every higher tier.
   - *Reference documents* (wiki, runbooks) go under the RAG prefix (`rag/{source_type}/{tier}/...`) and are
     embedded automatically on upload (see [`RAG.md`](RAG.md)).
4. **Choose the welcome.** A simple assistant uses the static welcome (instant, no model call). An assistant
   that onboards or intakes uses the context-gathering welcome pattern (below).
5. **Set response shape and guardrail** on the assistant config as needed.

The mechanisms are shared; a new use case is configuration, not a forked agent loop.

## Loading company context (admin/deployer)

**Built today.** Drop tier documents under `context/{tier}/`. Two DIFFERENT paths read them, each with its own
tier boundary. These are frequently confused, so be precise about which does what:

- The **company-context tool** (`load_company_context`) returns WHOLE documents from `context/{tier}/*`,
  scoped by the physical **IAM** prefix boundary. It is **selective, not whole-corpus**: the always-present
  **per-tier digest** (`context/{tier}/_digest.json`) lists each document's **filename** + title + one-line
  description, and the model names the specific file(s) it needs in the tool's `documents` argument, so it
  loads only those. It falls back to loading all permitted docs only for a genuinely broad question (or when a
  legacy digest has no filenames). Use it when the assistant needs a **complete document** (for example a
  data-extraction task pulling a full table).
- **Company RAG (retrieval):** the same documents are embedded into the pgvector store (under
  `rag/company/{tier}/`) and the router pre-fetches the top-K relevant **chunks** per turn by semantic
  relevance, scoped by the fail-closed **SQL** tier filter, and passes them in on the payload. Use it (it runs
  automatically) when the assistant needs the **relevant facts**, not a whole document. Requires Aurora mode.

So: **digest = the menu** (always present, names what exists); **tool = fetch a whole named document**;
**RAG = semantically retrieve the relevant chunks**. Because the router already pre-fetches relevant chunks,
the tool is for the whole-document case, not a redundant "load everything." The digest is precomputed at
ingestion/seed time and warm-cached, so it is not rebuilt from the corpus every turn.

> **The digest must carry each document's `file`** (its filename) for the tool's selective load to work — the
> seed writes it from `demo/context-digest-manifest.json`. A digest without `file` degrades safely to the tool
> loading all permitted docs.

**Isolation posture (read this before embedding sensitive data).** With company RAG active, a document's tier is
now enforced by **two** mechanisms: IAM (tool + digest) and the fail-closed SQL filter (retrieval). The SQL
filter is fail-closed but is a data-layer boundary, not a physical prefix boundary. **For genuinely sensitive
records (financials, PII, regulated data), the production pattern is to NOT embed them at all** - keep them in
their **source of truth** and read them live through a connector so the source system's own access controls
apply. The demo embeds *fictional* financials for illustration; a real deployment would not.

**Tier scoping rule (both models):** content tagged for a tier is visible to that tier and above; a lower
tier never sees it. Put all-tier content in `basic`.

## Conversation history and summary

- **History** is the recent turns of this conversation, read fresh each turn and threaded into the model
  input. It keeps the assistant coherent within the recent window.
- **Summary (consumable context, built):** a running summary of the conversation is produced out of band (it
  also feeds drift detection). It is now **consumable context**: once a conversation grows past the
  recent-history window (a summary row exists in the store), the router fetches it from the data-plane Lambda
  and the assistant folds it into the system prompt (`## EARLIER IN THIS CONVERSATION`) so it keeps the earlier
  thread; on short conversations it is omitted. Consumption is conditional on length (the summary's existence is
  the length signal), not automatic on every turn, and the fetch runs in parallel with retrieval so it adds no
  wall-clock.

## Welcome patterns (static to onboarding)

The welcome is a passthrough: at minimum it greets with the context the system already has; at most it runs
a short, context-gathering intake before the assistant proper. Choose the pattern the use case needs.

- **Static greeting (default).** Instant, no model call. Personalizes from what is already on the channel:
  the user's name, a topic set at creation, or a trigger context carried from another flow. Best for a
  general assistant where any first turn is a real question. See
  [`SPEC-WELCOME-AND-CONTEXT.md`](../../specs/conversation-messaging/SPEC-WELCOME-AND-CONTEXT.md).
- **Context-gathering onboarding (opt-in, built).** A multi-step intake that gathers what the assistant needs
  before it can help (for example, a sign-up or profile-building flow that collects a few fields, confirms
  them, and hands off to the working assistant with that context in place). This is the richer end of the
  passthrough: it gathers relevant context and personalizes, rather than answering a general question cold.
  Use it when the assistant cannot do useful work until it has collected structured inputs from the user.
  The shape is: greet, ask for the minimum required inputs one step at a time, validate and confirm, then
  transition into the assistant with the collected context available. Required inputs are minimal and the
  user can skip optional ones.

  Like the static welcome it is **deterministic (no Bedrock call)** on any intake turn, so it is instant and
  predictable. Progress within a single intake rides in Lex `sessionAttributes` across turns (no per-turn
  store); the questions and answers land as normal channel messages, so once the intake confirms, the working
  assistant sees the collected inputs in its recent-history window with nothing extra to wire.

  **Onboarding fires ONCE per user.** The intake is not per-conversation: the router records that a user
  completed onboarding (and the collected facts) in a durable per-user profile, and every later conversation
  for that user skips the intake and answers directly. On WelcomeIntent it resolves the creator (channel
  membership, falling back to the `createdBy` metadata stamp because the welcome fires before the creator's
  membership settles) and starts the intake only when that user has no `onboardedAt`; on completion it writes
  `onboardedAt` plus the facts. Reads fail open (a profile-store outage degrades to starting the intake, never
  to a broken welcome). The profile store is a reference stand-in an implementer swaps for their own via
  `USER_PROFILE_SERVICE_ARN`. Full design: [`SPEC-USER-PROFILE-AND-ONBOARDING.md`](../../specs/assistant-context/SPEC-USER-PROFILE-AND-ONBOARDING.md).

  **Enabling it.** Onboarding is off by default (the generic assistant answers the first turn cold). A
  deployment turns it on by supplying an intake schema as JSON, either inline via the `ONBOARDING_INTAKE`
  environment variable or, for a larger schema, via an SSM parameter named by `ONBOARDING_INTAKE_PARAM`:

  ```json
  {
    "greeting": "Welcome! I just need a few details before we begin.",
    "fields": [
      { "key": "company", "prompt": "What company are you with?", "required": true },
      { "key": "email", "prompt": "What is your work email?", "required": true,
        "pattern": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", "example": "you@acme.com" },
      { "key": "goal", "prompt": "What are you hoping to accomplish? (optional)", "required": false }
    ],
    "completion": "Thanks, {name}! You're all set. How can I help?"
  }
  ```

  Each field has a `key` (where the answer is stored), a `prompt` (the question), and `required` (default
  true; optional fields accept a blank or `skip`). A required field may set a validation `pattern` (a
  case-insensitive regex) with an `example` shown when an answer does not match. `{name}` in `completion`
  interpolates the user's display name when known. An empty or malformed schema leaves onboarding disabled.
  The implementation is `backend/lambda/src/lib/onboarding-intake.ts` (a pure FSM engine) wired into the
  router welcome path.

  **Where the schema lives (per tier).** The router Lambda for each advanced tier (standard, premium) reads
  its schema from a per-tier SSM parameter, wired by the tier stack:

  ```
  /agent-echelon/assistant/standard/onboarding-intake
  /agent-echelon/assistant/premium/onboarding-intake
  ```

  (`/agent-echelon` is `SSM_ROOT`; it changes with the instance prefix.) The parameter is not created by the
  stack, only granted and pointed at, so onboarding stays off until you write it. Enable or update it with no
  redeploy (it takes effect on the router's next cold start):

  ```bash
  aws ssm put-parameter --name /agent-echelon/assistant/standard/onboarding-intake \
    --type String --overwrite --value "$(cat intake.json)"
  ```

  Disable it again by deleting the parameter (`aws ssm delete-parameter --name ...`); the router falls back to
  the static welcome. All tiers run the same shared router code (`router-agent-handler.ts`, deployed as a per-tier Lambda) and the same intake path. For a single small
  schema you can instead set the `ONBOARDING_INTAKE` env var directly on the router Lambda (read before the
  SSM param), but the SSM parameter is the deployment-managed path.

## Efficiency notes (why the target is lighter)

- **Do not re-gather unchanged context.** Static, per-tier content should be cached for the warm
  conversation rather than re-read from storage every turn.
- **Do not re-bill an always-present prefix (built).** Prompt caching is applied to the stable system-prompt
  prefix (persona + standing policy) via a Bedrock cachePoint, so it is billed and processed once and reused
  across tool-loop iterations and turns, not re-billed every turn. It engages on supporting models (Claude
  3.5+/4.x) once the prefix clears the ~1024-token minimum; the dynamic suffix (retrieved context, the
  company-context digest, conversation summary, and the history-note) stays after the cachePoint.
- **Retrieve, do not dump.** Relevance retrieval scales with corpus size; a whole-corpus load does not.
- **Skip trivial turns.** A greeting or acknowledgment needs no retrieval.

## Deployment mode and context capability (Athena vs Aurora)

Two context mechanisms, relevance **retrieval** (RAG over pgvector) and the **conversation summary**, require
Aurora mode, because pgvector and the summary store live in the Aurora cluster. Athena mode, the default, does
not have them.

| Capability | Athena (default) | Aurora |
|---|---|---|
| Company context | `load_company_context` tool (loads the specific doc(s) the model names from the digest, tier-scoped by IAM), plus the digest | Plus RAG relevance retrieval, deterministic router pre-fetch |
| Project docs (wiki, runbooks) | Not retrievable | RAG retrieval |
| Conversation summary | Not available | Consumed for long conversations |
| Drift / cross-conversation | Not available | Available |

This follows the platform rule that **Aurora is a strict superset**: Athena is the baseline (the tool and the
digest still work; nothing is removed), and Aurora adds relevance retrieval and the summary on top. Nothing is
Athena-only.

**Recommendation for production.** Deploy **Aurora mode** for any instance whose assistants must answer from a
non-trivial or growing body of documents. Relevance retrieval is what keeps context accurate and bounded as a
corpus grows; the whole-corpus tool load does not scale, and the digest alone cannot rank relevance. The
Aurora cluster is shared across RAG, drift, cross-conversation context, and evaluation, so the incremental
cost of retrieval is small once Aurora is deployed (see [`AURORA-MODE-GUIDE.md`](../admin/AURORA-MODE-GUIDE.md), and
[`INFRASTRUCTURE-COST.md`](../admin/INFRASTRUCTURE-COST.md) for the per-piece cost model). Retrieval and drift execute
in a dedicated VPC-attached data-plane Lambda that the non-VPC assistant path invokes, which adds no new VPC
endpoints (project decision 018; see [`RAG.md`](RAG.md)).

**If Aurora is not an option:**
- Keep company documents small and few so the tool load stays within budget, and lean on the digest so the
  model fetches the right document rather than the whole set.
- For sensitive or high-value data, use the **source-of-truth connector** pattern (read live from the system
  of record). It works in both modes and does not depend on retrieval.
- The retrieval call is the extension point for a bring-your-own vector store if a deployment already has one;
  the built-in retrieval is pgvector on Aurora.

## Related

- [`SPEC-WELCOME-AND-CONTEXT.md`](../../specs/conversation-messaging/SPEC-WELCOME-AND-CONTEXT.md) - the context inventory and welcome contract.
- [`SPEC-ASSISTANT-CONFIG.md`](../../specs/assistant-context/SPEC-ASSISTANT-CONFIG.md) - the assistant configuration bundle.
- [`RAG.md`](RAG.md) - the pgvector retrieval path and the data-plane Lambda.
- [`INFRASTRUCTURE-COST.md`](../admin/INFRASTRUCTURE-COST.md) - per-piece infrastructure cost model.
- [`MESSAGE-FLOW.md`](MESSAGE-FLOW.md) - where context enters the message path.
- [`SPEC-CONVERSATION-SECURITY.md`](../../specs/identity-access/SPEC-CONVERSATION-SECURITY.md) - tier isolation guarantees.
- [`HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`](HOW-TO-ADD-OR-MANAGE-A-PROFILE.md) - per-tier assistant management.
