import { type IntentWorkflow } from '../../backend/lambda/src/lib/intent-workflow.js';
import type { VersionProcess } from '../../backend/lambda/src/lib/event-workflow.js';
import { type ProcessManifest } from '../../backend/lambda/src/lib/process-manifest.js';
/** The assistant whose version owns the process: the premium classification's primary. */
export declare const ADVISOR_ASSISTANT = "advisor";
/** The process Advisor owns, by name. */
export declare const ACCOUNT_BRIEF_PROCESS = "account-briefs";
/**
 * THE WORKFLOW A BRIEF REQUEST RUNS: the one a draft of Advisor's declares where its version names none, one task step on the
 * intent's own machine for the person who asked (`canonicalIntentWorkflow`), with that step labeled, so the Processes view
 * shows it as the process's stage, from the request to the brief written. The process links it by the intent's name.
 */
export declare function advisorIntentWorkflows(): Record<string, IntentWorkflow>;
/**
 * WHETHER A VERSION'S BODY RUNS THE ACCOUNT BRIEF AS THIS DEMO SHIPS IT, labeled step included. The labels are the owner's
 * version's own, not the process manifest's, so the import writes them into the draft beside the process and checks them here.
 */
export declare function advisorBriefWorkflowIsCurrent(body: {
    intentWorkflows?: unknown;
} | undefined): boolean;
/** Account briefs as one process: the request-started workflow, and how many briefs are written within an hour of the ask. */
export declare function advisorBriefProcess(): Record<string, VersionProcess>;
/** Account briefs as its own manifest (SPEC-PROCESSES P13), with what it requires computed from the workflow it links. */
export declare function advisorBriefProcessManifest(): ProcessManifest;
