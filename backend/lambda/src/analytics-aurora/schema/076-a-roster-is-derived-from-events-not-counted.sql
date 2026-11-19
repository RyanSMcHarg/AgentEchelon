-- A MEETING ROSTER IS DERIVED FROM ITS EVENTS, NOT COUNTED (SPEC-ASSISTANT-MEETINGS FR22,
-- DESIGN-ASSISTANT-MEETINGS C.5, Phase 1's operator goal).
--
-- This table holds the EVENT SEQUENCE a meeting emits. The roster is a query over it and is never
-- stored: "nothing maintains a roster as mutable state, which is the mistake FR22 exists to prevent -
-- a counter incremented on arrival and decremented on departure is wrong the first time an event is
-- redelivered or lost, and it is wrong silently."
--
-- WHY THE EVENTS CAN BE TRUSTED TO ANSWER THE QUESTION. Every fact the roster shows is already
-- emitted by the service: joins, leaves, drops, video starting and stopping, content sharing starting
-- and stopping, and the network each attendee is connected over. None of it has to be inferred.
--
-- ── ONE ROW PER EVENT, AND THE ROSTER FOLDS THEM BY PERSON ──────────────────────────────────────
--
-- The service issues a NEW attendee record per connection, so one person routinely produces several:
-- dial in then switch to a browser, lose connection and come back, or share a screen - which joins as
-- a SEPARATE attendee whose id carries a `#content` suffix. Keyed on the attendee, a person who did
-- all three is three participants and one of them is a screen.
--
-- So `person_key` is the stable identity (the attendee's external user id, which this platform sets
-- to the Cognito sub) and `is_content` marks the screen-share attendee. A roster groups by
-- `person_key`, counts only rows where `is_content` is false as participation, and attributes the
-- content share to its owner. A participant count taken that way is a count of PEOPLE.

CREATE TABLE IF NOT EXISTS meeting_events (
    id BIGSERIAL PRIMARY KEY,

    -- The meeting, and the conversation it is an event on. `channel_arn` joins to `conversations`,
    -- which is what lets a roster be read across meetings without this table knowing anything about
    -- conversations itself.
    meeting_id VARCHAR(128) NOT NULL,
    channel_arn VARCHAR(256) NOT NULL,

    -- ── THE CLASSIFICATION THIS ROW BELONGS TO ──────────────────────────────────────────────────
    --
    -- The table joins `BOUNDED_TABLES`, so it gains per-classification reader grants, FORCE ROW LEVEL
    -- SECURITY and the scope policy (ADR-028).
    --
    -- IT HOLDS NO MESSAGE TEXT, and is bounded for the reason `cross_conversation_context` is: who
    -- was in a meeting, on which conversation, and when, is itself a fact that must not cross a
    -- classification boundary. A roster is read to decide who an assistant is still waiting for, and
    -- it names people and the conversation they met on.
    --
    -- NOT NULL, because every row is written by a path that can always establish a value: the
    -- writer reads the conversation's immutable classification tag, and stamps
    -- `failClosedContentValue` when that read fails - the classification the FEWEST holders reach.
    -- An event is never DISCARDED for an unreadable tag, because the operator's record of who was in
    -- a meeting is the thing this table exists for; it is filed where fewest people can read it.
    classification VARCHAR(32) NOT NULL,

    -- `AttendeeJoined`, `AttendeeLeft`, `AttendeeDropped`, `MeetingStarted`, `MeetingEnded`, and the
    -- video and content-share transitions. Stored as the service names it rather than remapped, so a
    -- new event type lands as data instead of being dropped by a translation table.
    event_type VARCHAR(64) NOT NULL,

    -- Absent on meeting-level events (`MeetingStarted` / `MeetingEnded`), which belong to no attendee.
    attendee_id VARCHAR(128),
    person_key VARCHAR(256),
    is_content BOOLEAN NOT NULL DEFAULT FALSE,

    -- Phone or browser, where the service reports it. The transport HISTORY is what matters rather
    -- than a current value: somebody starting on a phone and moving to a browser is unremarkable, and
    -- three people doing it in the same two minutes is the network rather than the people.
    network_transport VARCHAR(32),

    -- When the event happened, per the service. Distinct from when it was stored: the gap is delivery
    -- latency, and a roster must be built on the former or a redelivery reorders the timeline.
    event_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- The unmapped remainder, so a fact the service emits that nothing reads yet is still recorded.
    detail JSONB
);

-- ── REDELIVERY MUST NOT DOUBLE-COUNT, WHICH IS THE WHOLE RISK OF AN APPEND-ONLY ROSTER ──────────
--
-- EventBridge delivery is at-least-once, and the roster sums intervals across records. A duplicated
-- `AttendeeJoined` would add a second interval for one arrival, so connected time and the participant
-- count would both drift up - silently, and in the direction that looks like success.
--
-- The natural key is what the service already makes unique: one attendee record produces one event of
-- a given type at a given instant. `COALESCE` on the nullable attendee column because a unique index
-- treats NULLs as distinct, which would let meeting-level events duplicate freely - the one case the
-- obvious index would miss.
CREATE UNIQUE INDEX IF NOT EXISTS meeting_events_natural_key
    ON meeting_events (meeting_id, COALESCE(attendee_id, ''), event_type, event_at);

-- Reading a single meeting's roster: every event for one meeting, in order.
CREATE INDEX IF NOT EXISTS meeting_events_meeting_at ON meeting_events (meeting_id, event_at);
-- Reading across a conversation's meetings, which is the operator's view.
CREATE INDEX IF NOT EXISTS meeting_events_channel_at ON meeting_events (channel_arn, event_at);
-- "Which meetings has this person been in", and the per-person fold the roster performs.
CREATE INDEX IF NOT EXISTS meeting_events_person ON meeting_events (person_key, event_at)
    WHERE person_key IS NOT NULL;
