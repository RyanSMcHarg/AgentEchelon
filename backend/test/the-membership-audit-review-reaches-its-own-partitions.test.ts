/**
 * THE MEMBERSHIP-AUDIT REVIEW SURFACE REACHES THE AUDIT TABLE'S TWO PARTITIONS IT SERVES, AND NO OTHER.
 *
 * `membership-audit-admin` lists, reads and marks findings (`pk = finding`) and reads and sets the enforce toggle
 * (`pk = config`). Its role holds exactly those actions, each bounded by `dynamodb:LeadingKeys` to its partition:
 * a toggle is never written through the findings grant, a finding never put whole, and nothing is deleted or scanned.
 */
import { auroraAppTemplates } from './helpers/synth';

type Statement = { Sid?: string; Effect?: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
const list = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

describe('the membership-audit review surface', () => {
  const templates = auroraAppTemplates();
  const [, t] = Object.entries(templates).find(([, tpl]) =>
    Object.keys(tpl.findResources('AWS::Lambda::Function')).some((id) => id.startsWith('MembershipAuditAdminFn')))!;
  const [, fn] = Object.entries(t.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith('MembershipAuditAdminFn'))!;
  const roleId = (fn.Properties.Role as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0];
  const statements: Statement[] = (Object.values(t.findResources('AWS::IAM::Policy')) as any[])
    .filter((p) => JSON.stringify(p.Properties.Roles).includes(roleId))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
  const onDynamo = statements.filter((s) => s.Effect !== 'Deny' && list(s.Action).some((a) => a.startsWith('dynamodb:')));

  it('holds each DynamoDB action under the one partition it serves', () => {
    const byPartition = new Map<string, string[]>();
    for (const s of onDynamo) {
      const keys = s.Condition?.['ForAllValues:StringEquals']?.['dynamodb:LeadingKeys'];
      expect(Array.isArray(keys) && keys.length === 1).toBe(true);
      const pk = (keys as string[])[0];
      byPartition.set(pk, [...(byPartition.get(pk) ?? []), ...list(s.Action)].sort());
    }
    expect(Object.fromEntries(byPartition)).toEqual({
      finding: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
      config: ['dynamodb:GetItem', 'dynamodb:PutItem'],
    });
  });

  it('never deletes, scans or batch-writes the audit table', () => {
    const actions = onDynamo.flatMap((s) => list(s.Action));
    for (const a of ['dynamodb:DeleteItem', 'dynamodb:Scan', 'dynamodb:BatchWriteItem', 'dynamodb:BatchGetItem', 'dynamodb:*']) {
      expect([a, actions.includes(a)]).toEqual([a, false]);
    }
  });
});
