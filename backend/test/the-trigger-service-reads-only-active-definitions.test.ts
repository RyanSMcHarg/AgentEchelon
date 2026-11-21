/**
 * THE TRIGGER SERVICE READS ONLY ACTIVE DEFINITIONS (DESIGN-PROCESSES section 4.2; tenet D12), synthesized.
 *
 * What it proves: the trigger function's role gains one statement for the declared hand-offs, `ssm:GetParameter` on the
 * `assistant/*\/definition` parameters, and holds no other SSM read beyond the event policy's parameter and the operational
 * notices' state: no path read, no history, no draft, no KMS decrypt and no read of a definition's bodies. The function reads the
 * active label only and takes the `processes` key alone.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { adminServicesOnLiteralsTemplate } from './helpers/synth';

const flat = (v: unknown): string => JSON.stringify(v);
const list = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : flat(x)));

describe('the trigger function\'s SSM reach', () => {
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

  it('one statement reads the definitions: GetParameter on assistant/*/definition and nothing wider', () => {
    const read = statements.filter((s) => s.Sid === 'ReadActiveDefinitions');
    expect(read).toHaveLength(1);
    expect(list(read[0].Action)).toEqual(['ssm:GetParameter']);
    expect(list(read[0].Resource)).toHaveLength(1);
    expect(list(read[0].Resource).join(' ')).toMatch(/parameter\/[^"]*\/assistant\/\*\/definition"?/);
  });

  it('DENY: no other SSM read than the event policy\'s and the notices\' state, and no path, history, draft, KMS or body read', () => {
    const ssm = statements.filter((s) => list(s.Action).some((a) => a.startsWith('ssm:')));
    expect(ssm.map((s) => s.Sid).sort()).toEqual(['ReadActiveDefinitions', 'ReadAndWriteTheEventPolicy', 'RecordOperationalNoticeState']);
    const actions = statements.flatMap((s) => list(s.Action));
    for (const forbidden of ['ssm:GetParametersByPath', 'ssm:GetParameterHistory', 'ssm:GetParameters', 'ssm:*', 'kms:Decrypt', 's3:GetObject']) expect(actions).not.toContain(forbidden);
    expect(statements.flatMap((s) => list(s.Resource)).join(' ')).not.toMatch(/\/draft/);
    // The definition read is GetParameter only: never a write.
    expect(list(ssm.find((s) => s.Sid === 'ReadActiveDefinitions')!.Action)).not.toContain('ssm:PutParameter');
  });

  it('reads the active label, and keeps the processes key only', () => {
    const src = readFileSync(resolve(__dirname, '../lambda/src/event-triggers-api.ts'), 'utf8');
    const fn = src.slice(src.indexOf('async function activeProcessesOf('), src.indexOf('function typedFields('));
    expect(fn).toMatch(/Name: `\$\{definitionParamName\(process\.env\.SSM_ROOT \?\? '', assistant\)\}:active`/);
    expect(fn).toMatch(/\)\.processes;/);
    expect(fn).not.toMatch(/draft|GetParametersByPath|GetParameterHistory/);
  });
});
