-- ROLE AND PROFILE VERSION BECOME DIMENSIONS, so "which assistant" can be asked precisely.
--
-- `agent_type` names the assistant (migration 055). Two questions an operator asks next had no
-- answer: which ROLE that assistant occupies, and which VERSION of its profile produced the turn.
--
-- ROLE did not exist anywhere - not in the profile config, not in the schema. One role is declared
-- today (`primary`), which is exactly why it is recorded now rather than later: a dimension added
-- after a second role exists can only describe traffic from the day it shipped, and the comparison
-- worth having is across the change. An alt occupies the SAME role (`alt-{role}`), so occupancy is a
-- different question and is deliberately not recorded here - the classification's processor serves
-- both occupants and cannot tell them apart from its own environment.
--
-- VERSION was declared, rendered, and never written. `profileVersion` has been on the analytics
-- metadata and in the console's L1 view since profile versioning shipped, and the only thing that
-- ever wrote it was the manual backfill tool: the resolver read the active version and discarded the
-- parameter version it came back with. So "which version produced this" was blank on every live turn.
-- `profile_config_id` is promoted alongside it out of the metadata JSONB, where it was readable only
-- through a MODE() over a JSON key - unindexable, and unusable as a filter.
--
-- TWO COLUMNS BECAUSE THEY ANSWER TWO QUESTIONS. `profile_version` is the operator's handle: the
-- number the Profiles tab lists and rolls back to, monotonic within one deployment. `config_id`
-- fingerprints what the version SAYS, so it is comparable ACROSS deployments and identical for two
-- versions with the same body. Keeping only one would silently answer the other question wrong.
--
-- BACKFILL: `profile_config_id` and `profile_version` come from the metadata JSONB already recorded
-- per message. Role is NOT backfilled - no turn before this declared one, and writing 'primary'
-- everywhere would make history indistinguishable from a turn that actually said so, which is the
-- substitution that let a classification stand in for an assistant in the first place. NULL is the
-- honest record of a dimension that did not exist yet.

ALTER TABLE messages  ADD COLUMN IF NOT EXISTS assistant_role    VARCHAR(32);
ALTER TABLE messages  ADD COLUMN IF NOT EXISTS profile_version   INTEGER;
ALTER TABLE messages  ADD COLUMN IF NOT EXISTS profile_config_id VARCHAR(64);

ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS assistant_role    VARCHAR(32);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS profile_version   INTEGER;
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS profile_config_id VARCHAR(64);

COMMENT ON COLUMN exchanges.assistant_role IS
  'The role the answering assistant occupies in its classification (primary today). NULL for a turn '
  'that declared none - never a defaulted primary. Not the occupancy: an alt occupies the same role.';
COMMENT ON COLUMN exchanges.profile_version IS
  'The SSM parameter version of the profile that produced the turn - the number the Profiles tab '
  'lists and rolls back to. Per deployment. See profile_config_id for the cross-deployment handle.';
COMMENT ON COLUMN exchanges.profile_config_id IS
  'Fingerprint of what the profile version SAYS. Identical for two versions with the same body, and '
  'stable across deployments, which the version number is not.';

-- ── BACKFILL FROM WHAT WAS ALREADY RECORDED ─────────────────────────────────────────────────────
UPDATE messages m
   SET profile_config_id = COALESCE(m.profile_config_id, m.metadata->>'profileConfigId'),
       profile_version   = COALESCE(m.profile_version, NULLIF(m.metadata->>'profileVersion', '')::int)
 WHERE (m.metadata->>'profileConfigId' IS NOT NULL OR m.metadata->>'profileVersion' IS NOT NULL)
   AND (m.profile_config_id IS NULL OR m.profile_version IS NULL);

-- Exchanges take theirs from the message that answered, which is where they are recorded.
UPDATE exchanges ex
   SET profile_config_id = COALESCE(ex.profile_config_id, m.profile_config_id),
       profile_version   = COALESCE(ex.profile_version, m.profile_version),
       assistant_role    = COALESCE(ex.assistant_role, m.assistant_role)
  FROM messages m
 WHERE m.id = ex.agent_message_id
   AND (m.profile_config_id IS NOT NULL OR m.profile_version IS NOT NULL OR m.assistant_role IS NOT NULL)
   AND (ex.profile_config_id IS NULL OR ex.profile_version IS NULL OR ex.assistant_role IS NULL);

-- Filters land on (dimension, time) the same way the classification index does.
CREATE INDEX IF NOT EXISTS idx_exchanges_assistant_role_created
    ON exchanges(assistant_role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exchanges_profile_version_created
    ON exchanges(profile_version, created_at DESC);
