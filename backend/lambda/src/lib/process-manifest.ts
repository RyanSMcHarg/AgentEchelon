/**
 * A PROCESS TRAVELS AS ITS OWN MANIFEST (SPEC-PROCESSES P13, DESIGN-PROCESSES section 8).
 *
 * A process is a `processes` entry on its owner team's assistant version, and its workflows are that version's event
 * workflows and request-started workflows (`intentWorkflows`, each keyed by the intent it runs on, which the owner's own version
 * declares). What those workflows depend on lies outside the owner's version: the conversation types they run in and open,
 * the participant roles those types declare, the assistants holding an assistant role in the classification and the intents
 * their active versions advertise, the message templates they say, and the task machines they open. A process manifest
 * carries the entry and those dependencies as data (`requires`), so a deployment that imports it is told, in codes, exactly
 * what it lacks, rather than landing a process whose first run fails at a step nobody can see.
 *
 * What it guarantees:
 *  - INSTANCE-AGNOSTIC, like the profile manifest (`profile-manifest.ts`): names only, never an ARN, an id, an account or a
 *    Region. The linked workflows travel in the owner's assistant manifest, never here.
 *  - `requires` IS COMPUTED, never written: from the owner version's linked workflows at export, and again from the target
 *    version's workflows at import and at activation, so a hand-edited manifest cannot talk its way past the check.
 *  - EVERY REFUSAL IS A CODE WITH THE MISSING NAMES AS DATA (tenet D11): the console says it from its locale bundle.
 *  - THE CHECK READS WHAT THE RUNTIME READS: the deployment's conversation types, the classification's declared holder of
 *    each assistant role (`roleAssistantName`, as validation reads it) and that holder's published advertisement
 *    (`readAdvertisement`, which the router decides a request from), the shipped and stored templates, and the machines the
 *    version runs (`versionTaskMachines`).
 */
import { createHash } from 'node:crypto';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { CONVERSATION_TYPES, classificationAllowedForType } from '../../../lib/config/conversation-types.js';
import { participantRolesOf } from '../../../lib/config/participant-roles.js';
import { defaultProfileRegistry } from '../../../lib/profile-registry';
import {
  audienceRole, linkableWorkflows, mentionedRole, templatesNamedBy, versionProcessesErrors,
  type EventStepDef, type EventWorkflow, type VersionProcess,
} from './event-workflow.js';
import { asRun, type IntentWorkflow } from './intent-workflow.js';
import { workerAssistantRole } from './task-step.js';
import { projectAdvertisement, readAdvertisement, type AssistantAdvertisement } from './assistant-advertisement.js';
import { shippedMessageTemplates } from './shipped-message-templates.js';
import type { ProfileDefinitionBody } from './active-profile.js';
import { classificationServedBy, versionIntentsOf, versionTaskMachines } from './profile-lifecycle.js';
import { signManifest, verifyManifestSignature } from './profile-manifest.js';

export const PROCESS_MANIFEST_SCHEMA_VERSION = 1 as const;
/** A process manifest is a label, a description, at most eight workflows and eight metrics, and their names: small. */
export const MAX_PROCESS_MANIFEST_BYTES = 32 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** What a process needs of the deployment it runs on, each list de-duplicated and in order. */
export interface ProcessRequirements {
  /** The workflows it links, which the owner's version declares (they travel in the assistant manifest). */
  workflows: string[];
  /** Every conversation type a linked workflow runs in (`types`) or opens (`open.type`). */
  conversationTypes: string[];
  /** Every participant role a step addresses or an open step leads with, by the type that declares it. */
  participantRoles: Array<{ type: string; role: string }>;
  /** Every assistant role a task step asks, by the type its workflow runs in, with the intents it asks (each step's `machine`). */
  assistantRoles: Array<{ type?: string; role: string; intents: string[] }>;
  /** Every template a linked workflow sends, prompts with, asks or assigns. */
  templates: string[];
  /** Every task machine a step opens itself, rather than asking of another assistant role. */
  machines: string[];
  /**
   * Every intent a linked request-started workflow runs on (its `intentWorkflows` key), which the owner's own version declares
   * with that workflow. Present only where the process links one, so a process of event workflows reads as it always has.
   */
  intents?: string[];
}

