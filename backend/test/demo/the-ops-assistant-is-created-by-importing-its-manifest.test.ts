/**
 * THE OPS ASSISTANT'S FIRST VERSION IS IMPORTED FROM ITS SHIPPED MANIFEST (SPEC-PORTABLE-PROFILES FR14, ADR-048).
 *
 * Creating the ops assistant (`ops-premium`) imports its first version from a manifest built from the demo sources,
 * rather than the demo seed writing its definition directly, so every ops creation proves import.
 * These pin the manifest to its sources, keep it free of anything bound to one instance, prove it survives an import,
 * activation and export unchanged, and pin what the import step (run by `npm run add-assistant-role -- ops-premium` after its deploy, and by `npm run ops-assistant -- import`) decides from an assistant's export.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  opsAssistantManifest, opsEventWorkflows, opsImportPlan, differingBodyKeys, opsIncidentProcess, opsIncidentProcessManifest, opsProcessIsCurrent,
  OPS_ASSISTANT, OPS_INCIDENT_PROCESS,
} from '../../../demo/portable-assistants/ops-assistant-manifest';
import { deploymentConversationTypes, processRequirementErrors, readProcessManifest, type ProcessTarget } from '../../lambda/src/lib/process-manifest';
import { versionProcessesErrors } from '../../lambda/src/lib/event-workflow';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { withVersionMachines } from '../../lambda/src/lib/version-machines';
import { stratumIntentPack } from '../../../demo/stratum-company/intent-packs';
import { OPS_PERSONA } from '../../../demo/stratum-company/personas';
import { projectAdvertisement } from '../../lambda/src/lib/assistant-advertisement';
import { SHIPPED_EVENT_WORKFLOWS } from '../../lambda/src/lib/event-workflow';
import { workerAssistantRole } from '../../lambda/src/lib/task-step';
import { opsIntentPack } from '../../../demo/stratum-company/intent-packs';
import { OPS_BOUNDARY } from '../../../demo/stratum-company/boundaries';
import { OPS_WELCOME } from '../../../demo/portable-assistants/welcomes';
import { contentHashOf, exportManifest, importManifest, MANIFEST_SCHEMA_VERSION, type TargetContextSource } from '../../lambda/src/lib/profile-manifest';
import { activateDraft, isKnownProfile } from '../../lambda/src/lib/profile-lifecycle';
import { defaultProfileRegistry } from '../../lib/profile-registry';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

/** In-memory S3, the profile body store the persona and pack are offloaded to, as on a deployment. Named `mock*` so jest's hoisted factory may close over it. */
const mockS3Objects = new Map<string, string>();
jest.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand { constructor(public input: { Bucket: string; Key: string; Body: string }) {} }
  class GetObjectCommand { constructor(public input: { Bucket: string; Key: string }) {} }
  class S3Client {
    async send(cmd: PutObjectCommand | GetObjectCommand): Promise<unknown> {
      const addr = `${cmd.input.Bucket}/${cmd.input.Key}`;
      if (cmd instanceof PutObjectCommand) { mockS3Objects.set(addr, cmd.input.Body); return {}; }
      const body = mockS3Objects.get(addr);
      if (body === undefined) throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => body } };
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand };
});
beforeEach(() => { mockS3Objects.clear(); process.env.PROFILE_BODY_BUCKET = 'profile-bodies'; });
afterAll(() => { delete process.env.PROFILE_BODY_BUCKET; });

const ROOT = '/test-instance';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
const GUARDRAILS = async () => [{ key: 'default', guardrailId: 'gr-target-default' }];
const CONTEXT_SOURCES = async (): Promise<TargetContextSource[]> => [
  { key: 'user-profile', contractVersion: '1.0', fields: { displayName: { type: 'string' } } },
];

