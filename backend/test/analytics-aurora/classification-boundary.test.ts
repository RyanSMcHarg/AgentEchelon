/**
 * ADR-028's boundary, asserted at the level a unit test can reach: the SQL that gets generated, and
 * the role discipline the helpers apply.
 *
 * WHAT THIS SUITE CAN AND CANNOT PROVE. It cannot prove that Postgres enforces the policy - that
 * needs a live database and is owned by the `verifyClassificationBoundary` data-plane op, run against
 * the deployed cluster. What it CAN prove, and what has to be pinned here because it is invisible at
 * runtime until it is too late, is that the generated SQL has the three properties that separate a
 * boundary from a decoration:
 *
 *   1. FORCE, not just ENABLE          - or the owner (which is every Lambda) bypasses every policy
 *   2. a CURRENT_USER predicate, not a `TO <role>` policy - or membership hands the owner the ladder
 *   3. a fail-closed ELSE              - or an unknown identity inherits somebody's scope
 *
 * Each of the three has been checked to FAIL when the property is removed, which is the only reason
 * a green run here means anything.
 */
import {
  BOUNDED_TABLES,
  WRITER_ROLE,
  boundaryStatements,
  readerRoleFor,
  scopeFunctionSql,
} from '../../lambda/src/analytics-aurora/classification-boundary-sql';
import { ProfileRegistry } from '../../lib/profile-registry';
import { DEFAULT_PROFILES_CONFIG } from '../../lib/config/profiles';

const all = (registry?: ProfileRegistry) => boundaryStatements(registry).join('\n\n');