export interface ProcessManifest {
  schemaVersion: typeof PROCESS_MANIFEST_SCHEMA_VERSION;
  kind: 'process';
  /** The assistant whose version owns the process (the /assistant/{name} segment on any instance). */
  ownerProfileName: string;
  processName: string;
  process: VersionProcess;
  requires: ProcessRequirements;
  provenance: {
    instanceId?: string;
    sourceProfileName: string;
    sourceVersion: number | 'active' | 'seed' | 'draft';
    exportedConfigId: string;
  };
  /** sha256 of the canonical `{ processName, process, requires }`. */
  contentHash: string;
  /** Present only when the exporter signs (`MANIFEST_SIGNING_SECRET`), as a profile manifest is signed. */
  signature?: string;
}

/** Each refusal a process manifest or its requirements are given, as a code the console says from its locale bundle (D11). */
export const PROCESS_MANIFEST_REFUSALS = [
  'PROCESS_MANIFEST_SHAPE', 'PROCESS_MANIFEST_SIZE', 'PROCESS_MANIFEST_HASH', 'PROCESS_MANIFEST_SIGNATURE',
  'PROCESS_OWNER_UNKNOWN', 'PROCESS_NOT_FOUND',
  'PROCESS_REQ_WORKFLOW', 'PROCESS_REQ_TYPE', 'PROCESS_REQ_ROLE', 'PROCESS_REQ_ASSISTANT_ROLE', 'PROCESS_REQ_INTENT',
  'PROCESS_REQ_TEMPLATE', 'PROCESS_REQ_MACHINE', 'PROCESS_REQ_OWN_INTENT',
] as const;
export type ProcessManifestRefusalCode = typeof PROCESS_MANIFEST_REFUSALS[number];

/** One refusal: its code, and the names of what is missing, as data. */
export interface ProcessRefusal {
  code: ProcessManifestRefusalCode;
  workflow?: string;
  type?: string;
  role?: string;
  intent?: string;
  assistant?: string;
  template?: string;
  machine?: string;
  classification?: string;
  process?: string;
}

const envOf = (k: string): string | undefined => process.env[k] || undefined;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON with every object's keys in order, so two values compare and hash by what they say. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]));
  return v;
}

/** The `contentHash` a process manifest carries. */
export function processContentHashOf(m: Pick<ProcessManifest, 'processName' | 'process' | 'requires'>): string {
  return createHash('sha256').update(JSON.stringify(stable({ processName: m.processName, process: m.process, requires: m.requires })), 'utf8').digest('hex');
}

/**
 * WHAT A PROCESS NEEDS OF ITS DEPLOYMENT, read from the workflows it links. A linked workflow the version does not declare
 * is listed and contributes nothing more, so the check names it rather than guessing what it would have needed. A linked
 * request-started workflow is read as it runs (`asRun`), and needs its intent too: the owner's version declares the intent and
 * its workflow, and its own task step opens the intent's machine, which the version must run.
 */
