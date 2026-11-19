/**
 * AN AWS EVENT STARTS A WORKFLOW IN A TEAM'S ROOM (SPEC-WORKFLOWS-AND-TASKS WT121).
 *
 * What it proves: a trigger chosen as an event type, an ARN or an existing rule is one precise pattern, or a refusal; the room is
 * found by convention; the rule hands over references and never the event's body; one rule gives one run per window however many
 * events arrive; a workflow on this event runs in one team room's type and no other; and what the admin function may write is
 * bounded to the deployment's own rules, a router as their only target, and `event-rule:` tags on a team room.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  EVENT_TRIGGER_WINDOW_MINUTES, eventTriggerWindow, eventTypeOfSchema, patternFor, patternFromRule, teamRoomArn, teamRoomChannelId, triggerRuleId, triggerRuleName, triggerTargetInput,
} from '../../lambda/src/lib/event-triggers';
import { SHIPPED_EVENT_WORKFLOWS, eventWorkflowErrors } from '../../lambda/src/lib/event-workflow';
import { eventNaturalKey } from '../../lambda/src/lib/event-natural-key';

const channelArn = 'arn:aws:chime:us-east-1:1:app-instance/ai/channel/team-ops-team-premium';
const alarmArn = 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:api-latency';

describe('what a trigger chooses is one precise pattern', () => {
  it('an event type is its source and detail type', () => {
    expect(patternFor({ source: 'aws.ec2', detailType: 'EC2 Instance State-change Notification' }))
      .toEqual({ source: ['aws.ec2'], 'detail-type': ['EC2 Instance State-change Notification'] });
  });

  it('an ARN narrows an event type to that resource', () => {
    expect(patternFor({ source: 'aws.ec2', detailType: 'X', resourceArn: 'arn:aws:ec2:us-east-1:1:instance/i-1' }))
      .toMatchObject({ resources: ['arn:aws:ec2:us-east-1:1:instance/i-1'] });
  });

  it('an alarm\'s ARN names its own event type and matches entering ALARM only', () => {
    expect(patternFor({ resourceArn: alarmArn })).toEqual({
      source: ['aws.cloudwatch'], 'detail-type': ['CloudWatch Alarm State Change'], resources: [alarmArn], detail: { state: { value: ['ALARM'] } },
    });
  });

  it('an alarm matches entering ALARM only however it is chosen: its event type, narrowed or not, or a copied rule', () => {
    const entering = { state: { value: ['ALARM'] } };
    expect(patternFor({ source: 'aws.cloudwatch', detailType: 'CloudWatch Alarm State Change' })).toMatchObject({ detail: entering });
    expect(patternFor({ source: 'aws.cloudwatch', detailType: 'CloudWatch Alarm State Change', resourceArn: alarmArn })).toMatchObject({ resources: [alarmArn], detail: entering });
    expect(patternFromRule(JSON.stringify({ source: ['aws.cloudwatch'], 'detail-type': ['CloudWatch Alarm State Change'], detail: { alarmName: ['x'], state: { value: ['OK', 'ALARM'] } } })))
      .toEqual({ source: ['aws.cloudwatch'], 'detail-type': ['CloudWatch Alarm State Change'], detail: { alarmName: ['x'], state: { value: ['ALARM'] } } });
  });

  it('refuses another ARN alone, and anything that is not an ARN', () => {
    expect(patternFor({ resourceArn: 'arn:aws:ec2:us-east-1:1:instance/i-1' })).toHaveProperty('error');
    expect(patternFor({ resourceArn: 'api-latency' })).toHaveProperty('error');
    expect(patternFor({})).toHaveProperty('error');
  });

  it('an existing rule\'s pattern is copied, and refused unless it names an exact source and detail type', () => {
    expect(patternFromRule(JSON.stringify({ source: ['a'], 'detail-type': ['b'], detail: { x: ['y'] } }))).toEqual({ source: ['a'], 'detail-type': ['b'], detail: { x: ['y'] } });
    expect(patternFromRule(JSON.stringify({ source: ['a'] }))).toHaveProperty('error');
    expect(patternFromRule(undefined)).toHaveProperty('error');
    expect(patternFromRule('not json')).toHaveProperty('error');
  });

  it('a schema names its event type through the registry\'s extensions', () => {
    expect(eventTypeOfSchema(JSON.stringify({ 'x-amazon-events-source': 'aws.ec2', 'x-amazon-events-detail-type': 'X' }))).toEqual({ source: 'aws.ec2', detailType: 'X' });
    expect(eventTypeOfSchema('{}')).toBeUndefined();
  });
});

describe('the resources are named by convention', () => {
  it('one room per type per classification, found by its ARN', () => {
    expect(teamRoomChannelId('ops-team', 'premium')).toBe('team-ops-team-premium');
    expect(teamRoomArn('arn:aws:chime:us-east-1:1:app-instance/ai', 'ops-team', 'premium')).toBe(channelArn);
  });

  it('the same choice is the same rule, and another room or workflow is another', () => {
    const pattern = { source: ['a'], 'detail-type': ['b'] };
    const id = triggerRuleId(channelArn, 'w', pattern);
    expect(triggerRuleId(channelArn, 'w', pattern)).toBe(id);
    expect(triggerRuleId(channelArn, 'other', pattern)).not.toBe(id);
    expect(triggerRuleName('AgentEchelon-', 'premium', id)).toBe(`AgentEchelon-premium-trigger-${id}`);
    expect(id).toMatch(/^[a-f0-9]{12}$/);
  });

  it('the rule fixes the room and workflow, and reads references from the event, never its detail', () => {
    const input = triggerTargetInput({ rule: 'abc', channelArn, workflow: 'w' });
    expect(Object.values(input.InputPathsMap).join()).not.toMatch(/detail\b(?!-type)/);
    const rendered = input.InputTemplate.replace('<at>', '"t"').replace('<source>', '"s"').replace('<detailType>', '"d"').replace('<resource>', '"r"');
    expect(JSON.parse(rendered)).toEqual({ aeRuleEvent: { rule: 'abc', channelArn, workflow: 'w', at: 't', source: 's', detailType: 'd', resource: 'r' } });
  });
});

describe('a storm of events is one run', () => {
  const minute = 60_000;
  const at = (ms: number) => new Date(ms).toISOString();
  const start = EVENT_TRIGGER_WINDOW_MINUTES * minute * 1000;

  it('events in one window share a run key, and the next window is another', () => {
    const key = (ms: number) => eventNaturalKey('event-received', channelArn, undefined, undefined, undefined, undefined, { rule: 'a'.repeat(12), window: eventTriggerWindow(at(ms))! });
    expect(key(start)).toBe(key(start + minute));
    expect(key(start)).not.toBe(key(start + EVENT_TRIGGER_WINDOW_MINUTES * minute));
  });

  it('an unreadable time or rule runs nothing', () => {
    expect(eventTriggerWindow('soon')).toBeUndefined();
    expect(eventNaturalKey('event-received', channelArn)).toBeUndefined();
    expect(eventNaturalKey('event-received', channelArn, undefined, undefined, undefined, undefined, { rule: 'nope', window: 1 })).toBeUndefined();
  });
});

describe('the workflow runs in one team room\'s type and no other', () => {
  const wf = SHIPPED_EVENT_WORKFLOWS['incident-triage'];

  it('ships, opening an ops child led by the on-call', () => {
    expect(eventWorkflowErrors('incident-triage', wf)).toEqual([]);
    expect(wf.types).toEqual(['ops-team']);
    expect(wf.states.open.open).toEqual({ type: 'ops', for: { typeRole: 'on-call:ops' } });
  });

  it.each([
    ['no type', undefined, /declares the one conversation type/],
    ['two types', ['ops-team', 'general'], /declares the one conversation type/],
    ['a meeting, which the platform opens from its parent, one per meeting', ['meeting'], /a meeting's conversation/],
  ])('refuses %s', (_n, types, pattern) => {
    expect(eventWorkflowErrors('x', { ...wf, types }).join()).toMatch(pattern);
  });

  it('accepts a type that is not a team room, whose conversation receives the event through the key it watches', () => {
    expect(eventWorkflowErrors('x', { ...wf, types: ['ops'] }).join()).not.toMatch(/types/);
  });

  it('refuses a type no event reaches: not a team room type, and no opener of it watches a key', () => {
    expect(eventWorkflowErrors('x', { ...wf, types: ['general'] }).join()).toMatch(/types names general, which no event reaches/);
  });
});

describe('what may reach what', () => {
  const stack = readFileSync(resolve(__dirname, '../../lib/stacks/admin-services-stack.ts'), 'utf8');
  const profile = readFileSync(resolve(__dirname, '../../lib/stacks/assistant-profile-stack.ts'), 'utf8');
  const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const handler = router.slice(router.indexOf('export async function handleRuleEvent'), router.indexOf('DELETE THE DEADLINE SCHEDULES'));

  // The first look is an agent step, which the router dispatches without the host grounding a person's turn carries, and a
  // multi-step intent the assistant takes up as task turns. Both carry the room's watched alarm, so `read_deployment_health`
  // asks for that alarm rather than the deployment's alarms alone, and the first look reports what is actually firing.
  it('hands an agent step and a task the assistant takes up the alarm its room watches, read from the server-only row', () => {
    const helper = router.slice(router.indexOf('async function roomGroundingFields'), router.indexOf('async function roomGroundingFields') + 400);
    expect(helper).toMatch(/const row = await getChannelContext\(channelArn\)\.catch\(\(\) => null\);/);
    expect(helper).toMatch(/const name = row\?\.watchedAlarm;/);
    for (const [anchor, channel] of [['const { channelArn, botArn, variantProfile, ...eventStep } = args;', 'channelArn'], ['const handed = await invokeAsync(processorArn, {', 'task.channelArn']]) {
      const at = router.indexOf(anchor);
      expect(at).toBeGreaterThan(-1);
      expect(router.slice(at, at + 400)).toContain(`...await roomGroundingFields(${channel}),`);
    }
  });

  // AWS evaluates these two on resources a rule or schema ARN pattern never matches (the IAM policy simulator against the
  // deployed role shows it), so a "tighter" grant denies every console listing.
  it('lists event types on the registry\'s own schema path, and counts rules on the one resource ListRules takes', () => {
    expect(stack).toContain('`arn:aws:schemas:${this.region}:${this.account}:schema/${r}`,');
    expect(stack).toMatch(/sid: 'CountTriggerRules', actions: \['events:ListRules'\], resources: \['\*'\]/);
  });

  it('the admin function writes only trigger rules, targeting only a router', () => {
    expect(stack).toMatch(/sid: 'WriteOnlyTriggerRules'[\s\S]{0,160}resources: triggerRules/);
    expect(stack).toMatch(/'events:TargetArn': `[^`]*-EventTriggerRelay`/);
  });

  it('it tags only team rooms, and only with event-rule keys', () => {
    expect(stack).toMatch(/sid: 'TagOnlyEventRules'[\s\S]{0,200}channel\/team-\*[\s\S]{0,120}'aws:TagKeys': \['event-rule:\*'\]/);
  });

  it('only a rule under this classification\'s prefix, on the default bus, may invoke the relay, and the relay only this router', () => {
    expect(profile).toMatch(/eventTriggerRelay\.addPermission\('EventTriggerRules', \{\s*principal: new iam\.ServicePrincipal\('events\.amazonaws\.com'\),\s*sourceArn: `arn:aws:events:\$\{this\.region\}:\$\{this\.account\}:rule\/\$\{eventTriggerRulePrefix\(classification\)\}\*`/);
    expect(profile).not.toContain('EventTriggerBusRules');
    expect(profile).toMatch(/agentHandler\.grantInvoke\(eventTriggerRelay\)/);
    expect(profile).toMatch(/eventTriggerRulePrefix\(classification\)/);
    // A separator after the instance prefix, so a look-alike instance (`AgentEchelonTwo`) is outside the grant and the count.
    expect(stack).toContain('rule/${STACK_PREFIX}-*-trigger-*`');
    expect(stack).toContain('EVENT_TRIGGER_RULE_PREFIX: `${STACK_PREFIX}-`,');
  });

  it('the router checks the room\'s own tags before any model call', () => {
    // The room's classification and archive state by the one rule (`roomRefusal`), then its own tags for the rule and the type.
    expect(handler).toContain("const closed = roomRefusal(tags, 'room');");
    for (const refusal of ['the room does not name this rule', 'not a team room', 'the workflow runs in another type of room']) {
      expect(handler).toContain(refusal);
    }
    expect(handler.indexOf('the room does not name this rule')).toBeLessThan(handler.indexOf('runWorkflowFor'));
  });

  it('the version creates nothing: only the admin action does', () => {
    expect(router).not.toMatch(/PutRuleCommand|PutTargetsCommand/);
  });
});
