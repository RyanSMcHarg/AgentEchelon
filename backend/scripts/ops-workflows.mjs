/**
 * PUT THE PREMIUM PRIMARY'S WELCOMES FOR THE OPS ROOMS ON ITS VERSION, OR TAKE THEM OFF: `npm run ops-workflows -- add|remove [--dry-run]`.
 *
 * `welcome-ops` and `welcome-ops-team` are the Advisor's welcomes for rooms the premium ops role makes real, so they belong
 * on the primary's version only while that role is deployed (`demo/portable-assistants/ops-workflows.ts`). The ops rooms'
 * own workflows (`ops-room`, `incident-triage`) are the ops assistant's, on its version (its manifest), and both modes take
 * them off the Advisor's version. The order:
 *
 *   npm run add-assistant-role -- ops-premium     # deploys the role and imports its assistant's first version
 *   npm run ops-workflows -- add                   # a new version of the primary with the two, validated and activated
 *   ...
 *   npm run ops-workflows -- remove                # a new version without them
 *   npm run add-assistant-role -- ops-premium --remove
 *
 * Each change is a version written through the profile API, the operator's IAM credentials signing every call as the
 * assistant CLI does (`scripts/assistant.mjs`): created, edited, validated and activated like a console edit, recorded
 * in the audit, and undone with `npm run assistant -- rollback <assistant> --version <n>`. `add` is refused while no
 * ops role is deployed. A run with nothing to change writes nothing. `add` also reports whether the ops assistant's active
 * version carries the ops rooms' workflows as its manifest writes them, naming the import that brings it in line, and exits
 * non-zero when it does not.
 *
 *   --assistant <name>   the premium primary to change (default: the one premium's primary assignment names)
 *   --dry-run            print what would change, and write nothing
 *   --replace-draft      replace the assistant's open draft rather than refuse while one is open
 */
import { createRequire } from 'node:module';
import { profileApiClient, must, validationRefusals } from './lib/profile-api-client.mjs';
import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

const require = createRequire(import.meta.url);
const { resolveInstanceName } = require('./lib/stack-lookup.cjs');
const { withOpsWorkflows, opsAssistantGap, OPS_WORKFLOW_KEYS } = await import('../../demo/portable-assistants/ops-workflows.js');
const { OPS_ASSISTANT } = await import('../../demo/portable-assistants/ops-assistant-manifest.js');

const REGION = process.env.AWS_REGION || 'us-east-1';
// The instance's SSM root, from the one resolver every script reads it through.
const SSM_ROOT = `/${resolveInstanceName(process.env)}`;
const OPS_ASSIGNMENT = `${SSM_ROOT}/assistant-assignments/premium/ops/assistants/ops-premium`;

const args = process.argv.slice(2);
const mode = args[0];
const dryRun = args.includes('--dry-run');
const replaceDraft = args.includes('--replace-draft');
const named = args.includes('--assistant') ? args[args.indexOf('--assistant') + 1] : undefined;
if (mode !== 'add' && mode !== 'remove') {
  console.error('usage: npm run ops-workflows -- add|remove [--assistant <name>] [--dry-run] [--replace-draft]');
  process.exit(2);
}

const ssm = new SSMClient({ region: REGION });
const exists = (Name) => ssm.send(new GetParameterCommand({ Name })).then(() => true, (e) => {
  if (e?.name === 'ParameterNotFound') return false;
  throw e;
});

if (mode === 'add' && !(await exists(OPS_ASSIGNMENT))) {
  console.error('Refused: premium has no ops role on this deployment, so its rooms cannot open.');
  console.error('Deploy it first: npm run add-assistant-role -- ops-premium');
  process.exit(1);
}

async function primaryOfPremium() {
  if (named) return named;
  const r = await ssm.send(new GetParametersByPathCommand({ Path: `${SSM_ROOT}/assistant-assignments/premium/primary/assistants/` }));
  const live = (r.Parameters ?? []).map((p) => JSON.parse(p.Value)).find((a) => a.occupancy === 'live');
  if (!live?.assistant) throw new Error('premium has no live primary assistant');
  return live.assistant;
}

