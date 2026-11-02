-- A RATE STATES THE POPULATION IT WAS COMPUTED OVER.
--
-- Evaluation scored EVERYTHING. `getUnscoredExchanges` took unscored rows ordered by age up to
-- `EVAL_MAX_PER_RUN`, and the cap's own comment says what it is: "the next run picks up the rest".
-- That is a timeout guard, not a sampling policy. Cost scaled with traffic, and the only lever
-- changed WHEN an exchange was judged, never WHETHER.
--
-- That was affordable while one cheap judge asked one question. It stops being affordable the moment
-- a second, more expensive question is added - groundedness has to re-read the retrieved context,
-- and pairwise judging costs two candidates and a comparison. Multiplying an unbounded population by
-- a bigger per-row cost is how an evaluation bill becomes the reason evaluation gets turned off.
--
-- STRATIFIED, WHICH IS THE PART THAT KEEPS IT HONEST. Sampling uniformly would dilute exactly the
-- rows worth reading: the ones somebody already flagged, and the ones the classifier was unsure
-- about. Those are taken ALWAYS. The rest are sampled at a recorded rate.
--
--   'always'  - a human flagged the response, or the classifier reported low confidence
--   'sampled' - drawn from the remainder at `sample_rate` percent
--
-- The stratum and the rate are recorded ON THE ROW, so a reader can state the population a figure
-- was computed over instead of inferring it. Without that, a relevance average silently mixes an
-- exhaustive early period with a sampled later one, and the change looks like quality moving.
--
-- A rate over the 'always' stratum is NOT a rate over traffic. It is a rate over the rows most
-- likely to be bad, by construction, and any reader combining the two strata has to weight them.
-- Recording the stratum is what makes that possible rather than a guess.
--
-- Runtime-applied migrations run inside ONE transaction, so everything here is idempotent and
-- transaction-safe (no CREATE INDEX CONCURRENTLY).
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS sample_stratum VARCHAR(16);

-- The percentage in force when the row was drawn. Kept per row rather than read from config at
-- query time, because the config is the CURRENT rate and a historical row was drawn under whatever
-- was set then. Null on the 'always' stratum, which is not sampled.
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS sample_rate SMALLINT;

CREATE INDEX IF NOT EXISTS idx_evaluation_results_sample_stratum
    ON evaluation_results(sample_stratum)
    WHERE sample_stratum IS NOT NULL;

COMMENT ON COLUMN evaluation_results.sample_stratum IS
  'Why this exchange was evaluated: always (human-flagged or low classifier confidence) or sampled (drawn from the remainder). NULL means the row predates stratified sampling, when everything was scored. A rate over one stratum is not a rate over traffic.';
COMMENT ON COLUMN evaluation_results.sample_rate IS
  'The sampling percentage in force when this row was drawn, 1-100. NULL on the always stratum, which is not sampled, and on rows that predate sampling.';
