/**
 * OFFBOARDING'S REACH INTO THE AURORA PROJECTION (SPEC-CREDENTIAL-EXCHANGE §5b, ADR-058).
 *
 * Offboarding runs outside this VPC, so it asks the data plane (`op: 'erasePerson'`, tenet D8: the existing
 * seam, never a VPC endpoint), and this deletes, in ONE transaction, the rows that exist only because of the
 * person, keyed by their AppInstanceUser id:
 *
 *  - `channel_membership`: the projection of memberships the erasure already removed in the Amazon Chime SDK;
 *  - `conversation_creation_tasks`: a conversation the person was offered and had not answered;
 *  - `cross_conversation_context`: what the person's other conversations were about, kept to brief them;
 *  - `meeting_events`: what the person did in each meeting (joined, left, shared a screen), by `person_key`.
 *
 * The last two are bounded tables under forced row-level security (`BOUNDED_TABLES`), whose only write policy admits the
 * writer role, so their rows are deleted as that role (`SET LOCAL ROLE`, released with the transaction); a delete as any
 * other identity matches no row.
 *
 * The conversation's own record is KEPT, as the archive it projects is kept until it expires: `messages` and
 * `exchanges` (what was said, whose content is redacted through the redact and delete path), `client_events`
 * (which holds the `offboarding` and `export` records themselves) and `drift_events` (a conversation's drift
 * decisions, which store no message body). Their `person_id` stops resolving to anybody once the
 * AppInstanceUser is erased, as the archive's sender ARN does.
 *
 * Idempotent: a second run finds nothing and removes nothing, so offboarding's retry continues safely.
 */
import { transaction } from './db-client.js';
import { WRITER_ROLE } from './classification-boundary-sql.js';

/** The person's own rows: each table, the column that names them, and whether it is a bounded table the writer deletes from. */
export const PERSON_OWN = [
  { table: 'channel_membership', column: 'person_id', bounded: false },
  { table: 'conversation_creation_tasks', column: 'person_id', bounded: false },
  { table: 'cross_conversation_context', column: 'person_id', bounded: true },
  { table: 'meeting_events', column: 'person_key', bounded: true },
] as const;

/** The tables whose rows are the person's own, erased with them. In the order they are deleted. */
export const PERSON_OWN_TABLES = PERSON_OWN.map((t) => t.table);
export type PersonOwnTable = (typeof PERSON_OWN)[number]['table'];

/** The tables that carry `person_id` and are kept with the conversation's record. */
export const PERSON_KEPT_TABLES = ['messages', 'exchanges', 'client_events', 'drift_events'] as const;

export interface ErasePersonResult {
  removed: number;
  byTable: Record<PersonOwnTable, number>;
}

/** A person id is the bare AppInstanceUser id: no separator, no wildcard, never empty. */
const PERSON_ID = /^[A-Za-z0-9_.@-]{1,128}$/;

export async function erasePersonProjection(input: { personId?: unknown }): Promise<ErasePersonResult> {
  const personId = typeof input?.personId === 'string' ? input.personId.trim() : '';
  if (!PERSON_ID.test(personId)) throw new Error('erasePerson: a person id is required');
  return transaction(async (client) => {
    const byTable = {} as Record<PersonOwnTable, number>;
    let removed = 0;
    let asWriter = false;
    for (const { table, column, bounded } of PERSON_OWN) {
      // The bounded tables come last, deleted as the writer role for the rest of the transaction.
      if (bounded && !asWriter) {
        await client.query(`SET LOCAL ROLE ${WRITER_ROLE}`);
        asWriter = true;
      }
      // The table and column are the constants above, never input.
      const r = await client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [personId]);
      byTable[table] = r.rowCount ?? 0;
      removed += byTable[table];
    }
    return { removed, byTable };
  });
}
