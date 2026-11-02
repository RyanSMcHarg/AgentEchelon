# SPEC: Evaluation

**Status:** Partial. This document describes the design for first release; the requirements table states what is delivered and what is not.

**Coverage:** `tests/e2e/evaluation-verdicts.spec.ts` (phase `evaluation-verdicts`, Aurora mode), plus the per-requirement tests named in the requirements table.

**Related:** [DESIGN-EVALUATION.md](./DESIGN-EVALUATION.md)

**Site section:** Interaction layer, quality.

---

## Overview

**Evaluation serves two primary audiences: (1) platform teams and (2) functional teams that create and manage assistants end to end to complete specific tasks in their area of ownership.**

**The platform team asks a question about the platform, not about any one assistant: is the platform enabling teams to give their assistants the right context and tools to do their job?** It is not one number and is not expected to be. It is assembled from three activities that reinforce each other: **manual review** of a sample of judged exchanges, read in this console rather than exported; **comparing what users said against what the evaluator scored**, because a judge no person has checked is an opinion repeated at scale; and **calibrating the evaluation itself** from what that review found. Underneath sit this team's own questions: are the training datasets sufficient to calibrate an assistant at all, or is the corpus too thin to distinguish a badly instructed assistant from a badly evidenced one? Do assistants need calibration instructions of their own, so a terse internal lookup is not held to a customer-facing standard, and does that reach down to the intent level? And the question that is this audience's alone: **is the platform providing the right controls to balance the cost of evaluation against its quality** - levers for how often evaluation runs, where it runs, and how much it samples? Evaluation is a second inference bill that scales with traffic, and a team that cannot turn it down turns it off.

**A team managing an assistant asks: given the full context, is my assistant behaving the way it should and giving the right answer for its given task?** That is a per-assistant, per-intent question about behavior, answered by scoring each exchange for relevance, compliance against declared rules and groundedness against retrieved passages, by scoring a document the turn delivered as a file as an artifact of its own, and by scoring each multi-turn task holistically. Verdicts land beside the exchange and are read by the admin console.

### What a verdict is about

**The measured unit is an assistant in one classification, not an assistant.** The same assistant can have an instance in several classifications, each with its own profile and its own context, and each instance is measured against the profile and context it was given there. Pooling those instances into a single per-assistant figure describes none of them. The attribution key is therefore the assistant that answered - `(assistant, classification)` - rather than the profile definition it served.

**A conversation can hold several assistants, and each is accountable for a different slice of it.** A primary delegates to specialists as needed; a user can also address a specialist directly. Judging each one well means judging it on the context it actually had, which includes what other assistants contributed, while holding it to account for its own part only.

| The assistant is judged on | It is not judged on |
|---|---|
| Requests that reached it - by the primary's delegation, or by a direct mention | Requests that never reached it |
| How well it used all the context available to it, including input contributed by other assistants | The quality of another assistant's input, even where that input was what misled it |
| Whether it declined what falls outside its remit, which is correct behavior and scores as such | Work that belongs to a sibling assistant's remit |
| Whether the primary delegated when a reachable assistant covered the request | Whether a sibling then handled the delegated work well |

Using all of that context well, and only that context, is what makes a verdict actionable: it is how a finding reaches one team rather than being argued between two.

### Where evaluation runs

**Aurora mode is the full evaluation.** Every pass, every verdict and every per-instance reading below assumes it. It scores exchanges, so it judges answers only: a notice the router says as an assistant and a join recap declare that they answer no message and never pair into an exchange, and a duel side is scored under the pinned version it served ([SPEC-MESSAGE-METADATA-CODEBOOK](../../communication/SPEC-MESSAGE-METADATA-CODEBOOK.md), "Turn shapes in analytics").

**Athena mode, the default, runs relevance only.** A daily job reads the previous day's archived messages, pairs them per channel, scores each pair for relevance with no prior transcript, and writes NDJSON verdicts plus a per-assistant daily score to the archive. It carries no compliance verdict, no groundedness, no multi-turn task score, no delivered-document score, no sampling and no rubric version, and it rolls up by assistant and intent without splitting by classification.

Because the gap is that wide, **every requirement below states the mode it is expected in.** A requirement marked `Aurora only` is not a defect in Athena mode; it is a reason to choose Aurora mode.

## Business Problem

Two different failures reach the person as the same disappointing answer and have two different owners: an assistant that never called the tool it needed is a prompt or taxonomy problem, while a tool that was called correctly and returned nothing, stale data or an error belongs to whoever owns the system of record behind it. Both are invisible in a quality score computed over reply text, and a reply that invents the figure scores *better* than both, because a fabrication addresses the request completely. The telemetry that separates them is archived per turn and read by the operations half of the console, but nothing joins "the tool failed" to "the answer was poor", so nobody is told which owner has work to do. Evaluation exists to produce one surface that says which of three things happened - the assistant did not reach for the tool, the tool did not serve the assistant, or both worked and the answer is still wrong - because each sentence sends the work to a different person.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Six of them use evaluation, and they divide along the two audiences in the Overview. A finding has to reach the right one, because neither audience can act on the other's work: a platform team cannot fix an intent's instructions, and an assistant's owners cannot widen the levers evaluation gives them.

### Platform developer

**How evaluation relates to them:** they answer for whether the platform lets every team instrument its own assistants, so they read across all assistants and all classifications at once, and they are the only audience that reads evaluation *of the evaluator* - whether the judge agrees with people, and whether the corpus is even large enough to calibrate against.

| What they need | Requirement |
|---|---|
| One view spanning every assistant and every classification, filterable down to one instance | FR19 |
| Judge-versus-person agreement, per assistant instance, with the population it was computed over | FR15 |
| Read a sample of judged exchanges in the console and calibrate from what the review found | FR14, FR15 |
| Tell a thin corpus from a badly instructed assistant before trusting any score | FR9 |
| See that a verdict is attributed to the assistant that answered, so a shared assistant's instances do not blur | FR3 |

### Admin / operator

**How evaluation relates to them:** evaluation is a second inference bill that scales with traffic, and they own what the deployment spends and whether the daily run finishes. They do not tune assistants; they decide how much evaluation runs and are alerted when it finds something blocking.

| What they need | Requirement |
|---|---|
| Set how often evaluation runs, where it runs and how much it samples, without a code change | FR18 |
| Have every assistant reviewed on a cycle regardless of its traffic, so a quiet assistant is not unmeasured | FR18 |
| A blocking compliance breach raised as an alert rather than folded into a percentage | FR7 |
| Know the population behind every rate, so a suppressed rate is not read as a good one | FR9 |

### AI developer

**How evaluation relates to them:** they answer for how an assistant is built, and their question is whether a poor answer is the assistant's fault or the data source's. They own one team's assistants, so every surface they use is scoped to those.

