---
title: "SPEC: Context sources and stores, and what restricts each one"
status: Partial. The as-built paths are described from code; three paths are named as NOT BUILT and marked inline.
related:
  - "../identity-access/core/SPEC-CONVERSATION-SECURITY.md"
  - "../../../design/decisions/028-vector-store-classification-boundary.md"
  - "../../../design/decisions/012-assistant-config-store-and-drift.md"
  - "../../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md"
  - "../../../guides/developer/RAG.md"
  - "../../capabilities/SPEC-DRIFT-CONVERGENCE.md"
---

# SPEC: Context sources and stores, and what restricts each one

**Status:** Partial. Every path below marked "as built" is described from the code that implements it,
with the file named. Three paths are **NOT BUILT** and say so in place: the external approved-link
allowlist, the two-tier RAG pointer design, and the meetings/operations telemetry sources. ADR-028's
database boundary (sections 5.1 and 5.2) is verified against the deployment; every other guard here is
described from code and inherits the coverage of the document that owns it.

**Coverage:** `e2e/classification-context.spec.ts` - the only test that drives these paths end to end
against a deployment, asserting that a basic turn cannot name content that exists only at a higher
classification, with real `simulate-principal-policy` IAM assertions behind it. It is also what caught
the `platform-knowledge` pollution described in section 1.3, which no unit test could have found: the
IAM boundary was intact and the content arrived by the path that has none.

This is a map of paths owned by other documents, so most rows inherit their coverage rather than
adding any. The Aurora role-and-policy boundary of sections 5.1 and 5.2 is covered by ADR-028's
`verifyClassificationBoundary` data-plane op, run against the live cluster (seven of seven on
2026-08-12, paired with a live retrieval returning content so it cannot pass by matching nothing).
Not covered by any deployed test: the cross-conversation gate of section 7 beyond drift's own e2e, and
every path in section 8, which is not built.

## Problem and who it's for

A team running one assistant platform across clearance levels has to be able to answer two questions
about any sentence the assistant produces: **where did that come from**, and **what would have stopped
it reaching a user who should not see it**. Those questions are hard to answer here because grounding
arrives from eleven different places, through five different stores, guarded by four different
mechanisms that are not equally strong. An auditor asking "how is premium content kept out of a basic
answer" deserves a per-path answer, not a per-layer one.

This is for the security reviewer signing off on the isolation claim, the AI developer adding a new
grounding source (who needs to know which guard their source inherits, and which it does not), and the
operator explaining to a user why the assistant will not surface something the user knows exists.

## The model in one line

**A store holds content; a guard decides who may read it; a path is one store plus one guard.** The
platform's security claim is only as strong as the weakest guard on any path that reaches the model,
and the guards are not interchangeable: an IAM prefix grant survives a wrongly written query, a
database privilege survives a wrongly written filter, a `WHERE` clause survives neither, and a caller
convention survives nothing.

---

## 1. Amazon S3, the attachments bucket

One bucket, five prefixes, and they do not share a guard. The prefix is the boundary, so the key
layout **is** the security model.

### 1.1 `context/{classification}/*` - curated business documents

**Content.** The deployment's own company, product, pricing, FAQ and financial documents, authored or
uploaded by the deployer. In the reference deployment these are the Stratum Technologies fixtures.
Plain text or JSON, one document per object.

**Read by.** `lib/company-context.ts` (`loadCompanyContext`), reached as the `load_company_context`
tool from the in-Lambda Converse tool loop (`async-processor-core.ts`, ADR-011) and from the
Bedrock-Agent action group. Fired only when the model calls the tool, not on every turn.

**Guard: IAM prefix grant.** The calling Lambda's execution role holds `s3:GetObject` only for the
prefixes its classification may read, derived from `registry.contextPrefixesAtOrBelow`, the same
resolver retrieval uses, so a renamed or added classification moves IAM and retrieval together. The
module walks every prefix it knows and returns what it could read; an `AccessDenied` on a higher
classification is the boundary working, and that document is silently omitted.

**Failure direction.** Withholds. A missing grant loses a document; it never gains one.

