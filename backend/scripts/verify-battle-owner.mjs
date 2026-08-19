/**
 * verify-battle-owner.mjs — a duel records who started it, against a LIVE deployment.
 *
 * WHY A SCRIPT AND NOT AN E2E ASSERTION. Ownership is enforced server-side and is invisible to the
 * browser: nothing renders it, and its EFFECT (a non-initiator's reply not resuming a side) needs a
 * side sitting in WAITING_FOR_USER, which no duel currently reaches - the round-1 prompt never asks a
 * model to raise a clarifying question (ADR-029). So the reachable property is the one this checks:
 * every duel in the window has an owner recorded WHERE THE ENFORCEMENT READS IT, and the sides of one
 * duel do not disagree about who that is.
 *
 * WHERE THE ENFORCEMENT READS IT is the correction this script exists in its second form to make. The
 * owner was originally recorded on the per-bot BattleState rows, and the rows do not keep it - the
 * terminal transition rewrote the whole item, so a duel's owner was erased by its own completion. The
 * durable record is `activeBattleInitiator` on the channel pointer. This checks the pointer FIRST and
 * treats the rows as corroboration.
 *
 * THE ALLOWANCE THAT MADE THE FIRST VERSION USELESS. It excused any duel with no recorded owner as
 * "PRE-EXISTING (predates the field)" - with no bound on what "predates" meant. Duels created 32
 * minutes AFTER the deploy were waved through, and the script printed PASS over a live defect. An
 * exception with no limit is not a tolerance, it is an exemption.
 *
 * So the allowance is now BOUNDED BY THE DEPLOYMENT ITSELF: a duel is excused only if it started
 * before the currently-deployed channel-flow processor was published (`LastModified`). Anything newer
 * than the code that is supposed to record the owner FAILS. If the deploy time cannot be resolved,
 * the script fails rather than falling back to an unbounded allowance - an unverifiable check must not
 * report PASS.
 *
 * WHAT IT DOES NOT PROVE, stated because the gap matters more than the check: that a non-owner is
 * actually refused. That path cannot fire until a duel can reach WAITING_FOR_USER again. The refusal
 * itself is covered by unit tests at the flow seam (backend/test/lib/battle-owner-enforced-live.test.ts),
 * with the real decision function rather than a mock of it.
 *
 * Usage:
 *   AWS_PROFILE=<p> node backend/scripts/verify-battle-owner.mjs [--since-minutes 30]
 */
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const region = process.env.AWS_REGION || 'us-east-1';
const args = process.argv.slice(2);
const sinceIdx = args.indexOf('--since-minutes');
const sinceMinutes = sinceIdx !== -1 ? Number(args[sinceIdx + 1]) : 60;

const instance = process.env.E2E_INSTANCE_NAME || process.env.AE_INSTANCE_NAME || 'agent-echelon';
const stackPrefix = instance.split(/[-_]/).filter(Boolean)
  .map((p) => p[0].toUpperCase() + p.slice(1)).join('');

const ddb = new DynamoDBClient({ region });
const cfn = new CloudFormationClient({ region });
const lambda = new LambdaClient({ region });
const ssm = new SSMClient({ region });

const s = (v) => (v && typeof v === 'object' && 'S' in v ? v.S : undefined);

/** Table names are published to SSM by the Battle stack (SHARED_SSM), which is the stable contract. */
async function resolveTable(envVar, ssmSuffix) {
  if (process.env[envVar]) return process.env[envVar];
  const name = `/${instance}/shared/tables/${ssmSuffix}`;
  const res = await ssm.send(new GetParameterCommand({ Name: name }));
  if (!res.Parameter?.Value) throw new Error(`SSM ${name} is empty`);
  return res.Parameter.Value;
}

/**
 * When the code that records the owner was last published. This is the BOUND on the pre-existing
 * allowance, and the reason it is read from the deployment rather than assumed: the field's age is a
 * property of what is running, not of the calendar.
 */
async function resolveDeployedAt() {
  const res = await cfn.send(new DescribeStacksCommand({ StackName: `${stackPrefix}ChannelFlow` }));
  const out = res.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'ProcessorFunctionArn');
  if (!out?.OutputValue) throw new Error(`no ProcessorFunctionArn output on ${stackPrefix}ChannelFlow`);
  const cfg = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: out.OutputValue }));
  const ms = Date.parse(cfg.LastModified || '');
  if (Number.isNaN(ms)) throw new Error(`unparseable LastModified on ${out.OutputValue}: ${cfg.LastModified}`);
  return ms;
}

