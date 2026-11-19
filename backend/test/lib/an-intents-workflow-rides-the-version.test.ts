/**
 * ADR-066: AN INTENT'S WORKFLOW RIDES THE ASSISTANT'S VERSION (build steps 1 and 2).
 *
 * What it proves:
 *   - a version's intent pack may declare machines keyed by intent, and those are the machines it runs; a version that
 *     declares none runs the classification's and platform's set exactly (no behavior change for any stored version);
 *   - the platform's machines (`PLATFORM_MACHINE_KEYS`) are resolved only from the platform set at runtime, and a version
 *     that declares one is refused by name at draft, validate, activate and import;
 *   - a machine step naming a tool outside the version's tools is refused;
 *   - a task follows the version it started on (`originConfigId`), even after a newer version declares a different
 *     machine, read from the body store when this container has not served that version; a task with no origin follows
 *     the global set;
 *   - machines survive export and import, and a new draft carries the machines its multi-step intents run today.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { getModelCatalog } from '../../lib/config/model-strategy';
import {
  DEFAULT_TASK_STATE_MACHINES, PLATFORM_MACHINE_KEYS, PLATFORM_TASK_MACHINE_KEYS, isPlatformMachineKey, type TaskStateMachine,
} from '../../lambda/src/lib/task-state-machines';
import { taskStateMachines } from '../../lambda/src/lib/intent-pack';
import { machinesAStepMayOpen } from '../../lambda/src/lib/task-step';
import {
  machinesForVersion, machinesForTask, resolveTaskMachines, declaredMachineFor, originConfigIdOf, __clearVersionMachines,
} from '../../lambda/src/lib/version-machines';
import {
  __clearActiveProfileCache, bodyFrom, buildDefinition, resolveFromDefinition, validateDefinitionBody, type ProfileDefinitionBody,
} from '../../lambda/src/lib/active-profile';
import {
  activateDraft, createDraft, editDraft, getDraft, validateDraft, withStartingMachines, ProfileValidationError,
} from '../../lambda/src/lib/profile-lifecycle';
import { exportManifest, importManifest, MANIFEST_SCHEMA_VERSION } from '../../lambda/src/lib/profile-manifest';
import { ALL_TOOL_NAMES } from '../../lambda/src/lib/tool-registry';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

/** In-memory S3, the profile body store. Named `mock*` so jest's hoisted factory may close over it. */
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

const ROOT = '/agent-echelon';
const CATALOG = getModelCatalog('us-east-1', '123456789012');
const ACTOR = 'admin-sub';
const NAME = 'analyst';
const BUCKET = 'profile-bodies';
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** The target's published guardrails and context sources, as the import is handed them. */
const GUARDRAILS = async () => [{ key: 'default', guardrailId: 'gr-target-default' }];
const CONTEXT_SOURCES = async () => [{ key: 'user-profile', contractVersion: '1.0', fields: { displayName: { type: 'string' as const } } }];

/** The report workflow as a team edited it: one more question before drafting. */
const EDITED_REPORT: TaskStateMachine = (() => {
  const m = clone(DEFAULT_TASK_STATE_MACHINES.report_generation);
  const first = m.initial;
  m.states.confirming_audience = { transitions: [first], awaits: { party: 'requester' }, prompt: 'Ask who the report is for.' };
  m.initial = 'confirming_audience';
  return m;
})();
/** A second edit of the same workflow, the version after. */
const REEDITED_REPORT: TaskStateMachine = (() => {
  const m = clone(EDITED_REPORT);
  m.states.confirming_audience.prompt = 'Ask who reads it and when they need it.';
  return m;
})();

const PACK = { extends: 'default' as const, intents: [{ key: 'report_generation' }] };
const packWith = (machines: Record<string, unknown>) => ({ ...PACK, machines }) as unknown as ProfileDefinitionBody['intentPack'];