export function processRequirementsOf(
  process: Pick<VersionProcess, 'workflows'>,
  eventWorkflows: Readonly<Record<string, EventWorkflow>> | undefined,
  intentWorkflows?: Readonly<Record<string, IntentWorkflow>> | undefined,
): ProcessRequirements {
  const workflows = new Set<string>();
  const types = new Set<string>();
  const roles = new Map<string, { type: string; role: string }>();
  const asked = new Map<string, { type?: string; role: string; intents: Set<string> }>();
  const templates = new Set<string>();
  const machines = new Set<string>();
  const intents = new Set<string>();
  const addRole = (type: string, role: string | undefined) => { if (type && role) roles.set(`${type}\u0000${role}`, { type, role }); };
  for (const name of process.workflows ?? []) {
    workflows.add(name);
    const byRequest = !eventWorkflows?.[name] && isObject(intentWorkflows?.[name]) ? intentWorkflows![name] : undefined;
    if (byRequest) intents.add(name);
    const wf = byRequest ? asRun(byRequest) : eventWorkflows?.[name];
    if (!wf || !isObject(wf.states)) continue;
    const runsIn = Array.isArray(wf.types) ? wf.types.filter((t): t is string => typeof t === 'string') : [];
    for (const t of runsIn) types.add(t);
    const inRunTypes = (role: string | undefined) => { for (const t of runsIn) addRole(t, role); };
    for (const t of templatesNamedBy(wf)) templates.add(t.name);
    for (const def of Object.values(wf.states) as EventStepDef[]) {
      if (!def || typeof def !== 'object') continue;
      for (const send of [def.send, def.agent?.fallback?.send]) {
        if (!send) continue;
        inRunTypes(audienceRole(send.to));
        for (const source of Object.values(send.mention ?? {})) inRunTypes(mentionedRole(source));
      }
      if (def.agent) {
        inRunTypes(audienceRole(def.agent.to));
        if (typeof def.agent.workflow === 'string') machines.add(def.agent.workflow);
      }
      if (def.open && typeof def.open.type === 'string') {
        types.add(def.open.type);
        const lead = def.open.for as unknown;
        if (isObject(lead) && typeof lead.typeRole === 'string') addRole(def.open.type, lead.typeRole);
        else inRunTypes(audienceRole(lead));
      }
      const task = def.task;
      if (task && typeof task.machine === 'string') {
        inRunTypes(audienceRole(task.for));
        inRunTypes(audienceRole(task.by));
        for (const name of [task.assigned?.template, task.assigned?.withoutMeetings, task.ask?.template, task.notice?.template, task.notice?.redirect]) {
          if (typeof name === 'string' && name) templates.add(name);
        }
        const role = workerAssistantRole(task.by);
        if (role) {
          for (const type of runsIn.length ? runsIn : [undefined]) {
            const key = `${type ?? ''}\u0000${role}`;
            const entry = asked.get(key) ?? { ...(type ? { type } : {}), role, intents: new Set<string>() };
            entry.intents.add(task.machine);
            asked.set(key, entry);
          }
        } else machines.add(task.machine);
      }
    }
  }
  const sorted = (s: Set<string>) => [...s].sort();
  return {
    workflows: [...workflows],
    conversationTypes: sorted(types),
    participantRoles: [...roles.values()].sort((a, b) => `${a.type} ${a.role}`.localeCompare(`${b.type} ${b.role}`)),
    assistantRoles: [...asked.values()]
      .map((a) => ({ ...(a.type ? { type: a.type } : {}), role: a.role, intents: sorted(a.intents) }))
      .sort((a, b) => `${a.type ?? ''} ${a.role}`.localeCompare(`${b.type ?? ''} ${b.role}`)),
    templates: sorted(templates),
    machines: sorted(machines),
    ...(intents.size ? { intents: sorted(intents) } : {}),
  };
}

/** Both sets of requirements, de-duplicated: what a manifest says it needs and what the target's own workflows need. */
export function mergeRequirements(a: ProcessRequirements, b: ProcessRequirements): ProcessRequirements {
  const roles = new Map<string, { type: string; role: string }>();
  for (const r of [...a.participantRoles, ...b.participantRoles]) roles.set(`${r.type}\u0000${r.role}`, r);
  const asked = new Map<string, { type?: string; role: string; intents: Set<string> }>();
  for (const r of [...a.assistantRoles, ...b.assistantRoles]) {
    const key = `${r.type ?? ''}\u0000${r.role}`;
    const entry = asked.get(key) ?? { ...(r.type ? { type: r.type } : {}), role: r.role, intents: new Set<string>() };
    for (const i of r.intents) entry.intents.add(i);
    asked.set(key, entry);
  }
  const union = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  const intents = union(a.intents ?? [], b.intents ?? []).sort();
  return {
    ...(intents.length ? { intents } : {}),
    workflows: union(a.workflows, b.workflows),
    conversationTypes: union(a.conversationTypes, b.conversationTypes).sort(),
    participantRoles: [...roles.values()].sort((p, q) => `${p.type} ${p.role}`.localeCompare(`${q.type} ${q.role}`)),
    assistantRoles: [...asked.values()].map((r) => ({ ...(r.type ? { type: r.type } : {}), role: r.role, intents: [...r.intents].sort() }))
      .sort((p, q) => `${p.type ?? ''} ${p.role}`.localeCompare(`${q.type ?? ''} ${q.role}`)),
    templates: union(a.templates, b.templates).sort(),
    machines: union(a.machines, b.machines).sort(),
  };
}

