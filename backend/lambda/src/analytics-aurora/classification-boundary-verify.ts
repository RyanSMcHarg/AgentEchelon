/**
 * ADR-028's owed verification, run against the REAL database.
 *
 * WHY THIS IS AN OP AND NOT A TEST FILE. Everything the boundary actually does happens inside
 * Postgres: `FORCE ROW LEVEL SECURITY`, policy evaluation, and what `current_user` resolves to after
 * `SET LOCAL ROLE`. A Jest suite can pin the SQL that gets generated - and
 * `classification-boundary.test.ts` does - but it cannot prove Postgres enforces it. Aurora sits in
 * isolated subnets with no public route, so the only thing that can ask it is a Lambda already in the
 * VPC: hence a data-plane op, invoked from a script, rather than a new endpoint or a peering hole.
 *
 * WHAT IT PROVES, AND WHY EACH ONE IS HERE. These are ADR-028's four requirements verbatim, plus the
 * owner case that the ADR calls out as the one most likely to fail:
 *
 *   1. NEGATIVE     - a low reader cannot see a high row. The boundary discriminates.
 *   2. DEFEAT       - the SAME query with the classification filter DELETED still cannot see it. This
 *                     is the only check that proves the boundary is the PRIVILEGE and not the clause.
 *                     Run as the owner too: without FORCE, that is the case that fails.
 *   3. NON-VACUITY  - an in-scope query still returns rows. A boundary that passes because it matches
 *                     nothing is the failure this is most likely to ship as, and it is invisible:
 *                     retrieval returning empty looks exactly like a corpus with nothing relevant.
 *   4. ROLE LEAK    - two queries in sequence on the same POOLED connection, premium then basic, with
 *                     the second seeing only basic. Pooling plus role switching is the specific way
 *                     this design can reintroduce the leak it removes.
 *
 * IT SEEDS ITS OWN PROBES rather than asserting over whatever the corpus happens to hold. Content
 * drifts; a deployment may have no premium documents on the day someone runs this, and then every
 * check passes for the wrong reason. The probes are written as the write role, asserted against, and
 * removed in a `finally` - so a failed run cleans up too.
 */

import { query, transaction } from './db-client.js';
import { withReaderRole, withWriterRole } from './classification-boundary.js';
import { readerRoleFor, BOUNDED_TABLES, WRITER_ROLE } from './classification-boundary-sql.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry.js';

export interface BoundaryCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerifyBoundaryResult {
  ok: boolean;
  checks: BoundaryCheck[];
  /** Echoed so a caller can tell WHICH ladder was proven, not just that something passed. */
  classifications: string[];
  probeSourceId: string;
}

/** Marks the probe rows. A source_type nothing else writes, so cleanup cannot touch real content. */
const PROBE_SOURCE_TYPE = 'boundary-probe';

/**
 * Say WHY an unroled read got through, because there are three distinct causes and they need
 * different fixes. A check that reports only "the boundary is not in effect" sends the next person
 * to re-read the policy, which is the one thing that is probably correct.
 *
 *   - `rolbypassrls` on the connecting role: no policy of any kind constrains it, `FORCE` included.
 *     This is the RDS-shaped cause, because the master user is where `rds_superuser` lands. The fix
 *     is to connect as a different role, not to change the policy.
 *   - `rolsuper`: same effect, different attribute.
 *     - neither set, but `relforcerowsecurity` false: the ALTER did not take, or something re-created
 *     the table afterwards. This is the only cause the policy SQL itself can fix.
 *   - all three fine: the predicate is matching when it should not, which is a policy bug.
 */
