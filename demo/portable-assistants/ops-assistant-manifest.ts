/**
 * THE OPS ASSISTANT'S FIRST VERSION, SHIPPED AS A PROFILE MANIFEST (SPEC-PORTABLE-PROFILES FR14, ADR-048).
 *
 * Creating the ops assistant (`ops-premium`, the premium classification's `ops` role) is one command:
 * `npm run add-assistant-role -- ops-premium` deploys the role, the provisioner seeds the assistant's identity, and as
 * its last step it imports this manifest onto the assistant as a draft, validates it and activates it
 * (`scripts/lib/ops-assistant-import.mjs`; `npm run ops-assistant -- import` runs the same import again).
 * So the ops assistant's definition reaches a deployment through the same import a team uses to move an assistant
 * between instances, and every ops creation exercises that import.
 *
 * BUILT, NOT WRITTEN BY HAND, from the demo sources the other assistants' seeds read: the persona (`OPS_PERSONA`),
 * the intent pack (`opsIntentPack()`), the boundary (`OPS_BOUNDARY`) and the event workflows (`opsEventWorkflows`),
 * serialized by the platform's seed (`serializeSeedDefinition`) and normalized the way export normalizes a body
 * (`bodyFrom`, `ensureModelsBundle`). An edit to any of those sources changes the manifest, so the two cannot drift.
 *
 * The manifest names no ARN, account id or region, and no source instance: it is the portable artifact FR14
 * describes, and it imports onto any deployment that declares the role.
 */
import { OPS_PERSONA } from '../stratum-company/personas.js';
import { withIntentWorkflowsDeclared } from '../../backend/lambda/src/lib/intent-workflow';
import { opsIntentPack } from '../stratum-company/intent-packs.js';
import { OPS_BOUNDARY } from '../stratum-company/boundaries.js';
import { OPS_WELCOME } from './welcomes.js';
import { SHIPPED_EVENT_WORKFLOWS, type EventWorkflow, type VersionProcess } from '../../backend/lambda/src/lib/event-workflow.js';
import { serializeSeedDefinition, bodyFrom, ensureModelsBundle, type ProfileDefinition } from '../../backend/lambda/src/lib/active-profile.js';
import { MANIFEST_SCHEMA_VERSION, contentHashOf, type ProfileManifest } from '../../backend/lambda/src/lib/profile-manifest.js';
import { buildProcessManifest, type ProcessManifest } from '../../backend/lambda/src/lib/process-manifest.js';

/** The assistant this manifest creates: the premium classification's `ops` role. */
export const OPS_ASSISTANT = 'ops-premium';

/**
 * THE OPS ROOMS' EVENT WORKFLOWS, WHICH THE OPS ASSISTANT OWNS (ADR-061 decision 2): `ops` and `ops-team` name the ops role as
 * the owner of their workflows (`workflowOwner`), so an ops room's opening (`ops-room`, its first look) and the team room's
 * incident (`incident-triage`) run on this assistant's version and speak as it, as does an incident's customer messaging
 * (`customer-messaging`, whose type names the ops role as its workflow owner too). Copied from the platform's
 * (`SHIPPED_EVENT_WORKFLOWS`), so the version owns what it runs.
 */
export const OPS_ROOM_WORKFLOW_KEYS = ['ops-room', 'incident-triage', 'customer-messaging'] as const;

/** The ops assistant's event workflows: its welcomes, and the ops rooms' workflows it owns. */
export function opsEventWorkflows(): Record<string, EventWorkflow> {
  const owned = Object.fromEntries(OPS_ROOM_WORKFLOW_KEYS.map((k) => {
    const wf = SHIPPED_EVENT_WORKFLOWS[k];
    if (!wf) throw new Error(`the platform declares no '${k}' workflow`);
    return [k, JSON.parse(JSON.stringify(wf)) as EventWorkflow];
  }));
  return { ...OPS_WELCOME, ...owned };
}

