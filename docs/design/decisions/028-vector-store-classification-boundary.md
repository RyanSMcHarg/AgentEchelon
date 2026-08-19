---
title: "ADR-028: The vector store's classification boundary is a database privilege, not a query"
status: Implemented 2026-08-12 (built, deployed, and verified live - 7/7 boundary checks)
date: 2026-08-12
related:
  - "../../specs/interaction/identity-access/core/SPEC-CONVERSATION-SECURITY.md"
  - "../../guides/developer/GUIDE-ASSISTANT-CONTEXT.md"
  - "../../guides/developer/RAG.md"
  - "../../specs/capabilities/SPEC-DRIFT-CONVERGENCE.md"
  - "../../../backend/lambda/src/analytics-aurora/document-retrieval.ts"
  - "../../../backend/lambda/src/analytics-aurora/document-ingestion.ts"
  - "../../../backend/lambda/src/analytics-aurora/db-client.ts"
  - "../../../backend/lambda/src/lib/scoped-channels.ts"
---

# ADR-028: The vector store's classification boundary is a database privilege, not a query

## Status

**Implemented 2026-08-12.** All seven owed checks pass against the deployed cluster, and retrieval
still returns content, which is the other half of the claim.

**Verified by:** the `verifyClassificationBoundary` data-plane op, run against the dev deployment
(Aurora PostgreSQL 15.10) on 2026-08-12: `ok: true`, seven of seven. It seeds a probe row at each
classification, asserts, and removes them, so it does not depend on what the corpus happens to hold.
The checks are the negative test, the defeat test with the classification filter deleted, the defeat
test as the connecting identity with no role assumed, non-vacuity, and the pooled-connection role
leak. Paired with a live `retrieve` op returning 4 chunks at both `basic` and `premium` with
`signalAvailable: true`, which is what distinguishes a boundary that holds from one that has gone
blind. Unit coverage of the generated SQL is `backend/test/analytics-aurora/classification-boundary.test.ts`,
each of whose load-bearing assertions was confirmed to fail when the property it pins is removed.

**The first run of this verification FAILED**, and the record of what that cost and what it changed is
in "Verification: what the run found" below. It is kept rather than tidied away: the design as
originally written did not hold, and the reason was not any of the three things it looked like.

The mechanism below is implemented (`classification-boundary-sql.ts`, `classification-boundary.ts`,
`channel-classification.ts`, migrations `021`/`022`, and the reader/writer role assumption at every
call site that touches either table), and the checks in "Verification this ADR owes" have run and
passed against the deployed cluster, per the `Verified by:` line above.

**One decision below changed during implementation**, and it is recorded inline where it applies: the
policies key on `current_user` rather than on a policy role list, because this cluster is PostgreSQL
15 and the PG16 grant option that would make the role-list form safe does not exist there. See
"Decision" step 2.

## Problem and who it's for

A business running one assistant platform across clearance levels needs the guarantee that
higher-classification content never reaches a lower-classification reader to hold **even when a query
is written wrongly**. That is the promise `SPEC-CONVERSATION-SECURITY.md` makes, and for the paths it
enumerates it is kept by infrastructure: a basic assistant's role has no `s3:GetObject` on
`context/premium/*`, so a prompt bug, a confused model, or a mistaken code path cannot cross it.

Retrieval does not have that property. It reaches the model on every turn, and its boundary is a
`WHERE` clause.

## Context: what actually enforces each grounding path

Eleven sources feed a turn. Grouped by what restricts them:

| Mechanism | Sources |
|---|---|
| **IAM prefix grant** | company digest, `load_company_context`, `load_platform_info`, persona body, intent pack, attachment-in, user-profile facts |
| **Amazon Chime SDK membership** | channel history, conversation summary, drift's related-conversation lookup |
| **SQL filter** | document retrieval (`embeddings`) |
| **Nothing recorded** | conversation summary embeddings (`summary_embeddings`) |

Two facts make the last two rows the subject of this ADR.

**One database identity.** Every Lambda that touches Aurora connects as a single user (`db-client.ts`
`DB_USER`, default `evaladmin`, granted `rds_iam`). There is no per-classification database principal.
Whatever rows exist, that identity can read.

**Classification is data, not privilege.** `embeddings` holds every classification's chunks in one
table and retrieval appends `AND metadata->>'classification' = ANY($3)`. The filter is fail-closed for
untagged rows and the scope is validated non-empty, both good - but the protection is that the clause
was written, and written correctly, at every call site that will ever exist.

**`summary_embeddings` has no classification at all:**

