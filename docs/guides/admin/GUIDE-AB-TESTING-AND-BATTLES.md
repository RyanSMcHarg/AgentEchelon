# A/B Testing and Running Battles

How to run real A/B model experiments on your own traffic, measure which model wins, promote the winner, and use Battle Mode to put two assistants head to head on the same prompt.

This guide is for operators (an admin running a single AgentEchelon deployment). It describes behavior, not any specific account or environment.

> **Feature availability.** Everything described in this guide is available except lines marked *(not available)*. The *(not available)* items are: the **accuracy** objective and its classifier-accuracy measurement, and reading the live model catalog into the form. Battles are documented in `docs/specs/capabilities/SPEC-BATTLE.md`.

## Why this exists

Administrators require fine-grained control over the assistants interacting with users in order to optimize the experience for performance, quality, and cost. This includes not just what topics assistants can or are willing to engage with users on, but also which models are used throughout the flow for users in different tiers.

Administrators can set up tests between two assistants for a given user tier. The test is between the current default assistant and an alternative assistant. The configuration of the alternative, and what needs to change, depends on the goal of the experiment. To understand the levers available, you have to understand the message flow.

```
User message
   │
   ▼
Channel Flow Processor ──▶ Tier router  (picks the per-tier assistant: Basic / Standard / Premium)
                                │
                                ▼
                        Intent classifier  ── one low-cost model (configurable via CLASSIFIER_MODEL_ID; Haiku by default)
                                │
              ┌─────────────────┼───────────────────────────────┐
              ▼                 ▼                                ▼
       intent = code      intent = image generation        intent = general / other
       (intent-routed      ├─ clarify step  (default model: "what image?")
        model)             └─ generate step (image-gen model)        → default (base) model
```

The flow exposes three levers, and each is one of the single-model experiment types in Part 1:

- **Classification** - the single low-cost model that reads a message and routes it to an intent.
- **Default (base) model** - the fallthrough model that answers any request not pinned to a specific intent. It differs per tier.
- **Intent** - the model used for one specific intent, including a specific sub-step of a multi-step intent (for example, the model that generates the image, distinct from the default model that clarifies what image to generate).

A fourth experiment type, **Profile vs Profile**, sits above these three: instead of moving one lever it swaps the whole assistant (all three levers, plus the tool surface and limits) by pitting two versioned profiles against each other. Part 1 covers when to use each.

Given this flow, administrators have levers they can pull at different levels to achieve the goals they desire.

Examples of broad goals:

- Users are complaining that assistants are consistently misunderstanding the topic of conversation, mishandling topic drift, or improperly handling requests across different types of requests.
- Management is looking to lower the cost of AI tools across the company and wants to identify all options to reduce cost.
- Users are complaining about the time to first response from assistants.

Examples of focused goals:

- The design team is currently using model X for image generation. There is an emerging model Y they would like to experiment with to compare results.
- The engineering team is spending a large share of its AI budget on code and security reviews. They are looking at alternative models to perform these reviews in addition to structural and operational changes.

AgentEchelon provides multiple ways to address these goals. Outside of A/B testing there is the option to move more users into lower tiers to reduce cost. You can also put guardrails up to prevent users from engaging with assistants for specific, high-cost intents, or work on operational changes and the way that context is managed. A/B testing provides the tools required to take a more targeted, quantifiable approach.

### Broad goals

When looking at cost, you can use the analytics in AgentEchelon to review performance for different intents and see which cost the most per interaction and which cost the most per month, using intent filters. This shows whether specific types of interactions account for a disproportionate cost, so you can optimize just those intents with A/B testing. If there is no obvious culprit, or the issue is genuinely broad (like general feedback about misrouting), you can look at two primary areas:

- **Intent classification** - the low-cost, efficient model used to understand and route user requests. AgentEchelon ships with Anthropic's Haiku, but you may want to try other low-cost alternatives and compare effectiveness and cost against Haiku. Because these are already low-cost, tests at this level are most often for quality or latency.
- **Default model** - the power of modern AI systems is that they assist with a wide variety of requests. Because of that, it is inconvenient (and, depending on guardrails, sometimes impossible) to match every possible request to a specific workflow or model. To handle requests not tied to a specific model, AgentEchelon uses a default model, which differs per tier. By experimenting with different default models you can optimize a broad set of responses for performance, cost, or quality.

### Focused goals

Focused goals are used when you want to optimize a specific intent or process, often a high-value or high-cost intent like image generation. For these cases, AgentEchelon lets you set up A/B tests scoped to a specific intent.

## Concepts

