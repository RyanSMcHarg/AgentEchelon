# DESIGN-ASSISTANT: Meetings assistant

**Status:** Draft / planning - the design is not finalized and nothing is built.

**Layer:** Built on the platform (application)

**Product spec:** [`SPEC-ASSISTANT-MEETINGS.md`](SPEC-ASSISTANT-MEETINGS.md)

**Summary:** A meetings-facilitation assistant (Parts A and B) composed from six domain intents and their tools on the platform Converse tool loop, with propose-and-confirm writes and per-attendee onboarding via the multi-agent orchestration primitive - plus the live meetings and calls infrastructure it runs on (Part C, draft): Amazon Chime SDK meetings, PSTN in and out on a pluggable carrier, and a unified conversation timeline where every meeting, call, and voicemail lands in the right conversation.

> Worked exemplar of `templates/DESIGN-ASSISTANT-TEMPLATE.md`. Part A reuses the platform seams almost verbatim; Part B (Intents -> Tools) is the meetings-specific content. This assistant is internal, so its ceiling is a **classification**, not a customer rung.

---

## Part A - the standard pieces

| Piece | Platform mechanism | This assistant's setting |
|---|---|---|
| **Profile / model** | `AssistantProfile` (`backend/lib/config/profiles.ts`). | A `meetings` profile: `modelKey: sonnet`, `classifierMode: 'llm'`, `timeoutSeconds: 60`, `taskSupport: 'full'` (it runs TASK_MULTI_STEP intents), `contextScope: 'own-rank-and-below'`, `battleEligible: false`. Bound to the deployment's internal classification. |
| **Persona / system prompt** | `ASSISTANT_SYSTEM_PROMPT` -> SSM, hydrated at cold start; stable prefix cached via `cachePoint`. | `persona-meetings.txt`: a concise meeting facilitator - proposes, does not decide; confirms before consequential actions; never chairs. |
| **Guardrail** | `applyInputGuardrail` / `applyOutputGuardrail` (out-of-band, fails open). | Platform default guardrail (PROMPT_ATTACK on input; PII / marker filter on output). No meeting-specific rules. |
| **Context scope** | `load_company_context` / `load_platform_info` on a classification-scoped S3 prefix, IAM-bounded. | Company-context tool OFF. The assistant's "context" is the meeting record (see the tools), not a document corpus. `load_platform_info` may stay on for "what can you do?" turns. |
| **Classification cap** | Immutable channel `classification` tag; min-cap; fail-closed to the lowest rank. | Serves the classification of the meeting channel; an attendee below that classification is capped to it in-channel. |
| **Identity / bot** | Own `CfnAppInstanceBot`, bearer-pinned; `ChannelModerator` of its own channels; privileged actions via credential-exchange. | The meetings bot owns and moderates the meeting channel. It never holds a standing calendar-write or membership grant - those run through host apply endpoints (below). |
| **Converse tool loop** | `invokeBedrock` in `async-processor-core.ts`: input guardrail, bounded loop (`MAX_TOOL_ITERATIONS = 3`), `tool_use` dispatch, `toolResult`, final generate, output guardrail, `ConverseStep` telemetry. | Unchanged. It exposes the tools in Part B. |
| **Intent classification** | Intent pack (`ASSISTANT_INTENT_PACK` -> SSM) + universal three; LLM classifier with keyword fallback; pack + persona hash into `configId`. | `intent-pack-meetings.json` (section "Config wiring"). |

The two TASK_MULTI_STEP intents (`schedule_meeting`, `follow_up`) ride the generic `action_item` task lifecycle (`gather -> present options -> awaiting_completion -> completed`) exactly as the corporate-travel worked example does - no meeting-specific state machine is added. `onboard_attendee` is TASK_MULTI_STEP but its steps are attendee greeters run by the orchestration primitive (Part B.3), not a task graph.

---

## Part B - Intents -> Tools (the keystone)

### B.1 Intents -> Tools map

