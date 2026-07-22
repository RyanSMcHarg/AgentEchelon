# DESIGN: Multi-Assistant Turn Engine

Status: Draft (design-target). Anchors the redesign of `/battle` into a general
multi-assistant turn-taking engine. Unifies the two "orchestrator" notions that
[DESIGN-MULTI-AGENT-ORCHESTRATION.md](DESIGN-MULTI-AGENT-ORCHESTRATION.md) (hierarchical
fan-out-collate) and [DESIGN-BATTLE.md](DESIGN-BATTLE.md) (peer round-scheduler) describe
separately, and generalizes battle so it becomes one preset of the engine.

## Problem and who it is for

A platform operator who wants assistants that can reply together, take turns, and hold
structured multi-party conversations has to choose between three unrelated entry points,
none of which composes: `@all` (broadcast, every bot answers once, no turns), `/battle`
(exactly two bots, two rounds, scored), and a design-only delegate tool (a parent spawning
ephemeral workers). All three converge on the same async processor, but nothing models them
as one thing. Battle is the only built peer turn-taker, and it is hardcoded to two
participants and two rounds, with its configuration resolved twice in two Lambdas, which is
a live source of silent divergence.

The goal: one engine that runs N named assistant participants through a policy-driven
sequence of turns, where battle, co-reply, round-robin discussion, and facilitated meetings
are configurations over it rather than separate features.

## Design direction

These constraints are authoritative and shape every phase below.

- **Battle is an engagement option on an A/B experiment, not a separate feature.** It is a
  flag on an experiment (as today), and the two sides are whatever variants that experiment
  already configures (model variants, profile variants, whatever the experiment defines).
  There is no battle-specific notion of a "combatant."
- **Battle runs the platform's normal request engine, not a separate path.** Each side answers
  a `/battle` prompt through the same flow as any normal message: real intent classification,
  real profile model resolution, real tools. Crucially, a side is resolved by the **same
  experiment-variant resolution the normal engine already uses** for a request that falls in an
  experiment; battle simply runs **all** the experiment's variants instead of hash-assigning
  one. Battle owns no parallel model, prompt, or modality resolution. The `/battle` prefix adds
  exactly three things on top: it makes every variant respond, it runs a rebuttal round, and it
  renders a scorecard.
- **The rebuttal is the point, and assistants are coached for it.** After the parallel first
  responses, each assistant responds to what the other produced; that reaction is what makes a
  battle engaging, so it is a core part of the format. Assistants are aware they are in battle
  mode (a light awareness note on the first turn, distinct from the old heavy adversarial
  constraints and length caps), and on the rebuttal turn they are explicitly prompted how to
  respond to the rival. Round-one content and length stay normal; only this awareness and
  rebuttal guidance are added.
- **Keep the parallel "race" first.** Round one is simultaneous (both answer at once), as
  today. Richer assistant-to-assistant coordination (true multi-turn back-and-forth,
  negotiation, N-party) is a later enhancement, not part of this pass.
- **Battle mode is scoped to the experiment's lifetime.** Battle stays on for as long as the
  owning experiment is running, unless the admin or experiment owner turns it off. It is a
  property of the experiment (`experiment.battleEnabled`), not a per-conversation toggle that
  has to be re-enabled each time.
- **Scorecard is inline and terminal.** The scoring interface appears inline at the end of
  each battle rather than remaining persistently visible.
- **Results are recorded as they are today** unless the refactor forces a change.

### Consequence: image generation must become a normal capability

Image generation today exists only inside the battle path (`invokeImageGenModel` is reached
solely from the generation-out branch, gated on `battleContext.imageGenModelId`); there is no
normal "a user asks an assistant for an image and receives one" flow. Honoring "use the
profile's actual intents and models, not some other path" therefore requires making image
generation a first-class profile capability and intent on the normal engine. Once an assistant
can generate images on any request, a battle of image prompts works with no battle-specific
image code, because both assistants simply run their normal flow. This is the true fix for the
image-battle failure that motivated this redesign.

## The abstraction