async function diagnoseOwnerBypass(): Promise<string> {
  try {
    const who = await query<{
      current_user: string; is_super: boolean; bypasses_rls: boolean;
    }>(
      `SELECT current_user AS current_user,
              rolsuper     AS is_super,
              rolbypassrls AS bypasses_rls
         FROM pg_roles WHERE rolname = current_user`,
    );
    const rel = await query<{ relname: string; rls: boolean; forced: boolean; owner: string }>(
      `SELECT c.relname,
              c.relrowsecurity      AS rls,
              c.relforcerowsecurity AS forced,
              pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [BOUNDED_TABLES as unknown as string[]],
    );
    const r = who.rows[0];
    const tables = rel.rows
      .map((t) => `${t.relname}{rls=${t.rls},forced=${t.forced},owner=${t.owner}}`)
      .join(' ');

    // THE ATTRIBUTE IS NOT ALWAYS ON THE ROLE THAT USES IT. `has_bypassrls_privilege` follows
    // INHERITED role membership, so a role whose own `rolbypassrls` is false still bypasses RLS if it
    // inherits from one that has it - which is the normal shape on RDS, where the master user is an
    // inheriting member of `rds_superuser`. Checking only the connecting role's own attributes reports
    // "not privileged" for an identity that is, in fact, exempt from every policy on the database.
    //
    // This is the same confusion the boundary itself had to design around: a privilege arriving
    // through membership rather than being visible on the principal.
    const inherited = await query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolname, rolbypassrls, rolsuper
         FROM pg_roles
        WHERE pg_has_role(current_user, oid, 'USAGE')
          AND (rolbypassrls OR rolsuper)
          AND rolname <> current_user`,
    );
    if (inherited.rows.length) {
      const via = inherited.rows
        .map((x) => `${x.rolname}(${x.rolbypassrls ? 'BYPASSRLS' : ''}${x.rolsuper ? 'SUPERUSER' : ''})`)
        .join(', ');
      return `CAUSE: '${r?.current_user}' INHERITS a row-security exemption from ${via}. Its own `
        + 'attributes are clean, which is why this looked like a policy bug - but has_bypassrls_privilege '
        + `follows inherited membership, so no policy constrains it and FORCE is irrelevant. The `
        + `policies are correct and DO bound every reader role (${tables}). The fix is to connect as a `
        + 'database user that is neither a member of that role nor the table owner.';
    }

    if (r?.bypasses_rls || r?.is_super) {
      return `CAUSE: the connecting role '${r.current_user}' holds `
        + `${r.bypasses_rls ? 'BYPASSRLS' : ''}${r.bypasses_rls && r.is_super ? ' and ' : ''}`
        + `${r.is_super ? 'SUPERUSER' : ''}, which exempts it from row-level security entirely - FORCE `
        + `cannot constrain it. The policies ARE in effect (${tables}) and do bound every reader role; `
        + 'what is missing is that the runtime connects as this privileged identity. The fix is a '
        + 'non-privileged, non-owning database user for the Lambdas, not a change to the policies.';
    }
    const unforced = rel.rows.filter((t) => !t.forced).map((t) => t.relname);
    if (unforced.length) {
      return `CAUSE: FORCE ROW LEVEL SECURITY is not set on ${unforced.join(', ')} (${tables}). The `
        + 'ALTER did not take, or the table was re-created after it ran.';
    }
    // Not a privilege problem and the flags are set, so the predicate itself is admitting rows.
    // Dump what Postgres actually has, plus what the scope function returns for this identity: a
    // policy that reads correctly in the generator and wrong in the catalog is the only thing left.
    const policies = await query<{
      policyname: string; permissive: string; roles: string; cmd: string; qual: string | null; with_check: string | null;
    }>(
      `SELECT policyname, permissive, roles::text AS roles, cmd, qual, with_check
         FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[])
        ORDER BY tablename, policyname`,
      [BOUNDED_TABLES as unknown as string[]],
    );
    const scope = await query<{ scope: string | null }>(
      `SELECT ae_classification_scope(current_user::text)::text AS scope`,
    );
    const rendered = policies.rows
      .map((p) => `${p.policyname}[${p.permissive}/${p.cmd}/to=${p.roles}] USING(${p.qual ?? 'null'})`
        + `${p.with_check ? ` CHECK(${p.with_check})` : ''}`)
      .join(' | ');
    return `CAUSE UNCLEAR: role '${r?.current_user}' is not privileged and ${tables}. `
      + `ae_classification_scope('${r?.current_user}') = ${scope.rows[0]?.scope ?? 'null'} `
      + `(empty array expected). POLICIES: ${rendered}`;
  } catch (err) {
    return `(diagnosis failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

export async function verifyClassificationBoundary(): Promise<VerifyBoundaryResult> {
  const classifications = profiles.classificationValues();
  const lowest = classifications[0];
  const highest = profiles.mostRestrictiveValue;
  const probeSourceId = `boundary-probe://${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const checks: BoundaryCheck[] = [];

  if (classifications.length < 2) {
    return {
      ok: false,
      classifications,
      probeSourceId,
      checks: [{
        name: 'ladder-has-two-rungs',
        passed: false,
        detail: `only ${classifications.length} classification declared; there is no boundary to verify.`,
      }],
    };
  }

  // A fixed unit vector. The similarity ordering is irrelevant here - every probe is fetched by
  // source_id, not by ANN search - but the column is NOT NULL and dimension-checked.
  const vector = `[${new Array(1024).fill(0.1).join(',')}]`;

  try {
    // ---- seed one probe row per classification, as the write role ------------------------------
    await withWriterRole(async (client) => {
      for (const [i, classification] of classifications.entries()) {
        await client.query(
          `INSERT INTO embeddings (source_type, source_id, content, embedding, metadata, chunk_index, classification)
           VALUES ($1, $2, $3, $4::vector, $5::jsonb, $6, $7)
           ON CONFLICT (source_type, source_id, chunk_index) DO NOTHING`,
          [
            PROBE_SOURCE_TYPE,
            probeSourceId,
            `boundary probe for ${classification}`,
            vector,
            JSON.stringify({ classification, probe: true }),
            i,
            classification,
          ],
        );
      }
    });

    // The seed itself is the first assertion: if the write role cannot write, everything below would
    // pass vacuously against an empty probe set.
    const seeded = await withReaderRole(highest, (client) => client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM embeddings WHERE source_id = $1`,
      [probeSourceId],
    ));
    checks.push({
      name: 'probes-seeded',
      passed: Number(seeded.rows[0]?.n ?? 0) === classifications.length,
      detail: `wrote ${seeded.rows[0]?.n ?? 0} of ${classifications.length} probe rows as the write role`,
    });

    // ---- 1. NEGATIVE ---------------------------------------------------------------------------
    const lowSeesHigh = await withReaderRole(lowest, (client) => client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM embeddings WHERE source_id = $1 AND classification = $2`,
      [probeSourceId, highest],
    ));
    checks.push({
      name: 'negative:low-reader-cannot-see-high-row',
      passed: Number(lowSeesHigh.rows[0]?.n ?? -1) === 0,
      detail: `${readerRoleFor(lowest)} saw ${lowSeesHigh.rows[0]?.n} row(s) classified '${highest}' (want 0)`,
    });

    const highSeesHigh = await withReaderRole(highest, (client) => client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM embeddings WHERE source_id = $1 AND classification = $2`,
      [probeSourceId, highest],
    ));
    checks.push({
      name: 'negative:high-reader-can-see-high-row',
      passed: Number(highSeesHigh.rows[0]?.n ?? 0) === 1,
      detail: `${readerRoleFor(highest)} saw ${highSeesHigh.rows[0]?.n} row(s) classified '${highest}' (want 1)`
        + ' — without this the check above passes because nothing is visible to anyone.',
    });

    // ---- 2. DEFEAT -----------------------------------------------------------------------------
    // The classification filter is GONE from this query on purpose. This is the one that proves the
    // privilege is doing the work.
    const defeat = await withReaderRole(lowest, (client) => client.query<{ classification: string }>(
      `SELECT classification FROM embeddings WHERE source_id = $1`,
      [probeSourceId],
    ));
    const leaked = defeat.rows.map((r) => r.classification).filter((c) => c !== lowest);
    checks.push({
      name: 'defeat:unfiltered-query-as-low-reader-still-sees-only-its-own',
      passed: leaked.length === 0,
      detail: leaked.length
        ? `the filter-free query returned rows classified ${JSON.stringify([...new Set(leaked)])} — the `
          + 'boundary is the WHERE clause, not the privilege.'
        : `returned ${defeat.rows.length} row(s), all '${lowest}'`,
    });

    // ...and as the OWNER, with no role assumed at all. This is the FORCE check: `ENABLE` alone
    // exempts the table owner, and the data-plane connects as the owner, so without FORCE this is the
    // one that comes back holding everything.
    // `current_user` is selected IN THE SAME STATEMENT, not in a follow-up query. `query()` runs on a
    // POOL, so a separate "who am I" call can land on a different connection and answer for the wrong
    // one - which is precisely how a leaked role would hide from its own diagnosis. Reading both in
    // one statement is the only way to know which identity actually saw these rows.
    const asOwner = await query<{ classification: string; whoami: string }>(
      `SELECT classification, current_user::text AS whoami FROM embeddings WHERE source_id = $1`,
      [probeSourceId],
    );
    const seenAs = asOwner.rows[0]?.whoami;
    checks.push({
      name: 'defeat:owner-without-a-role-sees-nothing',
      passed: asOwner.rows.length === 0,
      detail: asOwner.rows.length
        ? `${asOwner.rows.length} probe row(s) were read on an unroled connection, AS '${seenAs}'. `
          + (seenAs === WRITER_ROLE
            ? `THIS IS A ROLE LEAK, NOT AN RLS FAILURE: the pooled connection was still '${WRITER_ROLE}' `
              + 'from an earlier statement, so the write policy admitted everything. The boundary is '
              + 'intact; the role reset is not. Fix withRole(), not the policies.'
            : await diagnoseOwnerBypass())
        : 'owner read 0 rows unroled, as required',
    });

    // ---- 3. NON-VACUITY ------------------------------------------------------------------------
    const inScope = await withReaderRole(lowest, (client) => client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM embeddings WHERE source_id = $1 AND classification = $2`,
      [probeSourceId, lowest],
    ));
    checks.push({
      name: 'non-vacuity:in-scope-read-still-returns-rows',
      passed: Number(inScope.rows[0]?.n ?? 0) === 1,
      detail: `${readerRoleFor(lowest)} saw ${inScope.rows[0]?.n} of its own row(s) (want 1). A boundary `
        + 'that admits nothing passes every negative check and breaks retrieval silently.',
    });

    // ---- 4. ROLE LEAK --------------------------------------------------------------------------
    // Both statements on ONE connection, in order, high then low. If `SET LOCAL ROLE` were a bare
    // `SET ROLE` — or if the reset did not happen — the second read would still be running as the
    // first role and would see the high row.
    const leak = await transaction(async (client) => {
      await client.query(`SET LOCAL ROLE ${readerRoleFor(highest)}`);
      const first = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM embeddings WHERE source_id = $1`,
        [probeSourceId],
      );
      await client.query(`SET LOCAL ROLE ${readerRoleFor(lowest)}`);
      const second = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM embeddings WHERE source_id = $1`,
        [probeSourceId],
      );
      await client.query('RESET ROLE');
      return { first: Number(first.rows[0]?.n ?? -1), second: Number(second.rows[0]?.n ?? -1) };
    });
    checks.push({
      name: 'role-leak:a-second-query-on-the-same-connection-is-not-still-privileged',
      passed: leak.first === classifications.length && leak.second === 1,
      detail: `same connection: as ${readerRoleFor(highest)} saw ${leak.first} (want ${classifications.length}), `
        + `then as ${readerRoleFor(lowest)} saw ${leak.second} (want 1)`,
    });

    return { ok: checks.every((c) => c.passed), checks, classifications, probeSourceId };
  } finally {
    // Always, including after a thrown assertion — a failed verification must not leave probe rows
    // in a real corpus where retrieval could return them.
    try {
      await withWriterRole((client) => client.query(
        `DELETE FROM embeddings WHERE source_type = $1 AND source_id = $2`,
        [PROBE_SOURCE_TYPE, probeSourceId],
      ));
    } catch (err) {
      console.error('[classification-boundary-verify] PROBE CLEANUP FAILED — remove by hand:', probeSourceId, err);
    }
  }
}
