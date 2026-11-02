# SPEC-ASSISTANT: Meetings assistant

**Status:** NOT BUILT, under consideration. Draft / planning - the design is not finalized and none of the meeting itself is built; the invitation chase (FR32) is built for any conversation. The Phase 1 WebRTC meeting (start, join, end and the lifecycle events behind the roster) is **NOT BUILT** in this codebase; "Phase 1 scope" states what that phase covers and what it does not. **BLOCKED**, in a specific order: sub-agent identity, then the moderator role, then this. See "What Blocks This, In Order".

**The phone leg is not a default dependency.** It is specified as a replaceable adapter (FR13, FR13a), because Amazon Chime SDK PSTN Audio is in maintenance mode and closed to new accounts from 2026-10-29.

**Coverage:** none - a draft design; nothing meeting-specific is built, and the invitation chase (FR32) is verified in SPEC-TASK-STATE-TRANSITIONS, so there is no deployed meeting behavior to drive.

**Related:** [DESIGN-ASSISTANT-MEETINGS.md](./DESIGN-ASSISTANT-MEETINGS.md) - the mechanics: the intents-to-tools map, the proposal and apply boundary, and the live meetings and calls infrastructure. [DESIGN-MULTI-AGENT-ORCHESTRATION.md](./DESIGN-MULTI-AGENT-ORCHESTRATION.md) - the platform primitive per-attendee onboarding depends on.

**Site section:** Interaction layer, assistants.

---

## Overview

**This is an assistant composed ON TOP of AgentEchelon, and that is what makes it worth specifying.** It is a set of domain intents plus the tools those intents need, running on the platform's own tool loop, identity model, classification boundary and guardrails. It adds no orchestration code of its own. Where it spins up one greeter per attendee it USES the platform's multi-agent primitive; where it mails an offline owner it posts a channel message and lets the notification bridge deliver it. The boundary is the specification: this assistant decides WHO and WHAT, and the platform owns HOW.

**The job is the bracket around a meeting, not the meeting.** Someone has to find a time, create the invite, chase the right attendees, make sure each person knows why they were pulled in, capture what was decided, and send the follow-ups. The assistant owns that bracket so the people can spend the meeting on the meeting.

**Its differentiator is the attendee, not the organizer.** Scheduling assistants are commodity. Greeting and orienting each attendee individually as they arrive - "you are here to review the new onboarding flow" - is the part that changes how a meeting starts, and it is the part that needs a sub-agent per attendee rather than one assistant talking to a room.

**Everything consequential is propose-and-confirm.** Creating a meeting, inviting a person and sending follow-ups are proposals a human accepts. Nothing a model emitted becomes an identity: an attendee is named by an allowlist KEY that an apply endpoint resolves, never by an address or an ARN the model wrote.

**It is the conversation's own assistant, at the conversation's classification.** It reads only the context that classification grants, so in a meeting with customers it reaches nothing internal. A participant's private asks (a sales rep's question about a discount, an engineer's note on an incident) go to the assistant of the inside conversation linked to this one, never to this assistant. Only segments addressed to it become turns, and its writes are propose-and-confirm. An attendee whose own classification does not reach the conversation is not admitted to it at all - the access layer refuses them the conversation rather than capping what they are served inside it.

**Every attendee, speaker and invitee is an AppInstanceUser.** A meeting belongs to exactly one conversation channel. Joining checks the caller's membership of that channel as the caller, the attendee's `ExternalUserId` is their AppInstanceUser id, a transcript segment is attributed through its attendee to that AppInstanceUser, and an invitation names the invitee's AppInstanceUser before anyone redeems it. An email address or phone number is only a route for a notice, never a way to find or bind a person (FR27 to FR30).

**It does ONE job.** It does not manage a project, own a calendar as a system of record, or replace the human chair.

## Business Problem

A meeting with no notes and no follow-up looks completely fine at the time and produces nothing a week later, which is what makes the failure so persistent: nobody is ever visibly at fault. Getting it right instead means somebody does five or six small chores around the edges - find a time everybody has, create the invite, get the right people on it, tell each of them why they are there, write down what was decided, and chase the actions - and every one of those is the kind of work that gets dropped when the day is busy. So meetings start late, spend their first minutes on re-introductions because nobody told the attendees what they were for, and end without a durable record. What an organization wants is for that bracket to happen reliably without asking anybody to be the scribe, and without the meeting's own participants leaving the conversation to arrange it.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. Three of them meet this assistant, in two quite different postures: two are in the meeting, and one reads its outcome without attending.

### End user

**How this relates to them:** they meet it in two roles, and the two want opposite things. As the organizer they want the chores done without opening a calendar, and they want to stay in control of anything consequential. As an attendee they want to arrive knowing why they are there, and to be able to ask the conversation what the meeting is rather than digging through invites.

| What they need | Requirement |
|---|---|
| Schedule against real availability and create the meeting without leaving the conversation | FR1 |
| Ask the conversation when the meeting is, who is on it, and what the agenda says | FR2 |
| Manage the roster in the same conversation, with a confirmation before anybody is added | FR3, FR11 |
| A personal "here is why you are here" on arrival, rather than a shared announcement | FR4 |
| A large meeting onboarded as fast as a small one | FR5 |
| Decisions written down as they are made, without volunteering to be the scribe | FR6 |
| Their action items reaching them afterward, including when they are offline | FR7 |
| Nothing CONSEQUENTIAL created, invited or sent without an explicit confirmation | FR11 |
| It may speak unprompted in a room it is already in, and only that | FR11b |
| Join only meetings of conversations they are a member of, as themselves | FR27 |
| Be invited without an account yet, and join from the invitation alone | FR29 |
| A scheduled meeting that does not hand its guests the parent conversation's history | FR30 |

### Manager

**How this relates to them:** they monitor a recurring team meeting they do not necessarily attend. What they want from it is the outcome - what was decided, and what their team now owes - scoped to their own conversations and with none of the platform's internals.

