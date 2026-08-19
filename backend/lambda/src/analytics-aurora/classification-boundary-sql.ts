/**
 * ADR-028: the vector store's classification boundary, as a database privilege.
 *
 * Retrieval reaches the model on every turn, and until this module its boundary was a `WHERE`
 * clause: one database identity, one shared table, and a filter that had to be written - and written
 * correctly - at every call site that would ever exist. Every OTHER classification boundary in
 * `SPEC-CONVERSATION-SECURITY` survives a wrongly written query because the principal lacks the
 * permission. This makes retrieval match that bar: a forgotten or widened filter becomes an empty
 * result, because the privilege is not there to widen to.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREE THINGS THAT MAKE THIS NON-OBVIOUS. Each one, done the natural way, produces a boundary
 * that looks correct, passes a green test run, and enforces nothing.
 *
 * 1. **`FORCE ROW LEVEL SECURITY`, not merely `ENABLE`.** Postgres exempts a table's OWNER from its
 *    own policies. Migrations create these tables as the master user and the data-plane connects as
 *    that same user, so `ENABLE` alone attaches policies that are bypassed on every single query -
 *    this ADR's own failure mode wearing a fix's clothes.
 *
 * 2. **The policy predicate keys on `current_user`, NOT on a policy role list.** The natural spelling
 *    is `CREATE POLICY ... TO ae_reader_premium USING (...)`. Postgres matches that policy by role
 *    MEMBERSHIP (`pg_has_role`), and `SET ROLE` requires the connecting user to be a member of the
 *    target role - so granting the membership that makes `SET LOCAL ROLE` legal simultaneously makes
 *    the premium policy apply to `evaladmin`'s own unroled queries. The boundary would read as built
 *    and admit everything to the identity that does all the work.
 *
 *    So the policies are declared `TO PUBLIC` and discriminate inside the predicate on `current_user`,
 *    which `SET LOCAL ROLE` changes and mere membership does not. An unroled query by the owner
 *    resolves to the empty scope and reads nothing.
 *
 *    **DO NOT "FIX" THIS TO `TO <role>` POLICIES ON A NEWER ENGINE.** Postgres 16 adds
 *    `GRANT ... WITH INHERIT FALSE`, which makes the role-targeted form safe, and Aurora here is
 *    15.10 - so this reads like a version workaround waiting to be undone. It is not. The
 *    role-targeted form puts the security property in the GRANT rather than in the policy:
 *
 *        GRANT ae_reader_premium TO evaladmin WITH INHERIT FALSE;  -- boundary holds
 *        GRANT ae_reader_premium TO evaladmin;                     -- boundary silently opens
 *
 *    Both leave a policy that reads identically. A re-grant during maintenance, or a migration that
 *    re-runs the grant without the option, reopens the boundary with no error and no visible diff
 *    where the rule is written - exactly the silent-failure class this whole ADR exists to remove.
 *    The `current_user` predicate is self-contained: the entire rule is visible at the point of
 *    enforcement and no grant option can undermine it. It is the preferred form on ANY version, and
 *    the engine constraint is why it was found, not why it was chosen.
 *
 * 3. **`SET LOCAL ROLE`, never a bare `SET ROLE`.** `db-client.query()` runs on a POOLED connection
 *    and opens no transaction. A bare `SET ROLE` there persists on the connection and is inherited by
 *    the NEXT Lambda invocation, possibly at a different classification - the fix creating the leak it
 *    exists to prevent. (`SET LOCAL` outside a transaction is separately useless: it is a no-op with a
 *    warning.) Every role assumption below therefore runs inside `transaction()`, where `SET LOCAL` is
 *    released at COMMIT, with an explicit `RESET ROLE` as a second guard.
 * ---------------------------------------------------------------------------------------------
 *
 * WHY THE SQL IS GENERATED AND NOT A STATIC `schema/NNN-*.sql`. Classifications are deployment
 * configuration (`config/profiles.ts`), not constants: a deployment may rename them, add one, or ship
 * a different ladder. The CDK already generates per-classification IAM from this same registry
 * precisely so a renamed classification cannot drift IAM apart from retrieval
 * (`contextPrefixesAtOrBelow`). A hardcoded `ae_reader_basic|standard|premium` in a `.sql` file would
 * reintroduce exactly that drift on the one path where the consequence is a cross-classification read.
 * The ladder each role may read is `scopeAtOrBelow`, the same resolver retrieval and IAM consume.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not replace the existing `WHERE` filters. ADR-028 keeps
 * them as defence in depth: a correct query AND a correct privilege, so either one failing alone is
 * survivable. It also does not fix ingest-time MISLABELLING - content written to the wrong
 * classification is served faithfully from it, and that is a separate control.
 */

