/**
 * NO PROCESS HAND-OFF GRANT IS HELD (SPEC-PROCESSES P4 to P7 are designed and not built; DESIGN-PROCESSES O22), synthesized.
 *
 * What it proves: with the cross-classification hand-off removed until it is needed, the router's role holds no
 * `events:PutEvents` on an `ae.process.*` source, and the trigger function's role holds no read of the assistants' active
 * definitions: its only SSM reach is the event policy's parameter. The router's read of its own assistants' `owner-team` tag
 * (O16) stays.
 */
import { adminServicesOnLiteralsTemplate, basicClassificationTemplate } from './helpers/synth';

const flat = (v: unknown): string => JSON.stringify(v);
const list = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : flat(x)));
const statementsOf = (t: ReturnType<typeof basicClassificationTemplate>) =>
  Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);

describe('the router holds no process put', () => {
  const statements = statementsOf(basicClassificationTemplate());

  it('DENY: no PutEvents on an ae.process source, and no statement of that name', () => {
    expect(statements.some((s) => s.Sid === 'PutOnlyItsOwnProcessSource')).toBe(false);
    expect(flat(statements)).not.toMatch(/ae\.process\./);
  });

  it('keeps the read of its own assistants\' owner-team tag', () => {
    expect(statements.some((s) => s.Sid === 'ReadItsOwnAssistantsOwnerTeam')).toBe(true);
  });
});

describe('the trigger function reads no definition', () => {
  const t = adminServicesOnLiteralsTemplate();
  const fns = t.findResources('AWS::Lambda::Function');
  const fnId = Object.keys(fns).find((id) => /EventTriggersFn/.test(id))!;
  const roleRef = flat(fns[fnId].Properties.Role);
  const statements = Object.values(t.findResources('AWS::IAM::Policy'))
    .filter((p: any) => (p.Properties.Roles ?? []).some((r: unknown) => roleRef.includes(flat(r).replace(/^\{"Ref":"|"\}$/g, ''))))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement as any[]);

  it('is found', () => {
    expect(fnId).toBeDefined();
    expect(statements.length).toBeGreaterThan(0);
  });

  it('DENY: its only SSM statement is the event policy\'s, and nothing reads an assistant definition', () => {
    const ssm = statements.filter((s) => list(s.Action).some((a) => a.startsWith('ssm:')));
    expect(ssm.map((s) => s.Sid)).toEqual(['ReadAndWriteTheEventPolicy']);
    expect(statements.some((s) => s.Sid === 'ReadActiveDefinitions')).toBe(false);
    expect(statements.flatMap((s) => list(s.Resource)).join(' ')).not.toMatch(/assistant\/\*\/definition/);
    expect(flat(fns[fnId].Properties.Environment?.Variables ?? {})).not.toMatch(/"SSM_ROOT"/);
  });
});
