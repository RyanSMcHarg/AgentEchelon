# SPEC: Context sources and stores, and what restricts each one

**Status:** Partial. Every path below marked "as built" is described from the code that implements it, with the file named. Three paths are not built and say so in place: the external approved-link allowlist, the two-tier RAG pointer design, and the meetings/operations telemetry sources. ADR-028's database boundary (sections 5.1 and 5.2) is verified against the deployment; every other guard here is described from code and inherits the coverage of the document that owns it.

**Coverage:** `tests/e2e/classification-context.spec.ts` - the only test that drives these paths end to end against a deployment, asserting that a basic turn cannot name content that exists only at a classification its grants do not reach, with real `simulate-principal-policy` IAM assertions behind it. It is also what caught the `platform-knowledge` pollution described in section 1.3, which no unit test could have found: the IAM boundary was intact and the content arrived by the path that has none. `tests/e2e/a-turn-role-is-refused-another-classifications-context-source.spec.ts` asks IAM, of each deployed acting role with the tags a real session carries, for its own catalog (allowed) and for every other classification's catalog and the sources only that catalog publishes (refused), the read a `ctx:` variable makes (ADR-060).

**Related:** [SPEC-CONVERSATION-SECURITY.md](../governance/SPEC-CONVERSATION-SECURITY.md) - the layered access model these paths sit inside. [ADR-028](../../../design/decisions/028-vector-store-classification-boundary.md) - the database boundary on the vector store. [ADR-012](../../../design/decisions/012-assistant-config-store-and-drift.md) - why a live decision never reads the archive. [GUIDE-ASSISTANT-CONTEXT.md](../../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md) and [RAG.md](../../../guides/developer/RAG.md) - the how-to. [SPEC-DRIFT-CONVERGENCE.md](./SPEC-DRIFT-CONVERGENCE.md) - the cross-conversation lookup section 7 bounds.

**Site section:** Interaction layer, assistants.

---

## Overview

**A store holds content; a guard decides who may read it; a path is one store plus one guard.** That is the unit this document is written in, and the reason it exists: the platform's isolation claim is only as strong as the weakest guard on any path that reaches the model, and the guards are not interchangeable. An IAM prefix grant survives a wrongly written query. A database privilege survives a wrongly written filter. A `WHERE` clause survives neither. A caller convention survives nothing. A per-layer answer to "how is content a classification's grants do not reach kept out of its answer" is therefore not an answer; a per-path one is, and the map in Appendix A is that answer.

**The strongest guard on a path is worth nothing if content arrives by a path that has none**, which is the specific trap this document was written around. A corpus readable at more than one classification must contain nothing restricted from any classification that reads it, because the boundary can be perfectly intact while the content walks in beside it. The generalizable rule, and the reason the demo-dataset document is excluded from the platform corpus by a check that fails the run: **a document about restricted data is itself restricted data.**

**A classification is a declared set of grants, not a rank.** Every guard here derives its reach from one resolver over those grants, so IAM, the reader role and the retrieval filter cannot drift apart, and a deployment declaring classifications that do not nest is bounded correctly rather than accidentally. A classification the deployment does not declare is not resolved to a floor: it refuses. `contextScope` admits the single literal `'granted'`, which names exactly that - what this classification's own grants declare - and nothing else.

**Failure direction is a property of each path, and the two directions are never interchangeable.** A guard that withholds costs recall; a guard that fails open costs isolation. Both appear below, deliberately: the per-user profile store fails open to null so that a store outage starts an intake rather than erroring a turn, and that is the right trade for onboarding and would be the wrong one for a classification decision. Appendix A states the direction for every path so the two can never be confused by someone reading only one of them.

## Business Problem

A team running one assistant platform across clearance levels has to be able to answer two questions about any sentence the assistant produced: **where did that come from**, and **what would have stopped it reaching somebody who should not see it**. Both are hard to answer here for a structural reason rather than a sloppy one: grounding legitimately arrives from many places, through five different stores, behind four guard mechanisms of very different strength, and the ones that look alike in a diagram behave completely differently under a mistake. A security reviewer signing off on the isolation claim needs the per-path answer rather than a reassurance about layers, an engineer adding a grounding source needs to know which guard their source inherits and which it does not, and an operator explaining to somebody why the assistant will not surface something they know exists needs to be able to tell a correct refusal from a bug.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Four use this document, and they want different things from the same map: two are adding to it, one is signing it off, and one has to explain it to a person who is disappointed.

### Platform developer

**How this relates to them:** they add and move grounding paths, so their question is which guard a new source inherits by construction and which it does not. This is the audience the store-plus-guard framing exists for: a source added beside an existing one in the same store does not automatically get that store's guard.

| What they need | Requirement |
|---|---|
| One resolver behind every reach decision, so IAM, the reader role and the query filter cannot disagree | FR1, FR4 |
| A store for private per-conversation grounding that no participant can write | FR8 |
| The failure direction of each path stated, so a new path is placed knowingly | FR2, FR9 |
| A selectable source catalog whose publication and grant happen together | FR11 |

### AI developer

**How this relates to them:** they decide what an assistant is grounded in, so they add sources and select among them. Their risk is the quiet one: a source added at the wrong classification is served faithfully from the wrong classification, and nothing errors.

| What they need | Requirement |
|---|---|
| Select which context sources an assistant reaches, by key, portably | FR11 |
| A resolved value treated as data rather than as instructions, and capped so it cannot crowd out the persona | FR12 |
| A source that is not readable yet omitted rather than awaited, and a failure that degrades rather than ending the turn | FR13 |
| The conversation's own classification asserted at ingestion, fail-closed when the path does not say | FR7 |
| An external reference surface an assistant may legitimately cite | FR16 |

### Admin / operator

**How this relates to them:** they answer for what the deployment can reach and for explaining a refusal that reads as forgetfulness. They tune nothing here; they need the rule to be explainable without any particular withheld result becoming visible.

| What they need | Requirement |
|---|---|
| A refusal that is distinguishable from an absence, at least to them | FR9, FR15 |
| The scope rule stated to a room without confirming that a specific other conversation exists | FR15 |
| Confidence that a live decision never reads a lagging copy | FR10 |
| Observability the assistant may legitimately read, bounded by its own identity rather than by the runtime's role | FR18 |

