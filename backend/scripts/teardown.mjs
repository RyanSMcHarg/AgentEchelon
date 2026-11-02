#!/usr/bin/env node
/**
 * Tear down ONE AgentEchelon instance in a shared, multi-project AWS account.
 *
 * The account also hosts other projects, so a hand-run `cdk destroy` plus a manual orphan cleanup is a
 * minefield: one wrong bucket, pool or app instance irreversibly destroys another project's data. This
 * script makes the teardown repeatable and reviewable. What it decides is in `lib/teardown-plan.cjs`,
 * pure and unit-tested (`test/teardown-plan.test.ts`); this file only asks AWS and acts.
 *
 *   1. THE TARGET IS THE INSTANCE YOU NAME. `AE_INSTANCE_NAME` (or a variable `resolveInstanceName`
 *      agrees with) must be set; there is no default. The default instance, the dev deployment, also
 *      needs `--instance-is-dev`.
 *   2. STACKS ARE FOUND IN CLOUDFORMATION, not in `cdk list`: every stack named exactly
 *      `<prefix><a name lib/config/stack-names.json lists>`, current or retired, in the deploy region and
 *      each region a stack is pinned to. So an instance still on the earlier layout is removed whole,
 *      and instance `AeNext` never takes `AeNextC0`'s stacks.
 *   3. STACKS ARE DELETED IN ROUNDS by export dependency, importers first, other regions last.
 *   4. RETAINED RESOURCES are purged when their `Instance` tag names this instance, or, untagged, when
 *      their name is one this instance gives them: the user pools (the deployment's, the staff pool and
 *      the TestIssuer pools), the `Identities` and `Tokens` tables and every other retained table,
 *      buckets, the message stream, the app instance, the SSM root, and the archive KMS key, which is
 *      scheduled for deletion and its alias removed.
 *   5. SECRETS ARE NEVER DELETED. Twilio, image-generation and every other external API key live in
 *      Secrets Manager; a teardown leaves every secret it finds and says so.
 *   6. HARD SAFETY GATE: every target is checked against an other-project denylist, `AE_TEARDOWN_PROTECT`
 *      (comma-separated regular expressions, matched case-insensitively), and a single match aborts the
 *      whole run. The gate fails closed: a `--confirm` run with `AE_TEARDOWN_PROTECT` unset is refused
 *      before anything is deleted. `AE_TEARDOWN_PROTECT=none` declares an account that holds only this
 *      instance. A dry run with it unset still plans, and prints the warning above and below the plan.
 *
 * DEFAULTS TO A DRY RUN. It prints the exact plan and deletes nothing. Re-run with `--confirm`.
 *
 *   AE_INSTANCE_NAME=ae-next AE_TEARDOWN_PROTECT=billing,crm-?app node scripts/teardown.mjs            # dry run
 *   AE_INSTANCE_NAME=ae-next AE_TEARDOWN_PROTECT=billing,crm-?app node scripts/teardown.mjs --confirm  # execute
 *   AE_INSTANCE_NAME=ae-next AE_TEARDOWN_PROTECT=none node scripts/teardown.mjs --confirm   # account holds only this instance
 *   AE_INSTANCE_NAME=<default instance> AE_TEARDOWN_PROTECT=... node scripts/teardown.mjs --instance-is-dev [--confirm]
 *   ... --keep-archives                                                                    # keep the archive buckets
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const plan = require('./lib/teardown-plan.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');

let TARGET;
try {
  TARGET = plan.teardownTarget({ env: process.env, argv: process.argv.slice(2) });
} catch (err) {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
}
const { instance: INSTANCE, prefix: PREFIX } = TARGET;
const SSM_ROOT = `/${INSTANCE}`;
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const REGIONS = plan.teardownRegions(REGION);

const CONFIRM = process.argv.includes('--confirm');
const MODE = CONFIRM ? 'EXECUTE' : 'DRY-RUN';

// HARD DENYLIST: if ANY selected target's name matches another project, abort the whole run. The account's
// other projects are the deployer's to name, so the list is read from `AE_TEARDOWN_PROTECT`: comma-separated
// regular expressions, matched case-insensitively, or `none` for an account that holds only this instance.
// An executing run with it unset is refused here, before anything is read or deleted.
let OTHER_PROJECTS;
let PROTECT_WARNING;
try {
  ({ patterns: OTHER_PROJECTS, warning: PROTECT_WARNING } = plan.otherProjectsDenylist({ env: process.env, confirm: CONFIRM }));
} catch (err) {
  console.error(`\n✗ SAFETY ABORT: ${err.message}\n`);
  process.exit(1);
}
function warnUnprotected() {
  if (!PROTECT_WARNING) return;
  console.warn(`\n!!! ${'='.repeat(96)}\n!!! WARNING: ${PROTECT_WARNING}\n!!! ${'='.repeat(96)}\n`);
}

/**
 * KEEP THE ARCHIVES, and tear down everything else.
 *
 * The conversation archive and the Aurora archive are the ABSOLUTE record - the projection in Aurora
 * is lossy and rebuilt, these are not. Tearing a deployment down for the weekend is a different
 * decision from discarding its history.
 *
 * THE COST OF KEEPING THEM IS REAL AND IS PRINTED. These buckets are RETAIN and fixed-name, so a
 * redeploy tries to create a bucket that already exists and fails early validation. Keeping them means
 * the next deploy needs them imported or removed first.
 */
