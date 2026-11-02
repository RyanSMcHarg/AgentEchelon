# A/B Testing and Running Battles

How to run real A/B model experiments on your own traffic, measure which model wins, promote the winner, and use Battle Mode to put two assistants head to head on the same prompt.

This guide is for operators (an admin running a single AgentEchelon deployment). It describes behavior, not any specific account or environment.

> **Feature availability.** Everything described in this guide is built except items marked **NOT BUILT** or **ROADMAP**: the **accuracy** objective and its classifier-accuracy measurement, reading the live model catalog into the form, and a one-tap thumbs prompt after a battle round (**NOT BUILT**); replaying an intent or base-model candidate over archived traffic before it meets live users (**ROADMAP**, [SPEC-BATTLE](../../specs/interaction/quality/SPEC-BATTLE.md) FR13). The two-version model (every experiment compares the live version with one candidate, [SPEC-BATTLE](../../specs/interaction/quality/SPEC-BATTLE.md) FR11) and the **Promote** action (FR12) are deployed and verified on a deployment. Battles are specified in [SPEC-BATTLE](../../specs/interaction/quality/SPEC-BATTLE.md).

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

AgentEchelon provides multiple ways to address these goals. Outside of A/B testing there is the option to move more users into a tier whose declared grants include only lower-cost models. You can also put guardrails up to prevent users from engaging with assistants for specific, high-cost intents, or work on operational changes and the way that context is managed. A/B testing provides the tools required to take a more targeted, quantifiable approach.

### Broad goals

When looking at cost, you can use the analytics in AgentEchelon to review performance for different intents and see which cost the most per interaction and which cost the most per month, using intent filters. This shows whether specific types of interactions account for a disproportionate cost, so you can optimize just those intents with A/B testing. If there is no obvious culprit, or the issue is genuinely broad (like general feedback about misrouting), you can look at two primary areas:

- **Intent classification** - the low-cost, efficient model used to understand and route user requests. AgentEchelon ships with Anthropic's Haiku, but you may want to try other low-cost alternatives and compare effectiveness and cost against Haiku. Because these are already low-cost, tests at this level are most often for quality or latency.
- **Default model** - the power of modern AI systems is that they assist with a wide variety of requests. Because of that, it is inconvenient (and, depending on guardrails, sometimes impossible) to match every possible request to a specific workflow or model. To handle requests not tied to a specific model, AgentEchelon uses a default model, which differs per tier. By experimenting with different default models you can optimize a broad set of responses for performance, cost, or quality.

### Focused goals

Focused goals are used when you want to optimize a specific intent or process, often a high-value or high-cost intent like image generation. For these cases, AgentEchelon lets you set up A/B tests scoped to a specific intent.

## Concepts