```sql
CREATE TABLE summary_embeddings (
    channel_arn VARCHAR(256) PRIMARY KEY,
    embedding vector(1024) NOT NULL, ...
);
```

Drift's control over it is genuinely well built - the candidate set is the intersection of all human
members' **live** Amazon Chime SDK memberships via `SearchChannels … MEMBERS INCLUDES`, enforced inside the
`WHERE`, fail-closed on an empty scope, never falling back to the archive (`scoped-channels.ts`,
ADR-012). But it means the entire boundary for conversation summaries is one caller passing the right
ARNs, with nothing in the data for a second reader to check against.

**Membership is not classification.** Two premium-cleared people talking in a **basic** channel have
premium channels in their membership intersection. Nobody learns anything they could not already open,
but the platform's model is that the **channel's** classification bounds what may surface in it -
which is why the assistant is classification-scoped per channel. Membership protects the people; it
does not protect the channel.

**This is not hypothetical.** On 2026-08-11 the platform's own documentation was ingested at the
lowest classification so every classification could answer "how does this work?". One of those
documents reproduces the demo dataset's org chart and financials to illustrate what each
classification may see. A `basic` turn then answered *"the VP of Engineering at Stratum Technologies is
Priya Patel"* - a name that appears in no basic-classification context file. The IAM boundary held
perfectly; the content simply arrived by the path that has no IAM boundary. `e2e/classification-context.spec.ts`
caught it after deploy.

## Decision

**Make the reader identity carry the classification, and enforce it in the database.**

1. **A database role per classification.** `ae_reader_basic`, `ae_reader_standard`,
   `ae_reader_premium`, created and granted at deploy alongside the existing `rds_iam` setup. Created
   in a `DO $$ … $$` guard: Postgres has no `CREATE ROLE IF NOT EXISTS`, and every migration here
   auto-applies at cold start and must be idempotent.
2. **Row-level security on the vector tables**, with one policy per table admitting only rows at or
   below the reading role's classification. The ladder is expressed once, from `scopeAtOrBelow`, and
   the roles are generated from the deployment's own classification registry rather than hardcoded -
   the CDK already derives per-classification IAM from that registry so a rename cannot drift IAM
   apart from retrieval, and a static `.sql` file naming `ae_reader_basic|standard|premium` would
   reintroduce exactly that drift on the read path.

   - **The policy predicate keys on `current_user`, NOT on a policy role list** - `TO PUBLIC ... USING
     (classification = ANY (ae_classification_scope(CURRENT_USER)))`. **This corrects the original
     form of this decision, which was "a policy per role".** Postgres matches a `TO <role>` policy by
     role MEMBERSHIP, and `SET ROLE` requires the connecting user to be a member of the target role -
     so the grant that makes role assumption legal would simultaneously apply the premium policy to
     `evaladmin`'s own unroled queries. The boundary would read as built, pass a green suite, and
     admit everything to the identity that does all the work. Keying on `current_user` - which
     `SET LOCAL ROLE` changes and mere membership does not - obtains the intended property. An
     identity with no ladder resolves to the empty array and reads nothing.

     **This is not a version workaround, and must not be undone as one.** Postgres 16 adds
     `GRANT ... WITH INHERIT FALSE`, which makes the role-targeted form safe, and this cluster is
     Aurora PostgreSQL 15.10 - so the obvious reading is "revert on upgrade". The opposite holds. The
     role-targeted form places the security property in the **grant** rather than in the policy:
     `GRANT ae_reader_premium TO evaladmin WITH INHERIT FALSE` and the same grant without the option
     leave policies that read identically, and the second one silently reopens the boundary. A
     re-grant during maintenance, or a migration that re-runs it, is enough. The `current_user`
     predicate is self-contained - the whole rule is visible where it is enforced - and it is the
     preferred form on any engine version. **The engine constraint is how this was found, not why it
     was chosen**, and the engine version is therefore not a dependency of this decision.
   - **`FORCE ROW LEVEL SECURITY`, not merely `ENABLE`.** Postgres exempts a table's OWNER from its own
     policies. The tables are created by migrations running as the master user, and the data-plane
     connects as that same user - so `ENABLE` alone would leave policies attached and bypassed on every
     query, which is this ADR's own failure mode wearing a fix's clothes. The reader roles must also
     not own the tables.
   - **Classification becomes a real column** on the vector tables rather than a `metadata->>` lookup.
     A policy predicate is evaluated per row scanned, and a JSONB expression cannot use a btree index
     the way a column can.
