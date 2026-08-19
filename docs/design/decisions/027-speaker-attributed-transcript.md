---
title: "ADR-027: A conversation transcript carries who said it and whether they are a person"
status: Accepted (parts 1-4 built 2026-08-17; part 5, the renderer seam, deliberately deferred)
date: 2026-08-11
related:
  - "./023-battle-round-coordination.md"
  - "./026-task-shaped-battle-rounds.md"
  - "../../specs/capabilities/DESIGN-MULTI-ASSISTANT-TURN-ENGINE.md"
  - "../../specs/capabilities/DESIGN-BATTLE.md"
  - "../../specs/interaction/identity-access/core/SPEC-CONVERSATION-SECURITY.md"
  - "../../../backend/lambda/src/lib/async-processor-core.ts"
  - "../../../backend/lambda/src/channel-battle.ts"
---

# ADR-027: A conversation transcript carries who said it and whether they are a person

## Status

**Accepted. Parts 1 to 4 are BUILT; part 5 (the renderer seam) is not.**

**Verified by:** `backend/test/lib/transcript-attribution.test.ts` (20: the merge keeps the boundary
between different speakers and relabels the first contribution; a peer assistant is distinguishable
from a person inside one merged turn; a forged label never survives, including one written by an
assistant and including when nothing else is being labelled; a mid-sentence bracket is left alone; the
emitted label is what the stripper recognises; and a 1:1 transcript is byte-identical to the old
behaviour), `backend/test/lib/channel-history-context.test.ts` (17: history carries the speaker it
used to discard, with the placeholder and current-message filtering unchanged), and
`backend/test/lib/guardrail-scores-the-user-turn.test.ts` (4, part 4, shipped earlier as `c8f6c23`).

**Where it lives:** `backend/lambda/src/lib/transcript-attribution.ts` holds the one definition of the
label, the sanitiser, and the "is there anything to disambiguate" test; `loadChannelHistory` stops
discarding the sender; `consolidateConsecutiveMessages` applies attribution at the merge; the current
turn carries its own speaker; and `transcriptConventionDirective` tells the model what the labels mean,
in the dynamic suffix so the cacheable persona prefix does not move.

**What ATTRIBUTION COSTS is bounded deliberately.** Labels appear only where they disambiguate - a
transcript with more than one distinct non-self speaker, or a merge across different speakers. A 1:1
conversation is unchanged, byte for byte, which is both the cost control and the reason this was safe
to ship on every conversation rather than behind a flag.

**Part 5 is NOT built and is not the next increment.** A renderer is indistinguishable from no renderer
while there is one surface; it becomes worth building when a second wire format arrives. The merge rule
lives in one function today, which is the property part 5 exists to protect.