| What they need | Requirement |
|---|---|
| Views scoped to the assistants their team manages, reached from the profile they were already editing | FR20 |
| See that a tool returned an error on a third of its calls, and stop rewriting instructions that were already correct | FR11 |
| Know whether the retrieved context supported the answer | FR8 |
| Distinguish "retrieval returned the wrong passages" from "the model ignored the right ones" | FR8, FR12 |
| Change a prompt and have earlier scores segregate rather than re-baseline | FR10 |
| Not be marked down for a request that was never theirs, or for a sibling's bad input | FR4, FR5 |

### QA / test engineer

**How evaluation relates to them:** they gate releases on the assistants their organization builds, so they need a verdict that is reproducible and a comparison that is fair - the same exchanges, the same rubric - before and after a change.

| What they need | Requirement |
|---|---|
| A measured comparison of a draft profile version against the active one before promotion | FR17 |
| A stable set of exchanges that keeps meaning something as the assistant changes | FR16 |
| A verdict that names the rubric and the evaluator model, so two runs are comparable or are marked as not | FR10 |
| A deterministic selection, so a re-run scores the same rows | FR9 |
| Record a verdict from the exchange being reviewed rather than by copying an identifier | FR14 |

### Manager

**How evaluation relates to them:** they answer for what the assistant achieves rather than how it is built, so the unit that matters is the task, not the turn, and the reading has to hold up without them opening a transcript.

| What they need | Requirement |
|---|---|
| Whether tracked multi-turn tasks reached their goal | FR2 |
| Whether a delivered report, extraction or code file met what was agreed, scored apart from the chat reply beside it | FR22 |
| Whether the assistant is following its persona and per-intent instructions | FR12 |
| Attribute a score change to a specific configuration change | FR10 |
| See their own team's assistants only, without platform internals | FR20, FR21 |

### BI analyst

**How evaluation relates to them:** they take verdicts into their own stack rather than reading a curated dashboard, so what they need from evaluation is governed, queryable data with the verdict's provenance attached, not another view.

| What they need | Requirement |
|---|---|
| Verdicts queryable from the archive with rubric, model, stratum and sample rate on the row | FR9, FR10 |
| An export whose scope is defined, including what a later erasure request can still reach | Non-Goals, and [DESIGN-EVALUATION](./DESIGN-EVALUATION.md), Third-party integration points |

**Also served, and not personas in `PERSONAS.md`:** the **owner of a system of record**, who should be told their system caused a thin answer without reading transcripts (FR11), and the **compliance reviewer**, who needs a per-exchange verdict citing a rule id and the rule-set version (FR7).

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable. The bar-by-bar assessment behind these calls is kept in the maintainer notes rather than here.

**Mode** is the mode the requirement is expected in for first release, whether or not it is delivered yet.