### QA / test engineer

**How this relates to them:** they gate releases on the isolation claim, and the only evidence that counts here is a deny-test against a deployment. A withholding guard and an empty corpus look identical, so a passing isolation test has to prove it withheld something that exists.

| What they need | Requirement |
|---|---|
| A deny-test against the deployed boundary rather than a code review | FR1, FR3 |
| A non-vacuity check beside every withholding assertion | FR3 |
| A non-contiguous grant set exercised, not only a nesting one | FR4 |
| An undeclared classification proven to refuse rather than to fall back | FR5 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | Company documents and their digest are reachable only through an IAM prefix grant derived from the serving classification's declared grants, so a renamed or added classification moves IAM and retrieval together | Table stakes | Yes | `classification-context` (e2e, behavior) - **deny-test** with real `simulate-principal-policy` assertions; `profile-registry` (unit, behavior) |
| FR2 | A prefix guard failure WITHHOLDS: a denied read loses a document and never gains one, and the caller's own documents survive the character budget first | Table stakes | Yes | `company-context-digest` (unit, behavior), `profile-registry` (unit, behavior) for the prefix order |
| FR3 | The document vector store is bounded by a database privilege as well as by a query filter: policies are FORCEd, they discriminate on the connected identity rather than on role membership, and an unrecognized identity resolves to the empty scope | Differentiator | Yes | `classification-boundary` (unit, behavior) - FORCE, current-identity discrimination, empty scope for an unknown identity; `classification-context` (e2e, behavior) |
| FR4 | A reader role reaches exactly the set its classification's grants declare, on every path, including a set that does not nest | Table stakes | Yes | `retrieval-reaches-the-grant-set` (unit, behavior) - the set is asserted genuinely non-contiguous first, so the case cannot pass on a prefix; `classification-boundary` (unit, behavior) |
| FR5 | A classification the deployment does not declare REFUSES rather than resolving to a floor, at every consumer | Table stakes | Yes | `profile-registry` (unit, behavior), `classification-boundary` (unit, behavior) - a missing classification refuses to yield a role name |
| FR6 | A corpus readable at more than one classification contains nothing restricted from any classification that reads it, enforced at authoring time rather than trusted | Differentiator | Yes - the demo-dataset document is excluded from the corpus and the generator exits non-zero if any document bound for it names anyone from the employee directory | `classification-context` (e2e, behavior) - the case that caught the original pollution; `platform-knowledge` (e2e, behavior) for the corpus still answering |
| FR7 | Ingestion asserts a chunk's classification from its key path, and content whose path does not say is stamped fail-closed at the conversational classification the fewest holders reach | Table stakes | Partly - the assertion and the fail-closed default ship; a document placed under the WRONG segment is served faithfully from the wrong classification, and no content-side gate exists at ingest | `document-ingestion-classification` (unit, behavior), `document-ingestion` (unit, behavior) for the ingest path |
| FR8 | Private per-conversation grounding is held where no participant can write it, and no consumer falls back to member-writable channel Metadata | Table stakes | Yes | `channel-context-client` (unit, behavior), `legacy-channel-context` (unit, behavior) - promotion is one-shot and never overwrites the store, `cdk-synth` (unit, behavior) for the table grants |
| FR9 | Each path's failure direction is a deliberate choice: a store whose outage would cost isolation fails closed, one whose outage would only cost a feature fails soft, and the two are never confused | Differentiator | Yes | `host-grounding` (unit, behavior) - a soft null degrades the turn, `user-profile-client` (unit, behavior) - the onboarding store fails open to null by design, `embedding-writer` (unit, behavior) for the fail-closed stamp |
| FR10 | A live membership or classification decision reads the authority rather than a projection, and an unresolvable scope suggests nothing rather than falling back to the archive | Table stakes | Yes | `scoped-channels` (unit, behavior), `a-refused-membership-read-is-not-an-unreadable-one` (unit, behavior) |
| FR11 | A selectable context source catalog is published per classification together with its IAM grant, and a profile selects from it by key, portably across deployments | Differentiator | Yes | `config-context-sources` (unit, behavior), `cdk-synth` (unit, behavior) - publication and grant in one construct, `context-sources` (e2e, behavior), `profile-manifest` (unit, behavior) for the portable selection |
| FR12 | A resolved source value is treated as data and never as instructions: it is marker-stripped, capped, and rendered with its trust level so a member-sourced value cannot read as an operator's | Differentiator | Yes | `context-sources-runtime` (unit, behavior) - sanitization and trust rendering, `context-source-readers` (unit, behavior) |
| FR13 | A source that is not reliably readable at a call site is omitted rather than awaited, and a resolution failure degrades the turn rather than ending it | Table stakes | Yes | `context-sources-runtime` (unit, behavior) - availability, and degrade-do-not-except, `context-source-outcomes` (unit, behavior) |
| FR14 | A cross-conversation suggestion requires all three of live membership of every current human member, the channel classification's own grants, and a similarity floor | Differentiator | Yes | `scoped-channels` (unit, behavior), `classification-boundary` (unit, behavior) for the reader-role bound, `drift-detection` (e2e, behavior) |
| FR15 | The scope RULE is discoverable without any particular withheld RESULT becoming discoverable, so a correct refusal is distinguishable from the assistant forgetting | Gap - prioritize | No - nothing is said today, which is the safest option and the one that reads as unhelpfulness | none |
| FR16 | An assistant may cite external references from a per-classification approved list held inside the classification's own prefix, so it inherits the prefix grant | Above bar - optional | No - no allowlist of external links, domains or URLs exists anywhere in the codebase | none |
| FR17 | A retrieved vector row carries a pointer to fuller content dereferenced only after the classification check, under the same reader role and inside the same transaction | Above bar - optional | No - the chunk text lives in the vector row and is returned directly | none |
| FR18 | An assistant may read this deployment's own operational telemetry, granted per assistant identity and exercised under that identity rather than the runtime's role | Differentiator | Partly - CloudWatch metrics and this deployment's alarm state ship behind one tool for a role whose boundary grants observability reads; Logs Insights and CloudTrail are deliberately not wired, and the classification question for log CONTENT is unsettled | `an-assistant-boundary-refuses-cloudwatch` (e2e, behavior) - **deny-test:** the grant admits the ops role and refuses the primary and an untagged session, and grants reads and never a write; `health-reads-this-deployments-alarms` and `every-alarm-is-published-by-name` (unit), and the deploy matrix's "publishes every alarm it creates by name" (synth), for the alarm read by name |
| FR19 | The summary TEXT carries its own classification control, independent of the summary vectors | Gap - prioritize | No - the vectors carry a classification and the text table has no column of its own, so any future reader of the text directly needs its own control | none |