/** The process manifest of one `processes` entry of a version. Undefined where the version declares no such process. */
export function buildProcessManifest(args: {
  ownerProfileName: string;
  processName: string;
  body: Pick<ProfileDefinitionBody, 'processes' | 'eventWorkflows'> & Partial<Pick<ProfileDefinitionBody, 'intentWorkflows'>>;
  provenance: ProcessManifest['provenance'];
}): ProcessManifest | undefined {
  const entry = args.body.processes?.[args.processName];
  if (!entry) return undefined;
  const requires = processRequirementsOf(entry, args.body.eventWorkflows, args.body.intentWorkflows);
  const manifest: ProcessManifest = {
    schemaVersion: PROCESS_MANIFEST_SCHEMA_VERSION,
    kind: 'process',
    ownerProfileName: args.ownerProfileName,
    processName: args.processName,
    process: entry,
    requires,
    provenance: args.provenance,
    contentHash: processContentHashOf({ processName: args.processName, process: entry, requires }),
  };
  const secret = envOf('MANIFEST_SIGNING_SECRET');
  if (secret) manifest.signature = signManifest(manifest as never, secret);
  return manifest;
}

const stringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function requirementsShapeOk(r: unknown): r is ProcessRequirements {
  if (!isObject(r)) return false;
  return stringList(r.workflows) && stringList(r.conversationTypes) && stringList(r.templates) && stringList(r.machines)
    && Array.isArray(r.participantRoles) && r.participantRoles.every((p) => isObject(p) && typeof p.type === 'string' && typeof p.role === 'string')
    && Array.isArray(r.assistantRoles) && r.assistantRoles.every((p) => isObject(p) && typeof p.role === 'string'
      && (p.type === undefined || typeof p.type === 'string') && stringList(p.intents))
    && (r.intents === undefined || stringList(r.intents));
}

/**
 * AN UNTRUSTED PROCESS MANIFEST, READ: its size, its shape, its `contentHash`, and its signature where the deployment signs.
 * Returns the manifest, or every refusal it earned; nothing about the target is read here.
 */
export function readProcessManifest(raw: unknown): { manifest: ProcessManifest } | { refusals: ProcessRefusal[] } {
  let text: string;
  try {
    text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  } catch {
    return { refusals: [{ code: 'PROCESS_MANIFEST_SHAPE' }] };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_PROCESS_MANIFEST_BYTES) return { refusals: [{ code: 'PROCESS_MANIFEST_SIZE' }] };
  let m: unknown;
  try {
    m = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { refusals: [{ code: 'PROCESS_MANIFEST_SHAPE' }] };
  }
  if (!isObject(m) || m.kind !== 'process' || m.schemaVersion !== PROCESS_MANIFEST_SCHEMA_VERSION
    || typeof m.ownerProfileName !== 'string' || !m.ownerProfileName
    || typeof m.processName !== 'string' || !NAME.test(m.processName)
    || !isObject(m.process) || !requirementsShapeOk(m.requires) || typeof m.contentHash !== 'string') {
    return { refusals: [{ code: 'PROCESS_MANIFEST_SHAPE' }] };
  }
  const entry = m.process as unknown as VersionProcess;
  // THE ENTRY'S OWN SHAPE, by the validator a version's `processes` is held to. Its workflows and its metrics' steps are read
  // against the target's version once that is known, so here each linked name stands for a workflow with the steps its
  // metrics name.
  const linked = (Array.isArray(entry.workflows) ? entry.workflows : []).filter((w): w is string => typeof w === 'string');
  const stepsNamed = (w: string) => (Array.isArray(entry.metrics) ? entry.metrics : [])
    .filter((x) => isObject(x) && x.workflow === w && typeof x.step === 'string').map((x) => [x.step as string, {}]);
  const shapeOnly = versionProcessesErrors({ [m.processName]: entry }, Object.fromEntries(linked.map((w) => [w, { states: Object.fromEntries(stepsNamed(w)) }])));
  if (shapeOnly.length) return { refusals: [{ code: 'PROCESS_MANIFEST_SHAPE', process: m.processName }] };
  const manifest = m as unknown as ProcessManifest;
  if (processContentHashOf(manifest) !== manifest.contentHash) return { refusals: [{ code: 'PROCESS_MANIFEST_HASH' }] };
  const secret = envOf('MANIFEST_SIGNING_SECRET');
  if (envOf('MANIFEST_REQUIRE_SIGNATURE') === 'true' && !manifest.signature) return { refusals: [{ code: 'PROCESS_MANIFEST_SIGNATURE' }] };
  if (manifest.signature && (!secret || !verifyManifestSignature(manifest as never, secret))) return { refusals: [{ code: 'PROCESS_MANIFEST_SIGNATURE' }] };
  return { manifest };
}