| What they need | Requirement |
|---|---|
| Read the notes and decisions for a meeting in their own scope | FR8 |
| See the follow-ups their team owns, and who owns each one | FR7, FR8 |
| A record that cannot be silently altered after the fact | FR10 |
| Everything about a topic in one conversation rather than a separate meetings view | FR12, FR14, FR15 |

### AI developer

**How this relates to them:** they are the ones who would build and tune this assistant, and the reason it is written down as an exemplar. What they need from it is that every piece of it is configuration and tools over platform seams, so that the next domain assistant is the same shape.

| What they need | Requirement |
|---|---|
| The whole assistant expressed as a persona, an intent pack and a tool set | FR1 through FR7 |
| No orchestration, identity or transport code of its own | FR5, FR9 |
| Consequential writes held by an apply endpoint rather than by the assistant's role | FR9 |
| An append-only store for anything that is a record | FR10 |
| A documented degraded path per tool, so an absent platform primitive does not fail the assistant | FR9 |
| A cost bound on a fan-out a single turn can start | FR17 |

**Also served, and an actor rather than a persona:** **the assistant** ([PERSONAS.md](../../../overview/PERSONAS.md), system actors). It greets and onboards each attendee on its own identity, captures notes as the meeting runs, and sends follow-ups after it ends, all as itself and never as a person.

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row work.

Nothing in this table is delivered, and the `Delivered` column says so on every row rather than being summarized once.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | An organizer schedules from a request: the assistant checks availability for the named attendees, proposes candidate times, and creates the meeting once the organizer picks one - all inside the conversation | Table stakes | No | none |
| FR2 | Anyone in the conversation asks the meeting record for its time, agenda and attendees, and is answered from the record rather than from the model's memory | Table stakes | No | none |
| FR3 | An attendee is invited by proposal, identified by an allowlist KEY that the apply endpoint resolves to an AppInstanceUser; no address, sub or ARN the model emitted ever becomes an identity, and the invitation itself follows FR29 | Table stakes | No | none |
| FR4 | Each attendee is greeted by name as they join and given a one-line statement of why they are there | Differentiator | No - **NOT BUILT**: its event, `meeting-joined`, with the arrival brief and the rejoin edge ([ADR-061](../../../design/decisions/061-a-welcome-is-a-workflow-an-event-starts.md) slice 2), waits on the meetings code landing on main | none |
| FR5 | A large meeting is onboarded by one greeter per attendee, fanned out in parallel on the platform's multi-agent primitive, each acting as its own classification-bounded identity | Differentiator | No | none |
| FR6 | A note, decision or action item stated during the meeting is captured on the meeting record, attributed to the sender by the platform rather than by model input, and timestamped | Table stakes | No | none |
| FR7 | After the meeting, decisions and action items are compiled per owner and sent on the organizer's confirmation, reaching an offline owner by email through the notification bridge with no transport code in the assistant | Table stakes | No | none |
| FR8 | A manager reads a meeting's notes and the follow-ups their team owns, scoped to their own conversations, with no platform internals | Table stakes | No | none |
| FR9 | The assistant holds no standing calendar-write, membership, mail or identity-creation grant: every consequential write is held by an apply endpoint or a platform primitive, and each tool degrades to a documented fallback rather than failing the assistant | Enabler | No | none |
| FR10 | The note store grants no update and no delete, so a captured note cannot be silently altered | Differentiator | No | none |
| FR11 | Every consequential action - creating the meeting, inviting a person, sending an outbound follow-up - takes effect only on an explicit human confirmation. A targeted in-channel message to somebody already a member is NOT one of these, or the per-attendee greeter cannot exist | Table stakes | No | none |
| FR11b | An assistant may speak unprompted into a conversation it is already a member of, to the room or to a member, attributably and visibly. A targeted message to a member, and the notification bridge's email of it, is initiative and is allowed. It may not add a member, send email to an address with no membership, send an invitation, create anything, or perform any external write on its own initiative: each is consequence (FR11). The definition is [ADR-061](../../../design/decisions/061-a-welcome-is-a-workflow-an-event-starts.md) decision 8, rule 7 | Table stakes | No | none |