const KEEP_ARCHIVES = process.argv.includes('--keep-archives');

// Windows resolves aws as .cmd via PATH, so shell:true is required for spawnSync to find it. Our arg
// values (stack names, ids, ARNs) carry no shell metacharacters; the one JSON payload (delete-objects)
// is passed via a temp file, never inline, so shell:true stays safe here.
const USE_SHELL = process.platform === 'win32';
function run(cmd, args, { capture = true } = {}) {
  return spawnSync(cmd, args, { cwd: BACKEND_DIR, encoding: 'utf8', shell: USE_SHELL, stdio: capture ? 'pipe' : 'inherit' });
}

/**
 * A CREDENTIAL FAILURE MUST NEVER READ AS "THERE IS NOTHING THERE".
 *
 * Callers write `(awsJson(...) || {}).X || []`, so a `null` return becomes an empty inventory. For a
 * not-found that is the right shape. For an EXPIRED OR DENIED CALL it is the worst one: an empty answer
 * both ends the delete loop and satisfies the final check, so the run would print a success over stacks
 * it never looked at. The likely case is a token expiring PART WAY THROUGH a long run.
 *
 * So instead of reading the error, re-ask the question. `sts get-caller-identity` needs no permissions
 * beyond holding a usable credential, so if it succeeds the failed call failed for its own reasons and a
 * null is honest; if it fails, this process cannot see the account at all, and the run aborts. (An
 * earlier version pattern-matched the CLI's error text for ExpiredToken and friends, and missed the
 * first unfamiliar message it met: a guard against silent failure must not itself fail silently.)
 */
function canStillReadTheAccount() {
  return run('aws', ['sts', 'get-caller-identity', '--output', 'json']).status === 0;
}

function awsJson(args) {
  const r = run('aws', [...args, '--output', 'json']);
  if (r.status !== 0) {
    if (!canStillReadTheAccount()) {
      const why = `${r.stderr || ''}${r.error?.message || ''}`.trim().split('\n')[0];
      console.error('\n✗ ABORT: cannot read the account, so this run cannot say what is left standing.');
      console.error(`   failed call: aws ${args.join(' ')}`);
      if (why) console.error(`   ${why}`);
      console.error('\n   Refresh credentials and re-run. Anything already deleted stays deleted;');
      console.error('   re-running is safe because every step re-reads what is actually still there.');
      process.exit(2);
    }
    return null;
  }
  try { return JSON.parse(r.stdout || 'null'); } catch { return null; }
}