| Intent | Tool(s) | Pattern | Capability the tool needs |
|---|---|---|---|
| `schedule_meeting` | `find_meeting_slot`, then `create_meeting` | EXECUTED read, then PROPOSE-AND-CONFIRM write | Read: scoped calendar-read credential (Secrets Manager). Write: host apply endpoint holds the calendar-write credential; assistant never writes directly. |
| `lookup_meeting` | `lookup_meeting` | EXECUTED read | `dynamodb:GetItem` / `Query` on `MeetingsTable`, keyed by `meetingId` in the channel. Read-only. |
| `invite_attendee` | `invite_attendee` | PROPOSE-AND-CONFIRM | Host apply endpoint: `chime:CreateChannelMembership` scoped to the app instance, plus the calendar-invite write. Attendee chosen by allowlist KEY, never a model-emitted ARN. |
| `onboard_attendee` | `onboard_attendees` | delegates to platform | None direct - delegates to `capabilities/DESIGN-MULTI-AGENT-ORCHESTRATION.md` multi-agent orchestration, which vends each greeter sub-agent's identity via credential-exchange. |
| `take_notes` | `append_meeting_note` | EXECUTED write (append-only) | `dynamodb:PutItem` on `MeetingNotesTable` scoped by `meetingId`. Append-only (no update/delete grant). Attributed to the sender. |
| `follow_up` | `compile_follow_up`, then `send_follow_up` | EXECUTED read, then PROPOSE-AND-CONFIRM | Read: `Query` on `MeetingNotesTable`. Send: posts as the assistant's own bot with `metadata.notify:{email:true}`; the notification bridge fans out to email. No direct SES grant. |

The universal intents need no tools: `greeting` / `acknowledgment` answer directly; `general` answers from persona (and `load_platform_info` if enabled).

### B.2 Tool detail

#### `find_meeting_slot` (EXECUTED)

- **Serves intent(s):** `schedule_meeting`.
- **Description (what the model sees):** "Find times when the named attendees are all free for a meeting of the given length in a date window. Call this once you have the attendees, the duration, and a rough window. Returns candidate slots; it does not book anything."
- **Input schema:**

```json
{
  "type": "object",
  "properties": {
    "attendeeKeys": { "type": "array", "items": { "type": "string" }, "description": "Allowlist KEYs of the attendees to check (never emails or ARNs)." },
    "durationMinutes": { "type": "number", "description": "Meeting length in minutes." },
    "windowStart": { "type": "string", "description": "Earliest date to consider, YYYY-MM-DD." },
    "windowEnd": { "type": "string", "description": "Latest date to consider, YYYY-MM-DD." }
  },
  "required": ["attendeeKeys", "durationMinutes", "windowStart"]
}
```

- **Output (toolResult):**

```json
{ "slots": [ { "start": "ISO-8601", "end": "ISO-8601", "allFree": true } ], "note": "policy/availability note string" }
```