**Why FR11 and FR11b are separate.** FR11 binds CONSEQUENCE; FR11b binds INITIATIVE. A rule of "nothing created, invited or sent on the assistant's own initiative" is a much larger promise on a different axis: under it, an assistant may not greet an arrival, chase an absence, or notice that a metric moved, and a proactive meetings assistant is not a thing that can be built. The two axes are independent: a greeting is initiative without consequence, and creating the meeting is consequence without initiative. FR11 states the consequence rule, and FR11b states the initiative rule as a bound. The protection people actually want, that nothing irreversible happens without a person, is unchanged - and FR11b is testable in a way "no initiative" never was.
| FR12 | A live meeting is an event on a conversation's timeline: the meeting record carries the conversation, and every artifact it produces posts back into that conversation | Differentiator | No | none |
| FR13 | Meetings run end to end over WebRTC with **no telephony adapter configured**, and a deployment without one loses dial-in and dial-out and nothing else | Table stakes | No | **OWED: `a-meeting-runs-without-a-telephony-adapter`** - the one requirement here whose regression is otherwise invisible, because an adapter creeping onto the WebRTC path fails only for adopters who cannot deploy one |
| FR13a | A phone participant joins through a **telephony adapter the deployment supplies**, in either direction, with no Amazon Chime SDK PSTN Audio. The adapter is the seam: the platform specifies what it is handed and what it returns, and ships no carrier and no telephony service as a requirement. A phone-only call goes through a telephony connector (Twilio first), with a call leg naming the callee's AppInstanceUser written before dialing; a phone leg into a WebRTC meeting goes through an optional media bridge that joins the meeting as one attendee per caller, taking the leg's AppInstanceUser id as its `ExternalUserId`, and can neither post nor read. **OPEN:** how a server process joins an Amazon Chime SDK meeting as a WebRTC attendee (a headless browser, or a supported native SDK) | Optional - attach instead | No | none |
| FR13b | Placing an outbound call to a telephone is CONSEQUENCE, never initiative: it rides FR11 confirmation, and the assistant holds no telephony credential of its own | Table stakes | No | none |
| FR14 | An inbound event lands in the conversation it deterministically belongs to rather than spawning a stray one: a meeting in the conversation it was started or scheduled in, and a call or voicemail on a known call leg in that leg's conversation. A call or voicemail from a number with no leg opens a new guest conversation and is never matched to a person by phone; it reaches a person's own conversations only through that person's action | Differentiator | No | none |
| FR15 | A meeting, call or voicemail renders inline as a compact card with a drill-down, as an ordinary channel message with metadata, so a message without one renders as before | Above bar - optional | No | none |
| FR16 | Follow-ups are per-owner, a single shared recap, or both, as the deployment chooses | Differentiator | No | none |
| FR17 | A single onboarding turn cannot start an unbounded fan-out: the number of parallel greeters is capped | Enabler | No | none |
| FR18 | What this assistant SAYS is measured by the existing ledger and nothing new is built for it: a turn it takes is an exchange carrying its model, tokens, latency, intent and answering assistant like any other | Table stakes | No | none |
| FR19 | A message this assistant sends unprompted DECLARES a turn kind, so it is refused by both pairing paths rather than pairing wrongly or landing in the unattributed bucket | Table stakes | No | none |
| FR20 | A meeting records the people it EXPECTED, not only the ones who arrived, so attendance has a denominator. An expected attendee is the invitee's AppInstanceUser in every case, including an invitee who has not yet signed in. FR24 rests on this, so it is table stakes rather than an enabler | Table stakes | No | none |
| FR21 | A person is identified on a meeting fact by their AppInstanceUser id, carried as the attendee's `ExternalUserId`, not by a display name, an address or an identity provider's subject, and a rejoin is the same person | Table stakes | No | none |
| FR22 | Every meeting figure is derived from the recorded events rather than from a counter maintained alongside them | Table stakes | No | none |
| FR23 | A meeting statistic states the population it was computed over, and one that cannot be supported is suppressed rather than shown as zero | Table stakes | No | none |
| FR24 | A meeting has a ROSTER with one row per person, carrying that person's state: invited, joined, left, or never joined | Table stakes | No | none |
| FR25 | A roster row carries how that person is present and WHEN each of those changed: audio over phone or browser, video on or off, screen share on or off | Differentiator | No | none |
| FR26 | Several attendee records for one person resolve to ONE roster row: a rejoin, a transport switch, and a content share are the same person | Table stakes | No | none |
| FR27 | A meeting belongs to exactly one conversation channel: the conversation it was started in, or its own meeting conversation when scheduled (FR30). The relation is a server-side `activeMeeting` record keyed by that channel ARN, never member-writable channel Metadata, and the meeting's `ExternalMeetingId` is the channel id. Joining resolves the caller once, through the edge resolver, to their AppInstanceUser; checks their membership of that channel with the caller as bearer; reads the meeting only from that channel's own record, so a meeting id from another channel admits no one; and creates the attendee with `ExternalUserId` set to the caller's AppInstanceUser id | Table stakes | No | **OWED:** a deny-test that a caller cannot join another channel's meeting with its meeting id, and a unit test that an attendee from a second identity provider carries its AppInstanceUser id |
| FR28 | Every stored transcript segment carries an AppInstanceUser ARN: Amazon Chime SDK live transcription attributes each transcript item to an attendee, and the attendee's `ExternalUserId` resolves it, so a speaker label is never the attribution. Live transcription transcribes the top two active talkers at any moment, so overlapping speech beyond two people is not captured. Segments are archived to the conversation's archive from the media capture pipeline's transcription-message artifacts, a per-meeting pipeline with its own cost, and never relayed by a client. Only the host starts transcription, and every attendee is told it is running | Table stakes | No | none |
| FR29 | An invitation is a single-use token, and the token is the credential: whoever redeems it acts as the invitation's AppInstanceUser. The full rules are in "Invitations" below: a `Tokens` record per invitation; a known invitee named by their existing AppInstanceUser; an unknown invitee is assigned an AppInstanceUser by the credential exchange when the invitation is made, at the latest when the meeting conversation is created; membership granted at invite time; redemption in the mode the conversation type declares (`sign-in` or `link`); a pending invitee swept once its invitation expires unredeemed; revocation removes the membership and ends the vended session | Table stakes | No | none |
| FR30 | A scheduled meeting is its own meeting conversation, linked to the conversation it was scheduled from by a resource tag on its channel naming the parent channel. Membership of the meeting conversation grants nothing in the parent, an invited guest does not inherit the parent's history, and the join recap is built only from the conversation joined. Calendar events come through a calendar connector, and an expected-attendee record (FR20) is written for every invitee | Table stakes | No | none |
| FR31 | Each expected attendee of a scheduled meeting is reminded before it starts, with a targeted message and its email, at a lead time the assistant's workflow declares (`meeting-starting`, a one-shot schedule the router creates, [ADR-061](../../../design/decisions/061-a-welcome-is-a-workflow-an-event-starts.md) decision 1); a moved meeting reminds at its new time and a cancelled one reminds nobody | Table stakes | No - **NOT BUILT** | none |
| FR32 | An invitation nobody has redeemed by a declared deadline before it expires is chased: the assistant drafts a nudge and proposes it to the inviter, who confirms before it is sent (`invitation-unredeemed`, an `agent` step, FR11) | Differentiator | Yes, built for any conversation's invitation: the router schedules `invitation-unredeemed` when it handles `invitation-sent` and checks the invitation when it fires, the platform's `chase-unredeemed` drafts the reminder and proposes it to the inviter, the chat client's confirmation card applies it once, and the reminder is the `nudge` kind the invitee may stop ([ADR-061](../../../design/decisions/061-a-welcome-is-a-workflow-an-event-starts.md) slice 4). A meeting's own invitations (`invite_attendee`) are **NOT BUILT** | `backend/test/lib/a-deadline-is-scheduled-once-and-checked-when-it-fires.test.ts`, `backend/test/lib/a-proposal-is-applied-once-by-its-addressee.test.ts`, `backend/test/deadlines-and-proposals-are-granted-narrowly.test.ts`, `frontend/packages/chat/src/components/ProposalCard.test.tsx` |
| FR33 | An expected attendee who has not joined by a declared time after the meeting starts is chased: the assistant drafts a nudge and proposes it to the organizer, who confirms before it is sent (`expected-attendee-absent`, an `agent` step, FR11) | Differentiator | No - **NOT BUILT**: `expected-attendee-absent` waits on the meetings code landing on main. The confirmation card, the apply endpoint and the deadline schedule it would use are built (FR32) | none |
| FR34 | A person can stop reminders and nudges: each is sent under its own notice kind (`meeting-reminder`, `nudge`), honors the person's notification preference for that kind and the bridge's one-click unsubscribe (SPEC-NOTIFICATION-BRIDGE FR19), and at most one nudge reaches a person per meeting or per invitation. **OPEN:** whether a person may decline being mentioned by name in room messages | Table stakes | No - **NOT BUILT** | none |

