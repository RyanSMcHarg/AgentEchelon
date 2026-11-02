/**
 * AFTER A DEPLOY: SAY WHICH DECLARED ASSISTANTS ARE RETIRED IN THE CONSOLE (ADR-048, amended 2026-10-23).
 *
 * Reads the assistant directory (read only) and prints each assistant the deployment declares that a person
 * retired in the console, which the deploy's seed left retired. Best-effort: a read that fails is said, and
 * never fails the deploy that already succeeded.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { declaredAssistantsOf, retiredInTheConsole, reportLines, consoleAssistantsOrphanedBy, orphanRefusal } = require('./declared-assistants.cjs');

/**
 * BEFORE A DEPLOY: REFUSE A CONFIGURATION THAT WOULD ORPHAN A CONSOLE-CREATED ASSISTANT (ADR-048, amended
 * 2026-10-24). A classification's seed never fails its stack's delete, so the refusal that a classification is not
 * removed while the console's assistants are active in it lives here, before anything deploys. Returns the refusal,
 * or null. A directory that cannot be read is a refusal too: whether an assistant would be orphaned is then unknown.
 */
export async function orphanedConsoleAssistantsRefusal({ profilesConfig, ssmRoot, region }) {
  let entries;
  try {
    entries = await directoryEntries(ssmRoot, region);
  } catch (err) {
    return `could not read the assistant directory (${err?.message || err}), so whether this configuration orphans an `
      + 'assistant created in the console is unknown; nothing was deployed';
  }
  return orphanRefusal(consoleAssistantsOrphanedBy(profilesConfig, entries));
}

/** Every directory entry by name. */
export async function directoryEntries(ssmRoot, region) {
  const { SSMClient, GetParametersByPathCommand } = await import('@aws-sdk/client-ssm');
  const ssm = new SSMClient({ region });
  const out = new Map();
  const prefix = `${ssmRoot}/assistant-directory/`;
  let token;
  do {
    const res = await ssm.send(new GetParametersByPathCommand({ Path: `${ssmRoot}/assistant-directory`, NextToken: token }));
    for (const p of res.Parameters ?? []) {
      try { out.set(p.Name.slice(prefix.length), JSON.parse(p.Value)); } catch { /* an unreadable entry names nobody */ }
    }
    token = res.NextToken;
  } while (token);
  return out;
}

/** Print the report for a deployment's set (`resolveDeploymentProfiles`), optionally narrowed to some classifications. */
export async function printDeclaredButRetired({ profilesConfig, ssmRoot, region, classifications }) {
  try {
    const declared = declaredAssistantsOf(profilesConfig).filter((d) => !classifications || classifications.includes(d.classification));
    for (const line of reportLines(retiredInTheConsole(declared, await directoryEntries(ssmRoot, region)))) console.log(line);
  } catch (err) {
    console.warn(`\n• Could not read which declared assistants are retired in the console: ${err?.message || err}`);
  }
}
