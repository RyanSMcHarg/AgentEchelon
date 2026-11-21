/**
 * A PROCESS TRAVELS AS ITS OWN MANIFEST (SPEC-PROCESSES P13, DESIGN-PROCESSES section 8).
 *
 * A process manifest carries one `processes` entry and what its linked workflows need of a deployment, computed from them:
 * the conversation types they run in and open, the participant roles they address, the assistant roles they ask and the
 * intents asked, the templates they say and the machines they open. The check against a target names every missing thing
 * as a code with its names, so the console says it in words from its locale bundle (D11).
 */
import { SHIPPED_EVENT_WORKFLOWS, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import {
  buildProcessManifest, deploymentConversationTypes, mergeRequirements, processContentHashOf, processRequirementErrors, processRequirementsOf,
  readProcessManifest, PROCESS_MANIFEST_REFUSALS, type ProcessRequirements, type ProcessTarget,
} from '../../lambda/src/lib/process-manifest';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';

const INCIDENT_WORKFLOWS = ['incident-triage', 'ops-room', 'customer-messaging'];
const workflows = (): Record<string, EventWorkflow> => Object.fromEntries(INCIDENT_WORKFLOWS.map((k) => [k, JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS[k]))]));
const incident = { label: 'Incident response', workflows: INCIDENT_WORKFLOWS };

describe('what the shipped incident response requires, computed from its workflows', () => {
  const requires = processRequirementsOf(incident, workflows());

  it('the workflows it links, in order', () => {
    expect(requires.workflows).toEqual(INCIDENT_WORKFLOWS);
  });

  it('the conversation types they run in and open: the team conversation, the incident, and customer messaging', () => {
    expect(requires.conversationTypes).toEqual(['customer-messaging', 'ops', 'ops-team']);
  });

  it('the participant roles they address, by the type that declares each: the on-call, the incident\'s lead, the account team\'s lead', () => {
    expect(requires.participantRoles).toEqual([
      { type: 'customer-messaging', role: 'lead:accounts' },
      { type: 'ops', role: 'lead' },
      { type: 'ops', role: 'on-call:ops' },
      { type: 'ops-team', role: 'on-call:ops' },
    ]);
  });

  it('the assistant roles they ask and the intent each step asks, by the type its workflow runs in', () => {
    expect(requires.assistantRoles).toEqual([
      { type: 'customer-messaging', role: 'primary', intents: ['customer_notice_draft', 'impacted_accounts'] },
      { type: 'ops', role: 'ops', intents: ['dashboard_refresh', 'incident_first_look', 'runbook_cause', 'runbook_verify'] },
      { type: 'ops', role: 'primary', intents: ['impacted_accounts'] },
    ]);
  });

  it('the machines its steps open themselves, and none it asks of another assistant', () => {
    expect(requires.machines).toEqual(['acknowledgement', 'approval', 'customer_updates', 'final_notice', 'incident_ownership', 'meeting_offer']);
    const asked = requires.assistantRoles.flatMap((r) => r.intents);
    for (const m of requires.machines) expect(asked).not.toContain(m);
  });

  it('every template they send, prompt with, ask or assign, each one the platform ships', () => {
    expect(requires.templates).toEqual(expect.arrayContaining([
      'incident-declared', 'ops-room-opening', 'incident-owner-task', 'incident-owner-task-no-call', 'customer-impact',
      'runbook-cause', 'runbook-verify', 'post-incident-review-draft', 'customer-messaging-opening', 'customer-notice-initial', 'customer-notice-approval',
    ]));
    const shipped = shippedMessageTemplates();
    expect(requires.templates.filter((t) => !shipped.has(t))).toEqual([]);
    expect(new Set(requires.templates).size).toBe(requires.templates.length);
  });

  it('a linked workflow the version does not declare is listed and contributes nothing more', () => {
    const r = processRequirementsOf({ workflows: ['gone'] }, {});
    expect(r).toEqual({ workflows: ['gone'], conversationTypes: [], participantRoles: [], assistantRoles: [], templates: [], machines: [] });
  });

  it('merging what a manifest says with what the target\'s workflows need keeps every requirement once', () => {
    const extra: ProcessRequirements = { workflows: ['ops-room'], conversationTypes: ['ops'], participantRoles: [{ type: 'ops', role: 'lead' }], assistantRoles: [{ type: 'ops', role: 'ops', intents: ['deployment_health'] }], templates: ['x'], machines: ['form'] };
    const merged = mergeRequirements(requires, extra);
    expect(merged.workflows).toEqual(INCIDENT_WORKFLOWS);
    expect(merged.participantRoles).toEqual(requires.participantRoles);
    expect(merged.assistantRoles.find((r) => r.type === 'ops' && r.role === 'ops')!.intents).toContain('deployment_health');
    expect(merged.templates).toContain('x');
    expect(merged.machines).toContain('form');
  });
});

