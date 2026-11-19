/**
 * IMPORT THE DEMO'S REQUEST-STARTED PROCESS: `npm run demo-processes -- import [--dry-run] [--replace]`.
 *
 * Imports Advisor's `account-briefs` process from its shipped manifest (`demo/portable-assistants/advisor-processes.ts`) into a
 * draft of Advisor's, validates it and activates it (`scripts/lib/demo-process-import.mjs`). The incident response is the ops
 * assistant's and is imported by `npm run ops-assistant -- import`; this touches Advisor only. A run where the active version
 * already holds the process writes nothing.
 *
 *   --dry-run   print what would happen, and write nothing
 *   --replace   add the process to an open draft of Advisor's, which is otherwise refused
 */
import { importDemoProcesses } from './lib/demo-process-import.mjs';

const args = process.argv.slice(2);
if (args[0] !== 'import') {
  console.error('usage: npm run demo-processes -- import [--dry-run] [--replace]');
  process.exit(2);
}
const result = await importDemoProcesses({ dryRun: args.includes('--dry-run'), replace: args.includes('--replace') });
if (result.outcome === 'refused') process.exit(1);