const { call } = await profileApiClient({ region: REGION });

// THE OPS ROOMS RUN ON THE OPS ASSISTANT'S OWN VERSION, so `add` reads it and says whether it carries `ops-room` and
// `incident-triage` as its manifest writes them. One that lacks them opens ops rooms with no run; the import that brings it
// in line replaces a team's edits, so it is named here and run by the operator. The run then exits non-zero.
if (mode === 'add') {
  const ops = must(await call('/export', { profileName: OPS_ASSISTANT }), "reading the ops assistant's active version");
  const gap = opsAssistantGap(ops.manifest?.body?.eventWorkflows);
  if (!gap.missing.length && !gap.differs.length) {
    console.log(`${OPS_ASSISTANT}: its active version carries the ops rooms' workflows.`);
  } else {
    if (gap.missing.length) console.error(`${OPS_ASSISTANT}: its active version lacks ${gap.missing.join(', ')}, so its rooms open with no run.`);
    if (gap.differs.length) console.error(`${OPS_ASSISTANT}: its active version holds ${gap.differs.join(', ')} unlike its manifest.`);
    console.error('  See what differs: npm run ops-assistant -- import --dry-run');
    console.error('  Bring it in line: npm run ops-assistant -- import --replace');
    process.exitCode = 1;
  }
}

const profileName = await primaryOfPremium();
const exported = must(await call('/export', { profileName }), 'reading the active version');
const active = exported.manifest?.body ?? {};
const next = withOpsWorkflows(active.eventWorkflows, mode);

console.log(`${profileName}: ${mode} ${OPS_WORKFLOW_KEYS.join(', ')}`);
if (!next.changed) {
  console.log(`  nothing to change: the active version ${mode === 'add' ? 'already carries' : 'carries none of'} them.`);
  process.exit(process.exitCode ?? 0);
}
if (next.keys.length) console.log(`  ${mode === 'add' ? 'adds' : 'removes'}: ${next.keys.join(', ')}`);
if (next.moved.length) console.log(`  takes off, since the ops assistant owns them: ${next.moved.join(', ')}`);
console.log(`  keeps: ${Object.keys(next.eventWorkflows).filter((k) => !OPS_WORKFLOW_KEYS.includes(k)).join(', ') || '(none)'}`);
if (dryRun) {
  console.log('--dry-run: nothing was written.');
  process.exit(process.exitCode ?? 0);
}

let created = await call('/version', { profileName });
if (created.body?.code === 'DRAFT_EXISTS' && typeof created.body?.configId === 'string') {
  // AN OPEN DRAFT IS A TEAM'S UNSAVED WORK, so it is replaced only when asked.
  if (!replaceDraft) {
    console.error(`Refused: ${profileName} has an open draft (${created.body.configId}), which may be a team's work in progress. `
      + 'Activate or discard it in the console, or replace it with --replace-draft.');
    process.exit(1);
  }
  console.log(`  replacing the open draft ${created.body.configId}`);
  created = await call('/version', { profileName, replaceConfigId: created.body.configId });
}
const draftId = must(created, 'creating the draft').draftConfigId ?? created.body.configId;
const edited = must(await call('/draft', { profileName, configId: draftId, patch: { eventWorkflows: next.eventWorkflows } }), 'editing the draft');
const configId = edited.draftConfigId ?? edited.configId ?? draftId;
const valid = must(await call('/validate', { profileName }), 'validating the draft');
const refusals = validationRefusals(valid);
if (refusals.length) {
  console.error(`Refused at validation, and the draft is left for you to read in the console:\n  ${refusals.join('\n  ')}`);
  process.exit(1);
}
for (const w of valid.warnings ?? []) console.log(`  warning: ${typeof w === 'string' ? w : JSON.stringify(w)}`);
const activated = must(await call('/activate', { profileName, configId }), 'activating the draft');
console.log(`  ✓ ${profileName} v${activated.version} is active (configId ${configId}).`);
console.log(`  Undo: npm run assistant -- rollback ${profileName} --version <the version before this one>`);
