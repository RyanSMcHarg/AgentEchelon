# A/B Testing and Running Battles

How to run real A/B model experiments on your own traffic, measure which model wins, promote the winner, and use Battle Mode to put two assistants head to head on the same prompt.

This guide is for operators (an admin running a single AgentEchelon deployment). It describes behavior, not any specific account or environment.

> **Feature availability.** Everything described in this guide is available except lines marked *(not available)*. The *(not available)* items are: the **accuracy** objective and its classifier-accuracy measurement, future-dated start-date gating, and reading the live model catalog into the form. Battles are documented in `docs/specs/experiments-battle/SPEC-BATTLE.md`.

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
- **Objective.** The target the experiment is trying to move: a cost, quality, or latency goal, used to frame the result. Advisory only: it informs the recommendation, never an automatic routing change. (The **accuracy** objective is *(not available)*: it needs the classifier-accuracy measurement, which is not available, so it always reads as pending.)
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
- **Description** - the hypothesis in one line, for example "Does Opus actually beat Sonnet for our code questions?"
- **Control Model** and **Treatment Model** - the two models you are comparing. The available models come from your deployment's model catalog, which can include Bedrock and external (non-Bedrock) models. Control is variant A; treatment is variant B (the alt). See the [Model Strategy guide](../developer/MODEL_STRATEGY.md) for the catalog. *(The form does not read the live catalog; the model list is a fixed set, and admin management of the catalog is design-only.)* For a **Profile vs Profile** experiment these two fields become **Control Profile** and **Treatment Profile** pickers instead: choose a profile name and, for each, a specific version or leave it on the active version. The rest of the form is the same.
- **Tiers** - the user tiers the experiment applies to (Basic, Standard, Premium). A model that a tier is not allowed to use is skipped for that tier, so the experiment never grants more access than the tier already has.
- **Start Date** - defaults to today, starting the test as soon as it is saved. *(A future-dated start is not honored; an experiment is live whenever its status is active, regardless of a later start date.)*
- **End Date** - when the test ends; defaults to 30 days after the start date. Once past the end date the experiment stops being resolved and routing falls back to the default for that intent and tier.
- **Objective** - the target the test is trying to move; one of:
  - **Cost** - a target percentage decrease in cost.
  - **Quality** (Base Model, Intent) - a target percentage, measured by AgentEchelon's evaluator and by user thumbs up / thumbs down. The evaluator and user signals are entered and reported separately so you can weight user input more heavily, and results flag when too few user ratings have been collected to be confident.
  - **Latency** - a target percentage decrease in time, measured by the evaluator. For Classification this is the classification step specifically; for Base Model and Intent it is response time for the affected intents.
  - **Accuracy** (Classification) *(not available)* - a target percentage for classifier correctness. The classifier-accuracy measurement is not available, so an accuracy objective always reads as pending.

**Type-specific field**

- **Intent** (Intent type only) - which kind of request this experiment applies to (General Q&A, Code Generation, Code Review, Document Extraction, Report Generation, Strategic Analysis, or Workflow Actions). The experiment only affects conversation messages routed to this intent.

Choose **Create and Activate**. The experiment starts immediately with a status of **active**.

### Part 2: Set the traffic split (how much goes to the alt)

The **Traffic Split (Control %)** slider sets what share of conversations (or, for classification and intent tests, of matching invocations) stay on the control model. It runs from 10 to 90 in steps of 10, and shows the resulting split, for example `70% / 30%`. The treatment (the alt) receives the remainder, so a control value of 70 sends **30 percent of new conversations** to the alt.

How the split is applied:

- Assignment is **deterministic and sticky**. For each conversation, the platform hashes the channel identifier together with the experiment identifier into a bucket from 0 to 99, then maps that bucket to a variant by cumulative weight. A 70/30 split sends buckets 0 to 69 to control and 70 to 99 to treatment.
- Because the hash is stable, a given conversation always lands on the same variant. New conversations are spread across variants in proportion to the split, so over time roughly the configured percentage of conversations experience the alt.

Start conservative (for example 90/10) to expose the alt to a small slice, then widen the split as confidence grows by editing the experiment.

Once active, each experiment shows its variants and weights in the **Active Experiments** table, rendered as `control: sonnet (70%) | treatment: opus (30%)`, alongside its status and start date.

You can **Pause** an experiment (stops new assignments, keeps the data), **Resume** it, or **Complete** it. While an experiment is active it overrides the default model routing for matching conversations; when it is paused or completed, routing falls back to the deployment's default model for that intent and tier (see Part 4).

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
2. **Complete** the experiment in the Experiments section. With no active experiment for that intent and tier, all conversations now route to the new default you just set.

There is intentionally **no one-click promote and no automatic promotion** of a winning variant today; the decision and the configuration change (activating the new version, or editing config and redeploying) are deliberate operator actions. Objectives are advisory for the same reason: hitting a target produces a recommendation, never an automatic routing change. Automatic promotion of a proven winner is not current behavior, so do not expect a successful test to change routing by itself.