/**
 * INCIDENT RESPONSE AS ONE PROCESS (SPEC-PROCESSES P11; DESIGN-PROCESSES O8, O22, O26 to O33): the ops team's `processes` entry
 * linking the team conversation's triage (`incident-triage`), the incident conversation's work (`ops-room`) and the account
 * team's customer messaging beside it (`customer-messaging`) by one process id, with declared metrics: resolved within four
 * hours, and the share of incidents whose initial customer notice was not approved within its deadline (the run reached
 * `initial-late`). The time to first notice is the `Initial notice` stage's time. It travels as its own manifest
 * (`opsIncidentProcessManifest`, SPEC-PROCESSES P13), imported after the assistant's, so a deployment is told what it lacks
 * before the process lands.
 */
export function opsIncidentProcess(): Record<string, VersionProcess> {
  return {
    'incident-response': {
      label: 'Incident response',
      description: 'From an alarm to the post-incident review: the ops team triages and works the incident, and the account team tells affected customers beside it.',
      workflows: ['incident-triage', 'ops-room', 'customer-messaging'],
      metrics: [
        { id: 'resolved-in-4h', label: 'Resolved within 4 hours', workflow: 'ops-room', within: 'PT4H', target: 0.8 },
        { id: 'first-notice-missed', label: 'Initial customer notice missed its deadline', workflow: 'customer-messaging', step: 'initial-late' },
      ],
    },
  };
}

/** The ops assistant's first version, as a manifest the profile API imports. */
export function opsAssistantManifest(): ProfileManifest {
  const seeded = serializeSeedDefinition(OPS_ASSISTANT, OPS_PERSONA, opsIntentPack(), undefined, OPS_BOUNDARY, opsEventWorkflows());
  if (!seeded) throw new Error(`the shipped catalog declares no '${OPS_ASSISTANT}' assistant`);
  const def = JSON.parse(seeded) as ProfileDefinition;
  const seededBody = ensureModelsBundle(bodyFrom(def));
  // EVERY MULTI-STEP INTENT DECLARES ITS WORKFLOW (ADR-067 stage 3), the standard one where the pack names none, as the import
  // writes it out, so the manifest is the version it imports as and its export says the same.
  const multiStep = ((seededBody.intentPack as { intents?: Array<{ key?: string; delivery?: string }> } | undefined)?.intents ?? [])
    .filter((i) => i.delivery === 'TASK_MULTI_STEP' && typeof i.key === 'string').map((i) => i.key as string);
  const intentWorkflows = withIntentWorkflowsDeclared(seededBody.intentWorkflows, multiStep);
  // THE OPS TEAM'S PROCESS IS NOT PART OF THIS MANIFEST: it travels as its own (`opsIncidentProcessManifest`).
  const body = intentWorkflows ? { ...seededBody, intentWorkflows } : seededBody;
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: 'assistant-profile',
    profileName: OPS_ASSISTANT,
    body,
    provenance: { sourceProfileName: OPS_ASSISTANT, sourceVersion: 'seed', exportedConfigId: def.configId },
    contentHash: contentHashOf(body),
  };
}

/** The process the ops team owns, by name. */
export const OPS_INCIDENT_PROCESS = 'incident-response';

/**
 * INCIDENT RESPONSE AS ITS OWN MANIFEST (SPEC-PROCESSES P13): the ops team's process, with what it requires of a deployment
 * computed from the ops assistant's own workflows: the ops, ops team and customer messaging conversation types, the on-call,
 * the incident's lead and the account team's lead, the primary and the ops assistant and the intents each is asked, the
 * templates and the machines. Imported after the assistant's manifest, into the draft that import landed.
 */