| # | Requirement | Priority | Mode | Delivered | Validated by |
|---|---|---|---|---|---|
| FR1 | Every exchange gets a relevance verdict **in the context it was sent in**, or records that it got none | Table stakes | Aurora only | Yes | `the-judge-reads-the-transcript-not-the-ledger` (unit, behavior) |
| FR2 | Every tracked multi-turn task is scored holistically against its outcome | Table stakes | Aurora only | Yes | `flow-eval` (unit, behavior) |
| FR3 | A verdict is attributed to the assistant that answered, `(assistant, classification)`, and instances of one assistant are never pooled | Differentiator | Both | No | none |
| FR4 | An assistant is scored on the requests that reached it and on its use of the context it had, never on another assistant's input quality | Differentiator | Aurora only | No | none |
| FR5 | A correct out-of-remit decline is an Appropriate Refusal, not `irrelevant` | Table stakes | Aurora only | Yes | `a-correct-decline-is-not-irrelevant` (unit, source text) |
| FR6 | No score is derived from the conclusion it is checking | Table stakes | Both | Yes | `the-judge-is-not-told-the-intent` (unit, source text) |
| FR7 | Every exchange gets a compliance verdict against declared, versioned rules, or records NULL, and a breach alerts | Differentiator | Aurora only | Yes | `compliance-rules` (unit, behavior), `a-turn-records-only-its-own-guardrail-findings` (unit, behavior), `alerts` (unit, behavior) |
| FR8 | An answer is checked against what it was given | Table stakes | Aurora only | Yes | `an-answer-is-checked-against-what-it-was-given` (unit, source text) |
| FR9 | Every rate states the population it was computed over, and a rate that cannot be supported is suppressed rather than rendered | Differentiator | Both | Partly - two stratum counts are recorded and not shown | `an-unjudged-row-is-not-a-verdict` (unit, source text), `a-rate-states-the-population-it-was-computed-over` (unit, source text), `evaluation-verdicts` (e2e, behavior) |
| FR10 | A score names both the rubric it was judged under and the evaluator model that produced it | Differentiator | Both | Partly - both axes in Aurora mode, recorded on the row and read by the surfaces that report a rate, with a notice when a window spans more than one evaluator model; the Athena runner records neither, so a score names nothing in that mode | `a-score-names-the-rubric-it-was-judged-under` (unit, source text), `a-score-names-the-model-that-judged-it` (unit, behavior), `EffectivenessTab.evaluatorModel` (unit, behavior), `EvaluationsTab.evaluatorModel` (unit, behavior), `evaluation-verdicts` (e2e, behavior) |
| FR11 | Tool use is evaluated, and a finding names its owner | Gap - prioritize | Aurora only | Partly - built, covered by unit tests and deployed to dev on 2026-10-27, **NOT VERIFIED** on a deployment (Appendix C3): each call is recorded with its arguments and a result excerpt, decided from a recorded error, a recorded effect or one judge call, and routed to the tool's owner or the assistant's team; the tool judge has no human label to be calibrated against | `a-tool-call-is-judged-by-what-it-did` (unit, behavior), `ToolOutcomesPanel` (unit, behavior) |
| FR12 | Adherence, correctness and fitness are reported separately | Gap - prioritize | Aurora only | No | none |
| FR13 | The standard is fixed before the answer is seen | Above bar - optional | Aurora only | No | none |
| FR14 | A human verdict is recorded from the exchange it is about | Table stakes | Aurora only | Partly - built and covered by unit tests (Appendix C1): a label queue ordered by what a label is worth, opening the label with the answer in view; the label queue and the label write verified on dev 2026-10-31 by the `golden-set` e2e phase through the API, and the Ground Truth tab's flow is unit-tested only | `a-golden-entry-is-de-identified-and-classified` (unit, behavior), `GoldenSetPanel` (unit, behavior), `a-draft-answers-the-golden-set-before-it-is-activated` (e2e, passed on dev 2026-10-31) |
| FR15 | Judge-versus-person agreement is reported per assistant instance, with its population | Gap - prioritize | Aurora only | Partly - built, covered by unit tests and deployed to dev on 2026-10-27, **NOT VERIFIED** on a deployment (Appendix C4): kappa and both error rates per rubric, instance, evaluator model and rubric version for relevance, compliance and groundedness, people against people, and self-judged verdicts, on the Ground Truth tab; the document and tool judges have no human labels yet | `a-judge-is-measured-against-people-per-rubric` (unit, behavior), `a-human-label-names-its-author` (unit, behavior), `JudgeCalibrationPanel` (unit, behavior) |
| FR16 | Golden entries, from reviewed exchanges, a deployment's uploads or generation from the intent pack, enter a golden set that outlives the exchange | Enabler | Aurora only | Yes - de-identified, per classification under row-level security, two tiers (Appendix C1); a labeled answer nominated from its de-identified copy verified on dev 2026-10-31 by the `golden-set` e2e phase, uploads and generated entries under FR27 and FR30 | `a-golden-entry-is-de-identified-and-classified` (unit, behavior), `a-draft-answers-the-golden-set-before-it-is-activated` (e2e, passed on dev 2026-10-31) |
| FR17 | A draft profile version is measured against the golden set before it becomes active | Differentiator | Aurora only | Partly - built, unit tested and verified on dev 2026-10-31 by the `golden-set` e2e phase for text entries: a draft is run against its assistant's set on the classification's own GoldenRun function, text only, beside the active version, and Activate is refused while a regression entry fails or no run exists for the draft ([ADR-065](../../../design/decisions/065-a-draft-answers-the-golden-set-before-it-is-activated.md)); tool-using entries are counted as not exercised (Appendix C1) | `a-draft-is-refused-only-on-deterministic-failures` (unit, behavior), `a-draft-answers-the-golden-set-before-it-is-activated` (unit, behavior; e2e, passed on dev 2026-10-31), `a-golden-run-role-cannot-speak` (synth) |
| FR18 | Evaluation batches by assistant, the batches cycle so every assistant is reviewed regardless of traffic, and the sampling levers are operator-settable | Enabler | Both | No | none |
| FR19 | A platform-wide view spans every assistant and every classification, filterable to one instance | Table stakes | Both | Partly - the shared filter cascade narrows to one instance; one row per assistant instance is not built, because `intent_effectiveness` groups by intent only | `PerformanceFilters` (unit, behavior) |
| FR20 | A team-scoped view covers only the assistants that team manages, reachable from the profile and from a list of those assistants | Table stakes | Both | No | none |
| FR21 | The data-access matrix in Appendix B is enforced where the request is served, not in the client | Table stakes | Both | No | none |
| FR22 | A document a turn delivers as a file is graded as an artifact of its own, against the request and the requirements its task recorded before delivery, from the archive's own copy, and the score names the artifact it is about | Table stakes | Both | Partly - built in both modes and covered by unit tests: the turn records the reference, the archive keeps its own copy (archival in Aurora mode, the runner in Athena mode), and the runner writes a `document` row as its own unit of work, retried within a bound in Aurora mode; `document_evaluation` reads the rows by intent and task type and per conversation, and the Effectiveness tab, the Evaluations tab and the conversation drawer show them. Athena mode judges relevance only. Not yet exercised on a deployed stack | `a-delivered-document-is-graded-as-itself` (unit, behavior), `a-delivered-document-is-recorded-for-evaluation` (unit, behavior), `a-delivered-document-is-graded-in-athena-mode` (unit, behavior), `a-document-score-has-a-reader` (unit, behavior), `DeliveredDocumentsPanel` (unit, behavior) |
| FR23 | Every workflow task reports where it ended and how directly, against the machine it ran under | Differentiator | Aurora only | Partly - built and covered by unit tests (Appendix C2); deployed to dev on 2026-10-27, **NOT VERIFIED** on a deployment | `a-task-path-is-measured-against-its-own-machine` (unit, behavior), `a-workflow-trajectory-reads-the-stamped-path` (unit, behavior) |
| FR24 | Retrieval is read by what the answer used, per intent and per context source | Gap - prioritize | Aurora only | Partly - built and covered by unit tests (Appendix C7); deployed to dev on 2026-10-27, **NOT VERIFIED** on a deployment | `a-reply-names-the-passages-it-rests-on` (unit, behavior), `RetrievalSourcesPanel` (unit, behavior) |
| FR25 | Guardrail findings, compliance rules and capability refusals are counted on their own, each over its population | Table stakes | Aurora only | Partly - built and covered by unit tests (Appendix C5); deployed to dev on 2026-10-27, **NOT VERIFIED** on a deployment | `safety-readings-are-counts-from-the-turn` (unit, behavior), `SafetyReadingsPanel` (unit, behavior) |
| FR26 | Whether a person had to work to be understood is counted per person per conversation from recorded events | Above bar - optional | Aurora only | Partly - built and covered by unit tests (Appendix C6); deployed to dev on 2026-10-27, **NOT VERIFIED** on a deployment | `frustration-is-counted-per-person-per-conversation` (unit, behavior), `FrustrationPanel` (unit, behavior) |
| FR27 | A deployment uploads its own golden entries, de-identified before they are stored | Table stakes | Aurora only | Yes - `POST .../profiles/golden-set-import` under `import-golden-set`: JSON Lines or CSV, every line checked against the intents the assistant serves, de-identified by the clean copy's detector on the classification's GoldenRun function, stored as capability marked uploaded ([ADR-065](../../../design/decisions/065-a-draft-answers-the-golden-set-before-it-is-activated.md) decision 7); verified on dev 2026-11-01 | `a-deployment-uploads-its-own-golden-entries` (unit, behavior), `GoldenUploadPanel` (unit, behavior), `a-deployment-brings-its-own-golden-entries` (e2e, passed on dev 2026-11-01) |
| FR28 | An administrator activates a draft past the golden gate on a separate grant, with the standing refusal confirmed and a reason recorded on the version | Table stakes | Aurora only | Yes - `POST /admin/profiles/activate-past-golden-gate` under `activate-past-golden-gate`, held by the admin role alone with no team route; the handler requires an admin group from the caller's directory groups and the refusal shown (code, values, run) to still stand; the version records `activatedPastGate` and the admin channel is told ([ADR-065](../../../design/decisions/065-a-draft-answers-the-golden-set-before-it-is-activated.md) decision 5); verified on dev 2026-11-01 | `an-administrator-activates-past-the-golden-gate` (unit, behavior), `GoldenRunPanel` (unit, behavior), `a-draft-answers-the-golden-set-before-it-is-activated` (e2e, passed on dev 2026-11-01) |
| FR29 | The gate reports coverage per intent, against a minimum the active version may declare | Differentiator | Aurora only | Yes - the gate read counts entries per intent of the draft's pack, and `goldenSet.minRegressionPerIntent`, read from the active version, refuses as `GOLDEN_SET_THIN` (ADR-065 decision 6); verified on dev 2026-11-01 | `the-golden-gate-reads-coverage-per-intent` (unit, behavior), `GoldenRunPanel` (unit, behavior), `a-deployment-brings-its-own-golden-entries` (e2e, passed on dev 2026-11-01) |
| FR30 | Golden entries are generated from the intent pack for an assistant with no traffic, as capability entries only | Gap - prioritize | Aurora only | Yes - `POST .../profiles/golden-set-generate` under `edit-profiles`: the utility model writes requests from each intent's own description, de-identified and stored as capability marked generated (ADR-065 decision 8); verified on dev 2026-11-01 | `a-deployment-uploads-its-own-golden-entries` (unit, behavior), `a-deployment-brings-its-own-golden-entries` (e2e, passed on dev 2026-11-01) |