**Caps.** 8,000 characters per document, 24,000 total, ordered highest classification first so the
caller's own documents survive the budget.

### 1.2 `context/{classification}/_digest.json` - the precomputed digest

**Content.** A short summary of what exists at that classification, built at seed or ingestion time so
the assistant can say what it has without loading it.

**Read by.** `loadContextDigest` / `buildDigestHint`, injected as a hint rather than as content.

**Guard.** Identical IAM prefix grant. It is inside the same tree deliberately: a digest of premium
documents is premium content.

### 1.3 `platform-knowledge/` - the platform's self-knowledge

**Content.** Curated title-plus-summary index of AgentEchelon's own documentation, generated by
`scripts/sync-project-knowledge.mjs`.

**Read by.** `loadPlatformInfo`, exposed as the separate `load_platform_info` tool.

**Guard: prefix separation, not classification.** This sits **outside** the `context/` tree on
purpose, so a question about the company never loads it and a question about the product never loads
company financials. It is readable at every classification, which is the point: every classification
should be able to answer "how does this work?".

**The trap that lives here, and the reason this section exists.** Content readable at every
classification must contain nothing restricted at any classification. On 2026-08-11 the platform
corpus included `SPEC-DEMO-COMPANY.md`, which reproduces the demo org chart and financials to
illustrate what each classification may see. A basic turn then named a person who appears in no basic
context file. The IAM boundary held perfectly; the content simply arrived by the path with no
classification. `sync-project-knowledge.mjs` now excludes that document and **fails the whole run** if
any document bound for this corpus names anyone from the employee directory. The generalisable rule:
**a document about restricted data is itself restricted data.**

### 1.4 `profiles/{profileName}/{configId}/{persona|intentPack}` - profile bodies

**Content.** The assistant's persona prose and its intent pack, moved out of the SSM definition
because SSM's Standard tier caps a parameter value at 4,096 characters while the persona limit is
20,000.

**Read by.** The router and async processor, dereferencing a `personaRef` pointer stored in the SSM
definition (`lib/profile-bodies.ts`).

**Guard: write exclusivity plus read-prefix grant.** Only the manage-profiles role may write; readers
get `GetObject` on the prefix. Keys are **content-addressed by `configId`**, so a body is immutable:
activating or rolling back re-points at bytes that already exist rather than rewriting anything, and
nothing is ever deleted, because an older version's body has to survive for rollback to mean anything.

**Note on scope.** These are per-PROFILE bodies. The per-DEPLOYMENT intent pack and system prompt are
a separate, older mechanism in SSM (see 2.2). Conflating the two makes the size problem look solved
when only one path solves it.

### 1.5 `rag/{sourceType}/{classification}/…` - RAG ingestion input

**Content.** Source documents destined for the vector store. Two corpora ship: `rag/company/…` from
`seed-demo`, and `rag/agentechelon/basic/…` from `sync-project-knowledge.mjs --rag`.

**Read by.** Nothing at turn time. An S3 PutObject event drives `document-ingestion.ts`, which chunks,
embeds and writes to Aurora. **The key path is where a chunk's classification is asserted**: the
segment after the source type, defaulting to the most restrictive classification when absent.

**Guard.** Ingestion-side only. Once embedded, the chunk's protection is the Aurora boundary (section
5), not this prefix. **A document placed under the wrong classification segment is served faithfully
from the wrong classification**, which no table, policy or role fixes. The ingest-side content guard
is a separate and necessary control.

### 1.6 `uploads/` and `generated-docs/{channelId}/` - attachments

**Content.** User-uploaded files in, assistant-generated documents out.

**Guard.** IAM, plus the admin access model: admins open these through a scoped, short-lived, audited
credential-exchange vend with two distinct capabilities (generated docs as archive, user uploads as
moderation), not through a presigning Lambda.

---

## 2. AWS Systems Manager Parameter Store

**Content type: configuration and behaviour, never business data.**

### 2.1 `/{instance}/assistant/{profileName}/definition`

The versioned profile definition: model key, classifier mode, tool allowlist, guardrail selection,
timeouts, limits, and pointers to the bodies in 1.4. One parameter per profile, with SSM versioning
and an `active` label providing the lifecycle.