/** What the target deployment offers a process, read once, against which `processRequirementErrors` decides. */
export interface ProcessTarget {
  /** The owner's classification, named in a refusal of a type that does not permit it. */
  classification?: string;
  /** The workflows the owner's version declares that a process may link: its event workflows and its request-started ones. */
  workflows: readonly string[];
  /** The intents the owner's version answers, read only where the process links a request-started workflow. */
  intents?: readonly string[];
  /** Each conversation type the deployment declares and permits at the owner's classification, with its declared participant roles. */
  conversationTypes: Readonly<Record<string, readonly string[]>>;
  /** The assistant holding each assistant role in the owner's classification, with the intents its active version advertises. */
  assistantRoles: Readonly<Record<string, { assistant: string; intents: readonly string[] }>>;
  /** The required templates the target holds: shipped, or the owner's or its classification's. */
  templates: readonly string[];
  /** The task machines the owner's version runs: the platform's, its classification's and its own. */
  machines: readonly string[];
}

/**
 * WHAT A PROCESS NEEDS THAT THE TARGET LACKS, each as a code with the missing names. Empty when every requirement is met. A
 * role is checked only on a type the target declares, so a missing type is said once rather than once per role.
 */
export function processRequirementErrors(requires: ProcessRequirements, target: ProcessTarget): ProcessRefusal[] {
  const out: ProcessRefusal[] = [];
  const workflows = new Set(target.workflows);
  for (const workflow of requires.workflows) if (!workflows.has(workflow)) out.push({ code: 'PROCESS_REQ_WORKFLOW', workflow });
  // A REQUEST-STARTED WORKFLOW RUNS ONLY WHERE ITS OWNER ANSWERS THE INTENT: a request is classified to one of its own intents.
  const own = new Set(target.intents ?? []);
  for (const intent of requires.intents ?? []) if (!own.has(intent)) out.push({ code: 'PROCESS_REQ_OWN_INTENT', intent, workflow: intent });
  const hasType = (t: string) => Object.prototype.hasOwnProperty.call(target.conversationTypes, t);
  for (const type of requires.conversationTypes) {
    if (!hasType(type)) out.push({ code: 'PROCESS_REQ_TYPE', type, ...(target.classification ? { classification: target.classification } : {}) });
  }
  for (const { type, role } of requires.participantRoles) {
    if (hasType(type) && !target.conversationTypes[type].includes(role)) out.push({ code: 'PROCESS_REQ_ROLE', type, role });
  }
  for (const { type, role, intents } of requires.assistantRoles) {
    const holder = Object.prototype.hasOwnProperty.call(target.assistantRoles, role) ? target.assistantRoles[role] : undefined;
    if (!holder) { out.push({ code: 'PROCESS_REQ_ASSISTANT_ROLE', ...(type ? { type } : {}), role }); continue; }
    for (const intent of intents) {
      if (!holder.intents.includes(intent)) out.push({ code: 'PROCESS_REQ_INTENT', ...(type ? { type } : {}), role, intent, assistant: holder.assistant });
    }
  }
  const templates = new Set(target.templates);
  for (const template of requires.templates) if (!templates.has(template)) out.push({ code: 'PROCESS_REQ_TEMPLATE', template });
  const machines = new Set(target.machines);
  for (const machine of requires.machines) if (!machines.has(machine)) out.push({ code: 'PROCESS_REQ_MACHINE', machine });
  return out;
}

/** The conversation types the deployment declares that permit a classification, each with its declared participant roles. */
export function deploymentConversationTypes(classification: string): Record<string, string[]> {
  return Object.fromEntries(Object.keys(CONVERSATION_TYPES)
    .filter((t) => classificationAllowedForType(t, classification))
    .map((t) => [t, Object.keys(participantRolesOf(t)).sort()]));
}