import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry.js';
import type { ProfileRegistry } from '../../../lib/profile-registry.js';

/** The tables whose rows are partitioned by classification. Both carry a `classification` column. */
export const BOUNDED_TABLES = ['embeddings', 'summary_embeddings'] as const;

/**
 * The single write role. Every writer assumes it; the owner is NOT given a write policy, because a
 * permissive owner policy is indistinguishable from the `ENABLE`-without-`FORCE` hole this exists to
 * close - the defeat test asserts an unroled owner query reads nothing, and an owner policy would
 * hand it back the whole table.
 */
export const WRITER_ROLE = 'ae_writer';

/**
 * The runtime login role. Every Lambda query connects as this; nothing connects as the master user
 * except migrations and this bootstrap.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A WORKAROUND. When the runtime connected as `evaladmin` the
 * live verification failed its owner-defeat check: an unroled query read every row despite
 * `relforcerowsecurity` being true, with no `BYPASSRLS` on the role and correct policies in the
 * catalog. That behaviour was never explained (ADR-028, "Verification: what the run found"). A
 * non-owner does not depend on the explanation: row-level security applies to it through the ordinary
 * path, with no reliance on FORCE or on owner-exemption semantics.
 *
 * It is also the separation that should have existed anyway. `evaladmin` was the master user, the
 * owner of every table, the migration runner AND the query identity at once, so a wrongly written
 * runtime query carried authority to drop the table it was reading.
 *
 * NOLOGIN IS WRONG HERE, unlike the reader and writer roles: this one is connected to directly, with
 * an IAM auth token, so it needs LOGIN and membership of `rds_iam`.
 */
export const APP_ROLE = 'ae_app';

/**
 * Reader role for a classification. One per declared classification, named from its value.
 *
 * VALIDATED AGAINST THE REGISTRY, NOT JUST A CHARACTER CLASS. The first version of this checked only
 * `SAFE_IDENTIFIER.test(classification)`, and `RegExp.test` COERCES its argument - so `test(undefined)`
 * examines the string `"undefined"`, which is a perfectly well-formed lowercase identifier and passes.
 * A caller that omitted the field therefore got a confidently-constructed `ae_reader_undefined`, and
 * the failure surfaced far away as `role "ae_reader_undefined" does not exist`, on the database, once
 * per turn. Caught in the live e2e (2026-08-12) after it had already shipped.
 *
 * A classification that this deployment does not declare has no role and never will, so this throws
 * rather than returning a name that cannot work. The character-class check stays as the second gate,
 * because the value is interpolated into DDL where a bind parameter is not accepted.
 */
export function readerRoleFor(classification: string, registry: ProfileRegistry = profiles): string {
  if (typeof classification !== 'string' || !registry.isKnownClassification(classification)) {
    throw new Error(
      `[classification-boundary] no reader role for ${JSON.stringify(classification)}: it is not a `
      + `classification this deployment declares (${registry.classificationValues().join(', ')}). `
      + 'A missing or misspelled classification is a wiring fault, not a value to build a role name from.',
    );
  }
  assertSafeIdentifier(classification);
  return `ae_reader_${classification}`;
}

/**
 * Role names are interpolated into DDL (`CREATE ROLE`, `GRANT`) where a bind parameter is not
 * accepted, so the classification value they are built from is validated rather than trusted. The
 * value comes from deployment config, not from user input, which makes this a defence against a
 * careless config edit rather than against an attacker - but a boundary that is only correct when its
 * configuration is well-formed is worth exactly as much as the config review that never happened.
 */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,40}$/;

function assertSafeIdentifier(value: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `[classification-boundary] refusing to build a role name from ${JSON.stringify(value)}: `
      + 'a classification value must match /^[a-z][a-z0-9_]{0,40}$/ to be used as a SQL identifier.',
    );
  }
}

/**
 * How many unstamped rows the fail-closed stamp converts per application (step 6 below).
 *
 * A single-column write is cheap per row, so this is generous - the point is only that the statement
 * has a ceiling at all, since it runs inside the shared cold-start migration transaction.
 */
const NULL_STAMP_BATCH = 20000;

/** A Postgres string literal. Used for the scope arrays baked into the mapping function. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The scope-resolution function the policies call.
 *
 * It maps a ROLE NAME to the classification values that role may read, straight from
 * `scopeAtOrBelow` - so the ladder is expressed once and a config change moves the privilege with it.
 *
 * `ELSE ARRAY[]::text[]` is the load-bearing line: any identity that is not one of the declared
 * reader roles - the owner on an unroled query, a future Lambda connecting as something else, a role
 * someone adds by hand - resolves to the EMPTY scope and matches no row. Fail-closed by construction
 * rather than by remembering to add a case.
 *
 * `STABLE` (not `VOLATILE`) so the planner may cache it per statement instead of calling it per row.
 * `search_path` is pinned to `pg_catalog` so the body cannot be redirected by a caller's search_path.
 */
