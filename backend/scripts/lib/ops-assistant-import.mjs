/**
 * THE OPS ASSISTANT'S FIRST VERSION, IMPORTED FROM ITS SHIPPED MANIFEST. The one implementation, called by
 * `npm run add-assistant-role -- ops-premium` as its last step after the deploy, and by `npm run ops-assistant -- import`
 * to run it again.
 *
 * The manifest is built from the demo sources (`demo/portable-assistants/ops-assistant-manifest.ts`) and carries no ARN, account id
 * or region (SPEC-PORTABLE-PROFILES FR14). It goes through the profile API's import, the operator's IAM credentials
 * signing every call as `ops-workflows.mjs` does: landed as a draft, then the ops team's incident response process
 * imported from its own manifest into that draft (SPEC-PROCESSES P13, refused with what the deployment lacks), validated,
 * then activated by the configId the process import answered with, and recorded in the audit like a console import. After
 * activation the active version is exported again and compared with both manifests.
 *
 * Refused while the ops role is not deployed. A run where the active version already says what the manifest says
 * writes nothing. An active version that differs (a team edited it in the console) is left alone and its differing
 * fields are named; `replace` imports over it (and over an open draft, which is otherwise refused too), and `npm run assistant -- rollback ops-premium --version <n>` undoes that.
 *
 * Reads the compiled `demo/ops-assistant-manifest.js`, so the caller builds first (both npm scripts do). Returns what
 * it did and never exits the process: each caller decides its own exit.
 */
import { createRequire } from 'node:module';
import { profileApiClient, must, validationRefusals } from './profile-api-client.mjs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const require = createRequire(import.meta.url);
const { resolveInstanceName } = require('./stack-lookup.cjs');

/** The assistants whose first version this module imports, by name. */
export const IMPORTED_ASSISTANTS = ['ops-premium'];

/** What a dry run of the role script says the import will do, with no AWS call. */
export function importPreview(assistant) {
  return `then:            import ${assistant}'s shipped manifest through the profile API (a draft, validated, then activated); `
    + 'nothing is written when its active version already says what the manifest says';
}

/**
 * Import the shipped manifest onto the ops assistant.
 *
 * @returns {Promise<{ outcome: 'imported' | 'unchanged' | 'refused' | 'dry-run', version?: number, configId?: string, reason?: string }>}
 */