beforeEach(() => {
  __clearActiveProfileCache();
  mockS3Objects.clear();
  delete process.env.PROFILE_BODY_BUCKET;
});
afterAll(() => { delete process.env.PROFILE_BODY_BUCKET; });

describe('the platform machines are one declaration', () => {
  it('is the queue, the work items and asking a person, and the queue stays its own subset', () => {
    expect([...PLATFORM_MACHINE_KEYS].sort()).toEqual([
      ...PLATFORM_TASK_MACHINE_KEYS, 'action_item', 'place_item', 'approval', 'acknowledgement', 'incident_ownership', 'drift_offer', 'dashboard_refresh', 'form', 'meeting_offer', 'customer_impact', 'customer_updates', 'final_notice', 'meeting_action_item',
    ].sort());
    for (const k of PLATFORM_MACHINE_KEYS) expect(DEFAULT_TASK_STATE_MACHINES[k]).toBeDefined();
    // A workflow step may still open the work items and the asking machines; only the queue's own are closed to it.
    const mayOpen = Object.keys(machinesAStepMayOpen());
    expect(mayOpen).toEqual(expect.arrayContaining(['approval', 'acknowledgement', 'action_item']));
    for (const k of PLATFORM_TASK_MACHINE_KEYS) expect(mayOpen).not.toContain(k);
  });
});

describe('what a version runs', () => {
  it('a version that declares no machines runs the global set exactly', () => {
    expect(machinesForVersion({ configId: 'v-none', intentPack: { intents: [] } as never })).toEqual(taskStateMachines());
    expect(machinesForVersion(undefined)).toEqual(taskStateMachines());
  });

  it('a version runs its own machine for its intent, and every other key as before', () => {
    const m = machinesForVersion({ configId: 'v7', intentPack: packWith({ report_generation: EDITED_REPORT }) as never });
    expect(m.report_generation).toEqual(EDITED_REPORT);
    expect(m.incident_first_look).toEqual(taskStateMachines().incident_first_look);
  });

  it('never resolves a platform key from a version, whatever it stored', () => {
    const forged = { initial: 'x', states: { x: { transitions: [], terminal: 'success' } } };
    const m = machinesForVersion({ configId: 'v-forged', intentPack: packWith({ queue_drain: forged, action_item: forged, report_generation: EDITED_REPORT }) as never });
    expect(m.queue_drain).toEqual(DEFAULT_TASK_STATE_MACHINES.queue_drain);
    expect(m.action_item).toEqual(DEFAULT_TASK_STATE_MACHINES.action_item);
    // The task service is handed only a version's own machine for the type it opens.
    expect(declaredMachineFor({ intentPack: packWith({ action_item: forged }) as never }, 'action_item')).toBeUndefined();
    expect(declaredMachineFor({ intentPack: packWith({ report_generation: EDITED_REPORT }) as never }, 'report_generation'))
      .toEqual({ report_generation: EDITED_REPORT });
  });
});