describe('the manifest is instance-agnostic and checked on its way in', () => {
  const build = () => buildProcessManifest({
    ownerProfileName: 'ops-premium', processName: 'incident-response', body: { eventWorkflows: workflows(), processes: { 'incident-response': incident } },
    provenance: { sourceProfileName: 'ops-premium', sourceVersion: 'active', exportedConfigId: 'abc123abc123' },
  })!;

  it('carries the entry, what it requires and a content hash, and names no ARN, account or Region', () => {
    const m = build();
    expect(m).toMatchObject({ schemaVersion: 1, kind: 'process', ownerProfileName: 'ops-premium', processName: 'incident-response', process: incident });
    expect(m.contentHash).toBe(processContentHashOf(m));
    const scanned = JSON.stringify({ ...m, contentHash: '', provenance: { ...m.provenance, exportedConfigId: '' } });
    expect(scanned).not.toMatch(/arn:aws|\b\d{12}\b|\b(us|eu|ap)-(east|west|central)-\d\b/);
  });

  it('a version that declares no such process has none to export', () => {
    expect(buildProcessManifest({ ownerProfileName: 'ops-premium', processName: 'nope', body: { processes: {} }, provenance: { sourceProfileName: 'ops-premium', sourceVersion: 'active', exportedConfigId: 'x' } })).toBeUndefined();
  });

  it('reads back what it wrote', () => {
    const m = build();
    expect(readProcessManifest(JSON.parse(JSON.stringify(m)))).toEqual({ manifest: m });
    expect(readProcessManifest(JSON.stringify(m))).toEqual({ manifest: m });
  });

  it('DENY: a manifest edited after export, whose hash no longer matches', () => {
    const m = build();
    expect(readProcessManifest({ ...m, requires: { ...m.requires, assistantRoles: [] } })).toEqual({ refusals: [{ code: 'PROCESS_MANIFEST_HASH' }] });
  });

  it('DENY: anything that is not a process manifest, or one larger than the bound', () => {
    expect(readProcessManifest({ kind: 'assistant-profile' })).toEqual({ refusals: [{ code: 'PROCESS_MANIFEST_SHAPE' }] });
    expect(readProcessManifest('not json')).toEqual({ refusals: [{ code: 'PROCESS_MANIFEST_SHAPE' }] });
    const m = build();
    expect(readProcessManifest({ ...m, process: { ...m.process, extra: 1 } })).toEqual({ refusals: [{ code: 'PROCESS_MANIFEST_SHAPE', process: 'incident-response' }] });
    expect(readProcessManifest({ ...m, padding: 'x'.repeat(40 * 1024) })).toEqual({ refusals: [{ code: 'PROCESS_MANIFEST_SIZE' }] });
  });

  it('DENY: a signed manifest whose signature does not verify, and an unsigned one where signatures are required', () => {
    const m = build();
    process.env.MANIFEST_SIGNING_SECRET = 'secret';
    try {
      const signed = build();
      expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(readProcessManifest(signed)).toEqual({ manifest: signed });
      expect(readProcessManifest({ ...signed, signature: 'f'.repeat(64) })).toEqual({ refusals: [{ code: 'PROCESS_MANIFEST_SIGNATURE' }] });
      process.env.MANIFEST_REQUIRE_SIGNATURE = 'true';
      expect(readProcessManifest(m)).toEqual({ refusals: [{ code: 'PROCESS_MANIFEST_SIGNATURE' }] });
    } finally {
      delete process.env.MANIFEST_SIGNING_SECRET;
      delete process.env.MANIFEST_REQUIRE_SIGNATURE;
    }
  });
});