**Reading the "Validated by" column.** Each entry names one specific test by its filename without the extension, or by the `describe` block where that is the precise unit. Backend unit tests live in `backend/test/`, with the shared-library ones under `backend/test/lib/` and the Aurora ones under `backend/test/analytics-aurora/`; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong value.
- **none** - no test exists, which is expected where `Delivered` is No.

**A row marked deny-test carries the strongest evidence this document has.** Tenet P4 asks for isolation proven by deny-test rather than by code review, so a row whose evidence is only that the allowed path works is weaker than it looks. FR1 and FR18 carry one; FR3's database half is verified against the live cluster through ADR-028's own boundary check, run alongside a live retrieval that returns content so it cannot pass by matching nothing.

**The non-vacuity requirement, stated once because it applies to every withholding row.** A policy that admits nothing looks identical to a corpus with nothing relevant in it, so an isolation assertion that only observes an empty result proves nothing. Every check on a withholding guard here is paired with one that returns content, and FR4's own test asserts its grant set is genuinely non-contiguous before it uses it, so the case cannot be satisfied by a prefix.

**This is a map of paths owned by other documents**, so most rows inherit their coverage rather than adding any. Not covered by any deployed test: FR15, FR16, FR17 and FR19, none of which is built, and the cross-conversation gate of section 7 beyond drift's own end-to-end case.

**OPEN:** whether an approved external link is **content** the assistant may quote or a **reference** it may only name. The two need different controls, only the first requires a fetch path, and a fetch path from a database-attached Lambda is a network decision rather than a configuration one (FR16).

**OPEN:** whether an approved link inherits the classification of the **list it appears on** or of the **content it points at**. Those disagree the moment a link approved at one classification points at a page that changes, which makes a URL a mutable reference inside an otherwise immutable-content model (FR16).

**OPEN:** how log CONTENT is classified, if at all. A log group for one classification's Lambda is classification-aligned, but shared infrastructure is not, and log content is incidental rather than curated - nobody reviews a line for classification before it is written. This is the corpus-pollution trap of section 1.3 at a much larger scale and with no authoring step at which to catch it (FR18).

**OPEN:** whether CloudTrail belongs to any user-facing assistant. It records who did what across the whole account, including administrative actions above the reading assistant's own reach, so granting it grants a view no content classification describes. The direction on record, not a decision: grant metrics broadly and log content narrowly, require per-log-group grants rather than wildcards, and treat CloudTrail as an admin-plane source (FR18).

**OPEN:** whether a connector may back a catalog source. `ContextSourceType` admits `s3-prefix`, `dynamodb-table`, `lambda-service` and `ssm-parameter` and deliberately no `connector` member, because connectors are declared per conversation type while sources are published per classification, which is the isolation boundary. See [SPEC-CONNECTORS.md](../../communication/SPEC-CONNECTORS.md).

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| The layered access model itself | This document maps paths inside that model rather than defining it. A per-path answer is what it adds; the layers are somebody else's specification | [SPEC-CONVERSATION-SECURITY.md](../governance/SPEC-CONVERSATION-SECURITY.md) |
| A content-side classification gate at ingestion | Real and necessary, and a separate control: the key path asserts a classification, and no table, policy or role can correct a document filed under the wrong one | FR7 states the limit; the ingest-side content guard is its own work |
| Reading current conversation state from a projection | A projection inherits its pipeline's lag, and at read time that is indistinguishable from the conversation having been quiet. Both lag directions leak at exactly the moment the control matters | FR10, tenet D7, and [ADR-012](../../../design/decisions/012-assistant-config-store-and-drift.md) |
| An Amazon Chime SDK call from inside the database VPC | It does not fail, it HANGS until the function times out - there is no interface endpoint and no route out. Outside the VPC does the AWS-API work; inside does the database work | Appendix A, section 4.2 |
| A classification partition on the archive tables | They feed the admin plane, which gates on the caller's allowed classifications at the query layer and on admin identity at the IAM layer. They are a lagging projection and never the authority for a live boundary decision | [SPEC-ADMIN-IDENTITY.md](../governance/SPEC-ADMIN-IDENTITY.md) |
| A presigning Lambda for attachments | An operator opens an attachment through a scoped, short-lived, audited credential vend with two distinct capabilities, which is narrower and leaves a record a presigned URL does not | [SPEC-ADMIN-IDENTITY.md](../governance/SPEC-ADMIN-IDENTITY.md), [SPEC-CREDENTIAL-EXCHANGE.md](../governance/SPEC-CREDENTIAL-EXCHANGE.md) |
| Injecting a related conversation's SUMMARY rather than its existence | A materially larger decision than turning the lookup on, and the one that turns this into a disclosure surface | FR14, FR15 |
| Telling a person exactly which related conversation was withheld | It would confirm existence, topic adjacency and an access difference in one sentence, in a room whose members differ | FR15 |
| A general-purpose knowledge-base product | The stores here are what the platform needs to ground a turn and to prove it did so within a boundary. A workbench over the same corpus is commodity tooling attached to the archive | [RAG.md](../../../guides/developer/RAG.md) |

## User Experience Description and Mocks

**This document has no surface, and the one thing a person experiences from it is a refusal they cannot distinguish from an absence.** That is the whole user-experience problem, and it is stated here rather than solved.

- Somebody knows they discussed something in another conversation. The assistant does not surface it, because one other member of this conversation is not in that one. From where they sit this reads as the assistant forgetting, not as a privacy control working exactly as designed.
- Adding a member to a conversation **silently narrows** what the assistant can surface, because the intersection shrank. Nothing announces it, so the assistant appears to have got worse.
- A conversation cannot be pointed at another whose classification its own grants do not cover, even when the person asking personally reaches it. They have the access; the conversation does not. That distinction is real, load-bearing, and not something anyone should be expected to infer.

