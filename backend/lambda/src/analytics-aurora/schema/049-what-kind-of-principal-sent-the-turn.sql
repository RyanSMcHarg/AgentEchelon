-- WHAT KIND OF PRINCIPAL SENT THE TURN.
--
-- Analytics has always recorded what a turn was SERVED at (`agent_type`), what classification it ran
-- under (`user_type`), and since migration 046 what the caller was cleared for (`user_clearance`).
-- All three are points on ONE axis - classification. Nothing recorded the other axis: whether the
-- sender was a person, an administrator acting on the admin plane, a federated sender from an
-- embedded widget, or an assistant. `messages.is_bot` was the entire vocabulary.
--
-- ── WHY THAT GAP WAS INVISIBLE ────────────────────────────────────────────────────────────────────
--
-- `user_type` reads like it answers this and does not. It is a classification, and on the exchange
-- table it resolved to the literal string 'unknown' for 198 of 200 rows measured 2026-09-14 - because
-- a person's message arrives from Amazon Chime SDK carrying no AE metadata at all, so every
-- producer-declared field on that row is NULL and the COALESCE fell straight through to its default.
-- A column named for the user, that never described one, sitting at a value that looked like missing
-- data rather than a missing concept.
--
-- ── WHY THIS ONE CAN BE POPULATED WHEN THE OTHERS COULD NOT ───────────────────────────────────────
--
-- Because it is structural rather than temporal. A clearance MOVES - a classification change rewrites
-- a person's groups and re-stamps their identity tag - so it can only ever be declared by the
-- producer at the moment the turn runs, which is exactly what migration 046 says and why it refuses a
-- backfill. A role does not move. It is legible in the sender ARN itself: whether the ARN names a
-- `/user/` or a `/bot/`, whether the id is the deployment's admin identity, whether it carries the
-- federated prefix. So archival resolves it when it writes the row, a late pairing and a live one
-- reach the same answer, and a person's own message can carry it despite declaring nothing.
--
-- The rules live in one place, `lambda/src/lib/principal-role.ts`, shared with the membership audit -
-- which had the same taxonomy and was the only thing that knew it.
--
-- ── WHAT IT MAKES ANSWERABLE ──────────────────────────────────────────────────────────────────────
--
-- How much of the traffic in each classification comes from people rather than from the admin plane;
-- whether federated senders behave like members; which populations the evaluation scores are actually
-- averaging over. Each of those was previously a question about a column that said 'unknown'.
--
-- `guest` is deliberately not a value. A guest today IS a federated sender - provisioned into one
-- conversation and unable to reach another - so `federated` names them. A deployment that declares a
-- guest classification adds the role beside it, in the one place the rules live.
--
-- NULL means the row predates this column. 'unknown' means the sender ARN could not be read, which is
-- a defect to chase and never a default - no reader may treat either as a role.
--
-- Idempotent and additive. No backfill of existing rows here: the ARNs are still on them, so a
-- backfill is possible later and is a deliberate act rather than a side effect of a deploy.

ALTER TABLE messages  ADD COLUMN IF NOT EXISTS user_role VARCHAR(16);
ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS user_role VARCHAR(16);

-- The question is "which populations is this traffic coming from, over time", so the index carries
-- the date alongside the role. Not partial: unlike `user_clearance`, most rows will have a value.
CREATE INDEX IF NOT EXISTS idx_messages_user_role_created  ON messages(user_role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exchanges_user_role_created ON exchanges(user_role, created_at DESC);

COMMENT ON COLUMN messages.user_role IS
    'What KIND of principal sent this message - user, admin, federated, bot - derived from the sender '
    'ARN by lambda/src/lib/principal-role.ts. Structural and stable, unlike user_clearance, so it is '
    'resolved at archival rather than declared by the producer. Distinct from user_type and '
    'user_clearance, which are classifications. NULL predates the column; ''unknown'' means the ARN '
    'could not be read and is never a default.';

COMMENT ON COLUMN exchanges.user_role IS
    'The role of the principal whose message opened this exchange, carried from messages.user_role. '
    'The role axis, never a classification - see user_type for what the turn ran at.';