### 2.2 `${SSM_ROOT}/assistant/{classification}/assistant-intent-pack` and `-system-prompt`

The per-deployment intent taxonomy and system prompt, read by `intent-pack.ts`. These are per
CLASSIFICATION, not per profile, and they sit against the same 4,096-character ceiling that drove 1.4.

**Guard.** IAM on the parameter path, and a single-writer rule: the manage-profiles role owns the
namespace, because a definition and its body are one artifact and a second writer to either is a
second source of truth.

**Failure direction.** Fails closed to the compiled-in seed profile when a definition is absent or
unreadable.

---

## 3. Amazon DynamoDB

### 3.1 `ChannelContextTable` - private per-conversation grounding

**Content.** The participant profile, domain context, extra context blobs and resolved display name:
who the assistant is talking to and what the conversation is about.

**Guard: table-level IAM, and this is the whole reason the table exists.** Amazon Chime SDK channel
Metadata is returned by `DescribeChannel`, which any channel MEMBER may call, so anything placed there
is member-readable. These fields must not be. Only the conversation-create Lambdas may write and only
the assistant handler may read; no end-user or Identity-Pool principal is granted access.

**The rule this encodes, which applies well beyond this table:** channel Metadata is member-WRITABLE
as well as member-readable (users hold `UpdateChannel`), so it may carry routing bits but must never
be the source of private grounding or of trusted state.

**Failure direction.** Reads fail soft to null, degrading to "no host grounding this turn" rather than
erroring the turn. Writes are best-effort: a lost write degrades grounding, it never leaks.

### 3.2 `UserProfileTable` - per-user onboarding facts

**Content.** A durable per-end-user record keyed by Cognito sub: an onboarded flag and the facts
collected during intake. This is why onboarding fires once per user rather than once per conversation.

**Guard.** IAM. Note this is a **reference stand-in, not a system of record**: setting
`USER_PROFILE_SERVICE_ARN` delegates every call to the implementer's own Lambda, and the built-in
table goes unused. The boundary at that point is the implementer's.

**Failure direction.** Fails OPEN to null, so a store outage starts the intake rather than erroring the
turn. That is the right trade for onboarding and would be the wrong one for a classification decision;
the two must not be confused.

### 3.3 Task tables (`AgentTasksTable`, `UserTasksTable`)

**Content.** Durable task state, including the drift confirm/decline task that is opened on detection,
read early on each turn, and closed on resolution.

**Guard.** IAM, plus per-user partitioning.

---

## 4. Amazon Chime SDK Messaging

**This is the only store the platform does not own, and the only authority for two facts:
membership and the channel classification tag.**

### 4.1 Channel history

**Content.** The literal messages of the conversation, with speaker attribution (ADR-027).

**Guard: Amazon Chime SDK channel membership**, enforced by the service. A non-member cannot read a channel, and the
per-user credential is bearer-pinned to their own AppInstanceUser.

### 4.2 Membership, via `SearchChannels … MEMBERS INCLUDES`

**Content.** Which channels a set of principals are all members of.

**Read by.** `lib/scoped-channels.ts`, called by the ROUTER, not by the data-plane.

**Why the router.** Drift executes in `DataPlaneLambda`, VPC-attached in isolated subnets with no NAT,
no internet gateway and no Amazon Chime SDK interface endpoint. An Amazon Chime SDK call from there does not fail, it HANGS
until the function times out. Outside the VPC does the AWS-API work; inside does the database work.

**Why not the Aurora `channel_membership` archive.** That table is a projection the Kinesis path fills
asynchronously, and **both lag directions leak** at exactly the moment the control matters. A member
who joined but has not been projected is left out of the intersection, making the scope WIDER than the
people in the room. A channel someone was removed from but is still projected stays in their set. Per
ADR-012 the archive is never the authority for a live decision, and there is deliberately no fallback
to it: an unresolvable scope suggests nothing.

### 4.3 The channel classification tag

**Content.** The immutable `classification` tag. Every live tier decision reads this tag, not a copy.

