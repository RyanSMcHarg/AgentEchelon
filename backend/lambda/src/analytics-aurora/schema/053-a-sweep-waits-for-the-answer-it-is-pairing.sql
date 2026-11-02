-- ============================================================================
-- 053: a sweep waits for the answer it is pairing, and a paired anchor is not an independent one.
--
-- TWO COLUMN CONTRACTS MOVED, AND NEITHER COLUMN DID. Nothing here adds, drops or rewrites anything:
-- this migration records what `exchanges.paired_by` and `turn_events.turn_id_source` now mean, in the
-- place a reader looks for it. A comment that states the old contract is worse than no comment,
-- because it is read as current and there is nothing beside it to say otherwise.
--
-- ── WHAT CHANGED ABOUT paired_by ────────────────────────────────────────────────────────────────
--
-- The cross-batch sweep (`createExchangesFromDatabase`) used to mint an exchange the moment a bot
-- placeholder landed. The message a turn answers is NOT known when the placeholder is posted and IS
-- known by the time the answer update is written, so on any turn whose answer had not arrived yet
-- there was no declaration to read and the row was stamped `swept` permanently. Kinesis batches on a
-- five second window, so the turns reached in that state were disproportionately the SLOW ones - and
-- `swept` is excluded from the headline time to first feedback by name. The service level objective
-- was therefore computed with its own worst cases censored.
--
-- The sweep now DEFERS a bot message that has no answer update yet, until either the update exists or
-- the placeholder is older than any live turn can be. So `swept` means what its comment always said
-- it meant - a pairing this pass genuinely reconstructed by search - rather than also meaning "the
-- declaration had not arrived yet". The exclusion is unchanged and deliberately so: a reconstruction
-- is not a measurement, and the work was to stop manufacturing them, never to start trusting them.
--
-- ── AND WHAT CHANGED ABOUT turn_id_source ───────────────────────────────────────────────────────
--
-- `v_turn_latency` reports `anchor_source = 'ledger'` when the ledger holds a `user_message` row for
-- the turn, and `getLatencyMetrics` read that alone as "no sweep took part in this anchor". The
-- INSTANT is observed either way; what the ledger may not have observed is WHICH user message is the
-- turn's anchor. `turn_events.turn_id_source` is the column that says so, and `paired` means the
-- binding was derived FROM THE EXCHANGE - `turn-events-backfill.ts` reads `exchanges` with no
-- `paired_by` filter and writes the turn id onto the user_message row. A ledger anchor bound that way
-- inherits the exchange's provenance, a swept one included, so running that backfill over a window
-- readmitted every swept pairing to the headline average. The measured predicate now asks both
-- columns, and where the binding was `paired` the decision falls through to the exchange it came
-- from.
--
-- ── WHY THERE IS NO DATA STEP ───────────────────────────────────────────────────────────────────
--
-- Relabeling history would mean re-deciding provenance for rows whose evidence has already been
-- consumed, and admitting a row to the measured population on anything less than the turn's own exact
-- declaration is the fabrication this whole partition exists to prevent. The one repair that IS
-- evidence-based already exists and runs with the evidence in hand: `backfillFromUpdateEvents`
-- promotes `swept` to `declared` when a folded update names that exchange's own user message. Rows
-- older than that keep their label.
--
-- Idempotent and transaction-safe: `COMMENT ON` is a catalog write with no table lock and no row
-- rewrite, and re-running it sets the same text. Applied at RUNTIME on a cold start inside one
-- transaction (db-client applyPendingMigrations).
-- ============================================================================

COMMENT ON COLUMN exchanges.paired_by IS
    'How this pair was made. declared - the answer named the message it answers, so the pairing is '
    'the turn''s own statement. in_batch - inferred from order within one Kinesis batch, bounded to '
    'seconds by the batch itself. swept - RECONSTRUCTED by the cross-batch reconciliation pass, '
    'whose search for a plausible reply is bounded only by the reply window, so its '
    'response_latency_ms is the gap to whatever that search chose and must not vote in a '
    'time-to-first-feedback average. Since migration 053 that pass defers a bot message whose answer '
    'update has not landed yet, so swept no longer also covers a turn whose declaration was merely '
    'late. A declaration that arrives after the deferral expires still promotes the row to declared '
    'on the exact user message id. NULL on every row written before this column existed, and readers '
    'partition those on the old proxy (a NULL delivery_option meant the sweep minted them).';

COMMENT ON COLUMN turn_events.turn_id_source IS
    'declared | paired. How this row was bound to its turn, NOT how its instant was observed. '
    'declared - the turn id came from the turn itself, through the correlation marker it posted. '
    'paired - the binding was derived from the exchange pairing, because the processor is never given '
    'the user Chime MessageId. A paired binding therefore inherits the provenance of the exchange it '
    'came from, a swept one included, so a v_turn_latency row with anchor_source = ledger and '
    'turn_id_source = paired is NOT an independently measured anchor: getLatencyMetrics asks both '
    'columns and falls through to the exchange when the binding was paired. Rows state which, rather '
    'than implying a declared key.';