describe('the requirement check names what the target lacks', () => {
  const requires = processRequirementsOf(incident, workflows());
  /** A target that has everything the incident response needs: the shipped types at premium, both roles and their intents. */
  const met = (): ProcessTarget => ({
    classification: 'premium',
    workflows: [...INCIDENT_WORKFLOWS, 'welcome'],
    conversationTypes: deploymentConversationTypes('premium'),
    assistantRoles: {
      primary: { assistant: 'advisor', intents: ['impacted_accounts', 'customer_notice_draft', 'account_status'] },
      ops: { assistant: 'ops-premium', intents: ['incident_first_look', 'dashboard_refresh', 'runbook_cause', 'runbook_verify', 'deployment_health'] },
    },
    templates: [...shippedMessageTemplates().keys()],
    machines: Object.keys(DEFAULT_TASK_STATE_MACHINES),
  });

  it('every refusal code is one the console says (`admin.processes.errors.*`)', () => {
    expect(PROCESS_MANIFEST_REFUSALS).toEqual(expect.arrayContaining([
      'PROCESS_REQ_WORKFLOW', 'PROCESS_REQ_TYPE', 'PROCESS_REQ_ROLE', 'PROCESS_REQ_ASSISTANT_ROLE', 'PROCESS_REQ_INTENT', 'PROCESS_REQ_TEMPLATE', 'PROCESS_REQ_MACHINE',
    ]));
  });

  it('all met: no refusal, and the shipped types at premium declare every role it addresses', () => {
    expect(processRequirementErrors(requires, met())).toEqual([]);
  });

  it('DENY: a linked workflow the owner\'s version does not declare', () => {
    const t = { ...met(), workflows: ['incident-triage', 'ops-room'] };
    expect(processRequirementErrors(requires, t)).toEqual([{ code: 'PROCESS_REQ_WORKFLOW', workflow: 'customer-messaging' }]);
  });

  it('DENY: a conversation type the deployment does not declare at the owner\'s classification, said once and not once per role', () => {
    const { 'customer-messaging': _gone, ...types } = met().conversationTypes;
    expect(processRequirementErrors(requires, { ...met(), conversationTypes: types })).toEqual([{ code: 'PROCESS_REQ_TYPE', type: 'customer-messaging', classification: 'premium' }]);
    // A classification no shipped ops type permits declares none of them.
    expect(Object.keys(deploymentConversationTypes('basic'))).not.toContain('ops');
  });

  it('DENY: a participant role the type does not declare', () => {
    const t = met();
    const types = { ...t.conversationTypes, ops: t.conversationTypes.ops.filter((r) => r !== 'lead') };
    expect(processRequirementErrors(requires, { ...t, conversationTypes: types })).toEqual([{ code: 'PROCESS_REQ_ROLE', type: 'ops', role: 'lead' }]);
  });

  it('DENY: no assistant holds an asked role, named for each type that asks it', () => {
    const { ops: _ops, ...roles } = met().assistantRoles;
    expect(processRequirementErrors(requires, { ...met(), assistantRoles: roles })).toEqual([{ code: 'PROCESS_REQ_ASSISTANT_ROLE', type: 'ops', role: 'ops' }]);
  });

  it('DENY: the role\'s assistant\'s active version does not advertise the intent asked', () => {
    const t = met();
    const roles = { ...t.assistantRoles, primary: { assistant: 'advisor', intents: ['impacted_accounts'] } };
    expect(processRequirementErrors(requires, { ...t, assistantRoles: roles })).toEqual([
      { code: 'PROCESS_REQ_INTENT', type: 'customer-messaging', role: 'primary', intent: 'customer_notice_draft', assistant: 'advisor' },
    ]);
  });

  it('DENY: a template the target does not hold', () => {
    const t = { ...met(), templates: met().templates.filter((n) => n !== 'runbook-verify') };
    expect(processRequirementErrors(requires, t)).toEqual([{ code: 'PROCESS_REQ_TEMPLATE', template: 'runbook-verify' }]);
  });

  it('DENY: a machine the version does not run', () => {
    const t = { ...met(), machines: met().machines.filter((n) => n !== 'customer_updates') };
    expect(processRequirementErrors(requires, t)).toEqual([{ code: 'PROCESS_REQ_MACHINE', machine: 'customer_updates' }]);
  });
});