**Reading the "Validated by" column.** Each entry is one specific test, named by its own filename or `describe` block. Unit tests live in `backend/test/` (the analytics ones under `backend/test/analytics-aurora/`); end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The status in brackets is what the test does, which matters more than that it is green:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists, which is expected where `Delivered` is No.

**Known limits on the delivered rows.** FR1's neutral-score fallback on an unparseable judge reply is implemented and not covered by a test, in both runners. FR5 holds in Aurora mode; the Athena runner's rubric reaches the Appropriate Refusal band for adversarial input alone. FR7's rule-set validation runs at module load and nothing asserts that it does.

FR14 through FR17 are ordered dependencies: the promotion gate cannot run until the set exists, and the set fills from labeled exchanges (FR14), from a deployment's own uploads (FR27) and from entries generated from the intent pack (FR30).

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| **Security findings, including leak detection** | Information isolation is a security control, and it is enforced where a control belongs: by IAM and resource policies **before a request runs**, with every sensitive operation carrying at least two layers and isolation proven by deny-test rather than by review (tenet P4). Evaluation reads a sample after the fact, so a percentage from it could never be the guarantee, and reporting one risks reading as though the matter were handled | [SPEC-CONVERSATION-SECURITY](../governance/SPEC-CONVERSATION-SECURITY.md) - six numbered layers plus Layer 4b for retrieval scoping, with Layer 7 for mixed-trust visibility |
| A general-purpose dataset workbench for answer quality | Commodity tooling, a smaller corpus here, and nobody to maintain it | Attach Ragas, Phoenix, LangSmith, Braintrust or Amazon Bedrock Evaluations to the S3 archive. FR16's golden set is narrower on purpose: entries bound to this deployment's own promotion control |
| An evaluation gate in CI | A nondeterministic judge makes flaky builds, flaky builds acquire retries, and the gate stops meaning anything | FR17 is deliberately different: a promotion runs when an operator is standing there to read the result |
| A correction loop feeding human labels back into the judge | A rubric tuned on the labels it is measured against is no longer independent | Calibration publishes the distance between judge and person; it does not retune the judge |
| Automated routing or promotion from an evaluation result | No score changes routing or promotes a variant on its own | [SPEC-BATTLE](./SPEC-BATTLE.md) FR8, [DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP](./DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md) INV-1 |
| Judging an assistant on another assistant's contribution | It marks down the wrong team and hides the real owner | FR4 draws the line; the shared context is still an input |
| Per-assistant or per-intent rubrics | **Open question, not a decision.** A per-assistant rubric makes scores incomparable across assistants unless the scale is held fixed | [DESIGN-EVALUATION](./DESIGN-EVALUATION.md), Open questions |
| Membership and roles as evaluation inputs | Once leak detection is out of scope, room composition is not an evaluation input. Task state remains one, because it is part of "its given task" | FR4 for what the assistant is accountable for |
| Confidence intervals on per-intent rates | Over-engineering for an operations console | FR9 suppresses a rate whose population cannot support it |
| Position, self-consistency and self-preference checks on the judge | Each needs a change to the judge before a finding could be acted on | Verbosity correlation is the one kept, because it needs no judge change |

## User Experience Description and Mocks

Evaluation has no surface of its own; it writes rows that the admin console reads. Two journeys use it, and they differ in scope before they differ in screen. These journeys describe the first-release design; delivery is per row in the requirements table above, and a step that leans on an undelivered row describes what the design requires rather than what the console renders.

### The platform team's journey

1. **Open the platform-wide view** (FR19). Every assistant and every classification, one row per assistant instance, worst-first. Each rate carries its population, and a rate over too few observations reads "too few to report" rather than rendering over five (FR9).
2. **Filter to narrow the question.** By classification, by assistant, by intent, by date. Filtering to one classification is how a shared assistant's instances are compared rather than blurred (FR3).
3. **Ask whether the score can be trusted before acting on it.** Judge-versus-person agreement sits next to the score it qualifies, per assistant instance, with its own population (FR15). A low agreement figure means the score below it is not yet evidence.
4. **Read a sample of judged exchanges in place.** The judge's reasoning, the rubric version, the evaluator model and why the exchange was drawn (FR10). Recording a human verdict starts from this row (FR14).
5. **Calibrate, and tune the cost.** What the review found feeds the rubric; how much this costs is set here rather than in code, along with the cycle that guarantees a quiet assistant is still reviewed (FR18).
6. **Alerts, not percentages, for anything blocking.** A compliance breach is raised (FR7). Because evaluation reads a sample, a quiet Alerts tab means no breach was seen in what was drawn, and the surface says so.

### A functional team's journey

1. **Arrive from the assistant, not from a dashboard.** The existing link on the profile leads to that assistant's evaluation, so the team enters from the thing they were already editing (FR20).
2. **Or open the list of assistants this team manages** and pick one (FR20). The same list is the answer to "what am I responsible for".
3. **Pick the instance, not just the assistant.** An assistant deployed into two classifications shows one row per classification, each judged against the profile and context given to it there (FR3).
4. **Read worst intent first**, then the exchanges behind it - the judge's reasoning, and whether the request was even theirs. A decline of an off-remit request reads as correct (FR5), and a sibling assistant's bad input is not charged to them (FR4).
5. **Separate the three failures.** Adherence, correctness and fitness read apart (FR12), and tool use reads as its own dimension naming the owner - including the case where the tool was never called and the case where it answered anyway (FR11).
6. **Change something, and compare.** A prompt change segregates old scores rather than re-baselining them (FR10); a draft profile version is measured against the golden set before it is promoted (FR17).

Every step above is scoped where it is served, not filtered in the browser (FR21).

**Open design question, not settled here: how "the assistants my team manages" is resolved.** The candidates are an IAM-enforced scope on the request and a filtered list of app-instance bots. Tenet P4 pushes toward the first - access is enforced before the request runs, and a client-side filter is not an enforcement layer - but the ownership record that a policy would read does not exist yet, so the cost is not only in evaluation. The trade-off is set out in [DESIGN-EVALUATION](./DESIGN-EVALUATION.md), Scoping a team to its own assistants, and FR20 and FR21 depend on the answer.

