-- 091: a turn records the NAME of the definition that served it, beside its version and config id.
--
-- Migration 056 promoted `profile_version` and `profile_config_id` out of the metadata JSONB into columns,
-- and archival writes both from the turn's analytics record. The name stayed a metadata key, read as
-- `metadata->>'profileName'`. In Aurora mode the Chime Metadata is the slim set the client receives, and
-- the full analytics record (the name included) is merged into the metadata of the event that reads it,
-- which for an answered turn is its UPDATE. The row an exchange joins to is the placeholder's CREATE, and
-- only columns fold onto it (`backfillFromUpdateEvents`), so on that row the key is empty: a version number
-- with no name to say whose version it is.
--
-- THE NAME IS NOT THE ASSISTANT. `assistant` is the identity that answered; `profile_name` is the
-- definition that served. They agree on an ordinary turn and differ on an experiment's treatment, which is
-- served from the candidate in the alt's history under the live identity, and on a cross-assistant
-- variant. A version number is per definition, so only the pair (profile_name, profile_version) says which
-- version served.
--
-- NO BACKFILL. The only rows whose metadata holds the name are those the manual profile backfill wrote,
-- and every reader takes the column first and the metadata key after it, so those rows already read
-- correctly. Rows archived before this have no name anywhere to recover; NULL is the honest record.
--
-- Idempotent and transaction-safe: applied at runtime on a cold start inside one transaction.

ALTER TABLE messages  ADD COLUMN IF NOT EXISTS profile_name VARCHAR(128);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS profile_name VARCHAR(128);

COMMENT ON COLUMN exchanges.profile_name IS
  'The name of the profile definition that served the turn: the live assistant''s on an ordinary turn, '
  'the candidate''s on an experiment treatment. Not the answering assistant (see assistant). With '
  'profile_version it names the version that served; NULL on a turn archived without attribution.';