**The options carry their own risks and none is obviously right** (FR15):

| Option | What it buys | What it costs |
|---|---|---|
| Say nothing, which is today | The safest disclosure posture | The assistant looks forgetful, and an operator cannot tell a refusal from a bug either |
| Say something generic - "I can only draw on conversations everyone here is part of" | A correct mental model, once | It confirms to a room that *some* other conversation exists, which is itself a disclosure where members differ |
| Say something specific - "there is a related conversation, but not everyone here can see it" | The clearest explanation | The worst disclosure: existence, topic adjacency and an access difference in one sentence |

**A defensible direction, not yet a decision:** make the RULE discoverable without making any particular RESULT discoverable, by stating the scope up front - at conversation creation, or when membership changes - rather than at the moment a suggestion is withheld. That decouples the explanation from the existence of a specific hit.

**OPEN:** this document carries no mocks, and the surface worth drawing is the one in the table above, which has not been chosen yet.

## Related Documents

- [SPEC-CONVERSATION-SECURITY.md](../governance/SPEC-CONVERSATION-SECURITY.md) - the layered access model these paths sit inside
- [SPEC-WELCOME-AND-CONTEXT.md](./SPEC-WELCOME-AND-CONTEXT.md) - the whole per-turn context inventory, and the welcome that reads part of it
- [SPEC-CONNECTORS.md](../../communication/SPEC-CONNECTORS.md) - reading a system of record live, and why no catalog source is connector-backed yet
- [SPEC-DRIFT-CONVERGENCE.md](./SPEC-DRIFT-CONVERGENCE.md) - the cross-conversation lookup section 7 bounds
- [SPEC-AURORA-VPC-MODE.md](../../foundations/SPEC-AURORA-VPC-MODE.md) - the deployment mode the vector store and the reader roles require
- [SPEC-CAPABILITY-PROFILES.md](./SPEC-CAPABILITY-PROFILES.md) - classifications as declared grant sets, and the one module that interprets a classification value
- [SPEC-PORTABLE-PROFILES.md](./SPEC-PORTABLE-PROFILES.md) - the profile bodies of section 1.4, and the portable source selection of FR11
- [ADR-028](../../../design/decisions/028-vector-store-classification-boundary.md) - the database boundary on the vector store
- [ADR-012](../../../design/decisions/012-assistant-config-store-and-drift.md) - why a live decision never reads the archive
- [GUIDE-ASSISTANT-CONTEXT.md](../../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md) and [RAG.md](../../../guides/developer/RAG.md) - the how-to for adding and operating a source
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above
- [TENETS.md](../../../overview/TENETS.md) - tenet P4 for the layering and the deny-test, tenet D7 for one source per question

## Appendix A - The path-by-path map

Section numbers here are cited from source comments and are stable. Each subsection names a store, its content, who reads it, the guard, and the direction its guard fails in.

### 1. Amazon S3, the attachments bucket

One bucket, five prefixes, and they do not share a guard. The prefix is the boundary, so the key layout **is** the security model.

#### 1.1 `context/{classification}/*` - curated business documents

**Content.** The deployment's own company, product, pricing, FAQ and financial documents, authored or uploaded by the deployer. In the reference deployment these are the Stratum Technologies fixtures. Plain text or JSON, one document per object.

**Read by.** `backend/lambda/src/lib/company-context.ts`, reached as the `load_company_context` tool from the in-Lambda Converse tool loop (`backend/lambda/src/lib/async-processor-core.ts`, ADR-011). Fired only when the model calls the tool, not on every turn.

**Guard: IAM prefix grant.** The calling Lambda's execution role holds `s3:GetObject` only for the prefixes its classification may read. Those prefixes come from the ONE resolver the IAM statement generator and the retrieval walk both consume - `contextPrefixesGranted` in `backend/lib/profile-registry.ts`, which maps the classification's declared `grants` to `context/{value}/` - so a renamed or added classification moves IAM and retrieval together rather than apart. The module walks every prefix it knows and returns what it could read; an `AccessDenied` on a classification this one does not grant is the boundary working, and that document is silently omitted.

**Failure direction.** Withholds. A missing grant loses a document; it never gains one.

**Caps.** 8,000 characters per document, 24,000 total, ordered so the caller's own documents survive the budget first.

#### 1.2 `context/{classification}/_digest.json` - the precomputed digest

**Content.** A short summary of what exists at that classification, built at seed or ingestion time so the assistant can say what it has without loading it.

**Read by.** The digest loader and hint builder in `backend/lambda/src/lib/company-context.ts`, injected as a hint rather than as content. The underscore prefix keeps it out of ordinary document loads.

**Guard.** The identical IAM prefix grant. It is inside the same tree deliberately: a digest of restricted documents is restricted content.

#### 1.3 `platform-knowledge/{classification}/` - the platform's self-knowledge

**Content.** Two files generated by `backend/scripts/sync-project-knowledge.mjs`: `platform-knowledge/standard/agentechelon-about.json`, a curated title-plus-summary index of the platform's own documentation, and `platform-knowledge/basic/agentechelon-about.json`, a public overview (project, license, author, repository, purpose, overview) with no document index.

**Read by.** The platform-info loader, exposed as the separate `load_platform_info` tool. `loadPlatformInfo` (`company-context.ts`) reads `platform-knowledge/{c}/` for each classification `c` that `ProfileRegistry.grantsFor` returns for the caller's classification, as the assistant: the loader's client is the turn's vended session.

**Guard: prefix separation and an IAM prefix grant.** This sits **outside** the `context/` tree on purpose, so a question about the company never loads it and a question about the product never loads company financials. It is keyed by classification because the platform's documentation is internal material: the acting role's `ContextS3Read` (`platformGrantedPrefixes` in `assistant-profile-stack.ts`) and the vended session's `platform` edge (`PLATFORM_PREFIXES` in `agent-classification-common.ts`) grant `platform-knowledge/{c}/*` only for the classifications the caller's grants include. Basic, the external classification, can say what the platform is and does; it cannot read how it is built. The RAG copy of the documentation is ingested under `rag/agentechelon/standard/`, so row-level security applies the same scope to retrieval.

