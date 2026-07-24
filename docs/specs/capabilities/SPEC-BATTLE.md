# SPEC: Battle Mode (`/battle`) - Product Specification

**Status:** Implemented (premium-gated) **Layer:** Core platform (capability - a platform feature, not an interaction pillar; its MECHANISM lives here, its variant CONFIG is assistant-config, pillar 2) **Plane:** core **Technical design:** [DESIGN-BATTLE.md](./DESIGN-BATTLE.md)

## 1. Overview

Battle Mode lets a user pit two assistants against each other on the same prompt in one conversation, unifying the head-to-head comparison with the existing probabilistic A/B experiment as a single feature.

## 2. Business Problem

A team choosing which model or persona should serve a class of requests usually does it blind. A deployer picks a default model from a catalog, ships it, and only later infers from aggregate metrics whether it was the right call - short of standing up its own side-by-side evaluation harness. Two problems make that inference slow and unsatisfying:

- **A/B testing is probabilistic per conversation.** The existing experiment framework assigns each conversation one variant deterministically and keeps it for the life of that conversation. That is the correct design for measuring real traffic at scale, but it means no single person ever sees both variants answer the *same* prompt. The comparison is statistical, deferred, and invisible to the people forming an opinion.
- **Picking a model or persona blind is unconvincing.** An AI developer who wants to ship "Opus over Sonnet for code review," or a stakeholder who wants to feel the difference between two personas, has no fast, tangible way to do a controlled side-by-side. Aggregate dashboards do not settle a room; a visible head-to-head on a prompt everyone cares about does.

Battle Mode closes that gap. It puts both variants of an experiment into one conversation as real, named participants, runs them on the same prompt, and surfaces a scorecard the human reads and decides on directly. It turns a slow, probabilistic measurement into a fast, hands-on decision experience while still feeding the same per-variant results the A/B experiment already collects.

Why it matters: the same experiment now serves two jobs. It measures broad traffic slowly (A/B), and it produces direct human feedback and a real-time, tangible decision experience quickly (battle). Neither auto-routes traffic; both inform a deliberate promotion decision.

## 3. Personas

Personas are defined once in [`../../overview/PERSONAS.md`](../../overview/PERSONAS.md); this spec only notes what each wants from Battle Mode. "Channel moderator" is not a persona but a per-conversation role/capability (a ChannelModerator) that any member can hold; it appears as an actor in the use cases below, not in this list.

**End user (chat participant).** Works inside a conversation. Wants to ask one question and see two assistants answer it side by side, then say which answer was better without reading a dashboard. Needs a one-command trigger (`/battle <prompt>`), a readable side-by-side result, and a single pick control.

**AI developer.** Compares models and personas to decide what to ship. Wants to run two candidate models (or two persona addenda on the same model) on representative prompts, read cost and latency objectively, and form a quality judgment from real output rather than a leaderboard. Needs the comparison to feed the same per-variant experiment results so a battle pick counts toward the same decision as probabilistic traffic.

**Admin / operator (deployer).** Runs a single AgentEchelon deployment. Authors the experiment and its variants, arms it for battle, and reads accumulated results across conversations. Needs to bind a variant to a battle seat, see a per-step breakdown (which model ran each step, how long, at what estimated cost), and see picks credited per variant, all without any result silently changing routing.

**QA / test engineer.** Validates assistant quality across scenarios before a release. Uses a battle as a controlled, repeatable side-by-side test: runs the same representative prompts through two candidate variants and reads the objective cost/latency plus the human quality pick as a release-gating comparison, distinct from routing live traffic.

## 4. Use Cases

- **As an end user**, I type `/battle What is the best caching strategy for a read-heavy database?` in a battle-enabled channel and get two answers, from "Atlas" and "Echo", side by side. I read both, tap **B better**, and my pick is recorded. I did not have to open any admin tooling.

- **As an end user**, after both answers land I see a compact scorecard: each side's response time, an estimated cost, and a pick-the-winner control. I expand "Show steps" to see which model produced each answer. Moments later a divider marks round 2 and each assistant either rebuts, builds on, or stays silent about the other's answer.

- **As an AI developer**, I arm an experiment (`control = Sonnet`, `treatment = Opus`) for battle, give each side a display name and an optional short persona addendum, and run several representative code-review prompts as battles. I read the objective cost and latency per side and make the quality call myself. My picks accumulate as a "Battle wins" signal per variant in the same experiment results table as probabilistic traffic.

- **As an AI developer**, I run two personas (same model, different addenda) on one prompt to compare voice and framing, not raw capability, before committing a persona to production.

- **As an admin/operator**, I open the Experiments results and read the two variants together: exchanges, average score, latency, tokens, compliance, fallbacks, user approval, and battle wins. I promote the winner by hand through the model-strategy config; nothing was auto-promoted.

- **As a channel moderator**, I open the members panel of a premium conversation, pick an armed experiment, and turn on Battle Mode. The treatment assistant joins as a visible member with its display name, a system message announces it, and `/battle` becomes available. When I am done I turn it off and the assistant leaves cleanly.
- **As the assistant (a battle participant)**, I answer round 1 to the shared prompt, then see my rival's reply and choose to rebut, agree with, or ignore it in round 2, aware that I am in a battle, so that the comparison is a genuine head-to-head rather than two isolated answers.