/**
 * A LISTING THE PLAN OR THE VERIFICATION DEPENDS ON: any failure aborts. `awsJson` returns null for a
 * failed call the credentials survive (a throttle, a denied list), which is right for a lookup of one
 * thing and wrong for "what is left": an empty listing there is a success the run did not verify.
 */
function listing(args) {
  const out = awsJson(args);
  if (out === null) {
    console.error(`\n✗ ABORT: aws ${args.join(' ')} failed, so this run cannot say what is there. Nothing further is deleted.`);
    process.exit(2);
  }
  return out;
}

/** Fail-safe: abort the ENTIRE run if any target name looks like another project. */
function guard(name, kind) {
  for (const re of OTHER_PROJECTS) {
    if (re.test(name)) {
      console.error(`\n✗ SAFETY ABORT: ${kind} "${name}" matches another project (${re}). Refusing to touch anything.`);
      process.exit(2);
    }
  }
  return name;
}

// ── 1. The stacks ─────────────────────────────────────────────────────────────────────────────────

const LIVE_STATUSES = [
  'CREATE_IN_PROGRESS', 'CREATE_COMPLETE', 'CREATE_FAILED', 'ROLLBACK_IN_PROGRESS', 'ROLLBACK_COMPLETE', 'ROLLBACK_FAILED',
  'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', 'UPDATE_ROLLBACK_IN_PROGRESS',
  'UPDATE_ROLLBACK_COMPLETE', 'UPDATE_ROLLBACK_FAILED', 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS',
  'DELETE_IN_PROGRESS', 'DELETE_FAILED', 'REVIEW_IN_PROGRESS', 'IMPORT_COMPLETE', 'IMPORT_ROLLBACK_COMPLETE',
];

/** This instance's stacks still standing, in every region it uses, current and retired names alike. */
function standingStacks() {
  const all = REGIONS.flatMap((region) => (listing(['cloudformation', 'list-stacks', '--region', region,
    '--stack-status-filter', ...LIVE_STATUSES]).StackSummaries || [])
    .map((s) => ({ name: s.StackName, region, status: s.StackStatus })));
  return plan.instanceStacks(all, PREFIX);
}

/**
 * A NESTED STACK IS DELETED WITH ITS ROOT, so an import from one is the root's import. CloudFormation names
 * the nested stack as the importer; its `RootId` names the stack this teardown actually deletes. A stack
 * with no root, or one that cannot be read, stays as named, so a foreign importer is still refused.
 */
function rootOf(name, region) {
  const stack = ((awsJson(['cloudformation', 'describe-stacks', '--region', region, '--stack-name', name]) || {}).Stacks || [])[0];
  return stack?.RootId ? String(stack.RootId).split('/')[1] : name;
}

/** Exporting stack name -> the stacks importing from it, for this instance's exports. */
function importsOf(stacks) {
  const ours = new Set(stacks.map((s) => s.name));
  const imports = {};
  for (const region of REGIONS) {
    for (const exp of listing(['cloudformation', 'list-exports', '--region', region]).Exports || []) {
      const exporter = String(exp.ExportingStackId || '').split('/')[1];
      if (!ours.has(exporter)) continue;
      // `list-imports` fails with a ValidationError for an export nothing imports; that null is "none".
      const importers = ((awsJson(['cloudformation', 'list-imports', '--region', region, '--export-name', exp.Name]) || {}).Imports || [])
        .map((name) => (ours.has(name) ? name : rootOf(name, region)));
      imports[exporter] = [...new Set([...(imports[exporter] || []), ...importers])];
    }
  }
  return imports;
}

// ── 2. The retained resources ─────────────────────────────────────────────────────────────────────

let ACCOUNT = null;
function account() {
  if (!ACCOUNT) ACCOUNT = listing(['sts', 'get-caller-identity']).Account;
  return ACCOUNT;
}