**The trap that lives here, and the reason this section exists.** Content readable at several classifications must contain nothing restricted from any classification that reads it. [SPEC-DEMO-COMPANY.md](../../demos/SPEC-DEMO-COMPANY.md) reproduces the demo org chart and financials to illustrate what each classification may see, so a copy of it in the platform corpus lets a turn name a person who appears in no context file its classification reads - the IAM boundary holds perfectly while the content arrives by the path with none. The generator therefore excludes that document, indexes only git-tracked documents so a private working file cannot reach a corpus several classifications read, and **exits non-zero** if any document bound for this corpus names anyone from the employee directory. The generalizable rule: **a document about restricted data is itself restricted data.**

#### 1.4 `profiles/{profileName}/{configId}/{persona|intentPack}` - profile bodies

**Content.** The assistant's persona prose and its intent pack, moved out of the SSM definition because SSM's Standard tier caps a parameter value at 4,096 characters while the persona limit is 20,000.

**Read by.** The router and async processor, dereferencing a pointer stored in the SSM definition (`backend/lambda/src/lib/profile-bodies.ts`).

**Guard: write exclusivity plus read-prefix grant.** Only the profile writer's role (`manage-profiles.ts`) may write; readers get `GetObject` on the prefix. Keys are **content-addressed by `configId`**, so a body is immutable: activating or rolling back re-points at bytes that already exist rather than rewriting anything, and nothing is ever deleted, because an older version's body has to survive for rollback to mean anything.

**Note on scope.** These are per-PROFILE bodies. The per-DEPLOYMENT intent pack and system prompt are a separate, older mechanism in SSM (see 2.2). Conflating the two makes the size problem look solved when only one path solves it.

#### 1.5 `rag/{sourceType}/{classification}/…` - RAG ingestion input

**Content.** Source documents destined for the vector store. Two corpora ship: the company documents written by the demo seed, and the platform corpus written by the knowledge generator.

**Read by.** Nothing at turn time. An S3 `PutObject` event drives `backend/lambda/src/analytics-aurora/document-ingestion.ts`, which chunks, embeds and writes to the database. **The key path is where a chunk's classification is asserted**: the segment after the source type. Content whose path carries no recognized classification is stamped at the conversational classification the fewest holders reach, derived by counting reach from the declared grants rather than read off a rank, so adding a classification tightens this default instead of silently leaving untagged content readable at a classification the fewest holders reach.

**Guard.** Ingestion-side only. Once embedded, the chunk's protection is the database boundary of section 5, not this prefix. **A document placed under the wrong classification segment is served faithfully from the wrong classification**, which no table, policy or role fixes (FR7). The ingest-side content guard is a separate and necessary control.

#### 1.6 `uploads/` and `generated-docs/{channelId}/` - attachments

**Content.** Uploaded files in, assistant-generated documents out.

**Guard.** IAM, plus the admin access model: an operator opens these through a scoped, short-lived, audited credential vend with two distinct capabilities - generated documents as archive, uploads as moderation - rather than through a presigning Lambda.

### 2. AWS Systems Manager Parameter Store

**Content type: configuration and behavior, never business data.**

#### 2.1 `/{instance}/assistant/{profileName}/definition`

The versioned profile definition: model bundle, tool allowlist, guardrail selection, intent pack and persona (by pointer), onboarding, boundary, copy, welcome, display name, workflow selection, context-source selection, and pointers to the bodies in 1.4. One parameter per profile, with SSM versioning and an `active` label providing the lifecycle. The classifier mode, the timeout and the rate limit are deploy-owned and are not on it.

**Guard.** IAM on the parameter path, and a single-writer rule: the profile writer's role (`manage-profiles.ts`) owns the namespace, because a definition and its body are one artifact and a second writer to either is a second source of truth.

**Failure direction.** Fails closed to the compiled-in seed profile when a definition is absent or unreadable.

#### 2.2 `${SSM_ROOT}/assistant/{classification}/assistant-intent-pack` and `-system-prompt`

The per-deployment intent taxonomy and system prompt, read by `backend/lambda/src/lib/intent-pack.ts`. These are per CLASSIFICATION rather than per profile. The system prompt sits against the same 4,096-character boundary that drove 1.4. The intent pack does not: its parameter holds a pointer to a content-addressed body at `classification-packs/{classification}/{sha256}/intentPack` in the attachments bucket (`backend/lambda/src/lib/profile-bodies.ts`), and an inline pack in the parameter still reads.

**Guard.** IAM on the parameter path, and on the pack body's prefix, which names the classification: its own functions read it and no other classification's do, and only its deploy-time writer puts a body there. The reader refuses a pointer outside its own classification's prefix and a body whose hash is not its id. The parameter is written by the deploy context, by the seeder or by hand, so it is deploy-time configuration rather than a runtime write path.

**Failure direction.** The pack falls back to the platform default when the parameter is absent, unparseable or wholly invalid, or when its pointer is refused or its body cannot be read, and the system prompt to the environment value or the compiled-in default; both log the fallback.

#### 2.3 `${SSM_ROOT}/assistant/{classification}/context-sources` - the published source catalog

**Content.** The selectable context sources a deployment offers at that classification: for each entry a stable key, a human title, what it contains, the situation to reach for it in, its type, the locator a reader needs, its trust level, the earliest point it is reliably readable, a byte cap, and its fields. Account-qualified ARNs are stripped before publication, so nothing here travels in a profile export.

**Read by.** `backend/lambda/src/lib/context-sources-runtime.ts` at turn time, resolving only the keys the active profile version selected, through the readers in `backend/lambda/src/lib/context-source-readers.ts`.

**Guard: IAM on the parameter path, plus the exact-ARN grant published beside it.** Publication and grant happen in the same construct, because a published key without its grant fails at runtime, and that failure fails OPEN in the sense that matters: the surface advertises reach the role does not have. Publishing the locator grants nothing on its own - IAM is the gate, and a catalog naming a resource the role cannot read simply fails closed.

**Failure direction.** Withholds, per source. A source whose availability is unmet at a call site is omitted rather than awaited; a source that fails to resolve degrades the turn and is recorded as an outcome rather than ending it (FR13).

### 3. Amazon DynamoDB

#### 3.1 `ChannelContextTable` - private per-conversation grounding

