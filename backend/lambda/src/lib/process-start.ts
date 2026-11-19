/**
 * A PROCESS'S ID AND EDITION (SPEC-PROCESSES P2, P10), hashed with Node's crypto. Kept apart from `event-workflow.ts`, which the
 * admin console also imports, so the console's browser build never pulls in a Node-only module.
 */
import { contentHash12 } from './canonical-json.js';
import { processOfWorkflow, type RunProcess, type VersionProcess } from './event-workflow.js';

/**
 * The edition of a process (P10): the content hash of its `processes` entry, so an edit elsewhere on the version is not one. Its
 * description is words about the process, not what it measures, so rewording it starts no new edition.
 */
export const processEditionOf = (process: VersionProcess): string => {
  const { description: _words, ...measured } = process;
  return contentHash12(measured);
};

/**
 * THE PROCESS A RUN STARTS (P2): a run of a linked workflow carrying no process starts one, whose id is a hash of the process
 * and the run's key, so a repeat of the event the run already took makes no second process. Undefined where no process links it.
 */
export function startedProcess(processes: Readonly<Record<string, VersionProcess>> | undefined, workflow: string, runKey: string): RunProcess | undefined {
  const found = processOfWorkflow(processes, workflow);
  return found ? { id: contentHash12({ process: found.name, run: runKey }), name: found.name, edition: processEditionOf(found.process) } : undefined;
}