describe('a task follows the version it started on', () => {
  const v7 = { configId: 'cfg-v7', intentPack: packWith({ report_generation: EDITED_REPORT }) as never };
  const v8 = { configId: 'cfg-v8', intentPack: packWith({ report_generation: REEDITED_REPORT }) as never };

  it('records the served version, never the compiled seed', () => {
    expect(originConfigIdOf(v7)).toBe('cfg-v7');
    expect(originConfigIdOf({ configId: 'seed' })).toBeUndefined();
  });

  it('resolves the machine of its origin even after a newer version declares another', () => {
    machinesForVersion(v7);
    const served = machinesForVersion(v8);
    const task = { taskId: 't1', originConfigId: 'cfg-v7', taskType: 'report_generation' };
    expect(machinesForTask(task, served).report_generation).toEqual(EDITED_REPORT);
    // A task opened on the newer version runs the newer machine.
    expect(machinesForTask({ originConfigId: 'cfg-v8' }, served).report_generation).toEqual(REEDITED_REPORT);
  });

  it('a version this container serves is recorded when it is resolved', () => {
    const def = buildDefinition(NAME, bodyFrom({ modelKey: 'sonnet', intentPack: v7.intentPack } as never));
    __clearVersionMachines();
    resolveFromDefinition(def, NAME);
    expect(machinesForTask({ originConfigId: def.configId }, taskStateMachines()).report_generation).toEqual(EDITED_REPORT);
  });

  it('reads an origin this container has not served from the body store', async () => {
    process.env.PROFILE_BODY_BUCKET = BUCKET;
    mockS3Objects.set(`${BUCKET}/profiles/${NAME}/cfg-v7/intentPack`, JSON.stringify(v7.intentPack));
    __clearVersionMachines();
    const served = machinesForVersion(v8);
    const m = await resolveTaskMachines({ originConfigId: 'cfg-v7' }, { profileName: NAME, fallback: served });
    expect(m.report_generation).toEqual(EDITED_REPORT);
    // A store with no pack body for a version means that version carried none: it runs the global set.
    const none = await resolveTaskMachines({ originConfigId: 'cfg-v6' }, { profileName: NAME, fallback: served });
    expect(none.report_generation).toEqual(taskStateMachines().report_generation);
  });

  it('a row written before the origin existed follows the global set, not the turn\'s version', async () => {
    const served = machinesForVersion(v8);
    expect(machinesForTask({ taskId: 'old' } as Parameters<typeof machinesForTask>[0], served)).toEqual(taskStateMachines());
    expect(await resolveTaskMachines({ taskId: 'old' }, { profileName: NAME, fallback: served })).toEqual(taskStateMachines());
  });

  it('an origin that cannot be read leaves the task on the turn\'s version', async () => {
    __clearVersionMachines();
    const served = machinesForVersion(v8);
    const failing = jest.fn(async () => { throw Object.assign(new Error('denied'), { name: 'AccessDenied' }); });
    const m = await resolveTaskMachines({ originConfigId: 'cfg-v7' }, { profileName: NAME, fallback: served, read: failing });
    expect(m.report_generation).toEqual(REEDITED_REPORT);
  });
});

describe('a version that declares a platform machine is refused by name', () => {
  const platformPack = packWith({ approval: DEFAULT_TASK_STATE_MACHINES.approval });
  const storeDraft = async (client: import('@aws-sdk/client-ssm').SSMClient, body: Record<string, unknown>) => {
    const def = buildDefinition(NAME, body as never);
    await client.send(new PutParameterCommand({ Name: `${ROOT}/assistant/${NAME}/draft`, Type: 'String', Overwrite: true, Value: JSON.stringify(def) }));
  };

  it('at draft', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, NAME, ACTOR);
    await expect(editDraft(client, ROOT, NAME, { intentPack: platformPack }, ACTOR)).rejects.toThrow(/intentPack\.machines\['approval'\] is a platform machine/);
    // The legacy top-level field is refused too, naming the field that is read and the platform key it sends.
    const legacy = editDraft(client, ROOT, NAME, { machines: { queue_drain: DEFAULT_TASK_STATE_MACHINES.queue_drain } } as never, ACTOR);
    await expect(legacy).rejects.toBeInstanceOf(ProfileValidationError);
    await expect(editDraft(client, ROOT, NAME, { machines: { queue_drain: DEFAULT_TASK_STATE_MACHINES.queue_drain } } as never, ACTOR))
      .rejects.toThrow(/intentPack\.machines.*machines\['queue_drain'\] is a platform machine/s);
  });

  it('at validate and at activate', async () => {
    const { client } = fakeSsmStore();
    await storeDraft(client, { modelKey: 'sonnet', intentPack: platformPack });
    const v = await validateDraft(client, ROOT, NAME, CATALOG);
    expect(v.errors.join('\n')).toMatch(/intentPack\.machines\['approval'\] is a platform machine/);
    await expect(activateDraft(client, ROOT, NAME, CATALOG, ACTOR)).rejects.toThrow(/intentPack\.machines\['approval'\] is a platform machine/);
  });

  it('at import', async () => {
    const { client } = fakeSsmStore();
    const manifest = {
      schemaVersion: MANIFEST_SCHEMA_VERSION, kind: 'assistant-profile', profileName: NAME,
      body: { modelKey: 'sonnet', intentPack: platformPack },
      provenance: { sourceProfileName: NAME, sourceVersion: 'active', exportedConfigId: 'x' }, contentHash: 'x',
    };
    await expect(importManifest(client, ROOT, manifest, {
      catalog: CATALOG, knownProfile: () => true, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR,
    })).rejects.toMatchObject({ errors: expect.arrayContaining([expect.stringMatching(/intentPack\.machines\['approval'\] is a platform machine/)]) });
  });
});