3. **The data-plane assumes the caller's role for the query.** `db-client.ts` `query()` runs on a
   **pooled** connection and opens no transaction, so this cannot be a bare `SET ROLE`: that persists
   on the pooled connection and would be inherited by the NEXT invocation, possibly at a different
   classification - the fix creating the leak it exists to prevent. Retrieval therefore runs through
   the existing `transaction()` helper with `SET LOCAL ROLE` (transaction-scoped, released at COMMIT),
   with `RESET ROLE` in a `finally` as a belt-and-braces guard. The classification travels as a
   *principal*, not as a parameter the query is trusted to apply.
   - The data-plane Lambda dispatches roughly two dozen ops on one pool; only retrieval (and later
     drift) assumes a reader role. Role state is scoped per query, never per connection.
4. **`summary_embeddings` gains a classification column**, under the same policy. Untagged rows are
   invisible - the fail-closed rule documents already follow. **The backfill reads the channel's
   classification from Amazon Chime SDK Messaging, not from the Aurora archive**: ADR-012 and the
   membership work established that the archive is a lagging projection and never the authority for a
   live boundary decision, and a backfill that seeds the boundary from it would bake that lag in
   permanently.
5. **The existing filters stay.** RLS is defence in depth, not a replacement: a correct query and a
   correct privilege, so either one failing is survivable.

### Why not separate tables per classification

Considered and rejected as the primary mechanism. The instinct behind it is right - move the boundary
from the query to the privilege - but **the tables are not what creates the boundary; the reader
identity is.** Splitting `embeddings` into three tables while every Lambda still connects as
`evaladmin` leaves all three equally readable and the protection is still "which query did we write".
Once per-classification roles exist, RLS obtains the same property with one table, one HNSW index, and
no schema change when a classification is added - which matters, because classifications are
configurable in `profiles.ts`.

Separate tables remain a reasonable *later* choice for reasons that are not access control: physical
separation for audit, retention, or backup scoping. This ADR does not preclude that.

### Why not stop embedding restricted content

This is the cheapest correct answer and it stays on the table: keep genuinely sensitive records in
their source of truth and read them live through the IAM-bounded tool path.
`GUIDE-ASSISTANT-CONTEXT.md` already recommends exactly this, and a deployment that follows it needs
none of the above. It is not sufficient **for the reference deployment**, which demonstrates
classification isolation with a seeded corpus, nor for a deployer who wants semantic retrieval over
classified content - and the platform should not require that they give it up to stay safe.

## Consequences

- **A forgotten or widened filter stops being a leak.** It becomes an empty result, because the
  privilege is not there to widen to. That is the whole point.
- **Ingest-time mislabelling is NOT fixed by this.** Classification is asserted by the S3 key path at
  ingest; a table or a policy is another label, and content written to the wrong classification is
  served faithfully from it. The ingest-side content guard is a separate, necessary control.
- **`FORCE` locks out the owner's WRITES too, and migrations are writers.** This is the consequence
  with the widest blast radius and it was not anticipated when this ADR was written. The owner
  deliberately has no write policy (an owner write policy is one edit away from an owner read policy,
  which is the `ENABLE`-without-`FORCE` hole with extra steps), so every writer must assume
  `ae_writer` - including migrations. From `023` onward, an ordinary `UPDATE embeddings` in a
  migration **succeeds having changed zero rows**: no error, no warning, and `applyPendingMigrations`
  records the file as applied. `migration-writer-role.test.ts` fails any migration above the cutoff
  that writes a bounded table without assuming the role and resetting it, and verifies its own matcher
  against a synthetic bad file so it cannot pass by scanning nothing.
- **A classification cannot be read where a summary is written.** The Aurora VPC has `natGateways: 0`
  and interface endpoints for Kinesis, S3, Secrets Manager, DynamoDB and Bedrock Runtime only, so
  `summary-updater`, the data-plane and the archival pipeline have no route to Amazon Chime SDK at all.
  The authoritative read therefore happens outside the VPC and arrives as an op payload, landing in
  `channel_classification` - a projection, never an authority (ADR-012). A live turn refreshes its own
  channel through the `detectDrift` op; `backfill-channel-classifications.mjs` covers the rest.
- **"Fail-closed" points in OPPOSITE directions for a writer and a reader, and confusing them is
  silent.** Stamping CONTENT falls back to the MOST restrictive classification, so an unknown row is
  readable only at the top. Choosing a READER role falls back to the LOWEST, because a reader sees its
  own classification *and everything below* - defaulting an unknown reader to "most restrictive" would
  hand it the entire table under the name of caution. Both fallbacks exist in the code and are named
  as such at each site.
