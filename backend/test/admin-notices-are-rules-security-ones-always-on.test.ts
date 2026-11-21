/**
 * THE ADMIN NOTICES ARE ONE RULE PER TYPE, AND THE SECURITY ONES ARE ALWAYS ON (DESIGN-EVENT-TARGETS section 12), proven on the
 * synthesized AdminServices template: each catalogued type has its rule to the poster, a security notice's rule is enabled with
 * no switch, an operational one reads its state at deploy, and the trigger service's role can switch only the operational ones
 * and can still target only a relay.
 */
import { adminServicesTemplate } from './helpers/synth';
import { ADMIN_NOTICE_TYPES, BOUNDARY_REFUSAL_ALARM_SUFFIX } from '../lambda/src/lib/admin-notice-types';

type Statement = { Sid?: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
const actions = (s: Statement) => ([] as string[]).concat(s.Action);
const flat = (v: unknown): string => JSON.stringify(v);

describe('the admin notices, on the AdminServices template', () => {
  const t = adminServicesTemplate();
  const rules = Object.values(t.findResources('AWS::Events::Rule')) as Array<{ Properties: { Name?: unknown; State?: unknown; EventPattern: any } }>;
  const noticeRules = rules.filter((r) => (r.Properties.EventPattern?.source ?? []).includes('ae.alert'));

  it('has one rule per catalogued type, and no rule that takes every alert', () => {
    expect(noticeRules).toHaveLength(ADMIN_NOTICE_TYPES.length);
    expect(noticeRules.every((r) => Array.isArray(r.Properties.EventPattern['detail-type']))).toBe(true);
    const named = noticeRules.map((r) => flat(r.Properties.Name));
    for (const n of ADMIN_NOTICE_TYPES) expect(named.some((x) => x.includes(`admin-notice-${n.key}`))).toBe(true);
  });

  it('keeps a security notice enabled with no switch, and reads an operational notice\'s state at deploy', () => {
    for (const n of ADMIN_NOTICE_TYPES) {
      const rule = noticeRules.find((r) => flat(r.Properties.Name).includes(`admin-notice-${n.key}"`) || flat(r.Properties.Name).endsWith(`admin-notice-${n.key}`))!;
      expect(rule).toBeDefined();
      if (n.security) expect(rule.Properties.State).toBe('ENABLED');
      else expect(flat(rule.Properties.State)).toContain(`{{resolve:ssm:`);
    }
  });

  it('routes the boundary refusal alarm to its own rule, and every other alarm to the operational one', () => {
    const alarmRules = noticeRules.filter((r) => r.Properties.EventPattern['detail-type'].includes('cloudwatch_alarm'));
    expect(alarmRules).toHaveLength(2);
    expect(alarmRules.map((r) => flat(r.Properties.EventPattern.detail.notice.extra.alarmName)).sort())
      .toEqual([flat([{ 'anything-but': { suffix: BOUNDARY_REFUSAL_ALARM_SUFFIX } }]), flat([{ suffix: BOUNDARY_REFUSAL_ALARM_SUFFIX }])].sort());
  });

  it('DENY: the trigger service can switch no security notice, change no notice rule, and target nothing but a relay', () => {
    const policies = Object.values(t.findResources('AWS::IAM::Policy')) as Array<{ Properties: { PolicyDocument: { Statement: Statement[] } } }>;
    const all = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    const switching = all.filter((s) => s.Sid === 'SwitchOperationalNotices');
    expect(switching).toHaveLength(1);
    const switched = flat(switching[0].Resource);
    for (const n of ADMIN_NOTICE_TYPES) {
      if (n.security) expect(switched).not.toContain(`admin-notice-${n.key}`);
      else expect(switched).toContain(`admin-notice-${n.key}`);
    }
    // No statement anywhere lets a principal rewrite, retarget or delete a notice rule.
    const writes = all.filter((s) => actions(s).some((a) => ['events:PutRule', 'events:PutTargets', 'events:DeleteRule', 'events:RemoveTargets'].includes(a)));
    expect(writes.filter((s) => flat(s.Resource).includes('admin-notice'))).toEqual([]);
    const relay = all.filter((s) => s.Sid === 'TargetOnlyARelay');
    expect(relay).toHaveLength(1);
    expect(flat(relay[0].Condition)).toContain('-EventTriggerRelay');
  });
});
