/**
 * A TURN RUNS ON THE ASSISTANT'S SESSION, NOT ON THE PROCESSOR'S ROLE (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
 *
 * The processor's own role is bootstrap only: it writes logs and asks the vend for a session. Every
 * call a turn makes goes out on the session, so everything a turn needs is granted to the acting role.
 *
 * Two omissions fail silently and are what this pins:
 *   - a grant left on the processor role, which would let a turn act without being anyone;
 *   - a grant on the acting role that the classification boundary does not allow, which IAM would deny
 *     at runtime while the policy reads correctly in review.
 */
import { assistantRolePath } from '../lib/stacks/agent-classification-common';
import { basicClassificationTemplate } from './helpers/synth';


type Resources = Record<string, { Type: string; Properties?: Record<string, any> }>;

function synth(): Resources {
  return (basicClassificationTemplate().toJSON() as { Resources: Resources }).Resources;
}

const asList = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : x === undefined ? [] : [String(x)]);

/** Every Allow statement attached to a role, from inline policies, AWS::IAM::Policy and managed policies. */
function statementsFor(resources: Resources, roleId: string): any[] {
  const out: any[] = [];
  const role = resources[roleId];
  for (const p of role.Properties?.Policies ?? []) out.push(...p.PolicyDocument.Statement);
  for (const r of Object.values(resources)) {
    const attached = JSON.stringify(r.Properties?.Roles ?? []);
    if ((r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') && attached.includes(`"${roleId}"`)) {
      out.push(...r.Properties!.PolicyDocument.Statement);
    }
  }
  return out;
}

function actionAllowed(action: string, allow: string[]): boolean {
  return allow.some((a) => {
    if (a === '*' || a === action) return true;
    if (!a.includes('*')) return false;
    return new RegExp('^' + a.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(action);
  });
}

describe('a turn runs on the assistant, not the processor', () => {
  const resources = synth();
  const roleIds = Object.keys(resources).filter((k) => resources[k].Type === 'AWS::IAM::Role');
  const processorId = roleIds.find((k) => k.startsWith('ProcessorRole'))!;
  const actingId = roleIds.find((k) => resources[k].Properties?.Path === assistantRolePath())!;

  it('finds both roles (a scan that finds neither passes vacuously)', () => {
    expect(processorId).toBeDefined();
    expect(actingId).toBeDefined();
  });

  it('leaves the processor role able to ask the vend, raise an admin alert, write its own records, and nothing a turn does', () => {
    const allows = statementsFor(resources, processorId).filter((s) => s.Effect === 'Allow');
    // Logs come from the AWS managed basic-execution policy, which is not in these statements. The
    // failure destination's invoke is added by the async-invoke configuration. The admin alert is a
    // platform action raised as an ae.alert event, so the role sends no message. The processor's own
    // records (abuse counters and their circuit, the turn lock and queue) are written on this role, never
    // on a session.
    const actions = [...new Set(allows.flatMap((s) => asList(s.Action)))].sort();
    expect(actions).toEqual([
      'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'events:PutEvents',
      'lambda:InvokeFunction', 'ssm:GetParameter', 'ssm:PutParameter',
    ]);
    // The event is for the ae.alert source only.
    for (const st of allows.filter((x) => asList(x.Action).includes('events:PutEvents'))) {
      expect(st.Condition.StringEquals['events:source']).toEqual(['ae.alert']);
    }
    // ...and those writes reach only the processor's own records.
    for (const st of allows.filter((x) => asList(x.Action).some((a) => a.startsWith('dynamodb:')))) {
      expect(JSON.stringify(st.Resource)).toMatch(/sharedtables(abusecontrols|turnstate)arn/);
    }
    for (const st of allows.filter((x) => asList(x.Action).includes('ssm:PutParameter'))) {
      expect(st.Resource).toBe('arn:aws:ssm:us-east-1:123456789012:parameter/agent-echelon/abuse/circuit');
    }
    // ...and it bears no bot at all.
    expect(allows.filter((x) => JSON.stringify(x.Resource).includes('/bot/'))).toEqual([]);
  });

  it('gives the acting role no bearer but the session\'s own bot', () => {
    const bearers = statementsFor(resources, actingId)
      .filter((s) => s.Effect === 'Allow' && JSON.stringify(s.Resource).includes('/bot/'));
    expect(bearers.length).toBeGreaterThan(0);
    for (const s of bearers) expect(JSON.stringify(s.Resource)).toContain('aws:PrincipalTag/bot');
  });

  it('allows, in the boundary, every action a turn is granted', () => {
    const boundaryRef = JSON.stringify(resources[actingId].Properties?.PermissionsBoundary);
    const boundaryId = Object.keys(resources).find((k) => boundaryRef.includes(`"${k}"`))!;
    const bounded = resources[boundaryId].Properties!.PolicyDocument.Statement
      .filter((s: any) => s.Effect === 'Allow')
      .flatMap((s: any) => asList(s.Action));
    const granted = statementsFor(resources, actingId)
      .filter((s) => s.Effect === 'Allow')
      .flatMap((s) => asList(s.Action));
    expect(granted.length).toBeGreaterThan(10);
    const outside = [...new Set(granted)].filter((a) => !actionAllowed(a, bounded));
    expect(outside).toEqual([]);
  });

  it('grants the turn its models and its task service on the acting role, and none of the processor records', () => {
    const json = JSON.stringify(statementsFor(resources, actingId));
    expect(json).toContain('bedrock:InvokeModel');
    expect(json).toContain('bedrock:ApplyGuardrail');
    expect(json).toContain('lambda:InvokeFunction');
    expect(json).not.toMatch(/sharedtables(abusecontrols|turnstate)arn/);
  });
});
