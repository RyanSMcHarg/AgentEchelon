/**
 * ADR-028 runtime side: assuming a classification's database role for the duration of one query.
 *
 * The SQL that CREATES the boundary lives in `classification-boundary-sql.ts`, which imports nothing
 * but the profile registry. The split is not cosmetic: `db-client.ts` applies those statements inside
 * the same transaction as the migrations, and the helpers here are built ON `db-client.transaction()`,
 * so keeping them in one module would be a genuine import cycle. It also means the generator - the
 * part with the security properties worth pinning - is unit-testable without a database anywhere near
 * it.
 *
 * WHY EVERY ROLE ASSUMPTION IS TRANSACTION-SCOPED. `db-client.query()` runs on a POOLED connection and
 * opens no transaction. A bare `SET ROLE` there would persist on that connection and be inherited by
 * the NEXT Lambda invocation, possibly serving a different classification - the fix creating the leak
 * it exists to prevent. (`SET LOCAL` outside a transaction is separately useless: a no-op with a
 * warning.) So these run through `transaction()`, where `SET LOCAL` is released at COMMIT, with an
 * explicit `RESET ROLE` as a second guard.
 */

import { transaction } from './db-client.js';
import { WRITER_ROLE, readerRoleFor } from './classification-boundary-sql.js';
import type { PoolClient } from 'pg';

export {
  BOUNDED_TABLES,
  WRITER_ROLE,
  readerRoleFor,
  scopeFunctionSql,
  boundaryStatements,
} from './classification-boundary-sql.js';

/**
 * Run `fn` with the connection's role set to the reader for `classification`.
 *
 * The classification travels as a PRINCIPAL, not as a parameter the query is trusted to apply. That
 * is the entire point: the caller can still pass a wrong or missing `classificationScope` to the
 * query it runs inside here, and the database will still refuse to hand back a row above this role's
 * ladder.
 */
export async function withReaderRole<T>(
  classification: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withRole(readerRoleFor(classification), fn);
}

/** Run `fn` as the write role. Every INSERT/UPDATE/DELETE on a bounded table goes through this. */
export async function withWriterRole<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withRole(WRITER_ROLE, fn);
}

async function withRole<T>(role: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  assertSafeRoleName(role);
  return transaction(async (client) => {
    try {
      // SET LOCAL: scoped to this transaction, released at COMMIT/ROLLBACK.
      await client.query(`SET LOCAL ROLE ${role}`);
      return await fn(client);
    } finally {
      // Belt and braces. COMMIT/ROLLBACK already drops a SET LOCAL and `transaction()` releases the
      // client either way - but the cost of either of those being wrong is a pooled connection
      // carrying a classification into the next invocation, so it is worth the extra round trip.
      await client.query('RESET ROLE').catch(() => {});
    }
  });
}

/**
 * Role names are interpolated into `SET LOCAL ROLE`, where a bind parameter is not accepted. The name
 * is already built by `readerRoleFor` from a validated classification value; this is the second check,
 * on the value that actually reaches the SQL.
 */
function assertSafeRoleName(role: string): void {
  if (!/^ae_[a-z][a-z0-9_]{0,48}$/.test(role)) {
    throw new Error(`[classification-boundary] refusing to assume an unrecognized role: ${JSON.stringify(role)}`);
  }
}