- **Side-effects:** None (read-only availability lookup).
- **Capability / IAM:** A scoped, read-only calendar credential in Secrets Manager (secret ARN granted to the assistant's Lambda role). Ships as a MOCK (deterministic slots, no network call) exactly like `corporate-travel-tool.ts`; swap for a real calendar client to make it live.
- **Enablement:** OFF unless `ENABLE_MEETINGS_CALENDAR=true` (optionally `MEETINGS_CALENDAR_API_BASE`), so the platform stays domain-neutral by default.
- **Failure mode:** On error the loop feeds back `{ error }`; the model reports it cannot check availability and asks the organizer to pick a time manually.

#### `create_meeting` (PROPOSE-AND-CONFIRM)

- **Serves intent(s):** `schedule_meeting`.
- **Description:** "Propose creating the meeting once the organizer has chosen a time. Does not take effect until the organizer confirms."
- **Input schema:**

```json
{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "start": { "type": "string", "description": "ISO-8601 chosen start." },
    "durationMinutes": { "type": "number" },
    "attendeeKeys": { "type": "array", "items": { "type": "string" } },
    "agenda": { "type": "string" }
  },
  "required": ["title", "start", "durationMinutes", "attendeeKeys"]
}
```

- **Proposal payload:** `{ op: "create_meeting", args: <input>, summary: "Create \"<title>\" at <start>" }`, emitted as a `<!--proposal:...-->` marker (base64), rendered as a confirm card - the same mechanism as the work-item tools (`proposalMarker` in `async-processor-core.ts`).
- **Side-effects on Apply:** creates the calendar event and the meeting record (`MeetingsTable`), and provisions the meeting channel.
- **Capability / IAM:** The host apply endpoint (not the assistant) holds the calendar-write credential and the `dynamodb:PutItem` on `MeetingsTable`. The assistant only proposes; nothing is written from model output.
- **Enablement:** With `ENABLE_MEETINGS_CALENDAR`.
- **Failure mode:** If the chosen slot is taken between proposal and Apply, the apply endpoint returns a conflict the widget surfaces; the assistant re-runs `find_meeting_slot`.

#### `lookup_meeting` (EXECUTED)

- **Serves intent(s):** `lookup_meeting`.
- **Description:** "Look up a meeting's time, agenda, and attendees. Call this before answering any question about when a meeting is, who is invited, or what is on the agenda."
- **Input schema:**

```json
{
  "type": "object",
  "properties": {
    "meetingId": { "type": "string", "description": "Omit to use the current channel's meeting." },
    "query": { "type": "string", "description": "What the user is asking about." }
  },
  "required": []
}
```

- **Output (toolResult):** `{ "title": "...", "start": "ISO-8601", "attendees": ["display names"], "agenda": "...", "found": true }`.
- **Side-effects:** None (read-only).
- **Capability / IAM:** `dynamodb:GetItem` / `Query` on `MeetingsTable`, scoped to meetings in the assistant's app instance. Attendee identities are read from the record; the model never receives raw ARNs or emails, only display names.
- **Enablement:** On by default for this assistant (it is the read side of the meeting record).
- **Failure mode:** Absent record returns `{ found: false }`; the model says it has no meeting on file and offers to schedule one.

#### `invite_attendee` (PROPOSE-AND-CONFIRM)

- **Serves intent(s):** `invite_attendee`.
- **Description:** "Propose adding a person to the meeting. Identify them by their allowlist KEY. Does not take effect until the organizer confirms."
- **Input schema:**

```json
{
  "type": "object",
  "properties": {
    "meetingId": { "type": "string" },
    "attendeeKey": { "type": "string", "description": "Allowlist KEY of the person to add (never an email, sub, or ARN)." },
    "reason": { "type": "string", "description": "One line the greeter uses when this attendee joins." }
  },
  "required": ["attendeeKey"]
}
```

- **Proposal payload:** `{ op: "invite_attendee", args: <input>, summary: "Invite <key>" }` as a `<!--proposal:...-->` marker.
- **Side-effects on Apply:** adds the attendee to the meeting record and (for an in-app attendee) creates their channel membership; sends the calendar invite.
- **Capability / IAM:** The host apply endpoint resolves the KEY against the deployment allowlist and holds `chime:CreateChannelMembership` (scoped to the app instance) plus the calendar-invite write. The KEY-not-ARN rule mirrors the add-user escalation design (`interaction/identity-access/core/SPEC-ADD-USER-ESCALATION.md`): no model output ever becomes an identity.
- **Enablement:** On by default; the membership write always goes through the apply endpoint.
- **Failure mode:** An unknown KEY is rejected by the apply endpoint with an actionable message; the proposal never resolves to an add.

#### `onboard_attendees` (delegates to platform)

- **Serves intent(s):** `onboard_attendee`.
- **Description:** "Onboard the meeting's attendees: for each one, ensure they are invited, joined, and greeted with their reason for attending. Call this when the organizer says the meeting is ready to start."
- **Input schema:**

```json
{
  "type": "object",
  "properties": {
    "meetingId": { "type": "string" },
    "greeters": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "attendeeKey": { "type": "string" },
          "briefing": { "type": "string", "description": "The one-line why-you-are-here this attendee's greeter delivers." }
        },
        "required": ["attendeeKey", "briefing"]
      }
    }
  },
  "required": ["greeters"]
}
```

- **Output (toolResult):** `{ "dispatched": <n>, "orchestrationId": "..." }` - the assistant reports that onboarding is running; each greeter posts its own greeting as it completes.
- **Side-effects:** Spawns one greeter sub-agent per attendee (invite -> join -> greet), fanned out in parallel, each acting as its own classification-gated identity.
- **Capability / IAM:** **None direct.** This tool hands the `{attendeeKey, briefing}` list to the platform multi-agent orchestration runtime, which owns spawning, per-sub-agent identity (vended via credential-exchange, classification-gated), fan-out, and lifecycle. The meetings assistant holds no `chime:CreateAppInstanceBot` or bulk-invoke grant. See Part B.3.
- **Enablement:** On by default for this assistant; requires the orchestration primitive to be present in the deployment.
- **Failure mode:** If orchestration is unavailable, the tool returns `{ error }` and the assistant falls back to greeting attendees itself, sequentially, in-channel (a degraded but functional path).

#### `append_meeting_note` (EXECUTED, append-only)

- **Serves intent(s):** `take_notes`.
- **Description:** "Capture a note, decision, or action item for the current meeting. Call this whenever the user states something to record. Include an owner for an action item."
- **Input schema:**

```json
{
  "type": "object",
  "properties": {
    "meetingId": { "type": "string", "description": "Omit to use the current channel's meeting." },
    "kind": { "type": "string", "enum": ["note", "decision", "action_item"] },
    "text": { "type": "string" },
    "ownerKey": { "type": "string", "description": "Allowlist KEY of the action-item owner, if kind is action_item." }
  },
  "required": ["kind", "text"]
}
```

- **Output (toolResult):** `{ "noteId": "...", "saved": true }`.
- **Side-effects:** Appends one immutable note row to `MeetingNotesTable`, attributed to the sender and timestamped.
- **Capability / IAM:** `dynamodb:PutItem` on `MeetingNotesTable` scoped by `meetingId`. Append-only: the role grants no `UpdateItem` / `DeleteItem`, so a note can never be silently altered (the audit-integrity posture). Attribution comes from the platform (the sender identity), not from model input.
- **Enablement:** On by default.
- **Failure mode:** A write failure returns `{ error }`; the model tells the user the note was not saved and offers to repeat it.

#### `compile_follow_up` (EXECUTED) and `send_follow_up` (PROPOSE-AND-CONFIRM)

- **Serves intent(s):** `follow_up`.
- **`compile_follow_up` description:** "Gather the meeting's decisions and action items into a per-owner follow-up. Call this when the meeting ends or the organizer asks to send follow-ups."
- **`compile_follow_up` input:** `{ "meetingId": "string (optional)" }`. **Output:** `{ "recap": "...", "perOwner": [ { "ownerKey": "...", "items": ["..."] } ] }`. Read-only (`Query` on `MeetingNotesTable`).
- **`send_follow_up` description:** "Propose sending the compiled follow-up to each owner. Does not send until the organizer confirms."
- **`send_follow_up` input:** `{ "meetingId": "string", "perOwner": [ ... ] }`. **Proposal payload:** `{ op: "send_follow_up", args: <input>, summary: "Send follow-ups to <n> owners" }`.
- **Side-effects on Apply:** posts one targeted channel message per owner (`"<owner>, you're set to complete <X> by <dueBy>"`) with `metadata.notify:{email:true}`, so an offline owner is emailed.
- **Capability / IAM:** The assistant posts as its own bot (it is a member/moderator of the channel). The outbound email is the **notification bridge** platform primitive - no SES grant on the assistant. Only the recap send is behind confirm; compiling is a read.
- **Enablement:** On by default; email delivery requires the notification bridge in the deployment.
- **Failure mode:** A per-owner post failure is reported per owner; the recap that reaches the channel is never lost even if an email leg fails (in-app delivery is the backstop, matching the bridge design).

### B.3 Platform primitives this assistant USES (not re-implemented)

The boundary is deliberate and crisp: **this doc is the meetings APPLICATION; the orchestration is a platform primitive.** The meetings assistant decides WHO and WHAT; the platform owns HOW.

| Primitive (platform doc) | What the platform owns | What this assistant owns |
|---|---|---|
| Multi-agent orchestration (`capabilities/DESIGN-MULTI-AGENT-ORCHESTRATION.md`) | Spawning one sub-agent per attendee, each sub-agent's identity (credential-exchange, classification-gated), the parallel fan-out, retries, and lifecycle/teardown. | Which attendees get a greeter, and the per-attendee briefing text each greeter delivers (the `greeters[]` it passes to `onboard_attendees`). |
| Credential-exchange (`interaction/identity-access/core/SPEC-CREDENTIAL-EXCHANGE.md`) | Vending each greeter's short-lived, bearer-pinned credentials. | Nothing - it never handles a sub-agent's credentials. |
| Notification bridge (`interaction/conversation/SPEC-NOTIFICATION-BRIDGE.md`) | Fanning a `metadata.notify` message out to email. | Composing the follow-up and targeting the owner; it emits the marker, not transport code. |
| Add-user escalation allowlist (`interaction/identity-access/core/SPEC-ADD-USER-ESCALATION.md`) | Resolving an allowlist KEY to a real identity at the apply endpoint. | Selecting the KEY; it never emits an ARN, sub, email, or name as an identity. |
| Generic `action_item` task lifecycle (`interaction/assistant-config/SPEC-CONFIGURABLE-INTENT-PACK.md`) | The `gather -> present options -> awaiting_completion -> completed` state machine, hand-off notices, and cross-channel continuity. | Supplying the `schedule_meeting` / `follow_up` intents that route onto it. |

If any row's platform primitive is absent from a deployment, the corresponding tool degrades to a documented fallback (see each tool's failure mode) rather than failing the whole assistant.

