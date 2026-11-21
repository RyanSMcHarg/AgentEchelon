/**
 * A PROCESS DEFINITION IS REFUSED WHEN INCOMPLETE (SPEC-PROCESSES P1, P5, P10; DESIGN-PROCESSES section 2, O37).
 *
 * What it proves: a `processes` entry on a version links only workflows that version declares, and one workflow to one
 * process; an entry declares its label, its description, its workflows, its hand-offs and its metrics and nothing else; a
 * hand-off field is one of the closed types, an enum lists values and a ref names a declared connector, so no declaration can
 * carry free text; a metric names a linked workflow and one of its steps; each refusal is a coded reason the
 * console says from its locale bundle; the entry rides the version (kept by `bodyFrom`, hashed into `configId`); and the
 * process id and edition are the hashes the design names.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  PROCESS_REFUSALS, SHIPPED_EVENT_WORKFLOWS, eventWorkflowErrors, versionProcessesErrors, type VersionProcess,
} from '../../lambda/src/lib/event-workflow';
import { processEditionOf, startedProcess } from '../../lambda/src/lib/process-start';
import { bodyFrom, profileDefinitionConfigId, type ProfileDefinitionBody } from '../../lambda/src/lib/active-profile';
import { contentHash12 } from '../../lambda/src/lib/canonical-json';

const workflows = {
  'account-desk': { on: 'event-received', types: ['general'], initial: 'decided', states: { decided: { disposition: 'success' } } },
  'other-desk': { on: 'event-received', types: ['general'], initial: 'done', states: { done: { disposition: 'success' } } },
};

const customerRequest: VersionProcess = {
  label: 'Customer request',
  workflows: ['account-desk'],
  handoffs: {
    'security-review': {
      fields: {
        accountId: { type: 'id' },
        requestKind: { type: 'enum', values: ['data-export', 'access-change', 'integration'] },
        dueBy: { type: 'time' },
        ticket: { type: 'ref', store: 'crm' },
      },
    },
  },
  metrics: [{ id: 'decision-in-2d', label: 'Security decision within 2 days', workflow: 'account-desk', step: 'decided', outcome: 'success', within: 'P2D', target: 0.8 }],
};

const errs = (processes: unknown, connectors: readonly string[] = ['crm']) => versionProcessesErrors(processes, workflows, undefined, { connectors });
const codes = (processes: unknown) => errs(processes).map((e) => e.split(': ')[1]);

describe('a process is declared on its team\'s version', () => {
  it('as the design writes it', () => {
    expect(errs({ 'customer-request': customerRequest })).toEqual([]);
  });

  it('absent, nothing is checked', () => {
    expect(errs(undefined)).toEqual([]);
  });

  it('linking only workflows the version declares', () => {
    expect(codes({ p: { ...customerRequest, workflows: ['no-such'], metrics: [] } })).toEqual(['PROCESS_WORKFLOW_UNDECLARED']);
    expect(codes({ p: { ...customerRequest, workflows: [], metrics: [] } })).toContain('PROCESS_NO_WORKFLOWS');
  });

  it('one workflow to one process', () => {
    expect(codes({ a: { label: 'A', workflows: ['account-desk'] }, b: { label: 'B', workflows: ['account-desk'] } })).toEqual(['PROCESS_WORKFLOW_LINKED_TWICE']);
  });

  it('with a label and a process name', () => {
    expect(codes({ p: { workflows: ['account-desk'] } })).toEqual(['PROCESS_LABEL']);
    expect(codes({ 'Bad Name': { label: 'x', workflows: ['account-desk'] } })).toEqual(['PROCESS_NAME']);
  });
});

describe('a hand-off carries typed fields only (O2)', () => {
  const withField = (spec: unknown) => ({ p: { label: 'P', workflows: ['account-desk'], handoffs: { h: { fields: { f: spec } } } } });

  it.each(['text', 'string', 'prose', undefined])('DENY: refuses the type %s, so no free text crosses', (type) => {
    expect(codes(withField({ type }))).toEqual(['HANDOFF_FIELD_TYPE']);
  });

  it('DENY: an enum lists its values', () => {
    expect(codes(withField({ type: 'enum' }))).toEqual(['HANDOFF_ENUM_EMPTY']);
    expect(codes(withField({ type: 'enum', values: [] }))).toEqual(['HANDOFF_ENUM_EMPTY']);
  });

  it('DENY: a ref names a connector the deployment declares', () => {
    expect(codes(withField({ type: 'ref', store: 'erp' }))).toEqual(['HANDOFF_REF_STORE']);
    expect(errs(withField({ type: 'ref', store: 'crm' }), [])).toHaveLength(1);
  });

  it('DENY: a hand-off declares at least one field, and nothing beside its fields', () => {
    expect(codes({ p: { label: 'P', workflows: ['account-desk'], handoffs: { h: { fields: {} } } } })).toEqual(['HANDOFF_FIELDS']);
    expect(codes({ p: { label: 'P', workflows: ['account-desk'], handoffs: { h: { fields: { f: { type: 'id' } }, note: 'x' } } } })).toEqual(['HANDOFF_FIELDS']);
    expect(codes({ p: { label: 'P', workflows: ['account-desk'], handoffs: { 'Bad Name': { fields: { f: { type: 'id' } } } } } })).toEqual(['HANDOFF_NAME']);
  });

  it('each refusal is a code the console says', () => {
    for (const c of ['HANDOFF_NAME', 'HANDOFF_FIELDS', 'HANDOFF_FIELD_TYPE', 'HANDOFF_ENUM_EMPTY', 'HANDOFF_REF_STORE', 'HANDOFF_UNDECLARED']) expect(PROCESS_REFUSALS).toContain(c);
  });
});

describe('an entry declares its label, its description, its workflows, its hand-offs and its metrics only', () => {
  it('DENY: any other key is refused', () => {
    expect(codes({ p: { label: 'P', workflows: ['account-desk'], severity: 'sev1' } })).toEqual(['PROCESSES_SHAPE']);
  });
});

describe('a metric reads what its process links', () => {
  const metric = (m: unknown) => ({ p: { label: 'P', workflows: ['account-desk'], metrics: [m] } });
  it('a linked workflow, and one of its steps', () => {
    expect(codes(metric({ id: 'm', label: 'M', workflow: 'other-desk' }))).toEqual(['METRIC_WORKFLOW']);
    expect(codes(metric({ id: 'm', label: 'M', workflow: 'account-desk', step: 'nope' }))).toEqual(['METRIC_STEP']);
  });
  it('a time and a target of the right shape', () => {
    expect(codes(metric({ id: 'm', label: 'M', workflow: 'account-desk', within: 'two days' }))).toEqual(['METRIC_SHAPE']);
    expect(codes(metric({ id: 'm', label: 'M', workflow: 'account-desk', target: 80 }))).toEqual(['METRIC_SHAPE']);
  });
});

describe('each refusal is a code the console says from its locale bundle', () => {
  const locale = JSON.parse(readFileSync(resolve(__dirname, '../../../frontend/packages/shared/src/locales/en.json'), 'utf8'));
  it.each([...PROCESS_REFUSALS])('%s', (code) => {
    expect(typeof locale.admin.processes.errors[code]).toBe('string');
  });
  it('and the console renders it through the locale', () => {
    const src = readFileSync(resolve(__dirname, '../../../frontend/packages/admin/src/components/admin/DraftControls.tsx'), 'utf8');
    expect(src).toMatch(/admin\.processes\.errors\./);
  });
});

describe('the definition rides the version', () => {
  const base = { modelKey: 'sonnet', eventWorkflows: workflows } as unknown as ProfileDefinitionBody;
  it('kept by the body whitelist and hashed into configId', () => {
    const withProcess = { ...base, processes: { 'customer-request': customerRequest } } as ProfileDefinitionBody;
    expect(bodyFrom(withProcess).processes).toEqual(withProcess.processes);
    expect(profileDefinitionConfigId(bodyFrom(withProcess))).not.toBe(profileDefinitionConfigId(bodyFrom(base)));
  });

  it('validated on save and activate, beside the event workflows', () => {
    const src = readFileSync(resolve(__dirname, '../../lambda/src/lib/profile-lifecycle.ts'), 'utf8');
    expect(src).toMatch(/versionProcessesErrors\(body\.processes, body\.eventWorkflows, body\.intentWorkflows, \{ connectors: declaredConnectors\(\) \}\)/);
  });
});

describe('the process id and the edition (P2, P10)', () => {
  const runKey = 'event-received#rule-abc#accounts';
  it('a linked workflow\'s run starts the process, keyed by the process and the run', () => {
    const started = startedProcess({ 'customer-request': customerRequest }, 'account-desk', runKey);
    expect(started).toEqual({ id: contentHash12({ process: 'customer-request', run: runKey }), name: 'customer-request', edition: contentHash12(customerRequest) });
    expect(startedProcess({ 'customer-request': customerRequest }, 'account-desk', runKey)?.id).toBe(started?.id);
  });
  it('a workflow no process links starts none', () => {
    expect(startedProcess({ 'customer-request': customerRequest }, 'other-desk', runKey)).toBeUndefined();
  });
  it('the edition changes with the entry, never with the rest of the version', () => {
    expect(processEditionOf({ ...customerRequest, label: 'Customer request v2' })).not.toBe(processEditionOf(customerRequest));
    expect(processEditionOf({ ...customerRequest })).toBe(processEditionOf(customerRequest));
  });
});

describe('a process and each stage say what they are for (SPEC-PROCESSES P9)', () => {
  it('a process may carry a description of at most 300 characters, and rewording it starts no new edition', () => {
    expect(codes({ p: { ...customerRequest, description: 'From the request to its answer.' } })).toEqual([]);
    expect(codes({ p: { ...customerRequest, description: 'x'.repeat(301) } })).toEqual(['PROCESS_DESCRIPTION']);
    expect(codes({ p: { ...customerRequest, description: '  ' } })).toEqual(['PROCESS_DESCRIPTION']);
    expect(processEditionOf({ ...customerRequest, description: 'Reworded.' })).toBe(processEditionOf(customerRequest));
  });

  it('a stage may carry a description, only beside its label; the shipped incident stages each say what they are for', () => {
    const wf = (state: Record<string, unknown>) => eventWorkflowErrors('w', { on: 'assistant-joined', initial: 's', states: { s: { ...state, send: { to: 'room', template: 'x' }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } } });
    expect(wf({ label: 'Told', description: 'The room hears it.' }).filter((e) => e.includes('description'))).toEqual([]);
    expect(wf({ label: 'Told', description: 'x'.repeat(301) }).some((e) => e.includes('.description says what the stage is for'))).toBe(true);
    expect(wf({ description: 'No label.' }).some((e) => e.includes('.description belongs to a stage'))).toBe(true);
    for (const name of ['incident-triage', 'ops-room', 'customer-messaging']) {
      for (const [step, def] of Object.entries(SHIPPED_EVENT_WORKFLOWS[name].states)) {
        if ((def as { label?: string }).label) expect(`${name}.${step}: ${typeof (def as { description?: string }).description}`).toBe(`${name}.${step}: string`);
      }
    }
  });
});
