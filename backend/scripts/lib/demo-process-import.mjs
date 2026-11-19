/**
 * THE DEMO'S REQUEST-STARTED PROCESS, IMPORTED FROM ITS SHIPPED MANIFEST: Advisor's `account-briefs`
 * (`demo/portable-assistants/advisor-processes.ts`), the process a person's request for an account brief starts.
 *
 * The same route a team uses to move a process between instances (`/process-import`, SPEC-PROCESSES P13), signed with the
 * operator's IAM credentials as every ops script's call is (`profile-api-client.mjs`): the process lands in a draft cloned
 * from Advisor's active version, which declares the workflow of every multi-step intent, so the account brief's workflow is
 * there to link; a deployment that lacks what the process needs refuses it with codes, which are printed, and nothing is
 * activated. The draft then takes the account brief's labeled workflow (`advisorIntentWorkflows`), since a stage's label is the
 * owner's version's own and no manifest carries it, is validated and activated, and the active version read back.
 *
 * A run whose active version already holds the process as the manifest carries it writes nothing. An open draft is a team's
 * work in progress and is refused unless `replace` asks to add the process to it.
 *
 * Reads the compiled `demo/portable-assistants/advisor-processes.js`, so the caller builds first (the npm script does).
 */
import { profileApiClient, must, validationRefusals } from './profile-api-client.mjs';

/**
 * Import Advisor's account brief process.
 *
 * @returns {Promise<{ outcome: 'imported' | 'unchanged' | 'refused' | 'dry-run', version?: number, configId?: string, reason?: string }>}
 */
export async function importDemoProcesses({ env = process.env, dryRun = false, replace = false, log = console.log, error = console.error } = {}) {
  const { advisorBriefProcessManifest, advisorBriefWorkflowIsCurrent, advisorIntentWorkflows, ADVISOR_ASSISTANT } = await import('../../../demo/portable-assistants/advisor-processes.js');
  const { opsProcessIsCurrent } = await import('../../../demo/portable-assistants/ops-assistant-manifest.js');
  const region = env.AWS_REGION || 'us-east-1';
  const { call } = await profileApiClient({ env, region });
  const manifest = advisorBriefProcessManifest();
  const owner = ADVISOR_ASSISTANT;

  log(`${owner}: import the ${manifest.processName} process (${manifest.contentHash.slice(0, 12)})`);
  const exported = must(await call('/export', { profileName: owner }), 'reading the active version').manifest;
  if (opsProcessIsCurrent(exported?.body, manifest) && advisorBriefWorkflowIsCurrent(exported?.body)) {
    log('  nothing to change: the active version already holds the process as its manifest carries it, and the account brief\'s labeled workflow.');
    return { outcome: 'unchanged' };
  }
  if (dryRun) {
    log('  --dry-run: nothing was written.');
    return { outcome: 'dry-run' };
  }

  let landed = await call('/process-import', { manifest, profileName: owner });
  if (landed.body?.code === 'DRAFT_EXISTS' && typeof landed.body?.configId === 'string') {
    if (!replace) {
      const reason = `${owner} has an open draft (${landed.body.configId}), which may be a team's work in progress. `
        + 'Activate or discard it in the console, or add the process to it with npm run demo-processes -- import --replace.';
      error(`  Refused: ${reason}`);
      return { outcome: 'refused', reason };
    }
    log(`  adding the process to the open draft ${landed.body.configId}`);
    landed = await call('/process-import', { manifest, profileName: owner, replaceConfigId: landed.body.configId });
  }
  if (landed.body?.code === 'PROCESS_REQUIREMENTS_UNMET' || landed.body?.code === 'PROCESS_MANIFEST_REFUSED') {
    const lines = [...(landed.body.refusals ?? []).map((r) => JSON.stringify(r)), ...(landed.body.errors ?? [])];
    const reason = `this deployment does not have what the ${manifest.processName} process needs:\n  ${lines.join('\n  ')}`;
    error(`  Refused: ${reason}`);
    return { outcome: 'refused', reason };
  }
  const { configId } = must(landed, `importing the ${manifest.processName} process`);
  log(`  the ${manifest.processName} process landed in the draft (configId ${configId})`);
  // THE STAGE'S LABEL IS THE OWNER'S VERSION'S OWN, not the manifest's: the draft takes the account brief's labeled workflow,
  // beside every other request-started workflow the active version declares.
  // SAVING THE DRAFT GIVES IT A NEW configId, and that draft is the one validated and activated.
  const labeled = must(await call('/draft', { profileName: owner, configId, patch: { intentWorkflows: { ...(exported?.body?.intentWorkflows ?? {}), ...advisorIntentWorkflows() } } }), 'labeling the account brief\'s stage');
  const draftConfigId = labeled.draftConfigId;
  log('  the account brief\'s step is labeled as the process\'s stage');
  const valid = must(await call('/validate', { profileName: owner }), 'validating the draft');
  const refusals = validationRefusals(valid);
  if (refusals.length) {
    const reason = `validation refused the draft, which is left for you to read in the console:\n  ${refusals.join('\n  ')}`;
    error(`  Refused: ${reason}`);
    return { outcome: 'refused', reason, configId };
  }
  if (valid.configId !== draftConfigId) {
    const reason = `the draft was saved again while it was being imported (validated ${valid.configId}, labeled ${draftConfigId}), so nothing was activated`;
    error(`  Refused: ${reason}`);
    return { outcome: 'refused', reason, configId: valid.configId };
  }
  for (const w of valid.warnings ?? []) log(`  warning: ${typeof w === 'string' ? w : JSON.stringify(w)}`);
  const activated = must(await call('/activate', { profileName: owner, configId: draftConfigId }), 'activating the draft');
  log(`  ✓ ${owner} v${activated.version} is active (configId ${draftConfigId}).`);

  // READ BACK, so a version that activated without the process as the manifest carries it is reported here.
  const after = must(await call('/export', { profileName: owner }), 'reading the activated version').manifest;
  if (!opsProcessIsCurrent(after?.body, manifest) || !advisorBriefWorkflowIsCurrent(after?.body)) {
    const reason = `the active version does not hold processes.${manifest.processName} as its manifest carries it, or the account brief's labeled workflow`;
    error(`  ✗ ${reason}.`);
    return { outcome: 'refused', reason, version: activated.version, configId: draftConfigId };
  }
  log(`  ✓ its export holds the ${manifest.processName} process.`);
  return { outcome: 'imported', version: activated.version, configId: draftConfigId };
}