**The reachability problem, and where the copy comes from.** Nothing inside the Aurora VPC can read
it. Since nothing that can reach the database can reach Amazon Chime SDK Messaging, the read happens outside and lands in
`channel_classification` (5.4) as a projection, never an authority.

---

## 5. Aurora PostgreSQL with pgvector

**Content type: everything derived. Vectors, summaries, archived messages, analytics.** This is the
store where the guard was historically weakest, and ADR-028 is the correction.

### 5.1 `embeddings` - the document vector store

**Content.** Chunked text of every ingested RAG document, its 1024-dimension Titan v2 embedding, the
source key, and the asserted classification.

**Read by.** `document-retrieval.ts`, on the request path, via the data-plane `retrieve` op. Pre-fetched
by the router before dispatch and passed to the model on the payload, which is why Layer 4's S3 grants
do not gate it.

**Guard: database privilege plus query filter (ADR-028, verified live 2026-08-12).** The query runs
as `ae_reader_{classification}`, and row-level security admits only rows at or below that role's
ladder. The `WHERE metadata->>'classification' = ANY($3)` filter stays as defence in depth. Two
properties are load-bearing and reproduce the original hole if either is wrong: the policies are
`FORCE`d, because Postgres exempts a table's owner and the data-plane connects as the owner; and they
discriminate on `current_user` rather than on a policy role list, because Postgres matches those by
role membership and `SET ROLE` requires the caller to hold it.

**Failure direction.** Withholds, and that is the risk. A policy that admits nothing looks identical to
a corpus with nothing relevant in it, so the verification includes an explicit non-vacuity check.

### 5.2 `summary_embeddings` - conversation summary vectors

**Content.** One embedding per conversation summary, plus the channel's classification.

**Read by.** `drift-detection.ts`, twice: the channel's own anchor, and the related-conversation
cosine-NN lookup.

**Guard: three independent bounds, and none subsumes another** (the classification bound verified live 2026-08-12).
1. **Membership** (4.2): the candidate ARNs, live from Amazon Chime SDK Messaging, enforced inside the `WHERE`.
2. **Classification** (ADR-028): the reader role, so a basic channel cannot see a premium summary.
3. **Similarity threshold**: a floor below which nothing is suggested.

**Why membership alone was not enough.** Two premium-cleared people talking in a BASIC channel have
premium channels in their membership intersection, so drift could point from that basic channel at a
premium one. Nobody learned anything they could not already open, but the platform's model is that the
CHANNEL's classification bounds what may surface in it, which is why the assistant is
classification-scoped per channel. **Membership protects the people; it does not protect the channel.**

### 5.3 `conversation_summaries` - the summary text

**Content.** Purpose, summary prose, topics and key points per conversation, versioned.

**Read by.** The summary injection path, and the drift anchor.

### 5.4 `channel_classification` - the classification projection

**Content.** Channel ARN to classification, plus provenance (`router` for a live turn, `backfill` for
the bulk Amazon Chime SDK enumeration).

**Guard.** None needed: it holds labels, not content. **It is never the authority for a live access
decision.** It supplies the value at WRITE time, and a channel it has never heard of causes the writer
to stamp the most restrictive classification, so the failure withholds.

### 5.5 Archive tables (`messages`, `channel_membership`, `exchanges`, analytics)

**Content.** The durable record of every turn.

**Guard.** No classification partitioning. These feed the admin plane, which gates on
`allowedClassifications` at the query layer and on admin identity at the IAM layer. **These tables are
a lagging projection and are never the authority for a live boundary decision.**

---

## 6. The whole map, as a table

