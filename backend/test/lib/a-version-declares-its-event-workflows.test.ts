/**
 * A VERSION DECLARES ITS OWN EVENT WORKFLOWS (ADR-061 decision 1, as built; SPEC-WELCOME-AND-CONTEXT FR25).
 *
 * What it proves: a version's `eventWorkflows` round-trips through the body and is part of its `configId`; it is
 * held to the platform workflows' rules plus size bounds and one workflow per type an event selects (W1); every template
 * it names exists and fits its step; export carries it and import validates it in the target, refusing a
 * state-changing tool; the version's own workflow is chosen over a platform one of the same name; and an experiment
 * arm's version is the one the welcome, the dispatch and the processor read. Task machines stay select-only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getModelCatalog } from '../../lib/config/model-strategy';
import {
  MAX_EVENT_WORKFLOW_STEPS,
  MAX_VERSION_EVENT_WORKFLOWS,
  PLATFORM_EVENT_WORKFLOWS,
  versionEventWorkflowsErrors,
  workflowFor,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { bodyFrom, buildDefinition } from '../../lambda/src/lib/active-profile';
import { patchShapeErrors } from '../../lambda/src/lib/profile-copy-fields';
import {
  activateDraft,
  classificationServedBy,
  createDraft,
  editDraft,
  eventWorkflowTemplateErrors,
  isKnownProfile,
  welcomeWorkflowErrors,
} from '../../lambda/src/lib/profile-lifecycle';
import { exportManifest, importManifest, ProfileManifestError } from '../../lambda/src/lib/profile-manifest';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const OWN: EventWorkflow = clone(PLATFORM_EVENT_WORKFLOWS['ops-room']);
OWN.states.opening.send!.template = 'ops-room-opening';
const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

describe('the declaration', () => {
  it('round-trips through the body and is part of what the version is identified by', () => {
    const base = { modelKey: 'titan' };
    const withOwn = { ...base, eventWorkflows: { 'ops-mine': OWN } };
    expect(bodyFrom(withOwn as never).eventWorkflows).toEqual({ 'ops-mine': OWN });
    const a = buildDefinition('x', bodyFrom(base as never)).configId;
    const b = buildDefinition('x', bodyFrom(withOwn as never)).configId;
    const changed = clone(OWN);
    changed.states['first-look'].agent!.deadlineMs = 15_000;
    const c = buildDefinition('x', bodyFrom({ ...base, eventWorkflows: { 'ops-mine': changed } } as never)).configId;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('a patch may carry it, and a task machine still may not', () => {
    expect(patchShapeErrors({ eventWorkflows: { 'ops-mine': OWN } })).toEqual([]);
    const lifecycle = read('lib/profile-lifecycle.ts');
    expect(lifecycle).toMatch(/machines are global workflows and are not part of a version/);
    expect(lifecycle).toMatch(/EVENT WORKFLOWS ARE THE EXCEPTION, BY DECISION \(ADR-061 decision 1, as built\)/);
  });
});

describe('validation, the platform rules and the version\'s own', () => {
  const refused = (mutate: (wfs: Record<string, any>) => void, pattern: RegExp) => {
    const wfs: Record<string, any> = { 'ops-mine': clone(OWN) };
    mutate(wfs);
    expect(versionEventWorkflowsErrors(wfs).join('\n')).toMatch(pattern);
  };

  it('refuses each rule a platform workflow is held to', () => {
    refused((w) => { w['ops-mine'].states['first-look'].agent.tools = ['advance_task_state']; }, /which changes state/);
    refused((w) => { w['ops-mine'].states['first-look'].agent.propose = ['x']; }, /propose names exactly one of send_nudge, open_conversation/);
    refused((w) => { delete w['ops-mine'].states['first-look'].agent.deadlineMs; }, /deadlineMs/);
    refused((w) => { delete w['ops-mine'].states['first-look'].agent.fallback; }, /fallback must be a send/);
    refused((w) => { w['ops-mine'].states['greet-lead'].onSuccess = 'opening'; }, /cycle/);
    refused((w) => { w['ops-mine'].types = ['general']; }, /no event opens/);
    refused((w) => { w['ops-mine'].initial = 'first-look'; }, /initial must be a send/);
  });

  it('bounds the count, the steps, the size and the names', () => {
    refused((w) => { for (let i = 0; i < MAX_VERSION_EVENT_WORKFLOWS; i++) w[`w${i}`] = clone(OWN); }, new RegExp(`at most ${MAX_VERSION_EVENT_WORKFLOWS} workflows`));
    refused((w) => {
      const states = w['ops-mine'].states;
      for (let i = 0; i < MAX_EVENT_WORKFLOW_STEPS; i++) states[`extra-${i}`] = { disposition: 'success' };
    }, new RegExp(`at most ${MAX_EVENT_WORKFLOW_STEPS} steps`));
    refused((w) => { w['ops-mine'].states.opening.send.template = 'x'.repeat(40_000); }, /at most 32000 characters/);
    refused((w) => { w['Bad Name'] = clone(OWN); }, /not a workflow name/);
  });

  it('a workflow its event selects is accepted, and two that would answer for one type are refused (W1)', () => {
    expect(welcomeWorkflowErrors({ modelKey: 'x', eventWorkflows: { 'ops-mine': OWN } } as never)).toEqual([]);
    expect(welcomeWorkflowErrors({ modelKey: 'x', eventWorkflows: { 'ops-mine': OWN, 'ops-room': clone(OWN) } } as never).join())
      .toMatch(/both run on conversation-opened in ops conversations/);
  });

  it('every template it names exists and fits its step', async () => {
    const wf = clone(OWN);
    wf.states.opening.send!.template = 'nobody-wrote-this';
    wf.states['first-look'].agent!.prompt = 'ops-room-opening'; // a message, where a prompt is needed
    const store = { bucket: 'b', ssmRoot: '/ae', s3: { send: async () => { throw Object.assign(new Error('nk'), { name: 'NoSuchKey' }); } }, ssm: { send: async () => { throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' }); } } } as never;
    const errors = await eventWorkflowTemplateErrors({ modelKey: 'x', eventWorkflows: { 'ops-mine': wf } } as never, 'ops-premium', store);
    expect(errors).toEqual([
      expect.stringMatching(/opening\.send\.template names "nobody-wrote-this", which is not a message template/),
      expect.stringMatching(/first-look\.agent\.prompt names "ops-room-opening", which is not a prompt template/),
    ]);
    expect(await eventWorkflowTemplateErrors({ modelKey: 'x', eventWorkflows: { 'ops-mine': OWN } } as never, 'ops-premium', store)).toEqual([]);
    expect(classificationServedBy('ops-premium')).toBeTruthy();
  });
});

describe('export and import (SPEC-PORTABLE-PROFILES)', () => {
  const ROOT = '/agent-echelon';
  const CATALOG = getModelCatalog('us-east-1', '123456789012');
  const opts = { catalog: CATALOG, knownProfile: isKnownProfile, guardrailCatalog: async () => [{ key: 'default', guardrailId: 'g' }], contextSourceCatalog: async () => [{ key: 'user-profile', contractVersion: '1.0', fields: { displayName: { type: 'string' }, company: { type: 'string', optional: true } } }], actor: 'admin' };

  it('export carries the workflow by names only, and import lands it as a draft', async () => {
    const a = fakeSsmStore();
    await createDraft(a.client, ROOT, 'ops-premium', 'admin');
    await editDraft(a.client, ROOT, 'ops-premium', { modelKey: 'titan', eventWorkflows: { 'ops-mine': OWN } } as never, 'admin');
    await activateDraft(a.client, ROOT, 'ops-premium', CATALOG, 'admin');
    const manifest = await exportManifest(a.client, ROOT, 'ops-premium');
    expect(manifest.body.eventWorkflows).toEqual({ 'ops-mine': OWN });
    expect(JSON.stringify(manifest.body.eventWorkflows)).not.toMatch(/arn:aws/);
    const b = fakeSsmStore();
    const draft = await importManifest(b.client, ROOT, manifest, opts as never);
    expect(draft.eventWorkflows).toEqual({ 'ops-mine': OWN });
  });

  it('import refuses a workflow with a state-changing tool in the target', async () => {
    const a = fakeSsmStore();
    await createDraft(a.client, ROOT, 'ops-premium', 'admin');
    await editDraft(a.client, ROOT, 'ops-premium', { modelKey: 'titan', eventWorkflows: { 'ops-mine': OWN } } as never, 'admin');
    await activateDraft(a.client, ROOT, 'ops-premium', CATALOG, 'admin');
    const manifest = await exportManifest(a.client, ROOT, 'ops-premium');
    const tampered = clone(manifest);
    (tampered.body.eventWorkflows as Record<string, EventWorkflow>)['ops-mine'].states['first-look'].agent!.tools = ['advance_task_state'];
    delete (tampered as { signature?: unknown }).signature;
    const b = fakeSsmStore();
    const err = await importManifest(b.client, ROOT, tampered, opts as never).catch((e) => e);
    expect(err).toBeInstanceOf(ProfileManifestError);
    expect(JSON.stringify((err as ProfileManifestError & { errors?: string[] }).errors ?? err.message)).toMatch(/advance_task_state\\", which changes state/);
  });
});

describe('the runtime reads the served version\'s own workflow', () => {
  it('chooses the version\'s own over a platform workflow of the same name', () => {
    const mine = clone(PLATFORM_EVENT_WORKFLOWS['ops-room']);
    mine.states['first-look'].agent!.deadlineMs = 5_000;
    expect(workflowFor({ 'ops-room': mine }, 'ops-room')).toBe(mine);
    expect(workflowFor({}, 'ops-room')).toBe(PLATFORM_EVENT_WORKFLOWS['ops-room']);
    expect(workflowFor(undefined, 'nope')).toBeUndefined();
  });

  it('the welcome, the event and the continuation read the served version, an experiment arm\'s when enrolled', () => {
    const router = read('router-agent-handler.ts');
    const served = router.slice(router.indexOf('async function servedWelcomeVersion('));
    expect(served).toMatch(/enrollmentOf\(channelArn, [\s\S]{0,200}resolveEnrollment\(/);
    expect(served).toMatch(/await Promise\.all\(\[resolveActiveProfile\(profileName/);
    expect(served).toMatch(/return \{ version: resolveFromDefinition\(await hydrateBodies\(arm\.variantProfile\), profileName\), variantProfile: arm\.variantProfile \};/);
    expect(router).toMatch(/welcome = welcomeWorkflowOf\(active\.eventWorkflows, conversationType\);/);
    expect(router).toMatch(/const opened = openedWorkflowOf\(served\?\.version\.eventWorkflows, type\);/);
    expect(router).toMatch(/const wf = workflowFor\(served\?\.version\.eventWorkflows, str\(req\.workflow\)\);/);
    // The arm's definition rides the dispatch, so the processor serves the same version.
    expect(router).toMatch(/\.\.\.\(variantProfile \? \{ variantProfile \} : \{\}\),\n\s+\}\);/);
    const processor = read('assistant-async-processor.ts');
    expect(processor).toMatch(/const activeProfile = event\.variantProfile\n\s+\? \{ \.\.\.resolveFromDefinition/);
    expect(processor).toMatch(/const wf = workflowFor\(stepWorkflows, req\.workflow\);/);
    // A step the run's own assistant takes reads the served version; one another assistant takes reads its owner's.
    expect(processor).toMatch(/: activeProfile\.eventWorkflows;/);
  });
});