**Content.** Who the assistant is talking to and what the conversation is about, as `OWNED_FIELDS` in `backend/lambda/src/lib/channel-context-client.ts` declares: the participant profile, domain context, extra context blobs and resolved display name; the routing signals `userLanguage` and `segment`; the participant shape and the member identity hints; the carry-over the welcome renders; and an onboarding intake in progress. A field outside that list is discarded on write.

**Guard: table-level IAM, and this is the whole reason the table exists.** Channel `Metadata` is returned by `DescribeChannel`, which any channel MEMBER may call, so anything placed there is member-readable. These fields must not be. The conversation-create Lambdas, the member-add Lambda, the conversation-split Lambda and the agent handler may write; each holds at most `GetItem` and `UpdateItem` on this table and nothing wider, so a caller patches the fields the store owns and can neither replace nor enumerate a row. The conversation-create and member-add roles hold `UpdateItem` alone, since each only ever upserts the one conversation's grounding; the agent handler and the conversation-split Lambda hold both. No principal holds `PutItem`, `DeleteItem`, `Scan` or `Query`, and no end-user or identity-pool principal is granted access at all.

**The rule this encodes, which applies well beyond this table:** channel `Metadata` is member-WRITABLE as well as member-readable, so it may carry routing bits but must never be the source of private grounding or of trusted state.

**Failure direction.** Reads fail soft to null, degrading to "no host grounding this turn" rather than erroring the turn. Writes are best-effort: a lost write degrades grounding, it never leaks.

**Migration.** Every writer of the grounding and routing fields is on a conversation-create or member-add path, so a conversation predating the move out of channel `Metadata` has no row and is served ungrounded, on the deployment's default model and language. `backend/lambda/src/lib/host-grounding.ts` reports each such turn - channel and key names, never values - and does not fall back to `Metadata`. Recovery is the one-shot `backend/scripts/backfill-channel-context.ts`, run by an operator: it promotes what `Metadata` still carries, re-bounded and marker-stripped, never overwriting a row the store already owns. A channel whose `Metadata` has since been rewritten without those fields is not recoverable from any source.

#### 3.2 `UserProfileTable` - per-user onboarding facts

**Content.** A durable per-person record keyed by their identity: an onboarded flag and the facts collected during intake. This is why onboarding fires once per person rather than once per conversation.

**Guard.** IAM. Note this is a **reference stand-in, not a system of record**: setting `USER_PROFILE_SERVICE_ARN` delegates every call to the implementer's own Lambda, and the built-in table goes unused. The boundary at that point is the implementer's.

**Failure direction.** Fails OPEN to null, so a store outage starts the intake rather than erroring the turn. That is the right trade for onboarding and would be the wrong one for a classification decision; the two must not be confused (FR9).

#### 3.3 Task tables

**Content.** Durable task state, including the drift confirm-or-decline task that is opened on detection, read early on each turn, and closed on resolution.

**Guard.** IAM, plus per-user partitioning.

### 4. Amazon Chime SDK Messaging

**This is the only store the platform does not own, and the only authority for two facts: membership and the channel classification tag.**

#### 4.1 Channel history

**Content.** The literal messages of the conversation, with speaker attribution (ADR-027).

**Guard: Amazon Chime SDK channel membership**, enforced by the service. A non-member cannot read a channel, and the per-user credential is bearer-pinned to their own AppInstanceUser.

#### 4.2 Membership, via a members-include channel search

**Content.** Which channels a set of principals are all members of.

**Read by.** `backend/lambda/src/lib/scoped-channels.ts`, called by the ROUTER rather than by the data plane.

**Why the router.** Drift executes in the data-plane Lambda, VPC-attached in isolated subnets with no NAT, no internet gateway and no Amazon Chime SDK interface endpoint. An Amazon Chime SDK call from there does not fail, it HANGS until the function times out. Outside the VPC does the AWS-API work; inside does the database work.

**Why not the archived membership table.** That table is a projection the streaming path fills asynchronously, and **both lag directions leak** at exactly the moment the control matters. A member who joined but has not been projected is left out of the intersection, making the scope WIDER than the people in the room. A channel someone was removed from but is still projected stays in their set. Per ADR-012 the archive is never the authority for a live decision, and there is deliberately no fallback to it: an unresolvable scope suggests nothing.

#### 4.3 The channel classification tag

**Content.** The immutable `classification` tag. Every live classification decision reads this tag, not a copy.

**The reachability problem, and where the copy comes from.** Nothing inside the database VPC can read it, and nothing that can reach the database can reach Amazon Chime SDK Messaging, so the read happens outside and lands in the projection of 5.4 - a projection, never an authority.

### 5. Aurora PostgreSQL with pgvector

**Content type: everything derived. Vectors, summaries, archived messages, analytics.** This is the store where the guard was historically weakest, and ADR-028 is the correction.

#### 5.1 `embeddings` - the document vector store

**Content.** Chunked text of every ingested document, its embedding, a generated lexical index of the text (`content_tsv`, schema 081), the source key, and the asserted classification.

