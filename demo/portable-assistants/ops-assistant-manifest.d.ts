import { type EventWorkflow, type VersionProcess } from '../../backend/lambda/src/lib/event-workflow.js';
import { type ProfileManifest } from '../../backend/lambda/src/lib/profile-manifest.js';
import { type ProcessManifest } from '../../backend/lambda/src/lib/process-manifest.js';
/** The assistant this manifest creates: the premium classification's `ops` role. */
export declare const OPS_ASSISTANT = "ops-premium";
/**
 * THE OPS ROOMS' EVENT WORKFLOWS, WHICH THE OPS ASSISTANT OWNS (ADR-061 decision 2): `ops` and `ops-team` name the ops role as
 * the owner of their workflows (`workflowOwner`), so an ops room's opening (`ops-room`, its first look) and the team room's
 * incident (`incident-triage`) run on this assistant's version and speak as it, as does an incident's customer messaging
 * (`customer-messaging`, whose type names the ops role as its workflow owner too). Copied from the platform's
 * (`SHIPPED_EVENT_WORKFLOWS`), so the version owns what it runs.
 */
export declare const OPS_ROOM_WORKFLOW_KEYS: readonly ["ops-room", "incident-triage", "customer-messaging"];
/** The ops assistant's event workflows: its welcomes, and the ops rooms' workflows it owns. */
export declare function opsEventWorkflows(): Record<string, EventWorkflow>;
/**
 * INCIDENT RESPONSE AS ONE PROCESS (SPEC-PROCESSES P11; DESIGN-PROCESSES O8, O22, O26 to O33): the ops team's `processes` entry
 * linking the team conversation's triage (`incident-triage`), the incident conversation's work (`ops-room`) and the account
 * team's customer messaging beside it (`customer-messaging`) by one process id, with declared metrics: resolved within four
 * hours, and the share of incidents whose initial customer notice was not approved within its deadline (the run reached
 * `initial-late`). The time to first notice is the `Initial notice` stage's time. It travels as its own manifest
 * (`opsIncidentProcessManifest`, SPEC-PROCESSES P13), imported after the assistant's, so a deployment is told what it lacks
 * before the process lands.
 */
export declare function opsIncidentProcess(): Record<string, VersionProcess>;
/** The ops assistant's first version, as a manifest the profile API imports. */
export declare function opsAssistantManifest(): ProfileManifest;
/** The process the ops team owns, by name. */
export declare const OPS_INCIDENT_PROCESS = "incident-response";
/**
 * INCIDENT RESPONSE AS ITS OWN MANIFEST (SPEC-PROCESSES P13): the ops team's process, with what it requires of a deployment
 * computed from the ops assistant's own workflows: the ops, ops team and customer messaging conversation types, the on-call,
 * the incident's lead and the account team's lead, the primary and the ops assistant and the intents each is asked, the
 * templates and the machines. Imported after the assistant's manifest, into the draft that import landed.
 */
export declare function opsIncidentProcessManifest(): ProcessManifest;
/** Whether a version's `processes` already holds the process exactly as its manifest carries it. */
export declare function opsProcessIsCurrent(body: {
    processes?: unknown;
} | undefined, process: Pick<ProcessManifest, 'processName' | 'process'>): boolean;
/** A body without its `processes`, which travel as their own manifests and are compared on their own. */
export declare function withoutProcesses<T extends object>(body: T): Omit<T, 'processes'>;
/** The body keys on which two bodies differ, in order. Empty when they say the same thing. */
export declare function differingBodyKeys(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): string[];
/** What the import step does (`scripts/lib/ops-assistant-import.mjs`), decided from the assistant's export and the shipped manifest. */
export type OpsImportPlan = 
/** No active version: the manifest is imported, validated and activated. An import replaces an open draft and says so. */
{
    action: 'import';
    reason: 'no-active-version';
    differing: string[];
}
/** An active version that differs, and `--replace` asked for it to be replaced. */
 | {
    action: 'import';
    reason: 'replace';
    differing: string[];
}
/** The active version already says what the manifest says: nothing is written. */
 | {
    action: 'none';
    reason: 'already-active';
    differing: [];
}
/** An active version that differs, without `--replace`: refused, so a team's edits are never overwritten unasked. */
 | {
    action: 'refuse';
    reason: 'active-differs';
    differing: string[];
}
/** An export answer with no manifest: what is active cannot be read, so nothing is imported over it. */
 | {
    action: 'refuse';
    reason: 'unreadable-export';
    differing: [];
};
/**
 * Decide the import from the assistant's `/export` answer. An export of an assistant with no active version reports
 * `sourceVersion: 'seed'` (the compiled default), which is the creation case: the manifest becomes its first version.
 */
export declare function opsImportPlan(exported: Pick<ProfileManifest, 'body' | 'provenance'> | undefined, shipped: Pick<ProfileManifest, 'body'>, opts?: {
    replace?: boolean;
}): OpsImportPlan;