- **Ensemble session**: a run of the engine bound to one conversation. Fields:
  `sessionId`, `channelArn`, `participants[]`, `turnPolicy`, `terminationPolicy`, and the
  live transcript of completed turns.
- **Participant**: a first-class, named channel member. Fields: `participantId`, `botArn`,
  `role`, a resolved run target (`modelId` or `profileRef`), `displayName`, and declared
  `modalities`. There are N of them; nothing about the engine assumes two.
- **Turn**: one participant producing one response of one declared modality
  (`text | image | vision`), given a defined slice of the transcript it is allowed to see.
- **Turn policy**: a pure function that, given the transcript and per-participant states,
  returns the next set of turns to invoke, or `DONE`. This replaces battle's hardcoded
  `round === 1 ? ... : ...` branch.
- **Termination policy**: when the session ends (fixed phase count, consensus signal,
  facilitator decision, or all-participants-opt-out).

## Format presets (configuration over the engine)

| Preset | Participants | Turn policy | Cross-injection | Extras |
| --- | --- | --- | --- | --- |
| Co-reply (`@all`) | N | one parallel phase, all speak once | none | none |
| Battle | exactly 2 (precondition) | two ordered phases: answer, then rebuttal | each sees the rival's prior turn | adversarial constraints, scorecard |
| Discussion / round-robin | N | ordered turns, M rounds or until-consensus | each sees all prior turns | optional summary |
| Meeting | N + a facilitator role | facilitator-driven ordering over an agenda | policy-defined | agenda, minutes |

Battle stops being a feature and becomes the 2-participant, 2-phase, adversarial, scored
preset. Its distinctive parts (the `BATTLE_CONSTRAINTS_ROUND1/2` prompts, the `battlestats`
scorecard, the `NO_REBUTTAL` opt-out) are preset config, not engine mechanics.

## Battle delegates to the normal engine

Each side's turn is a normal request through the platform's single request engine (intent
classification, profile model resolution, tool loop). The side's configuration comes from the
experiment variant it is assigned, resolved by the **same** experiment-variant resolution the
normal engine already applies to any in-experiment request. The engine does not resolve models,
prompts, or modality on a battle-specific path. What the fan-out passes each worker is only the
coordination context it cannot derive itself: the shared `sessionId`, which variant it is, and
(for a rebuttal turn) the transcript slice it is reacting to. The worker then runs the ordinary
flow for that variant.

This removes the class of bug this redesign was triggered by: today the fan-out resolves the
image-model pair and display names while the worker independently re-resolves the battle
variant, so a resolution that succeeds on one side and falls through on the other (for
example, the fan-out Lambda missing the experiments-table grant) silently degrades to a text
turn with no signal. When there is only one resolution path (the normal one, in the worker),
there is nothing to diverge.

## Modality follows the profile, never the battle path

Because a turn is a normal request, its modality is whatever the assistant's profile and the
classified intent produce. An assistant whose profile grants image generation produces an
image when the intent calls for one, in a battle or not; an assistant without it does not.
There is no battle-specific image branch and no separate image-model registry wiring to
forget. This is why making image generation a first-class profile capability (see Design
direction above) is the enabling change rather than an add-on.

## Fail loud

If a session cannot fully resolve (no runnable participants, a participant missing a
required model or provider key, an unknown modality), the enable or start action rejects
with the specific reason, or the session posts an explicit "misconfigured: X" turn. The
engine never silently falls back to a degraded format.

## Data model (generalize what is built)

The engine keeps battle's proven mechanics and widens their keys:

- **SessionState** (generalizes `BattleState`): PK `sessionId`, SK `participantId`; per
  participant state `INVOKED -> {WAITING_FOR_USER ->} COMPLETED | FAILED`, all via
  conditional writes; plus a `__scheduler__` sentinel SK for exactly-once phase advance.
  Each row stores that participant's completed-turn output so later turns can be given it.
  TTL-based crash cleanup is retained.
- **ChannelSessionConfig** (generalizes `ChannelBattleConfig`): which formats are enabled on
  the channel, and the active-session pointer for continuation.
