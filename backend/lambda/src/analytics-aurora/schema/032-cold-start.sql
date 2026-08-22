-- 032 (G9): record cold start, so the TTFF/worker-compute divergence stops being an argument.
--
-- THE GAP THIS CLOSES, in the doc's own words: "cold start shows in TTFF but not total_ms... annotate
-- the divergence as cold-start, not error." That instruction could not be followed, because nothing
-- recorded which turns were cold. An operator seeing a 4s TTFF beside a 900ms worker number had two
-- readings available - a cold container, or a regression in a hop nobody measures - and no way to
-- choose between them. Annotation without measurement is just a plausible story told about a number.
--
-- WHY THE DIVERGENCE IS LEGITIMATE AND MUST NOT BE "FIXED". `total_ms` starts at handler ENTRY, and a
-- container's initialisation - module load, client construction, config reads - happens before that.
-- `ttff_ms` is measured from the user's message on the Chime clock, so it necessarily contains the
-- init that `total_ms` structurally cannot. The two disagreeing on a cold turn is the design working.
-- What was missing is the label.
--
-- MEASURED, NOT INFERRED. A module-scope flag in the async processor is true for exactly the first
-- invocation on a container and false for every reuse - the definition of a cold start rather than a
-- proxy for one. Inferring it from the numbers instead (say, ttff minus total over a threshold) would
-- make the annotation depend on the very divergence it claims to explain, so a real regression would
-- be labelled "cold start" precisely when it mattered most.
--
-- FALSE BY ABSENCE. Only a cold turn writes the column, so NULL means warm. A boolean written on
-- every row to say "nothing unusual happened" costs a value on every record for no reading.
--
-- Idempotent and order-independent: IF NOT EXISTS, converging whether it runs before 001's column
-- exists, after it, or twice.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS cold_start BOOLEAN;

COMMENT ON COLUMN messages.cold_start IS
    'TRUE when this turn ran on a container that had to initialise first; NULL means warm (only a '
    'cold turn writes it). The one sanctioned reason ttff_ms and total_ms disagree: init runs before '
    'handler entry, so total_ms cannot contain it and ttff_ms - measured from the user''s message on '
    'the Chime clock - necessarily does. Read as a RATE beside the averages: a cold_start_count that '
    'is a large share of a small window explains a slow TTFF, and one that stays high on a busy '
    'window is a concurrency finding rather than a latency one.';

-- The rate is read per (day, tier, delivery option) alongside the other latency aggregates, and a
-- window scan is what serves it. Partial, because warm is the overwhelming majority and only the cold
-- rows are ever selected FOR - indexing the nulls too would be a bigger index answering nothing.
CREATE INDEX IF NOT EXISTS idx_messages_cold_start
    ON messages (created_at DESC)
    WHERE cold_start;
