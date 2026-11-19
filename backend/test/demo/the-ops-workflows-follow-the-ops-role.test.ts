/**
 * THE OPS ROOMS' WORKFLOWS ARE THE OPS ASSISTANT'S, AND THE PREMIUM PRIMARY'S WELCOMES FOR THEM FOLLOW THE OPS ROLE.
 *
 * The ops assistant is the primary of `ops` and `ops-team` rooms and owns their workflows, so `ops-room` and
 * `incident-triage` ride its own version (its manifest). The Advisor is a member of both and carries one welcome for each,
 * `welcome-ops` and `welcome-ops-team`, on its version only while the ops role is, so the demo's console shows no ops
 * workflows before ops is created. The seed leaves them off a deployment that declares no ops role, and
 * `npm run ops-workflows -- add|remove` puts them on and takes them off, taking off the Advisor any workflow the ops
 * assistant owns.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { OPS_WORKFLOW_KEYS, OWNED_BY_OPS_KEYS, opsAssistantGap, opsWorkflows, withOpsWorkflows } from '../../../demo/portable-assistants/ops-workflows';
import { opsEventWorkflows } from '../../../demo/portable-assistants/ops-assistant-manifest';
import { ADVISOR_WELCOME } from '../../../demo/portable-assistants/welcomes';
import { SHIPPED_EVENT_WORKFLOWS, versionEventWorkflowsErrors } from '../../lambda/src/lib/event-workflow';

describe('the ops workflows', () => {
  it('the Advisor carries its two welcomes, and the ops rooms\' own workflows are the ops assistant\'s', () => {
    expect([...OPS_WORKFLOW_KEYS].sort()).toEqual(['welcome-ops', 'welcome-ops-team']);
    expect(opsWorkflows()).toEqual(ADVISOR_WELCOME);
    expect([...OWNED_BY_OPS_KEYS].sort()).toEqual(['customer-messaging', 'incident-triage', 'ops-room']);
    const ops = opsEventWorkflows();
    expect(ops['ops-room']).toEqual(SHIPPED_EVENT_WORKFLOWS['ops-room']);
    expect(ops['incident-triage']).toEqual(SHIPPED_EVENT_WORKFLOWS['incident-triage']);
    expect(versionEventWorkflowsErrors(ops)).toEqual([]);
  });

  it('are added beside every other workflow, and a second add changes nothing', () => {
    const other = { on: 'person-joined', initial: 'done', states: { done: { disposition: 'success' } } };
    const added = withOpsWorkflows({ 'greet-joiner': other }, 'add');
    expect(added.changed).toBe(true);
    expect(Object.keys(added.eventWorkflows).sort()).toEqual(['greet-joiner', 'welcome-ops', 'welcome-ops-team']);
    expect(added.eventWorkflows['greet-joiner']).toEqual(other);
    expect(withOpsWorkflows(added.eventWorkflows, 'add').changed).toBe(false);
  });

  it('an add takes off the Advisor the workflows the ops assistant now owns, and its old room welcome', () => {
    const before = { ...ADVISOR_WELCOME, 'welcome-ops-team': { ...ADVISOR_WELCOME['welcome-ops-team'], initial: 'old' }, 'ops-room': SHIPPED_EVENT_WORKFLOWS['ops-room'], 'incident-triage': SHIPPED_EVENT_WORKFLOWS['incident-triage'] };
    const moved = withOpsWorkflows(before, 'add');
    expect(moved.changed).toBe(true);
    expect(moved.moved.sort()).toEqual(['incident-triage', 'ops-room']);
    expect(moved.eventWorkflows).toEqual(ADVISOR_WELCOME);
  });

  it('are removed and every other workflow is kept, and a second remove changes nothing', () => {
    const other = { on: 'person-joined', initial: 'done', states: { done: { disposition: 'success' } } };
    const removed = withOpsWorkflows({ ...opsWorkflows(), 'ops-room': SHIPPED_EVENT_WORKFLOWS['ops-room'], 'greet-joiner': other }, 'remove');
    expect(removed.changed).toBe(true);
    expect(removed.eventWorkflows).toEqual({ 'greet-joiner': other });
    expect(withOpsWorkflows(removed.eventWorkflows, 'remove').changed).toBe(false);
  });

  it('are not seeded on a deployment that declares no ops role', () => {
    const seed = readFileSync(resolve(__dirname, '../../scripts/seed-demo.ts'), 'utf8');
    expect(seed).toContain('...(opsRoleDeclared ? { advisor: ADVISOR_WELCOME } : {})');
  });

  it('add reports an ops assistant version that lacks the ops rooms\' workflows or holds them unlike its manifest', () => {
    const shipped = opsEventWorkflows();
    expect(opsAssistantGap(shipped)).toEqual({ missing: [], differs: [] });
    // A version imported before the ops assistant owned the ops rooms' workflows: its welcomes alone.
    const welcomesOnly = Object.fromEntries(Object.entries(shipped).filter(([k]) => !(OWNED_BY_OPS_KEYS as readonly string[]).includes(k)));
    expect(opsAssistantGap(welcomesOnly)).toEqual({ missing: ['ops-room', 'incident-triage', 'customer-messaging'], differs: [] });
    expect(opsAssistantGap(undefined).missing).toEqual(['ops-room', 'incident-triage', 'customer-messaging']);
    const edited = { ...shipped, 'ops-room': { ...shipped['ops-room'], initial: 'first-look' } };
    expect(opsAssistantGap(edited)).toEqual({ missing: [], differs: ['ops-room'] });
    // An inherited name is never read as a workflow the version carries.
    expect(opsAssistantGap(Object.create({ 'ops-room': shipped['ops-room'] })).missing).toContain('ops-room');
    const cli = readFileSync(resolve(__dirname, '../../scripts/ops-workflows.mjs'), 'utf8');
    expect(cli).toMatch(/if \(mode === 'add'\) \{\s*const ops = must\(await call\('\/export', \{ profileName: OPS_ASSISTANT \}\)/);
    expect(cli).toContain('opsAssistantGap(ops.manifest?.body?.eventWorkflows)');
    expect(cli).toContain('process.exitCode = 1');
  });
});