export interface ProcessTargetDeps {
  /** The declared assistant holding a role in a classification (`roleAssistantName`, as validation reads it). */
  roleAssistant?: (classification: string, role: string) => string | undefined;
  /** An assistant's published advertisement, which the router reads to decide a request (`readAdvertisement`). */
  readAd?: (assistant: string) => Promise<AssistantAdvertisement | null>;
  /** Whether the owner or its classification holds a template the platform does not ship. */
  hasStoredTemplate?: (classification: string, assistant: string, name: string) => Promise<boolean>;
}

async function storedTemplate(classification: string, assistant: string, name: string): Promise<boolean> {
  const { loadNamedTemplate } = await import('./message-template-selection.js');
  for (const kind of ['message', 'prompt'] as const) {
    if (await loadNamedTemplate({ classification, assistant, name }, kind).catch(() => undefined)) return true;
  }
  return false;
}

/**
 * THE TARGET A PROCESS IS CHECKED AGAINST: the owner's `version` (the draft it lands in, or the draft being activated), the
 * deployment's conversation types at the owner's classification, each asked role's declared holder and what its ACTIVE
 * version advertises, the templates the target holds and the machines the version runs. Where the owner itself holds an asked
 * role, its intents are `version`'s own, since that version is what will serve. A machine set that cannot be read is an
 * error, never an empty set standing in for it.
 */
export async function processTargetOf(
  ssm: SSMClient, ssmRoot: string, owner: string, version: Partial<ProfileDefinitionBody>, requires: ProcessRequirements, deps: ProcessTargetDeps = {},
): Promise<ProcessTarget | { error: string }> {
  const classification = classificationServedBy(owner);
  const roleAssistant = deps.roleAssistant ?? ((c: string, r: string) => defaultProfileRegistry.roleAssistantName(c, r));
  const readAd = deps.readAd ?? readAdvertisement;
  const hasStored = deps.hasStoredTemplate ?? storedTemplate;
  const assistantRoles: Record<string, { assistant: string; intents: string[] }> = {};
  for (const role of new Set(requires.assistantRoles.map((r) => r.role))) {
    const assistant = roleAssistant(classification, role);
    if (!assistant) continue;
    const ad = assistant === owner
      ? projectAdvertisement({ assistant, pack: version.intentPack as never })
      : await readAd(assistant).catch(() => null);
    assistantRoles[role] = { assistant, intents: (ad?.intents ?? []).map((i) => i.key) };
  }
  const shipped = shippedMessageTemplates();
  const templates: string[] = [];
  for (const name of requires.templates) {
    if (shipped.has(name) || await hasStored(classification, owner, name)) templates.push(name);
  }
  let machines: string[] = [];
  if (requires.machines.length) {
    const read = await versionTaskMachines(version, ssm, ssmRoot, owner);
    if ('error' in read) return { error: read.error };
    machines = Object.keys(read.machines);
  }
  // THE OWNER'S OWN INTENTS, read only where the process links a request-started workflow: its own pack's, else its classification's.
  let intents: string[] | undefined;
  if (requires.intents?.length) {
    const read = await versionIntentsOf(version, ssm, ssmRoot, owner).catch(() => undefined);
    if (!read) return { error: `the intents ${owner}'s version answers could not be read` };
    intents = read.intents;
  }
  return {
    classification,
    workflows: Object.keys(linkableWorkflows(version.eventWorkflows, version.intentWorkflows)),
    ...(intents ? { intents } : {}),
    conversationTypes: deploymentConversationTypes(classification),
    assistantRoles,
    templates,
    machines,
  };
}

/**
 * EVERY PROCESS A VERSION DECLARES, CHECKED AGAINST THE TARGET (activation's re-check): its requirements computed from the
 * version itself, so an assistant or a role removed since import is caught before the version serves.
 */
export async function versionProcessRefusals(
  ssm: SSMClient, ssmRoot: string, owner: string, version: Partial<ProfileDefinitionBody>, deps: ProcessTargetDeps = {},
): Promise<{ refusals: ProcessRefusal[] } | { error: string }> {
  const out: ProcessRefusal[] = [];
  for (const [name, process] of Object.entries(version.processes ?? {})) {
    const requires = processRequirementsOf(process, version.eventWorkflows, version.intentWorkflows);
    const target = await processTargetOf(ssm, ssmRoot, owner, version, requires, deps);
    if ('error' in target) return target;
    out.push(...processRequirementErrors(requires, target).map((r) => ({ ...r, process: name })));
  }
  return { refusals: out };
}