- **Experiment.** A named comparison with a **control** variant (A) and a **treatment** variant (B), the tiers it applies to, a traffic split, and a type (below). A battle is the same experiment's two variants compared head to head in a single conversation, instead of being split probabilistically across many conversations.
- **Experiment type.** What the experiment swaps. Three types swap a single model at one lever: the **Classification** model, the **Base** (default) model, or the model for one **Intent**. A fourth, **Profile vs Profile**, swaps the whole assistant profile version at once. See Part 1.
- **Variant.** One side of the comparison. For the single-model types it is a model (plus, for battles, a display name and optional prompt addendum). For a Profile experiment it is a **profile version reference** (a profile name and an optional version) rather than a bare model; a variant is exactly one of the two, never both.
- **Traffic split.** The percentage of conversations assigned to each variant. You set the control percentage; the treatment (the alt) gets the rest.
- **Sticky assignment.** A conversation is assigned a variant deterministically (a hash of the channel and the experiment identifier) and keeps it for the life of the conversation, so you compare conversations rather than turn-by-turn flip-flops.
- **Objective.** What the experiment is for: a written **statement** of the decision it informs, a **primary metric** and target (cost, quality, or latency) the result is framed against, optional **guardrails** (metrics that must not regress for a ship), and an optional **human pick weight** for how much battle picks count. Advisory only: it informs the recommendation, never an automatic routing change. (The **accuracy** metric is *(not available)*: it needs the classifier-accuracy measurement, which is not available, so it always reads as pending.)
- **Battle Mode.** A per-channel toggle that pulls the treatment variant into a conversation as a second assistant, so one prompt is answered by both.
- **Alt-bot slot.** A pre-provisioned second-assistant seat. Arming an experiment for battle binds the treatment to one of these slots.