describe('classification boundary — the generated SQL', () => {
  it('FORCEs row level security on every bounded table, not merely ENABLEs it', () => {
    const sql = all();
    for (const table of BOUNDED_TABLES) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      // The one that matters. Postgres exempts a table's OWNER from its own policies unless FORCEd,
      // and the data-plane connects as the owner — so ENABLE alone attaches policies that are
      // bypassed on every query this platform actually makes.
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      // ...and it is applied only when not already in force. `ALTER TABLE` takes an ACCESS EXCLUSIVE
      // lock even when it changes nothing, and this runs on every cold start against the two tables
      // the request path reads, so the no-op case must not take the lock.
      expect(sql).toContain(`WHERE oid = '${table}'::regclass AND relrowsecurity AND relforcerowsecurity`);
    }
  });

  it('discriminates on CURRENT_USER, never by policy role membership', () => {
    const sql = all();
    // `CREATE POLICY ... TO ae_reader_premium` matches by role MEMBERSHIP, and SET LOCAL ROLE
    // requires that membership — so the grant that makes role assumption legal would simultaneously
    // apply the premium policy to the owner's own unroled queries. Hence: TO PUBLIC, discriminating
    // in the predicate.
    //
    // This assertion is deliberately a RATCHET, not a version check. PG16's `GRANT ... WITH INHERIT
    // FALSE` makes the role-targeted form safe, so an upgrade makes it look revertible — but that
    // form hides the security property in a grant option, where a plain re-GRANT silently reopens
    // the boundary and the policy still reads correctly. This test fails that change on any engine.
    for (const classification of DEFAULT_PROFILES_CONFIG.classifications.map((c) => c.value)) {
      expect(sql).not.toContain(`TO ${readerRoleFor(classification)}\n`);
      expect(sql).not.toMatch(new RegExp(`CREATE POLICY[^;]*TO\\s+${readerRoleFor(classification)}\\b`));
    }
    for (const table of BOUNDED_TABLES) {
      expect(sql).toMatch(
        new RegExp(`CREATE POLICY ${table}_classification_read ON ${table}[\\s\\S]*?USING \\(classification = ANY \\(ae_classification_scope\\(CURRENT_USER::text\\)\\)\\)`),
      );
    }
  });

  it('resolves an unknown identity to the EMPTY scope, so it reads nothing', () => {
    // The fail-closed line. Without it, an identity that is not a declared reader — the owner on an
    // unroled query, a new Lambda connecting as something else — would fall through to whatever the
    // last branch happened to be.
    expect(scopeFunctionSql()).toContain('ELSE ARRAY[]::text[]');
  });

  it('gives each reader exactly its scopeAtOrBelow ladder, and no more', () => {
    const registry = new ProfileRegistry(DEFAULT_PROFILES_CONFIG);
    const sql = scopeFunctionSql(registry);
    // basic reads only basic; premium reads the union. Asserted against the registry rather than a
    // hardcoded list, so a deployment that reorders or renames its ladder moves this with it.
    expect(sql).toContain("WHEN 'ae_reader_basic' THEN ARRAY['basic']::text[]");
    expect(sql).toContain("WHEN 'ae_reader_standard' THEN ARRAY['basic', 'standard']::text[]");
    expect(sql).toContain("WHEN 'ae_reader_premium' THEN ARRAY['basic', 'standard', 'premium']::text[]");
  });

  it('follows a renamed or extended classification ladder from config alone', () => {
    // The reason this is generated instead of a static schema/NNN-*.sql. The CDK already derives
    // per-classification IAM from this registry so a rename cannot drift IAM apart from retrieval;
    // a hardcoded role list here would reintroduce that drift on the read path.
    const registry = new ProfileRegistry({
      ...DEFAULT_PROFILES_CONFIG,
      classifications: [
        { value: 'public', rank: 1, profile: 'basic' },
        { value: 'internal', rank: 2, profile: 'standard' },
        { value: 'secret', rank: 3, profile: 'premium' },
        { value: 'topsecret', rank: 4, profile: 'premium' },
      ],
      failClosedTo: 'public',
      groupClearance: { 'ae-public': 'public' },
    });
    const sql = all(registry);
    expect(sql).toContain('CREATE ROLE ae_reader_topsecret NOLOGIN;');
    expect(sql).toContain("WHEN 'ae_reader_secret' THEN ARRAY['public', 'internal', 'secret']::text[]");
    expect(sql).not.toContain('ae_reader_basic');
  });

  it('refuses to build a role name from a MISSING classification — the regression that shipped', () => {
    // `RegExp.test` COERCES. `SAFE_IDENTIFIER.test(undefined)` examines the string "undefined", which
    // is a well-formed lowercase identifier, so the original guard passed it and built
    // `ae_reader_undefined`. That reached the live database once per turn as
    // `role "ae_reader_undefined" does not exist`, and only the e2e caught it.
    //
    // These are the exact values a caller omitting the field produces, and every one of them is a
    // string a character class would happily accept.
    expect(() => readerRoleFor(undefined as unknown as string)).toThrow(/not a classification this deployment declares/);
    expect(() => readerRoleFor(null as unknown as string)).toThrow();
    expect(() => readerRoleFor('undefined')).toThrow(/not a classification this deployment declares/);
    expect(() => readerRoleFor('null')).toThrow();
    // ...and the error names what IS declared, so the reader is not left guessing.
    expect(() => readerRoleFor('undefined')).toThrow(/basic, standard, premium/);
  });

  it('refuses to build a role name from a classification value that is not a safe identifier', () => {
    // The value is deployment config, not user input, so this guards a careless config edit rather
    // than an attacker — but the name is interpolated into DDL, where a bind parameter is not
    // accepted, so it is validated rather than trusted.
    // These are now rejected by the REGISTRY gate before the character-class one ever runs, which is
    // strictly stronger: it refuses anything this deployment does not declare, not merely anything
    // that is unsafe to interpolate. The character class remains as the second gate for the DDL path.
    expect(() => readerRoleFor('basic; DROP TABLE embeddings--')).toThrow(/not a classification this deployment declares/);
    expect(() => readerRoleFor('Basic')).toThrow();
    expect(() => readerRoleFor('')).toThrow();
  });

  it('gives writes to the writer role only, and never to the owner', () => {
    const sql = all();
    for (const table of BOUNDED_TABLES) {
      expect(sql).toMatch(
        new RegExp(`CREATE POLICY ${table}_writer ON ${table}[\\s\\S]*?WITH CHECK \\(CURRENT_USER::text = '${WRITER_ROLE}'\\)`),
      );
      expect(sql).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${WRITER_ROLE};`);
    }
    // No permissive policy for the connecting/owning identity. A policy that let the owner write
    // would be one edit away from letting it read, and an owner read policy IS the ENABLE-without-
    // FORCE hole with extra steps.
    expect(sql).not.toMatch(/CURRENT_USER::text = 'evaladmin'/);
    expect(sql).not.toMatch(/USING \(true\)/);
  });

  it('creates roles before it grants them and grants before it policies them', () => {
    const statements = boundaryStatements();
    const firstCreate = statements.findIndex((s) => s.includes('CREATE ROLE'));
    const firstGrant = statements.findIndex((s) => s.startsWith('GRANT '));
    const firstPolicy = statements.findIndex((s) => s.includes('CREATE POLICY'));
    const scopeFn = statements.findIndex((s) => s.includes('CREATE OR REPLACE FUNCTION ae_classification_scope'));
    expect(firstCreate).toBeGreaterThanOrEqual(0);
    expect(firstCreate).toBeLessThan(firstGrant);
    expect(firstGrant).toBeLessThan(firstPolicy);
    // The policies call it, so it must exist first.
    expect(scopeFn).toBeLessThan(firstPolicy);
  });

  it('stamps pre-existing unclassified rows to the most restrictive value, as the write role', () => {
    const statements = boundaryStatements();
    const setRole = statements.indexOf(`SET LOCAL ROLE ${WRITER_ROLE};`);
    const reset = statements.indexOf('RESET ROLE;');
    expect(setRole).toBeGreaterThanOrEqual(0);

    for (const table of BOUNDED_TABLES) {
      const update = statements.findIndex((s) => s.startsWith(`UPDATE ${table} SET classification =`));
      expect(update).toBeGreaterThanOrEqual(0);
      // Only NULL rows, so a re-run is a no-op and a partly-stamped table converges.
      expect(statements[update]).toContain('WHERE classification IS NULL;');
      // Fail-closed direction: the TOP of the ladder, never the bottom. Stamping 'basic' here would
      // publish every pre-existing summary to every classification in one statement.
      expect(statements[update]).toContain(`'${DEFAULT_PROFILES_CONFIG.classifications.slice(-1)[0].value}'`);
      // Between the role assumption and its reset. By this point FORCE RLS is on and the owner has
      // no write policy, so an unroled UPDATE would report success having changed nothing.
      expect(update).toBeGreaterThan(setRole);
      expect(update).toBeLessThan(reset);
    }

    // RESET ROLE is mandatory, not tidiness: migrations and this bootstrap share ONE transaction per
    // cold start, so a SET LOCAL left standing would be inherited by whatever ran next in it.
    expect(reset).toBe(statements.length - 1);
  });

  it('enables the boundary before it writes through it', () => {
    const statements = boundaryStatements();
    const lastForce = statements.map((s) => s.includes('FORCE ROW LEVEL SECURITY')).lastIndexOf(true);
    const writerPolicy = statements.map((s) => s.includes('_writer ON ')).lastIndexOf(true);
    const setRole = statements.indexOf(`SET LOCAL ROLE ${WRITER_ROLE};`);
    // The stamp runs as ae_writer, so ae_writer's policy has to exist first or the UPDATE silently
    // touches nothing.
    expect(writerPolicy).toBeLessThan(setRole);
    expect(lastForce).toBeLessThan(setRole);
  });

  it('is idempotent: every statement converges on a re-run', () => {
    // This runs at Lambda cold start on fresh AND existing clusters, so a second application must
    // be a no-op rather than an error. Postgres has no CREATE ROLE IF NOT EXISTS, hence the guards.
    // The two role statements and the NULL-guarded stamps are naturally re-runnable.
    // `ALTER DEFAULT PRIVILEGES` is in the list because re-granting a default privilege that is
    // already held is a no-op in Postgres, exactly like a repeated GRANT. It is NOT here because it
    // happened to fail the check: it earns its place for the same reason GRANT does.
    const REENTRANT = /IF NOT EXISTS|OR REPLACE|DROP POLICY IF EXISTS|^GRANT |^ALTER TABLE |^ALTER DEFAULT PRIVILEGES |^CREATE POLICY |^DO \$do\$|^SET LOCAL ROLE |^RESET ROLE;|WHERE classification IS NULL;/m;
    for (const statement of boundaryStatements()) {
      const guarded = REENTRANT.test(statement);
      expect({ statement, guarded }).toEqual({ statement, guarded: true });
    }
    // Specifically: a policy is always dropped-if-exists immediately before it is created, so a
    // changed ladder replaces the old predicate instead of failing on a duplicate name.
    const sql = all();
    for (const table of BOUNDED_TABLES) {
      expect(sql.indexOf(`DROP POLICY IF EXISTS ${table}_classification_read`))
        .toBeLessThan(sql.indexOf(`CREATE POLICY ${table}_classification_read`));
    }
  });
});
