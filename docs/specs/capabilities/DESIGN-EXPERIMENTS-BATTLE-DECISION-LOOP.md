# DESIGN: Experiments and Battle - Objective, Briefing, Lifecycle, and Decision Loop

**Status:** Implemented. The §4.3 drill-down's real-data reconciliation is **verified live** by `e2e/experiments.spec.ts` ("the drill-down reproduces the aggregate: same count, same mean, per variant"); `e2e/experiment-results-trust.spec.ts` extends that check to every experiment type through the admin console, and needs a live run. **§5's gate is built and deployed but has never been executed**, and its precondition is enforced in the console rather than the API (§5, build status). `accuracy` has no measurement of its own inside §4 (§4.5); §5 is its measurement. **Layer:** Core platform (capability). **Plane:** core. **Verified by:** `backend/test/lib/experiment-stats.test.ts` (the statistics in §4), `backend/test/lib/experiment-types-and-lifecycle.test.ts` (the state machine in §3.2 / A.3), `backend/test/lib/experiment-outcome.test.ts` (the verdict rule in §4.4), `backend/test/lib/battle-outcome.test.ts` (per-user picks, A.4), `backend/test/analytics-aurora/analytics-query.test.ts` (the two human axes in §4.3: that each is emitted independently of the metric sample floor, that absence differs from zero, and that a small lopsided sample is not called decisive), `backend/test/lib/variant-feedback-drilldown.test.ts` (one counted vote per voter, and that each drill-down selector returns exactly the records its aggregate counts), `backend/test/analytics-aurora/analytics-query.drilldown.test.ts` (the three drill-down queries and their full-match totals), `frontend/packages/admin/src/components/admin/ExperimentDrillDown.test.tsx` (the on-screen reconciliation, including that a mismatch is announced rather than rendered quietly), `backend/test/lib/experiment-worked-examples.test.ts` (every figure quoted in the §4.6 and §5.3 worked examples, computed by the same functions the recommendation calls).

**Coverage:** `e2e/experiments.spec.ts` · `e2e/battle.spec.ts`

**Related:** [SPEC-BATTLE.md](./SPEC-BATTLE.md) · [DESIGN-BATTLE.md](./DESIGN-BATTLE.md) · [DESIGN-MULTI-ASSISTANT-TURN-ENGINE.md](./DESIGN-MULTI-ASSISTANT-TURN-ENGINE.md) · [SPEC-ADMIN-CONSOLE.md](../interface/admin/SPEC-ADMIN-CONSOLE.md) · [GUIDE-AB-TESTING-AND-BATTLES.md](../../guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md) · [TENETS.md](../../overview/TENETS.md)

> Section numbers in this document are referenced from source comments (`DESIGN §1.2`, `§2.2`, `§3.2 / A.3`, `A.5`). Renumbering a section breaks those references.

---

## 0. Summary

Experiments and battles are **one feature by design**, not two. A battle is the hands-on, human-feedback mode of an A/B experiment: `battleEnabled` is a field on the experiment record, the combatants **are** the experiment's two variants, and picks flow back as a per-variant `battle_wins` column (SPEC-BATTLE §2, FR8).

Four capabilities make that loop close into a decision:

1. **A written objective** on the experiment: the decision it informs, a primary metric, guardrails.
2. **A battle-start briefing and prompt steering**, so users are told what is being tested and nudged toward decision-relevant prompts.
3. **A guarded lifecycle** for experiments and battles, with an audit trail and an honest close.
4. **Real statistics** and a rule that folds the human battle pick in as its own axis.

### Invariants

These are load-bearing constraints from the specs and tenets. Every mechanism below holds to them.

- **INV-1 - Never auto-route.** Results recommend; promotion is always a deliberate manual operator action (SPEC-BATTLE FR8 and Non-Goals).
- **INV-2 - Additive schema.** Deployed experiments keep working; new fields are optional and absent means prior behaviour (TENET 3).
- **INV-3 - Honest about confidence.** Low-sample flags, `pending` states, and the advisory tags are preserved.
- **INV-4 - No algorithmic judge decides the battle.** The human pick and objective telemetry are first-class; a model-as-judge control loop is out of scope (SPEC-BATTLE Non-Goals). Statistics are computed over the picks and metrics, but the quality verdict per battle stays the human's.
- **INV-5 - Governance holds.** Battle stays premium-gated and single-classification; no result escalates a classification's model access (TENET 4).

## Business value

The through-line is faster, cheaper, more defensible model and persona decisions, with a human in the loop and an auditable trail: the concrete expression of TENET 5 (fine-grained cost, quality and latency control) and TENET 4 (governance is infrastructure).

| Capability | Value | Who gains |
|---|---|---|
| **Written objective** (§1) | Makes an experiment a decision that was informed rather than numbers that moved. The hypothesis and ship criteria are explicit, so a test can be handed off, revisited, or audited months later. | Operator, AI developer |
| **Battle briefing and steering** (§2) | Raises decision quality per battle: users generate relevant comparison data, so fewer battles reach a confident call. That cuts billed inference and time to decision, and makes a battle a credible stakeholder demo. | End user, AI developer, stakeholder |
| **Lifecycle** (§3) | Removes foot-guns: start a new test without hunting for the blocker, never silently corrupt a running test, close inconclusive tests honestly. Every transition is audited. | Operator, QA |
| **Decision logic** (§4) | Prevents shipping on noise, and makes the human pick count toward the conclusion. Confidence that survives review. | AI developer, operator |

## Roles and use cases

Personas are those defined in [SPEC-BATTLE §3](./SPEC-BATTLE.md), plus the stakeholder they mention in passing.

**Admin / operator**
- Write the objective, its primary metric and its guardrails, so a reviewer knows why the test runs and what would make the deployment ship (§1).
- When a classification is already occupied, End, Pause or Delete the blocker inline, each behind a confirmation, without hunting through the console (§3.2.1).
- Pause a running test and resume it later with its data intact (§3.2.1).
- Delete a never-started draft outright, and keep a tombstone for a test that ran (§3.2.1, L8).
- End a test that ran and record the outcome, including "No decision" (§3.2.1).
- Read results that show statistical significance and confidence rather than raw averages (§4).

**AI developer**
- Have human battle picks folded into the recommendation as a distinct axis (§4.3).
- See metric-versus-human disagreement surfaced explicitly rather than averaged away (§4.4).

**End user**
- In a battle-enabled channel, see what is being decided and which kinds of prompts help (§2).
- Use clickable starter prompts to contribute a useful comparison in one tap (§2.2).

**QA / test engineer**
- Rely on a guarded lifecycle: no silent overwrite of a running test, no battle lost to a race (§3.2, §3.4).

**Stakeholder**
- Have a battle state the decision and let them feel the difference, without reading a dashboard (§2, §4.4).

---

## 1. The written objective

### 1.1 What it carries

An experiment records the decision it informs, not just a threshold. The objective holds prose (the decision), one primary quantitative criterion, veto conditions, and how much the human signal counts.

### 1.2 Schema

The objective is a single sub-object, extended additively so a record carrying only `{metric, target}` keeps working (INV-2):