## Related Documents

- [DESIGN-EVALUATION.md](./DESIGN-EVALUATION.md) - the passes, the flows, and the context each judge is given
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the six personas above
- [SPEC-ADMIN-CONSOLE-EFFECTIVENESS.md](../../interface/SPEC-ADMIN-CONSOLE-EFFECTIVENESS.md) - where every score is read
- [SPEC-AURORA-VPC-MODE.md](../../foundations/SPEC-AURORA-VPC-MODE.md) - the deployment mode the full evaluation requires
- [HOW-TO-CONFIGURE-COMPLIANCE-RULES.md](../../../guides/developer/HOW-TO-CONFIGURE-COMPLIANCE-RULES.md) - authoring the rules FR7 judges against
- [DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md](../assistants/DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION.md) - delegation, which FR4 and FR5 depend on
- [ADR-065](../../../design/decisions/065-a-draft-answers-the-golden-set-before-it-is-activated.md) - the run that has a draft answer the golden set, and the identity it runs under (FR17)
- The bar-by-bar assessment behind the Priority column is kept in the maintainer notes, outside this repository.

## Appendix A - Mocks

Both mocks are drawn with the admin console's own stylesheets and class names rather than as wireframes, so what they show is what those components do at the viewport the e2e suite runs at. Source and regeneration: `tests/mocks/evaluation-views.html`, rendered by `tests/mocks/render-mocks.mjs`. The numbers in them are illustrative, and so is the five-tab nav across the top of A1: the console's real rail has the seven sections [DESIGN-ADMIN-CONSOLE](../../interface/DESIGN-ADMIN-CONSOLE.md) describes, and the mock abbreviates it to frame the view.

**A1. Platform-wide view (FR19).** Every assistant instance, worst-first, with the population beside every rate and the trustworthiness of the score visible before the score can be acted on.

![The platform-wide evaluation view: a filter row, four summary cards, and a table with one row per assistant instance - assistant, classification, intent, relevance, judged-over-seen, agreement and tool use - with the worst assistant instance selected and its provenance panel open below.](./mock-evaluation-platform.png) *One row per assistant instance. `onboarding-bot` reports "too few to report" rather than rendering a score over three observations, and the open panel says the 41 is not yet evidence because judge agreement on that assistant instance is 62%.*

**A2. A team's own assistants (FR20).** Reached from the profile the team was editing, or from this list.

![A team-scoped evaluation view for the people-ops team: two assistant cards, one showing the same assistant in two classifications with separate scores, then adherence, correctness and fitness as three cards, a tool-use table naming an owner per outcome, and a per-exchange verdict list.](./mock-evaluation-team.png) *`hr-assistant` appears twice, once per classification, scored separately and never pooled. The tool-use table sends 39 errored calls to `hris-system` rather than to this team, and the verdict list shows an off-remit decline scoring as correct alongside a missed delegation.*

The components these would use are named in [DESIGN-ADMIN-CONSOLE](../../interface/DESIGN-ADMIN-CONSOLE.md).

## Appendix B - Data access matrix

What each audience may read. Enforced where the request is served (FR21); this table is the specification that enforcement is written against.

| Data | Platform developer | Admin / operator | AI developer | QA / test engineer | Manager | BI analyst |
|---|---|---|---|---|---|---|
| Scores and rates, all assistants, all classifications | Yes | Yes | No | No | No | Yes, from the archive |
| Scores and rates, own team's assistants | Yes | Yes | Yes | Yes | Yes | Yes, from the archive |
| Judge reasoning on an exchange | Yes | Yes | Own team only | Own team only | Own team only | Only if exported |
| Message content behind a verdict | Scoped, opt-in, audited | Yes | No, by default | Own team only | Own team's scope | No |
| Rubric version, evaluator model, stratum, sample rate | Yes | Yes | Yes | Yes | No | Yes |
| Judge-versus-person agreement | Yes | Yes | Own team only | Own team only | No | Yes |
| Human verdict entry | Yes | Yes | Own team only | Own team only | No | No |
| Cost and sampling levers | Read | **Write** | No | No | No | No |
| Compliance verdicts and alerts | Yes | Yes | Own team only | Own team only | Own team's scope | Aggregates only |

"Own team only" resolves through the same scope as FR20, which is the open design question named in the User Experience section. A cell reading `No` is not a UI omission: the request is refused where it is served.

## Appendix C - Evaluation increments

**Status:** built with unit tests and deployed to dev on 2026-10-27 (Aurora mode), **NOT VERIFIED** on a deployment, except C1's golden set, answer run and gate, which the `golden-set` e2e phase verified on dev; each increment states its own. What to implement next, in order, and how each builds on what the platform already records. Each item names the requirement it delivers or the new requirement it proposes; a proposed requirement joins the table above only when it is accepted. The assessment behind the order is kept in the maintainer notes. The mechanics, and how each increment fits the existing passes, are in [DESIGN-EVALUATION](./DESIGN-EVALUATION.md), Next increments.

### What every increment holds to

Each increment meets what the field expects of agent evaluation, and does it in the way only this platform can. Five properties are not optional for any of them:

- **Scored where the data already lives.** The archive is the system of record for every evaluation input (tenet D7). An increment reads what a turn recorded, and where a turn does not record what a judge needs, the increment's first step is recording it, never reconstructing it after the fact.
- **Attributed as it happens, not inferred afterwards.** Every reading is attributed to the assistant that answered, `(assistant, classification)` (FR3), from the turn's own routing record. A handover is answered by the assistant that owns the work, never relayed through another, so no reading has to work out from a transcript which assistant caused a failure.
- **Measured against what the deployment declared.** Workflows, tool allowlists, compliance rules and the versions they ride are declared configuration. A reading compares behavior with that declaration rather than with a reference someone wrote separately and must keep current.
- **Classification-scoped like everything else.** A golden set, a replay run and a recorded tool result are stored and read per classification, under that classification's own role, and proven by a test that another classification's role is refused (tenets P4, D12).
- **The judge earns trust before its numbers are used.** No new judged reading is shown without the judge-versus-person agreement that qualifies it (C4), and no alert fires on a population too small to support it (FR9).

### The order

The order follows the evidence on what predicts real outcomes, and one rule: **measure from records the platform already writes before adding a judge.** A judge is a second inference bill that scales with traffic (FR18).

| Order | Increment | Delivers | Priority | Mode | Judge cost |
|---|---|---|---|---|---|
| C1 | Golden set and promotion gate | FR14, FR16, FR17 | Table stakes, Enabler, Differentiator | Aurora only | Per promotion run only |
| C2 | Workflow outcome and trajectory | FR23 | Differentiator | Aurora only | None |
| C3 | Tool use, scored by what it changed | FR11 | Gap - prioritize | Aurora only | One call per judged exchange that held tools, none for a call decided from its record |
| C4 | Judge calibration per rubric | FR15 | Gap - prioritize | Aurora only | None beyond human review |
| C5 | Safety and refusal readings from recorded findings | FR25 | Table stakes | Aurora only | None |
| C6 | A frustration reading per conversation | FR26 | Above bar - optional | Aurora only | None |
| C7 | Retrieval contribution per passage | FR24 | Gap - prioritize | Aurora only | None beyond the groundedness call it rides |

