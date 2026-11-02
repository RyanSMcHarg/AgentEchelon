/**
 * PREVIEW RUN WALKS A WORKFLOW WITH SAMPLE VALUES, AND SAYS NOTHING AND WRITES NOTHING (ADR-061 decision 7).
 *
 * What it proves: the walk is the runtime's own runner, so each step, gate and edge is decided as a real run decides it
 * (a send's audience and values, a role's holder, a conditioned edge on a sample value, an agent step's fallback, a task
 * step's deadline edge); the draft's preview is held to the draft's rules and refuses bad input by name; and the deny
 * side: the preview module builds no AWS client, a preview of a stored draft issues reads only (no SSM write, no S3
 * write, no message, no invoke), the route is a view-profiles route whose grants name only it, and the manage-profiles
 * role gains no statement for it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PLATFORM_EVENT_WORKFLOWS, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { previewWorkflowRun } from '../../lambda/src/lib/workflow-preview';
import { createDraft, editDraft, previewDraftWorkflow, ProfileValidationError } from '../../lambda/src/lib/profile-lifecycle';
import { ADMIN_CAPABILITIES } from '../../lib/config/admin-capabilities';
import { ADMIN_CONSOLE_ROLE_NAME } from '../../lib/constructs/admin-role-grants';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { adminApiTemplate, adminServicesTemplate } from '../helpers/synth';

const mockS3Calls: Array<{ verb: string; key: string }> = [];
jest.mock('@aws-sdk/client-s3', () => {
  class PutObjectCommand { constructor(public input: { Key: string }) {} }
  class GetObjectCommand { constructor(public input: { Key: string }) {} }
  class S3Client {
    async send(cmd: PutObjectCommand | GetObjectCommand): Promise<unknown> {
      mockS3Calls.push({ verb: cmd instanceof PutObjectCommand ? 'put' : 'get', key: cmd.input.Key });
      if (cmd instanceof PutObjectCommand) return {};
      throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command: class {} };
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const OPS: EventWorkflow = clone(PLATFORM_EVENT_WORKFLOWS['ops-room']);
const ROOT = '/agent-echelon';
const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');

describe('the walk is the runtime\'s', () => {
  it('says each send to whom it reaches with the values it would carry, and goes on past an agent step as it succeeds', async () => {
    const r = await previewWorkflowRun('ops', OPS);
    expect(r.steps.map((s) => `${s.step}:${s.outcome}`)).toEqual(['opening:posted', 'greet-lead:posted', 'first-look:dispatched']);
    expect(r.acts[0]).toMatchObject({ step: 'opening', act: 'send', template: 'ops-room-opening', to: 'room', values: { lead: 'lead-holder' } });
    expect(r.acts[1]).toMatchObject({ step: 'greet-lead', act: 'send', to: ['lead-holder'] });
    expect(r.acts[2]).toMatchObject({ step: 'first-look', act: 'agent', template: 'ops-first-look' });
    expect(r.ended).toBe('success');
  });

  it('an agent step that fails says its fallback, with no model call, and takes its failure edge', async () => {
    const r = await previewWorkflowRun('ops', OPS, { outcomes: { 'first-look': 'failure' } });
    expect(r.acts.filter((a) => a.fallback)).toEqual([expect.objectContaining({ step: 'first-look', template: 'ops-first-look-unavailable', to: 'room' })]);
    expect(r.ended).toBe('success');
  });

  it('a conditioned edge reads the sample value the caller gives, and the otherwise branch without one', async () => {
    const wf = clone(OPS);
    wf.states.opening.onSuccess = [{ to: 'first-look', when: { 'conversation:type': 'ops' } }, { to: 'greet-lead' }];
    const given = await previewWorkflowRun('ops', wf, { values: { 'conversation:type': 'ops' } });
    expect(given.steps.map((s) => s.step)).toEqual(['opening', 'first-look']);
    const none = await previewWorkflowRun('ops', wf);
    expect(none.steps.map((s) => s.step)).toEqual(['opening', 'greet-lead', 'first-look']);
  });

  it('a task step opens its task and goes on by how it ended: success, or its deadline edge', async () => {
    const wf: EventWorkflow = {
      on: 'assistant-joined', initial: 'ask',
      states: {
        ask: { task: { machine: 'acknowledgement', for: 'subject', by: 'subject', deadline: { afterMinutes: 5 } }, onSuccess: 'thanks', onFailure: 'done', onDeadline: 'chase' },
        thanks: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done', onFailure: 'done' },
        chase: { send: { to: 'subject', template: 'workflow-subject-welcome' }, onSuccess: 'done', onFailure: 'done' },
        done: { disposition: 'success' },
      },
    };
    const ok = await previewWorkflowRun('t', wf);
    expect(ok.acts.map((a) => `${a.step}:${a.act}`)).toEqual(['ask:task', 'thanks:send']);
    const late = await previewWorkflowRun('t', wf, { outcomes: { ask: 'deadline' } });
    expect(late.acts.map((a) => `${a.step}:${a.act}`)).toEqual(['ask:task', 'chase:send']);
    expect(late.acts[1].to).toEqual(['subject']);
  });
});

describe('a draft\'s preview', () => {
  const setup = async () => {
    const s = fakeSsmStore();
    await createDraft(s.client, ROOT, 'ops-premium', 'admin');
    await editDraft(s.client, ROOT, 'ops-premium', { modelKey: 'titan', eventWorkflows: { 'ops-mine': OPS } } as never, 'admin');
    (s.client.send as unknown as jest.Mock).mockClear();
    mockS3Calls.length = 0;
    return s;
  };

  it('walks the draft\'s own workflow, or the one the console holds, reading and writing nothing else', async () => {
    const { client } = await setup();
    const own = await previewDraftWorkflow(client as never, ROOT, 'ops-premium', { workflow: 'ops-mine' });
    expect(own.ended).toBe('success');
    const unsaved = clone(OPS);
    delete unsaved.states['greet-lead'];
    unsaved.states.opening.onSuccess = 'first-look';
    unsaved.states.opening.onFailure = 'first-look';
    const held = await previewDraftWorkflow(client as never, ROOT, 'ops-premium', { workflow: 'ops-mine', definition: unsaved });
    expect(held.steps.map((s) => s.step)).toEqual(['opening', 'first-look']);
    // THE DENY SIDE: reads only. No parameter written, labelled or deleted; no body written.
    const verbs = (client.send as unknown as jest.Mock).mock.calls.map(([cmd]: [object]) => cmd.constructor.name);
    expect(verbs.length).toBeGreaterThan(0);
    expect(verbs.every((v: string) => v === 'GetParameterCommand')).toBe(true);
    expect(mockS3Calls.filter((c) => c.verb !== 'get')).toEqual([]);
  });

  it('refuses by name a workflow that breaks the draft\'s rules, a missing one, and malformed samples', async () => {
    const { client } = await setup();
    const broken = clone(OPS);
    broken.initial = 'nowhere';
    const errs = async (req: Record<string, unknown>) => ((await previewDraftWorkflow(client as never, ROOT, 'ops-premium', req as never).catch((e) => e)) as ProfileValidationError).errors;
    expect(await errs({ workflow: 'ops-mine', definition: broken })).toEqual(expect.arrayContaining([expect.stringMatching(/eventWorkflows\.ops-mine\.initial names a declared step/)]));
    expect(await errs({ workflow: 'nope' })).toEqual(["no workflow named 'nope' to preview"]);
    expect(await errs({ workflow: 'ops-mine', outcomes: { 'first-look': 'maybe' } })).toEqual(['outcomes.first-look is success, failure or deadline']);
    expect(await errs({ workflow: 'ops-mine', values: { 'conversation:type': { x: 1 } } })).toEqual(['values.conversation:type is a string, a number, a boolean or a list of strings']);
  });
});

describe('it cannot post or write', () => {
  it('the preview module holds no AWS client and imports no SDK, so no dependency it builds can act', () => {
    const src = fs.readFileSync(path.join(SRC, 'lib', 'workflow-preview.ts'), 'utf8');
    expect(src).not.toMatch(/@aws-sdk|Client\(|sessionClient|chimeMessagingClient|fetch\(/);
    const imports = [...src.matchAll(/from '(\.\/[^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./event-workflow.js', './task-state-machines.js', './task-step.js', './variables.js']);
  });

  it('the route is a view-profiles route in both forms, and no capability that writes carries it', () => {
    const paths = (key: string) => [...(ADMIN_CAPABILITIES[key].resources ?? []), ...(ADMIN_CAPABILITIES[key].teamResources ?? [])].map((r) => `${r.method} ${r.path}`);
    expect(paths('view-profiles')).toEqual(expect.arrayContaining(['POST admin/profiles/preview-run', 'POST admin/assistants/{assistant}/profiles/preview-run']));
    for (const key of Object.keys(ADMIN_CAPABILITIES).filter((k) => k !== 'view-profiles')) {
      expect(paths(key).filter((p) => p.includes('preview-run'))).toEqual([]);
    }
    expect(ADMIN_CAPABILITIES['view-profiles'].teamResources!.filter((r) => r.path.includes('preview-run'))
      .every((r) => r.path.startsWith('admin/assistants/{assistant}/'))).toBe(true);
  });

  it('the handler serves it on the existing function with no new grant', () => {
    const construct = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'constructs', 'admin-assistant-administration.ts'), 'utf8');
    expect(construct).toMatch(/const profileActions = \['version', 'draft', 'validate', 'preview-run', /);
    const handler = fs.readFileSync(path.join(SRC, 'manage-profiles.ts'), 'utf8');
    // The preview-run branch alone: from its own test to the next branch's.
    const start = handler.indexOf("path.endsWith('/preview-run')");
    const branch = handler.slice(start, handler.indexOf('if (path.endsWith(', start + 1));
    expect(branch).toMatch(/previewDraftWorkflow\(ssm, SSM_ROOT, profileName/);
    expect(branch).not.toMatch(/editDraft|activate|putDefinition|send\(/);
  });

  it('SYNTHESIZED: the admin console role may invoke it, and the team console role only on an assistant\'s own route', () => {
    const grants = (roleName: string): string[] => {
      const [roleId] = Object.entries(adminServicesTemplate().findResources('AWS::IAM::Role') as Record<string, { Properties?: Record<string, any> }>)
        .find(([, r]) => r.Properties?.RoleName === roleName) ?? [];
      const out: string[] = [];
      for (const p of Object.values(adminApiTemplate().findResources('AWS::IAM::ManagedPolicy') as Record<string, { Properties?: Record<string, any> }>)) {
        if (!JSON.stringify(p.Properties?.Roles ?? []).includes(roleId!)) continue;
        for (const s of p.Properties?.PolicyDocument?.Statement ?? []) {
          if ([].concat(s.Action).includes('execute-api:Invoke' as never)) out.push(...[].concat(s.Resource).map((x) => JSON.stringify(x)));
        }
      }
      return out.filter((g) => g.includes('preview-run'));
    };
    const admin = grants(ADMIN_CONSOLE_ROLE_NAME.admins);
    expect(admin.some((g) => g.includes('/POST/admin/profiles/preview-run'))).toBe(true);
    const team = grants(ADMIN_CONSOLE_ROLE_NAME['team-members']);
    expect(team.length).toBeGreaterThan(0);
    // DENIED: the team console role is never granted the unscoped route, which would preview any assistant's draft.
    expect(team.filter((g) => g.includes('/POST/admin/profiles/preview-run'))).toEqual([]);
    expect(team.every((g) => g.includes('/admin/assistants/'))).toBe(true);
  });
});