**Reading the "Validated by" column.** Every row reads `none`, which is what `Delivered: No` requires. When rows begin to land, unit tests belong in `backend/test/` and `backend/test/lib/`, and end-to-end specs in `tests/e2e/`, listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). The planned shape of each layer is in [DESIGN-ASSISTANT-MEETINGS.md](./DESIGN-ASSISTANT-MEETINGS.md), Testing.

**Ordering, because these rows are not independent.** FR1 through FR3, FR6 and FR7 are chat-only and can land first; they need a calendar client and the notification bridge and nothing else. FR4 and FR5 depend on the multi-agent primitive, whose blocking question is which identity a sub-agent acts as - unresolved, and named as such in [DESIGN-MULTI-AGENT-ORCHESTRATION.md](./DESIGN-MULTI-AGENT-ORCHESTRATION.md). FR17 has no number to cap until that question is answered, because the scarce resource is whatever that mechanism turns out to be. FR12 through FR15 are the live meetings and calls layer, and FR4's greeting of a live joiner reads differently once they exist. FR27 to FR30 are the identity rules every one of those rows rests on.

### Invitations

Invitations and scheduling are specified here rather than in a document of their own, beside the membership modes of [SPEC-CONVERSATION-TYPES.md](../conversation/SPEC-CONVERSATION-TYPES.md) FR18 and the expected attendees of FR20 above.

- **The record.** Each invitation is a `Tokens` record keyed by the token's hash: kind `invitation`, the meeting conversation's channel ARN, the invitee's AppInstanceUser ARN, the issuing AppInstanceUser ARN, the identity provider, the redemption mode, an expiry and a single-use flag consumed with a conditional write. A link carries only the token, never a user id, and the record, not the URL, names the AppInstanceUser.
- **A known invitee** is chosen from the conversation, from the directory, from a connector, or found by address inside one identity provider's directory. The match resolves the provider's record through the `Identities` index to an existing AppInstanceUser ARN. That AppInstanceUser is added as a member of the meeting conversation at invite time and notified. An address reassigned at the identity provider can put the wrong person on the invitation; that is a recorded, accepted risk, bounded by the rules below.
- **An unknown invitee** is assigned an AppInstanceUser by the credential exchange when the invitation is made, at the latest when the meeting conversation is created. The credential exchange is the one place AppInstanceUsers are minted; the AppInstanceUser is added as a member of that one channel, and notified through the contact seam. It has no `Identities` row until it is bound; its `Tokens` record names it until then.
- **Membership before redemption reaches nothing**, because only a session pinned to the AppInstanceUser can act as it.
- **Redemption modes.** The conversation type declares a default and an invitation may narrow it. In `sign-in` mode the token is redeemed by a signed-in session: for an AppInstanceUser not yet bound, redeeming binds that identity provider record to it and the person joins as a full member; for one already bound, only a session already pinned to it can redeem, so a sign-in never binds a second provider record to an AppInstanceUser that has one. In `link` mode clicking the emailed link redeems it with no sign-in: the exchange vends a short-lived session pinned to the invitation's AppInstanceUser, for that one channel only and bound to the conversation's classification, and a later sign-in can bind a provider record to the same AppInstanceUser if it is not yet bound. Further modes, such as a verified-address check or inviter approval, are declared the same way.
- **Unredeemed invitees are swept.** A pending invitee is created with no expiration, and a low-frequency sweep deletes one whose invitation expired unredeemed. **OPEN:** whether an AppInstanceUser's expiration can be removed at binding; if it can, a pending invitee is created with an expiration that binding removes instead, and the sweep is not needed.
- **Forwarding.** A forwarded `link` invitation admits whoever redeems it first, once, within the `link` session's limits; a forwarded `sign-in` invitation to a bound AppInstanceUser admits no one else. A verified-address mode checks the redeeming provider's verified address against the invited one as a further check, never as the binding.
- **Revocation.** The inviter and the conversation's moderators see who redeemed each invitation and when, and can revoke it, which removes the membership and ends the vended session.
- **Abuse limits.** `link` redemption is an unauthenticated route, so it carries the same in-handler controls as every unauthenticated route: a captcha, a per-IP limit, a per-person message limit and a kill switch, all failing closed.

**Chasing an unredeemed invitation is an event, not the sweep.** The sweep above removes a pending invitee once its invitation has expired. Offering a nudge before then is `invitation-unredeemed`, a one-shot schedule created with the invitation ("Events and roles" below).

**NOT BUILT for meetings:** no meeting invitation, scheduled meeting conversation or expected-attendee record exists. Invitations into an ordinary conversation are built on the same `Tokens` store and the same rules ([SPEC-CREDENTIAL-EXCHANGE.md](../governance/SPEC-CREDENTIAL-EXCHANGE.md) §4c), with two differences from the above: a pending invitee is created with an expiration that a sign-in redemption removes, rather than swept, and a `sign-in` invitation is redeemed by a first sign-in, an account that already exists being added by sharing rather than invited.

### Events and roles