Everything below lives in the admin console under the **Experiments** section, except channel Battle Mode (which a channel moderator toggles in the conversation's members panel) and promoting a winner to default (a configuration change, covered in A/B Experiments, Part 4).

## A/B Experiments

### Part 1: Set up an experiment and its variants

Open the admin console, go to **Experiments**, and choose **New Experiment**.

First choose a **Type** (Intent, Base Model, Classification, or Profile).

The first three are the established, targeted tests: each **swaps one model at one point in the flow** of your *current* assistant and holds everything else constant, so the result isolates that single change. In practice these are the fast, mostly model-and-prompt-driven experiments you reach for to tune an assistant you already run. They differ only in *which* lever they move (the three levers from the flow above):

- **Classification** - swaps only the low-cost intent-classifier model. Everything downstream (base and per-intent models) is unchanged. A classification test cannot run while any other type of test is running on the targeted tier(s), because changing the classifier shifts routing for every intent and would confound the other tests.
- **Base Model** - swaps only the default (fallthrough) model for a tier, across every intent that is not pinned to its own model. The classifier and any per-intent models are unchanged.
- **Intent** - swaps only the model for one specific intent (for example code generation, or the image-generation step). The classifier, the base model, and every other intent are unchanged.

The fourth type is different in kind: it does not tweak your current assistant, it compares **two whole, separately-built assistants**.

- **Profile vs Profile** - compares two assistant **profile versions**, not a single model. This is the type to use when you are testing **new profiles** you have built, rather than tuning a model in the assistant you already run. A profile version is a portable, versioned artifact that bundles ALL of the above at once (base model, every per-intent model, the classifier, the tool surface, and limits) plus its identity (see [How to add or manage a profile](../developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md)). Both variants are profiles: you pick a profile version for control and a profile version for treatment (typically your current profile versus a new candidate). Because many things change at once, a Profile result tells you which *configuration* wins overall, not which single model or prompt caused it; reach for one of the three single-lever tests above when you want to attribute the win to one change. Like a base-model test it applies across intents, and each variant's effective model resolves from the referenced version at runtime.

Then fill in the fields. Most are common to every type; the type-specific fields are noted.

**Common fields**

- **Experiment ID** - a short stable name, for example `exp-codegen-sonnet-vs-opus`.
- **Control Model** and **Treatment Model** - the two models you are comparing. The available models come from your deployment's model catalog, which can include Bedrock and external (non-Bedrock) models. Control is variant A; treatment is variant B (the alt). See the [Model Strategy guide](../developer/MODEL_STRATEGY.md) for the catalog. *(The form does not read the live catalog; the model list is a fixed set, and admin management of the catalog is design-only.)* For a **Profile vs Profile** experiment these two fields become **Control Profile** and **Treatment Profile** pickers instead: choose a profile name and, for each, a specific version or leave it on the active version. The rest of the form is the same.
- **Tiers** - the user tiers the experiment applies to (Basic, Standard, Premium). A model that a tier is not allowed to use is skipped for that tier, so the experiment never grants more access than the tier already has.
- **Start Date** - defaults to today, starting the test as soon as it is saved. A future-dated start IS honored: the experiment stores as active but resolves no traffic until the start date passes. It still counts toward the active-experiment cap from the moment it is saved, so a batch of scheduled tests consumes cap while it waits. An unparseable date is refused at save time rather than silently stranding the experiment.
- **End Date** - when the test ends; defaults to 30 days after the start date. Once past the end date the experiment stops being resolved and routing falls back to the default for that intent and tier.
- **Objective** - a small block that records *what decision the test informs* and *what would make you ship a variant*, so the experiment is a documented decision rather than a set of numbers that moved. It is advisory throughout: it frames the recommendation and never triggers a routing change on its own. It has four parts:
 - **Statement** (required) - the decision this test informs, in a sentence or two, for example "Decide whether premium code generation should move to Opus, and ship Opus only if it clearly improves code quality without a large cost increase." The create form requires it (an empty statement is blocked or warned), it is capped at 500 characters, and it is sanitized. This prose is also what battling users are shown in the briefing, so write it for that audience (see Battles, Part 2). It replaces the old free-text description; there is no separate description field to smuggle the hypothesis into.
 - **Primary metric and target** - the one quantitative criterion the result is framed against, one of:
   - **Cost** - a target percentage decrease in cost.
   - **Quality** (Base Model, Intent) - a target percentage, measured by AgentEchelon's evaluator and by user thumbs up / thumbs down. The evaluator and user signals are reported separately so you can weigh user input more heavily, and results flag when too few user ratings have been collected to be confident.
   - **Latency** - a target percentage decrease in time, measured by the evaluator. For Classification this is the classification step specifically; for Base Model and Intent it is response time for the affected intents.
   - **Accuracy** (Classification) *(not available)* - a target percentage for classifier correctness. The classifier-accuracy measurement is not available, so an accuracy objective always reads as pending.
 - **Guardrails** (optional, up to three) - metrics that must not regress for the result to recommend a ship, each a metric plus a bound, for example "cost no worse than +25%" or "fallback rate no worse than +2%". A guardrail can also state a floor rather than a ceiling ("quality at least +5%"), in which case a result the data can show fell short of the floor fails it in the same way a regression past a ceiling does. A guardrail is a veto: a primary-metric win bought with a guardrail regression is not recommended as a ship, and the recommendation names the breached guardrail. Setting the decision rule up front this way also keeps the results honest (see Part 3).
 - **Human pick weight** (optional, 0 to 1, default 0) - how much the head-to-head battle picks count toward the recommendation relative to the primary metric. At the default of 0, battle picks are shown alongside the metric result but do not change it. Raising it lets the hands-on human signal carry weight when both signals exist (see Battles). The metric verdict and the human verdict are always shown separately and never blended into a single number; agreement raises confidence, and disagreement is surfaced as an explicit conflict for you to reconcile.

**Type-specific field**

- **Intent** (Intent type only) - which kind of request this experiment applies to (General Q&A, Code Generation, Code Review, Document Extraction, Report Generation, Image Generation, Strategic Analysis, or Workflow Actions). The experiment only affects conversation messages routed to this intent. For **Image Generation** the two variant fields become **Control Image Model** and **Treatment Image Model** (Stability Core / Ultra, OpenAI, FAL), because the thing being compared for an image request is the image model, not a text model; both are required. Image generation is a normal capability, so the assigned variant's image model serves ordinary image requests on the traffic split - a battle is not required (it only adds the side-by-side UI and scoring). Image comparison is meaningful for an Image Generation intent experiment or a Profile vs Profile experiment (each profile carries its own image model); a Base Model or Classification experiment varies a text model, so an image prompt there runs the same image model on both sides.

When the form is complete you can save the experiment as a **draft** or choose **Create and Activate**. A draft is saved but not live: it is assigned no traffic and stays freely editable, which is useful for staging an experiment before it runs. **Create and Activate** saves the experiment and starts it immediately with a status of **active**, unless the classification is already occupied by another test, in which case the console offers to free it first (see Part 2). You can activate a draft later from the Experiments list.

### Part 2: Set the traffic split (how much goes to the alt)

The **Traffic Split (Control %)** slider sets what share of conversations (or, for classification and intent tests, of matching invocations) stay on the control model. It runs from 10 to 90 in steps of 10, and shows the resulting split, for example `70% / 30%`. The treatment (the alt) receives the remainder, so a control value of 70 sends **30 percent of new conversations** to the alt.

How the split is applied:

- Assignment is **deterministic and sticky**. For each conversation, the platform hashes the channel identifier together with the experiment identifier into a bucket from 0 to 99, then maps that bucket to a variant by cumulative weight. A 70/30 split sends buckets 0 to 69 to control and 70 to 99 to treatment.
- Because the hash is stable, a given conversation always lands on the same variant. New conversations are spread across variants in proportion to the split, so over time roughly the configured percentage of conversations experience the alt.

Start conservative (for example 90/10) to expose the alt to a small slice, then widen the split as confidence grows by editing the experiment.

Once active, each experiment shows its variants and weights in the **Active Experiments** table, rendered as `control: sonnet (70%) | treatment: opus (30%)`, alongside its status and start date.

You can **Pause** an experiment (stops new assignments, keeps the data), **Resume** it, or **Complete** it. While an experiment is active it overrides the default model routing for matching conversations; when it is paused or completed, routing falls back to the deployment's default model for that intent and tier (see Part 4).

#### Experiment states

An experiment moves through a small, explicit set of states:

- **Draft** - saved but not live. No traffic is assigned and the experiment is freely editable. Activate it when you are ready.
- **Active** - live and overriding routing for matching conversations on its tiers.
- **Paused** - new conversations stop being assigned to it, but the data collected so far is preserved and you can **Resume** it later with that data intact.
- **Completed** - terminal. The test has stopped collecting data and its results stay in the dashboard. To run it again, create a new experiment with a new ID.
- **Deleted** - terminal. See the delete behavior below.

Two edit guards keep a running test trustworthy. Once any variant has collected traffic, the variant **models and the variant count are locked**: you can still change the traffic split, the end date, and the objective, but changing *what is being compared* means creating a new experiment rather than swapping variants under a live test. And a **completed** experiment cannot be reopened. When an experiment passes its end date it auto-completes and stops being resolved. Every state change is recorded in an audit trail (who acted, what changed, and when).

#### Recording the decision when a test that ran is completed

Completing an experiment that ever collected data prompts you to record the **outcome**, so an inconclusive test closes honestly instead of being quietly dropped. The options are **promoted treatment**, **kept control**, or **No decision**, and **No decision is the default and always available** - you are never forced to declare a winner. This is simply your record of what you did after reading the advisory recommendation; recording a decision is not itself the promotion (routing still only changes through the manual step in Part 4). A never-started draft has nothing to decide, so it skips this prompt. The recorded decision, with your identity and the time, shows on the completed experiment and in the audit trail, and the results view can later show the **recommended verdict next to the decision you chose**.

#### Freeing a classification to start a new test (End, Pause, or Delete)

A classification can host only one test at a time, and a classification test in particular cannot run alongside any other type on the same tier(s), because changing the classifier shifts routing for every intent. When you try to activate or create an experiment that conflicts with one already on the classification, the console does not just show an error: it tells you **which** experiment holds the classification and offers three ways to free it, each behind a confirmation that states the consequence.

- **End the existing test** - completes it (terminal, not resumable). Its results stay in the dashboard, and because it ran, ending it prompts you to record the outcome (with **No decision** as the default, as above).
- **Pause the existing test** - stops new assignments but preserves the data collected so far, and you can **Resume** it later. Reversible, but still confirmed because it changes a running test's data collection.
- **Delete the existing test** - removes it from your experiments and frees its alt-bot slot. A never-started draft is removed outright; a test that ran becomes a hidden tombstone so its historical analytics keep their variant labels. Not resumable, and not undoable.

After the action you choose frees the classification, the console retries your original create automatically, so you are not sent back to the start. Each of these actions is recorded in the audit trail with your identity.

### Part 3: Compare and measure the results

Open the **Experiments** section and scroll to **Experiment Results**, a side-by-side comparison of the variants. Each row is one variant, with:

- **Exchanges** - how many request/response pairs the variant served (your sample size).
- **Avg Score** - the average evaluation (relevance) score for the variant's responses.
- **Avg Latency (ms)** and **P95 (ms)** - typical and tail response time.
- **Avg Tokens** - average tokens per exchange, a proxy for cost.
- **Compliance %** - the share of responses that passed the configured guardrails and format checks.
- **Fallbacks** - how often the variant's primary model failed and a fallback model answered instead.
- **User approval** - the thumbs up / thumbs down collected on the variant's responses, folded in as an approval percentage and reported separately from the evaluator score (Aurora mode). A companion **Battle wins** column credits each variant with the head-to-head `/battle` picks it won.

Read the two rows together: a treatment that wins on score and compliance without a meaningful latency or fallback penalty is a real improvement; a treatment that only wins on latency but loses on score is not. When an **objective** is set, the results also show progress toward that target (met, not met, or pending) and feed it into the recommendation. An **accuracy** objective always shows *pending*, because the classifier-accuracy measurement is not available.

#### How results report a winner (significance, not raw averages)

A raw average lead is not a winner. The results distinguish a real difference from noise, so a one-point lead on a thin sample does not read the same as a decisive gap:

- **Per-metric labels.** Each metric is labeled honestly as *no difference*, *leads (not significant)*, *leads (p<0.05)*, or *leads (p<0.01)*, rather than simply highlighting whichever number is larger. The primary metric and its guardrails are tested and reported with a confidence interval: continuous metrics (score, latency, cost, tokens) use Welch's t-test, and the objective's metric is one of cost, accuracy, quality, or latency. The two human signals are tested and reported with their own intervals as separate axes: **battle win rate** (Wilson interval) and **user approval** from thumbs (two-proportion test with a Newcombe interval on the difference). Compliance, fallback and task completion are reported as descriptive columns; they are not tested and cannot currently be selected as an objective metric or a guardrail.
- **Underpowered state.** When a metric has too few samples to detect the effect your target implies, the results show an *underpowered - need about N more per variant* state instead of a premature winner. A hard minimum still applies below which nothing is claimed.
- **A quality or accuracy objective needs SCORED exchanges, not just exchanges.** Those objectives read the evaluator score, and an exchange the evaluator has not reached yet counts as a zero in the average. An experiment with traffic on both sides but nothing scored therefore has no measurement of quality at all, and it reports *keep running - not enough data yet* rather than declaring the variants equivalent. The per-variant scored count is shown beside the exchange count, so the gap between traffic and evidence is visible. Cost and latency are measured on every exchange and are unaffected.
- **The hard minimum ships at 5 exchanges per variant, deliberately low - and increasing it is recommended.** The default is set for a first look: most people meeting this feature want to watch the lifecycle work - create a variant, send it traffic, get a verdict - and at a statistically respectable floor the first verdict is tens of minutes of traffic away, which makes the honest setting and the demonstrable one mutually exclusive. Five is a **demonstration floor, not a decision floor**: the verdict is real arithmetic on real traffic, but underpowered, so it will usually report *low* confidence with a wide interval. That reading is correct, not a defect.

  **Recommendation: raise the floor once you are past the first look, and before anyone routes traffic or retires a variant on what a verdict says.** 30 per variant is the usual starting point; pick higher if your metric is noisy or the effect you care about is small. Set the `minSamplePerVariant` context key and redeploy the analytics stack. The floor is **per variant**, so the smallest arm gates the result, and omitting the key on a later deploy of that stack silently restores the default.
- **Guardrails.** Each guardrail shows one of three states, because a bound can be passed, failed, or not yet answerable. **Held** means the confidence interval on the difference sits entirely within the bound, which is what a ship requires. **Breached** means it sits entirely past the bound, which vetoes a ship even when the primary metric won, and the recommendation names it. **Not established** is everything in between: the interval spans the bound, so the data supports neither claim. That is not a pass, and a ship does not proceed on it; the answer is more data. Every one of those comparisons is made against the bound you set, never against zero, so a difference that is merely distinguishable from no-change is not reported as a breach.
- **Confidence tied to the statistic.** The recommendation's confidence (low, medium, high) is derived from the computed result - significant and powered with guardrails held reads high; not significant, underpowered, or a regressed guardrail reads low - not from a model's opinion. Any prose narrates the computed numbers; it does not source the confidence.
- **The human pick is a separate axis.** Battle picks are reported as their own human-preference signal (for example "18 of 25 picked treatment, 72%, CI 52-86%") with its own confidence interval, shown next to the metric verdict and never folded into it. When the human signal and the metrics disagree, the disagreement is stated plainly for you to reconcile rather than averaged away. How much the human axis counts toward the overall verdict is set by the objective's human pick weight (default 0).

The whole recommendation stays advisory: it never reroutes traffic on its own, and the "advisory, not auto-applied" framing is kept. On a completed experiment the results can show the **recommended verdict alongside the decision you actually recorded** (Part 2), which may differ.

#### Checking a number for yourself

You do not have to take a result on trust. Four figures carry a **show** control that opens the rows behind them, so you can recompute the number and read the conversations it came from:

| Control | What it opens |
|---|---|
| **Sample (exchanges)** | The randomly assigned turns for that variant, with each one's score, latency, tokens and model. Battle turns are excluded, exactly as they are from the averages above it. |
| **Turns** on the battle scorecard | The replies produced inside duels for that variant. |
| **User approval** | One row per counted vote. |
| **Battle wins** | One row per counted head-to-head pick. |

Each of the four is a different set of traffic, which is why they are separate controls rather than one link. Battle turns and battle picks in particular are not the same thing: a duel produces a reply from each side and at most one pick per person.

The view checks itself. It recomputes the count and the mean over the **whole** matching set, not just the page on screen, and says either *Reconciles with the result above* or *DOES NOT reconcile* with both numbers shown. A mismatch means the pipeline disagrees with itself, and the verdict should be treated as unverified until it is resolved.

Two things it tells you that change how a mean should be read:

- **Unscored exchanges count as zero.** That is how the average above is computed, so the drill-down reports how many rows carry no evaluator score. If a large share are unscored, part of the average is scoring coverage rather than reply quality.
- **Redacted and deleted messages keep their numbers and lose their transcript.** The exchange still counted toward the score, so removing it would stop the numbers adding up. The row stays, the transcript is withheld and labeled, and the view states how many of the rows are affected.

Opening a transcript uses the same permissioned admin read as the Conversations view.

Two things to know about measurement:

- **Results require Aurora mode.** The Experiment Results table is powered by the analytics database. In the default Athena mode it shows an honest "Aurora-only" banner rather than an empty table. Enable Aurora mode (see the Aurora Mode Guide) to get per-variant scoring.
- **Data accrues after traffic flows.** Results appear once messages have flowed through an active experiment, so give a new experiment enough conversations on each variant before drawing a conclusion.

For battles specifically, you also get the per-battle scorecard and a per-step breakdown described under Battles, Part 2.

### Part 4: Make a winning variant the default

When a treatment wins, you make it the standard model for that intent (or, for a base-model test, the tier default; for a classification test, the classifier model). AgentEchelon keeps a human in the loop here on purpose: experiment and battle results are descriptive, and a result never reroutes future traffic on its own.

To promote a winner:

1. Make the winning model the default. Two paths, depending on how your deployment manages assistants:
   - **Profile version (no redeploy, preferred).** In the admin **Assistants > Profiles** tab, create a new version of the affected profile, set the winning model (base, per-intent, or classifier as appropriate) on it, validate, and **activate** it. Activation takes effect at runtime with no redeploy, and the previous version stays available for one-click rollback. For a **Profile vs Profile** experiment this is the whole promotion: activate the treatment profile version that won. See [How to add or manage a profile](../developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md).
   - **Model strategy config (deploy-time default).** Alternatively, update the deployment's centralized **model strategy** so the winning model becomes the classification-level default for that intent and tier, then redeploy the backend. This is the fallback path and sets the default a blank profile inherits.
2. **Complete** the experiment in the Experiments section. Because the test ran, completing it prompts you to record the outcome: select **promoted treatment** (with an optional note) so the audit reflects what you did, or leave **No decision** if you promoted nothing. With no active experiment for that intent and tier, all conversations now route to the new default you just set.

There is intentionally **no one-click promote and no automatic promotion** of a winning variant today; the decision and the configuration change (activating the new version, or editing config and redeploying) are deliberate operator actions. Objectives are advisory for the same reason: hitting a target produces a recommendation, never an automatic routing change. Automatic promotion of a proven winner is not current behavior, so do not expect a successful test to change routing by itself.

### When a change takes effect

Both promotion steps apply to **the next turn** of a conversation, not the next conversation. Nobody has to start a new conversation, reconnect, or sign out, and no in-flight reply is interrupted: a conversation that is mid-thread simply gets the new behavior on its next message.

There is a short convergence delay, because each running handler caches these reads. The two caches are separate and have different lifetimes:

| Change | Converges within | Why |
|---|---|---|
| Activating (or rolling back) a profile version | **~30 seconds** | Each handler resolves the active profile per turn and caches it briefly |
| Starting, completing, pausing, or ending an experiment | **~60 seconds** | Experiments are read per turn and cached briefly |

So the full sequence when you activate a profile version is:

1. **Activate.** The new version is written and the `active` pointer moves to it. Nothing is deployed and nothing restarts.
2. **Within ~30 seconds**, every handler picks it up on its next turn.
3. **Rollback behaves identically**, including the delay: a version you roll back can still serve for up to ~30 seconds. If you are backing out a bad activation, expect a short tail rather than an instant cut-off.

And when an experiment ends (completed, paused, deleted, or its end date passes):

1. The experiment stops resolving traffic. Conversations that had been assigned a variant are no longer held to it - a variant assignment only ever applies while the experiment is live.
2. **Within ~60 seconds**, those conversations fall back to **whatever profile version is currently active** for their classification. That is the ordinary assistant, not the control variant: the control was a variant of the experiment and ends with it.
3. If you promoted a winner first (the step above), the fallback IS the winner, because you already activated it. Promote before you complete the experiment and users see one change, not two.

An **end date that has passed** stops resolving traffic immediately on the same schedule, even before the status label catches up; the label is corrected to `completed` the next time the experiment is read. A **future** start date is honored the same way: the experiment stores as active but resolves nothing until the date passes.

Battles follow the experiment. When the experiment a battle-enabled channel is bound to ends, `/battle` in that channel replies that the comparison has ended rather than running a duel, and the channel's ordinary assistant continues to answer normally. Turn Battle Mode off in the members panel to clear the affordance, or start a new experiment and enable it again.

## Battles

A battle is the visible, hands-on version of the same experiment: the two variants answer one prompt side by side in a real conversation, instead of being split probabilistically across many conversations. Battles exist to do two things the probabilistic split does slowly or not at all - **collect direct human feedback** (the pick-the-winner, and a quick thumbs prompt) and give administrators and users a **real-time, tangible experience** they can use to drive a decision.

### Part 1: Turn an experiment into a battle

Arming a battle takes a few extra fields on the same experiment form.

In the experiment's form, tick **Enable for /battle** (whether battles can run in a channel is controlled by the channel classification profile's `battleEligible` flag; premium is the only battle-eligible profile in the default configuration). The Battle Mode card unfolds with a side-by-side control-versus-treatment layout:

- **Display name** per variant (for example, control = Atlas, treatment = Echo), up to sixteen characters. This is what users see, so they read two distinct assistants rather than two model identifiers.
- **System prompt addendum** per variant (optional, up to 500 characters), a short style or persona instruction layered on top of the tier's base prompt. It shapes voice, not capability; the models remain the real comparison.
- **Alt-bot slot** - the pre-provisioned seat the treatment occupies when it joins a channel. Each slot can be bound to one active battle experiment at a time.

An **image battle** is just an Image Generation intent experiment (its two variant image models, set above) with battle enabled: both sides generate an image in round one, then each critiques the other's image in the round-two rebuttal. Battle adds no image setup of its own; the model choice lives on the experiment, and battle only layers the side-by-side UI and scoring on top of the same flow. A Profile vs Profile experiment can also be an image battle when the two profiles carry different image models. Choose **Create and Activate**.

Any experiment type can be armed for battle, including **Profile vs Profile**: the two profile versions then answer side by side in one conversation, so you can feel the difference between two whole assistant configurations before you promote one.

### Part 2: Run a battle

#### Turn on Battle Mode for a channel

Battle is opt-in per conversation, and only in channels whose classification profile is battle-eligible (the profile's `battleEligible` flag; premium channels only in the default configuration). A channel moderator opens the conversation's **members panel**, finds the **Battle Mode** section (status **Off**), picks the armed experiment, and chooses **Turn on Battle Mode**. The status flips to **Active** and the treatment variant joins as a real member.

#### The battle briefing (what is being decided)

Battling users are told what the battle is for, so they contribute a meaningful comparison instead of guessing. The briefing is built from the experiment's objective statement (A/B Experiments, Part 1) and is shown to the **battling users**, not only the moderator. It is semi-blind by design: it names the **decision**, never which alias is which model, so the comparison stays fair (model identities appear in the scorecard only after answers land).

The briefing appears in two places:

- **On enable.** When Battle Mode turns on, the channel announcement adds a line built from the objective, for example: "Battle Mode is ON. Two assistants will answer the same prompt so you can compare them. We're deciding: whether premium code generation should move to a stronger model. Most useful prompts: ask a real coding task you'd actually ship. Try `/battle <your prompt>`."
- **Per battle.** A compact, dismissible banner above the first battle turn carries the same decision line plus two or three suggested **starter prompt chips**. Clicking a chip prefills the composer with a `/battle` prompt, so a user can contribute a useful comparison in one tap.

The suggested prompts steer the battle toward what the experiment measures. For an **Intent** experiment they are drawn from that intent (a code-generation experiment suggests real coding tasks, an image-generation experiment suggests real image prompts, and so on). A **Base**, **Classification**, or **Profile** experiment spans intents, so it falls back to a generic coaching line ("ask the kinds of questions your users actually ask") seeded from the objective statement. The prompt suggestions are example copy, not policy, and a deployment can override them.

#### Run the prompt and read the scorecard

In a battle-enabled channel, start any prompt with the `/battle` command:

```
/battle What is the best caching strategy for a read-heavy database with 50 million rows?
```

Both assistants answer the same prompt in parallel (round one). A scorecard renders under the pair with three independent axes, never folded into a single number: **response time**, **estimated cost** (tokens times the model rate, an estimate for comparison and not a bill), and **quality**, which is your call (pick **A better**, **Tie**, or **B better**). A **Show steps** expander reveals the per-step rows (step label, model, duration), the same detail admins see.

The quality pick is the point: it is direct human feedback. In Aurora mode each pick is credited to the winning variant and surfaces as the **Battle wins** column in the per-variant Experiment Results, and it also feeds the experiment's recommendation as a distinct human-preference axis, shown next to the metric verdict and never blended into it (see A/B Experiments, Part 3). How much it weighs toward the overall verdict is set by the objective's human pick weight. At the end of each battle an inline result card summarizes that prompt's outcome (each side's response time and estimated cost, and which side you picked); the next `/battle` gets its own fresh card. *(Not included: a one-tap thumbs prompt after a round.)*