export async function importOpsAssistant({ env = process.env, dryRun = false, replace = false, log = console.log, error = console.error } = {}) {
  const {
    opsAssistantManifest, opsIncidentProcessManifest, opsProcessIsCurrent, withoutProcesses, opsImportPlan, differingBodyKeys, OPS_ASSISTANT,
  } = await import('../../../demo/portable-assistants/ops-assistant-manifest.js');
  const region = env.AWS_REGION || 'us-east-1';
  // The instance's SSM root, from the one resolver every script reads it through.
  const ssmRoot = `/${resolveInstanceName(env)}`;
  const assignment = `${ssmRoot}/assistant-assignments/premium/ops/assistants/${OPS_ASSISTANT}`;

  const ssm = new SSMClient({ region });
  const deployed = await ssm.send(new GetParameterCommand({ Name: assignment })).then(() => true, (e) => {
    if (e?.name === 'ParameterNotFound') return false;
    throw e;
  });
  if (!deployed) {
    const reason = `premium has no ops role on this deployment, so there is no ${OPS_ASSISTANT} to import onto. `
      + 'Deploy it first: npm run add-assistant-role -- ops-premium';
    error(`Refused: ${reason}`);
    return { outcome: 'refused', reason, notDeployed: true };
  }

  const { call } = await profileApiClient({ env, region });

  const manifest = opsAssistantManifest();
  const processManifest = opsIncidentProcessManifest();
  // THE PROFILE API LEARNS A NEW ASSISTANT FROM THE REGISTRY ROW THE DEPLOY PUBLISHES, through a cache, so right after
  // `add-assistant-role` deploys the role it can still answer "unknown or missing profileName" for a few minutes.
  // Wait that out, up to five minutes, rather than fail the import the role command runs.
  let read = await call('/export', { profileName: OPS_ASSISTANT });
  for (let waited = 0; read.status === 400 && /unknown or missing profileName/.test(JSON.stringify(read.body)) && waited < 300; waited += 15) {
    if (waited === 0) log('  the profile API does not list the new assistant yet (its registry cache); waiting for it');
    await new Promise((r) => setTimeout(r, 15_000));
    read = await call('/export', { profileName: OPS_ASSISTANT });
  }
  const exported = must(read, 'reading the active version').manifest;
  const plan = opsImportPlan(exported, manifest, { replace });
  // THE PROCESS IS ITS OWN ARTIFACT, compared with its own manifest.
  const processCurrent = opsProcessIsCurrent(exported?.body, processManifest);

  log(`${OPS_ASSISTANT}: import its shipped manifest (contentHash ${manifest.contentHash.slice(0, 12)}) and its ${processManifest.processName} process (${processManifest.contentHash.slice(0, 12)})`);
  if (plan.action === 'none' && processCurrent) {
    log('  nothing to change: the active version already says what both manifests say.');
    return { outcome: 'unchanged' };
  }
  if (plan.action === 'refuse' && plan.reason === 'unreadable-export') {
    const reason = 'the profile API answered the export with no manifest, so what is active cannot be compared with the shipped one';
    error(`  Refused: ${reason}`);
    return { outcome: 'refused', reason };
  }
  if (plan.action === 'refuse') {
    const reason = `the active version differs from the manifest on ${plan.differing.join(', ')}, which a team may have edited. `
      + 'Import over it with npm run ops-assistant -- import --replace; npm run assistant -- rollback undoes that.';
    error(`  Refused: ${reason}`);
    return { outcome: 'refused', reason };
  }
  log(plan.action === 'none'
    ? `  the assistant already says what its manifest says; its ${processManifest.processName} process is imported.`
    : plan.reason === 'no-active-version'
      ? `  ${OPS_ASSISTANT} has no active version: the manifest becomes its first.`
      : `  replaces the active version, which differs on ${plan.differing.join(', ')}.`);
  if (dryRun) {
    log('  --dry-run: nothing was written.');
    return { outcome: 'dry-run' };
  }

  /** AN OPEN DRAFT IS A TEAM'S UNSAVED WORK, so it is replaced only when asked, as an edited active version is. */
  const openDraftRefusal = (answer) => {
    const reason = `${OPS_ASSISTANT} has an open draft (${answer.body.configId}), which may be a team's work in progress. `
      + 'Activate or discard it in the console, or import over it with npm run ops-assistant -- import --replace.';
    error(`  Refused: ${reason}`);
    return { outcome: 'refused', reason };
  };
  let configId;
  if (plan.action === 'import') {
    const request = { manifest, targetProfileName: OPS_ASSISTANT };
    let imported = await call('/import', request);
    if (imported.body?.code === 'DRAFT_EXISTS' && typeof imported.body?.configId === 'string') {
      if (!replace) return openDraftRefusal(imported);
      log(`  replacing the open draft ${imported.body.configId}`);
      imported = await call('/import', { ...request, replaceConfigId: imported.body.configId });
    }
    ({ configId } = must(imported, 'importing the manifest'));
    log(`  landed as a draft (configId ${configId})`);
  }

  // THE PROCESS, AFTER THE ASSISTANT: into the draft the import just landed, named by its configId, or a draft cloned from
  // the active version. A deployment that lacks what it needs (a conversation type, a role, an assistant's intent) refuses
  // it with codes, which are printed, and nothing is activated.
  const processRequest = { manifest: processManifest, profileName: OPS_ASSISTANT };
  let landedProcess = await call('/process-import', configId ? { ...processRequest, replaceConfigId: configId } : processRequest);
  if (!configId && landedProcess.body?.code === 'DRAFT_EXISTS' && typeof landedProcess.body?.configId === 'string') {
    if (!replace) return openDraftRefusal(landedProcess);
    log(`  adding the process to the open draft ${landedProcess.body.configId}`);
    landedProcess = await call('/process-import', { ...processRequest, replaceConfigId: landedProcess.body.configId });
  }
  if (landedProcess.body?.code === 'PROCESS_REQUIREMENTS_UNMET' || landedProcess.body?.code === 'PROCESS_MANIFEST_REFUSED') {
    const lines = [...(landedProcess.body.refusals ?? []).map((r) => JSON.stringify(r)), ...(landedProcess.body.errors ?? [])];
    const reason = `this deployment does not have what the ${processManifest.processName} process needs:\n  ${lines.join('\n  ')}`;
    error(`  Refused: ${reason}`);
    return { outcome: 'refused', reason, ...(configId ? { configId } : {}) };
  }
  ({ configId } = must(landedProcess, `importing the ${processManifest.processName} process`));
  log(`  the ${processManifest.processName} process landed in the draft (configId ${configId})`);
  const valid = must(await call('/validate', { profileName: OPS_ASSISTANT }), 'validating the draft');
  const refusals = validationRefusals(valid);
  if (refusals.length) {
    const reason = `validation refused the draft, which is left for you to read in the console:\n  ${refusals.join('\n  ')}`;
    error(`  Refused: ${reason}`);
    return { outcome: 'refused', reason, configId };
  }
  for (const w of valid.warnings ?? []) log(`  warning: ${typeof w === 'string' ? w : JSON.stringify(w)}`);
  const activated = must(await call('/activate', { profileName: OPS_ASSISTANT, configId }), 'activating the draft');
  log(`  ✓ ${OPS_ASSISTANT} v${activated.version} is active (configId ${configId}).`);

  // READ BACK, so a version that activated but says something other than the manifest is reported here.
  const after = must(await call('/export', { profileName: OPS_ASSISTANT }), 'reading the activated version').manifest;
  const drift = differingBodyKeys(withoutProcesses(after?.body ?? {}), withoutProcesses(manifest.body));
  if (!opsProcessIsCurrent(after?.body, processManifest)) drift.push(`processes.${processManifest.processName}`);
  if (drift.length) {
    const reason = `the active version differs from the manifest on ${drift.join(', ')}`;
    error(`  ✗ ${reason}.`);
    return { outcome: 'refused', reason, version: activated.version, configId };
  }
  log('  ✓ its export says what both manifests say.');
  return { outcome: 'imported', version: activated.version, configId };
}