| Source | Store | Content type | Guard | Strength | Fails |
|---|---|---|---|---|---|
| Company documents | S3 `context/{cls}/` | Curated business docs | IAM prefix grant | Infrastructure | Withholds |
| Context digest | S3 `context/{cls}/_digest.json` | Summary of the above | IAM prefix grant | Infrastructure | Withholds |
| Platform self-knowledge | S3 `platform-knowledge/` | Product documentation | Prefix separation only | Content discipline | Leaks if the corpus is polluted |
| Persona / intent pack | S3 `profiles/…` | Behaviour prose | Write exclusivity + read prefix | Infrastructure | Falls back to seed |
| RAG source documents | S3 `rag/{type}/{cls}/` | Ingestion input | Key path asserts classification | Ingest-time only | Serves a mislabel faithfully |
| Attachments | S3 `uploads/`, `generated-docs/` | User and generated files | IAM + credential exchange | Infrastructure | Withholds |
| Profile definition | SSM | Configuration | IAM path + single writer | Infrastructure | Falls back to seed |
| Deployment intent pack | SSM | Taxonomy, system prompt | IAM path | Infrastructure | Falls back to seed |
| Host grounding | DynamoDB `ChannelContext` | Participant and domain context | Table IAM, no user principal | Infrastructure | Soft-null |
| User facts | DynamoDB `UserProfile` | Onboarding record | Table IAM (or delegated) | Infrastructure | **Fails open to null** |
| Channel history | Amazon Chime SDK Messaging | Conversation messages | Amazon Chime SDK membership | Service-enforced | Withholds |
| Membership set | Amazon Chime SDK `SearchChannels` | Channel ARNs | Live service query | Service-enforced | Suggests nothing |
| Document chunks | Aurora `embeddings` | RAG text + vectors | DB role + RLS + filter | Privilege (verified live) | Withholds |
| Summary vectors | Aurora `summary_embeddings` | Summary vectors | Membership + role + threshold | Privilege (verified live) | Withholds |
| Summary text | Aurora `conversation_summaries` | Summary prose | Caller-scoped | Convention | Withholds |
| Archive | Aurora `messages` etc. | Turn record | Admin IAM + query filter | Mixed | N/A, not turn context |

---

## 7. Cross-conversation context, and the UX problem it creates

The gate is three-way, and a conversation is only suggested when **all three** agree:

1. **Every current human member** of this conversation is already a member of that one (ADR-012), live
   from Amazon Chime SDK Messaging, never from the archive.
2. **That conversation's classification is at or below this channel's**, enforced by the reader role.
3. The **similarity** clears the reroute threshold.

Awareness is also deliberately narrower than content: the design surfaces **that** a related
conversation exists and its type, not what is in it. Injecting the summary is a materially larger
decision than turning the lookup on, and it is the one that turns this into a disclosure surface.

### The UX problem, stated plainly

**A correct refusal and a missing result are indistinguishable to the user**, and both look like the
assistant being unhelpful:

- A user knows they discussed something in another conversation. The assistant does not surface it,
  because one other member of the current channel is not in that conversation. From the user's seat
  this reads as the assistant forgetting, not as a privacy control working exactly as designed.
- Adding a member to a conversation **silently narrows** what the assistant can surface, because the
  intersection shrank. Nothing announces it. The assistant appears to have got worse.
- A basic-classification channel cannot be pointed at a premium conversation the user personally has
  access to. The user has the access; the channel does not. That distinction is real, load-bearing,
  and not something a user should be expected to infer.

**This is unresolved and is called out rather than papered over.** The options carry their own risks
and none is obviously right:

- **Say nothing** (today). Safest, and the assistant looks forgetful.
- **Say something generic** ("I can only draw on conversations everyone here is part of"). Better
  mental model, and it confirms to a room that *some* other conversation exists, which is itself a
  disclosure in a channel where members differ.
- **Say something specific** ("there is a related conversation, but not everyone here can see it").
  Clearest, and the worst disclosure: it confirms existence, topic adjacency and an access difference
  in one sentence.

A defensible direction, not yet a decision: make the RULE discoverable without making any particular
RESULT discoverable, by stating the scope up front (at conversation creation, or on member change)
rather than at the moment a suggestion is withheld. That decouples the explanation from the existence
of a specific hit. **Recorded here as an open question; no option is adopted.**

---

## 8. NOT BUILT

Named explicitly so nothing below is mistaken for as-built behaviour.

### 8.1 External approved-link allowlist

**Not built. There is no allowlist of external links, domains or URLs anywhere in the codebase**
(verified by search across `backend/lambda/src`, `backend/lib` and `docs`). The assistant has no
sanctioned outbound-link surface today.

