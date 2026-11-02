#!/usr/bin/env node
/**
 * ADD AN ASSISTANT ROLE TO THIS DEPLOYMENT, AND DEPLOY IT: `npm run add-assistant-role -- [assistant] [flags]`.
 *
 * A role is deployed exactly when the deployment declares it. A role the shipped catalog offers is declared by
 * naming its assistant in `profiles` in backend/deploy.config.json beside its classification
 * (`["basic", "standard", "premium", "ops-premium"]` deploys the premium ops assistant). This writes that one
 * name and runs the guarded single-stack deploy of the classification's stack:
 *
 *   npm run deploy:stack -- <prefix>Assistants-<classification>
 *
 * which builds, applies the whole of deploy.config.json, checks the stack against `cdk list`, refuses a
 * rollback, prints the diff and deploys (scripts/deploy-stack.mjs). The stack deploys the ROLE: its acting-role
 * grants and reach, which is what the diff shows and a review approves. Its seed then asks the provisioner for
 * the role's declared assistant, once (ADR-048, amended 2026-10-24): built when it is absent, left alone when it
 * exists, and not recreated when it was retired in the console, which the deploy says.
 *
 *   [assistant]   the role assistant to add, default ops-premium (the premium ops assistant)
 *   --dry-run     print the config change and the deploy command, and do neither
 *   --remove      take the name back out and deploy the same stack, which withdraws the ROLE. A role and the
 *                 assistants filling it are separate: the withdrawal is refused while any assistant (declared or
 *                 created in the console) still fills the role, naming them, so retire them in the console first.
 *                 Once none does, the withdrawal releases the declared assistant a console retire left as a
 *                 tombstone, so a later add seeds it afresh under the same name
 *
 * Refused, before anything is written: a checkout that is not this instance's deploy checkout (a git work tree
 * holding a deploy.config.json a deploy has already run from), an unparseable config, a config still carrying
 * the retired `additionalRoles` key, a custom `profiles` set (it declares roles on its own entries), a name the
 * catalog does not offer, and a --remove while an assistant fills the role (read from the assistant directory;
 * the deploy's provisioner refuses the same withdrawal). If the deploy fails, the config keeps the new name, and
 * rerunning deploys it again.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  parseRoleArgs, roleSelection, withProfilesText, assistantsStackFor, deployArgs, checkoutRefusal,
  ROLE_FILLING_MODULE, withdrawalRefusal,
} = require('./lib/assistant-role-config.cjs');
const { resolveInstancePrefix } = require('./lib/deploy-guards.cjs');
const { resolveInstanceName } = require('./lib/stack-lookup.cjs');

const REGION = process.env.AWS_REGION || 'us-east-1';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(BACKEND_DIR, 'deploy.config.json');
const npm = (args, label) => {
  console.log(`\n▶ ${label}\n  npm ${args.join(' ')}`);
  return spawnSync('npm', args, { cwd: BACKEND_DIR, shell: process.platform === 'win32', stdio: 'inherit' }).status;
};

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(2);
}

let args;
try {
  args = parseRoleArgs(process.argv.slice(2));
} catch (err) {
  fail(err.message);
}
if (args.help) {
  console.log('Usage: npm run add-assistant-role -- [assistant, default ops-premium] [--dry-run] [--remove]');
  process.exit(0);
}

// THE DEPLOY CHECKOUT, refused before anything is built or written.
const inGit = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: BACKEND_DIR, encoding: 'utf8' });
const configExists = existsSync(CONFIG_PATH);
const configText = configExists ? readFileSync(CONFIG_PATH, 'utf8') : '';
const refusal = checkoutRefusal({ isGitWorkTree: inGit.status === 0 && inGit.stdout.trim() === 'true', configExists, configText });
if (refusal) fail(refusal);

// THE CATALOG, read from the compiled library so the names are the ones synth will read. Built first, as the
// deploy itself is, so a stale compiled copy never decides which names exist.
if (npm(['run', 'build'], 'Compile, so the catalog read below is the source') !== 0) fail('the build failed; nothing was written');
const { shippedRoleAssistants, resolveDeploymentProfiles } = require('../lib/config/profiles.js');
const defaultSelection = resolveDeploymentProfiles(undefined).classifications.filter((c) => !c.adminPlane).map((c) => c.value);

let selection;
try {
  selection = roleSelection(JSON.parse(configText).profiles, args.assistant, {
    offered: shippedRoleAssistants(), defaultSelection, remove: args.remove,
  });
} catch (err) {
  fail(err.message);
}
const stack = assistantsStackFor(resolveInstancePrefix(process.env), selection.classification);
const deploy = deployArgs(stack);

console.log(`\n${args.remove ? 'Removing' : 'Adding'} the ${selection.role} assistant of ${selection.classification} (${args.assistant}).`);
console.log(`  profiles before: ${JSON.stringify(selection.before)}`);
console.log(`  profiles after:  ${JSON.stringify(selection.after)}${selection.changed ? '' : '   (unchanged: it already says this)'}`);
console.log(`  then:            npm ${deploy.join(' ')}`);

// A ROLE IS WITHDRAWN ONLY ONCE NO ASSISTANT FILLS IT, checked before the config is written. The deploy's provisioner
// refuses the same withdrawal, so this is the earlier of two layers, not the only one.
if (args.remove) {
  const { directoryEntries } = await import('./lib/declared-assistants-report.mjs');
  // The provisioner's own rule, compiled by the build above (`lambda/src/lib/role-filling.ts`).
  const { assistantsFilling } = require(ROLE_FILLING_MODULE);
  let fillers;
  try {
    fillers = assistantsFilling(await directoryEntries(`/${resolveInstanceName(process.env)}`, REGION), selection.classification, selection.role);
  } catch (err) {
    fail(`could not read the assistant directory (${err?.message || err}), so whether an assistant still fills the `
      + `${selection.role} role is unknown; nothing was written`);
  }
  const refusal = withdrawalRefusal(fillers, selection);
  if (refusal) fail(refusal);
}

if (args.dryRun) {
  console.log('\n--dry-run: nothing was written and nothing was deployed.');
  process.exit(0);
}

if (selection.changed) {
  let next;
  try {
    next = withProfilesText(configText, selection.after);
  } catch (err) {
    fail(err.message);
  }
  writeFileSync(CONFIG_PATH, next);
  console.log(`\n  wrote profiles to ${path.relative(process.cwd(), CONFIG_PATH) || CONFIG_PATH}`);
}

const status = npm(deploy, `Deploy ${stack}, the stack that deploys the ${selection.role} role and seeds its assistant`);
if (status !== 0) {
  console.error(`\n✗ the deploy failed (exit ${status}). deploy.config.json keeps ${JSON.stringify(selection.after)}; `
    + 'rerun this command to deploy it again.');
  process.exit(status || 1);
}
console.log(args.remove
  ? `\n✓ The ${selection.role} role is withdrawn from ${stack}. No assistant filled it, and a declared ${args.assistant} `
    + 'retired in the console is released, so adding the role again seeds it afresh.'
  : `\n✓ The ${selection.role} role is deployed in ${stack}, and the provisioner seeds ${args.assistant} when it is absent (a retire in the console sticks). See what the rollout created: node scripts/show-ops-rollout.mjs ${selection.classification} ${selection.role}`);