**Everything this assistant does unprompted starts from an event of [ADR-061](../../../design/decisions/061-a-welcome-is-a-workflow-an-event-starts.md)**, the platform's one event model, and runs as a workflow of `platform` sends and `agent` steps. There is no meetings-specific trigger. The event model is built and not deployed for every event that is not meeting-sourced; the meeting events below are **NOT BUILT**, deferred until the meetings code lands on main.

| Requirement | ADR-061 event | Step |
|---|---|---|
| FR29, the invitation's notice | `invitation-sent` | `platform` send, targeted to the invitee and emailed |
| FR32, an invitation nobody redeemed | `invitation-unredeemed`, a one-shot schedule the router creates when it runs the `invitation-sent` workflow | `agent` step: drafts a nudge, proposed to the inviter (FR11). Built as `chase-unredeemed`; verified on dev by `tests/e2e/a-proposal-is-applied-once-by-its-addressee.spec.ts` |
| FR31, a reminder before a scheduled meeting | `meeting-starting`, a one-shot schedule the router creates in the meeting's conversation | `platform` send to each expected attendee (FR20) |
| FR11b, the start notice (Phase 3) | `meeting-started` | `platform` send to the room, emailed to the expected attendees |
| FR4, the arrival greeting | `meeting-joined` | `platform` send to the room naming who joined; then an `agent` step drafting that person's brief, targeted to them |
| FR33, the chase of an absence (Phase 4) | `expected-attendee-absent`, a one-shot schedule the router creates when it runs the `meeting-started` workflow | `agent` step: drafts a nudge, proposed to the organizer (FR11). **NOT BUILT**: waits on the meetings code |

- **A deadline is a schedule, never a poll.** Each deadline event comes from one schedule the router creates when it runs the event that starts the thing it times, only when a workflow declares the deadline event, and names nothing if the deadline no longer matters when it fires (tenet D6).
- **An `agent` step follows ADR-061 decision 8.** It runs after the instant opening, has a deadline and a declared platform fallback, is metered as the join recap is, against the deployment's global budget (SPEC-ABUSE-CONTROLS), declares the `event_step` turn kind (FR19), reads through this assistant's own session with read tools only, and turns anything consequential into a proposal that only the person it names can apply (FR11).
- **FR5's per-person fan-out stays BLOCKED** on sub-agent identity ("What Blocks This, In Order", row 1). Until it exists an `agent` step runs as this assistant, one turn per run, so each arrival is briefed by one turn of its own (FR4's buildable form).
- **An attendee's participant role is the meeting conversation type's.** "Why you are here" comes from the participant role the type declares and resolves (`organizer`, `attendee`, or another declared one) and the reason the invitation recorded, as [DESIGN-CONVERSATION-TYPES.md](../conversation/DESIGN-CONVERSATION-TYPES.md) section 6.1 specifies (SPEC-CONVERSATION-TYPES FR30). An invitation records a declared participant role the type marks `invitable`, chosen by the inviter or resolved from the organizer's words when the invitation is proposed and confirmed with it; its free-text `reason` is what the brief says and never what decides. **NOT BUILT:** the invitations API takes neither a role nor a reason today.
- **A room message may say who joined by name.** A mention of a member's display name is allowed in a message the room reads; every other fact about a person stays in the targeted brief (ADR-061 decision 6).
- **The meeting ending is an ADR-061 event with one source, the `MeetingEnded` lifecycle event** ([DESIGN-MEETING-ONBOARDING-AND-INCIDENT-SUBAGENTS.md](./DESIGN-MEETING-ONBOARDING-AND-INCIDENT-SUBAGENTS.md) section 4.2). **NOT BUILT**: it waits on the meetings code landing on main, so a follow-up "when the meeting ends" (FR7) is started by the organizer until it is built.

### Phase 1 scope

The Phase 1 WebRTC meeting is **NOT BUILT** in this codebase. The table records the scope of that phase as designed; its file references are to that separate work, not to this codebase.

| Requirement | In Phase 1 | Not in Phase 1 |
|---|---|---|
| FR27, the meeting belongs to one channel | Start, join and end routes (meeting-api.ts). The meeting is recorded on the channel's server-side context item as `activeMeeting`, claimed with a conditional write, and `ExternalMeetingId` is the channel id (meeting-api.ts line 184). The channel ARN must belong to this app instance, membership is checked with the caller as bearer (lines 85-99), and the meeting is read only from the channel's own record, so a meeting id from another channel is never accepted. The meeting is tagged with the channel's classification, and an unreadable classification refuses the start | **NOT BUILT:** the edge resolver. The route uses a Cognito user-pool authorizer (meeting-stack.ts line 132), the caller ARN is built from the token's `sub` (meeting-api.ts line 333), and the attendee's `ExternalUserId` and the record's `createdBy` are the token's `sub` claim (meeting-api.ts line 333, lines 145-149, 198), which equals the AppInstanceUser id only for a pool user while ids are still subs; a caller from another issuer cannot reach the route at all |
| FR21, FR22, FR24 to FR26, the roster | Meeting lifecycle events consumed from Amazon EventBridge, with the conversation derived from `ExternalMeetingId`, the content-share attendee marked, and the roster a query over the stored events rather than a counter (meeting-events.ts) | **NOT BUILT:** the person key is the `ExternalUserId`, so it is the token's `sub` claim (meeting-events.ts lines 140-142), which equals the AppInstanceUser id only for a pool user. Events are written to Aurora through the data plane only, not to the archive first, so an Athena-mode deployment records no roster |
| FR28, transcripts | Nothing | **NOT BUILT:** no transcription, media capture pipeline or segment store |
| FR29, FR30, invitations and scheduling | Nothing | **NOT BUILT** |
| FR13a, the phone leg | Nothing | **NOT BUILT** |

## Measurement

**The PLATFORM already answers most of this, and nothing in this document is built.** What follows is what measurement this assistant will inherit rather than what it has. Intent is an open dimension in the ledger: the per-intent rollups group on `exchanges.intent` with no allowlist, so `schedule_meeting`, `onboard_attendee`, `take_notes` and `follow_up` appear in effectiveness, latency and model attribution the moment the intent pack declares them. Evaluation is per assistant and per intent, so each meetings intent gets its own relevance verdicts. Declaring the pack is what buys the measurement (FR18).

