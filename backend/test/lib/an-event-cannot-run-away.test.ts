/**
 * AN EVENT CANNOT RUN AWAY WITH ROOMS OR WORKFLOWS (SPEC-WORKFLOWS-AND-TASKS WT122).
 *
 * What it proves: the policy is checked on attach and again on every event, and a stored policy that is invalid or unreadable is
 * never more permissive than the dev values; no edit may exceed the most allowed; an open incident for the same resource takes the
 * event and opens nothing, and a room at its cap opens nothing until one is resolved, both before any model call; the relay passes
 * on a bounded number of events at once and an operator hears when it throttles; and the incident is a task the on-call
 * resolves, so the run ends when the work does.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  DEV_EVENT_POLICY, EVENT_POLICY_MOST, eventPolicyErrors, eventPolicyOf, eventTypeAllowed, forgetEventPolicy, patternAllowed, readEventPolicy,
} from '../../lambda/src/lib/event-policy';
import { SHIPPED_EVENT_WORKFLOWS, eventWorkflowErrors } from '../../lambda/src/lib/event-workflow';
import { DEFAULT_TASK_STATE_MACHINES, PLATFORM_MACHINE_KEYS } from '../../lambda/src/lib/task-state-machines';

const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

describe('the policy', () => {
  it('ships the dev values, which are valid and strict', () => {
    expect(eventPolicyErrors(DEV_EVENT_POLICY)).toEqual([]);
    expect(DEV_EVENT_POLICY).toMatchObject({ enabled: true, maxTriggersPerRoom: 5, maxTriggers: 20, maxOpenIncidentsPerRoom: 3, retryAttempts: 2, maxEventAgeSeconds: 900 });
  });

  it.each([
    ['a cap over the most allowed', { maxTriggers: EVENT_POLICY_MOST.maxTriggers + 1 }, /maxTriggers is a whole number/],
    ['no open incident at all', { maxOpenIncidentsPerRoom: 0 }, /maxOpenIncidentsPerRoom/],
    ['a fraction', { maxTriggersPerRoom: 2.5 }, /maxTriggersPerRoom/],
    ['an event type with no detail type', { allowedEventTypes: [{ source: 'aws.ec2' }] }, /names its source and detailType/],
    ['a field it does not hold', { maxChildren: 9 }, /does not declare maxChildren/],
  ])('refuses %s', (_n, change, pattern) => {
    expect(eventPolicyErrors({ ...DEV_EVENT_POLICY, ...change }).join()).toMatch(pattern);
  });

  it('a stored value that is not a valid policy means the dev values, never something looser', () => {
    expect(eventPolicyOf({ ...DEV_EVENT_POLICY, maxTriggers: 10_000 })).toBe(DEV_EVENT_POLICY);
    expect(eventPolicyOf('nonsense')).toBe(DEV_EVENT_POLICY);
  });

  it('a stored policy that says off is off, even when another of its fields is wrong', () => {
    expect(eventPolicyOf({ ...DEV_EVENT_POLICY, enabled: false, maxTriggers: 10_000 }).enabled).toBe(false);
    expect(eventPolicyOf({ enabled: false }).enabled).toBe(false);
  });

  it('allows a pattern only when every source and detail type it names is allowed', () => {
    expect(eventTypeAllowed(DEV_EVENT_POLICY, 'aws.cloudwatch', 'CloudWatch Alarm State Change')).toBe(true);
    expect(patternAllowed(DEV_EVENT_POLICY, { source: ['aws.cloudwatch'], 'detail-type': ['CloudWatch Alarm State Change'] })).toBe(true);
    expect(patternAllowed(DEV_EVENT_POLICY, { source: ['aws.cloudwatch', 'aws.ec2'], 'detail-type': ['CloudWatch Alarm State Change'] })).toBe(false);
    expect(patternAllowed(DEV_EVENT_POLICY, { source: [] })).toBe(false);
  });

  it('a deployment that never set one runs the dev values, and one whose read fails runs nothing', async () => {
    const env = process.env.EVENT_POLICY_PARAM;
    delete process.env.EVENT_POLICY_PARAM;
    forgetEventPolicy();
    expect((await readEventPolicy(1)).enabled).toBe(false);
    forgetEventPolicy();
    if (env !== undefined) process.env.EVENT_POLICY_PARAM = env;
  });
});

describe('the router holds the policy and the open incidents before any model call', () => {
  const router = read('lambda/src/router-agent-handler.ts');
  const handler = router.slice(router.indexOf('async function openIncidents'), router.indexOf('DELETE THE DEADLINE SCHEDULES'));
  const at = (s: string) => { const i = handler.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };

  it('in this order: switched off, not allowed, the same resource, the cap, then the run', () => {
    const run = at('return runWorkflowFor(');
    for (const refusal of ['event triggers are switched off', 'the event type is not allowed', 'the event is older than the policy allows', 'an incident for this resource is open', 'the room holds as many open incidents as its policy allows']) {
      expect(at(refusal)).toBeLessThan(run);
    }
    expect(at('the event type is not allowed')).toBeLessThan(at('an incident for this resource is open'));
  });

  it('refuses when the open incidents cannot be read, rather than opening one more', () => {
    expect(handler).toContain('open incidents could not be read');
  });
});

describe('the admin action holds the policy at attach', () => {
  const api = read('lambda/src/event-triggers-api.ts');
  it.each(['TRIGGERS_OFF', 'EVENT_TYPE_NOT_ALLOWED', 'TOO_MANY_TRIGGERS', 'POLICY_INVALID'])('refuses with %s', (code) => {
    expect(api).toContain(code);
  });
  it('counts the deployment\'s trigger rules at every classification against maxTriggers', () => {
    expect(api).toContain('new ListRulesCommand({ NamePrefix: RULE_PREFIX,');
    expect(api).toContain('await triggerCount() >= policy.maxTriggers');
  });
  // A room whose creation stopped after `CreateChannel` carries its `team-room` tag with nobody in it, so an attach that
  // trusted the tag would attach a trigger to an empty room. Every attach asks the creator, which opens the
  // room once and completes it after; the room's count is read only once it stands, and a failed read refuses.
  it('opens or completes the room on every attach, then reads its triggers, refusing when that read fails rather than counting none', () => {
    expect(api).toMatch(/const room = await ensureTeamRoom\(typeKey, classification\);\s*if \(!room\.ok\) \{[\s\S]{0,300}\}\s*\/\/[^\n]*\n\s*const roomTags = await readChannelTags\(chime as never, channelArn\);/);
    expect(api).not.toContain('roomTags?.[TEAM_ROOM_TAG]');
  });
  // A suffix dispatch would let `POST /admin/event-triggers/x/event-policy`, a route `manage-event-triggers` allows, reach the
  // policy write that `manage-event-policy` guards, so each branch is reached only through the route the gateway matched.
  it('reaches each branch only through the route the gateway matched, never a suffix of the path', () => {
    expect(api).not.toMatch(/event\.path\.endsWith/);
    expect(api).toContain("const route = event.resource ?? '';");
    expect(api).toContain("if (route === '/admin/event-policy') {");
    expect(api).toMatch(/if \(route !== TRIGGERS_ROUTE && route !== REMOVE_ROUTE\) return respond\(event, 404/);
  });
  it('copies a rule on the default event bus only', () => {
    expect(api).toContain('a rule on a custom bus cannot be copied yet');
  });
  it('takes the rule\'s retries from the policy', () => {
    expect(api).toMatch(/MaximumRetryAttempts: policy\.retryAttempts, MaximumEventAgeInSeconds: policy\.maxEventAgeSeconds/);
  });
});

describe('the relay is bounded and heard', () => {
  const stack = read('lib/stacks/assistant-profile-stack.ts');
  it('passes on a bounded number of events at once, two on dev', () => {
    expect(stack).toMatch(/reservedConcurrentExecutions: Number\(this\.node\.tryGetContext\('eventTriggerRelayConcurrency'\) \?\? 2\)/);
  });
  it('never retries, since the rule already did', () => {
    expect(stack).toMatch(/The relay never retries: the rule already did\.\n\s*retryAttempts: 0,/);
  });
  it('alarms when it throttles', () => {
    expect(stack).toMatch(/'EventTriggerRelayThrottled'[\s\S]{0,400}eventTriggerRelay\.metricThrottles/);
  });
});

describe('the incident is a task the on-call resolves', () => {
  it('is a platform machine with one open state, a confirmation of a resolve mid-runbook, and one resolution', () => {
    expect(PLATFORM_MACHINE_KEYS).toContain('incident_ownership');
    const m = DEFAULT_TASK_STATE_MACHINES.incident_ownership;
    expect(m.initial).toBe('open');
    expect(m.states.open.transitions).toEqual(['resolved', 'confirming_resolve']);
    expect(m.states.confirming_resolve.transitions).toEqual(['resolved', 'open']);
    expect(m.states.resolved.terminal).toBe('success');
  });

  it('the shipped incident is held by the conversation it opened, whose run ends when the on-call resolves it there', () => {
    const wf = SHIPPED_EVENT_WORKFLOWS['incident-triage'];
    expect(eventWorkflowErrors('incident-triage', wf)).toEqual([]);
    expect(wf.states.tell.onSuccess).toBe('hold');
    expect(wf.states.hold.wait).toEqual({ child: 'ended' });
    const room = SHIPPED_EVENT_WORKFLOWS['ops-room'];
    expect(room.states['lead-task'].task).toEqual({
      machine: 'incident_ownership', by: { participantRole: 'on-call:ops' }, continue: 'alongside', assigned: { template: 'incident-owner-task', withoutMeetings: 'incident-owner-task-no-call' }, deadline: { afterMinutes: 43_200 },
      endsRun: true, confirmEnd: 'confirming_resolve', movesTo: 'resolved',
    });
  });

  it('the holder of the incident is told in a template the assistant has', () => {
    const told = JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS['ops-room']));
    told.states['lead-task'].task.assigned = { template: 'no-such-template' };
    expect(eventWorkflowErrors('ops-room', told).join()).toMatch(/assigned\.template names no-such-template/);
  });
});