- **Experiment.** A named comparison with a **control** variant (A) and a **treatment** variant (B), the one tier (classification) it runs in, a traffic split, and a type (below). A battle is the same experiment's two variants compared head to head in a single conversation, instead of each conversation being assigned one of them.
- **Experiment type.** What the experiment swaps. Three types swap a single model at one lever: the **Classification** model, the **Base** (default) model, or the model for one **Intent**. A fourth, **Profile vs Profile**, swaps the whole assistant profile version at once. See Part 1.
- **Variant.** One side of the comparison. For the single-model types the treatment names a model (plus, for battles, a display name and an optional prompt addendum), and the control is the live assistant's active version, so it names no model. For a Profile experiment each side is a **profile version reference** (a profile name and an optional version) rather than a bare model; a variant is exactly one of the two, never both.
- **Traffic split.** The percentage of new conversations assigned to each variant. You set the control percentage; the treatment (variant B) gets the rest.
- **Enrollment.** A conversation is enrolled in the experiment that is live for its classification at the moment the conversation is created, and assigned a variant deterministically (a hash of the channel and the experiment identifier). It keeps that variant's version while the experiment is active; when the experiment is paused, completed (Promote included), deleted or passes its end date, the conversation returns to the live assistant's active version from its next turn, and a resume does not take it back. A conversation that already exists when an experiment is armed is never enrolled in it, so a new experiment accrues data only from conversations started after it is armed.
- **Objective.** What the experiment is for: a written **statement** of the decision it informs, a **primary metric** and target (cost, quality, or latency) the result is framed against, optional **guardrails** (metrics that must not regress for a ship), and an optional **human pick weight** for how much battle picks count. Advisory only: it informs the recommendation, never an automatic routing change. (The **accuracy** metric is **NOT BUILT**: it needs the classifier-accuracy measurement, which does not exist, so it always reads as pending.)
- **Battle Mode.** A per-channel toggle that pulls the treatment variant into a conversation as a second assistant, so one prompt is answered by both.
- **Challenger.** The alt assistant `alt-{role}-{classification}` (labeled **Challenger** in the console), provisioned by its classification's stack, one per classification and assistant role. Arming an experiment for battle names its classification's challenger for the treatment, and a challenger only ever answers in its own classification's rooms.
- **Two versions of one assistant.** Every experiment, battle or not, compares two complete versions of one assistant. When you arm it, the control is pinned to the version the live assistant serves (by number; nothing new is written to the live assistant's history), and the treatment is a **candidate** version derived from it that differs only in what the experiment type names, kept in the challenger's history ([DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP](../../specs/interaction/quality/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md) §3.5). Every turn of an enrolled conversation is served its variant's version whole, its per-intent routes included, under the live assistant's identity.

Everything below lives in the admin console under the **Experiments** section, except channel Battle Mode (which a channel moderator toggles in the conversation's members panel).

## A/B Experiments

### Part 1: Set up an experiment and its variants

Open the admin console, go to **Experiments**, and choose **New Experiment**.

First choose a **Type** (Intent, Base Model, Classification, or Profile).

The first three are the established, targeted tests: each **swaps one model at one point in the flow** of your *current* assistant and holds everything else constant, so the result isolates that single change. In practice these are the fast, mostly model-and-prompt-driven experiments you reach for to tune an assistant you already run. They differ only in *which* lever they move (the three levers from the flow above):

- **Classification** - swaps only the low-cost intent-classifier model. Everything downstream (base and per-intent models) is unchanged. A classification test cannot run while any other type of test is running on the targeted tier(s), because changing the classifier shifts routing for every intent and would confound the other tests.
- **Base Model** - swaps only the default (fallthrough) model for a tier, across every intent that is not pinned to its own model. The classifier and any per-intent models are unchanged.
- **Intent** - swaps only the model for one specific intent (for example code generation, or the image-generation step): the candidate changes that intent's route primary and keeps its fallback. The classifier, the base model, and every other intent are unchanged. The candidate may name a cheaper model than the base model; a route is served as written.

Whatever the type, the candidate is the live assistant's active version plus that one change, so the two arms differ in nothing else.

The fourth type is different in kind: it does not tweak your current assistant, it compares **two whole, separately-built assistants**.

- **Profile vs Profile** - compares two assistant **profile versions**, not a single model. This is the type to use when you are testing **new profiles** you have built, rather than tuning a model in the assistant you already run. A profile version is a portable, versioned artifact that bundles ALL of the above at once (base model, every per-intent model, the classifier, the tool surface, and limits) plus its identity (see [How to add or manage a profile](../developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md)). Both variants are profiles: you pick a profile version for control and a profile version for treatment (typically your current active version versus a new candidate). When armed, the control is pinned to the version it references and the treatment is copied into the challenger's history as the candidate, keeping the live assistant's intents (a variant never changes which intents an assistant serves). Because many things change at once, a Profile result tells you which *configuration* wins overall, not which single model or prompt caused it; reach for one of the three single-lever tests above when you want to attribute the win to one change. Like a base-model test it applies across intents. A Profile experiment whose control is not the live assistant's active version compares two non-live configurations: it records a decision, and the Promote action does not apply to it.

Then fill in the fields. Most are common to every type; the type-specific fields are noted.

**Common fields**

- **Experiment ID** - a short stable name, for example `exp-codegen-sonnet-vs-opus`.
- **Control** and **Treatment Model** - for an Intent or Base Model experiment the control is the live assistant's active version, so the form names no control model and shows "Control: the live assistant's active version, pinned when the experiment starts"; you pick only the treatment model. For a Classification experiment you name the control classifier as well, and it must be the classifier the live version uses. Control is variant A; treatment is variant B. The available models come from your deployment's model catalog, which can include Bedrock and external (non-Bedrock) models. See the [Model Strategy guide](../developer/MODEL_STRATEGY.md) for the catalog. Reading the live catalog into the form is **NOT BUILT**: the model list is a fixed set, and admin management of the catalog is design only. For a **Profile vs Profile** experiment these become **Control Profile** and **Treatment Profile** pickers instead: choose a profile name and, for each, a specific version or leave it on the active version. The rest of the form is the same.
- **Tiers** - the one user tier (classification) the experiment runs in (`basic`, `standard` or `premium`; `standard` preselected). An experiment compares two versions of one assistant, and an assistant acts in one classification, so picking a tier replaces the previous choice; arming an experiment that names any other number is refused (`EXPERIMENT_ONE_CLASSIFICATION`). A model the tier does not select is refused when the experiment is created (`VARIANT_MODEL_NOT_ALLOWED`) and when the candidate is derived, so the experiment never grants more access than the tier already has. The classification's model selection is enforced in two places: the write path refuses a version selecting a model the classification does not select, and the serving Lambda's `bedrock:InvokeModel` grant lists only the model ARNs of its selection (`modelArnsForClassification` in `agent-classification-common.ts`), so a Bedrock model outside it is refused by IAM even if the write path were bypassed. An external (non-Bedrock) model is bounded by the write path and by the classification's selection, since only a classification that selects it holds its provider's key.
- **Start date** - the form has no start-date field: an experiment created in the console starts the moment it is saved. A start date is set only through the API (`startDate` on `POST /admin/experiments`, `AWS_IAM`, on `AdminApi`). A future-dated start IS honored: the experiment stores as active but resolves no traffic until the start date passes. It still counts toward the active-experiment cap from the moment it is saved, so a batch of scheduled tests consumes cap while it waits. An unparseable date is refused at save time rather than silently stranding the experiment.
- **End Date** - optional, when the test ends. Left empty, the experiment is open-ended and runs until it is ended or promoted. Once past the end date the experiment enrolls no new conversations, and conversations already enrolled return to the live assistant's active version from their next turn.
- **Objective** - a small block that records *what decision the test informs* and *what would make you ship a variant*, so the experiment is a documented decision rather than a set of numbers that moved. It is advisory throughout: it frames the recommendation and never triggers a routing change on its own. It has four parts:
  - **Statement** (required) - the decision this test informs, in a sentence or two, for example "Decide whether premium code generation should move to Opus, and ship Opus only if it clearly improves code quality without a large cost increase." The create form requires it (an empty statement is blocked or warned), it is capped at 500 characters, and it is sanitized. This prose is also what battling users are shown in the briefing, so write it for that audience (see Battles, Part 2). There is no separate free-text description field.
  - **Primary metric and target** - the one quantitative criterion the result is framed against, one of:
    - **Cost** - a target percentage decrease in cost.
    - **Quality** (Base Model, Intent) - a target percentage, measured by AgentEchelon's evaluator and by user thumbs up / thumbs down. The evaluator and user signals are reported separately so you can weigh user input more heavily, and results flag when too few user ratings have been collected to be confident.
    - **Latency** - a target percentage decrease in time, measured by the evaluator. For Classification this is the classification step specifically; for Base Model and Intent it is response time for the affected intents.
    - **Accuracy** (Classification), **NOT BUILT** - a target percentage for classifier correctness. The classifier-accuracy measurement does not exist, so an accuracy objective always reads as pending.
  - **Guardrails** (optional, up to three) - metrics that must not regress for the result to recommend a ship, each a metric plus a bound, for example "cost no worse than +25%" or "fallback rate no worse than +2%". A guardrail can also state a minimum rather than a maximum ("quality at least +5%"), in which case a result the data can show fell short of the floor fails it in the same way a regression past a maximum does. A guardrail is a veto: a primary-metric win bought with a guardrail regression is not recommended as a ship, and the recommendation names the breached guardrail. Setting the decision rule up front this way also keeps the results honest (see Part 3).
  - **Human pick weight** (optional, 0 to 1, default 0; API only: the form has no field for it, so it is set as `objective.humanPickWeight` on `POST /admin/experiments`) - how much the head-to-head battle picks count toward the recommendation relative to the primary metric. At the default of 0, battle picks are shown alongside the metric result but do not change it. Raising it lets the hands-on human signal carry weight when both signals exist (see Battles). The metric verdict and the human verdict are always shown separately and never blended into a single number; agreement raises confidence, and disagreement is surfaced as an explicit conflict for you to reconcile.

**Type-specific field**

- **Intent** (Intent type only) - which kind of request this experiment applies to (General Q&A, Code Generation, Code Review, Document Extraction, Report Generation, Image Generation, Strategic Analysis, or Workflow Actions). The candidate changes only this intent's route, so the two arms answer every other intent identically, and only turns of this intent count toward the experiment's results. For **Image Generation** the two variant fields become **Control Image Model** and **Treatment Image Model** (Stability Core / Ultra, OpenAI, FAL), because the thing being compared for an image request is the image model, not a text model; both are required, the control's must be the image model the live version already uses (its `image_generation` route's primary, or the legacy `models.image`), and the treatment's becomes the primary of the candidate's `image_generation` route, which keeps the live route's fallback. Each must be an image model the live assistant's classification selects (`VARIANT_IMAGE_MODEL_NOT_ALLOWED` otherwise). One hosted outside AWS (OpenAI, FAL) is used exactly where the classification selects it, which is also where its stack holds the provider's key (`modelFits`, `resolveTurnImageRoute` in `async-processor-core.ts`); no version setting opens it. Image generation is a normal capability, so an enrolled conversation's version serves its own image model on ordinary image requests - a battle is not required (it only adds the side-by-side UI and scoring). Image comparison is meaningful for an Image Generation intent experiment or a Profile vs Profile experiment (each profile carries its own image model); a Base Model or Classification experiment varies a text model, so an image prompt there runs the same image model on both sides.

When the form is complete, choose **Create & Activate**, the form's one save action. It saves the experiment and arms it with a status of **active**, unless the classification is already occupied by another test, in which case the console offers to free it first (see Part 2). The form saves no draft. A **draft** (saved but not live: assigned no traffic and freely editable, useful for staging an experiment before it runs) is created through the API, with `status: "draft"` on `POST /admin/experiments`, and activated through the API, with `{ "status": "active" }` on `POST /admin/experiments/{experimentId}/status`. The Experiments list shows a draft under its **Draft** filter and offers **Delete** on it, but no Activate.

**What arming does.** Activating an experiment (on create, from a draft, or on Resume) pins its two versions: the control to the live assistant's active version, and the treatment to a candidate derived from it by the type's recipe and published in the challenger's history. Arming is refused, and nothing is stored, when:

- the control names something the live version does not serve (`CONTROL_DIFFERS_FROM_LIVE`): leave the control's model unset, or name the live one;
- the live assistant has no active version to pin (`CONTROL_HAS_NO_ACTIVE_VERSION`): activate one in the Profiles tab first;
- the experiment does not name exactly one tier (`EXPERIMENT_ONE_CLASSIFICATION`) or exactly two variants (`EXPERIMENT_TWO_VERSIONS`);
- the candidate cannot be derived (`DERIVATION_FAILED`, `DERIVATION_UNAVAILABLE`, or the validation error itself), for example because it names a model the classification does not allow.

The console has no edit form: an edit is a `POST /admin/experiments` carrying the same `experimentId`. Editing an armed experiment (weights, end date, objective), running or paused, keeps its pins, so the live assistant moving on does not change what it compares and a paused experiment can still be promoted. An edit that would change what the pins were derived from (the variant models, the type, the intent or the classification) is refused with `EXPERIMENT_LIVE_EDIT_LOCKED`; create a new experiment instead. A **Resume** arms again and pins the live version of that moment; conversations already enrolled keep the version they were given. An experiment armed before experiments pinned two versions is armed this way the first time it is paused and resumed; until then an Intent or Base Model one keeps choosing its variant's model per turn.

### Part 2: Set the traffic split

The **Traffic Split (Control %)** slider sets what share of new conversations is enrolled in the control. It runs from 10 to 90 in steps of 10, and shows the resulting split, for example `70% / 30%`. The treatment (variant B) receives the remainder, so a control value of 70 enrolls **30 percent of new conversations** in the treatment.

How the split is applied:

- Assignment is **deterministic and once per conversation**. When a conversation created while the experiment is live sends its first turn, the platform hashes the channel identifier together with the experiment identifier into a bucket from 0 to 99, maps that bucket to a variant by cumulative weight, and records the variant's version on the conversation. A 70/30 split sends buckets 0 to 69 to control and 70 to 99 to treatment.
- An enrolled conversation is served its variant's version on every turn, the greeting included, while the experiment is active; a pause or an end returns it to the live active version. Conversations that existed before the experiment was armed are never enrolled. Each type still counts only the turns it is about: an Intent experiment its intent's turns, a Classification experiment the turns its classifier labeled, a Base Model experiment every turn but a greeting.

Start conservative (for example 90/10) to expose the candidate to a small slice, then widen the split as confidence grows by editing the experiment through the API (Part 1). A changed split applies to conversations not yet enrolled.

Each experiment shows its variants and weights in the **Experiments** table, alongside its type, status, tiers and **Started** date. The table lists every experiment that is not deleted, and its filter buttons (**All**, **Active**, **Paused**, **Draft**, **Completed**) each show a count.

You can **Pause** an experiment (stops enrolling, returns its conversations to the live version, keeps the data), **Resume** it, or **End** it. While an experiment is live it enrolls new conversations and holds each to its arm; when it is paused or ended it enrolls none, and every conversation it enrolled is served the live assistant's active version from its next turn (see "When a change takes effect").

#### Experiment states

An experiment moves through a small, explicit set of states:

- **Draft** - saved but not live. No traffic is assigned and the experiment is freely editable. A draft is created and activated through the API (Part 1).
- **Active** - live: new conversations in its tier are enrolled and served their variant's version.
- **Paused** - new conversations stop being assigned to it, but the data collected so far is preserved and you can **Resume** it later with that data intact.
- **Completed** - terminal. The test has stopped collecting data and its results stay in the dashboard. To run it again, create a new experiment with a new ID.
- **Deleted** - terminal. See the delete behavior below.

Two edit guards keep a running test trustworthy. Once any variant has collected traffic, the variant **models and the variant count are locked**: you can still change the traffic split, the end date, and the objective, but changing *what is being compared* means creating a new experiment rather than swapping variants under a live test. And a **completed** experiment cannot be reopened. When an experiment passes its end date it auto-completes and stops being resolved. Every state change is recorded in an audit trail (who acted, what changed, and when).

#### Recording the decision

Completing an experiment that ever collected data prompts you to record the **outcome**, so an inconclusive test closes honestly instead of being quietly dropped. The options are **promoted treatment**, **kept control**, or **No decision**, and **No decision is the default and always available** - you are never forced to declare a winner. This is simply your record of what you did after reading the advisory recommendation; recording a decision when you end an experiment is not itself the promotion. The **Promote** action (Part 4) records **promoted treatment** for you as it completes the experiment. A never-started draft has nothing to decide, so it skips this prompt. The recorded decision, with your identity and the time, shows on the completed experiment and in the audit trail, and the results view can later show the **recommended verdict next to the decision you chose**.

#### Freeing a classification

A classification can host only one test at a time, and a classification test in particular cannot run alongside any other type on the same tier(s), because changing the classifier shifts routing for every intent. When you try to activate or create an experiment that conflicts with one already on the classification, the console does not just show an error: it tells you **which** experiment holds the classification and offers three ways to free it, each behind a confirmation that states the consequence.

- **End the existing test** - completes it (terminal, not resumable). Its results stay in the dashboard, and because it ran, ending it prompts you to record the outcome (with **No decision** as the default, as above).
- **Pause the existing test** - stops new assignments but preserves the data collected so far, and you can **Resume** it later. Reversible, but still confirmed because it changes a running test's data collection.
- **Delete the existing test** - removes it from your experiments and releases its challenger. A never-started draft is removed outright; a test that ran becomes a hidden tombstone so its historical analytics keep their variant labels. Not resumable, and not undoable.

After the action you choose frees the classification, the console retries your original create automatically, so you are not sent back to the start. Each of these actions is recorded in the audit trail with your identity.

### Part 3: Compare and measure the results

Open the **Experiments** section and click an experiment's row: its page opens (**← All experiments** returns), and its **Results** section, titled with the experiment's name, is one comparison card: the control (A) and the treatment (B) side by side, one row per metric with the better value marked, and **Get recommendation** for the advisory verdict. The rows are:

- **Task completion** and **Quality** - the headline rows. Quality is the average evaluator score for the variant's responses.
- **User approval** - the thumbs up / thumbs down collected on the variant's responses, as an approval percentage reported separately from the evaluator score (Aurora mode).
- **Battle wins** - the head-to-head `/battle` picks the variant won.
- **Latency** - average response time.
- **Est. cost / reply** - estimated cost per reply.
- **Compliance** - the share of responses that passed the configured guardrails and format checks.
- **Fallback** - how often the variant's primary model failed and a fallback model answered instead.
- **Sample (conversations)** - how many enrolled conversations the variant's counted turns came from. This is your sample size: every test counts conversations (see *Conversations, not exchanges* below).
- **Sample (exchanges)** - how many request/response pairs the variant served and counted. The averages are taken over these.
- **Scored by the evaluator** - how many of those exchanges carry an evaluator score.

A **Merge battle turns into metrics** checkbox above the cards is off by default: battle turns are chosen rather than randomly assigned, so they stay out of the averages unless you merge them.

Read the two rows together: a treatment that wins on score and compliance without a meaningful latency or fallback penalty is a real improvement; a treatment that only wins on latency but loses on score is not. When an **objective** is set, the results also show progress toward that target (met, not met, or pending) and feed it into the recommendation. An **accuracy** objective always shows *pending*, because the classifier-accuracy measurement is **NOT BUILT**.

#### Conversations, not exchanges

An experiment holds an enrolled conversation to one arm while it is active, so every counted turn of one conversation is the same person, on the same topic, served the same version. Those turns are not independent: forty replies to one person are one person's experience, not forty people's. Each variant therefore shows two counts, **conversations** and **exchanges**, and they mean different things:

- **The averages are over exchanges.** Score, latency, cost, approval and battle win rate are the per-exchange (or per-vote, or per-pick) figures, so they reconcile row for row with the drill-downs below.
- **The tests count conversations.** Every confidence interval, p-value, guardrail state, the underpowered state and the hard minimum treat the conversation as the unit. A variant with 400 exchanges from 12 conversations is 12 observations, and its interval is as wide as 12 observations allow. When each conversation holds one counted exchange, the two counts are equal and so are the results.
- **Approval** is tested with votes grouped by the conversation they were cast in, and the recommendation states votes and conversations.
- **Battle picks** are tested per **battle**: several people judging one battle count as one battle's evidence. The recommendation states picks and battles.

What a conversation counts toward depends on the experiment type: an **Intent** experiment counts only the turns of its intent (other turns of the conversation are served the same route in both arms and carry no attribution), a **Classification** experiment the turns its classifier labeled, a **Base Model** experiment every turn but the greeting and acknowledgment, and a **Profile** experiment every turn. A conversation appears in an experiment's count once at least one of its turns counted. Experiments armed before versions were pinned are counted the same way: they assign a turn by a hash of the conversation, so a conversation stays in one arm.

#### Significance

A raw average lead is not a winner. The results distinguish a real difference from noise, so a one-point lead on a thin sample does not read the same as a decisive gap:

- **Per-metric labels.** Each metric is labeled honestly as *no difference*, *leads (not significant)*, *leads (p<0.05)*, or *leads (p<0.01)*, rather than simply highlighting whichever number is larger. The primary metric and its guardrails are tested and reported with a confidence interval: continuous metrics (score, latency, cost, tokens) use Welch's t-test, and the objective's metric is one of cost, accuracy, quality, or latency. The two human signals are tested and reported with their own intervals as separate axes: **battle win rate** (Wilson interval) and **user approval** from thumbs (two-proportion test with a Newcombe interval on the difference). Compliance, fallback and task completion are reported as descriptive columns; they are not tested and cannot currently be selected as an objective metric or a guardrail.
- **Underpowered state.** When a metric has too few conversations to detect the effect your target implies, the results show an *underpowered: need about N more conversations per variant* state instead of a premature winner. A hard minimum still applies below which nothing is claimed.
- **Scored exchanges.** A quality or accuracy objective needs SCORED exchanges, not just exchanges. Those objectives read the evaluator score, and the evaluator works through a sample and a backlog, so at any moment much of your traffic carries no score. The underpowered check therefore counts **scored** conversations (conversations with at least one scored exchange) rather than exchanges: the smaller of the two variants' scored conversations is the sample size it uses to ask whether the data can detect the effect the objective names. An experiment with traffic on both sides but nothing scored has no measurement of quality at all and reports *keep running - not enough data yet* rather than declaring the variants equivalent. The per-variant scored count is shown beside the exchange count, so the gap between traffic and evidence is visible; the quality average is over the scored exchanges only. Cost and latency are measured on every exchange and are unaffected.
- **Hard minimum.** The hard minimum ships at 5 conversations per variant, deliberately low, and increasing it is recommended. The default is set for a first look: most people meeting this feature want to watch the lifecycle work - create a variant, send it traffic, get a verdict - and at a statistically respectable floor the first verdict is tens of minutes of traffic away, which makes the honest setting and the demonstrable one mutually exclusive. Five is a **demonstration floor, not a decision floor**: the verdict is real arithmetic on real traffic, but underpowered, so it will usually report *low* confidence with a wide interval. That reading is correct, not a defect.

  **Raise the floor.** Raise it once you are past the first look, and before anyone routes traffic or retires a variant on what a verdict says. 30 conversations per variant is the usual starting point; pick higher if your metric is noisy or the effect you care about is small. Set `minSamplePerVariant` in the gitignored `backend/deploy.config.json` and redeploy with `cd backend && npm run deploy`. The floor is **per variant**, so the smallest arm gates the result, and a later deploy that omits the key restores the default without warning, which is why it belongs in the config file rather than on one command line.
- **Guardrails.** Each guardrail shows one of three states, because a bound can be passed, failed, or not yet answerable. **Held** means the confidence interval on the difference sits entirely within the bound, which is what a ship requires. **Breached** means it sits entirely past the bound, which vetoes a ship even when the primary metric won, and the recommendation names it. **Not established** is everything in between: the interval spans the bound, so the data supports neither claim. That is not a pass, and a ship does not proceed on it; the answer is more data. Every one of those comparisons is made against the bound you set, never against zero, so a difference that is merely distinguishable from no-change is not reported as a breach.
- **Confidence.** The recommendation's confidence (low, medium, high) is derived from the computed result - significant and powered with guardrails held reads high; not significant, underpowered, or a regressed guardrail reads low - not from a model's opinion. Any prose narrates the computed numbers; it does not source the confidence.
- **Human pick.** Battle picks are reported as their own human-preference signal (for example "18 of 25 picked treatment in 25 battles, 72%, CI 52-86%") with its own confidence interval computed per battle, shown next to the metric verdict and never folded into it. When the human signal and the metrics disagree, the disagreement is stated plainly for you to reconcile rather than averaged away. How much the human axis counts toward the overall verdict is set by the objective's human pick weight (default 0).

The whole recommendation stays advisory: it never reroutes traffic on its own, and the "advisory, not auto-applied" framing is kept. On a completed experiment the results can show the **recommended verdict alongside the decision you actually recorded** (Part 2), which may differ.

#### Checking a number

You do not have to take a result on trust. Four figures carry a **show** control that opens the rows behind them, so you can recompute the number and read the conversations it came from:

| Control | What it opens |
|---|---|
| **Sample (exchanges)** | The randomly assigned turns for that variant, with each one's score, latency, tokens and model. Battle turns are excluded, exactly as they are from the averages above it. |
| **Turns** on the battle scorecard | The replies produced inside battles for that variant. |
| **User approval** | One row per counted vote. |
| **Battle wins** | One row per counted head-to-head pick. |

Each of the four is a different set of traffic, which is why they are separate controls rather than one link. Battle turns and battle picks in particular are not the same thing: a battle produces a reply from each side and at most one pick per person.

The view checks itself. It recomputes the count and the mean over the **whole** matching set, not just the page on screen, and says either *Reconciles with the result above* or *DOES NOT reconcile* with both numbers shown. A mismatch means the pipeline disagrees with itself, and the verdict should be treated as unverified until it is resolved.

Two things it tells you that change how a mean should be read:

- **Unscored exchanges.** The quality average is over the scored exchanges, as the average above is, so the drill-down reports how many rows carry no evaluator score. If a large share are unscored, the average describes a small part of the traffic.
- **Redacted and deleted messages.** They keep their numbers and lose their transcript. The exchange still counted toward the score, so removing it would stop the numbers adding up. The row stays, the transcript is withheld and labeled, and the view states how many of the rows are affected.

Opening a transcript uses the same permissioned admin read as the Conversations view.

Two things to know about measurement:

- **Results require Aurora mode.** The Experiment Results table is powered by the analytics database. In the default Athena mode it shows an honest "Aurora-only" banner rather than an empty table. Enable Aurora mode (see the Aurora Mode Guide) to get per-variant scoring.
- **Data accrual.** Results appear once messages have flowed through an active experiment, so give a new experiment enough conversations on each variant before drawing a conclusion.

For battles specifically, you also get the per-battle scorecard and a per-step breakdown described under Battles, Part 2.

### Part 4: Promote the winner

When a treatment wins, you promote it: the live assistant then serves exactly the version that was measured. AgentEchelon keeps a human in the loop here on purpose: experiment and battle results are descriptive, and a result never reroutes future traffic on its own.

**The Promote action** ([SPEC-BATTLE](../../specs/interaction/quality/SPEC-BATTLE.md) FR12, [DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP](../../specs/interaction/quality/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md) §3.6). On a running or paused experiment that pinned two versions, choose **Promote** in the Experiments list, add an optional note, and confirm. The platform:

1. refuses if the live assistant's active version is no longer the control the experiment pinned (someone activated another version since): the candidate was a variation of a version that no longer serves, so run a new experiment against the current version;
2. copies the candidate's body into the live assistant as a new version and refuses, writing nothing, unless the copy hashes to the candidate's `configId`, so what goes live is byte-identical to what was measured;
3. records on the new version where it came from (`promotedFrom`: the candidate, its version and the experiment), activates it (applying its display name to the assistant's identity, as any activation does), completes the experiment with the outcome **promoted treatment** and your note, records the promoted version on the experiment, and releases the challenger. The candidate stays in the challenger's history as the record of what was tried.

Promote is an activation of the live assistant's profile, so it needs the `activate-profiles` capability (the button is offered only to a role holding it), and a team member promotes only their own assistant's experiments. A role that may run experiments but not activate profiles is refused. The promoted version keeps the candidate's `configId`, so its turns are attributed to the same version the experiment measured.

Promote does not apply to a Profile vs Profile experiment whose control is not the live assistant's active version (it compared two non-live configurations), or to an experiment armed before experiments pinned two versions (pause and resume it first). Conversations already enrolled in the experiment keep the version they were assigned.

**After promotion, move the tested instruction into the persona.** A promoted version still carries the winning side's tested instruction as its `systemPromptAddendum`, shown on the assistant's page as **Tested instruction (from an experiment)**. Once it has won, it is part of how the assistant answers, so it belongs in the persona. Open a draft of the assistant (the **Edit** toggle on its page) and choose **Move into the persona** beside the instruction: the console adds it as the last item of the persona's `How to answer:` section, in that section's bullet style, or adds the section at the end of a persona that has none, and clears the instruction, all in one draft save. Review the persona in the draft, then validate and activate as usual; nothing serving changes until you do. The move is offered to a session that may edit the assistant, and it is refused, with the reason, when the version has no persona of its own (it answers with the classification's persona, which a move would replace) or when the persona would pass its 20,000-character limit. `How to answer:` is the platform's own section marker, the one the shipped personas use (`HOW_TO_ANSWER_HEADING` in `backend/lambda/src/lib/persona-sections.ts`); a persona that names its section in other words keeps it, and gains a `How to answer:` section at its end.

**Declining.** End the experiment and record **kept control** or **No decision**. Nothing changes for the live assistant.

**By hand.** Between instances, export the winning candidate and import it into the other instance, where it lands as a draft somebody reviews and activates ([How to add or manage a profile](../developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md)). Changing the deployment's model strategy and redeploying stays available for the platform default a blank profile inherits; it is not promotion of a measured version.

There is intentionally **no automatic promotion** of a winning variant: hitting a target produces a recommendation, never a routing change, and Promote is a deliberate operator action.

### When a change takes effect

Activating a version, by Promote or in the Profiles tab, applies to **the next turn** of a conversation the live assistant serves, not the next conversation. Nobody has to start a new conversation, reconnect, or sign out, and no in-flight reply is interrupted: a conversation that is mid-thread simply gets the new behavior on its next message.

There is a short convergence delay, because each running handler caches these reads. The two caches are separate and have different lifetimes:

| Change | Converges within | Why |
|---|---|---|
| Activating (or rolling back) a profile version | **~30 seconds** | Each handler resolves the active profile per turn and caches it briefly |
| Starting, completing, pausing, or ending an experiment | **~60 seconds** | Experiments are read per turn and cached briefly |

So the full sequence when you activate a profile version is:

1. **Activate.** The new version is written and the `active` pointer moves to it. Nothing is deployed and nothing restarts.
2. **Within ~30 seconds**, every handler picks it up on its next turn.
3. **Rollback behaves identically**, including the delay: a version you roll back can still serve for up to ~30 seconds. If you are backing out a bad activation, expect a short tail rather than an instant cut-off.

An enrolled conversation of an ACTIVE experiment is the exception: it is served its variant's pinned version, not the active one, so activating a new version does not reach it while the experiment runs. Promote completes the experiment, so its conversations then return to the live version, which is the promoted winner.

And when an experiment is paused, completed, or its end date passes:

1. **Within ~60 seconds** the experiment stops enrolling new conversations; they are served the live assistant's active version.
2. **Every conversation it enrolled returns to the live assistant's active version** on its next turn after that, whatever the experiment type: the winner after a promotion, the control otherwise. An ended experiment never keeps a conversation on a version, because a losing version can be a worse experience; the cost is that a person on the treatment sees the assistant change mid-conversation. Those later turns carry no experiment attribution, so only turns served while the experiment was active count.
3. **A pause releases for good.** On **Resume** only conversations created after the resume enroll; conversations the pause released stay on the live version.
4. **A battle stops.** A battle already running on the experiment ends at its next turn instead of letting either side answer (its rebuttal included), and the alt returns to its provisioned name.

An **end date that has passed** stops enrolling immediately on the same schedule, even before the status label catches up; the label is corrected to `completed` the next time the experiment is read. A **future** start date is honored the same way: the experiment stores as active but enrolls nothing until the date passes.

Battles follow the experiment. When the experiment a battle-enabled channel is bound to ends, `/battle` in that channel replies that the comparison has ended rather than running a battle, and the channel's ordinary assistant continues to answer normally. Turn Battle Mode off in the members panel to clear the affordance, or start a new experiment and enable it again.

## Battles

A battle is the visible, hands-on version of the same experiment: the two variants answer one prompt side by side in a real conversation, instead of each conversation being assigned one of them. Battles exist to do two things the traffic split does slowly or not at all - **collect direct human feedback** (the pick-the-winner; a one-tap thumbs prompt is **NOT BUILT**) and give administrators and users a **real-time, tangible experience** they can use to drive a decision.

### Turn battle on

**Off by default.** Battle is off until you turn it on. It puts a second assistant into somebody's conversation, so a deployment that has not asked for it does not get it; it is typically wanted for internal users only. Skipping this step is the usual reason a correctly armed battle refuses to enable.

Battle Mode is a classification's setting, switched from inside the experiment that runs the battle: the **Battle Mode in** *classification* switch sits in the create form's battle card (Part 1) and in the **Settings** section of the experiment's page. Two things decide what you see:

- A classification your deployment **builds** battle for can be switched on. Standard and premium are, out of the box.
- One it does not build shows as **not available** and cannot be switched on. Basic is that case by default: its assistant is deployed without any battle plumbing, so there is nothing for a switch to turn on. Making it available is a deployment change, not a console one.

The change takes effect within about 30 seconds. Turning it back off stops new battles; a conversation already mid-battle finishes.

### Part 1: Turn an experiment into a battle

Arming a battle takes a few extra fields on the same experiment form.

In the experiment's form, tick **Enable for /battle**. Whether battles can run in a channel at all is two things: the deployment must BUILD battle for that classification (standard and premium out of the box; basic does not), and an operator must TURN IT ON with the **Battle Mode in** *classification* switch in the battle card. It is off by default, and typically only wanted for internal users. The Battle Mode card unfolds with a side-by-side control-versus-treatment layout:

- **Side names** come from the profiles, not the form: a battle has no alias, and each side is named from its profile. The control takes its pinned version's name, else the live assistant's; the treatment takes its version's name, else the control's. When the two match, the treatment reads as the challenger, by default `{name} (alt)`, which its version's copy can change (`battleAltName`). The live assistant keeps its own name; the challenger's identity wears the treatment's name while the experiment holds it and gets its provisioned name back when the experiment releases it; and each side's placeholder and its rival's rebuttal note use both names. The Battle Mode ON announcement names the challenger the same way, and when its name cannot be read it says "The challenger" (`battleChallengerUnnamed`), never the assistant id. The console's Battles section shows each version by that name with its version number beside it. A profile name names no model, so users read two distinct assistants rather than two model identifiers.
- **Tested instruction** per variant (`systemPromptAddendum`, optional, up to 500 characters): the one instruction the experiment tests, layered after the assistant's persona in `<persona_addendum>` tags on every turn of that side. Give it a variation under test, such as "Keep every reply under 80 words." on the side that tests whether shorter replies are rated higher. How the assistant answers in general belongs in the persona's How to answer section, not here. It shapes voice, not capability; the models remain the real comparison.
- **Challenger** - the alt assistant the treatment runs as when it joins a channel, listed from the deployment's assignment records (`GET /admin/experiments/challengers`). Each challenger belongs to one classification and one assistant role, and one active battle experiment can name it at a time.

An **image battle** is just an Image Generation intent experiment (its two variant image models, set above) with battle enabled: both sides generate an image in round one, then each critiques the other's image in the round-two rebuttal. Battle adds no image setup of its own; the model choice lives on the experiment, and battle only layers the side-by-side UI and scoring on top of the same flow. A Profile vs Profile experiment can also be an image battle when the two profiles carry different image models. Choose **Create & Activate**.

Any experiment type can be armed for battle, including **Profile vs Profile**: the two profile versions then answer side by side in one conversation, so you can feel the difference between two whole assistant configurations before you promote one.

**What Create & Activate does for a battle.** One action arms it, exactly as it arms any experiment (Part 1, "What arming does"). The control is the live assistant's active version, pinned by number, and answers from the live assistant's identity; the treatment is the candidate in the challenger's history, and answers from the challenger's identity. Each side answers every battle from its own version, per-intent routes included, so an **Intent** battle's sides differ only on the experiment's intent. For a **Classification** experiment the candidate carries the treatment's classifier and each side classifies with its own version's classifier. A **Profile** battle's candidate keeps the live assistant's intents (the derivation leaves the intent pack out). Round 2 of a battle serves each side the version its experiment pins, whatever the round's request carries.

The live assistant's history gains nothing from arming. The candidate appears in the challenger's history (`alt-{role}-{classification}`), carrying `derivedFrom` (the experiment and variant), and a rollback to it is refused; a version Promote activates carries `promotedFrom`. The Profiles tab marks both in an **Origin** column: a candidate reads "Candidate of <experiment> (<variant>)" with the version it was derived from, and offers no Roll back, saying it is activated through Promote on its experiment; a promoted version reads "Promoted from <alt> v<n> (experiment <id>)".

Arming a battle is refused, and nothing is armed, with a reason and a code: `BATTLE_TIER_PREMIUM_ONLY` (the experiment does not name exactly one classification, or names one whose deployment wires no battle; the code keeps its name for the API contract), `BATTLE_VARIANT_COUNT` (not exactly two variants), `BATTLE_IMAGE_GEN_PAIR` (only one variant names an image model, or one names an unknown image model), `BATTLE_BOUND_BY`, `BATTLE_CHALLENGER_REQUIRED` or `BATTLE_CHALLENGER_MISMATCH` (no challenger, or not this classification's), `ALT_NOT_PROVISIONED` (the classification provisions no challenger), `BATTLE_TREATMENT_MUST_PIN_ALT_VERSION` or `BATTLE_CONTROL_MUST_PIN_LIVE_VERSION` (a side's version could not be pinned), the arming refusals in Part 1 (`CONTROL_DIFFERS_FROM_LIVE`, `CONTROL_HAS_NO_ACTIVE_VERSION`, `EXPERIMENT_ONE_CLASSIFICATION`, `EXPERIMENT_TWO_VERSIONS`), and `DERIVATION_FAILED` or `DERIVATION_UNAVAILABLE` when the candidate cannot be derived (for example, it names a model the classification does not allow).

### Part 2: Run a battle

#### Turn on Battle Mode for a channel

Battle is opt-in per conversation, and only in channels whose classification is battle-capable AND has battle turned on (the **Battle Mode** switch in the experiment's **Settings**). A channel moderator opens the conversation's **members panel**, finds the **Battle Mode** section (status **Off**), and chooses **Turn on Battle Mode**. There is no experiment to pick: a classification holds one active battle experiment at a time, and the backend resolves it for the channel; the section names it as **Experiment:** with its objective statement (or its id) when the listing finds it. The status flips to **Active** and the treatment variant joins as a real member.

#### The battle briefing

Battling users are told what the battle is for, so they contribute a meaningful comparison instead of guessing. The briefing is built from the experiment's objective statement (A/B Experiments, Part 1) and is shown to the **battling users**, not only the moderator. It is semi-blind by design: it names the **decision**, never which side is which model, so the comparison stays fair (model identities appear in the scorecard only after answers land).

The briefing appears in two places:

- **On enable.** When Battle Mode turns on, the channel announcement adds a line built from the objective, for example: "Battle Mode is ON. Two assistants will answer the same prompt so you can compare them. We're deciding: whether premium code generation should move to a stronger model. Most useful prompts: ask a real coding task you'd actually ship. Try `/battle <your prompt>`."
- **Per battle.** A compact, dismissible banner above the first battle turn carries the same decision line plus two or three suggested **starter prompt chips**. Clicking a chip prefills the composer with a `/battle` prompt, so a user can contribute a useful comparison in one tap.

The suggested prompts steer the battle toward what the experiment measures. For an **Intent** experiment they are drawn from that intent (a code-generation experiment suggests real coding tasks, an image-generation experiment suggests real image prompts, and so on). A **Base**, **Classification**, or **Profile** experiment spans intents, so it falls back to a generic coaching line ("ask the kinds of questions your users actually ask") seeded from the objective statement. The prompt suggestions are example copy, not policy, and a deployment can override them.

#### Run and score

In a battle-enabled channel, start any prompt with the `/battle` command:

```
/battle What is the best caching strategy for a read-heavy database with 50 million rows?
```

Both assistants answer the same prompt in parallel (round one). A scorecard renders under the pair with three independent axes, never folded into a single number: **response time**, **estimated cost** (tokens times the model rate, an estimate for comparison and not a bill), and **quality**, which is your call (pick **A better**, **Tie**, or **B better**). A **Show steps** expander reveals the per-step rows (step label, model, duration), the same detail admins see.

The quality pick is the point: it is direct human feedback. In Aurora mode each pick is credited to the winning variant and surfaces as the **Battle wins** column in the per-variant Experiment Results, and it also feeds the experiment's recommendation as a distinct human-preference axis, shown next to the metric verdict and never blended into it (see A/B Experiments, Part 3). How much it weighs toward the overall verdict is set by the objective's human pick weight. At the end of each battle an inline result card summarizes that prompt's outcome (each side's response time and estimated cost, and which side you picked); the next `/battle` gets its own fresh card. A one-tap thumbs prompt after a round is **NOT BUILT**.

After both answers land, a divider marks **round two**: each assistant receives the other's answer, knows it is in a battle, and may rebut, build on it, or stay silent. Round two is commentary; the deliverable is round one.

A few behaviors worth knowing:

- Round two fires only after both sides fully answer, so you are judging who solved it better, not who replied faster.
- Topic-drift suggestions are suppressed during a battle, because divergence is the point.
- A side that is waiting on the person (a task-shaped battle whose chain parks on a question) is answered through the composer's **Replying to** selector, so the answer reaches only the assistant that asked, and only the person who started the battle may answer it. A round-1 clarifying question is dormant: the round-1 prompt does not ask a model to raise one (**OPEN**, [SPEC-BATTLE](../../specs/interaction/quality/SPEC-BATTLE.md) FR10).

#### Battle types

Battles escalate through increasing capability; run the ones your deployment supports:

1. **Single-turn**, a direct answer compared side by side.
2. **Report creation**, a multi-step answer delivered as a complete write-up.
3. **Document creation**, output delivered as a downloadable attachment.
4. **Image understanding (vision in)**, both assistants reason over an uploaded image or scanned document.
5. **Image generation (generation out)**, both assistants produce an image from a prompt.

Image generation needs the classification to be battle-capable and to produce images. A classification produces images when it selects an image model (`models.selected` on its entry; only premium as shipped), which also provisions its image grant and the image-output guardrail (`battle-image-guardrails.ts`). An experiment that names an image model the classification does not select, or a text model as its image model, is refused when it is created (`VARIANT_IMAGE_MODEL_NOT_ALLOWED`), as is a variant model the classification does not select (`VARIANT_MODEL_NOT_ALLOWED`); the image models must be enabled in Bedrock, or an external provider key supplied through the `imageGenKeysSecretArn` context key. See [Image generation providers](IMAGE-GEN-PROVIDERS.md). No extra alt is involved: the classification's one challenger serves image battles too. Run only the types enabled in your environment.

#### Reading battle results

Beyond the inline scorecard, the admin console shows the **per-step breakdown** for each battle (which model ran each step and how long it took), alongside the same A/B experiment metrics from A/B Experiments, Part 3.

An experiment has a goal and results, and when Battle Mode is on it also has battles. A battle is one run in a conversation: someone in battle mode gets both versions' answers over a few turns and picks the better one. Each battle is a sub-result of its experiment, so battles are read on the experiment's page:

- In the **Experiments** list, each row reads as one sentence: the experiment's name and goal, what it compares (`advisor: v12 vs v13`), its status, the evidence so far (`240 conversations · 9 battles`, battles only when Battle Mode is on), and the current result (the leading version and its lift on the goal's metric, and whether the sample is enough to decide). Click the row to open the experiment's page.
- The page reads **Goal**, **Results** (titled with the experiment's name: the per-version metrics from real traffic, the recommendation and Promote), **Battles** and **Settings**, in that order.
- **Battles** opens with one help line and a summary sentence, for example "Challenger won 6 of 9 battles; 3 not picked yet". **How each version did in battles** lists the control (the version live now) and the challenger (the version being tested), each with its name and version, battles won with its share of picks, and quality and estimated cost per reply in battles; every column header has a tooltip saying what it counts. **Each battle** is one row per battle: when, the room, the outcome (a version won, **Tie**, or **Not picked yet**), how many people picked, and **Open conversation**. Click a battle (or **Open conversation**) to open the conversation it ran in, where both versions' answers and the pick are.
- **Settings** holds each version's share of traffic, the challenger, and the classification's **Battle Mode** switch.
- There is no separate battles view: an old `?admin=battles` or `?admin=duels` link opens the Experiments list, or the experiment the link names. Battles are Aurora mode only.

Quality is captured as an explicit human pick (A, B, or tie) per battle, and in Aurora mode that pick is credited to the winning variant so it counts in the per-variant results as **Battle wins** and feeds the recommendation as a distinct human-preference axis (A/B Experiments, Part 3). The unit of that axis is the battle: **Battle wins** counts picks, and the interval treats the picks of one battle as one battle's evidence. There is no algorithmic judge, and a battle outcome never auto-routes future traffic; the human pick is surfaced next to the metric verdict rather than blended into one number, the decision stays yours, and promotion is the Promote action in A/B Experiments, Part 4.

### Part 3: Turn it off cleanly

1. In the channel members panel, set **Battle Mode** back to **Off**. The treatment assistant leaves the conversation.
2. Optionally **pause** or **end** the experiment in the Experiments section once you have your answer, or **Promote** the winner (A/B Experiments, Part 4) if it earned it. Ending or promoting releases the challenger, whose identity gets its provisioned name back.

## Cost and safety guardrails

- A single `/battle` is up to four model invocations (two assistants times two rounds), so battle is gated twice: the classification must be battle-capable, and an operator must have turned it on. Both are off or absent by default, which is itself the first spend control. After that, the channel flow runs the shared abuse gate (`evaluateAbuseGate` in `abuse-controls.ts`) once for the whole battle, before the round-one fan-out: it checks the sender's hourly rate limit (the profile's `rateLimitPerHour`) and consumes the per-user and global spend budgets (`checkAndConsumeBudget`). An over-limit or over-budget `/battle` is refused before any model is called.
- Only **one** active battle runs per channel at a time; a second `/battle` while one is in flight is asked to wait.
- The platform's existing retry, fallback, and circuit-breaker protections apply to battle invocations unchanged.
- An experiment and a battle compare exactly **two** variants; comparing more than two at once is not supported.

## Troubleshooting

- **"/battle did nothing or said it is not enabled here."** The channel does not have Battle Mode on. A moderator enables it in the members panel, then try `/battle` again.
- **"Battle Mode isn't available in this conversation. Reply normally and I'll respond as usual."** Battle cannot run in this channel's classification: either the deployment does not build it there (basic, out of the box) or nobody has turned it on. Turn it on with the **Battle Mode** switch in the experiment's **Settings** (Turn battle on, above); a classification that is not capable cannot be turned on at all and is shown as unavailable.
- **The Enable for /battle option does nothing useful.** The experiment must name exactly one battle-capable classification, two variants, and that classification's challenger, not named by another active battle experiment (the refusal codes are in Part 1 above).
- **No challenger is offered.** Each classification's stack provisions one alt per role, and a battle names the alt of its classification's `primary` role, so each classification has exactly one challenger and a challenger in another classification does not help this one. The form offers none for a classification whose deployment wires no battle. A challenger another experiment names shows that experiment's id; disable battle on that experiment **in the same classification** to release it. There is no context key that adds challengers.
- **A variant with hundreds of exchanges reads below the floor or underpowered.** The floor and every test count conversations, and those exchanges came from few of them. Read **Sample (conversations)** beside **Sample (exchanges)**; collect more conversations rather than more turns in the same ones (see *Conversations, not exchanges* above and [TROUBLESHOOTING](../user/TROUBLESHOOTING.md) entry 33).
- **The Experiment Results table is empty or shows an Aurora-only banner.** Per-variant results require Aurora mode; enable it, then let traffic flow through the experiment.
- **Only one assistant answered a battle.** The treatment may not be a member; turn Battle Mode off and on again to re-add it, and confirm the experiment is still active.
- **Arming is refused with `CONTROL_DIFFERS_FROM_LIVE`.** The control names a model, addendum or image model the live assistant's active version does not serve. Leave the control's model unset (Intent, Base Model) or name what the live version uses (Classification, image models). To compare two configurations neither of which is live, use a Profile vs Profile experiment.
- **Arming is refused with `CONTROL_HAS_NO_ACTIVE_VERSION`.** The live assistant serves its compiled seed and has no version to pin. Create and activate a version in the Profiles tab, then arm again.
- **Arming is refused with `EXPERIMENT_ONE_CLASSIFICATION` or `EXPERIMENT_TWO_VERSIONS`.** An experiment compares two versions of one assistant: pick exactly one tier and two variants.
- **Promote is refused because the live version moved (`LIVE_VERSION_MOVED`).** Someone activated another version of the live assistant after the experiment was armed. The candidate is a variation of a version that no longer serves; run a new experiment against the current version.
- **Promote is refused with `PROMOTION_HASH_MISMATCH`.** The copy of the candidate does not hash to the `configId` the experiment measured (the stored candidate is not what was measured). Nothing was written or activated; treat the candidate as untrusted and run a new experiment.
- **Promote is refused with `PROMOTION_NEEDS_TWO_VERSIONS` or `PROMOTION_CONTROL_NOT_LIVE`.** The experiment was armed before experiments pinned two versions (pause and resume it to pin them), or it is a Profile vs Profile experiment whose control is not the live assistant (it records a decision; promote by hand).
- **Promote is not offered, or answers 403 (`PROMOTION_NEEDS_ACTIVATE_PROFILES`).** Promotion activates a profile version, so it needs the `activate-profiles` capability; a role that only manages experiments is refused.
- **Promote reports `PROMOTED_BUT_NOT_COMPLETED`.** The new version is active, but the experiment changed while it was promoted and was not completed. Reload the experiment and end it, recording **promoted treatment**; do not promote it again.
- **Rolling back to a version is refused because it "was derived by experiment".** That version is a candidate that never served. Promote it with its experiment's Promote action, which copies the measured candidate into the live assistant.