export function scopeFunctionSql(registry: ProfileRegistry = profiles): string {
  const branches = registry
    .classificationValues()
    .map((value) => {
      const scope = registry.scopeAtOrBelow(value).map(sqlLiteral).join(', ');
      return `    WHEN ${sqlLiteral(readerRoleFor(value, registry))} THEN ARRAY[${scope}]::text[]`;
    })
    .join('\n');

  return `CREATE OR REPLACE FUNCTION ae_classification_scope(role_name text)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $fn$
  SELECT CASE role_name
${branches}
    ELSE ARRAY[]::text[]
  END
$fn$;`;
}

/**
 * Every statement that establishes the boundary, in dependency order.
 *
 * ALL of it is idempotent and transaction-safe: it runs at Lambda cold start on fresh AND existing
 * clusters, alongside `applyPendingMigrations`, so a re-run must converge rather than fail. Postgres
 * has no `CREATE ROLE IF NOT EXISTS`, hence the `DO $$` guards.
 */
export function boundaryStatements(registry: ProfileRegistry = profiles): string[] {
  const classifications = registry.classificationValues();
  const readerRoles = classifications.map((c) => readerRoleFor(c, registry));
  const statements: string[] = [];

  // 1. The roles. NOLOGIN: these are assumed via SET LOCAL ROLE by an already-authenticated
  //    connection, never connected to directly, so none of them needs (or should have) a credential.
  for (const role of [...readerRoles, WRITER_ROLE]) {
    statements.push(
      `DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlLiteral(role)}) THEN
    CREATE ROLE ${role} NOLOGIN;
  END IF;
END $do$;`,
    );
  }

  // 2. Membership, so the connecting identity may SET LOCAL ROLE into them. On PG15 this also makes
  //    the connecting identity INHERIT their privileges, which is harmless here only because the
  //    policies discriminate on `current_user` rather than on membership (see the header, point 2).
  //    `CURRENT_USER` is resolved at apply time so this holds whatever the deployment named its user.
  for (const role of [...readerRoles, WRITER_ROLE]) {
    statements.push(
      `DO $do$ BEGIN
  EXECUTE format('GRANT %I TO %I', ${sqlLiteral(role)}, CURRENT_USER);
END $do$;`,
    );
  }

  // 2b. The runtime login role, and its membership of the reader/writer roles so it may assume them.
  //
  //     THE ORDERING IS THE POINT. This bootstrap runs as the OWNER, on the admin pool, before any
  //     runtime query. On a fresh cluster that is what resolves the chicken-and-egg: the role the
  //     Lambdas connect as does not exist until the identity that can create it has done so.
  //
  //     `rds_iam` is what makes IAM token auth work for this user. Granting it also DISABLES password
  //     auth for the role, which is intended: the runtime should have no password to leak.
  statements.push(
    `DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlLiteral(APP_ROLE)}) THEN
    CREATE ROLE ${APP_ROLE} LOGIN;
  END IF;
END $do$;`,
  );
  statements.push(
    `DO $do$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam') THEN
    EXECUTE format('GRANT rds_iam TO %I', ${sqlLiteral(APP_ROLE)});
  END IF;
END $do$;`,
  );
  // Membership so the runtime can SET LOCAL ROLE into a reader or the writer. Inheriting their
  // privileges is harmless BECAUSE the policies key on `current_user` rather than on membership: an
  // unroled runtime query resolves to the empty scope regardless of what it inherits.
  for (const role of [...readerRoles, WRITER_ROLE]) {
    statements.push(
      `DO $do$ BEGIN
  EXECUTE format('GRANT %I TO %I', ${sqlLiteral(role)}, ${sqlLiteral(APP_ROLE)});
END $do$;`,
    );
  }

  // 3. Table privileges. RLS narrows what a role may see; it does not grant access in the first
  //    place, so without these the policies would never be reached and every read would fail on
  //    permission instead of returning a scoped result.
  //
  //    The runtime role gets DML on every table because it serves roughly two dozen data-plane ops
  //    over the whole analytics schema, not just the two bounded ones. What it deliberately does NOT
  //    get is ownership or DDL: it cannot create, alter or drop, which is the separation this role
  //    exists for. On the two bounded tables this grant is the floor, not the ceiling, since RLS then
  //    narrows it to nothing until a reader or writer role is assumed.
  //
  //    ALTER DEFAULT PRIVILEGES covers tables a LATER migration creates. Without it, the runtime
  //    would lose access to every new table the moment it was added, and the failure would surface as
  //    a permission error on a code path nobody associates with this bootstrap.
  statements.push(`GRANT USAGE ON SCHEMA public TO ${[...readerRoles, WRITER_ROLE, APP_ROLE].join(', ')};`);
  statements.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};`);
  statements.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};`);
  statements.push(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};`,
  );
  statements.push(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE};`,
  );
  for (const table of BOUNDED_TABLES) {
    statements.push(`GRANT SELECT ON ${table} TO ${readerRoles.join(', ')};`);
    statements.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${WRITER_ROLE};`);
  }

  // 4. The scope mapping the policies call.
  statements.push(scopeFunctionSql(registry));

  // 5. RLS itself, plus the policies. FORCE is the difference between a boundary and a decoration.
  for (const table of BOUNDED_TABLES) {
    // CONDITIONAL, because `ALTER TABLE` takes an ACCESS EXCLUSIVE lock whether or not it changes
    // anything. These run inside the migration transaction on EVERY cold start of every analytics
    // Lambda that calls `ensureSchema()`, and `embeddings` / `summary_embeddings` are the tables
    // retrieval and drift read on the request path - so a burst of cold starts parked concurrent
    // readers behind a no-op that was already true. Reading `pg_class` first keeps the DDL idempotent
    // and makes the common path lock-free; the boundary is unchanged, it is just not re-asserted when
    // it already holds.
    statements.push(`DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = '${table}'::regclass AND relrowsecurity AND relforcerowsecurity
  ) THEN
    EXECUTE 'ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE ${table} FORCE ROW LEVEL SECURITY';
  END IF;
