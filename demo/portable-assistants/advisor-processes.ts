/**
 * A PROCESS A PERSON'S REQUEST STARTS (SPEC-PROCESSES P1, P2; DESIGN-PROCESSES section 3a), shipped as its own process manifest.
 *
 * Advisor, the premium classification's primary, answers an account brief (`account_brief`, a multi-step intent whose workflow
 * researches the account record, then drafts the brief) as a request-started workflow: its version's `intentWorkflows` entry
 * for the intent. The `account-briefs` process links that workflow, so each brief a person asks for is one process, from the
 * request to the brief written, measured in the Processes view as an incident is. Nothing about the incident response changes:
 * the process is Advisor's, links only Advisor's request-started workflow, and no incident run asks for an account brief.
 *
 * It travels as a process manifest (SPEC-PROCESSES P13), like the ops team's incident response, with what it requires of a
 * deployment computed from the workflow it links: the intent itself (Advisor's version must answer `account_brief` and declare
 * its workflow) and the task machine its own step opens. `npm run demo-processes -- import` imports it into Advisor's draft,
 * validates the draft and activates it (`scripts/lib/demo-process-import.mjs`).
 */
import { ACCOUNT_BRIEF_INTENT } from '../stratum-company/intent-packs.js';
import { canonicalIntentWorkflow, type IntentWorkflow } from '../../backend/lambda/src/lib/intent-workflow.js';
import type { VersionProcess } from '../../backend/lambda/src/lib/event-workflow.js';
import { buildProcessManifest, type ProcessManifest } from '../../backend/lambda/src/lib/process-manifest.js';

/** The assistant whose version owns the process: the premium classification's primary. */
export const ADVISOR_ASSISTANT = 'advisor';

/** The process Advisor owns, by name. */
export const ACCOUNT_BRIEF_PROCESS = 'account-briefs';

/**
 * THE WORKFLOW A BRIEF REQUEST RUNS: the one a draft of Advisor's declares where its version names none, one task step on the
 * intent's own machine for the person who asked (`canonicalIntentWorkflow`), with that step labeled, so the Processes view
 * shows it as the process's stage, from the request to the brief written. The process links it by the intent's name.
 */
export function advisorIntentWorkflows(): Record<string, IntentWorkflow> {
  const wf = canonicalIntentWorkflow(ACCOUNT_BRIEF_INTENT);
  const work = wf.initial;
  return {
    [ACCOUNT_BRIEF_INTENT]: {
      ...wf,
      states: {
        ...wf.states,
        [work]: { ...wf.states[work], label: 'Brief', description: 'Advisor researches the account record, then writes the brief for the person who asked.' },
      },
    } as IntentWorkflow,
  };
}

/**
 * WHETHER A VERSION'S BODY RUNS THE ACCOUNT BRIEF AS THIS DEMO SHIPS IT, labeled step included. The labels are the owner's
 * version's own, not the process manifest's, so the import writes them into the draft beside the process and checks them here.
 */
export function advisorBriefWorkflowIsCurrent(body: { intentWorkflows?: unknown } | undefined): boolean {
  const held = (body?.intentWorkflows as Record<string, unknown> | undefined)?.[ACCOUNT_BRIEF_INTENT];
  return held !== undefined && JSON.stringify(stable(held)) === JSON.stringify(stable(advisorIntentWorkflows()[ACCOUNT_BRIEF_INTENT]));
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]));
  return v;
}

/** Account briefs as one process: the request-started workflow, and how many briefs are written within an hour of the ask. */
export function advisorBriefProcess(): Record<string, VersionProcess> {
  return {
    [ACCOUNT_BRIEF_PROCESS]: {
      label: 'Account briefs',
      description: 'From a request for an account brief to the brief written from the account record.',
      workflows: [ACCOUNT_BRIEF_INTENT],
      metrics: [{ id: 'brief-in-1h', label: 'Brief written within an hour', workflow: ACCOUNT_BRIEF_INTENT, within: 'PT1H', target: 0.9 }],
    },
  };
}

/** Account briefs as its own manifest (SPEC-PROCESSES P13), with what it requires computed from the workflow it links. */
export function advisorBriefProcessManifest(): ProcessManifest {
  const manifest = buildProcessManifest({
    ownerProfileName: ADVISOR_ASSISTANT,
    processName: ACCOUNT_BRIEF_PROCESS,
    body: { eventWorkflows: {}, intentWorkflows: advisorIntentWorkflows(), processes: advisorBriefProcess() },
    provenance: { sourceProfileName: ADVISOR_ASSISTANT, sourceVersion: 'seed', exportedConfigId: 'seed' },
  });
  if (!manifest) throw new Error(`Advisor declares no '${ACCOUNT_BRIEF_PROCESS}' process`);
  return manifest;
}