/** Every resource that could be this instance's, with its `Instance` tag where it carries one. */
function inventory(stackNames) {
  const tags = new Map(); // ARN -> Instance tag value
  for (const region of REGIONS) {
    for (const m of listing(['resourcegroupstaggingapi', 'get-resources', '--region', region, '--tag-filters', 'Key=Instance']).ResourceTagMappingList || []) {
      tags.set(m.ResourceARN, (m.Tags || []).find((t) => t.Key === 'Instance')?.Value ?? null);
    }
  }
  const items = new Map();
  const add = (arn, item) => items.set(arn, { ...item, arn, instanceTag: tags.has(arn) ? tags.get(arn) : (item.instanceTag ?? null) });

  for (const b of listing(['s3api', 'list-buckets']).Buckets || []) add(`arn:aws:s3:::${b.Name}`, { kind: 'bucket', id: b.Name, name: b.Name });
  for (const region of REGIONS) {
    for (const p of listing(['cognito-idp', 'list-user-pools', '--max-results', '60', '--region', region]).UserPools || []) {
      add(`arn:aws:cognito-idp:${region}:${account()}:userpool/${p.Id}`, { kind: 'user-pool', id: p.Id, name: p.Name, region });
    }
    for (const t of listing(['dynamodb', 'list-tables', '--region', region]).TableNames || []) {
      add(`arn:aws:dynamodb:${region}:${account()}:table/${t}`, { kind: 'table', id: t, name: t, region });
    }
    for (const s of listing(['kinesis', 'list-streams', '--region', region]).StreamNames || []) {
      add(`arn:aws:kinesis:${region}:${account()}:stream/${s}`, { kind: 'stream', id: s, name: s, region });
    }
    const aliases = listing(['kms', 'list-aliases', '--region', region]).Aliases || [];
    const byKey = new Map();
    for (const a of aliases) if (a.TargetKeyId) byKey.set(a.TargetKeyId, [...(byKey.get(a.TargetKeyId) || []), a.AliasName]);
    for (const [keyId, names] of byKey) {
      add(`arn:aws:kms:${region}:${account()}:key/${keyId}`, { kind: 'kms-key', id: keyId, name: names.join(','), aliases: names, region });
    }
  }
  // The app instance's tags are not in the tagging API's listing, so it is matched by name alone.
  for (const a of listing(['chime-sdk-identity', 'list-app-instances', '--region', REGION]).AppInstances || []) {
    add(a.AppInstanceArn, { kind: 'app-instance', id: a.AppInstanceArn, name: a.Name, region: REGION, instanceTag: undefined });
  }
  // Tagged resources no listing above covered (a secret, a key with no alias): reported, and only
  // purgeable kinds act. A bucket, pool, table or stream the listings did not return does not exist: the
  // tagging API keeps a deleted resource's tags for a while, and that record is not a resource.
  const LISTED = new Set(['bucket', 'user-pool', 'table', 'stream']);
  for (const [arn] of tags) {
    if (items.has(arn)) continue;
    const kind = plan.kindOfArn(arn);
    if (LISTED.has(kind)) continue;
    add(arn, { kind, id: arn, name: arn.split(/[:/]/).pop(), region: arn.split(':')[3] || REGION });
  }
  const { purge, kept } = plan.selectRetained({ inventory: [...items.values()], instance: INSTANCE, stackNames, keepArchives: KEEP_ARCHIVES });
  return { purge: purge.map((i) => ({ ...i, name: guard(i.name || i.id, i.kind) })), kept };
}

function ssmParams() {
  return (listing(['ssm', 'get-parameters-by-path', '--path', SSM_ROOT, '--recursive', '--region', REGION]).Parameters || []).map((p) => p.Name);
}

/** The assistant directory's entries, read before anything is deleted. */
function directoryParams() {
  return listing(['ssm', 'get-parameters-by-path', '--path', `${SSM_ROOT}/assistant-directory`, '--region', REGION]).Parameters || [];
}

// ── 3. The plan ───────────────────────────────────────────────────────────────────────────────────