- **Cross-conversation context becomes buildable.** It is blocked today because the summaries it would
  draw on carry no classification to filter by.
- **A new classification means a new role, policy and grant** - deploy-time work, consistent with
  "a boundary is infrastructure".
- **Cost:** one `SET LOCAL ROLE` per query and a policy check per row scanned. Both are small against
  an ANN search and an embedding call; to be measured, not assumed.
- **Risk, and the failure mode to design for:** a policy that admits nothing looks identical to a
  corpus with no relevant content. Retrieval returning empty must be distinguishable from retrieval
  being denied, in tests and in logs, or this control will be "verified" by a green run that proves
  nothing.

## Verification this ADR owes

Nothing here may claim `Implemented` until each of these exists. (Each now does, and has run and
passed; see Status and the run record below.)

1. **A negative test at the database.** Connect as `ae_reader_basic`, query for content that exists
   only at premium, assert zero rows - and assert the same query as `ae_reader_premium` returns them.
   Proves the policy discriminates rather than merely being present.
2. **A defeat test.** Issue the retrieval query with the classification filter deliberately removed
   while connected as `ae_reader_basic`, and assert restricted rows still do not come back. This is
   the only test that proves the boundary is the privilege and not the clause. **Run it against the
   table owner too**, asserting that the owner path is not the hole: without `FORCE ROW LEVEL
   SECURITY` this test is the one that fails.
3. **A non-vacuity test.** Retrieval still returns chunks for an in-scope query - a boundary that
   passes because it matches nothing is the failure this is most likely to ship as.
4. **A role-leak test.** Two queries in sequence on the same pooled connection, the first at premium
   and the second at basic, asserting the second sees only basic rows. Pooling plus role switching is
   the specific way this design can reintroduce the leak it removes.
5. **The live isolation e2e** (`e2e/classification-context.spec.ts`) green against a deployment with
   RLS active.

**Where they run.** These need a real Postgres, which the Jest suite does not have - and an unrunnable
test is how a control gets "verified" by a green suite that never exercised it.

**They run against the deployed cluster, as a data-plane op** (`verifyClassificationBoundary`), not
against a container. Aurora sits in isolated subnets with no public route, so the only thing that can
question it is a Lambda already in the VPC; adding a container path would prove the policies are
correct SQL without proving they are in force *on the deployment that serves traffic*, which is the
claim being made. The op seeds its own probe rows at each classification, asserts, and removes them in
a `finally` - asserting over whatever the corpus happens to hold would pass for the wrong reason on any
day the deployment has no high-classification content. `backfill-channel-classifications.mjs --verify`
runs it and exits non-zero on any failing check.

The trade recorded honestly: this cannot be run on a laptop or in CI, so it does not gate a merge. The
unit suite (`classification-boundary.test.ts`) covers what is checkable without a database - and each
of its load-bearing assertions was confirmed to FAIL when the property it pins is removed, because a
green run is evidence only if the check can fail.

## Verification: what the run found (2026-08-12)

**Outcome: the first run failed on one check; connecting the runtime as a dedicated non-owning
database user fixed it, and the re-run passes seven of seven.** The detail below is kept because the
failure was instructive and because two confident hypotheses about its cause were wrong.

Run against the deployed dev cluster (Aurora PostgreSQL 15.10) immediately after the stack update that
shipped this design. **Six of seven checks passed. One failed, and it was the one that distinguishes a
privilege from a decoration.**

| Check | Result |
|---|---|
| probes seeded as the write role | PASS, 3 of 3 |
| negative: low reader cannot see a high row | PASS, `ae_reader_basic` saw 0 `premium` rows |
| negative: high reader CAN see a high row | PASS, `ae_reader_premium` saw it |
| defeat: filter deleted, still bounded | PASS, returned only `basic` rows |
| **defeat: owner with no role sees nothing** | **FAIL, read all 3 probes** |
| non-vacuity: in-scope read returns rows | PASS |
| role leak on a pooled connection | PASS, premium then basic on one connection |

**What this means for the boundary as it stands.** The per-classification roles genuinely bound reads
at the database: the defeat test passes for a reader role, which is the property the design exists to
obtain, and every read and write path now assumes a role. The leak that motivated this ADR cannot recur
through those paths. What does NOT hold is the promise in "Consequences" that a forgotten filter, or a
forgotten role assumption, becomes an empty result rather than a leak. The fallback identity can still
read everything, so the defence-in-depth claim is not yet earned.