**Two caveats on that.** `intent_effectiveness` groups by intent only and not by assistant, recorded as a partial on SPEC-EVALUATION FR19, so a per-intent figure is per intent across the room rather than per assistant. That is tolerable while only one assistant declares these intents and stops being tolerable when two do. And an intent only lands if the turn was classified, which a proactive greeting is not: hence FR19 here.

**The mechanism behind these requirements** is [DESIGN-ASSISTANT-MEETINGS.md](./DESIGN-ASSISTANT-MEETINGS.md) B.5 for the context a meeting produces, and section 5a of [DESIGN-MULTI-AGENT-ORCHESTRATION.md](./DESIGN-MULTI-AGENT-ORCHESTRATION.md) for what a fan-out owes the ledger.

The comparison of this platform with the field is not published here; the requirements it produced are FR22 and FR23.

### Roadmap: statistics that need a denominator first

**Join rate is not portable, because the reference implementation cannot compute it either.** It has no invitee model: every statistic is over people who produced an attendee event, so attendance has a numerator and no denominator. The nearest things it holds are a two-person expectation in mutable channel metadata, a free-text attendee string on a request, and single-use email tokens in a table with no index to list them by meeting. None is ever joined to attendance.

So these are roadmap items gated on FR20, and the gate is the point rather than a caveat:

| Statistic | Needs |
|---|---|
| **Join rate**: what share of invitees joined | The invited set, recorded at invite time on the meeting, with a stable person key |
| **No-show**: who was expected and never arrived | The same, plus the meeting reaching a terminal state so the question is answerable |
| **Time to join**: from the meeting opening to each person arriving | An opening timestamp distinct from the first join, which the reference implementation conflates |
| **Attendance over time**: occupancy during the meeting | Derived from join and leave events, not a sampled counter |
| **Chase effectiveness**: whether a nudge from this assistant changed whether somebody joined | Join rate first, plus the nudge recorded as an event rather than only as a message |

The last one is the one worth building toward, because it is the only measurement here that says whether this assistant is doing any good. The rest describe the meeting; that one describes the assistant.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| **Multi-agent orchestration of its own** | The boundary is load-bearing: this assistant decides WHICH attendees get a greeter and WHAT each one says, and the platform owns spawning, per-sub-agent identity, fan-out and teardown. An assistant that grew its own would be a second orchestrator to keep correct (tenet D8) | FR5, and [DESIGN-MULTI-AGENT-ORCHESTRATION.md](./DESIGN-MULTI-AGENT-ORCHESTRATION.md) |
| A calendar system of record | It reads and writes through a calendar the deployment supplies. It does not own scheduling truth, resolve booking conflicts authoritatively, or replace the calendar | FR1's proposal path, and the conflict-on-apply failure mode in [DESIGN-ASSISTANT-MEETINGS.md](./DESIGN-ASSISTANT-MEETINGS.md) |
| A project manager | Follow-ups are meeting action items, not a tracked backlog. Long-lived work belongs to a different assistant or a different tool | FR7 is bounded to the meeting; [SPEC-TASK-STATE-TRANSITIONS.md](../conversation/SPEC-TASK-STATE-TRANSITIONS.md) is where durable multi-turn work lives |
| Chairing the meeting | It supports the human chair. It does not run the agenda, enforce time, or make decisions | FR11: every consequential act is a proposal a person accepts |
| Transcription and recording, **until the corpus-retention gap is accepted or closed** | Recording is host-controlled and visible to the room, which is the industry norm, so consent is not the objection. A transcript is an attachment in the conversation, so its retention and classification are the conversation's and need no new answer. What remains is that the EMBEDDED SUMMARY has no TTL (ADR-008) and so outlives the conversation it came from. **A precondition rather than a refusal**: scheduled as Phase 2 by the owner on 2026-10-01 | [DESIGN-ASSISTANT-MEETINGS.md](./DESIGN-ASSISTANT-MEETINGS.md), "Phases", Phase 2 |
| Transport code for the follow-up email | The notification bridge fans a channel message out to email, so the assistant posts a message and holds no mail grant | FR7, FR9, and [SPEC-NOTIFICATION-BRIDGE.md](../../communication/SPEC-NOTIFICATION-BRIDGE.md) |
| Resolving an allowlist key to an identity inside the assistant | No model output may become an identity. Resolution belongs to the apply endpoint that holds the grant | FR3, and [SPEC-ADD-USER-ESCALATION.md](../governance/SPEC-ADD-USER-ESCALATION.md) |
| A meeting-specific task state machine | The two multi-step intents ride the generic action-item lifecycle, so a new workflow graph would be a second pattern for the same thing (tenet D9) | [SPEC-TASK-STATE-TRANSITIONS.md](../conversation/SPEC-TASK-STATE-TRANSITIONS.md), and Part A of the design |
| Binding a person by an address, or finding a caller by phone number | An address or number is a delivery route recorded on an AppInstanceUser. Matching a caller by phone, or an invitee by the address a vendor holds, would hand one person's conversations to whoever holds that route | FR14, FR29, and [SPEC-CONNECTORS.md](../../communication/SPEC-CONNECTORS.md) |
| A hard-coded telephony service, not only a hard-coded carrier | **Amazon Chime SDK PSTN Audio entered maintenance mode on 2026-09-29, and from 2026-10-29 a new SIP media application requires a per-account AWS Support exception.** An exception is granted per account, so it does nothing for anybody deploying this project from a clean one. A phone leg therefore cannot be a default dependency, and swapping the CARRIER behind one telephony service is not the same as being able to replace the service | FR13, FR13a |

## User Experience Description and Mocks

This vertical is the user experience, so the journeys below are the substance of the specification. Each is ordered as the person experiences it.

### The organizer