Two housekeeping items follow C7.

### C1. Golden set and promotion gate (FR14, FR16, FR17)

**Status:** the label from the answer (FR14), the golden set (FR16), the run that answers the set with a draft version, and the refusal at Activate are built, unit-tested and verified on dev on 2026-10-31 by the `golden-set` e2e phase; the label is verified through the API, and the Ground Truth tab's flow is unit-tested only. Uploads, generated entries, coverage per intent and activation past the gate are verified on dev on 2026-11-01 (FR27 to FR30) ([ADR-065](../../../design/decisions/065-a-draft-answers-the-golden-set-before-it-is-activated.md); see "The run").

**What.** A human verdict is recorded from the exchange it is about (FR14); positively reviewed exchanges, and the failures worth never repeating, enter a golden set (FR16); and a draft version of an assistant is run against that set before it is activated (FR17).

**Specific to this platform.** The gate sits on the version lifecycle every assistant already has (draft, validate, activate, roll back), so it measures exactly what is about to go live: the persona, the per-intent instructions, the models, the tool allowlist and the workflows selected, together. A model change is never measured apart from the prompt and tools it will run with.

**Labeling from the answer.** `label_queue` lists judged answers nobody has labeled, with an answer the guardrail found something on first, then one the classifier was unsure of or a person flagged, then the rest by recency. The Ground Truth tab opens the label with the request and the answer in view, so nobody carries an identifier across tabs.

**What the set holds, and where.**
- **The de-identified copy, never the raw exchange.** A nominated entry is copied from the conversation's de-identified copy (`clean_conversation_rows`), people as pseudonyms and personal details described rather than shown, so the set holds no personal data for offboarding to erase, and it outlives the conversation without outliving a person's right to be removed. A nomination is refused while that copy does not exist yet, rather than falling back to the raw text. An uploaded or generated entry is de-identified by the same detector before it is stored, and refused rather than stored raw.
- **Three sources.** A person nominates a labeled exchange, a deployment uploads its own entries (FR27), or an editor generates entries from the intent pack (FR30). Uploaded and generated entries enter as capability.
- **Per classification, inside the boundary.** `golden_set_entries` (migration 089) is a bounded table: row-level security lets a classification's reader role see only the entries its grant set covers, and only the write role writes. The live boundary verifier proves the narrowest reader cannot read the widest classification's entry.
- **Two purposes.** A regression entry is a case that passed (a person labeled it 50 or more) and must keep passing; a capability entry may come from a failed answer and carries no reference. An entry can be retired, or promoted from capability to regression.

**How the gate decides** (`lib/promotion-gate.ts`).
- **Repeated attempts, not one.** Each entry is answered k times by the draft and by the active version, because the same request does not give the same answer twice, even at temperature 0.
- **What blocks.** Activation is refused only when a regression entry fails any of its k attempts on a deterministic fact: the run errored, the answer was empty, the guardrail blocked it, or it breached a rule the platform checks without a judge (pass^k). A text-only run cannot exercise a workflow, so whether a workflow still reaches its success terminal is read on live traffic (C2), not here.
- **What informs.** Judged quality is reported as the mean paired difference, draft minus active, over entries, with a confidence interval in which each entry is one cluster. It never blocks on its own (Non-Goals: automated promotion).
- **Honest about size.** The result states the smallest difference the set can detect; with fewer than two judged entries it says the set cannot detect any.
- A capability entry the draft passes on every attempt is reported as ready to promote.

**The run** ([ADR-065](../../../design/decisions/065-a-draft-answers-the-golden-set-before-it-is-activated.md), Option A). A draft answers each entry of its assistant's set k = 3 times beside the active version, posting nothing, on the classification's own GoldenRun function: a role that invokes only the classification's models and guardrails, reads version bodies, and holds no Amazon Chime SDK action, so it needs no assistant session and is not a speaker. The prompt is composed by the one composer the live turn uses (`lib/answer-prompt.ts`), with the entry's recorded reply preferences and preceding turns and nothing about a person. No tools are offered, so an entry whose answer used a tool is answered and counted as not exercised, never passed or failed; a live read-only tool run (ADR-065 Option C) is a separate decision. Starting a run needs `edit-profiles`; Activate reads the latest run for the draft's configId and refuses while it is missing, running, failed or refused, and an edit after the run needs a new one. Rollback and an experiment's promotion are not gated. The console reads the result when the draft opens, on request, and when told on the run's channel (`/console/batch/<runId>`, `console-events-publisher.ts`) that the run ended, never on a timer. **NOT BUILT:** a sweep that deletes superseded runs.

**Before the set is adequate** (ADR-065 decisions 5 to 8, each built and verified on dev on 2026-11-01). The gate reports, per intent of the draft's pack, the regression and capability entries the set holds and the run exercised, and the active version may declare a minimum of regression entries per intent, `GOLDEN_SET_THIN` (FR29). A deployment may upload its own entries as JSON Lines or CSV under `import-golden-set`, each text de-identified by the same detector as the clean copy and refused rather than stored raw (FR27), and an editor may generate entries from the draft's intent pack under `edit-profiles` (FR30). Uploaded and generated entries enter as capability and become regression only after the active version passes them. Both run in the background, and the console is told on the batch's channel when each ends, as it is for a run. An administrator may activate a refused draft on a separate route and capability, `activate-past-golden-gate`, held by the admin groups only, after confirming the refusal that stands and giving a reason that the activated version records and the admin notification channel announces (FR28).