```ts
export type ExperimentObjectiveMetric = 'cost' | 'accuracy' | 'quality' | 'latency';

export interface ObjectiveGuardrail {
  metric: ExperimentObjectiveMetric;
  // 'no_worse_than' bounds a regression; 'at_least' bounds an improvement floor.
  direction: 'no_worse_than' | 'at_least';
  bound: number; // percentage, same units as `target`
}

export interface ExperimentObjective {
  metric: ExperimentObjectiveMetric;   // PRIMARY quantitative criterion
  target: number;                      // % decrease for cost/latency; % level for quality/accuracy
  statement?: string;                  // the decision this test informs (<=500 chars, sanitized)
  guardrails?: ObjectiveGuardrail[];   // metrics that must NOT regress for a ship (<=3)
  humanPickWeight?: number;            // 0-1: how much the battle human pick counts (default 0)
}
```

- `statement` is the written objective. The create form requires it; the API warns rather than rejecting when it is absent, so programmatic callers are unaffected (INV-2).
- `guardrails` pre-register the decision rule ("ship treatment if quality is at least +5% **and** cost is no worse than +20%"). Pre-registration also protects the statistics from multiple-comparison fishing (§4).
- `humanPickWeight` defaults to `0`, so folding the human axis into the verdict is opt-in.

### 1.3 API and validation

`validateAndSanitizeExperiment` sanitizes and length-caps `statement`, validates each guardrail's metric and that its `bound` is within 0 to 100, and validates `humanPickWeight` is within 0 to 1. All are optional, so an absent objective passes. This rides the existing `POST /admin/experiments` upsert; no new endpoint.

### 1.4 Console

The create form presents an **Objective** block: a required "What decision will this test inform?", the metric and target as **Primary metric**, and an optional **Guardrails** repeater. The results view renders the statement above the metric progress and shows guardrail pass or fail chips next to the primary-metric badge.

---

## 2. Battle-start briefing and prompt steering

### 2.1 Why it exists

Without a briefing, users generate the comparison data blind, so battles exercise prompts irrelevant to the decision. The briefing is the objective's `statement` (§1) put in front of the people producing the evidence.

### 2.2 The briefing

The briefing is **semi-blind by design**: it states the decision and steers prompts, but does not reveal which alias is which model. SPEC-BATTLE's aliases exist for that reason.

Two surfaces carry it:

1. **On enable**, the broadcast names the decision and the useful prompt shapes alongside the existing announcement.
2. **Per battle**, a compact dismissible banner above the first battle turn repeats the decision line and offers starter prompt chips that prefill the composer.

**Prompt steering** comes from a small static table keyed by the experiment's target intent, so the battle exercises what the experiment measures. Each entry is a coaching line plus two or three starter chips:

| Target intent | Coaching line | Starter chips |
|---|---|---|
| `general_qa` | Ask real questions your users ask. | "Explain X to a new hire" · "What is the difference between A and B?" |
| `code_generation` | Ask a real coding task you would actually ship. | "Write a function that ..." · "Add retry/timeout to this call" |
| `code_review` | Paste real code and ask for a review. | "Review this for bugs" · "Is this concurrency-safe?" |
| `document_extraction` | Give a document and ask for specific fields. | "Extract the totals as a table" · "Pull every date and owner" |
| `report_generation` | Ask for a report you would actually send. | "Draft a one-page status report on ..." · "Summarize this for execs" |
| `image_generation` | Describe an image you actually need. | "A hero image for ..." · "An icon set for ..." |
| `strategic_analysis` | Pose a real judgment call. | "Pros and cons of migrating to ..." · "What are the risks of ...?" |
| `workflow_actions` | Ask it to drive a multi-step task. | "Plan and track the steps to ..." · "Walk me through ..." |

Intent-type experiments use their own row. Base, classification and profile experiments span intents, so they seed from the objective statement plus a generic line. The table is example copy, not policy, and a deployment may override it.

### 2.3 Data flow

The enable handler already loads the experiment, so it carries `objective.statement` and `intent` onto the `ChannelBattleConfig` row (A.5). The frontend renders the starter chips; the backend supplies the copy. The briefing fields are readable by non-moderators, which is the point: the people running battles are the ones who need them.

### 2.4 Invariant checks

- INV-4 and semi-blindness: the briefing names the decision, not the models. Aliases stay opaque, and model identity appears in the scorecard only after answers land.
- INV-5: the briefing shows only where battle is already enabled, so it opens no new exposure surface.

---

## 3. Lifecycle

### 3.1 What the lifecycle guarantees

A running test is not silently overwritten, a finished test cannot be reopened, a test that collected data cannot vanish without a trace, and every transition records who made it.

### 3.2 Experiment state machine

```
draft ──activate──▶ active ──pause──▶ paused ──resume──▶ active
                      │                                   │
                      └──────────── complete ─────────────┴──▶ completed (TERMINAL)

draft (never started) ──delete (confirmed)──▶ (record hard-deleted; nothing to preserve)
active|paused|completed ──delete (confirmed)──▶ deleted (TERMINAL tombstone; labels + audit kept)
on endDate reached: active|paused ──auto──▶ completed
```

The rules the machine enforces:

- **`draft`** never resolves traffic. An omitted status still means `active` for existing callers (INV-2); the console's Create defaults to draft with an explicit "Create and Activate".
- **Edits to a live experiment are guarded.** Once any variant has accrued exchanges, the variant models and count are immutable; only weight, `endDate` and `objective` may change. `createdAt` is preserved on update, never clobbered. Changing what is being compared means a new experiment with a new id, which is cheaper and cleaner than pooling data across a variant swap.
- **`completed` is terminal.** Any transition out of it is refused.
- **Weights are validated**: each is a non-negative integer and the set sums to 100.
- **`startDate` is honoured at resolve time**, and a past `endDate` auto-completes the experiment.
- **A missing id returns 404**, not 500.
- **An append-only `transitions` audit** records every status change and guarded edit with the acting admin, per TENET 4.
- **Delete is hard if there is nothing to preserve, soft otherwise.** A never-started draft with no data is removed outright. Anything that ever ran becomes a `deleted` tombstone, so historical exchanges keep their variant labels in analytics and the transition audit survives. The choice is made server-side from the record's state and exchange count, not by the caller. Either way, Delete frees the classification and releases any bound alt-bot slot.

### 3.2.1 Freeing a classification

Starting an experiment that conflicts with one already active on a classification returns **409**. The console turns that into a resolution flow listing the blockers and offering exactly three ways to free the classification, each behind a confirmation stating the consequence:

| Action | Transition | Results | Resumable? |
|---|---|---|---|
| **End** | `active\|paused → completed` (terminal) | Kept | No |
| **Pause** | `active → paused` | Kept | Yes |
| **Delete** | `any → deleted` (soft) | Historical exchanges keep their labels | No |

Behaviour notes:

- **All three require confirmation.** End and Delete are terminal and carry the stronger, consequence-stating copy; Pause is reversible but still confirmed, because it changes a running test's data collection.
- **Ending a test that ran records a decision, and "No decision" is the default.** A test that ever collected data cannot be closed silently, and the operator is never forced to declare a winner (INV-1, INV-3):

  ```ts
  export interface ExperimentDecision {
    outcome: 'promoted_treatment' | 'kept_control' | 'no_decision';
    note?: string;   // optional prose, <=500 chars
    by: string;      // admin ARN from token
    at: string;      // ISO timestamp
  }
  ```

  `promoted_treatment` and `kept_control` are the operator's record of what they did after reading the advisory recommendation. Recording the decision is not the promotion itself; INV-1 still holds. A never-started draft has nothing to decide, so the prompt is skipped.