1. **They ask for a meeting in ordinary language.** "Set up a 30-minute design review with Priya and Sam next week." No calendar is opened (FR1).
2. **The assistant comes back with two or three times that work.** It checked the named attendees' availability rather than guessing (FR1).
3. **They pick one, and confirm.** The meeting is created on that confirmation and not before (FR11). If the slot went between the proposal and the apply, the conflict comes back and the assistant offers fresh times rather than booking something else.
4. **They adjust the roster in the same conversation.** "Add Priya's manager" produces a proposal naming the person, which they confirm; a wrong add never happens from an inference (FR3, FR11).
5. **They say the meeting is ready to start**, and each attendee is greeted individually as they arrive rather than getting a group announcement (FR4, FR5).
6. **During the meeting they speak decisions aloud.** "Note that we are shipping the new flow behind a flag" becomes a recorded decision, attributed and timestamped, with nobody taking minutes (FR6).
7. **Afterward they ask for follow-ups.** The assistant compiles them per owner and shows the recap; they confirm, and each owner gets their own items - by email if they are offline (FR7, FR11).
8. **What they never do:** open a calendar, open a separate meetings view, or write the notes.

### The attendee

1. **They are greeted by name when they join**, with one line saying why they are there (FR4). They arrive oriented instead of asking.
2. **They ask the conversation what the meeting is.** "When is the design review and what is on the agenda?" is answered from the meeting record (FR2).
3. **Their action items reach them afterward**, on a channel that gets to them (FR7).
4. **If they join by phone**, that is another way into the same conversation rather than a different place (FR13).

### The invitee from outside

1. **They receive an invitation by email** for a meeting conversation they are already a member of, under an AppInstanceUser assigned to them when they were invited (FR29).
2. **They open the link.** In `link` mode they are in the meeting with no account, on a short session that reaches only that one conversation; in `sign-in` mode they sign in with the identity provider the conversation type expects, and that sign-in becomes theirs from then on.
3. **They see only the meeting conversation**, never the conversation it was scheduled from (FR30).
4. **What they never do:** create an account before they can join, or find that a forwarded copy of their link let someone else in after them.

### The manager who does not attend

1. **They open the meeting's conversation** and read the notes and decisions in their own scope (FR8).
2. **They see the follow-ups their team owns**, and who owns each (FR7, FR8).
3. **They read the timeline rather than a meetings product.** Everything about this topic - the scheduled meeting, the completed meeting, a voicemail, a call summary - is on the one conversation (FR12, FR14, FR15).
4. **They trust the record**, because a captured note cannot be silently altered after the fact (FR10).

### The assistant, as an actor

1. **It proposes and does not decide.** Its persona is a concise facilitator: it proposes, confirms before anything consequential, and never chairs.
2. **It acts as itself.** It owns and moderates the meeting conversation on its own identity, and each greeter acts as its own identity rather than as anybody's (FR5).
3. **It degrades rather than failing.** With no orchestration primitive it greets attendees itself, sequentially, in the conversation; with no calendar it says it cannot check availability and asks the organizer to name a time; with a failed note write it says the note was not saved and offers to take it again (FR9).

**Mocks:** none. The surfaces are the conversation itself, the confirmation card a proposal renders as - rendered by the chat client's confirmation card (`ProposalCard.tsx`) for a proposal an `agent` step offers, and by a host widget outside this repo for the work-item proposals - and, once the live layer exists, the timeline cards (FR15).

## What Blocks This, In Order

**THIS ORDERS WHAT BLOCKS THE DIFFERENTIATOR, NOT WHAT BLOCKS THE FEATURE.** Read as a build order it puts the only buildable part last, which is how this stayed at zero: the meetings layer depends on none of the chain, and so does an assistant that speaks for itself. The phase plan in [DESIGN-ASSISTANT-MEETINGS.md](./DESIGN-ASSISTANT-MEETINGS.md), "Phases", starts with both and leaves the blocked work in Phase 4.

**This is not unwritten code. It is a blocked question, and the blocking chain is a platform question rather than a meetings one.** The order below is stated here because each link has been rediscovered separately, one piece at a time, from documents that each hold only their own part.

| # | What has to be settled | Where it is settled | State |
|---|---|---|---|
| 1 | **Sub-agent identity** - how a sub-agent gets an Amazon Chime SDK identity at all. The assistant provisioner mints an identity at runtime (`CreateAppInstanceBotCommand`, `backend/lambda/src/lib/assistant-provisioner.ts`), but only for an assistant in a deployed role, through `manage-assistants`; nothing mints a non-addressable worker identity for a sub-agent such as a greeter | [DESIGN-MULTI-AGENT-ORCHESTRATION.md](./DESIGN-MULTI-AGENT-ORCHESTRATION.md), Decision 2 | **OPEN** - the decision was reopened because the identity mechanism it originally leaned on no longer exists in the form it assumed. The document itself is deferred: the backend swarm is not being built yet |
| 2 | **Who holds the moderator role** - a sub-agent adding an attendee to a channel it did not create is refused, so per-attendee greeting cannot work until an identity exists that may add members | Follows from 1: the answer names which identity does it | **BLOCKED on 1** |
| 3 | **The meetings layer itself** - `chime-sdk-meetings` and `CreateMeetingCommand` appear nowhere in the backend. The Phase 1 WebRTC meeting is scoped in "Phase 1 scope" and is not built | This spec and [DESIGN-ASSISTANT-MEETINGS.md](./DESIGN-ASSISTANT-MEETINGS.md) | **NOT BUILT**. The layer depends on none of 1 and 2; only the per-attendee greeter does |
| 4 | **A confirmation card in the chat client** - every workflow that proposes needs something for a person to confirm on the chat client alone | [DESIGN-ASSISTANT-MEETINGS.md](./DESIGN-ASSISTANT-MEETINGS.md) B.2 | Built for a proposal an [ADR-061](../../../design/decisions/061-a-welcome-is-a-workflow-an-event-starts.md) `agent` step offers: the card (`ProposalCard.tsx`) is drawn from the targeted message's Metadata (`proposal`), not from a `proposal:` marker, and its answer goes to `POST /proposals/apply`. FR32 is built on it; FR3's invite proposal and FR33 wait on the meetings code, not on the card |