END $$;`);

    // Read: the row's classification must be in the current role's ladder. An identity with no
    // ladder (the owner unroled, anything unknown) gets the empty array and matches nothing.
    statements.push(`DROP POLICY IF EXISTS ${table}_classification_read ON ${table};`);
    statements.push(
      `CREATE POLICY ${table}_classification_read ON ${table}
  FOR SELECT
  TO PUBLIC
  USING (classification = ANY (ae_classification_scope(CURRENT_USER::text)));`,
    );

    // Write: only the writer role, and only it. Permissive policies OR together, so this also lets
    // the writer read - which it needs, for the ingestion etag check and the ON CONFLICT upsert.
    statements.push(`DROP POLICY IF EXISTS ${table}_writer ON ${table};`);
    statements.push(
      `CREATE POLICY ${table}_writer ON ${table}
  FOR ALL
  TO PUBLIC
  USING (CURRENT_USER::text = ${sqlLiteral(WRITER_ROLE)})
  WITH CHECK (CURRENT_USER::text = ${sqlLiteral(WRITER_ROLE)});`,
    );
  }

  // 6. Fail-closed stamp for any row that predates its table's classification column.
  //
  //    NULL is ALREADY invisible to `classification = ANY(scope)` - NULL matches no scope - so this
  //    is belt and braces rather than the protection itself. It is here, and not in the `.sql` files
  //    that add the columns, because which value is most restrictive is deployment config that static
  //    SQL cannot read.
  //
  //    IT RUNS AS THE WRITE ROLE, and that is not incidental: by this point in the transaction FORCE
  //    ROW LEVEL SECURITY is on and the owner has no write policy, so the same UPDATE issued unroled
  //    would report success having touched ZERO rows. Every future migration that writes a bounded
  //    table has to do exactly this, which is why `migration-writer-role.test.ts` enforces it.
  //
  //    IT IS BOUNDED, because it shares one transaction with every pending migration inside one Lambda
  //    invocation and nothing commits unless all of it does. On the first upgrade of an existing
  //    deployment the column has just been added, so EVERY row is NULL and this would be a whole-table
  //    write - one that, if it outran the invocation, would discard the migrations alongside it and
  //    make the next cold start repeat the lot. Bounding it costs nothing that matters: this bootstrap
  //    re-runs on every cold start, so the stamp converges on its own, and the rows it has not reached
  //    yet are NULL, which is STRICTER than the value it is about to write, not looser.
  const mostRestrictive = registry.mostRestrictiveValue;
  assertSafeIdentifier(mostRestrictive);
  statements.push(`SET LOCAL ROLE ${WRITER_ROLE};`);
  for (const table of BOUNDED_TABLES) {
    statements.push(
      `UPDATE ${table} SET classification = ${sqlLiteral(mostRestrictive)}
  WHERE ctid IN (SELECT ctid FROM ${table} WHERE classification IS NULL LIMIT ${NULL_STAMP_BATCH});`,
    );
  }
  // MANDATORY. `applyPendingMigrations` and this bootstrap share one transaction per cold start, so a
  // SET LOCAL left standing here would be inherited by whatever ran next in it.
  statements.push('RESET ROLE;');

  return statements;
}