**Sequencing (owner, 2026-08-11): design first.** The narrow alternative, scoring the turn's own user
message and changing nothing else, was deliberately NOT taken as an interim patch; it is retained as
the shape decision 4 takes. The consequence accepted with that choice: until parts 1 to 4 shipped, a
duel in a channel carrying a platform notice continued to block the side that did not author it, and
the measurement it produced was unusable. That window has closed: the defect is fixed by part 4 (the
guardrail scores the person's own turn), pinned by `guardrail-scores-the-user-turn.test.ts`.

## Problem and who it's for

A person working in a shared conversation with colleagues and one or more assistants expects the
assistant to know who is speaking. They expect "as Priya asked earlier" to resolve to Priya, a
follow-up question to be answered for the person who asked it, and a second assistant in the room to
be understood as another participant rather than as the user giving instructions.

The transcript an assistant reasons over collapses every participant who is not itself into a single
undifferentiated speaker. Two colleagues and a peer assistant are indistinguishable, and their words
are concatenated into one block. The assistant answers as though one voice said all of it.

This is the shared-conversation promise the platform is built on: assistants are participants in a
channel with people, not a private one-to-one chat.

## What the transcript did before this change

This section records the state at decision time; parts 1 to 4 have since replaced it (see Status).

`loadChannelHistory` reads the channel and resolves the SENDER of every message. It computes both
whether the sender is a bot (`async-processor-core.ts:678`) and whether the sender is this assistant
itself, then keeps neither: the push at `:703` stores `role`, `content` and `images` only, with
`role: isSelfBot ? 'assistant' : 'user'` at `:704`.

`consolidateConsecutiveMessages` (`:922`) then merges consecutive same-role messages with a blank
line between them. Because every non-self participant is `user`, one merged turn can hold a message
from one colleague, a message from another, and a message from a peer assistant, with nothing marking
where one ends and the next begins.

**The merge is required, not incidental.** The Converse API requires alternating user and assistant
roles (the reason recorded at `:920`), so consecutive same-role messages have to be combined. Any fix
that preserves attribution has to do so INSIDE a merged turn rather than by refusing to merge.

**Checked against the provider surfaces, because "the API forces it" deserves verification:**

| Surface | Consecutive same-role turns | Per-message speaker field |
|---|---|---|
| Converse (what the assistant calls today) | rejected; roles must alternate | none |
| The Anthropic Messages API | allowed, and merged into one turn by the service | none |
| The Messages-API endpoint on Amazon Bedrock | allowed, same merge | none |

**No surface offers a per-message speaker field**, and the two that accept consecutive same-role
messages merge them anyway, server-side. So in-band attribution is not a workaround for one API's
rule: it is the only mechanism any of them offers, and this decision holds whichever is used. Only
the LOCATION of the merge changes.

**There is a purpose-built channel for platform notices, and it is out of reach on two axes.** The
Messages API accepts a system-role message positioned mid-conversation, documented as the operator
channel that content inside a user turn cannot impersonate. That is exactly the right home for a
notice like the battle announcement. It is unavailable here twice over: not offered on Amazon
Bedrock, and gated to model generations later than the ones these classifications run. It is
recorded because it is what part 2 below stands in for, and because it becomes available if the
deployment ever moves to that endpoint and those models.

**Three sites assemble a transcript, and a fix applied to one of them is not a fix.** History is
loaded at `:2166`, consolidated for the model at `:2205`, and consolidated again when the current
turn is appended at `:2218`. All three are named here so the change cannot land at one and be missed
at the others.

Three consequences follow, in increasing severity.

**1. Identity is unavailable to the model.** Nothing in the prompt says who spoke, so an assistant
cannot address the right person, cannot attribute a request, and cannot tell that the current turn
comes from a different participant than the previous one.

**2. Person and assistant are indistinguishable.** `isBot` is computed and discarded, so a peer
assistant's reply reaches the model in the same shape as a human instruction.

**3. The input guardrail scores whatever lands last, and it is not always a person.** The guardrail
takes `latestUserText` (`:1569`), the last user-role message. **Measured live 2026-08-11** against
the deployed premium guardrail, with `ApplyGuardrail` called directly:

| Text submitted | Result |
|---|---|
| The user's actual prompt, with and without a `/battle` prefix | `NONE` |
| A rival's placeholder including its `<!--corr:-->` marker | `NONE` |
| A `<!--corr:-->` marker alone | `NONE` |
| `Battle Mode is now ON. Two assistants will answer the same prompt so you can compare them.` (`channel-battle.ts:312`) | `GUARDRAIL_INTERVENED` / `PROMPT_ATTACK` |
| `Battle Mode is now ON. <name> has joined the channel. Try /battle ...` (`channel-battle.ts:491`) | `GUARDRAIL_INTERVENED` / `PROMPT_ATTACK` |
| The same sentence with the "Battle Mode" framing removed | `GUARDRAIL_INTERVENED` / `PROMPT_ATTACK` |

The announcement is written by one assistant. To that assistant it is its own output; to its rival it
arrives as a user-role message that instructs a model how to behave, and it is scored as an attack.
The rival is blocked before its model is called, deterministically, in every duel in that channel.
**Rewording is not a fix**: the last row above is the neutral rewording, and it still fires.

**Why the tests are green through all of this.** A blocked side still posts an attributed reply, the
guardrail's block message, so a duel with a dead side is shaped exactly like a healthy one: two
replies, both archived, a scorecard, a countable human pick. The experiment records a loss against a
model that never ran.

## Decision

A transcript entry carries its speaker. Four parts.

**1. History preserves identity.** Each entry keeps a stable participant identity, a participant KIND
(`person`, `assistant`, or `system`), and whether the speaker is this assistant. The sender is
already resolved at `:678`; this stops discarding it.

**2. Attribution is applied in-band, at the merge.** Because Converse roles are two-valued and
merging is mandatory, each contribution inside a merged turn is labelled with its speaker and kind.
The label is what carries "who said it" into the model's context, and it preserves the turn boundary
the merge would otherwise dissolve.

**3. Attribution is sanitised before it is applied, on EVERY participant's content.** An in-band
label is forgeable, so content is stripped of attribution-shaped prefixes before the real label is
added. This applies to every contribution and not only to text a person typed: a compromised or
hostile assistant in the channel can forge a label exactly as a user can, and an assistant's output
is the less scrutinised of the two. This is the same defence the control markers already get, and it
is a security control rather than formatting.

**4. The guardrail scores what a person submitted.** The input guardrail exists to score the
incoming human turn for prompt injection and content violations, and it scores that turn rather than
whichever message happens to sit last in the transcript. Text authored by a peer assistant or by the
platform is labelled context, not an instruction addressed to the model.

**The residual risk part 4 accepts, stated plainly.** Today the input filter scores whichever
message lands last, which means it sometimes scores a peer assistant's text by accident. After this
change it never does. That is a REDUCTION in input-side coverage of peer content, accepted for two
reasons: the coverage was incidental rather than designed, and it is not free (it is what blocks a
side of every duel today). What remains: the output guardrail runs unchanged on this assistant's own
reply, and part 3 stops a peer forging an instruction that reads as a person's. What is NOT covered:
a peer assistant emitting genuinely hostile content is no longer input-filtered, so a deployment
that treats peer assistants as untrusted needs an explicit scoring pass for participant-authored
context. That pass is out of scope here and is named so it is not assumed.

**5. History assembly produces a provider-independent transcript; a renderer adapts it.** Parts 1 to
3 describe a structure, not a wire format. Assembly yields entries carrying speaker identity and
kind; a renderer converts that structure to the shape the target surface accepts, applying the merge
where the surface requires one and the labels wherever the merge would otherwise erase a boundary.
The merge rule then has one home instead of being spread across the three assembly sites, and adding
a surface is a renderer rather than a redesign. See the alternatives section for why this reading of
"build it ourselves" is the one that survives.

Part 4 is a consequence of parts 1 to 3, not a special case for battles: once the transcript knows
which entries a person wrote, "score the person's turn" is expressible.

**The security consequence of having no operator channel, stated plainly.** Until a system-role
message is available (see above), a platform notice and a sentence a user typed are the same kind of
object to the model. The guardrail intervention is one symptom; the other is that a user can type
text shaped like a platform notice and have it read with the platform's authority. Part 3's
sanitisation is what stands between those two cases, which is why it is a security control and not
formatting.

**Label shape is left to implementation.** An illustrative, NON-NORMATIVE example of what a merged
user turn might carry, to make the decision concrete rather than to fix a format:

```
[Priya, person] Can you draft the migration plan?
[Sam, person] Include the rollback step.
[Atlas, assistant] Here is a first outline: ...
```

## Consequences

**Prompt cost rises.** Every attributed contribution carries a label. In a busy channel this is real
token spend, and it is the price of the model knowing who it is talking to.

**The cacheable system prefix must not move.** Attribution belongs to the message content, so the
stable system prefix that prompt caching depends on stays intact. A change that pushed attribution
into the system prompt would invalidate the cache on every turn.

**The label format becomes an interface.** Once the model is told a format, personas and evaluations
depend on it. It needs one definition, used by every path that builds a transcript.

**Images stay on user turns.** Converse permits image blocks only on user turns, and the current
perspective-based roles are what make a peer assistant's image render at all. Attribution changes
what a turn SAYS about its speakers, not which role the turn takes, so this behaviour is preserved.

**Assistants remain first-class peers.** A peer's message stays in the user role and stays visible to
the model. The change is that it arrives labelled as an assistant's contribution instead of
impersonating the user.

**No data migration.** History is re-read from Amazon Chime SDK Messaging on every turn and is never
stored in an assistant-owned transcript table, so this changes assembly only. Nothing is backfilled
and no stored conversation is rewritten.

**A model may echo the labels.** Told that turns look like `[Name, person]`, a model can copy that
shape into its own reply, which reaches the user as noise. Personas need an explicit instruction that
attribution is context to read and never a format to reproduce, and it needs a test rather than
trust.

**Every classification is affected, and this is not tier-gated.** Any channel can hold more than one
person, so basic, standard and premium all assemble transcripts the same way. Battle is the first
feature that puts two ASSISTANTS in a channel, which is why it surfaced there first.

**Cost and usage analytics shift.** Labels add input tokens, so `model_usage` input counts and the
cost figures derived from them step up when this ships. A comparison across the change reads as a
cost regression unless it is known to be this.

**Participant names reach the model provider.** Attribution puts display identities into prompt
content sent to Bedrock, where before only message bodies went. Deployments with data processing
commitments covering who appears in a prompt need that reviewed, and a deployment that cannot send
names needs a pseudonymous stable label (`Participant 2`) rather than the change being skipped,
since the ordering and turn boundaries are what the model needs most.

**Tests owed before any `Verified by:` line - satisfied by the suites named in Status**
(`transcript-attribution.test.ts`, `channel-history-context.test.ts`,
`guardrail-scores-the-user-turn.test.ts`), except the final renderer-ratchet item, which is deferred
with part 5:
- Two people speaking consecutively survive consolidation as two attributed contributions.
- A peer assistant's message is labelled as an assistant and is not scored as user input.
- A user who types a forged attribution label does not impersonate another participant, and neither
  does an assistant that emits one.
- Attribution holds at BOTH consolidation sites (`:2205` and `:2218`), not only the first.
- Image attachments still survive a merged turn, which consolidation preserves today.
- The cacheable system prefix is unchanged by attribution.
- A battle side's reply is an ANSWER and not the guardrail block message. This single assertion is
  what would have made the defect above loud instead of invisible.
- The merge rule appears only in the renderer. The repository already enforces this class of
  constraint with a symbol ratchet; the same mechanism keeps assembly from re-acquiring it.

## Sequencing

Three phases. The first is deliberately small, because a duel that reports a loss for a model that
never ran is producing bad data every time it runs, and the full design is not a same-day change.

**Phase 1, stop the bad data.** Score the input guardrail on the turn's own user message rather than
on the last user-role entry, matching what the external-provider path already does. Add the
assertion that a duel side's reply is an answer. This is the narrow alternative listed below, taken
as a first step rather than as the answer: it stops blocked sides and makes a blocked side loud,
and it does not restore identity.

**Phase 2, attribution.** Parts 1 to 3: preserve speaker identity and kind through assembly, label
contributions at the merge, sanitise before labelling. This is what makes the assistant able to
address the right person and to tell a person from an assistant, and it is what the multi-participant
conversations the platform is built for require.

**Phase 3, the renderer seam.** Part 5. Worth doing when a second provider surface, a second wire
format, or the operator channel above comes into scope; premature before then, since a single
renderer is indistinguishable from no renderer.

Phase 1 does not need phases 2 and 3 to ship, and it does not block them. Phase 2 subsumes phase 1's
guardrail change rather than reworking it: the phase 1 fix is the shape part 4 takes.

## Alternatives rejected

**Score the turn's own user message and change nothing else.** This is the smallest fix and it does
stop the blocking, matching what the external provider path already does. Rejected as the whole
answer because it treats the symptom: the transcript stays identity-blind, so the assistant still
cannot tell two people apart or address the right one. Worth keeping as the shape part 4 takes.

**Exclude platform notices from the transcript.** Removes this instance and denoises the context, but
a peer assistant's ORDINARY reply can trip the same filter, and it does nothing for identity.

**Stop mapping peer assistants to the user role.** Contradicts the deliberate perspective-based
design, breaks the alternating-role requirement, and stops a peer's images rendering.

**Extend the round-2 `skipInputGuardrail` to any bot-authored latest turn.** Mechanically the
smallest change, and rejected on security grounds: it disables prompt-injection filtering on exactly
the path where a hostile message from another participant would arrive.

**Reword the announcement.** Disproven by measurement, see the table above.

**Build the inference layer instead of calling one.** Serving a model directly, or calling any
provider that exposes the raw prompt template, would allow arbitrary speaker roles instead of two.
Rejected, and the reason is not only cost:

- **It does not remove the constraint it is meant to remove.** Chat models are trained against
  two-role templates. Roles invented in a custom template carry no training signal, so the speakers
  are still distinguished by text the model has to interpret. That is in-band attribution with
  different delimiters, which is what parts 2 and 3 already describe.
- **The security model is built on the provider's primitives.** The input and output guardrails, the
  model-invocation grant scoped to catalog ARNs, and the classification boundary all come from the
  platform being called. Replacing it means rebuilding those first, and the guardrail is the control
  this ADR is trying to make behave correctly rather than remove.

**Build a custom TRANSCRIPT representation, and render it per provider. ACCEPTED as the shape of
parts 1 and 2**, recorded here because it is the reading of "custom built" that survives. History
assembly produces a provider-independent structure carrying speaker identity and kind; a renderer
converts that to whatever the target surface accepts, including the merge where the surface requires
one. The cost is one abstraction boundary. What it buys:

- The merge rule stops being scattered through history assembly and becomes one renderer's business.
- Attribution is decided once, not per provider.
- Provider independence becomes real rather than asserted: a second surface is a second renderer,
  and the operator-channel option above is a renderer change rather than a redesign.

This is the difference between owning the transcript and owning the inference stack. The first is a
module; the second is a platform.