console.log(`\n▶ Teardown of instance "${INSTANCE}" (stacks ${PREFIX}*) - ${MODE}\n`);
warnUnprotected();
const { stacks, retired } = standingStacks();
stacks.forEach((s) => guard(s.name, 'stack'));
const rounds = (() => {
  try {
    return plan.deletionRounds(stacks, importsOf(stacks), REGION);
  } catch (err) {
    console.error(`\n✗ ${err.message}\n`);
    return process.exit(1);
  }
})();
// Every name CloudFormation generates a physical name from (`<stack>-<logical id>-<suffix>`), current and
// retired, standing or not: a resource a stack retained still carries that stack's name after it is gone.
const KNOWN_STACK_NAMES = plan.knownStackNames(PREFIX, stacks.map((s) => s.name));
const retainedPlan = inventory(KNOWN_STACK_NAMES);
const params = ssmParams();
// EVERY ASSISTANT IDENTITY IS THE PROVISIONER'S (ADR-048, amended 2026-10-24): a stack's seed removes what it
// declared as its stack is deleted, and never fails the delete. No seed removes an assistant created in the console,
// so those are removed BEFORE the stacks (`plan.consoleAssistantsToRetireFirst`); what is left after the stacks is
// what no stack could reach, such as an identity a seed could not remove, and the sweep below removes it.
const directory = directoryParams();
const retireFirst = plan.consoleAssistantsToRetireFirst(directory, SSM_ROOT);
const retiredFirst = new Set(retireFirst.map((a) => a.assistant));
const identities = plan.assistantIdentitiesToRemove(directory, SSM_ROOT).filter((i) => !retiredFirst.has(i.assistant));

console.log(`Stacks to delete (${stacks.length}${retired.length ? `, ${retired.length} on the earlier layout` : ''}), in ${rounds.length} round(s):`);
rounds.forEach((round, i) => console.log(`   ${i + 1}. ${round.map((s) => (s.region === REGION ? s.name : `${s.name}@${s.region}`)).join(', ')}`));
console.log('\nRetained resources to purge:');
for (const kind of plan.PURGEABLE_KINDS) {
  const of = retainedPlan.purge.filter((i) => i.kind === kind);
  console.log(`   ${kind} (${of.length})`);
  of.forEach((i) => console.log(`      - ${i.name}${i.name !== i.id ? ` (${i.id})` : ''}${i.instanceTag === INSTANCE ? '' : ' [by name]'}`));
}
console.log(`   SSM parameters under ${SSM_ROOT}/ (${params.length})`);
console.log(`\nAssistants created in the console, removed before the stacks (${retireFirst.length}):`);
retireFirst.forEach((i) => console.log(`   - ${i.assistant}${i.botArn ? ` identity ${i.botArn}` : ''}${i.lexBotId ? ` Lex bot ${i.lexBotId}` : ''}`));
console.log(`\nAssistant identities the directory records, removed after the stacks (${identities.length}):`);
identities.forEach((i) => console.log(`   - ${i.assistant}${i.botArn ? ` identity ${i.botArn}` : ''}${i.lexBotId ? ` Lex bot ${i.lexBotId}` : ''}`));
if (retainedPlan.kept.length) {
  console.log('\nFound and KEPT:');
  retainedPlan.kept.forEach(({ item, why }) => console.log(`   - ${item.kind} ${item.name || item.id}: ${why}`));
}
if (KEEP_ARCHIVES) {
  console.log('\n   NOTE: kept archive buckets are RETAIN and fixed-name, so a fresh redeploy FAILS early validation');
  console.log('   on them ("already exists"). Import or remove them before redeploying.');
}
console.log('\nDeploy config:');
retireDeployOrigins({ preview: true });

if (!CONFIRM) {
  warnUnprotected();
  console.log('\n(DRY-RUN - nothing deleted. Re-run with --confirm to execute.)\n');
  process.exit(0);
}

// ── 4. Delete the stacks, round by round ──────────────────────────────────────────────────────────

