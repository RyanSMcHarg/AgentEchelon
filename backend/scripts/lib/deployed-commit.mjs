/**
 * The git and SSM half of the rollback check. `rollbackVerdict` in deploy-guards.cjs makes the
 * decision; this reads what it decides from and writes the record afterwards, for `deploy.mjs` and
 * `deploy-stack.mjs` alike, so the two scripts cannot record or check differently.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

const require = createRequire(import.meta.url);
const {
  deployedCommitParamName,
  deployedCommitRecord,
  parseDeployedCommitRecord,
  rollbackVerdict,
} = require('./deploy-guards.cjs');
const { resolveInstanceName } = require('./stack-lookup.cjs');

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/** The commit being deployed and whether the checkout differs from it. */
export function gitState(cwd) {
  const head = git(['rev-parse', 'HEAD'], cwd);
  if (head.status !== 0) throw new Error(`cannot read the checkout's commit: ${head.stderr || head.stdout}`);
  // Untracked files count: a new source file the build picks up ships as surely as an edited one.
  const status = git(['status', '--porcelain'], cwd);
  return { head: head.stdout.trim(), dirty: String(status.stdout || '').trim().length > 0 };
}

function commitKnown(sha, cwd) {
  return git(['cat-file', '-e', `${sha}^{commit}`], cwd).status === 0;
}

function isAncestor(ancestor, of, cwd) {
  return git(['merge-base', '--is-ancestor', ancestor, of], cwd).status === 0;
}

async function readRecord(ssm, name) {
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: name }));
    return parseDeployedCommitRecord(r.Parameter?.Value);
  } catch (err) {
    if (err?.name === 'ParameterNotFound') return null;
    throw err;
  }
}

/**
 * Refuse (exit 2) if deploying `stacks` from this checkout would remove a live commit. Prints one line
 * per stack. Returns the checkout state for the record step.
 */
export async function assertNoRollback({ stacks, cwd, region, allowRollback = false, allowDirty = false }) {
  const instanceName = resolveInstanceName();
  const ssm = new SSMClient({ region });
  const state = gitState(cwd);
  console.log(`\n▶ Rollback check: deploying ${state.head.slice(0, 8)}${state.dirty ? ' (uncommitted changes)' : ''} to ${stacks.length} stack(s)`);
  const refusals = [];
  for (const stackName of stacks) {
    const deployed = await readRecord(ssm, deployedCommitParamName(instanceName, stackName));
    const known = deployed ? commitKnown(deployed.commit, cwd) : false;
    const verdict = rollbackVerdict({
      stackName,
      head: state.head,
      dirty: state.dirty,
      deployed,
      knownLocally: known,
      isAncestor: deployed && known ? isAncestor(deployed.commit, state.head, cwd) : false,
      allowRollback,
      allowDirty,
    });
    if (verdict.ok) console.log(`  ✓ ${verdict.note}`);
    else refusals.push(verdict.reason);
  }
  if (refusals.length) {
    console.error('\n✗ ROLLBACK CHECK REFUSED the deploy:');
    for (const r of refusals) console.error(`    - ${r}`);
    process.exit(2);
  }
  return state;
}

/** Record the commit each stack now runs. A failed write is reported, never thrown: the deploy happened. */
export async function recordDeployedCommits({ stacks, state, region, by }) {
  const instanceName = resolveInstanceName();
  const ssm = new SSMClient({ region });
  const value = deployedCommitRecord({ commit: state.head, dirty: state.dirty, by });
  let failed = 0;
  for (const stackName of stacks) {
    try {
      await ssm.send(new PutParameterCommand({
        Name: deployedCommitParamName(instanceName, stackName),
        Value: value,
        Type: 'String',
        Overwrite: true,
      }));
    } catch (err) {
      failed += 1;
      console.error(`  ! could not record the deployed commit for ${stackName}: ${err?.message || err}`);
    }
  }
  const msg = `${stacks.length - failed}/${stacks.length} stack(s) recorded at ${state.head.slice(0, 8)}${state.dirty ? ' (dirty)' : ''}`;
  if (failed) console.error(`\n! Deployed-commit record incomplete: ${msg}. The next deploy of those stacks is unchecked.`);
  else console.log(`\n✓ Deployed-commit record: ${msg}.`);
}
