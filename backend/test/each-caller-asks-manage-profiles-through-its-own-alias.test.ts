/**
 * EACH CALLER ASKS `manage-profiles` THROUGH ITS OWN ALIAS, AND IAM GRANTS IT THAT ALIAS ALONE (tenet D3).
 *
 * `manage-profiles` serves a direct operation only through the alias of the caller that asks for it
 * (`profile-direct-callers.ts`; the handler's half is in manage-profiles.test.ts). This is the IAM half: each alias
 * exists, `manage-assistants` may invoke `assistant-builds` and nothing else of the function, `admin-experiments`
 * may invoke `experiments` and nothing else, and no role may invoke the function unqualified or through any
 * qualifier, so a caller cannot reach an operation its alias does not serve.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { adminServicesStacks } from './helpers/synth';
import { PROFILE_DIRECT_CALLERS } from '../lambda/src/lib/profile-direct-callers';

type Statement = { Effect?: string; Action: string | string[]; Resource: unknown };
const list = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

const nested = (context: Record<string, unknown>) =>
  Template.fromStack(adminServicesStacks(context).adminServices.node.findChild('AssistantAdministration') as cdk.Stack);

/** Every Allow statement in the template, by the role logical id it is attached to. */
function grantsByRole(t: Template): Array<[string, Statement]> {
  const out: Array<[string, Statement]> = [];
  for (const [id, role] of Object.entries(t.findResources('AWS::IAM::Role')) as Array<[string, any]>) {
    for (const p of role.Properties.Policies ?? []) for (const s of p.PolicyDocument.Statement) out.push([id, s]);
  }
  for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as any[]) {
    for (const r of p.Properties.Roles ?? []) for (const s of p.Properties.PolicyDocument.Statement) out.push([JSON.stringify(r), s]);
  }
  return out.filter(([, s]) => s.Effect !== 'Deny');
}

// The console's deep links read a classification's processor, router and vend configuration; the read is bounded
// by the tags those functions carry (this instance, a classification), so no other function's environment is reachable.
describe('the profile writer reads only classification functions\' configuration', () => {
  it('conditions GetFunctionConfiguration on this instance and a classification tag', () => {
    const reads = grantsByRole(nested({})).filter(([, s]) => list(s.Action).includes('lambda:GetFunctionConfiguration'));
    expect(reads.length).toBeGreaterThan(0);
    for (const [, s] of reads) {
      const c = (s as Statement & { Condition?: Record<string, Record<string, unknown>> }).Condition ?? {};
      expect(Object.keys(c.StringEquals ?? {}).some((k) => k.startsWith('aws:ResourceTag/'))).toBe(true);
      expect(c.Null?.['aws:ResourceTag/classification']).toBe('false');
    }
  });
});

describe.each([
  ['with experiments', {}, ['assistant-builds', 'experiments']],
  ['without experiments', { noExperiments: true }, ['assistant-builds']],
])('manage-profiles direct callers, %s', (_label, context, aliases) => {
  const t = nested(context);
  const aliasIds = Object.fromEntries((Object.entries(t.findResources('AWS::Lambda::Alias')) as Array<[string, any]>)
    .map(([id, a]) => [a.Properties.Name as string, id]));
  const invokes = grantsByRole(t).filter(([, s]) => list(s.Action).some((a) => a === 'lambda:InvokeFunction' || a === 'lambda:*' || a === '*'));

  it('has one alias per caller, and no other', () => {
    expect(Object.keys(aliasIds).sort()).toEqual([...aliases].sort());
    for (const a of aliases) expect(Object.keys(PROFILE_DIRECT_CALLERS)).toContain(a);
  });

  it('grants no role an invoke of the function itself, unqualified or through any qualifier', () => {
    for (const [role, s] of invokes) {
      expect([role, JSON.stringify(s.Resource).includes('ManageProfilesFunction')]).toEqual([role, false]);
    }
  });

  it.each([
    ['assistant-builds', /ManageAssistantsRole/],
    ['experiments', /AdminExperiments/],
  ])('grants the %s alias to its caller alone', (alias, caller) => {
    if (!aliases.includes(alias)) return;
    const reaching = invokes.filter(([, s]) => JSON.stringify(s.Resource).includes(aliasIds[alias]));
    expect(reaching.length).toBeGreaterThan(0);
    for (const [role, s] of reaching) {
      expect(role).toMatch(caller);
      // The alias and nothing else in the same statement.
      expect(list(s.Resource)).toEqual([{ Ref: aliasIds[alias] }]);
    }
    // And the caller is told the alias, not the function.
    const fns = Object.values(t.findResources('AWS::Lambda::Function')) as any[];
    const told = fns.filter((f) => JSON.stringify(f.Properties.Role).match(caller));
    expect(told.length).toBeGreaterThan(0);
    for (const f of told) expect(f.Properties.Environment.Variables.MANAGE_PROFILES_FUNCTION_NAME).toEqual({ Ref: aliasIds[alias] });
  });
});