**Proven by** `a-golden-entry-is-de-identified-and-classified` (unit: the copy is de-identified and written as the write role, refused without the copy, a label required and a passing one for regression, a capability entry without a reference, each classification read under its own role, the label queue's order), `a-draft-is-refused-only-on-deterministic-failures` (unit: pass^k refusal, breaches named, a judged fall reported and not blocking, capability promotion, a set too small to detect anything), `GoldenSetPanel` (unit), `a-draft-answers-the-golden-set-before-it-is-activated` (unit: one composer, what an entry carries, the gate's outcomes, not-exercised entries, the run's classification refusal), `a-golden-run-role-cannot-speak` (synth), `GoldenRunPanel` (unit), and the `golden:low-reader-cannot-see-high-entry` and `golden:low-reader-cannot-see-high-run` checks in the live boundary verifier. `tests/e2e/a-draft-answers-the-golden-set-before-it-is-activated.spec.ts` (phase `golden-set`) passed on dev on 2026-10-31: a labeled answer nominated as a regression entry, Activate refused before a run, the premium GoldenRun answering the entry in the archive's VPC and its record deciding the gate, and an edit needing a new run. **Owed:** tool-using entries are counted, not exercised (ADR-065 Option C).

### C2. Workflow outcome and trajectory (FR23)

**Status:** built with unit tests and deployed to dev on 2026-10-27; **NOT VERIFIED** on a deployment, and no e2e asserts it yet.

**What.** For every task: did it reach the outcome its workflow declares, and how did it get there. Reached a success, failure or handoff terminal; edges taken against the fewest declared edges to success; steps back; stalls; refused moves; and moves the platform made on the task's behalf.

**Specific to this platform.** A workflow here is a declared, enforced state machine (ADR-047), so the outcome is a fact the runtime records, not a judge's reading of a transcript, and the path is compared with the graph the deployment declared rather than with a single expected path. A task that reaches its success terminal by a valid route the author did not anticipate is a success with a longer path, never a failure.

**How. Deterministic, no judge.**
- A task turn stamps `taskTrajectory` on its analytics record (`lib/task-trajectory.ts`), computed from the PERSISTED task row and the machines the turn ran under, so a pack-declared machine is measured against its own graph. The in-memory task is not used: it learns a platform move's edge and not a model's. The stamp is archived with the turn, so it outlives the task row's TTL.
- `stateHistory` marks each edge `by: 'tool'` (the model asked) or `by: 'system'` (the platform moved it: a declared step action, an expiry or an admin action); `turnsInState` counts turns that moved nothing; the shortest path is a breadth-first search over each state's transitions and its action's outcome edges.
- `workflow_trajectory` reads the latest stamp per task and reports, per assistant, classification and task type: tasks by terminal kind and open; path ratio (1.0 is the direct path) over the tasks that reached success; tasks that went back; open tasks stalled for `TASK_STALL_TURNS`; platform moves; and refused moves counted from the turns' steps. The Effectiveness tab shows it as **Workflows**.

**Proven by** `a-task-path-is-measured-against-its-own-machine` (unit: direct, longer but valid, regressed, stalled, platform moves, reopened, a pack machine's own shortest path, and that the processor stamps from the persisted row) and `a-workflow-trajectory-reads-the-stamped-path` (unit: query shape, team binding, declared columns). **Owed:** the `tasks` e2e phase extended to a stalled task and a refused move.

### C3. Tool use, scored by what it changed (FR11)

**Status:** built with unit tests and deployed to dev on 2026-10-27; **NOT VERIFIED** on a deployment, and no e2e asserts it yet.

**What.** Every exchange that called a tool, or held tools it might have needed, gets one outcome per call, and each outcome names the team that fixes it:

| Outcome | Meaning | Owner |
|---|---|---|
| Not called | A tool the turn held covered the request, and the reply answered without it | The assistant's team (its instructions) |
| Wrong arguments | The call was made with arguments that cannot answer the request | The assistant's team |
| Errored | The tool failed | The tool's owner |
| Empty | The tool returned nothing usable for a request it covers | The tool's owner, or the context source behind it |
| Contradicted | The reply states something the tool's result does not support | The assistant's team |

**Specific to this platform.** The turn was offered a declared allowlist, narrowed per intent and per workflow step, so "not called" is judged against the tools this turn actually held, never against every tool that exists. And a finding names an owner from the tool's registry entry, so it reaches one team.

**How.**
- **Recording comes first.** Each call is recorded with its arguments (up to 1,000 characters) and a result excerpt (up to 1,500), beside the outcome the step already recorded, and the turn records the tools it was offered (`ToolCallRecord`, `toolsOffered`, `analytics-metadata.ts`). Both ride the out-of-band analytics record and are archived under the conversation's classification, as retrieved passages are. They are capped, not de-identified, which is the same treatment the archive gives the conversation itself.
- **Decided the cheapest way the record allows** (`analytics-aurora/tool-judge.ts`, a pass of the evaluation runner over exchanges the relevance pass judged, so it inherits that pass's sample):
  - a failed call is `errored`, from the error class the turn recorded, with no judge;
  - a call to a tool the registry marks `changesState` is scored from the platform's own record of the change it made, with no judge; whether that change was the right move for the task is C2's question;
  - a call the workflow refused by a declared rule is not scored here: it is the workflow working, counted on C2;
  - the rest, and the held tools, go to ONE judge call per exchange with the request, the held tools, each remaining call with its arguments and result excerpt, and the reply, as delimited evidence. The judge returns an outcome per call and the held tools that should have been called, as data; an answer that names a call it was not shown or a tool the turn did not hold is dropped.
- **The owner comes from the tool registry**, whose entries now each declare `owner` (`platform`, `connector:<name>` or `context:<name>`); the type requires it, so an entry without one does not compile.
- **Stored** as one row per call in `tool_call_verdicts` (migration 087), with how it was decided and, for a judged row, the evaluator model and rubric version (FR10). `tool_outcomes` reads it per tool, with the tool's owner, and the Effectiveness tab shows it as **Tool use**.

**Not built.** People cannot yet label a tool call, so the tool judge has no calibration row (C4).

**Proven by** `a-tool-call-is-judged-by-what-it-did` (unit: the record and its caps, every registry entry's owner, owner routing, an errored call and a state-changing call decided without a judge, a refused call skipped, judge answers filtered to what it was shown, a judge failure leaving the exchange unscored). **Owed:** the `evaluation-verdicts` e2e phase extended to a turn that calls a tool.

### C4. Judge calibration per rubric (FR15)

**Status:** built with unit tests and deployed to dev on 2026-10-27; **NOT VERIFIED** on a deployment, and no e2e asserts it yet.

**What.** Before a judged reading is relied on, the agreement between the judge and people is reported per rubric and per assistant instance: Cohen's kappa, the share of failures the judge caught (true-positive rate) and the share of good answers it passed (true-negative rate), with the labels behind them, beside the agreement two people reach on the same answers.

**Specific to this platform.** Three sources of human judgment exist and are kept apart: ground-truth labels (FR14), compliance and groundedness labels, and battle picks, where a person chose between two live answers and the judge scored both. Each is a calibration reading for the judge, and none retunes it (Non-Goals).

**How.**
- **One calibration reading for every labeled judge.** `judge_calibration` compares each judge's latest verdict with the latest label on the same exchange for relevance (a score below 50 is a failure on both sides), compliance and groundedness, and reports a row per assistant, classification, evaluator model and rubric version (`lib/agreement.ts` computes kappa and both rates, and returns null rather than a number where a denominator is zero). The Ground Truth tab shows it in place of the pooled error and agreement it replaced, and reads the battle-pick agreement (`pairwise_agreement`), which had no console reader before.
- **A label has three halves.** A person records a score, whether the answer broke a compliance rule (with the rule ids, which the write checks against the rule set), and whether it stayed within what it retrieved (migration 086). A half left out is stored NULL, never read as a pass.
- **People against people.** Two different people's labels on the same answer give the agreement a judge is measured up to, per rubric.
- **The judge is not the assistant.** Verdicts where the evaluator model is the model that wrote the answer are counted and called out, so self-preference cannot pass unnoticed.
- **Re-baselined on change.** Each row is one evaluator model and one rubric version; the groundedness rubric's version is now stored with each verdict, so a change to any judge starts a new row.
- **Held out by construction.** No rubric draws its examples from labels, so every label measures the judge.
- **A minimum population before an alert.** The judged relevance alert is raised only when the average sits further from its target than the smallest gap the conversations behind it can detect, sized with the experiment statistics' power calculation (`minimumDetectableDifference`) over conversations rather than turns.

**Not built.** The document judge and C3's tool judge have no human label of their own yet, so they have no calibration row.

**Proven by** `a-judge-is-measured-against-people-per-rubric` (unit: kappa and both rates, nulls, series per judge and rubric, people against people, self-judged counts, team binding, the minimum detectable difference over conversations), `a-human-label-names-its-author` (unit: the label's halves), `JudgeCalibrationPanel` and `alerts` (unit). **Owed:** an e2e that labels an answer and reads its calibration row.

### C5. Safety and refusal readings from recorded findings (FR25)

**Status:** built with unit tests and deployed to dev on 2026-10-27; **NOT VERIFIED** on a deployment, and no e2e asserts it yet.

**What.** A count per guardrail finding, a count per compliance rule a verdict named, and a count of capability refusals: requests an assistant declined because its classification does not offer the capability (DESIGN-CAPABILITY-REFUSAL), each over its own population.

**Specific to this platform.** Guardrail findings are deterministic and cannot be overturned by a judge, so these readings need no judge at all, and a capability refusal is a classification boundary working as designed, reported as a count rather than as a failure.

**How. No new judge.**
- `safety_readings` counts, per assistant and classification: each finding the guardrail recorded on the turn, leaving out the platform's own internal-marker masks; each rule the latest verdict named, over the turns assessed; and per intent, the turns refused, read from the delivery option `REFUSED` the router's refusal already writes, beside how many of the judged ones the judge also called an appropriate refusal. The Effectiveness tab shows it as **Safety and refusals**.
- **Judged where the judge is weakest.** A turn with a guardrail finding is always judged rather than left to the sample, and it is first in the label queue (C1), because a judge is least reliable on adversarial input.

**Proven by** `safety-readings-are-counts-from-the-turn` and `a-rate-states-the-population-it-was-computed-over` (unit), `SafetyReadingsPanel` (unit). **Owed:** the `evaluation-verdicts` e2e phase extended to a capability refusal.

### C6. A frustration reading per conversation (FR26)

**Status:** built with unit tests and deployed to dev on 2026-10-27; **NOT VERIFIED** on a deployment, and no e2e asserts it yet.

**What.** Whether a person had to work to be understood, per person per conversation: a thumbs-down marked "asked again" on the assistant's answer, a declined drift offer, a handover nobody answered within ten minutes, and stopped work.

**Specific to this platform.** Every signal is a recorded event, not a phrase matched in what someone wrote (tenet D11): vote reasons, drift outcomes, handover markers and the `stopped` marker a stop's acknowledgment now carries (who stopped, and how many tasks it cancelled). Thumbs alone are given by too few people to stand as a satisfaction measure (they are a floor on dissatisfaction, SPEC-ADMIN-CONSOLE-EFFECTIVENESS FR20), which is why this reading combines them with signals every conversation produces.

**How. No new judge.** `frustration` counts the signals for each person in each conversation an assistant answered in the window, then reports per assistant how many of those people hit a signal, and the conversations behind it, each openable. A conversation row counts people and the most any one person had; two people's signals are never added together. A vote counts for the assistant whose answer it is on; the other three belong to the conversation, so they count for every assistant the person spoke with there, and the reading says so. A judged multi-turn reading (conversation completeness, role adherence) waits until this count shows where one is needed.

**Proven by** `frustration-is-counted-per-person-per-conversation` (unit: every signal from a recorded event and none from message text, per person first, no sums across people, team binding, the stop marker) and `FrustrationPanel` (unit). **Owed:** an e2e that stops work and reads the signal.

### C7. Retrieval contribution per passage (FR24)

**Status:** built with unit tests and deployed to dev on 2026-10-27; **NOT VERIFIED** on a deployment, and no e2e asserts it yet.

**What.** For a turn that retrieved context, which passages the answer rests on, beside the groundedness verdict that says whether it stayed within them, per intent and per context source. A passage that was retrieved and not used is a retrieval finding, owned by whoever curates the context source, not by the assistant's team.

**Specific to this platform.** Retrieval is scoped per classification before it runs, so a reading here is never about whether a passage should have been reachable; it is about whether the passages that were reachable were the ones that helped.

**How.** The groundedness judge already receives the request, every retrieved passage and the reply, and now returns in the same call the passages the reply's claims rest on. The row stores `used_passage_count` and `passage_sources` (each passage's source, title and whether it was used, migration 085); the passage reader keeps the `sourceId` the turn has always recorded. The Effectiveness tab reports the share of retrieved passages used per intent with its population, and **Retrieval by source** shows how often each source was retrieved and used. Judging each passage's relevance to the request in isolation is not used: it correlates weakly with answer quality, while a passage's contribution to the answer is the reading that tracks it.

**Not here.** Recall, whether the right passages were retrieved at all, needs a reference answer per request. It belongs to a dataset tool attached to the archive (Non-Goals: dataset workbench), or to C1's set.

**Proven by** `a-reply-names-the-passages-it-rests-on` (unit: one call, distinct passages only, NULL rather than "used none", sources in order, both rows written, per-source query) and `EffectivenessTab.evalSignals`, `RetrievalSourcesPanel` (unit). **Owed:** the `evaluation-verdicts` e2e phase extended to a turn that retrieved context.

### Housekeeping

**Status:** built with unit tests and deployed to dev on 2026-10-27; **NOT VERIFIED** on a deployment.

- **A reader for what was recorded and never read.** `template_outcomes` reads the template check result every delivery records, per template and with the template versions a row spans, and the Effectiveness tab shows it as **Document templates**.
- **Removed what nothing writes or measures.** Migration 088 drops `agent_scores`, which nothing writes, once migration 075 has finished updating it. The intent reroute target is removed: nothing writes the reroute flag. The two drift detection rate targets are removed rather than drawn: a missed drift is not observable, so a true-positive rate cannot be measured, and the drift panel reports accuracy over the offers judged with no target, by design.

**Proven by** `housekeeping-readers-and-removals` (unit) and `TemplateOutcomesPanel` (unit).
