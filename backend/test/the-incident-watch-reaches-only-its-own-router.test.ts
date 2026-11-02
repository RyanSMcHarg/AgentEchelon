/**
 * THE ROUTER IS INVOKED BY ITS DECLARED SOURCES ALONE (ADR-061 "IAM this adds", the router's resource-policy row, and the
 * incident watch's rows; tenet P4).
 *
 *  - The router's resource policy admits Amazon Lex and, where this classification watches alarms, the one incident-watch
 *    rule by its own ARN, and no other principal: a principal that is not a declared source is refused invoking the
 *    router through it.
 *  - Within the classification's stack, the identities that may invoke the router are the declared ones: the router
 *    itself (a handover), the processor (an agent step's hand-back and triage), and the scheduler role (a deadline).
 *  - The incident watch's rule matches a CloudWatch alarm state change of this deployment's alarms alone, and hands the
 *    router the alarm's name and state, nothing else.
 *  - DENY: the router reads alarms of this deployment alone, by name prefix, never every alarm in the account, and a
 *    classification that watches no alarm holds no alarm read and no rule.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { assistantsOf } from './helpers/assistants';
import { CLASSIFICATION_TEST_PROPS } from './helpers/synth';
import { incidentWatchAlarmPrefixes } from '../lib/constructs/event-opened-conversations';

type Statement = { Sid?: string; Effect?: string; Action: unknown; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
type Resource = { Type: string; Properties?: Record<string, any> };
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const text = (v: unknown) => JSON.stringify(v);

const synthAssistants = (classification: string): Record<string, Resource> => {
  const app = new cdk.App();
  const stack = assistantsOf(classification)(app, `AgentEchelonAssistants-${classification}`, CLASSIFICATION_TEST_PROPS as never);
  return (Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> }).Resources;
};

/** Every policy statement in a stack, with the roles (logical ids) it is attached to. */
function statementsWithRoles(resources: Record<string, Resource>): Array<{ roles: string[]; statement: Statement }> {
  const out: Array<{ roles: string[]; statement: Statement }> = [];
  for (const [id, r] of Object.entries(resources)) {
    if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') {
      const roles = list(r.Properties?.Roles ?? []).map((x) => text(x).match(/"Ref":"([^"]+)"/)?.[1] ?? text(x));
      for (const st of r.Properties?.PolicyDocument?.Statement ?? []) out.push({ roles, statement: st });
    } else if (r.Type === 'AWS::IAM::Role') {
      for (const pol of r.Properties?.Policies ?? []) for (const st of pol.PolicyDocument.Statement) out.push({ roles: [id], statement: st });
    }
  }
  return out;
}

describe('the router is invoked by its declared sources alone (deny tests)', () => {
  const premium = synthAssistants('premium');
  const standard = synthAssistants('standard');
  const routerOf = (r: Record<string, Resource>) => Object.keys(r).find((id) => r[id].Type === 'AWS::Lambda::Function' && /^AgentHandler[0-9A-F]{8}$/.test(id))!;
  const ruleOf = (r: Record<string, Resource>) => Object.keys(r).find((id) => r[id].Type === 'AWS::Events::Rule' && /^IncidentWatchAlarmChanges/.test(id));
  const permissionsOf = (r: Record<string, Resource>) => Object.values(r)
    .filter((x) => x.Type === 'AWS::Lambda::Permission' && text(x.Properties?.FunctionName).includes(routerOf(r)));

  it('DENY: the router\'s resource policy admits Amazon Lex and the incident-watch rule by its ARN, and nothing else', () => {
    for (const r of [premium, standard]) {
      const rule = ruleOf(r);
      for (const p of permissionsOf(r)) {
        const principal = String(p.Properties!.Principal);
        expect(principal).not.toBe('*');
        expect(['lexv2.amazonaws.com', 'lex.amazonaws.com', 'events.amazonaws.com']).toContain(principal);
        if (principal === 'events.amazonaws.com') {
          // Only the incident watch's rule, by its own ARN: no other rule, bus or account reaches the router this way.
          expect(rule).toBeDefined();
          expect(p.Properties!.SourceArn).toEqual({ 'Fn::GetAtt': [rule, 'Arn'] });
        } else {
          expect(p.Properties!.SourceArn ?? p.Properties!.SourceAccount).toBeDefined();
        }
      }
    }
    expect(permissionsOf(premium).filter((p) => p.Properties!.Principal === 'events.amazonaws.com')).toHaveLength(1);
    expect(permissionsOf(standard).filter((p) => p.Properties!.Principal === 'events.amazonaws.com')).toHaveLength(0);
  });

  it('DENY: within its stack, only the router itself, the processor and the scheduler role may invoke the router', () => {
    for (const r of [premium, standard]) {
      const router = routerOf(r);
      const invokers = new Set<string>();
      for (const { roles, statement } of statementsWithRoles(r)) {
        if (statement.Effect === 'Deny') continue;
        if (!list(statement.Action).some((a) => /^lambda:Invoke/.test(String(a)))) continue;
        if (!text(statement.Resource).includes(router)) continue;
        for (const role of roles) invokers.add(role.replace(/[0-9A-F]{8}$/, ''));
      }
      for (const role of invokers) expect(role).toMatch(/^(AgentHandlerRole|ProcessorRole|AsyncProcessorRole|EventDeadlineSchedulerRole)/);
    }
  });

  it('the incident watch\'s rule matches this deployment\'s alarm changes and hands the router their name and state alone', () => {
    const rule = premium[ruleOf(premium)!].Properties!;
    expect(rule.EventPattern).toEqual({
      source: ['aws.cloudwatch'], 'detail-type': ['CloudWatch Alarm State Change'],
      detail: { alarmName: incidentWatchAlarmPrefixes().map((prefix) => ({ prefix })) },
    });
    expect(rule.EventBusName).toBeUndefined();
    expect(rule.Targets).toHaveLength(1);
    expect(text(rule.Targets[0].Arn)).toContain(routerOf(premium));
    const transformer = rule.Targets[0].InputTransformer;
    expect(Object.keys(transformer.InputPathsMap).sort()).toEqual(['detail-alarmName', 'detail-state-value']);
    expect(JSON.parse(transformer.InputTemplate.replace(/"?<(detail-alarmName|detail-state-value)>"?/g, '"x"'))).toEqual({ aeAlarm: { alarmName: 'x', state: 'x' } });
  });

  it('DENY: the router reads this deployment\'s alarms alone, by name, and a classification that watches none reads none', () => {
    const routerReads = (r: Record<string, Resource>) => statementsWithRoles(r)
      .filter(({ roles, statement }) => roles.some((role) => /^AgentHandlerRole/.test(role)) && list(statement.Action).some((a) => String(a).startsWith('cloudwatch:Describe')));
    const reads = routerReads(premium);
    expect(reads).toHaveLength(1);
    expect(list(reads[0].statement.Action)).toEqual(['cloudwatch:DescribeAlarms']);
    const resources = list(reads[0].statement.Resource).map(text);
    expect(resources).toHaveLength(incidentWatchAlarmPrefixes().length);
    for (const res of resources) {
      expect(res).toMatch(/:alarm:[^*]+\*/);
      expect(res).not.toMatch(/:alarm:\*/);
    }
    expect(routerReads(standard)).toHaveLength(0);
    expect(ruleOf(standard)).toBeUndefined();
  });
});