/** Delete one stack and wait. On DELETE_FAILED, retain what failed and retry, at most twice. */
function deleteStack({ name, region }) {
  guard(name, 'stack');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stuck = attempt === 0 ? [] : (listing(['cloudformation', 'list-stack-resources', '--stack-name', name, '--region', region]).StackResourceSummaries || [])
      .filter((x) => x.ResourceStatus === 'DELETE_FAILED').map((x) => x.LogicalResourceId);
    if (attempt > 0) console.log(`   ↻ ${name} DELETE_FAILED; retaining [${stuck.join(', ')}] and retrying`);
    run('aws', ['cloudformation', 'delete-stack', '--stack-name', name, '--region', region,
      ...(stuck.length ? ['--retain-resources', ...stuck] : [])], { capture: false });
    if (run('aws', ['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', name, '--region', region], { capture: false }).status === 0) {
      console.log(`   ✓ deleted ${name}`);
      return;
    }
  }
  console.error(`   ✗ ${name} is still standing after three attempts`);
}

/** Remove one assistant's identity and Lex bot, guarded, and return what is still there. */
function removeAssistant(i) {
  if (i.botArn) guard(i.botArn, 'assistant-identity');
  if (i.lexBotId) guard(i.lexBotId, 'lex-bot');
  return plan.removeAssistantResources(i, (args) => run('aws', [...args, '--region', REGION]));
}
/** The assistants whose identity or Lex bot could not be removed, by name, with what remains. */
const assistantsLeft = new Map();

// THE CONSOLE-CREATED ASSISTANTS FIRST: no seed removes one. Its entry goes only once its identity and bot are gone;
// one that remains keeps its entry, is reported, and is tried again after the stacks.
console.log('\n▶ Removing the assistants created in the console...');
for (const i of retireFirst) {
  const remaining = removeAssistant(i);
  if (remaining.length) {
    assistantsLeft.set(i.assistant, remaining);
    identities.push(i);
    console.error(`   ✗ ${i.assistant}: still there: ${remaining.join(', ')}; its directory entry is kept, and it is tried again after the stacks`);
    continue;
  }
  run('aws', ['ssm', 'delete-parameter', '--name', guard(i.parameter, 'ssm-param'), '--region', REGION]);
  console.log(`   • ${i.assistant}`);
}

console.log('\n▶ Deleting stacks...');
for (const round of rounds) for (const s of round) deleteStack(s);

const leftover = standingStacks().stacks;
if (leftover.length) {
  console.error(`\n✗ Stacks still standing: ${leftover.map((s) => `${s.name}@${s.region} (${s.status})`).join(', ')}.`);
  console.error('  Aborting BEFORE the purge: a retained resource is purged only once no stack of this instance holds it.');
  process.exit(1);
}
console.log('   ✓ no stack of this instance remains');

// ── 5. Purge the retained resources ───────────────────────────────────────────────────────────────

/** Empty (every version and delete marker) then delete a bucket. */
function purgeBucket(name) {
  run('aws', ['s3', 'rm', `s3://${name}`, '--recursive'], { capture: false });
  for (const key of ['Versions', 'DeleteMarkers']) {
    for (;;) {
      const page = awsJson(['s3api', 'list-object-versions', '--bucket', name, '--max-items', '500']);
      const objects = ((page && page[key]) || []).map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
      if (!objects.length) break;
      // The payload goes through a file (file://) so the JSON never has to survive shell quoting.
      const tmp = path.join(BACKEND_DIR, `.teardown-del-${process.pid}.json`);
      fs.writeFileSync(tmp, JSON.stringify({ Objects: objects, Quiet: true }));
      run('aws', ['s3api', 'delete-objects', '--bucket', name, '--delete', `file://${tmp}`]);
      fs.rmSync(tmp, { force: true });
      if (objects.length < 500) break;
    }
  }
  run('aws', ['s3api', 'delete-bucket', '--bucket', name], { capture: false });
}