**The intended shape**, per owner direction: a per-classification list of approved external references
held in the classification-specific S3 prefix and therefore inheriting the IAM prefix grant, so a basic
assistant literally cannot read the premium link list. Open questions before this is designed:

- Are links **content** (the assistant may quote the target) or **references** (it may only name the
  URL)? The two need different controls; only the first requires a fetch path, and a fetch path from a
  VPC-attached Lambda is a network decision, not a config one.
- Does an approved link inherit the classification of the **list it appears on**, or of the **content it
  points at**? Those disagree the moment a basic-approved link points at a page that changes.
- Link rot and content drift make a URL a **mutable** reference inside an otherwise immutable-content
  model. An approved link is only as safe as the page was on the day it was approved.

### 8.2 Two-tier RAG: embeddings as keys, detail fetched separately

**Not built.** Today the retrieved chunk text lives in the `embeddings` row itself and is returned
directly.

**The intended shape**: the vector row carries a short chunk plus a **pointer** to fuller content in
Postgres or another store, and retrieval dereferences the pointer only after the classification check.
The benefits are real: a smaller and cheaper vector table, chunk size decoupled from the answer's
detail, and a detailed store that can be governed, retained or audited on its own schedule.

**The one requirement that decides whether this is safe.** The dereference must run under **the same
reader role, inside the same transaction** as the vector query. A pointer resolved by a second,
unroled read reintroduces exactly the gap ADR-028 closes, and it does so invisibly, because the
classification check on the vector row will have passed. If the detail store is not Postgres it must
carry its own equivalent boundary; a pointer into an ungoverned store is an ungoverned read with extra
steps.

### 8.3 Meetings and operations telemetry

**Not built.** No CloudWatch, CloudTrail or other operational source is wired as assistant context.

**The intended shape**: assistants supporting meetings and operational work read CloudWatch Logs,
CloudWatch metrics, CloudTrail events and similar, granted per assistant identity as IAM resources in
the same style as the S3 prefix grants.

**Why this does not simply reuse the existing model.** Operational telemetry is not naturally
partitioned by classification, and this is the hard part of the design rather than a detail of it:

- A log group spans classifications. A single Lambda serves one classification, so its log group is
  classification-aligned, but shared infrastructure (the router, the data-plane, Amazon Chime SDK streaming) is
  not, and a data-plane log line can name a premium channel ARN.
- **CloudTrail is cross-cutting by construction.** It records who did what across the whole account,
  including administrative actions on higher classifications. Granting an assistant CloudTrail read
  grants it a view no content-classification boundary describes.
- Log content is **incidental**, not curated. Nobody reviews a log line for classification before it is
  written, so "the log group is basic" does not make its contents basic. This is the
  `platform-knowledge` trap (1.3) at a much larger scale and without an authoring step at which to
  catch it.
- Metrics are safer than logs, and dimension values are the exception: a metric dimension carrying a
  channel ARN or a classification name leaks structure even when the value is a number.

A plausible direction, recorded as a direction and not a decision: grant **metrics broadly and log
content narrowly**, require per-log-group grants rather than wildcards, and treat CloudTrail as an
admin-plane source that the admin assistant may read and no user-facing assistant may.

---

## 9. Known gaps in this document

- **ADR-028's boundary is verified against the deployment** (2026-08-12, seven of seven, alongside a live retrieval returning content). The runtime connects as a dedicated non-owning database user; as the table owner it was exempt from its own policies for reasons that remain unexplained, so do not reintroduce an owner-connected runtime on the assumption that FORCE covers it.
- **`conversation_summaries` (5.3) has no classification column of its own.** The vectors do; the text
  does not. Any future reader of the text directly needs its own control.
- **Section 7's UX question is open**, and it is a product decision rather than an engineering one.
- **`cross-conversation-context.ts` is HALF wired.** `updateConversationContext` is called by
  `kinesis-archival.ts`, so the `cross_conversation_context` table IS being written; only
  `findRelatedConversations` has no caller, so nothing injects its results into a prompt. The admin
  query over that table therefore returns real accumulating rows, not an empty set. Section 7 describes
  drift's related-conversation lookup, which is a different and genuinely built path.