**Why the order cannot be reversed.** FR4 and FR5 - greeting each attendee individually - are the differentiator, and they are the part that needs one sub-agent per attendee. Everything above them in this spec is commodity scheduling. Building the commodity half first would ship a meetings assistant whose reason for existing is the one part still blocked, which is the shape this ordering exists to refuse.

**What is safe to decide now.** The Open Product Questions below are independent of the chain, except the parallel-greeter cap, which explicitly waits on 1 to name what is scarce.

## Open Product Questions

| Question | Why it is open |
|---|---|
| Explicit note captures only, or also notes the assistant inferred for the organizer to confirm | Inferred notes make the record fuller and make it partly the model's account of the meeting rather than the participants', which is a different thing to trust |
| Propose a small set of times, or auto-book the first mutually free slot | Auto-booking is faster and removes the human choice, which is the one thing FR11 is otherwise consistent about |
| Per-owner private follow-ups, a single shared recap, or both by default | They disclose different amounts to different people, and the right answer probably depends on the meeting rather than on the deployment (FR16) |
| How much of the attendee greeting is templated and how much is generated | Templated stays consistent and reads as robotic; generated reads better and drifts. The differentiator in FR4 is the part most exposed to getting this wrong |
| A cap on parallel greeters, and its default | It is a cost bound, and there is no number to choose until the sub-agent identity mechanism names what is scarce (FR17) |
| Whether a meeting summary should outlive the conversation it came from | **The only part of this still open.** A transcript is an attachment, so its storage, retention and classification are the conversation's. The embedded SUMMARY has no TTL (ADR-008) and therefore stays answerable after the conversation expires. Accept it, or give the corpus a per-source-type expiry |
| Voicemail residency | Where a voicemail's audio and transcript are kept, and for how long, before the conversation it lands in is the only home they have. Placement itself is not open: an event lands only where a deterministic link puts it, and anything else opens a new conversation (FR14) |
| Default redemption mode per conversation type | `link` lets an outside invitee in with no account and admits whoever redeems a forwarded copy first; `sign-in` admits only a signed-in session and asks the invitee to have an account. Which a customer-facing meeting type defaults to is a product call (FR29) |

## Related Documents

- [DESIGN-ASSISTANT-MEETINGS.md](./DESIGN-ASSISTANT-MEETINGS.md) - the technical design: intents to tools, the proposal and apply boundary, and the live meetings and calls layer
- [DESIGN-MULTI-AGENT-ORCHESTRATION.md](./DESIGN-MULTI-AGENT-ORCHESTRATION.md) - the platform primitive FR4 and FR5 depend on, and the identity question that blocks it
- [ADR-061](../../../design/decisions/061-a-welcome-is-a-workflow-an-event-starts.md) - the events this assistant's unprompted work starts from, and the `agent` step
- [DESIGN-CONVERSATION-TYPES.md](../conversation/DESIGN-CONVERSATION-TYPES.md) section 6.1 - the participant roles an attendee's brief reads
- [SPEC-ASSISTANT-CONFIG.md](./SPEC-ASSISTANT-CONFIG.md) - how an assistant is configured
- [SPEC-CONFIGURABLE-INTENT-PACK.md](./SPEC-CONFIGURABLE-INTENT-PACK.md) - the intent taxonomy mechanism, and the generic action-item lifecycle
- [SPEC-NOTIFICATION-BRIDGE.md](../../communication/SPEC-NOTIFICATION-BRIDGE.md) - the email delivery FR7 uses
- [SPEC-ADD-USER-ESCALATION.md](../governance/SPEC-ADD-USER-ESCALATION.md) - the allowlist-key rule FR3 follows
- [SPEC-CONNECTORS.md](../../communication/SPEC-CONNECTORS.md) - the telephony and calendar connectors, and why a vendor's email never identifies an invitee
- [SPEC-TASK-STATE-TRANSITIONS.md](../conversation/SPEC-TASK-STATE-TRANSITIONS.md) - the task lifecycle the multi-step intents ride
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the three personas above

## Appendix A - The intents this assistant declares

The universal `greeting`, `acknowledgment` and `general` intents come from the platform and are not listed. These six are the domain intents, and the delivery shape is the platform's `DeliveryOption` for that intent.

| Intent key | The person is asking to | Delivery shape | Requirement |
|---|---|---|---|
| `schedule_meeting` | find a time and set up a new meeting | `TASK_MULTI_STEP` | FR1 |
| `lookup_meeting` | find an existing meeting, its agenda, time or attendees | `PLACEHOLDER_UPDATE` | FR2 |
| `invite_attendee` | add one or more people to a meeting | `PLACEHOLDER_UPDATE` | FR3 |
| `onboard_attendee` | greet and orient each attendee as they join | `TASK_MULTI_STEP` | FR4, FR5 |
| `take_notes` | capture a note, decision or action item during the meeting | `PLACEHOLDER_UPDATE` | FR6 |
| `follow_up` | send the notes and action items to the attendees afterward | `TASK_MULTI_STEP` | FR7 |

**Why each one is there, rather than being folded into `general`:**

- **`schedule_meeting`** removes the highest-friction chore. Without it the organizer context-switches to a calendar and the assistant's usefulness stops at advice.
- **`lookup_meeting`** makes the conversation the meeting's source of truth for time, agenda and attendees. Without it attendees re-ask questions the record already answers.
- **`invite_attendee`** keeps the roster in the same conversation. It is propose-and-confirm because adding a person is consequential.
- **`onboard_attendee`** is the differentiator. Without it attendees arrive cold and the meeting spends its first minutes on re-introductions.
- **`take_notes`** makes decisions durable in the moment they are made. Without it the output depends on somebody remembering to write it down.
- **`follow_up`** closes the loop so decisions become actions. Without it a good meeting still produces nothing a week later.

The tools each intent calls, their schemas, their grants and their failure modes are in [DESIGN-ASSISTANT-MEETINGS.md](./DESIGN-ASSISTANT-MEETINGS.md), Part B.