- After a confirmed action frees the classification, the console retries the original create so the operator is not sent back to the start.
- Each action appends to the transition audit with the acting admin's ARN.

The API keeps confirmation on the console side: End and Pause reuse `POST /admin/experiments/{id}/status`, Delete uses `DELETE /admin/experiments/{id}`, and the API executes the requested transition and returns the freed classification so the console can retry.

### 3.3 Battle lifecycle guarantees

A battle is bounded by four properties: only one runs per channel at a time, a stalled round fails loudly rather than silently, every member's pick is retained, and completion is signalled explicitly rather than inferred.

### 3.4 How each is enforced

- **One active battle per channel.** Before claiming the round-1 fan-out, the flow reads the channel's `activeBattleId` and its state. If a battle is in flight (a non-terminal participant that has not TTL-expired), the second `/battle` gets an explained no-op reply to the sender and nothing is broadcast. The pointer is a soft lock: a stale pointer whose rows are all terminal or TTL-aged falls through and the new battle proceeds. Deriving the `battleId` first means a redelivery of the *same* `/battle` message is not blocked, because it points at its own id and is deduped by the fan-out claim.
- **Fail loud.** Round 1 carries a deadline. A participant still outstanding past it produces an explicit turn naming the assistant that did not finish, and the battle either degrades to round 2 with a visible note or closes with a message. Never a silent TTL expiry.
- **Per-user picks.** Outcomes are a `votes` map keyed by `userSub` rather than one overwritable row, so each member's pick is retained and the battle winner is a tally. Re-picking overwrites per user, not globally. A legacy single-row outcome is read as one pick keyed by its `chosenByUserSub` during cutover.
- **Terminal marker.** The scheduler writes an explicit completion marker, so analytics, the tally UI and any future notification get a signal instead of inferring from absence.

---

## 4. Decision logic

### 4.1 What it computes

Confidence is a computed statistic, not an opinion or a fixed margin, and the human signal reaches the decision. Everything here stays advisory (INV-1) and never becomes an auto-judge (INV-4).

### 4.2 The statistics

Metrics are split by type and each gets the appropriate test.