export function opsIncidentProcessManifest(): ProcessManifest {
  const assistant = opsAssistantManifest();
  const manifest = buildProcessManifest({
    ownerProfileName: OPS_ASSISTANT,
    processName: OPS_INCIDENT_PROCESS,
    body: { eventWorkflows: assistant.body.eventWorkflows, processes: opsIncidentProcess() },
    provenance: { sourceProfileName: OPS_ASSISTANT, sourceVersion: 'seed', exportedConfigId: assistant.provenance.exportedConfigId },
  });
  if (!manifest) throw new Error(`the ops team declares no '${OPS_INCIDENT_PROCESS}' process`);
  return manifest;
}

/** Whether a version's `processes` already holds the process exactly as its manifest carries it. */
export function opsProcessIsCurrent(body: { processes?: unknown } | undefined, process: Pick<ProcessManifest, 'processName' | 'process'>): boolean {
  const held = (body?.processes as Record<string, unknown> | undefined)?.[process.processName];
  return held !== undefined && JSON.stringify(stable(held)) === JSON.stringify(stable(process.process));
}

/** A body without its `processes`, which travel as their own manifests and are compared on their own. */
export function withoutProcesses<T extends object>(body: T): Omit<T, 'processes'> {
  const { processes: _processes, ...rest } = body as T & { processes?: unknown };
  return rest;
}

/** JSON with every object's keys in order, so two bodies compare by what they say and not by key order. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]));
  }
  return v;
}

/** The body keys on which two bodies differ, in order. Empty when they say the same thing. */
export function differingBodyKeys(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => JSON.stringify(stable(a[k])) !== JSON.stringify(stable(b[k])))
    .sort();
}

/** What the import step does (`scripts/lib/ops-assistant-import.mjs`), decided from the assistant's export and the shipped manifest. */
export type OpsImportPlan =
  /** No active version: the manifest is imported, validated and activated. An import replaces an open draft and says so. */
  | { action: 'import'; reason: 'no-active-version'; differing: string[] }
  /** An active version that differs, and `--replace` asked for it to be replaced. */
  | { action: 'import'; reason: 'replace'; differing: string[] }
  /** The active version already says what the manifest says: nothing is written. */
  | { action: 'none'; reason: 'already-active'; differing: [] }
  /** An active version that differs, without `--replace`: refused, so a team's edits are never overwritten unasked. */
  | { action: 'refuse'; reason: 'active-differs'; differing: string[] }
  /** An export answer with no manifest: what is active cannot be read, so nothing is imported over it. */
  | { action: 'refuse'; reason: 'unreadable-export'; differing: [] };

/**
 * Decide the import from the assistant's `/export` answer. An export of an assistant with no active version reports
 * `sourceVersion: 'seed'` (the compiled default), which is the creation case: the manifest becomes its first version.
 */
export function opsImportPlan(
  exported: Pick<ProfileManifest, 'body' | 'provenance'> | undefined,
  shipped: Pick<ProfileManifest, 'body'>,
  opts: { replace?: boolean } = {},
): OpsImportPlan {
  const shippedBody = shipped.body as unknown as Record<string, unknown>;
  // AN ANSWER WITH NO MANIFEST IS NOT "NOTHING ACTIVE": it is an answer this cannot read, so it refuses rather than
  // import over whatever is active. Only the export's own word, `sourceVersion: 'seed'`, means no version yet.
  if (!exported?.body) return { action: 'refuse', reason: 'unreadable-export', differing: [] };
  if (exported.provenance?.sourceVersion === 'seed') {
    return { action: 'import', reason: 'no-active-version', differing: Object.keys(shippedBody).sort() };
  }
  // A PROCESS IS ITS OWN ARTIFACT: the active version's `processes` are compared with their process manifests, not with this one.
  const differing = differingBodyKeys(withoutProcesses(exported.body as unknown as Record<string, unknown>), withoutProcesses(shippedBody));
  if (!differing.length) return { action: 'none', reason: 'already-active', differing: [] };
  if (opts.replace) return { action: 'import', reason: 'replace', differing };
  return { action: 'refuse', reason: 'active-differs', differing };
}