---

## Part C - Live meetings and calls (draft, pulled in)

This part is the infrastructure a live meeting or call runs on, and how each one attaches to a conversation. It is adapted from a proven design on the same Amazon Chime SDK foundation, but **nothing in Part C is built in AgentEchelon yet**; Parts A and B (scheduling and facilitation over chat) can ship before any of it lands. Everything below stays inside the platform's invariants: a meeting or call is an event on a governed conversation, scoped by that conversation's classification.

### C.1 A live meeting is an Amazon Chime SDK meeting attached to a conversation

A meeting is an Amazon Chime SDK Meetings session (WebRTC audio and video). Attendees join from the web or mobile client; a phone attendee dials in over PSTN (C.2). The meeting record carries the conversation's `channelArn`, so the meeting's artifacts - the scheduled and completed cards, recording, transcript, and the notes from Part B - post back into that conversation. The conversation is the durable home; the meeting is an event on its timeline, not a separate place.

### C.2 Calls: PSTN in and out, provider-agnostic

Voice rides Amazon Chime SDK Voice: an Amazon Chime SDK Voice Connector plus a SIP Media Application whose call-flow Lambda drives the call (an IVR - "press 1 to join" - bridges a caller into the meeting). The PSTN carrier is a **pluggable SIP trunk**, the deployer's choice of provider rather than a hard-coded one - the connectivity model of `../../interaction/connectors/SPEC-CONNECTORS.md` and the Communication layer, where the platform supports the model and the deployer supplies the provider.