**A. Rate metrics** - proportions, compared with a **two-proportion z-test** (Fisher's exact when any cell is small) and a **Newcombe** confidence interval on the difference, which pairs with the per-variant **Wilson score interval** and stays robust at small n where the normal approximation is not.

Two rates are tested this way today: the **battle win rate** and **user approval** (thumbs). **Compliance, fallback and task completion are reported as descriptive columns only** - they are computed and displayed, but they are not tested, carry no interval, and cannot be selected as `objective.metric` or as a guardrail, because `ExperimentObjectiveMetric` admits only `cost`, `accuracy`, `quality` and `latency` (§1.2). Wiring them is a change to that enum and to the outcome evaluator, not a display change.

**B. Continuous metrics** - score, latency, cost, tokens. The results query carries per-variant standard deviation and count alongside the mean, so the comparison is a **Welch t-test** (unequal variance), giving a p-value and a confidence interval on the mean difference.

**C. Winner labelling** - each metric reads as one of `no difference` (the interval crosses zero), `leads (not significant)`, `leads (p < 0.05)`, or `leads (p < 0.01)`. A one-point lead on thin data reads as not significant rather than as a winner.

**D. Power** - the minimum is power-aware. Given the observed baseline and the minimum detectable effect implied by `objective.target`, the results show an **underpowered, need about N more per variant** state rather than a premature winner. A hard floor still applies below which nothing is claimed. That floor ships deliberately low as a demonstration floor, not a decision floor, and the operator guide recommends raising it before anyone routes traffic on a verdict.

**E. Confidence** maps from the computed result, not from a model's self-assessment:

- `high`: primary metric significant at p < 0.01, powered, and all guardrails held.
- `medium`: significant at p < 0.05 and guardrails held.
- `low`: not significant, underpowered, or a guardrail regressed.

Generated prose narrates the computed numbers; it does not source the confidence.

### 4.3 The human axes

There are **two** human signals, and they are separate from each other and from the metric verdict.

**Battle picks.** A binomial human-preference signal: wins over decisive picks, with a Wilson interval and a test of whether preference differs from 50%. A tie credits neither side, so the denominator is decisive picks rather than battles fought. `objective.humanPickWeight` controls how much this axis counts when both signals exist; the default of 0 preserves metric-only behaviour.

**User approval.** Thumbs up and down collected on ordinary (non-duel) traffic, reported as a tested rate: the difference between variants with a two-proportion test, a Newcombe confidence interval, and Fisher's exact for small cells. This is the higher-volume human signal, because a pick needs a duel while any exchange can carry a thumb.

**Why three axes and not one number.** They measure different things. The primary metric is a randomised measurement. A battle pick is a forced choice between two visible answers. A thumb is self-selected feedback on a single answer. Averaging them would hide exactly the disagreement an operator needs to see, so each is reported with its own interval and the combination rule in §4.4 is explicit rather than implicit.

**Neither human axis is gated by the metric sample floor.** They are measured on different populations: the floor counts probabilistic traffic, which deliberately EXCLUDES battle turns via the `assignmentMode` filter, while every pick comes from a battle. Gating the picks behind that floor withheld the human signal precisely when battles were the evidence being gathered, so a battle-led evaluation could accrue any number of picks and report no human axis at all. Both axes are therefore emitted whenever the votes or picks exist, and an underpowered metric read says so while still reporting them.

**Absence and zero are different.** An axis is omitted entirely when nobody has voted or picked. A zero-filled axis would render as a real 0% result and read as evidence.

**Attribution is per experiment.** Both axes key on the experiment id, not on the variant id alone: `control` and `treatment` collide across experiments, so a variant-only key mixes one experiment's votes into another's row whenever they share a variant id and intent.

**One counted vote per voter.** The feedback table is append-only: a voter who revises a thumb, or withdraws one, leaves several records for the same reply, and the whole trail is retained for audit. The approval rate counts only the latest record per (voter, message), so a revised vote counts once on the side the voter ended on and a withdrawn vote counts not at all. The collapse runs before the date window, because a vote revised today supersedes its original however old that original is.

**The bar is reproducibility, not navigation.** The feature is done when an operator can reach a view that lets them **calculate the same result themselves** and read the actual transcripts behind it, subject to permission. They should not have to trust the verdict; they should be able to recompute it. In practice that means showing the per-exchange values that roll up (score, latency, cost, tokens, thumb or pick) rather than a list of links, showing the complete scored set rather than a recent sample, and reconciling exactly: the row count equals `exchange_count` and the mean of the shown scores equals `avg_score`. A view that silently samples is a false pass in a different medium.

That reconciliation is also the feature's own test. If the drill-down and the aggregate disagree, the rollup is wrong, and the surface should say so rather than render a quiet contradiction.

**Shape (owner decision, 2026-08-06): a companion query, not a widened one.** The aggregate rows stay aggregate. A separate per-exchange query returns the rows behind one axis of one experiment, carrying that axis's own predicate. Widening `experiment_results` would make every dashboard read pay for detail almost no read wants, and would blur the three populations §4.3 keeps apart.

**Access.** The credential mechanism already exists: the admin plane vends scoped, short-lived, audited credentials, and the Aurora admin read already derives redaction and deletion from the `-RED` and `-DEL` sibling rows, with `moderation_actions` recording who acted and when. What this feature adds is the REQUEST path, not the mechanism.

#### Redaction and the audit trail: an unresolved tension, flagged deliberately

A redacted exchange **still contributed to the score**. Removing it from the drill-down would break the reconciliation in the acceptance criterion above, and would misrepresent what the verdict was actually computed from. So the exchange stays in the set and its numbers stay visible.

Whether its CONTENT should render is a different question, and this spec does not settle it. The two obligations genuinely conflict:

- **Auditability** says an operator must be able to see what produced a number they are about to ship on.
- **Redaction** says a participant asked for that text to stop being readable.

The current position is the conservative split: **the row and its measurements remain; the transcript for a redacted exchange is withheld and labelled as redacted**, so the arithmetic still reconciles while the retracted text is not re-surfaced. That keeps both obligations intact at the cost of a partially-auditable row.

**This area needs more attention than it has had.** Open questions, none of which should be answered by whoever implements the query without a deliberate decision:

1. **Redaction and deletion are not the same act.** `-RED` hides content; `-DEL` removes a message. A deletion made under an erasure request may carry an obligation the score itself inherits, in which case retaining a derived metric is a separate question from re-displaying the text.
2. **Does a score derived from erased content need to be excluded, recomputed, or retained with a note?** Retaining it is the current behaviour by default, not by decision.
3. ~~**Does the count of withheld rows need surfacing?**~~ **Answered: yes, and it is.** The drill-down states "3 of these 40 rows have a redacted or deleted message" and labels each such row, so the view cannot look complete when it is not. The remaining questions above are unchanged by that.
4. **Who may see a redacted row's metadata at all** - the graded admin levels are not currently distinguished for this surface.

It only earns that trust under three further conditions, and a drill-down that misses any of them is worse than none, because it puts an operator in front of evidence that contradicts the number beside it at the moment they decide whether to ship.

1. **It must resolve to exactly the scored set.** Same experiment id, same `assignmentMode` split as the aggregate it sits beside. A looser filter surfaces exchanges that did not count.
2. **What is scored must measure what the objective names.** This is not yet true of `accuracy`, which is selectable but aliases to the evaluator score (§4.5). That must be really measured or removed from the selectable metrics before a drill-down exposes the mismatch.
3. **Each axis needs its own drill-down.** The axes have different populations, so one shared control would be wrong for most of them. Each link carries its own predicate and the surface states which population it shows.

#### What the drill-down is

Four populations, four predicates, four controls, each rendered next to the number it explains:

| Control | Population | Reconciles against |
|---|---|---|
| Sample (exchanges) | Probabilistic turns for one variant. Battle turns excluded, matching the A/B averages. | `exchange_count` and `avg_score` |
| Battle scorecard turns | Battle turns for one variant: the replies produced inside a duel. | `turn_count` and the battle `avg_score` |
| User approval | One row per counted vote on ordinary traffic. | `feedback_count` and `approval_rate` |
| Battle wins | One row per counted pick. Ties credit neither side, so they are neither counted nor shown. | `battle_wins` |

Battle turns and battle picks are deliberately separate controls. A duel produces a turn from each side and at most one pick per person, so a single control would misreport whichever axis it was not filtered for.

**The reconciliation is stated on screen, and it is allowed to fail.** The view recomputes the count and the mean over the FULL match, not the page, and reports whether they equal the figures the console displays. A disagreement renders as "DOES NOT reconcile with the result above" with both numbers, because a quiet contradiction at the moment of a ship decision is worse than a loud one.

**Two conventions have to be stated or the number is not reproducible even with every row in view.** An unscored exchange counts as zero in the mean, matching the aggregate, so the view reports how many rows carry no evaluator score and notes that part of the average is scoring coverage rather than reply quality. And a paginated view states the full N and that the checked figures are computed over all of it.

**A pick carries no conversation reference of its own.** `battleId` is a one-way hash of the channel and the user message, so a pick is traced to its conversation by matching that id against the archived battle turns rather than by decoding it. A pick whose battle has no archived turn keeps its row, reports no conversation, and is counted in a stated total of unresolved picks; dropping it would make the list disagree with the win count it explains.

### 4.4 Combining the signals

The recommendation is a pre-registered decision rule over the primary metric, the guardrails, and the battle-pick axis, evaluated in order:

1. **Not enough data** produces `keep_running`. If the primary metric is underpowered for its target-derived effect size, the rule stops here regardless of the point estimate.
2. **A guardrail breach vetoes a ship.** A guardrail that has significantly regressed past its bound makes the verdict `keep_control` even when the primary won, and the rationale names the breached guardrail. A primary win bought with a cost or compliance regression is not a ship.
3. **Primary significant, treatment favoured, guardrails held** produces `promote_treatment`.
4. **Primary significant, control favoured** produces `keep_control`.
5. **Enough data, no significant difference** produces `equivalent`, which is a real answer rather than a failure. If the objective is cost or latency the cheaper or faster side is recommended as a tiebreak; otherwise `keep_control`. It is always surfaced as equivalent, never dressed as a winner.

**The human axis** is shown next to the verdict always. When `humanPickWeight` is above zero and the human preference is itself significant, agreement with the primary raises confidence, and **disagreement is surfaced as an explicit conflict rather than averaged away**: "Metrics favour control (p<0.05), but humans preferred treatment 72% [58-83%]. Your call." Honesty over a false single number (INV-3).

**A verdict is not a decision.** The computed verdict is advisory (INV-1). The operator's recorded `ExperimentDecision` (§3.2.1) is separate and may differ, including `no_decision`. Storing both lets the console show recommended versus chosen, a cheap meta-signal on how far the statistics are trusted, without letting the recommendation act on its own.

### 4.5 What does not change

- No auto-promotion. The verdict is a recommendation with computed confidence, and the advisory tag stays.
- Athena mode shows the honest Aurora-only banner, because the statistics need the analytics database.
- `accuracy` has **no measurement of its own** in §4. It is selectable as `objective.metric`, and the evaluator maps it to the same underlying `score` field that backs `quality`, relabelled (`experiment-stats.ts` `case 'accuracy'` returns `{ key: 'score', label: 'accuracy' }`). Its real measurement is §5's gate, which is a separate mechanism on a separate corpus, not a metric in this rollup. Until §5 is wired end to end, prefer `quality` here, which names what is actually being read. The operator guide marks the accuracy objective *(not available)* for this reason.
- **A `classification` experiment reports rows, but both variants share one response model.** The rollup keys on the `experiment_id` stamped on an exchange, and this type now stamps it for the turns its classifier labelled (§5, build status). What it does NOT do is change the model that answers, so `avg_score` compares a model against itself and correctly shows no difference. Its evidence about labelling comes from §5's gate; §4 tells you what happened downstream of the different routing.

### 4.6 Worked examples

Every figure below is produced by the functions named beside it and pinned by `backend/test/lib/experiment-worked-examples.test.ts`, so this section cannot drift from the code without a test failing. One experiment runs through all of it: **control** is the incumbent, **treatment** is the challenger, the objective is `quality` with a target of 5%, and the single guardrail is `latency no_worse_than 10%`.

#### 4.6.1 The per-variant aggregate

The results query groups by (experiment, variant, model, intent, assistant), so a variant is usually several rows. The console collapses them by exchange count.

| Variant | Intent | Exchanges | Score |
|---|---|---|---|
| control | research | 30 | 72.0 |
| control | general | 10 | 60.0 |
| treatment | research | 28 | 78.0 |
| treatment | general | 12 | 70.0 |

Control: `(72.0 x 30 + 60.0 x 10) / 40` = `2760 / 40` = **69.0** over **40** exchanges.
Treatment: `(78.0 x 28 + 70.0 x 12) / 40` = `3024 / 40` = **75.6** over **40** exchanges.

The statistics need a standard deviation as well as a mean, and pooling two groups is not an average of their two SDs. `poolGroups` uses the exact between/within decomposition: from `{n:30, mean:72.0, sd:16.0}` and `{n:10, mean:60.0, sd:20.0}` it returns `{n:40, mean:69.0, sd:17.617}`. The pooled SD is **larger than either input** because the group means differ, and that spread is real variance in the variant's traffic.

#### 4.6.2 The drill-down reconciliation, and why unscored rows matter

Opening the exchanges behind treatment returns `total = 40` and a full-match mean of `75.6`. Both equal the aggregate above, so the view reports *Reconciles with the result above*. Had the predicate been looser (battle turns left in, say), the count would move and the view would say so.

The mean counts an unscored exchange as **zero**, because the aggregate does (`AVG(COALESCE(relevance_score, 0))`). Suppose 32 of treatment's 40 exchanges carry an evaluator score and those 32 average **94.5**:

`94.5 x 32 / 40` = `3024 / 40` = **75.6**

The same 75.6, from a very different reality. The drill-down therefore states *8 of 40 exchanges carry no evaluator score*, because a reader who assumes the mean is over scored replies would read a 94.5-quality variant as a 75.6-quality one. Raising evaluator coverage moves this number without any model changing.

#### 4.6.3 The approval rate, and the collapse in front of it

The feedback table is append-only. Take 62 raw records for treatment:

| Records | Shape | Counted |
|---|---|---|
| 50 | one vote (42 up, 8 down) | 50 |
| 6 | 3 voters who revised up then down | 3 (the down) |
| 4 | 2 voters who voted up then cleared | 0 |
| 2 | one vote (up) | 2 |

Counting rows gives **60** votes at **49 / 60 = 81.7%**: the three superseded ups and the two withdrawn ups are still in the numerator. Counting the latest record per (voter, message) gives **55** votes at **44 / 55 = 80.0%**, and the two cleared pairs drop out entirely because their latest record is a withdrawal.

The second is the rate, and the drill-down lists exactly those 55 rows. Control, by the same rule, is **30 / 48 = 62.5%**.

#### 4.6.4 The approval axis (rate metrics, §4.2-A)

`twoProportionTest(44, 55, 30, 48)`, treatment against control:

| Output | Value |
|---|---|
| `pA` (treatment) | 0.800 |
| `pB` (control) | 0.625 |
| `delta` | +0.175, i.e. **+17.5 percentage points** |
| `ci` (Newcombe) | [+0.0007, +0.3397], i.e. **+0.07pp to +33.97pp** |
| `pValue` | 0.0489 |
| `method` | `z` (every cell is 5 or more) |
| significant | **true**, the interval excludes zero |

Note how close this is: the interval's lower bound is **0.07 of a percentage point** above zero. A single vote either way would flip the significance, which is exactly why the axis is reported with its interval rather than as "80% versus 62.5%". It is also why 4.6.3 matters: the uncollapsed 81.7% would have been tested against a different denominator and reported a different interval from the same underlying opinions.

#### 4.6.5 The battle pick axis (§4.3)

27 duels produce 2 ties and 25 decisive picks, 18 for treatment. Ties credit neither side and leave the denominator, so `humanPickTest(18, 25)`:

| Output | Value |
|---|---|
| `picks` / `wins` | 25 / 18 |
| `winRate` | 0.72 |
| `ci` (Wilson) | [0.524, 0.857] |
| `pValue` | 0.0433 |
| `significant` | true, the interval excludes 50% |
| `favors` | `a` (treatment) |

The drill-down behind this lists 25 rows, not 27. The two ties are absent because they moved no number, and the view says so rather than letting a shorter list read as fewer duels.

#### 4.6.6 The primary metric (continuous, §4.2-B)

Quality across the full run, control `mean 69.0, sd 18.0, n 500` against treatment `mean 75.6, sd 15.0, n 500`. `welchTTest(75.6, 15.0, 500, 69.0, 18.0, 500)`:

| Output | Value |
|---|---|
| `delta` | +6.6 score points |
| `ci` | [+4.544, +8.656] |
| `t` | 6.299 |
| `df` | 966.57 (Welch, not 998) |
| `pValue` | 4.55e-10 |
| `deltaPct` | `6.6 / 69.0 x 100` = **+9.6%** |

Two things to read carefully. The **CI is on the raw mean difference in the metric's own units**, not on the percentage: +4.5 to +8.7 score points. And the API rounds `pValue` to four decimals, so a p this small is reported as `0.0000`; that is a display rounding, not a claim of certainty.

#### 4.6.7 Power (§4.2-D)

The minimum detectable effect comes from the objective's target, not from a fixed number: a 5% target against a control mean of 69.0 is `0.05 x 69.0` = **3.45 score points**. With `sd = 18.0`, `requiredSampleForMean(18.0, 3.45, n)` gives:

`requiredN = ceil( (1.95996 + 0.84162)^2 x 2 x 18.0^2 / 3.45^2 )` = `ceil(427.3)` = **428 per variant**

- At `n = 500`: `powered: true`, `additionalNeeded: 0`.
- At `n = 40`: `powered: false`, `additionalNeeded: 388`, and the console says *underpowered, need about 388 more per variant* instead of naming a winner.

The same 40 exchanges that reconcile perfectly in 4.6.2 are nowhere near enough to decide on. Reproducible and decisive are different properties.

#### 4.6.8 A guardrail that holds, and one that cannot say

Latency, lower is better, `no_worse_than 10%`, against a control of `mean 1800ms, sd 600, n 500`.

**Treatment at `1850ms, sd 500`.** Welch gives `delta = +50ms`, `ci = [-18.5, +118.5]`, `p = 0.153`. As percentages of the 1800ms baseline: point estimate **+2.8%**, interval **-1.03% to +6.59%**. The whole interval sits inside the 10% margin, so `held: true`.

**Treatment at `1950ms, sd 700`.** Welch gives `delta = +150ms`, `ci = [+69.1, +230.9]`, `p = 0.00029`. As percentages: point estimate **+8.3%**, interval **+3.84% to +12.83%**.

The point estimate is inside the bound. The interval is not. So:

- `pointWithinBound: true` (8.3 is less than 10)
- `held: false` (12.83 is not less than 10, and the worst case consistent with the data is what a non-inferiority claim has to survive)
- `breached: false` (a breach requires the point estimate to be outside the bound AND the difference to be significant)
- `indeterminate: true`

**Indeterminate blocks a ship.** The data cannot rule out a 12.8% latency regression, and "we could not tell" must not read as "it held". This is the case a point-estimate check waved through: on thin or noisy data the estimate lands inside the bound by chance, and the ship goes out on ignorance.

#### 4.6.9 The verdict (§4.4)

`evaluateExperimentOutcome` over the numbers above.

**With the holding guardrail**, `humanPickWeight: 0.5`, and battle picks 18 to 7:

```
primary:     quality +9.6%, CI [4.5437, 8.6563], p 0.0000, significant, powered, favors treatment
guardrails:  latency +2.8% (bound 10%): held
human:       72% for treatment, CI [52.4%, 85.7%], significant
verdict:     promote_treatment
confidence:  high
humanAgrees: true
```

**With the indeterminate guardrail** and no picks recorded, from the *same winning primary metric*:

```
primary:     quality +9.6%, CI [4.5437, 8.6563], p 0.0000, significant, powered, favors treatment
guardrails:  latency +8.3% (bound 10%): indeterminate
human:       none recorded
verdict:     keep_running
confidence:  low
```

A significant, powered, 9.6% quality win does **not** ship, because the latency guardrail cannot be shown to have held. That is the rule working as pre-registered, and it is the single clearest reason to write guardrails down before the test rather than after the result.

#### 4.6.10 Cost, and metrics that are shown but not tested

Estimated cost per reply is priced from the model rate table: control $0.0021, treatment $0.0026, a `(0.0026 - 0.0021) / 0.0021` = **+23.8%** increase. That figure is descriptive until `cost` is named as the objective metric or as a guardrail, at which point it is tested by the same Welch path as quality with the direction inverted (lower is better).

Compliance, fallback rate and task completion are computed and displayed but never tested: they carry no interval, and `ExperimentObjectiveMetric` does not admit them (§4.2-A). A column on the results table is not evidence unless one of the tests above is behind it.

---

## 5. Classification experiments: the shadow gate, then the online confirm

A `classification` experiment changes which model LABELS a message. That is a change to routing, applied to real users, and the machinery in §4 cannot see it: §4 measures the ANSWER, and the answer is produced by a different model that the experiment did not change. Measuring a labelling change by the quality of the answers downstream is a proxy at best, and this section specifies the two-part mechanism that measures it properly.

**The order is deliberate.** Part A (§5.2, §5.3) answers *did labelling improve?* on archived traffic, exposing nobody. Only a passing Part A authorises Part B (§5.4), the ordinary traffic split that answers *were users better served?* Neither question substitutes for the other, and §5.4 exists to stop the first being mistaken for the second.

**Build status (2026-08-07).** Part A is built and deployed: the statistics (`mcnemarTest`), the ship criterion (`lib/classifier-gate.ts`), the storage (`classifier_replay_runs` / `classifier_replay_labels`), the replay job and its batch Lambda, the API lifecycle, and the adjudication surface.

**A replay has executed, and produced a verdict.** Haiku-3 against Sonnet-4-6 over a 30-message window: 30 considered, 30 replayed, both models called on every one, verdict `indistinguishable`. That proves the path end to end, including a Bedrock call from the replay role inside the VPC. It says nothing about production traffic: the corpus was test traffic of one shape, and a replay over an operator-chosen window is what the gate needs before it informs a decision.

One thing remains NOT done, and until it is, §5.4's precondition is weaker than this section reads:

1. **The §5.4 precondition is enforced in the CONSOLE, not the API.** The experiments API is DynamoDB-only while the gate's evidence lives in Aurora, so a programmatic caller can still create a classification experiment with no gate behind it. Closing it needs the experiments Lambda to resolve the gate over the data-plane seam.

**Part B's prerequisite.** A classification experiment stamps `experimentId` / `variantId` on the turns it labelled, so §4's machinery can see the type (the router resolves the classifier experiment and records the attribution on the turn, not only in its log). Two properties of that attribution are deliberate and worth knowing before reading a classification experiment's results table:

- **Only turns the LLM classifier actually ran on are attributed.** A greeting or acknowledgement is answered by the fast path without asking any model, so the variant did nothing and the turn is correctly absent. Attributing it would pad the experiment with exchanges it never touched, and because both the aggregate and the drill-down would read the same inflated set, the §4.3 reconciliation could not catch it.
- **Both variants show the SAME response model**, because this type changes the classifier and not the responder. So `avg_score` compares a model against itself and will show no difference. That is honest, and it is precisely why Part A exists: the labelling change is measured on the gate's corpus, while Part B measures what reached users downstream of the different routing.

### 5.1 Why this type needs a different mechanism

Intent classification is a deterministic function of the message, so both candidate models can score the SAME messages. That makes a paired design available, which a traffic split throws away:

| | Traffic split (today) | Paired shadow |
|---|---|---|
| User exposure to a worse classifier | yes, for the whole run | none |
| Messages informing the comparison | half | all |
| Statistical frame | two-proportion z-test, independent samples | McNemar's test on discordant pairs |
| Power at a given volume | low, and the sample floor is already the weak axis | materially higher, because the pairing removes between-sample variance |

### 5.2 Part A, the gate: replay, not live shadow

**Default: replay the challenger over archived messages.** The corpus already exists in the conversation archive, results arrive in minutes rather than over a run, and no user is exposed. Constraints that are not optional:

- **Off the request path.** The replay is a batch job. Adding a second classifier call to a live turn would spend user latency on an internal measurement.
- **Erasure and redaction carry through.** A message retracted by a deletion or redaction request must not be replayed. The archive read honours the `-RED` and `-DEL` sibling rows and the replay inherits that, or the gate quietly reprocesses content a user asked to have removed.
- **Representativeness is asserted, not assumed.** The replay window is recorded on the result. A corpus that predates a prompt change, an intent-pack change or a seasonal shift is not evidence about today's traffic, and the console states the window rather than implying currency.

**Forward shadow is the fallback**, for a deployment whose archive is too small or too stale to be representative. It classifies live messages with both models asynchronously and accumulates over time. Same comparison, slower, still no user exposure.

### 5.3 What is compared, and what needs a human

Both models label the same message set. Then:

- **Concordant pairs carry no comparative signal.** If both models agree, the pair cannot distinguish them: whatever the truth, they are both right or both wrong. They are counted and reported, and they are not adjudicated.
- **Discordant pairs are the evidence.** Only these are sent for human adjudication: *"this message; A said X, B said Y; which is correct, or neither?"*
- **McNemar's test** runs on the discordant pairs. A model may propose the correct label to speed the queue, but the human remains the arbiter of record (INV-4): a proposal is displayed as a proposal.

This is what makes the labelling tractable. Two classifiers typically agree on the large majority of traffic, so adjudication touches a small fraction of the corpus.

**One honest limit:** this measures RELATIVE accuracy, which is the question "which classifier is better". Absolute per-model accuracy would additionally require labels on the concordant pairs, and the console must not report a relative result as though it were an absolute accuracy figure.

#### Worked example

Replay 400 archived messages through both classifiers. Adjudication of the discordant pairs yields:

| | Incumbent right | Incumbent wrong |
|---|---|---|
| **Challenger right** | 300 | 42 |
| **Challenger wrong** | 18 | 40 |

**340 of the 400 pairs carry no comparative signal** (300 agreements on right, 40 on wrong). They are counted and reported, and they are not adjudicated, which is what makes this affordable: the human queue is 60 messages, not 400.

`mcnemarTest(42, 18)` over the discordant cells:

| Output | Value |
|---|---|
| discordant pairs | 60 |
| challenger wins | 42 (**70.0%**) |
| `ci` (Wilson) | [0.575, 0.801] |
| `pValue` | 0.00267 |
| `significant` | true, the interval excludes 50% |

Read against the non-inferiority margin, the challenger is right on `342 / 400` = **85.5%** of this corpus and the incumbent on `318 / 400` = **79.5%**, a **+6.0 point** difference against a default margin of 2 points (`DEFAULT_ACCURACY_MARGIN_PCT`). Those two percentages are accuracy **on this adjudicated corpus**, not absolute accuracy on live traffic, for the reason stated above.

`mcnemarTest` returns `null` when there are no discordant pairs at all. That is a real finding rather than a tie: the two classifiers are indistinguishable on this corpus, and the right conclusion is not to split traffic between them.

### 5.4 Part B, the online confirm

The gate answers whether labelling improved. It cannot answer whether USERS were better served, and those can diverge: a taxonomy is itself imperfect, and a label that is "wrong" against the taxonomy can still route to a model that answers better. Treating the intermediate metric as the outcome is the Goodhart failure this section exists to avoid.

So a passing gate authorises a normal traffic split, which measures the outcome with the machinery in §4: answer quality, task completion, thumbs, latency and cost. The gate does not replace the split; it earns it.

The gate also sizes the split before it runs. If the two models agree on 99.5% of traffic, no online experiment can detect a difference and the split should not be run at all. If they disagree on 8% concentrated in two intents, that names both the expected effect and where to look.

### 5.5 How the objective is honoured, including "cheaper but slightly worse"

The gate does not have its own decision rule. It uses the objective from §1, which already expresses this case: **the thing being optimised is the primary metric, and the thing that must not degrade is a guardrail.**

For "move to a cheaper classifier if it is not meaningfully less accurate":

```ts
objective: {
  metric: 'cost',                 // PRIMARY: what we are trying to improve
  target: 30,                     // % decrease sought
  guardrails: [
    { metric: 'accuracy', direction: 'no_worse_than', bound: 2 },  // the margin
  ],
  statement: 'Move intent classification to the cheaper model if it costs at least 30% less and is no more than 2 points less accurate.',
}
```

The verdict rule in §4.4 then does the work: a cheaper model that stays within the accuracy bound is `promote_treatment`; one that breaches it is `keep_control` even though it won on cost, and the rationale names the breached guardrail. **The margin is pre-registered**, which is the point: "2 points worse is acceptable" is a decision made before seeing the result, not a rationalisation after it.

**A guardrail must show evidence of no harm, not merely absence of evidence of harm.** A two-sided significance test cannot support "not meaningfully worse": on thin data it fails to detect a regression and the guardrail silently reads as held, so a cheaper-and-worse model ships on ignorance. The correct frame for a bounded-regression guardrail is a **non-inferiority test against the bound**: the challenger passes only when the confidence interval on the accuracy difference lies entirely within the margin. Underpowered data then correctly fails to ship rather than defaulting to permissive.

This applies to every `no_worse_than` guardrail, not only to classification, and it is a change to the evaluator rather than to this type.

## 6. Backward compatibility and cross-cutting concerns

- **Schema (INV-2):** every added field is optional, and absent means prior behaviour.
- **Status enum widening:** existing rows are `active`, `paused` or `completed`, which readers already tolerate. `draft` and `deleted` appear only on new writes.
- **Scale:** the experiments table is scanned rather than queried, which is why a cap on active experiments exists. If lifecycle states grow the row count, a `status` GSI lets the resolver and the expiry sweep query instead of scan.

## 7. Resolved defaults

- **Battle pick weighting presents two verdicts and does not blend them.** The recommendation always shows the metric verdict and the human-pick verdict separately, and surfaces disagreement explicitly (§4.4). `humanPickWeight` raises confidence on agreement; it never averages a conflict into one number. This avoids inventing the composite SPEC-BATTLE FR6 forbids.
- **Editing during active hard-locks the variants once traffic accrues** (§3.2). Changing what is compared means a new experiment.
- **The briefing names the decision and reveals models only after the pick** (§2.4), preserving the existing semi-blind evaluation without a new reveal mechanism.
- **Continuous-metric testing uses Welch's t** for latency, cost and tokens, which are approximately normal at aggregate n.
- **Expiry is handled lazily on read** rather than by a scheduled sweep, which avoids a new scheduled Lambda. An end date that has passed stops resolving traffic on the same read, even before the status label catches up.

## 8. Worked example

One experiment through every capability. Numbers are illustrative. Scenario: decide whether premium code generation should move from Sonnet to Opus.

### Step 1 - Author the objective (§1)

Type **Intent** on `code_generation`, classification premium, control Sonnet, treatment Opus:

```jsonc
{
  "experimentId": "exp-premium-codegen-opus",
  "experimentType": "intent", "intent": "code_generation", "tiers": ["premium"],
  "variants": [
    { "variantId": "control",   "modelKey": "sonnet", "weight": 70, "displayName": "Atlas" },
    { "variantId": "treatment", "modelKey": "opus",   "weight": 30, "displayName": "Echo"  }
  ],
  "objective": {
    "statement": "Decide whether premium code-gen should move to Opus. Ship Opus only if it clearly improves code quality without blowing up cost.",
    "metric": "quality", "target": 8,
    "guardrails": [
      { "metric": "cost",    "direction": "no_worse_than", "bound": 25 },
      { "metric": "latency", "direction": "no_worse_than", "bound": 30 }
    ],
    "humanPickWeight": 0.3
  },
  "battleEnabled": true, "altBotSlotId": "slot-0"
}
```

The form requires the statement and validates that the weights sum to 100. Because battle is enabled, it also requires display names and a free slot.

### Step 2 - A live conflict, resolved inline (§3.2.1)

Premium already has an active base-model experiment, so Create and Activate returns 409. The console lists the blocker and offers End, Pause or Delete. The operator is not finished with that test, so picks **Pause**, confirms, and the blocker becomes `paused`. The classification is free, so the original create retries and activates. The audit records who paused what, and when.

### Step 3 - Run (§2)

Probabilistic assignment splits 70/30 and accrues 420 control and 180 treatment exchanges. Separately, a moderator enables Battle Mode on a premium channel for this experiment, and battling users see the briefing built from the objective, aliases opaque:

> **Battle Mode is ON.** Two assistants will answer the same prompt so you can compare them. **We are deciding:** whether premium code-gen should move to a stronger model. **Most useful prompts:** ask a real coding task you would actually ship, for example *"Write a function that ..."* or *"Add retry/timeout to this call"*. Try `/battle <your prompt>`.

Over several battles, 25 decisive picks accrue, with Echo winning 18.

### Step 4 - Read the results (§4)

| Signal | Control | Treatment | Test | Result |
|---|---|---|---|---|
| **Quality** (primary) | 0.76 (n=420) | 0.83 (n=180) | Welch's t | +0.07, CI [+0.03,+0.11], **p<0.01**, significant |
| **Cost per reply** (guardrail) | $0.011 | $0.013 | two-sample | +18%, within the +25% bound, held |
| **Latency** (guardrail) | 2.1 s | 2.4 s | two-sample | +14%, within +30%, held |
| **Human pick** | 7/25 | 18/25 = **72%** | Wilson on 25 | [52%, 86%], excludes 50% |

The rule runs in order: enough data, guardrails held, primary significant with treatment favoured, so `promote_treatment` at **high** confidence. The human axis agrees, which the rationale notes. Quality is labelled "leads (p<0.01)", not a bare highlight. Nothing auto-routes.

### Step 5 - Promote, then record the decision (§3.2.1)

The operator makes the change manually first: a new premium profile version pins `code_generation` to Opus and is activated, with no redeploy. Then they End the experiment. Because it ran, the End dialog shows the decision picker defaulting to No decision; the operator selects `promoted_treatment` with a note. The completed experiment shows recommended against chosen side by side, and the decision and actor are in the audit trail.

### The honest no-decision branch

Had quality come back 0.76 against 0.78, CI [-0.01,+0.05], p=0.22, with humans split 13/12, the rule reads: enough data, no significant primary difference, so `equivalent`. Since the objective is quality rather than cost or latency, the recommendation is `keep_control`, labelled "equivalent, not a winner". The operator promotes nothing and Ends with `no_decision` and a note. The test closes honestly, the audit reflects reality, and no traffic moved. That is what the end-with-no-decision rule exists to make first-class.

---

## 9. Appendix - data model

### A.1 `Experiment` record

```ts
export interface Experiment {
  experimentId: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'deleted';
  experimentType?: ExperimentType;
  intent: string;
  tiers: Classification[];
  variants: ExperimentVariant[];        // model/count immutable once a variant has exchanges
  startDate: string;                    // enforced at resolve time
  endDate?: string;                     // auto-completes on expiry
  createdAt: string;                    // preserved on update
  description?: string;                 // populated alias of objective.statement
  objective?: ExperimentObjective;      // A.2
  decision?: ExperimentDecision;        // set when a test that RAN is completed (§3.2.1)
  transitions?: ExperimentTransition[]; // append-only lifecycle audit
  battleEnabled?: boolean;
  altBotSlotId?: string;
  altBotSlotArn?: string;
  boundBy?: string; boundAt?: string;
  longFormMode?: 'one-shot' | 'outline-first';
}
```

### A.2 Objective, decision and transition types

```ts
export interface ObjectiveGuardrail {
  metric: ExperimentObjectiveMetric;
  direction: 'no_worse_than' | 'at_least';
  bound: number;                                 // percent
}

export interface ExperimentObjective {
  metric: ExperimentObjectiveMetric;             // primary quantitative criterion
  target: number;
  statement?: string;                            // required at create in the console
  guardrails?: ObjectiveGuardrail[];             // veto conditions (<=3)
  humanPickWeight?: number;                      // 0..1, default 0 (§4.3)
}

export interface ExperimentDecision {
  outcome: 'promoted_treatment' | 'kept_control' | 'no_decision'; // default 'no_decision'
  note?: string;                                 // <=500
  by: string;                                    // admin ARN from token
  at: string;                                    // ISO timestamp
}

export interface ExperimentTransition {
  from: Experiment['status'] | 'create';
  to: Experiment['status'];
  by: string; at: string;
  reason?: string;                               // e.g. 'auto:endDate', 'conflict:paused', 'delete:soft'
}
```

### A.3 Status enum and transitions

The enum is `draft | active | paused | completed | deleted`. Server-enforced transitions: `draft→active`, `active↔paused`, `active|paused→completed` (terminal), `any→deleted` (terminal soft delete), and `active|paused→completed` via auto-expiry. `completed` and `deleted` are terminal. `draft` and `deleted` are excluded from active resolution and from the console's default list.

### A.4 Battle data model

- **Outcomes are per-user.** A battle outcome is a `votes` map keyed by `userSub` carrying `{ winner, chosenAt, experimentId?, variantId?, intent? }`, so `battle_wins` aggregation is a per-battle tally summed across battles. A legacy v1 row (top-level `winner` and `chosenByUserSub`, no `votes` map) is read as one pick keyed by its `chosenByUserSub`, so the cutover needs no migration step. A malformed row degrades to an empty tally and the UI shows no recorded pick rather than erroring.
- **Battle state** carries an optional round-phase deadline used by the fail-loud timeout, and a terminal completion marker so consumers get an explicit signal instead of inferring from TTL absence. Neither changes the key.

### A.5 `ChannelBattleConfig` briefing fields

To render the briefing without a per-render experiment read, the objective is snapshotted onto the config row at enable time:

```ts
briefingStatement?: string; // = experiment.objective.statement at enable time
briefingIntent?: string;    // = experiment.intent, drives the intent-to-prompt chips (§2.2)
```

### A.6 Analytics query and recommendation contract

The experiment results query carries per-variant standard deviation and an explicit count alongside the aggregates, which is what makes the continuous-metric tests in §4.2-B possible. The recommendation carries the computed statistics rather than a self-assessed confidence:

```ts
interface ExperimentRecommendation {
  verdict: 'promote_treatment' | 'keep_control' | 'keep_running' | 'equivalent' | 'inconclusive';
  confidence: 'low' | 'medium' | 'high';        // derived from the statistic (§4.2-E)
  rationale: string;                            // prose narration only
  primary:   { metric; deltaPct; ci: [number, number]; pValue; significant; powered };
  guardrails: Array<{ metric; deltaPct; bound; held: boolean }>;
  human?:    { picks: number; winRate: number; ci: [number, number]; significant: boolean };
  recommendedVsChosen?: { recommended: string; chosen?: ExperimentDecision['outcome'] };
}
```

### A.7 API surface

| Method / route | Behaviour |
|---|---|
| `POST /admin/experiments` | Preserves `createdAt` on update; rejects variant model and count edits once a variant has exchanges (409); warns rather than rejecting when `objective.statement` is absent; validates that weights sum to 100 (400). |
| `POST /admin/experiments/{id}/status` | Accepts an optional `decision` when completing a test that ran; returns 404 on a missing id; the 409-on-activate body carries the conflicting experiments so the console can drive the End, Pause or Delete resolution (§3.2.1). |
| `DELETE /admin/experiments/{id}` | Hard-deletes a never-started draft with no data; otherwise writes a `deleted` tombstone. Frees the classification and the alt-bot slot, and returns the freed classification so the console can retry a blocked create. |
| `POST /channels/battle/outcome` | Keyed per `userSub` from the token, not one overwritable row. |
