-- ADR-028: give `summary_embeddings` the classification it never had, and a place to resolve one from.
--
-- WHAT WAS WRONG. Every conversation's summary embedding - basic, standard and premium alike - sat in
-- one classification-blind table. The classification was not merely unfiltered, it was NOT RECORDED,
-- so it could not be filtered on at all. What held the line was drift's membership intersection: live
-- Chime memberships, enforced inside the WHERE, fail-closed on an empty scope, returning a channel ARN
-- rather than content. That control is well built, but it means the ENTIRE boundary for conversation
-- summaries was one caller passing the right ARN list, with nothing in the data for a second reader -
-- a new feature, a backfill, an admin query - to check against.
--
-- MEMBERSHIP IS NOT CLASSIFICATION, which is why filtering by it is not enough. Two premium-cleared
-- people talking in a BASIC channel have premium channels in their membership intersection, so drift
-- can point from a basic channel at a premium one. Nobody learns anything they could not already open,
-- but the platform's model is that the CHANNEL's classification bounds what may surface in it - which
-- is why the assistant is classification-scoped per channel. Membership protects the people; it does
-- not protect the channel.
--
-- THIS FILE IS DDL ONLY. It deliberately hardcodes no classification VALUE. The fail-closed backfill
-- that stamps existing rows, and the RLS policies over this column, are generated from the deployment's
-- own classification registry (`classification-boundary.ts`) - static SQL cannot read that config, and
-- a hardcoded ladder here is precisely the drift the registry exists to prevent.
--
-- IDEMPOTENT + TRANSACTION-SAFE (required: this auto-applies at Lambda cold start on fresh AND
-- existing clusters, inside one shared transaction with every other pending migration).

ALTER TABLE summary_embeddings ADD COLUMN IF NOT EXISTS classification TEXT;

-- The RLS predicate reads this column on every row the scan considers, and drift's cosine-NN lookup
-- already filters by channel ARN, so the classification filter needs its own access path.
CREATE INDEX IF NOT EXISTS idx_summary_embeddings_classification
    ON summary_embeddings (classification);

COMMENT ON COLUMN summary_embeddings.classification IS
    'ADR-028 isolation column. The classification of the channel this summary belongs to, resolved '
    'from Amazon Chime SDK Messaging (never from the archive - see channel_classification). NULL is '
    'invisible to retrieval by construction: the RLS predicate is `classification = ANY(scope)`, and '
    'NULL matches no scope.';

-- ---------------------------------------------------------------------------------------------
-- WHERE THE CLASSIFICATION COMES FROM, AND WHY IT NEEDS A TABLE AT ALL
--
-- The authority for a channel's classification is its immutable Amazon Chime SDK channel tag. Nothing
-- that writes `summary_embeddings` can read it: the Aurora VPC is provisioned with `natGateways: 0`
-- and interface endpoints for Kinesis, S3, Secrets Manager, DynamoDB and Bedrock Runtime only, so
-- summary-updater and the data-plane have NO route to the Chime SDK at all. Adding one is explicitly
-- not the answer; the platform's rule is to add an op to the data-plane seam instead.
--
-- So the read happens where Chime is reachable (outside the VPC, which is also where the router
-- already resolves a channel's classification on every turn) and arrives here as an op payload. This
-- table is that landing place: an in-VPC projection of an authoritative out-of-VPC read.
--
-- IT IS NOT ITSELF THE BOUNDARY, and must never be treated as one. The boundary is the
-- `classification` column above plus the RLS policy over it. This table only supplies the value at
-- write time, and when it has no answer the writer stamps the MOST RESTRICTIVE classification rather
-- than guessing - so a channel this table has never heard of produces a summary embedding that only
-- the top of the ladder can read. That is the fail-closed direction: withheld, never leaked.
--
-- `source` records provenance so a row seeded by a live router turn is distinguishable from one
-- recovered by the bulk Chime backfill, and so a future reader can tell how much to trust it.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_classification (
    channel_arn VARCHAR(256) PRIMARY KEY,
    classification VARCHAR(32) NOT NULL,
    source VARCHAR(32) NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE channel_classification IS
    'Channel ARN -> classification, resolved from Amazon Chime SDK Messaging outside the VPC and '
    'delivered through the data-plane. A projection that supplies the isolation value at write time; '
    'never the authority for a live access decision (ADR-012). Absent entry => most-restrictive.';
COMMENT ON COLUMN channel_classification.source IS
    'How this row was resolved: `router` (a live turn, authoritative at that moment) or `backfill` '
    '(the bulk Chime enumeration). Lets a reader weigh provenance instead of assuming it.';