After both answers land, a divider marks **round two**: each assistant receives the other's answer, knows it is in a battle, and may rebut, build on it, or stay silent. Round two is commentary; the deliverable is round one.

A few behaviors worth knowing:

- Round two fires only after both sides fully answer, so you are judging who solved it better, not who replied faster.
- Topic-drift suggestions are suppressed during a battle, because divergence is the point.
- If one assistant needs to ask a clarifying question, it asks exactly one, and the composer offers a **Replying to** selector so your answer reaches only the assistant that asked.

#### Battle types

Battles escalate through increasing capability; run the ones your deployment supports:

1. **Single-turn**, a direct answer compared side by side.
2. **Report creation**, a multi-step answer delivered as a complete write-up.
3. **Document creation**, output delivered as a downloadable attachment.
4. **Image understanding (vision in)**, both assistants reason over an uploaded image or scanned document.
5. **Image generation (generation out)**, both assistants produce an image from a prompt.

Image generation depends on extra deploy-time setup (image-generation models enabled, an image-output guardrail, and a second slot provisioned). Run only the types enabled in your environment.

#### Reading battle results

Beyond the inline scorecard, the admin console shows the **per-step breakdown** for each battle (which model ran each step and how long it took), alongside the same A/B experiment metrics from A/B Experiments, Part 3.