describe('a version machine is held to the version', () => {
  const [allowed, other] = ALL_TOOL_NAMES;

  it('a step naming a tool outside the version\'s tools is refused, naming the step and the tool', () => {
    const m = clone(EDITED_REPORT);
    m.states.confirming_audience.tools = [other];
    const errs = validateDefinitionBody({ modelKey: 'sonnet', tools: [allowed], intentPack: packWith({ report_generation: m }) } as never);
    expect(errs.join('\n')).toContain(`intentPack.machines['report_generation'].states['confirming_audience'] names tool(s) this version does not allow: ${other}`);
    // Within the version's tools it is accepted.
    expect(validateDefinitionBody({ modelKey: 'sonnet', tools: [allowed, other], intentPack: packWith({ report_generation: m }) } as never)).toEqual([]);
  });

  it('a machine the graph validation refuses is refused as a classification pack\'s would be', () => {
    const broken = { initial: 'nowhere', states: { start: { transitions: ['missing'] } } };
    expect(validateDefinitionBody({ modelKey: 'sonnet', intentPack: packWith({ report_generation: broken }) } as never).join('\n'))
      .toMatch(/^intentPack\.machines: /m);
  });

  it('an edited machine is accepted on a draft and activates', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, NAME, ACTOR);
    await editDraft(client, ROOT, NAME, { intentPack: packWith({ report_generation: EDITED_REPORT }) }, ACTOR);
    expect((await getDraft(client, ROOT, NAME))?.intentPack?.machines?.report_generation).toEqual(EDITED_REPORT);
    const activated = await activateDraft(client, ROOT, NAME, CATALOG, ACTOR);
    expect(activated.version).toBe(1);
  });
});

describe('machines travel with the version', () => {
  it('survive bodyFrom, export and import', async () => {
    expect(bodyFrom({ modelKey: 'sonnet', intentPack: packWith({ report_generation: EDITED_REPORT }) } as never).intentPack?.machines)
      .toEqual({ report_generation: EDITED_REPORT });
    const a = fakeSsmStore();
    await createDraft(a.client, ROOT, NAME, ACTOR);
    await editDraft(a.client, ROOT, NAME, { intentPack: packWith({ report_generation: EDITED_REPORT }) }, ACTOR);
    await activateDraft(a.client, ROOT, NAME, CATALOG, ACTOR);
    const manifest = await exportManifest(a.client, ROOT, NAME);
    expect((manifest.body.intentPack as { machines?: unknown })?.machines).toEqual({ report_generation: EDITED_REPORT });
    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, manifest, {
      catalog: CATALOG, knownProfile: () => true, guardrailCatalog: GUARDRAILS, contextSourceCatalog: CONTEXT_SOURCES, actor: ACTOR,
    });
    expect(draft.intentPack?.machines).toEqual({ report_generation: EDITED_REPORT });
  });
});

