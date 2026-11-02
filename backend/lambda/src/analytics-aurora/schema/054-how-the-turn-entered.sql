-- 054: HOW THE TURN ENTERED, recorded rather than inferred from the shape of a correlation id.
--
-- THE PROBLEM THIS FIXES. Two components can start an assistant turn: Amazon Chime SDK invoking the
-- assistant's Amazon Lex bot, and the channel flow invoking the router directly. They are different
-- code paths with different work in front of the first frame, so a latency figure that mixes them is
-- not a figure about either one. Nothing recorded which had happened.
--
-- The only way to tell them apart was the SHAPE of the correlation id: sixteen hex characters for an
-- Amazon Lex turn, `mention-<MessageId>` for a flow turn. That difference exists because the two
-- entries derive turn identity by incomparable rules, which is itself the defect being measured, so
-- the measurement was reading its own symptom. It also required a `LIKE` over message content, could
-- not be grouped, and silently mixed a DIRECT quick answer into the flow bucket.
--
-- WHY `messages` AND NOT `turn_events`. The two queries that must group by this - `getLatencyMetrics`
-- and `getRouterSteps` - already sit on `messages`, and `v_turn_latency` already joins it. A column
-- here is reachable from all three read paths with no CTE change. On `turn_events` it would have to
-- enter `v_turn_latency` through an aggregate, and an uncast aggregate over a varchar returns `text`,
-- which breaks the next `CREATE OR REPLACE VIEW` on a column-type change - the failure that took the
-- whole data plane down between migrations 026 and 027.
--
-- AND WHY THIS MIGRATION REPLACES NO VIEW. `v_turn_latency` has been redefined ten times and the
-- append-only column contract has held every time; the cheapest way to keep holding it is not to
-- touch it. The one reader that reads the view alone, `turn_latency_audit`, joins `messages` in its
-- own query instead. One ALTER, no view, no cast hazard.
--
-- TWO VALUES, NOT THREE. 'lex' and 'flow'. The interesting third case is an Amazon Lex turn that
-- arrived TARGETED rather than standard, and the router cannot know it without a channel read:
-- Amazon Chime SDK sends Amazon Lex three request attributes and none is the `Target` or the message
-- id. That read sits in front of the person's first frame, so buying it to record a dimension would
-- make the metric change the thing it measures. It is not needed either: under a deployment-wide
-- `StandardMessages: NONE` an Amazon Lex invocation IS targeted by construction, so the split is
-- implied by the configuration rather than stored per row.
--
-- NULL MEANS "WRITTEN BEFORE THIS COLUMN EXISTED", NEVER A DEFAULT. A guessed entry would put the
-- difference being measured into the measurement, which is the one thing this column exists to stop.
-- Readers COALESCE to 'unknown' for display and never for arithmetic.
--
-- Idempotent and transaction-safe: ADD COLUMN IF NOT EXISTS, no CONCURRENTLY, COMMENT ON converges.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS turn_entry VARCHAR(8);

COMMENT ON COLUMN messages.turn_entry IS
    'How the turn entered: ''lex'' (Amazon Chime SDK invoked the assistant''s Amazon Lex bot) or '
    '''flow'' (the channel flow invoked the router directly). Declared by the router, which is the '
    'one component both entries converge on, and carried on the analytics record beside trigger. '
    'NULL means the row predates the column - never a default, because a guessed entry biases the '
    'comparison the column exists for. A targeted Amazon Lex turn is not distinguished here: the '
    'router cannot learn it without a channel read in front of the first frame, and under '
    'StandardMessages: NONE it is implied by the configuration. See ADR-041.';

-- The read paths group on this, and a sequential scan over every message to answer "what did the
-- premium entry cost last week" is the shape that makes an operator stop asking. Partial: the column
-- is NULL for all history and for every row a pre-054 producer writes, and those rows are never
-- grouped by it.
CREATE INDEX IF NOT EXISTS idx_messages_turn_entry
    ON messages (turn_entry, created_at DESC)
    WHERE turn_entry IS NOT NULL;

-- ── AND WHO THE MESSAGE WAS ADDRESSED TO, WHICH THE PROJECTION HAS BEEN THROWING AWAY ────────────
--
-- The entry column above says WHICH COMPONENT started the turn. It deliberately does not say whether
-- an Amazon Lex turn arrived targeted, because the router cannot learn that without a channel read in
-- front of the person's first frame. But the ARCHIVAL path can, for free: the message stream carries
-- `Target` in full on every record, including on messages no bearer can read.
--
-- `transformToMessageRecord` never read it. The `target_arn` column beside it holds a different fact
-- entirely - its only writer is the MEMBERSHIP branch, where it means the member the event is about -
-- so on every message row ever archived it is NULL, and "who was this addressed to" is a question the
-- projection could not answer about itself. The S3 and Athena archive was complete throughout, because
-- Firehose reads the stream raw; only the queryable copy lost it.
--
-- A COLUMN OF ITS OWN RATHER THAN THE ONE NEXT TO IT. Reusing `target_arn` would make one column mean
-- "the member this membership event is about" on some rows and "the member this message was addressed
-- to" on others, and a reader filtering it would silently mix the two populations. One question, one
-- source.
--
-- WHAT IT BUYS. Targeted becomes a FILTER rather than a dimension nobody can compute: a turn whose
-- placeholder carries a target was a targeted turn, and that is visible after the fact at no cost to
-- the turn path. It also makes the moderation and accountability question answerable, which is why it
-- was recorded as owed in its own right.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS targeted_to VARCHAR(255);

COMMENT ON COLUMN messages.targeted_to IS
    'The member ARN this MESSAGE was addressed to, read from the stream record''s Target. Distinct '
    'from target_arn, whose only writer is the membership branch and which means the member a '
    'MEMBERSHIP event is about. NULL means the message carried no Target (the ordinary case) or the '
    'row predates the column. A turn whose placeholder carries this was a targeted turn, which is how '
    'a targeted Amazon Lex turn is told from a standard one without a read on the turn path.';

CREATE INDEX IF NOT EXISTS idx_messages_targeted_to
    ON messages (channel_arn, created_at DESC)
    WHERE targeted_to IS NOT NULL;