## Battles

A battle is the visible, hands-on version of the same experiment: the two variants answer one prompt side by side in a real conversation, instead of being split probabilistically across many conversations. Battles exist to do two things the probabilistic split does slowly or not at all - **collect direct human feedback** (the pick-the-winner, and a quick thumbs prompt) and give administrators and users a **real-time, tangible experience** they can use to drive a decision.

### Part 1: Turn an experiment into a battle

Arming a battle takes a few extra fields on the same experiment form.

In the experiment's form, tick **Enable for /battle** (battles are premium-only by default). The Battle Mode card unfolds with a side-by-side control-versus-treatment layout:

- **Display name** per variant (for example, control = Atlas, treatment = Echo), up to sixteen characters. This is what users see, so they read two distinct assistants rather than two model identifiers.
- **System prompt addendum** per variant (optional, up to 500 characters), a short style or persona instruction layered on top of the tier's base prompt. It shapes voice, not capability; the models remain the real comparison.
- **Alt-bot slot** - the pre-provisioned seat the treatment occupies when it joins a channel. Each slot can be bound to one active battle experiment at a time.
- **Long-form mode** - for report or document battles, choose **one-shot** (each side produces the complete deliverable in round one as an attachment) or **outline-first** (round one is just the approach, so you can compare directions before a full report is generated).

For an image-generation battle, set an **image-gen model** on both variants (set it on neither for a normal text battle); the form enforces both-or-neither. Choose **Create and Activate**.

Any experiment type can be armed for battle, including **Profile vs Profile**: the two profile versions then answer side by side in one conversation, so you can feel the difference between two whole assistant configurations before you promote one.

### Part 2: Run a battle

#### Turn on Battle Mode for a channel

Battle is opt-in per conversation, and only on premium channels. A channel moderator opens the conversation's **members panel**, finds the **Battle Mode** section (status **Off**), picks the armed experiment, and chooses **Turn on Battle Mode**. The status flips to **Active** and the treatment variant joins as a real member.

#### Run the prompt and read the scorecard

In a battle-enabled channel, start any prompt with the `/battle` command:

```
/battle What is the best caching strategy for a read-heavy database with 50 million rows?
```

Both assistants answer the same prompt in parallel (round one). A scorecard renders under the pair with three independent axes, never folded into a single number: **response time**, **estimated cost** (tokens times the model rate, an estimate for comparison and not a bill), and **quality**, which is your call (pick **A better**, **Tie**, or **B better**). A **Show steps** expander reveals the per-step rows (step label, model, duration), the same detail admins see.

The quality pick is the point: it is direct human feedback. In Aurora mode each pick is credited to the winning variant and surfaces as the **Battle wins** column in the per-variant Experiment Results. *(Not included: feeding that signal into an experiment objective and recommendation, a one-tap thumbs prompt after a round, and a running "N picks collected toward a confident call" tally.)*

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

Quality is captured as an explicit human pick (A, B, or tie) per battle, and in Aurora mode that pick is credited to the winning variant so it counts in the per-variant results as **Battle wins**. There is no algorithmic judge, and a battle outcome never auto-routes future traffic; the decision stays yours, and promotion follows the manual path in A/B Experiments, Part 4.

### Part 3: Turn it off cleanly

1. In the channel members panel, set **Battle Mode** back to **Off**. The treatment assistant leaves the conversation.
2. Optionally **pause** or **complete** the experiment in the Experiments section once you have your answer (and promote the winner per A/B Experiments, Part 4 if it earned it).

## Cost and safety guardrails

- A single `/battle` is up to four model invocations (two assistants times two rounds), so battle is **premium-tier only** by default.
- Only **one** active battle runs per channel at a time; a second `/battle` while one is in flight is asked to wait.
- The platform's existing retry, fallback, and circuit-breaker protections apply to battle invocations unchanged.
- An experiment and a battle compare exactly **two** variants; comparing more than two at once is not supported.

## Troubleshooting

- **"/battle did nothing or said it is not enabled here."** The channel does not have Battle Mode on. A moderator enables it in the members panel, then try `/battle` again.
- **"/battle is premium-only."** The conversation is not on the premium tier. Battle requires a premium channel by default.
- **The Enable for /battle option does nothing useful.** The experiment must have a display name on each variant and a free alt-bot slot.
- **No alt-bot slot is available.** Disable battle on another experiment to free its slot, or raise the alt-bot slot count on your next deploy.
- **The Experiment Results table is empty or shows an Aurora-only banner.** Per-variant results require Aurora mode; enable it, then let traffic flow through the experiment.
- **Only one assistant answered a battle.** The treatment may not be a member; turn Battle Mode off and on again to re-add it, and confirm the experiment is still active.