describe('a new draft says what it runs', () => {
  it('is given the machines its multi-step intents run today, platform keys left out', () => {
    const base = taskStateMachines();
    const body = withStartingMachines({ modelKey: 'sonnet', intentPack: { intents: [
      { key: 'report_generation', description: 'r', keywords: ['report'], delivery: 'TASK_MULTI_STEP' },
      { key: 'action_item', description: 'a', keywords: ['todo'], delivery: 'TASK_MULTI_STEP' },
      { key: 'code_review', description: 'c', keywords: ['review'], delivery: 'PLACEHOLDER_UPDATE' },
    ] } } as never, base);
    expect(Object.keys(body.intentPack?.machines ?? {})).toEqual(['report_generation']);
    expect(body.intentPack?.machines?.report_generation).toEqual(base.report_generation);
    // A pack that already declares machines keeps exactly what it declares.
    const own = withStartingMachines({ modelKey: 'sonnet', intentPack: packWith({ report_generation: EDITED_REPORT }) } as never, base);
    expect(own.intentPack?.machines).toEqual({ report_generation: EDITED_REPORT });
  });

  it('New version copies them in where the deployment keeps bodies in S3, and the copy activates', async () => {
    process.env.PROFILE_BODY_BUCKET = BUCKET;
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, NAME, ACTOR);
    await editDraft(client, ROOT, NAME, { intentPack: PACK as never }, ACTOR);
    await activateDraft(client, ROOT, NAME, CATALOG, ACTOR);
    const draft = await createDraft(client, ROOT, NAME, ACTOR);
    const machines = draft.intentPack?.machines ?? {};
    expect(machines.report_generation).toEqual(taskStateMachines().report_generation);
    for (const k of Object.keys(machines)) expect(isPlatformMachineKey(k)).toBe(false);
    expect((await activateDraft(client, ROOT, NAME, CATALOG, ACTOR)).version).toBe(2);
  });

  it('copies nothing where the pack is stored inline, so the version runs its classification\'s set', async () => {
    const { client } = fakeSsmStore();
    await createDraft(client, ROOT, NAME, ACTOR);
    await editDraft(client, ROOT, NAME, { intentPack: PACK as never }, ACTOR);
    await activateDraft(client, ROOT, NAME, CATALOG, ACTOR);
    expect((await createDraft(client, ROOT, NAME, ACTOR)).intentPack?.machines).toBeUndefined();
  });
});

describe('every reader resolves a task\'s machine through its version', () => {
  const router = read('lambda/src/router-agent-handler.ts');
  const processor = read('lambda/src/assistant-async-processor.ts');

  it('the router records the origin on both doors that open a classified request\'s task', () => {
    expect(router).toContain('...originTaskFields(battleSide.taskType),');
    expect(router).toContain('...originTaskFields(taskType),');
    expect(router).toContain('turnMachines = machinesForVersion(activeForPack);');
  });

  it('the router\'s task readers read the task\'s version, not the global set', () => {
    for (const site of [
      'pickupReadiness(task, await resolveTaskMachines(task, { profileName: assistant.profile.name }), assistantId)',
      'const machines = await resolveTaskMachines(task, { profileName: profile.name });',
      'machines: await taskMachinesOf(answered),',
      'machines: await taskMachinesOf(mine),',
      'const declineMachines = await taskMachinesOf(activeTask);',
    ]) expect(router).toContain(site);
    // What is left reading the global set directly, each only where no version is served: the turn's starting value, an
    // event run's continuation and an intent run's continuation.
    expect(router.match(/taskStateMachines\(\)/g)?.length).toBe(3);
  });

  it('the processor runs the task\'s own version\'s machines, and its ending is read against them', () => {
    expect(processor).toContain('await resolveTaskMachines(turnTaskRow, { profileName: turnProfileName, fallback: servedMachines })');
    expect(processor).not.toMatch(/taskStateMachines\(\)/);
    expect(read('lambda/src/lib/async-processor-core.ts')).toContain('const turnTaskMachines = params.taskContext?.machines ?? taskStateMachines();');
  });

  it('the task service drops a platform key a caller sends', () => {
    expect(read('lambda/src/task-service.ts')).toContain('versionDeclaredMachines({ machines: opts.machines })');
  });
});