### What was ruled out, and how

Recorded because each elimination cost a deploy-and-measure cycle, and because two of them were
confident hypotheses that turned out to be wrong. The pattern is worth keeping: **reasoning about the
mechanism produced two wrong answers; only measurement produced eliminations.**

| Hypothesis | Ruled out by | Evidence |
|---|---|---|
| A role leak: the pooled connection was still `ae_writer`, so the write policy admitted everything | Selecting `current_user` **in the same statement** as the rows, because a separate "who am I" query can land on a different pooled connection and answer for the wrong one | Rows were read as `evaladmin`, not `ae_writer` |
| A policy bug: the predicate admits rows it should not | Dumping `pg_policies` for both tables | Exactly the four generated policies, no strays; `USING (classification = ANY (ae_classification_scope((CURRENT_USER)::text)))` as written; `ae_classification_scope('evaladmin')` returns `{}`, so the predicate is false |
| The connecting role holds `BYPASSRLS` or `SUPERUSER` | `pg_roles` for the connecting role | Both false |
| The exemption is inherited from `rds_superuser` | `pg_has_role(current_user, oid, 'USAGE')` over roles carrying either attribute | No such role found. **This is the weakest elimination**: it assumes `has_bypassrls_privilege` resolves membership the way `pg_has_role(..., 'USAGE')` does, which was not independently confirmed |
| `FORCE ROW LEVEL SECURITY` never applied | `pg_class.relforcerowsecurity` | True on both tables, alongside `relrowsecurity` true and `relowner` = the connecting role |

**The cause is therefore unresolved**: the table owner is being exempted from its own policies while
the catalog reports `relforcerowsecurity` true. That is not the documented behaviour, and it is not
explained by any of the above.

### The decision that follows, and why it does not depend on resolving the cause

**The runtime will connect as a dedicated, non-owning, unprivileged database user.** The Lambdas
currently authenticate as `evaladmin`, which is simultaneously the RDS master user, the owner of every
table, the migration runner and the query identity. Four jobs on one principal.

This is not a workaround for the unresolved behaviour. It **removes the dependency on it**: row-level
security applies to a non-owner through the ordinary path, which needs no `FORCE`, no owner-exemption
semantics, and no conclusion about what `rds_superuser` confers. The owner exemption stops being a
question this design has to answer.

It is also the right separation on independent grounds, and would be worth doing had every check
passed:

- **Blast radius.** A wrongly written query today runs with authority to drop the table. As the
  runtime user it runs with `SELECT` on what it needs.
- **Migrations stop writing through the boundary.** The rule that a migration must assume `ae_writer`
  or silently affect zero rows exists only because the migration runner and the query identity are the
  same principal. Splitting them dissolves it.
- **It matches every other boundary here.** Two-layer user and assistant IAM, per-classification S3
  prefixes, credential exchange: the platform's answer everywhere else is a narrower principal, and the
  database was the one place it was not.

**The constraint that shapes the implementation.** `ensureSchema()` runs on the runtime connection, and
that is the only way a new migration reaches an existing cluster (`schema-init` bootstraps on Create
and can never reconnect). So the runtime user cannot simply lack DDL: the module keeps **two pools**,
an admin pool as the owner for migrations and the boundary bootstrap, and a runtime pool as the
unprivileged user for everything else. The bootstrap creates the runtime user, so a fresh cluster
resolves the ordering naturally: admin connects first, creates and grants, and only then does any
runtime query run.

### The result

`ae_app`, created by the bootstrap with `LOGIN` and `rds_iam`, granted DML on the schema (plus
`ALTER DEFAULT PRIVILEGES`, so a table added by a later migration does not silently become unreadable)
and membership of the reader and writer roles, owning nothing and holding no DDL. `DB_APP_USER` in the
Lambda environment selects it; unset, it falls back to the owner, which is what lets the first cold
start after this ships connect before the role it will use exists.

**The re-run passes seven of seven, including the owner-defeat check that failed before.** Row-level
security applies to `ae_app` through the ordinary non-owner path, so the unexplained owner exemption is
no longer on the path to the guarantee. It remains unexplained, and that is worth stating plainly: this
design no longer depends on the answer, but nobody has established what the answer was.

**What the fix bought beyond the fix.** A wrongly written runtime query no longer carries authority to
drop the table it is reading; migrations and queries are separate principals; and the rule that a
migration must assume `ae_writer` or silently affect zero rows now applies only to the owner's own
path, where it belongs.
