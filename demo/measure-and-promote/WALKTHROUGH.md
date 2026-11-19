# Walkthrough: measure an assistant, test a change, settle it head to head, and promote it

Setup (populating analytics, creating the demo experiment and sending it traffic) is in [README.md](README.md) in this folder. This walkthrough starts once that is done.

The [portable-assistants walkthrough](../portable-assistants/WALKTHROUGH.md) ends with Advisor live, versioned, edited and rolled back. This one answers the question a team asks next: is the change we want to make actually better, and how do we know? Four acts, all on Advisor:

1. **Measure** how Advisor performs now, per version, per intent and per step.
2. **Test** a candidate against the live version on real traffic, in an experiment with a goal and results.
3. **Battle** the two versions head to head in a conversation, as a result inside the same experiment.
4. **Trust and keep**: label answers, check how far the judge agrees with people, build the golden set, then promote.

An **experiment** has a goal and results; **battle mode** is an option on an experiment; a **battle** is one run of it in a conversation.

The console's analytics tabs fill only after traffic has been archived. An empty tab means the traffic that produces its data has not run yet, not that the tab is broken.

## Act 1. Measure

### 1.1 One assistant, one version

**Do:** admin console, **Assistants**, `advisor`, then **Effectiveness for vN** in the header.

**Notice:** **Performance**, **Overview**, with the filter bar set to Advisor and the version serving now: task completion, user approval, latency and cost. Every answer carries the `configId` of the version that produced it, so every number here belongs to one exact configuration, and a persona or model change is never blended into last week's average.

### 1.2 Per intent, then per step

**Do:** open the `financial_metric` intent, then a multi-step intent such as `report_generation` and its **By step** view.

**Notice:** each step of the workflow named (`collecting_requirements`, `drafting_outline`, `generating`, ...) with its own counts and latency. A multi-step answer is measured where it can go wrong: a report that stalls at requirements is a different problem from one whose generation is slow.

### 1.3 Where the numbers come from

The Amazon Chime SDK holds the live conversation; the S3 archive is the system of record, including what the Amazon Chime SDK never knew (model, tokens, latency, guardrail findings, scores, experiment arm); Aurora is a query layer rebuilt from the archive. The console reads Aurora, and if the two disagree, the archive wins.

## Act 2. Test a change on real traffic

### 2.1 What an experiment is

**Do:** **Experiments**, **Experiments**.

**Notice:** an experiment splits one classification's traffic between two complete versions of one assistant, one experiment per classification at a time. The control is the live version, pinned by number at the start; the treatment is a candidate derived from it, so a change is tested with the persona and tools it will run with.

### 2.2 Create one with a tested instruction

**Do:** **New experiment**.

- **Type:** **Intent** (which model best serves one intent), **Base Model**, **Classification** (the model that picks the intent) or **Profile vs Profile**. Use **Intent** on `financial_metric`.
- **Goal:** one sentence, such as "Decide whether shorter figure answers are rated higher", an objective (**Quality** with a target) and any guardrail metrics that must not get worse, such as latency.
- **Battle mode:** tick it and choose premium's **Challenger**.
- **Tested instruction for B Treatment:** `Keep every reply under 80 words.` Leave A blank.

**Notice:** a tested instruction is added after the persona on every turn of that side, so one sentence is tested without rewriting a persona. If B wins, promotion carries it to the live assistant.

### 2.3 Read the result

**Do:** open an experiment that has had traffic on both sides.

**Notice:**

- **Goal:** what it decides and what it compares.
- **Evidence so far:** conversations and battles, counted separately.
- **Current result:** for example "Waiting for both versions to record traffic", "No difference on quality yet" or "<side> leads on quality by N%".
- The results table, with "Tested per conversation: control N conversations (M exchanges), treatment ...".
- **Get recommendation:** **Promote treatment**, **Keep control**, **Keep running**, **Equivalent (no winner)** or **Inconclusive**, with why.

Three rules stand behind it:

1. **The unit is the conversation.** Turns in one conversation are not independent, so tests, intervals and minimum samples count conversations. "Underpowered" means it, and the console never hides that behind a percentage.
2. **Battle turns are left out by default.** In a battle the person chooses to see both sides, so its turns are not randomly assigned. People's picks are reported separately.
3. **Nothing promotes itself.** The recommendation is advisory and not auto-applied, and "No decision" is an allowed outcome.

When the interval for a difference includes zero, the difference is not yet a result.

## Act 3. Battle: the same experiment, head to head

### 3.1 Turn battle mode on

**Do:** in the chat client, as a premium user moderating a new conversation: **Show channel members**, then under **Battle Mode** choose the experiment and **Enable**.