- **Inbound:** a caller reaches a number, the SIP Media Application answers and identifies the caller, and either joins them to an active meeting or routes the call to the right conversation (C.3); an unanswered call falls to voicemail (recorded, transcribed, summarized, and posted as a card).
- **Outbound:** the operator (or the assistant, on confirm) places a call - for example, to dial an attendee into a meeting - through the same SIP Media Application.

### C.3 Every event lands in the right conversation (the unified timeline)

The organizing principle is that **the conversation is the source of truth.** A person holds several conversations, each a distinct topic or engagement, and every event - scheduled meeting, ad-hoc meeting, inbound call, voicemail - should land in the *most relevant* one rather than spawn a stray channel.

A **conversation-matcher** scores a user's conversations for an incoming event by purpose, topic overlap, company, and recency - reading the conversation summaries the platform already keeps (`../../interaction/assistant-config/SPEC-WELCOME-AND-CONTEXT.md`) - and posts the event to the best match; a weak match falls to the most recent conversation, and an unknown caller starts a new one. A scheduled meeting already knows the conversation it was created from, so it needs no matching. Voicemail is two-phase: placed immediately on caller identity, then re-evaluated after transcription (the transcript is the real signal), moving the card and leaving a "moved to another conversation" breadcrumb if a better match is found.

### C.4 Structured timeline cards

Each event posts a structured message carrying a `cardType` - `meeting-scheduled`, `meeting-completed`, `voicemail`, or `call-summary` - rendered inline as a compact card with a drill-down detail panel (attendee join and leave times, recording, transcript, audio player). A conversation is then a self-contained timeline of everything about that topic, without leaving it for a separate meetings view. Cards are ordinary channel messages with metadata, so an older message without a `cardType` renders as before.

### C.5 How the assistant (Parts A and B) sits on this

The facilitation assistant runs on top of this infrastructure: `create_meeting` provisions the meeting and its channel, `onboard_attendees` greets people as they join a live meeting, and `take_notes` / `follow_up` write and summarize the meeting the timeline cards surface. That is why Parts A and B can ship first over chat, and Part C is what makes the meetings and calls themselves live.

---

## Config wiring

- **Profile:** add a `meetings` `AssistantProfile` (Part A) and bind the deployment's internal classification to it in the profiles config (`backend/lib/config/profiles.ts`).
- **Persona:** `persona-meetings.txt`, injected via `-c assistantSystemPrompt` (merged into `cdk.context.json`; written to SSM by `assistant-profile-stack.ts`).
- **Intent pack:** `intent-pack-meetings.json`, injected via `-c assistantIntentPack`. Its six domain intents:

