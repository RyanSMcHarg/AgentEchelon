/**
 * AN OLD EXPORT IMPORTS INTO THE NEW FORM (ADR-067 stage 4, decision 5).
 *
 * What it proves: an agent step that opened a task in the room (`agent.workflow`, retired) is rewritten for a new draft
 * or an import as a create-task step on the same machine, worked by the same role, visible to the room, going on once the
 * task opens, with its absent and fallback messages kept as sends on its failure edge (the absent one only where nobody
 * holds the role); the result passes the current validator; a body with nothing retired is returned as it is; the
 * validator refuses the retired field on a draft; and both doors that write a new version from an older one, a new draft
 * and an import, rewrite it, while the runner keeps reading a stored version as it is.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { inCurrentForm, workflowInCurrentForm } from '../../lambda/src/lib/retired-fields';
import { eventWorkflowErrors, SHIPPED_EVENT_WORKFLOWS, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { AGENT_STEP_OPS_ROOM } from '../helpers/agent-step-ops-room';

describe('an agent step that opened a task is rewritten as a task step', () => {
  const { workflow, rewritten } = workflowInCurrentForm(AGENT_STEP_OPS_ROOM as EventWorkflow);

  it('opens the same machine, worked by the same role, going on once the task opens', () => {
    expect(rewritten).toEqual(['first-look']);
    expect(workflow.states['first-look']).toEqual({
      task: { machine: 'incident_first_look', by: { assistantRole: 'ops' }, continue: 'opened' },
      onSuccess: 'done',
      onFailure: [{ to: 'first-look-absent', when: { 'task:outcome': 'no-worker' } }, { to: 'first-look-unavailable' }],
    });
  });

  it('keeps the absent and fallback messages as sends on its failure edge', () => {
    expect(workflow.states['first-look-absent']).toEqual({ send: { to: 'room', template: 'ops-assistant-absent' }, onSuccess: 'done', onFailure: 'done' });
    expect(workflow.states['first-look-unavailable']).toEqual({ send: { to: 'room', template: 'ops-first-look-unavailable' }, onSuccess: 'done', onFailure: 'done' });
  });

  it('passes the current validator, as the shipped ops room does', () => {
    expect(eventWorkflowErrors('ops-room', workflow)).toEqual([]);
    expect(eventWorkflowErrors('ops-room', SHIPPED_EVENT_WORKFLOWS['ops-room'])).toEqual([]);
  });

  it('a body with nothing retired is returned as it is', () => {
    const body = { eventWorkflows: { 'ops-room': SHIPPED_EVENT_WORKFLOWS['ops-room'] } } as never;
    const out = inCurrentForm(body);
    expect(out.body).toBe(body);
    expect(out.rewritten).toEqual([]);
  });

  it('names what it rewrote by path', () => {
    expect(inCurrentForm({ eventWorkflows: { 'ops-room': AGENT_STEP_OPS_ROOM } } as never).rewritten)
      .toEqual(['eventWorkflows.ops-room.states.first-look.agent.workflow']);
  });
});

describe('the retired field', () => {
  it('is refused on a draft that carries it again', () => {
    expect(eventWorkflowErrors('ops-room', AGENT_STEP_OPS_ROOM as EventWorkflow).join('\n')).toMatch(/first-look\.agent\.workflow is retired: open the task with a task step/);
  });

  it('is rewritten by both doors that write a new version from an older one, and the runner keeps a stored one as it is', () => {
    const lifecycle = readFileSync(resolve(__dirname, '../../lambda/src/lib/profile-lifecycle.ts'), 'utf8');
    expect(lifecycle).toMatch(/const current = inCurrentForm\(started, needsPack \? \{ pack: await classificationPackOf\(ssm, ssmRoot, profileName\) \} : \{\}\);/);
    const manifest = readFileSync(resolve(__dirname, '../../lambda/src/lib/profile-manifest.ts'), 'utf8');
    expect(manifest).toMatch(/inCurrentForm\(bodyFrom\(m\.body as Partial<ProfileDefinitionBody>\)\)\.body/);
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).not.toMatch(/inCurrentForm/);
  });
});
