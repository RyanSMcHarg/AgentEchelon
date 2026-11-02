-- 042: what a turn declared about itself becomes a column, so both pairing paths can read it.
--
-- WHAT WAS MISSING. An exchange is "an assistant answered this message", and the turn knows which
-- message that is. Two paths build exchanges and neither could read the declaration the same way:
-- the in-batch path (`createExchangesFromRecords`) works from flattened record fields and has no SQL
-- to reach into metadata JSON with, and the 24-hour sweep (`createExchangesFromDatabase`) reads
-- `metadata->>'answersMessageId'` - which exists only for a turn that answered through the async
-- processor. A `DIRECT` answer is returned by the Lex fulfillment and materialized by Amazon Chime
-- SDK, and a fulfillment return carries no message metadata at all, so that turn declared in its own
-- CONTENT (`lib/turn-declaration.ts`) and the sweep could not see it.
--
-- Measured on the deployment 2026-09-11: the `unknown` delivery-option bucket held 1,134 exchanges
-- with 1 of 7 day-rows carrying any `e2e_ms`. That is where real direct answers landed.
--
-- SO THE DECLARED FACTS ARE FOLDED ONCE, AT ARCHIVAL, AND EVERY READER READS ONE PLACE. The archive
-- record already resolves them from whichever carrier the turn had; writing them to columns is what
-- lets the sweep obey a declaration instead of re-deriving one, and what lets a person filter on
-- turn kind without a JSON extraction per row.
--
-- ADDITIVE, NOT A BACKFILL. Every row written before this has NULL in both columns, and every reader
-- COALESCEs to the metadata JSON it already read. Nothing that pairs today stops pairing, and no
-- historical row changes meaning.
--
-- Idempotent and transaction-safe: applied at RUNTIME on a cold start inside one transaction
-- (db-client applyPendingMigrations), so no CREATE INDEX CONCURRENTLY.

-- ── WHAT THIS ANSWERS ──
--
-- Amazon Chime SDK permits a `MessageId` of up to 128 characters and treats it as opaque.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS answers_message_id VARCHAR(128);

COMMENT ON COLUMN messages.answers_message_id IS
    'The Amazon Chime SDK MessageId this bot message answers, DECLARED by the turn that produced it '
    'rather than inferred downstream. Folded at archival from whichever carrier the turn had: '
    'Metadata for a processor-delivered answer, the <!--turn:--> content declaration for a handler '
    'answered one. NULL means no component declared it - never that the message answered nothing - '
    'so a reader falls back to the heuristic pairing exactly as it did before this column existed.';

-- ── AND WHAT KIND OF TURN IT WAS ──
--
-- A CLOSED SET, which is the point. A closed set is what lets a query say "everything that is not an
-- answer" without naming the kinds it has not heard of, and what stops the `exchange_count` mistake
-- repeating: that number was never a count of exchanges, and nobody could tell because no query
-- published the population it counted.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS turn_kind VARCHAR(32);

COMMENT ON COLUMN messages.turn_kind IS
    'What kind of turn produced this bot message, declared by the turn (lib/turn-declaration.ts owns '
    'the set). WRITTEN TODAY: reading - queue work, which answers a BURST and so names no single '
    'message and never pairs; drift - a suggestion about where the conversation is going, which IS a '
    'response to a message and names it, but deliberately does not do the work and so is excluded '
    'from the population that measures answers. NULL means an ordinary answer, which is also what '
    'every row written before this column existed means. A kind absent from this list is not a '
    'sanctioned value: producers declare from the closed set, and a query filtering on an unknown '
    'string returns nothing.';

-- ── AND HOW IT WAS DELIVERED ──
--
-- `exchanges.delivery_option` has existed since 001 and only ONE of the two pairing paths ever set
-- it: the in-batch pairer passes it, the 24-hour sweep never has. So every exchange the sweep minted
-- carried NULL, and NULL renders as the `unknown` bucket - which is why that bucket is not only where
-- direct answers land but where every late-paired answer of any kind lands too. Folding the fact onto
-- the message is what lets the sweep pass it through, because the value the sweep needs is a property
-- of the ANSWER and it had nowhere to read it from.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_option VARCHAR(32);

COMMENT ON COLUMN messages.delivery_option IS
    'How this bot message was delivered (lib/delivery-options.ts owns the set: DIRECT, '
    'PLACEHOLDER_UPDATE, TASK_UPDATE_IN_PLACE, TASK_MULTI_STEP), folded at archival from whichever '
    'carrier the turn had. IT IS NOT A FINALITY SIGNAL: the value is stamped from the turn''s intent, '
    'so a turn whose intent maps to DIRECT but which fell through to the processor carries DIRECT as '
    'well. Only the declared respPhase says whether a message closed its turn.';

-- ── AND HOW THE PAIR WAS MADE, BECAUSE ONE ABSENCE WAS CARRYING TWO FACTS ──
--
-- `latency_metrics` partitions TTFF on `e.delivery_option IS NOT NULL`, and NULL there meant "the
-- 24-hour sweep minted this row" only because that pairer's INSERT omitted the column. The comment
-- at that filter says so in as many words, names it the fix's one weakness, and asks for exactly this:
-- "a declared provenance column on the pairer would make this a read of a fact rather than of an
-- absence, and is the better end state."
--
-- IT BECOMES LOAD-BEARING THE MOMENT THE SWEEP RECORDS A DELIVERY OPTION, which the column above lets
-- it do. Without this, every reconstructed row would rejoin the TTFF average it was removed from -
-- and that removal was worth 93% of a seven-day total: 101 rows on 2026-08-14 averaging 487,360 ms
-- took the headline from 3,585 ms to 21,555 ms against a 1 second target.
--
-- THREE VALUES, BECAUSE THE EXPOSURE IS NOT "WHICH PAIRER" BUT "HOW SURE". A declared pairing is the
-- turn's own statement and is exact wherever it was made. An in-batch inference is bounded by the
-- Kinesis batch it was made in, which is seconds. A swept inference searched up to an hour for a
-- plausible reply, so its latency is the gap to whatever that search chose.
--
-- NULL IS EVERY ROW WRITTEN BEFORE THIS, and readers keep the old test for exactly those, so no
-- historical row changes which side of a partition it falls on and no backfill is required.
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS paired_by VARCHAR(16);

COMMENT ON COLUMN exchanges.paired_by IS
    'How this pair was made. declared - the answer named the message it answers, so the pairing is '
    'the turn''s own statement. in_batch - inferred from order within one Kinesis batch, bounded to '
    'seconds by the batch itself. swept - inferred by the 24-hour reconciliation pass, whose search '
    'for a plausible reply is bounded only by the reply window, so its response_latency_ms is the gap '
    'to whatever that search chose and must not vote in a time-to-first-feedback average. NULL on '
    'every row written before this column existed; readers partition those on the old proxy '
    '(delivery_option IS NULL meant swept, because that pairer omitted the column).';

-- The sweep joins an answer to the message it named, per channel. Without this it scans.
CREATE INDEX IF NOT EXISTS idx_messages_answers_message_id
    ON messages (channel_arn, answers_message_id)
    WHERE answers_message_id IS NOT NULL;

-- And the viewable half filters on kind over a window. Partial, because the overwhelming majority of
-- rows are ordinary answers carrying NULL and a query asking for those asks for everything.
CREATE INDEX IF NOT EXISTS idx_messages_turn_kind
    ON messages (channel_arn, turn_kind, created_at)
    WHERE turn_kind IS NOT NULL;
