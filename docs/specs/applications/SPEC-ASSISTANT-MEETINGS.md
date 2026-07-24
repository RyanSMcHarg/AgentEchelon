# SPEC-ASSISTANT: Meetings assistant

**Status:** Draft / planning - the design is not finalized and nothing is built.

**Layer:** Built on the platform (application)

**Summary:** An assistant that helps a person run a meeting end to end - schedule it, invite the attendees, greet and onboard each one as they arrive, take notes while it runs, and send the follow-ups afterward.

**Technical design:** [`DESIGN-ASSISTANT-MEETINGS.md`](DESIGN-ASSISTANT-MEETINGS.md)

**Personas:** see `overview/PERSONAS.md`

> This is a worked exemplar of the per-assistant PRODUCT pattern (`templates/SPEC-ASSISTANT-TEMPLATE.md`). The meetings assistant is composed ON TOP of AgentEchelon: it is a set of domain intents plus the tools those intents need, running on the platform's Converse tool loop, identity, classification, and guardrails. It adds no orchestration code of its own; where it spins up one sub-agent per attendee it USES the platform multi-agent primitive (see the design doc, Part B.3).

## 1. Purpose

Running a meeting is a chain of small, forgettable chores that bracket the actual conversation. Someone has to find a time that works, create the invite, chase the right attendees, make sure each person knows why they were pulled in, capture what was decided, and then send the action items so the meeting does not evaporate the moment it ends. Each chore is minor; together they are why meetings start late, drift, and leave no trace.

The meetings assistant owns that bracket so the humans can spend the meeting on the meeting. It schedules against real availability, invites the attendees the organizer names, greets and orients each attendee individually as they join, keeps a running set of notes and decisions, and turns those into follow-ups it sends to the people responsible.

It matters because the failure mode is silent. A meeting with no notes and no follow-up looks fine in the moment and produces nothing a week later. Automating the bracket makes the meeting's output durable without asking anyone to be the scribe.

The assistant does ONE job - help run a meeting. It does not manage a project, own a calendar as a system of record, or replace the human chair. It is the staff work around a meeting, not the meeting.

## 2. Who it serves

| Persona | What this assistant does for them |
|---|---|
| End user (organizer) | Schedules, invites, and follows up without leaving the conversation; gets notes and action items without being the scribe. |
| End user (attendee) | Gets a personal greeting and a one-line "here is why you are here" when they join, so they arrive oriented. |
| Manager | Monitors a recurring team meeting: sees the notes and the follow-ups their team owns, scoped to their use-case channels. |
| The assistant (actor) | Greets and onboards each attendee on its own identity, captures notes as the meeting runs, and sends follow-ups after it ends. |

The meetings assistant is an internal-facing assistant, so its ceiling is a **classification** (not a customer-facing rung). It serves the classification of the channel it runs in and reads only context at or below that classification.

## 3. Intents it handles

The universal `greeting`, `acknowledgment`, and `general` intents are always present from the platform and are not listed here. These are the meetings assistant's domain intents:

| Intent key | The user is asking to... | Delivery shape |
|---|---|---|
| `schedule_meeting` | find a time and set up a new meeting | TASK_MULTI_STEP |
| `lookup_meeting` | find an existing meeting, its agenda, time, or attendees | PLACEHOLDER_UPDATE |
| `invite_attendee` | add one or more people to a meeting | PLACEHOLDER_UPDATE |
| `onboard_attendee` | greet and orient each attendee as they join | TASK_MULTI_STEP |
| `take_notes` | capture a note, decision, or action item during the meeting | PLACEHOLDER_UPDATE |
| `follow_up` | send the notes and action items to the attendees afterward | TASK_MULTI_STEP |

## 4. Use cases