**Read by.** `backend/lambda/src/analytics-aurora/document-retrieval.ts`, on the request path, via the data-plane retrieve operation. Fetched by the processor (`turn-grounding.ts`) and passed to the model in the system prompt, which is why the S3 grants of 1.1 do not gate it. Chunks are ranked by hybrid retrieval, a vector leg and a lexical leg fused by reciprocal rank fusion ([RAG.md](../../../guides/developer/RAG.md#ranking-hybrid-retrieval)).

**Guard: database privilege plus query filter (ADR-028, verified against the deployment).** The query runs as a per-classification reader role, and row-level security admits only rows whose classification is in the set that role's classification **declares**, resolved from the same `grants` resolver IAM's channel condition and the S3 prefixes use. The classification predicate in the query stays as defense in depth, on every read of the table in the statement, both retrieval legs included. Three properties are load-bearing and reproduce the original hole if any is wrong: the policies are `FORCE`d, because Postgres exempts a table's owner and the data plane once connected as the owner; they discriminate on the connected identity rather than on a policy role list, because Postgres matches those by role membership and assuming a role requires the caller to hold it; and the scope function resolves any identity that is not a declared reader role to the EMPTY set, so a future Lambda connecting as something else matches no row rather than matching everything.

**Why the scope is the grant set and not a rank walk.** This branch once asked the ORDER question while the IAM and S3 generators had moved to the declared grants. Identical output for a nesting configuration, and silently divergent the moment a deployment declares a set that does not nest: IAM would let a holder act on a conversation and read its documents while this function withheld the same classification from their reader role, so retrieval returned nothing with no error anywhere - one boundary meaning two things depending on which half evaluated the request (FR4).

**Failure direction.** Withholds, and that is the risk. A policy that admits nothing looks identical to a corpus with nothing relevant in it, so the verification includes an explicit non-vacuity check.

#### 5.2 `summary_embeddings` - conversation summary vectors

**Content.** One embedding per conversation summary, plus the conversation's classification.

**Read by.** `backend/lambda/src/analytics-aurora/drift-detection.ts`, twice: the conversation's own anchor, and the related-conversation nearest-neighbor lookup.

**Guard: three independent bounds, and none subsumes another** (the classification bound verified against the deployment).

1. **Membership** (4.2): the candidate ARNs, live from Amazon Chime SDK Messaging, enforced inside the query.
2. **Classification** (ADR-028): the reader role, so a conversation cannot see a summary at a classification its own grants do not cover.
3. **Similarity threshold**: a floor below which nothing is suggested.

**Why membership alone is not enough.** Two people whose clearances both reach a classification the room's grants do not have channels at that classification in their membership intersection, so drift could point from that conversation at one of them. Nobody learns anything they could not already open, but the platform's model is that the CONVERSATION's classification bounds what may surface in it, which is why the assistant is classification-scoped per conversation. **Membership protects the people; it does not protect the conversation.**

**Failure direction.** Withholds. When neither the caller nor the projection answers, the writer stamps the conversational classification the fewest holders reach and logs it distinguishably, so the summary keeps its anchor and is readable only by a classification that could already see everything - the failure costs recall rather than isolation.

#### 5.3 `conversation_summaries` - the summary text

**Content.** Purpose, summary prose, topics and key points per conversation, versioned.

**Read by.** The summary injection path, and the drift anchor.

**Guard.** Caller-scoped, which is the weakest kind here. The vectors carry a classification column and this text does not, so any future reader of the text directly needs its own control (FR19).

#### 5.4 `channel_classification` - the classification projection

**Content.** Channel ARN to classification, plus provenance: one value for a live turn, another for the bulk enumeration backfill.

**Guard.** None needed: it holds labels, not content. **It is never the authority for a live access decision.** It supplies the value at WRITE time, and a channel it has never heard of causes the writer to stamp fail-closed, so the failure withholds.

#### 5.5 Archive tables

**Content.** The durable record of every turn: messages, membership, exchanges and analytics.

**Guard.** No classification partitioning. These feed the admin plane, which gates on the caller's allowed classifications at the query layer and on admin identity at the IAM layer. **These tables are a lagging projection and are never the authority for a live boundary decision.**

### 6. The whole map, as a table

| Source | Store | Content type | Guard | Strength | Fails |
|---|---|---|---|---|---|
| Company documents | S3 `context/{cls}/` | Curated business documents | IAM prefix grant | Infrastructure | Withholds |
| Context digest | S3 `context/{cls}/_digest.json` | Summary of the above | IAM prefix grant | Infrastructure | Withholds |
| Platform self-knowledge | S3 `platform-knowledge/{cls}/` | Product documentation | IAM prefix grant, plus content discipline | Infrastructure for scope, content discipline for pollution | Withholds; leaks if the corpus is polluted |
| Persona and intent pack | S3 `profiles/…` | Behavior prose | Write exclusivity plus read prefix | Infrastructure | Falls back to the seed |
| RAG source documents | S3 `rag/{type}/{cls}/` | Ingestion input | Key path asserts the classification | Ingest-time only | Serves a mislabel faithfully |
| Attachments | S3 `uploads/`, `generated-docs/` | Uploaded and generated files | IAM plus the credential vend | Infrastructure | Withholds |
| Profile definition | SSM | Configuration | IAM path plus single writer | Infrastructure | Falls back to the seed |
| Deployment intent pack | SSM | Taxonomy, system prompt | IAM path | Infrastructure | Falls back to the platform default pack |
| Source catalog | SSM `…/context-sources` | Selectable source declarations | IAM path plus the exact-ARN grant published with it | Infrastructure | Withholds, per source |
| Host grounding | DynamoDB channel context | Participant and domain context | Table IAM, no user principal | Infrastructure | Soft null |
| User facts | DynamoDB user profile | Onboarding record | Table IAM, or delegated | Infrastructure | **Fails open to null** |
| Channel history | Amazon Chime SDK Messaging | Conversation messages | Amazon Chime SDK membership | Service-enforced | Withholds |
| Membership set | Amazon Chime SDK channel search | Channel ARNs | Live service query | Service-enforced | Suggests nothing |
| Document chunks | Aurora `embeddings` | Text plus vectors | Reader role, row-level security, filter | Privilege, verified live | Withholds |
| Summary vectors | Aurora `summary_embeddings` | Summary vectors | Membership, reader role, threshold | Privilege, verified live | Withholds |
| Summary text | Aurora `conversation_summaries` | Summary prose | Caller-scoped | Convention | Withholds |
| Deployment telemetry | Amazon CloudWatch metrics | Counters for one bounded window | The assistant's own identity, per-role boundary | Infrastructure, deny-tested | Says the figure is unavailable |
| Archive | Aurora message and analytics tables | Turn record | Admin IAM plus query filter | Mixed | Not turn context |

## Appendix B - Cross-conversation context

### 7. The three-way gate, and the disclosure question it raises

A conversation is only suggested when **all three** agree (FR14):

1. **Every current human member** of this conversation is already a member of that one (ADR-012), live from Amazon Chime SDK Messaging, never from the archive.
2. **That conversation's classification is within the set this conversation's classification grants**, enforced by the reader role.
3. The **similarity** clears the reroute threshold.

Awareness is also deliberately narrower than content: the design surfaces **that** a related conversation exists and its type, not what is in it. Injecting the summary is a materially larger decision than turning the lookup on, and it is the one that turns this into a disclosure surface.

The user-experience consequence, the three options and the direction on record are in the User Experience section above rather than here, because it is a product decision rather than an engineering one.

## Appendix C - The intended shape of three paths

### 8. Three paths whose design is recorded here, each named so nothing below reads as as-built behavior

#### 8.1 External approved-link allowlist

**There is no allowlist of external links, domains or URLs anywhere in the codebase** (verified by search across `backend/lambda/src`, `backend/lib` and `docs`). The assistant has no sanctioned outbound-link surface (FR16).

**The intended shape**, per owner direction: a per-classification list of approved external references held in the classification's own S3 prefix and therefore inheriting the IAM prefix grant, so an assistant cannot read a link list its grants do not cover. Three questions decide the design and are recorded as OPEN above: whether a link is content or a reference, which classification an approved link inherits, and what link rot does to a mutable reference inside an otherwise immutable-content model.

#### 8.2 Two-tier RAG: embeddings as keys, detail fetched separately

Today the retrieved chunk text lives in the `embeddings` row itself and is returned directly (FR17).

**The intended shape**: the vector row carries a short chunk plus a **pointer** to fuller content, and retrieval dereferences the pointer only after the classification check. The benefits are real - a smaller and cheaper vector table, chunk size decoupled from the answer's detail, and a detailed store that can be governed, retained or audited on its own schedule.

**The one requirement that decides whether this is safe.** The dereference must run under **the same reader role, inside the same transaction** as the vector query. A pointer resolved by a second, unroled read reintroduces exactly the gap ADR-028 closes, and it does so invisibly, because the classification check on the vector row will have passed. If the detail store is not the same database it must carry its own equivalent boundary; a pointer into an ungoverned store is an ungoverned read with extra steps.

#### 8.3 Meetings and operations telemetry

One narrow path exists and the rest does not (FR18). `backend/lambda/src/lib/deployment-health.ts` reads this deployment's own CloudWatch Lambda metrics - invocations, errors, throttles and average duration - for a bounded window, and this deployment's own CloudWatch alarms in `ALARM` or `INSUFFICIENT_DATA` (name, state, reason and since when, capped at 20 and 10, labeled as data rather than instructions), exposed as a tool in the Converse loop. The alarm read is `DescribeAlarms` granted on this deployment's alarm ARNs rather than `*` (`deploymentAlarmNamePrefixes` in `agent-classification-common.ts`). CloudWatch authorizes a listing call against `alarm:*` and a call that names its alarms against each alarm's ARN, so the tool asks by name only (`AlarmNames`, 100 per call), and the names come from the deployment: every stack publishes the alarms it declares under `<SSM root>/alarms/` (`publishAlarmNames`, `lib/constructs/alarm-names.ts`), which the ops session reads (`RoleObservabilityAlarmNames`). A published name with no alarm behind it is skipped, and a refused or failed read is reported as unavailable beside the metrics, never as no alarms.

**Evidence (development deployment, 2026-10-28).** A temporary role holding exactly `cloudwatch:DescribeAlarms` on `arn:aws:cloudwatch:us-east-1:<account>:alarm:AgentEchelonAssistants-*` and `...:alarm:AgentEchelon-*` (deleted afterwards). `aws cloudwatch describe-alarms --alarm-name-prefix AgentEchelonAssistants-`, the same with `--state-value`, and `describe-alarms` with no filter were each refused: `not authorized to perform cloudwatch:DescribeAlarms on resource: arn:aws:cloudwatch:us-east-1:<account>:alarm:*`. `aws cloudwatch describe-alarms --alarm-names AgentEchelonAssistants-premium-context-source-failure-rate AgentEchelonAssistants-premium-typed-conversation-events-undelivered` was allowed and returned both alarms, each in state `OK`. A listing call is therefore authorized against `alarm:*` and a named call against each alarm's ARN, which is why the tool never lists. It runs **under the assumed assistant identity and never under the ambient Lambda role**, with no fallback: one shared runtime serves every role a classification declares, and that runtime's own role holds no observability grant, so requiring the assistant identity is what keeps the per-role boundary honest rather than decorative. `tests/e2e/an-assistant-boundary-refuses-cloudwatch.spec.ts` is the deny-test: the grant admits the role whose boundary declares it, refuses the classification's primary assistant and an untagged session, and grants reads and never a write.

**Not wired: Logs Insights, CloudTrail, and any other operational source.** Metrics answer "is it healthy" in one bounded call with no scan cost and no risk of returning message content. A logs query is asynchronous - start, poll, read - so it needs the turn to wait or to come back, and it can surface lines that may contain conversation content, which is a different question from a counter.

**Why the rest does not simply reuse the existing model**, which is the hard part of the design rather than a detail of it:

- A log group spans classifications. A single Lambda serves one classification, so its log group is classification-aligned, but shared infrastructure is not, and a data-plane log line can name a channel at any classification.
- **CloudTrail is cross-cutting by construction.** It records who did what across the whole account, including administrative actions above the reading assistant's own reach. Granting it grants a view no content classification describes.
- Log content is **incidental**, not curated. Nobody reviews a log line for classification before it is written, so "the log group is basic" does not make its contents basic. This is the corpus-pollution trap of 1.3 at a much larger scale and without an authoring step at which to catch it.
- Metrics are safer than logs, and dimension values are the exception: a dimension carrying a channel ARN or a classification name leaks structure even when the value is a number.

## Appendix D - Known limits of this document

### 9. What a reader should not over-read

- **ADR-028's boundary is verified against the deployment**, with every check passing alongside a live retrieval that returns content. The runtime connects as a dedicated non-owning database user: an owner-connected runtime is exempt from the table's own policies, so an owner-connected runtime is not to be reintroduced on the assumption that `FORCE` covers it.
- **`conversation_summaries` (5.3) has no classification column of its own.** The vectors do; the text does not (FR19).
- **Section 7's disclosure question is open**, and it is a product decision rather than an engineering one (FR15).
- **The cross-conversation context accumulator is half wired.** Its update function is called by the archival path, so the table IS being written and the admin query over it returns real accumulating rows rather than an empty set. Only the lookup half has no caller, so nothing injects its results into a prompt. Section 7 describes drift's own related-conversation lookup, which is a different and genuinely built path.
- **Most guards here are described from code rather than proven by a test of their own.** This is a map of paths other documents own, so a row's real evidence is usually in the document that owns it; the rows with evidence of their own are named in the requirements table, and the two deny-tests are the strongest thing here.