**Notice:** the challenger joins as a real, named member with its own identity and session, answering through the same request engine as Advisor, and leaves when battle mode is turned off. A member who is not the moderator sees a briefing that names the decision being tested, not the models.

### 3.2 Run one battle

**Do:** send `/battle What was our net revenue retention last quarter, and what drove it?`

**Notice:**

- **Round 1:** both versions answer the same prompt at the same time, each labeled with its display name.
- **Round 2:** each replies briefly to the other. Round 2 is commentary; the deliverable is round 1.
- **The scorecard:** three axes side by side, never folded into one number: response time, estimated cost, and quality as a human pick (**A better**, **Tie** or **B better**). **Show steps** names the model behind each step.

**Do:** pick a side.

**Notice:** the pick is recorded on the server and credited to that version in the experiment's results, apart from the traffic metrics. A tie credits neither side.

### 3.3 The battle, back in the experiment

**Do:** **Experiments**, the experiment, **Battles**.

**Notice:** **Battles won**, **Quality per reply** (the judge's average, blank until scored) and **Est. cost per reply** for control and challenger, then each battle with **When**, **Classification**, **Outcome** and **Picked by** (a count of people, not names). Selecting a battle opens the console's conversation view at the `/battle` message that started it. There is no separate battles product: a battle is a result inside an experiment, and every row leads back to its conversation.

## Act 4. Trust the numbers, then keep the change

### 4.1 Is the classifier right? (optional)

**Do:** **Experiments**, **Classifier accuracy**.

**Notice:** a Classification experiment changes the model that picks the intent. The accuracy gate replays archived messages through both classifier models, off the request path and on the classification's own replay function, and queues only disagreements for a person to rule on.

### 4.2 Ground Truth: people label what the judge judged

**Do:** **Performance**, **Ground Truth**.

**Notice:** three panels:

1. **Waiting for a label:** judged answers nobody has labeled, with guardrail findings first, then answers the classifier was unsure of or a person flagged.
2. **How far each judge agrees with people:** a row per judge, rubric, assistant and judging model, with **Labels**, **Kappa**, **Caught**, **Passed** and **People agree**, plus how often the judge preferred the side people picked in battles.
3. **Golden set:** the entries a draft version is run against.

**Do:** **Label** a queued answer: score relevance (0 to 100, with a category and a reason), compliance (with the rules) and groundedness. Save.

**Notice:** the answer leaves the queue. Every judged number is only as good as the judge, so the judge is measured against people first. Kappa is agreement after removing what chance alone would give: 1 is perfect, 0 is chance. With nothing to compare, the panel shows nothing rather than a zero.

### 4.3 Keep the answers worth keeping

**Do:** nominate a passing answer to the golden set as **regression**, and a failed one as **capability**.

**Notice:** both entries appear in **Golden set** with their classification, assistant, intent, purpose and request, the request showing pseudonyms rather than names.

- **De-identified, not raw.** An entry is copied from the conversation's de-identified copy, and the nomination is refused if that copy does not exist yet, so the set holds no personal data.
- **Inside the boundary.** Entries belong to their classification, and row-level security lets a classification's reader see only its own.
- **Two purposes.** A regression entry must keep passing; a capability entry is something to learn, promoted to regression once a version passes it reliably.

### 4.4 The golden set gates a draft

A validated draft answers every regression entry three times beside the active version, posting nothing, and **Activate** is refused until that run passes. A failure the platform checks without a judge blocks activation; judged quality is reported as a paired difference with its interval and never blocks on its own. Scene 3.8 of the portable-assistants walkthrough shows the run.

### 4.5 Promote

**Do:** **Experiments**, the experiment, **Promote the treatment**, add a note, confirm.

**Notice:** "Advisor now serves version N, promoted from ...", and the experiment completes as **Promoted treatment**.

- **What is promoted is what was measured.** The candidate is copied into Advisor as a new version, and the copy is refused if it does not hash to the measured candidate's `configId`, or if Advisor has moved off the version the experiment was measured against. Create the experiment after any other edits to Advisor, or promote is refused.
- **Conversations already in the experiment** keep the version they were assigned.
- **The tested instruction** arrives as a field of the new version, labeled "Tested instruction (from an experiment)".
- **It is still a version**, so rollback applies.

**Do:** **Assistants**, `advisor`, **Behavioral** to see the tested instruction, then **Edit**, **Move into the persona**, **Save draft edits**. That makes it part of the persona and clears the field once the draft is activated.

## What is not built

- Replaying archived exchanges through a candidate model before it sees live traffic. **NOT BUILT**
- Verdicts attributed per assistant instance, and one row per instance on the platform-wide view: filter to an assistant that serves one classification. **NOT BUILT**
- Human labels for the document and tool-use judges, so they do not appear in calibration. **NOT BUILT**