## 5. Functional Requirements and Acceptance Criteria

**FR1 - Arm an experiment for battle.** An admin can mark a two-variant experiment as battle-eligible, giving each variant a display name (what users see) and an optional short system-prompt addendum (a style or persona layer, not a capability change), and bind the treatment variant to a pre-provisioned battle seat. *Done when:* an experiment with exactly two variants, a display name on each, and a bound seat can be saved as battle-enabled; an experiment missing any of those is rejected with an actionable message; a seat already bound to another active battle experiment is rejected.

**FR2 - Enable battle on a channel.** A moderator of a premium channel can turn Battle Mode on, choosing an armed experiment that matches the channel; the treatment variant joins as a real conversation member and a system message announces it. Turning it off removes the member and announces the departure. *Done when:* enabling adds a visible second assistant and makes `/battle` available; disabling removes it; a non-premium channel cannot enable battle.

**FR3 - Run a battle (round 1, parallel).** A user typing `/battle <prompt>` in a battle-enabled channel gets every assistant in the channel answering the same prompt in parallel. Each assistant knows it is in a battle, so its first reply is not generic and it does not treat the prompt as off-topic or propose starting a new conversation. *Done when:* one `/battle` produces one round-1 reply per assistant, each labeled with its display name, on the same prompt.

**FR4 - Rebut, agree, or stay silent (round 2).** After every side has fully completed round 1, each assistant receives the other's answer and may rebut, build on it, or decline to add anything. Round 2 is commentary; the deliverable is round 1. Round 2 only fires once both sides have *completed the intent* (a report or document battle finishes the deliverable first), not merely posted a first message. *Done when:* round 2 begins only after both sides complete; an assistant that declines leaves no leftover placeholder; both declining is a valid outcome.

**FR5 - Not-enabled is a visible, explained no-op.** `/battle` in a channel without Battle Mode replies to the sender with a one-line hint ("Battle Mode is not enabled here; ask a moderator to turn it on") and broadcasts nothing. *Done when:* the sender sees the hint, no assistant answers, and there is no error and no fallback broadcast.

**FR6 - Three-axis scorecard, no composite.** After both round-1 replies land, the user sees a scorecard with three independent axes shown side by side and never folded into one number: response time, estimated cost, and quality (an explicit human pick: A better, tie, or B better). Cost is labeled an estimate, not a bill. A "Show steps" expander reveals which model ran each step and how long it took. *Done when:* the three axes render separately; the pick records a per-battle outcome; re-picking overwrites; cost carries a "not a bill" caveat.

**FR7 - Per-battle result and per-variant credit.** Each battle ends with its own inline result card for that prompt (each side's response time and estimated cost, and which side the user picked); the next `/battle` gets a fresh card, so the conversation reads as a sequence of independent battle results rather than one running total. In Aurora mode each pick is credited per variant as a "Battle wins" column in the same experiment results as probabilistic traffic. *Done when:* each battle shows its own result card at its end; each pick maps A->control, B->treatment, tie->both, and surfaces in per-variant results.

**FR8 - Unify with A/B, never auto-route.** A battle is the same experiment's two variants compared head-to-head instead of split probabilistically. Battle results are descriptive: a leading variant produces a recommendation, and promotion stays a deliberate manual config change. *Done when:* no battle outcome changes routing on its own; promotion requires an explicit operator action.

**FR9 - Battle types escalate.** Deployments can run, in increasing capability: single-turn, report creation, document creation (downloadable attachment), image understanding (vision in), and image generation (generation out). The scorecard and pick-the-winner appear from the first battle onward. *Done when:* each enabled type produces a round-1/round-2 flow with a scorecard; image generation runs only where the extra deploy-time setup is present.

## 6. Non-Goals / Out of Scope

- **Algorithmic judging.** No third-model judge, and no signal that feeds back into automated variant or model selection. Human pick-the-winner and objective time/cost telemetry are first-class; an automated control loop is not.
- **Arbitrary persona authoring by end users.** End users only enable, disable, and run battles. Variants and their personas are authored by admins.
- **More than two variants per battle.** A battle compares exactly two.
- **Cross-classification battles.** Both variants must be allowed at the channel's classification.
- **Free-form "pick any two models" battles.** A battle always runs an armed experiment; the experiment is the authoring surface.
- **Streaming.** Both rounds use the placeholder-then-update pattern.
- **Automatic or one-click promotion** of a winning variant.

## 7. Open Product Questions

- Should the end-of-battle summary retain the verbatim clarifying-question Q&A text, not just the quantitative "how often did each side ask" metric? (Currently the metric is captured, the verbatim text is not.)
- For report and document battles, is one-shot (full deliverable in round 1) or outline-first the better default for comparing directions?
- Which image-generation model should ship as the baseline for generation-out battles, and what default image-output guardrail is reasonable before a deployer tunes it?

## 8. Related Specs

- Technical design: [DESIGN-BATTLE.md](./DESIGN-BATTLE.md)
- Operator guide: `docs/guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md`
- Drift interaction: `docs/specs/capabilities/SPEC-DRIFT-CONVERGENCE.md`
- Image providers: `docs/guides/admin/IMAGE-GEN-PROVIDERS.md`
- Per-step metadata: `docs/specs/interaction/conversation/SPEC-MESSAGE-METADATA-CODEBOOK.md`