```json
{ "intents": [
  { "key": "schedule_meeting", "description": "Find a time and set up a new meeting.", "keywords": ["schedule", "set up a meeting", "find a time", "book a meeting"], "delivery": "TASK_MULTI_STEP" },
  { "key": "lookup_meeting", "description": "Find an existing meeting, its agenda, time, or attendees.", "keywords": ["when is", "agenda", "who is invited", "meeting details"], "delivery": "PLACEHOLDER_UPDATE" },
  { "key": "invite_attendee", "description": "Add one or more people to a meeting.", "keywords": ["invite", "add", "include"], "delivery": "PLACEHOLDER_UPDATE" },
  { "key": "onboard_attendee", "description": "Greet and orient each attendee as they join.", "keywords": ["onboard", "greet", "start the meeting", "welcome everyone"], "delivery": "TASK_MULTI_STEP" },
  { "key": "take_notes", "description": "Capture a note, decision, or action item during the meeting.", "keywords": ["note that", "record", "decision", "action item"], "delivery": "PLACEHOLDER_UPDATE" },
  { "key": "follow_up", "description": "Send the notes and action items to the attendees afterward.", "keywords": ["follow up", "send recap", "action items", "wrap up"], "delivery": "TASK_MULTI_STEP" }
] }
```

- **Tool enablement flags:** `ENABLE_MEETINGS_CALENDAR=true` (+ `MEETINGS_CALENDAR_API_BASE`) for `find_meeting_slot` / `create_meeting`. `lookup_meeting`, `invite_attendee`, `append_meeting_note`, `onboard_attendees`, and the follow-up tools are on for this assistant by default.
- **Guardrail:** platform default (`GUARDRAIL_ID` / `GUARDRAIL_VERSION` from the shared construct).
- **Data stores:** `MeetingsTable` and `MeetingNotesTable` (DynamoDB), plus the calendar-read secret and the apply-endpoint calendar-write secret in Secrets Manager.
- **Grants added to the assistant Lambda role:** `dynamodb:GetItem`/`Query` on `MeetingsTable`; `dynamodb:Query` on `MeetingNotesTable`; `dynamodb:PutItem` on `MeetingNotesTable` (append-only); `secretsmanager:GetSecretValue` on the calendar-read secret. NO membership, calendar-write, SES, or bot-create grant - those live on the apply endpoints and the platform primitives.

## Testing

Status is Design; these are the planned tests, mirroring the platform tool patterns.

- **Unit:** each tool's input coercion and output shape; `create_meeting` / `invite_attendee` / `send_follow_up` proposal-marker encoding (base64, no `-->` leakage) as in the work-item tests; intent-pack classification + keyword fallback for the six intents; `find_meeting_slot` determinism (mirroring `corporate-travel-tool.test.ts`).
- **Integration:** the tool loop dispatching each EXECUTED tool and intercepting each PROPOSE-AND-CONFIRM tool without executing it; append-only enforcement on `MeetingNotesTable` (no update path); the guardrail on/off.
- **End-to-end:** one turn per intent through a deploy - schedule (propose + apply), look up, invite (propose + apply), onboard (greeters posted), note, follow-up (recap + email).
- **Deferred / gaps:** the `onboard_attendees` path depends on the orchestration primitive; its e2e is deferred until that primitive lands. The calendar tools are mock until a real calendar client replaces `find_meeting_slot`.

## Open technical questions

- Should `MeetingsTable` and `MeetingNotesTable` be one table with a composite key, or two? (One store simplifies the read side of `follow_up`.)
- Where does the meeting channel's lifecycle live - does `create_meeting`'s apply endpoint provision it, or does the platform conversation-type flow? (Boundary with `SPEC-CONVERSATION-TYPES`.)
- Should `onboard_attendees` cap parallel greeters (cost) and, if so, does the cap belong to this assistant or to the orchestration primitive?
- Does `find_meeting_slot` need attendee time zones passed explicitly, or does the calendar client resolve them?
- (Part C) Does `create_meeting`'s apply endpoint provision the meeting channel, or the conversation-type flow? (Same boundary as above.)
- (Part C) Recording and transcript storage and retention, and how they are classification-scoped.
- (Part C) Voicemail residency, and the conversation-matcher's confidence threshold for routing an event vs starting a new conversation.