1. **Schedule from a request** - As an organizer, I say "set up a 30-minute design review with Priya and Sam next week" and the assistant checks availability, proposes two or three times, and creates the meeting once I pick one, so I never open a calendar.
2. **Look up before I ask** - As an attendee, I ask "when is the design review and what is on the agenda?" and the assistant answers from the meeting record, so I do not dig through invites.
3. **Invite the right people** - As an organizer, I say "add Priya's manager" and the assistant proposes the invite for me to confirm before anyone is added, so a wrong add never happens silently.
4. **Greet each attendee as they arrive** - As the assistant, when each attendee joins I greet them by name and give them a one-line "you are here to review the new onboarding flow" briefing, so everyone arrives oriented instead of asking "why am I in this?".
5. **Onboard many attendees at once** - As the assistant, for a large meeting I spin up one greeter per attendee in parallel (invite, join, greet) using the platform's multi-agent orchestration, so a ten-person meeting is onboarded as fast as a two-person one, and I do not re-implement fan-out.
6. **Take notes as it runs** - As the assistant, when the organizer says "note that we are shipping the new flow behind a flag" I capture it as a decision on the meeting record, so the note is durable and attributed without a human scribe.
7. **Follow up after** - As the assistant, after the meeting I send each owner their action items and a short recap, targeted so an offline attendee gets an email, so the meeting's output reaches the people responsible.
8. **Manager reads the outcome** - As a manager, I open the meeting's channel and read the notes and the follow-ups my team owns, scoped to my use case, so I know what was decided without attending.

## 5. Why each intent matters

- **`schedule_meeting`** - Removes the highest-friction chore (finding a time and creating the invite). Without it the organizer context-switches to a calendar and the assistant's usefulness stops at advice.
- **`lookup_meeting`** - Turns the channel into the meeting's source of truth for time, agenda, and attendees. Without it attendees re-ask questions the record already answers.
- **`invite_attendee`** - Lets the organizer manage the roster in the same conversation. It is propose-and-confirm because adding a person is consequential; a wrong add should never happen from a model's inference alone.
- **`onboard_attendee`** - The differentiator: each attendee gets a personal, contextual welcome. Without it attendees arrive cold and the meeting spends its first minutes on re-introductions.
- **`take_notes`** - Makes the meeting's decisions durable in the moment they are made. Without it the output depends on someone remembering to write it down.
- **`follow_up`** - Closes the loop so decisions become actions. Without it a good meeting still produces nothing a week later.

## 6. Non-goals

- **No multi-agent orchestration of its own.** Where it spins up one sub-agent per attendee, it USES the platform multi-agent orchestration primitive (`capabilities/DESIGN-MULTI-AGENT-ORCHESTRATION.md`). It decides WHICH attendees and WHAT each greeter says; the platform owns spawning, identity, and fan-out. This boundary is deliberate and load-bearing.
- **Not a calendar system of record.** It reads and writes through a calendar the deployment supplies; it does not own scheduling truth, resolve booking conflicts authoritatively, or replace the calendar.
- **Not a project manager.** Follow-ups are meeting action items, not a tracked backlog. Long-lived work belongs to a different assistant or tool.
- **Does not chair the meeting.** It supports the human chair; it does not run the agenda, enforce time, or make decisions.
- **No transcription or recording** in this phase. Notes are explicit captures, not an automatic transcript. (See open questions.)

## 7. Open product questions

- Should notes be explicit captures only, or should the assistant also propose notes it inferred from the conversation for the organizer to confirm?
- For scheduling, is proposing a small set of times (current default) better than auto-booking the first mutually free slot, given that auto-booking is faster but removes the human choice?
- Should follow-ups be per-owner private messages, a single shared recap, or both by default?
- How much of the attendee greeting should be templated versus generated, so onboarding stays consistent but not robotic?
- Does onboarding a large meeting need a cap on parallel greeters for cost, and if so what is a sensible default?

## Related

- Technical design: [`DESIGN-ASSISTANT-MEETINGS.md`](DESIGN-ASSISTANT-MEETINGS.md)
- Platform primitive it builds on: `capabilities/DESIGN-MULTI-AGENT-ORCHESTRATION.md`
- Assistant configuration pillar: `interaction/assistant-config/SPEC-ASSISTANT-CONFIG.md`
- Intent taxonomy mechanism: `interaction/assistant-config/SPEC-CONFIGURABLE-INTENT-PACK.md`
- Task hand-off to a human (follow-up email path): `interaction/conversation/SPEC-NOTIFICATION-BRIDGE.md`
- Personas: `overview/PERSONAS.md`