Quality is captured as an explicit human pick (A, B, or tie) per battle, and in Aurora mode that pick is credited to the winning variant so it counts in the per-variant results as **Battle wins** and feeds the recommendation as a distinct human-preference axis (A/B Experiments, Part 3). There is no algorithmic judge, and a battle outcome never auto-routes future traffic; the human pick is surfaced next to the metric verdict rather than blended into one number, the decision stays yours, and promotion follows the manual path in A/B Experiments, Part 4.

### Part 3: Turn it off cleanly

1. In the channel members panel, set **Battle Mode** back to **Off**. The treatment assistant leaves the conversation.
2. Optionally **pause** or **complete** the experiment in the Experiments section once you have your answer (and promote the winner per A/B Experiments, Part 4 if it earned it).

## Cost and safety guardrails

- A single `/battle` is up to four model invocations (two assistants times two rounds), so battle is gated by the profile's `battleEligible` flag, and **premium is the only battle-eligible profile** by default.
- Only **one** active battle runs per channel at a time; a second `/battle` while one is in flight is asked to wait.
- The platform's existing retry, fallback, and circuit-breaker protections apply to battle invocations unchanged.
- An experiment and a battle compare exactly **two** variants; comparing more than two at once is not supported.

## Troubleshooting

- **"/battle did nothing or said it is not enabled here."** The channel does not have Battle Mode on. A moderator enables it in the members panel, then try `/battle` again.
- **"Battle Mode isn't available in this conversation. Reply normally and I'll respond as usual."** The channel's classification profile is not battle-eligible. By default only premium channels are.
- **The Enable for /battle option does nothing useful.** The experiment must have a display name on each variant and a free alt-bot slot.
- **No alt-bot slot is available.** Disable battle on another experiment to free its slot, or raise the alt-bot slot count on your next deploy.
- **The Experiment Results table is empty or shows an Aurora-only banner.** Per-variant results require Aurora mode; enable it, then let traffic flow through the experiment.
- **Only one assistant answered a battle.** The treatment may not be a member; turn Battle Mode off and on again to re-add it, and confirm the experiment is still active.