function purgeUserPool(item) {
  const pool = (awsJson(['cognito-idp', 'describe-user-pool', '--user-pool-id', item.id, '--region', item.region]) || {}).UserPool || {};
  if (pool.DeletionProtection === 'ACTIVE') {
    console.error(`   ✗ user pool ${item.name} has deletion protection on; turn it off and re-run`);
    return;
  }
  // A pool with a domain cannot be deleted until the domain is.
  for (const domain of [pool.Domain, pool.CustomDomain].filter(Boolean)) {
    run('aws', ['cognito-idp', 'delete-user-pool-domain', '--domain', domain, '--user-pool-id', item.id, '--region', item.region], { capture: false });
  }
  run('aws', ['cognito-idp', 'delete-user-pool', '--user-pool-id', item.id, '--region', item.region], { capture: false });
}

function purgeTable(item) {
  run('aws', ['dynamodb', 'update-table', '--table-name', item.id, '--no-deletion-protection-enabled', '--region', item.region]);
  run('aws', ['dynamodb', 'delete-table', '--table-name', item.id, '--region', item.region], { capture: false });
  // A table is listed while it is DELETING; wait, so the verification below reads the settled state.
  run('aws', ['dynamodb', 'wait', 'table-not-exists', '--table-name', item.id, '--region', item.region], { capture: false });
}

function purgeKey(item) {
  for (const alias of item.aliases || []) run('aws', ['kms', 'delete-alias', '--alias-name', alias, '--region', item.region], { capture: false });
  run('aws', ['kms', 'schedule-key-deletion', '--key-id', item.id, '--pending-window-in-days', '7', '--region', item.region], { capture: false });
}

const PURGE = {
  bucket: (i) => purgeBucket(i.id),
  'user-pool': purgeUserPool,
  table: purgeTable,
  stream: (i) => {
    run('aws', ['kinesis', 'delete-stream', '--stream-name', i.id, '--enforce-consumer-deletion', '--region', i.region], { capture: false });
    run('aws', ['kinesis', 'wait', 'stream-not-exists', '--stream-name', i.id, '--region', i.region], { capture: false });
  },
  'app-instance': (i) => run('aws', ['chime-sdk-identity', 'delete-app-instance', '--app-instance-arn', i.id, '--region', i.region], { capture: false }),
  'kms-key': purgeKey,
};

// THE ASSISTANT IDENTITIES, before the app instance and the directory they are recorded in go. A seed removed the
// declared ones with their stacks, so most of these are already gone; "already gone" is not a failure.
console.log('\n▶ Removing assistant identities the stacks did not own...');
for (const i of identities) {
  const remaining = removeAssistant(i);
  if (remaining.length) {
    assistantsLeft.set(i.assistant, remaining);
    console.error(`   ✗ ${i.assistant}: still there: ${remaining.join(', ')}`);
  } else {
    assistantsLeft.delete(i.assistant);
    console.log(`   • ${i.assistant}`);
  }
}
// AN ASSISTANT STILL STANDING KEEPS ITS DIRECTORY ENTRY through the purge, so a rerun finds its ids again.
const keptEntries = new Set([...assistantsLeft.keys()].map((a) => `${SSM_ROOT}/assistant-directory/${a}`));
const purgedParams = params.filter((n) => !keptEntries.has(n));

console.log('\n▶ Purging retained resources...');
// The app instance goes LAST: deleting it cascades the channels and flows the stacks left behind.
const ordered = [...retainedPlan.purge.filter((i) => i.kind !== 'app-instance'), ...retainedPlan.purge.filter((i) => i.kind === 'app-instance')];
for (const item of ordered) {
  plan.assertPurgeable(item); // never a secret, never a name holding external keys
  guard(item.name || item.id, item.kind);
  PURGE[item.kind](item);
  console.log(`   • ${item.kind} ${item.name}`);
}
for (let i = 0; i < purgedParams.length; i += 10) {
  const batch = purgedParams.slice(i, i + 10).map((n) => guard(n, 'ssm-param'));
  run('aws', ['ssm', 'delete-parameters', '--names', ...batch, '--region', REGION]);
}
console.log(`   • ${purgedParams.length} SSM parameters under ${SSM_ROOT}/${keptEntries.size ? ` (${keptEntries.size} directory entries kept for the assistants still standing)` : ''}`);