- **Participant pool** (generalizes the alt-bot slot pool): a bounded set of borrowable,
  persona-less acting identities, leased with a TTL conditional-write, sized for the largest
  supported ensemble rather than fixed at two.

## Scheduler (generalize the barrier and sentinel)

The round-1-to-round-2 handoff generalizes to a phase advancer: when every participant in
phase K reaches a terminal state (the existing `allBotsTerminal` barrier), the last writer
invokes the scheduler, which claims the `__scheduler__` sentinel exactly once (the existing
`tryClaimOrchestratorFire` idiom), asks the turn policy for phase K+1, and either fans out
the next turns or terminates. Battle is two phases; co-reply is one; discussion is M; a
meeting is policy-driven. No component hardcodes a phase count.

## What the redesign removes

- `rivalBotArn` (singular) becomes "the transcript slice this turn sees" (a list).
- `variants[0]` control / `variants[1]` treatment becomes `participants[]` with roles.
- `totalRounds: 2` (a literal type today) becomes a policy-driven phase index.
- The `botMembers.length < 2` collapse to `@all` becomes the general N case, where co-reply
  is the N-participant preset and battle asserts exactly two as a preset precondition.

## Open questions to resolve during build

- **Pool sizing and contention.** A shared participant pool means battle, discussion, and any
  future delegation compete for the same identities. Size, and who wins under contention,
  is unresolved (both source docs flag it).
- **Vended vs pooled identity.** Pooled alt-slot identities and credential-exchange-vended
  identities are two stories for the same participant; the engine needs one, or a clear rule
  for when each applies.
- **Peer vs hierarchical.** This engine models peer turn-taking (the built battle topology,
  Strands "swarm"). The hierarchical delegate-and-collate topology is expressible as a turn
  policy but is out of scope for the first build.
- **Wait model.** The barrier is write-then-read today; whether the scheduler polls or is
  callback-driven at larger N is open.

## Phasing (battle keeps working throughout)

1. **Route battle through the normal engine.** Replace battle's own model, prompt, and
   modality resolution so each round-one turn is an ordinary request for that assistant (real
   intent, real profile model, real tools), fanned out to both. The rebuttal round is the same
   ordinary request with the rival's prior turn injected as the thing to respond to. Keep the
   parallel race and the results recording as they are. Render the scorecard inline at the end.
   The battle-specific `BATTLE_CONSTRAINTS_ROUND1/2` and the double variant resolution go away.
   (Open detail: whether the two combatants are two variants of one profile or two distinct
   assistant profiles is a configuration choice the engine supports either way.)
2. **Image generation as a normal capability.** Make image generation a first-class profile
   capability and intent on the normal engine, so any suitably configured assistant can produce
   an image on a normal request. Battle image prompts then work with no battle-specific image
   code. This is the true fix for the motivating image-battle failure; it can proceed in
   parallel with phase 1 and is a prerequisite for image battles under the new model.
3. **Extract the scheduler.** Reimplement battle's round handoff as the generic phase advancer
   over `SessionState` (generalized `BattleState`). Behavior-preserving.
4. **First new presets.** Add co-reply (fold `@all` in) and round-robin discussion (N
   participants, ordered turns each seeing prior turns). The first true reply-together and
   take-turns beyond battle, and the substrate for later assistant-to-assistant coordination.
5. **Generalize identity and the turn policy.** Grow the participant pool past two and add the
   turn-policy interface. Enables the meeting preset and richer coordination formats.
6. **Retire duplicated paths.** Once presets cover them, remove the standalone `@all` bypass
   and the battle-specific resolvers.

## Roadmap (beyond this pass)

- **Guide users toward the experiment's goal intents.** An experiment exists to test something
  specific (report quality, a routing change, a persona). Prompt the user, when battle mode is
  on, about the kinds of intents worth trying so the battle actually exercises what the
  experiment is measuring, rather than leaving them to guess.
- **Assistant-to-assistant coordination.** Move past the parallel race plus single rebuttal to
  true multi-turn exchange (assistants reacting across more than one round, negotiating, or
  handing off), which the turn-policy interface (phase 5) is designed to express.