async function scanAll(TableName) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({ TableName, ExclusiveStartKey }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function main() {
  const [stateTable, configTable] = await Promise.all([
    resolveTable('BATTLE_STATE_TABLE', 'battle-state-name'),
    resolveTable('CHANNEL_BATTLE_CONFIG_TABLE', 'channel-battle-config-name'),
  ]);
  // Deliberately NOT wrapped in a fallback: without this bound the script cannot tell a legacy duel
  // from a broken one, which is exactly how the first version passed over a live defect.
  const deployedAt = await resolveDeployedAt();
  const cutoff = Date.now() - sinceMinutes * 60_000;
  console.log(`[verify-battle-owner] state=${stateTable} pointer=${configTable} window=${sinceMinutes}m`);
  console.log(`[verify-battle-owner] deployed channel-flow processor: ${new Date(deployedAt).toISOString()} `
    + '(duels started after this are NOT excusable)');

  const [stateRows, configRows] = await Promise.all([scanAll(stateTable), scanAll(configTable)]);

  // battleId -> the channel pointer that still points at it. A channel's pointer moves to the next
  // duel, so only the most recent duel per channel is covered here; older ones fall back to the rows.
  const pointerByBattle = new Map();
  for (const c of configRows) {
    const bid = s(c.activeBattleId);
    if (bid) pointerByBattle.set(bid, { channelArn: s(c.channelArn), owner: s(c.activeBattleInitiator) });
  }

  // Per-bot rows only, by the SAME rule the runtime uses (`botRowsOnly`: any `__`-prefixed sort key is
  // a sentinel). Excluding `__orchestrator__` by name - which is what this did - let `__round1__` and
  // `__complete__` through, so every duel was reported with twice the sides it has and two of them
  // could never carry an owner. A verification that does not partition rows the way the code does is
  // measuring something else.
  const botRows = stateRows.filter((r) => s(r.botArn) && !s(r.botArn).startsWith('__'));
  const recent = botRows.filter((r) => {
    const at = s(r.enteredStateAt);
    return at ? Date.parse(at) >= cutoff : false;
  });

  if (recent.length === 0) {
    console.log('[verify-battle-owner] NO DUEL in the window. Run a battle first '
      + '(node scripts/validate.mjs --only=battle), then re-run this.');
    process.exit(2);
  }

  const byBattle = new Map();
  for (const r of recent) {
    const id = s(r.battleId);
    if (!byBattle.has(id)) byBattle.set(id, []);
    byBattle.get(id).push(r);
  }

  let failures = 0;
  let excused = 0;
  for (const [battleId, sides] of byBattle) {
    // A duel's age is its EARLIEST row: a side that transitions later must not make an old duel look new.
    const startedAt = Math.min(...sides.map((r) => Date.parse(s(r.enteredStateAt) || '') || Infinity));
    const predatesDeploy = Number.isFinite(startedAt) && startedAt < deployedAt;

    const pointer = pointerByBattle.get(battleId);
    const rowOwners = new Set(sides.map((r) => s(r.initiatorUserSub)).filter(Boolean));
    const owner = pointer?.owner || (rowOwners.size === 1 ? [...rowOwners][0] : undefined);
    const age = Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : 'unknown';

    if (rowOwners.size > 1) {
      // Two sides of one duel disagreeing about who started it would make "only the initiator
      // resumes" depend on which side happened to be read first.
      console.error(`  ${battleId}: FAIL - sides disagree about the owner: ${[...rowOwners].join(', ')}`);
      failures++;
      continue;
    }

    if (!owner) {
      if (predatesDeploy) {
        console.log(`  ${battleId}: PRE-EXISTING (started ${age}, before the deployed build) - excused`);
        excused++;
        continue;
      }
      console.error(`  ${battleId}: FAIL - no owner on the pointer or any side, and it started ${age}, `
        + 'AFTER the build that records one');
      failures++;
      continue;
    }

    // The pointer is what the continuation path reads. A duel the pointer still names must carry the
    // owner THERE; finding it only on the rows means the enforcement is running on the fallback.
    if (pointer && !pointer.owner && !predatesDeploy) {
      console.error(`  ${battleId}: FAIL - the channel pointer still names this duel but records no `
        + `initiator (rows say ${owner}); the continuation path would read nothing`);
      failures++;
      continue;
    }

    const src = pointer?.owner ? 'pointer' : 'rows (pointer has moved on)';
    console.log(`  ${battleId}: OK - ${sides.length} sides, owner ${owner} [${src}]`);
  }

  const verified = byBattle.size - failures - excused;
  console.log(failures === 0
    ? `[verify-battle-owner] PASS (${verified} duel(s) verified, ${excused} excused as pre-deploy, `
      + `${byBattle.size} in the window)`
    : `[verify-battle-owner] FAIL (${failures} duel(s))`);
  // A run where EVERY duel was excused proves nothing, and must not read as a pass.
  if (failures === 0 && verified === 0) {
    console.error('[verify-battle-owner] INCONCLUSIVE - every duel in the window predates the deployed '
      + 'build. Run a fresh battle and re-run.');
    process.exit(2);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[verify-battle-owner] error:', err.message);
  process.exit(1);
});