// ── 6. Verify, and only then report success ───────────────────────────────────────────────────────

/** True when a purged item is still there in a state that is not "on its way out". */
function stillThere(item) {
  if (item.kind === 'kms-key') {
    const meta = (awsJson(['kms', 'describe-key', '--key-id', item.id, '--region', item.region]) || {}).KeyMetadata;
    return Boolean(meta && meta.KeyState !== 'PendingDeletion');
  }
  return true;
}
const after = inventory(KNOWN_STACK_NAMES).purge.filter(stillThere);
const paramsAfter = ssmParams();
const stacksAfter = standingStacks().stacks;
if (after.length || paramsAfter.length || stacksAfter.length || assistantsLeft.size) {
  console.error('\n✗ Teardown INCOMPLETE. Still present:');
  stacksAfter.forEach((s) => console.error(`   - stack ${s.name}@${s.region} (${s.status})`));
  assistantsLeft.forEach((remaining, a) => console.error(`   - assistant ${a}: ${remaining.join(', ')}`));
  after.forEach((i) => console.error(`   - ${i.kind} ${i.name}`));
  if (paramsAfter.length) console.error(`   - ${paramsAfter.length} SSM parameters under ${SSM_ROOT}/`);
  console.error('\n  Re-run to retry: every step re-reads what is actually there.');
  process.exit(1);
}

// ── 7. Retire the deploy config's CloudFront origins ──────────────────────────────────────────────
//
// `appUrl` / `adminAppUrl` name the distributions this teardown just deleted. Leaving them is not
// inert: `deploy.mjs` resolves the live origin only when the value is ABSENT, so a stale value is taken
// at face value and every hosted call of the rebuild is CORS-blocked. The previous values are kept in a
// .bak-preteardown alongside, so nothing is lost.
function retireDeployOrigins({ preview = false } = {}) {
  const p = path.join(BACKEND_DIR, 'deploy.config.json');
  if (!fs.existsSync(p)) return;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    console.log('   • deploy.config.json is unparseable - leaving it alone');
    return;
  }
  const retiring = ['appUrl', 'adminAppUrl'].filter((k) => cfg[k]);
  if (!retiring.length) {
    console.log('   ✓ deploy.config.json names no CloudFront origins - nothing to retire');
    return;
  }
  const detail = retiring.map((k) => `${k}=${cfg[k]}`).join(', ');
  // The plan PREVIEWS; the rewrite happens after the deletion is verified, so a teardown that aborts
  // half way leaves the config describing the deployment that is still standing.
  if (preview || !CONFIRM) {
    console.log(`   • ${CONFIRM ? 'will retire' : 'would retire'}: ${detail}`);
    return;
  }
  const backup = `${p}.bak-preteardown`;
  fs.copyFileSync(p, backup);
  for (const k of retiring) cfg[k] = '';
  fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`   ✓ emptied ${retiring.join(' + ')} in deploy.config.json (was: ${detail})`);
  console.log(`     previous config kept at ${path.basename(backup)}`);
}

console.log('\n▶ Retiring the deploy config\'s CloudFront origins...');
retireDeployOrigins();

console.log(`
✅ Teardown of "${INSTANCE}" complete, and verified: no stack, retained resource or SSM parameter of it remains
   (the archive KMS key is scheduled for deletion in 7 days). Secrets were left untouched.

   Rebuild: npm run deploy, then the re-provisioning scripts and validate.mjs:
     ADMIN_EMAIL=<you> node scripts/provision-admin.mjs
     node scripts/provision-test-users.mjs
     node scripts/provision-test-users.mjs --cast ops-demo
     npx ts-node scripts/seed-demo.ts
   Both provisioning runs read the test inbox from deploy.config.json (testInboxDomain, testInboxBucket,
   testInboxPrefix), so the e2e users and the demo cast land on its domain again with no environment set.
`);
