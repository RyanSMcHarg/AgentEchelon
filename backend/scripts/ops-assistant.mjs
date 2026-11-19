/**
 * IMPORT THE OPS ASSISTANT'S SHIPPED MANIFEST AGAIN: `npm run ops-assistant -- import [--dry-run] [--replace]`.
 *
 * `npm run add-assistant-role -- ops-premium` deploys the ops role and, as its last step, imports the ops assistant's
 * first version from its shipped manifest. This runs that same import on its own (`scripts/lib/ops-assistant-import.mjs`,
 * the one implementation): after a role deploy whose import was refused, or to bring a deployment's ops assistant to an
 * edited manifest. A run where the active version already says what the manifest says writes nothing.
 *
 *   --dry-run      print what would happen, and write nothing
 *   --replace      import even though the active version differs from the manifest (a team edited it), or a draft is open
 *   --if-deployed  succeed with nothing written when the ops role is not deployed (the seed phase runs it on every deployment)
 */
import { importOpsAssistant } from './lib/ops-assistant-import.mjs';

const args = process.argv.slice(2);
if (args[0] !== 'import') {
  console.error('usage: npm run ops-assistant -- import [--dry-run] [--replace] [--if-deployed]');
  process.exit(2);
}
const result = await importOpsAssistant({ dryRun: args.includes('--dry-run'), replace: args.includes('--replace') });
if (result.outcome === 'refused' && result.notDeployed && args.includes('--if-deployed')) {
  console.log('  no ops role on this deployment: nothing to import.');
  process.exit(0);
}
if (result.outcome === 'refused') process.exit(1);
if (result.outcome === 'imported') console.log('  Next: npm run ops-workflows -- add');