describe('the ops assistant manifest', () => {
  const manifest = opsAssistantManifest();

  it('is an assistant-profile manifest for ops-premium, the premium ops role', () => {
    expect(OPS_ASSISTANT).toBe('ops-premium');
    expect(manifest.kind).toBe('assistant-profile');
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.profileName).toBe(OPS_ASSISTANT);
    expect(manifest.contentHash).toBe(contentHashOf(manifest.body));
    expect(manifest.body.modelKey).toBe(defaultProfileRegistry.profileByName(OPS_ASSISTANT)!.modelKey);
  });

  it('carries the persona, pack, boundary and welcomes the demo sources declare', () => {
    expect(manifest.body.persona).toBe(OPS_PERSONA.replace(/\r\n/g, '\n').trim());
    expect(manifest.body.boundary).toBe(OPS_BOUNDARY.trim());
    // ITS WELCOMES, AND THE OPS ROOMS' WORKFLOWS IT OWNS (`workflowOwner` on `ops` and `ops-team`): the opening and the incident.
    expect(manifest.body.eventWorkflows).toEqual(opsEventWorkflows());
    expect(Object.keys(manifest.body.eventWorkflows ?? {})).toEqual(expect.arrayContaining([...Object.keys(OPS_WELCOME), 'ops-room', 'incident-triage']));
    const keys = (p: { intents: Array<{ key: string }> }) => p.intents.map((i) => i.key).sort();
    expect(keys(manifest.body.intentPack as never)).toEqual(keys(opsIntentPack() as never));
    expect(manifest.body.tools?.length).toBeGreaterThan(0);
  });

  it('names no ARN, account id, region or source instance (FR14)', () => {
    // The two digests are hex and checked for their shape, so a configId of twelve decimal digits is not read as an account.
    const { contentHash, provenance: { exportedConfigId, ...provenance }, ...rest } = manifest;
    const scanned = JSON.stringify({ ...rest, provenance });
    expect(scanned).not.toMatch(/arn:aws/);
    expect(scanned).not.toMatch(/\b\d{12}\b/);
    expect(scanned).not.toMatch(/\b(us|eu|ap|sa|ca|me|af|il|mx)-(north|south|east|west|central|northeast|southeast|northwest|southwest)-\d\b/);
    expect(manifest.provenance.instanceId).toBeUndefined();
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(exportedConfigId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('advertises every intent a shipped workflow asks of the ops role, or the request is refused at run time', () => {
    const ad = projectAdvertisement({ assistant: OPS_ASSISTANT, pack: opsIntentPack() as never });
    const asked = Object.values(SHIPPED_EVENT_WORKFLOWS).flatMap((wf) => Object.values(wf.states))
      .filter((step) => workerAssistantRole(step.task?.by) === 'ops').map((step) => step.task!.machine);
    expect(asked.length).toBeGreaterThan(0);
    for (const intent of asked) expect(ad.intents.map((i) => i.key)).toContain(intent);
    // The first look rests in the room as a task; the re-read is one turn, so nothing piles up as an alarm flaps.
    expect(ad.intents.find((i) => i.key === 'incident_first_look')).toMatchObject({ multiStep: true });
    expect(ad.intents.find((i) => i.key === 'deployment_health')?.multiStep).toBeUndefined();
  });

  it('imports as a draft, activates, and exports saying exactly what the manifest says', async () => {
    const { client } = fakeSsmStore();
    const draft = await importManifest(client, ROOT, manifest, {
      catalog: CATALOG, knownProfile: isKnownProfile, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES,
      actor: 'operator', targetProfileName: OPS_ASSISTANT,
    });
    expect(draft.profileName).toBe(OPS_ASSISTANT);
    const before = await exportManifest(client, ROOT, OPS_ASSISTANT);
    expect(opsImportPlan(before, manifest).action).toBe('import');
    await activateDraft(client, ROOT, OPS_ASSISTANT, CATALOG, 'operator', CONTEXT_SOURCES, GUARDRAILS, draft.configId);
    const exported = await exportManifest(client, ROOT, OPS_ASSISTANT);
    expect(differingBodyKeys(exported.body as never, manifest.body as never)).toEqual([]);
    expect(exported.contentHash).toBe(manifest.contentHash);
    expect(opsImportPlan(exported, manifest)).toEqual({ action: 'none', reason: 'already-active', differing: [] });
  });
});

describe('what the import step decides', () => {
  const shipped = opsAssistantManifest();
  const active = (body: Record<string, unknown>) => ({ body: body as never, provenance: { sourceProfileName: OPS_ASSISTANT, sourceVersion: 'active' as const, exportedConfigId: 'x' } });

  it('imports when the assistant has no active version (its export is the compiled seed)', () => {
    const seed = { body: { modelKey: 'sonnet' } as never, provenance: { sourceProfileName: OPS_ASSISTANT, sourceVersion: 'seed' as const, exportedConfigId: 'x' } };
    expect(opsImportPlan(seed, shipped)).toMatchObject({ action: 'import', reason: 'no-active-version' });
  });

  it('refuses an export answer it cannot read, rather than import over whatever is active', () => {
    expect(opsImportPlan(undefined, shipped)).toEqual({ action: 'refuse', reason: 'unreadable-export', differing: [] });
    expect(opsImportPlan({ provenance: { sourceProfileName: OPS_ASSISTANT, sourceVersion: 'active', exportedConfigId: 'x' } } as never, shipped)).toMatchObject({ action: 'refuse', reason: 'unreadable-export' });
  });

  it('writes nothing when the active version says what the manifest says, whatever its key order', () => {
    const reordered = Object.fromEntries(Object.entries(shipped.body).reverse());
    expect(opsImportPlan(active(reordered), shipped)).toEqual({ action: 'none', reason: 'already-active', differing: [] });
  });

  it('refuses an active version that differs, naming the fields, and replaces it only when asked', () => {
    const edited = { ...shipped.body, displayName: 'Night shift', boundary: 'edited' };
    expect(opsImportPlan(active(edited), shipped)).toEqual({ action: 'refuse', reason: 'active-differs', differing: ['boundary', 'displayName'] });
    expect(opsImportPlan(active(edited), shipped, { replace: true })).toEqual({ action: 'import', reason: 'replace', differing: ['boundary', 'displayName'] });
  });
});

describe('the demo seed', () => {
  it('writes no ops assistant definition and names the import command', () => {
    const seed = readFileSync(resolve(__dirname, '../../scripts/seed-demo.ts'), 'utf8');
    expect(seed).toContain('[OPS_ASSISTANT])) {');
    expect(seed).toContain('import --if-deployed');
    expect(seed).not.toMatch(/OPS_PERSONA|opsIntentPack|OPS_BOUNDARY|OPS_WELCOME/);
  });

  it('the seed phase imports the ops assistant after seeding, so a fresh deployment with the role gets its first version', () => {
    const validate = readFileSync(resolve(__dirname, '../../scripts/validate.mjs'), 'utf8');
    expect(validate).toContain("cmd: 'npx ts-node scripts/seed-demo.ts && npm run -s ops-assistant -- import --if-deployed'");
    const standalone = readFileSync(resolve(__dirname, '../../scripts/ops-assistant.mjs'), 'utf8');
    expect(standalone).toContain("result.notDeployed && args.includes('--if-deployed')");
  });

  it('an open draft is replaced only when asked, and validation passes only on its own word', () => {
    const lib = readFileSync(resolve(__dirname, '../../scripts/lib/ops-assistant-import.mjs'), 'utf8');
    expect(lib).toMatch(/DRAFT_EXISTS[\s\S]*if \(!replace\)[\s\S]*replaceConfigId/);
    expect(lib).toContain('validationRefusals(valid)');
  });

});

describe('the import has one implementation, which creating the ops assistant runs', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');
  const lib = read('scripts/lib/ops-assistant-import.mjs');
  const role = read('scripts/add-assistant-role.mjs');
  const standalone = read('scripts/ops-assistant.mjs');

  it('reads the SSM root through the one resolver, and imports, validates and activates by the imported configId', () => {
    expect(lib).toContain('resolveInstanceName(env)');
    expect(lib).toMatch(/call\('\/import'[\s\S]*call\('\/validate'[\s\S]*call\('\/activate', \{ profileName: OPS_ASSISTANT, configId \}\)/);
    expect(lib).toContain("IMPORTED_ASSISTANTS = ['ops-premium']");
  });

  it('add-assistant-role imports after a successful deploy, previews it on a dry run, and never on a withdrawal', () => {
    expect(role).toContain("await import('./lib/ops-assistant-import.mjs')");
    expect(role).toContain('const importsVersion = !args.remove && IMPORTED_ASSISTANTS.includes(args.assistant);');
    // The preview is printed before the dry run returns; the import runs only after the deploy's success line.
    const preview = role.indexOf('importPreview(args.assistant)');
    const dryRunExit = role.indexOf("console.log('\\n--dry-run: nothing was written and nothing was deployed.');");
    const deployFailed = role.indexOf('the deploy failed (exit');
    const runs = role.indexOf('result = await importOpsAssistant()');
    expect(preview).toBeGreaterThan(0);
    expect(dryRunExit).toBeGreaterThan(preview);
    expect(runs).toBeGreaterThan(deployFailed);
    expect(deployFailed).toBeGreaterThan(dryRunExit);
  });

  it('the standalone command runs the same module', () => {
    expect(standalone).toContain("from './lib/ops-assistant-import.mjs'");
    expect(standalone).not.toMatch(/SignatureV4|call\('\/import'/);
  });
});

describe('the ops team\'s process travels as its own manifest (SPEC-PROCESSES P13)', () => {
  const assistant = opsAssistantManifest();
  const processManifest = opsIncidentProcessManifest();

  it('the assistant manifest carries no process', () => {
    expect((assistant.body as { processes?: unknown }).processes).toBeUndefined();
  });

  it('the process manifest carries incident response, valid against the assistant manifest\'s own workflows', () => {
    expect(processManifest).toMatchObject({ kind: 'process', ownerProfileName: OPS_ASSISTANT, processName: OPS_INCIDENT_PROCESS, process: opsIncidentProcess()[OPS_INCIDENT_PROCESS] });
    expect(readProcessManifest(processManifest)).toEqual({ manifest: processManifest });
    expect(versionProcessesErrors(opsIncidentProcess(), assistant.body.eventWorkflows)).toEqual([]);
  });

  it('its requirements are met by the ops manifest plus the shipped types and roles, Advisor holding the primary role', () => {
    const intents = (pack: unknown, name: string) => projectAdvertisement({ assistant: name, pack: pack as never }).intents.map((i) => i.key);
    const target: ProcessTarget = {
      classification: 'premium',
      workflows: Object.keys(assistant.body.eventWorkflows ?? {}),
      conversationTypes: deploymentConversationTypes('premium'),
      assistantRoles: {
        primary: { assistant: defaultProfileRegistry.roleAssistantName('premium', 'primary')!, intents: intents(stratumIntentPack('premium'), 'advisor') },
        ops: { assistant: defaultProfileRegistry.roleAssistantName('premium', 'ops')!, intents: intents(assistant.body.intentPack, OPS_ASSISTANT) },
      },
      templates: [...shippedMessageTemplates().keys()],
      machines: Object.keys(withVersionMachines(DEFAULT_TASK_STATE_MACHINES, assistant.body.intentPack as never)),
    };
    expect(target.assistantRoles.ops.assistant).toBe(OPS_ASSISTANT);
    expect(processManifest.requires.conversationTypes).toEqual(['customer-messaging', 'ops', 'ops-team']);
    expect(processRequirementErrors(processManifest.requires, target)).toEqual([]);
  });

  it('an active version holding the process is current, and one without it is not, whatever the assistant says', () => {
    expect(opsProcessIsCurrent({ processes: opsIncidentProcess() }, processManifest)).toBe(true);
    expect(opsProcessIsCurrent({}, processManifest)).toBe(false);
    const active = { body: { ...assistant.body, processes: opsIncidentProcess() } as never, provenance: { sourceProfileName: OPS_ASSISTANT, sourceVersion: 'active' as const, exportedConfigId: 'x' } };
    expect(opsImportPlan(active, assistant)).toEqual({ action: 'none', reason: 'already-active', differing: [] });
  });

  it('the import step imports the assistant, then the process into that draft, then validates and activates', () => {
    const lib = readFileSync(resolve(__dirname, '../../scripts/lib/ops-assistant-import.mjs'), 'utf8');
    expect(lib).toMatch(/call\('\/import'[\s\S]*call\('\/process-import'[\s\S]*replaceConfigId: configId[\s\S]*call\('\/validate'[\s\S]*call\('\/activate'/);
    expect(lib).toContain('PROCESS_REQUIREMENTS_UNMET');
  });
});
