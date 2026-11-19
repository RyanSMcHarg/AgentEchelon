/**
 * OFFBOARDING ERASES A PERSON AND THEIR TWIN, AND NEVER THE SERVICE ADMIN (tenet D3).
 *
 * The offboarding role deletes AppInstanceUsers and drops app-instance-admin elevations, which it needs for any
 * person and their `<personId>-admin` twin. The service admin is no person: every membership cleanup and every
 * bearer-held erasure acts through it, so IAM refuses its deletion and the removal of its elevation by an explicit
 * Deny, whatever id an erasure resolves to. The delete itself names the AppInstanceUser alone.
 */
import { identityTemplate } from './helpers/synth';

type Statement = { Sid?: string; Effect?: string; Action: string | string[]; Resource: unknown };
const list = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

describe('the offboarding role and the service admin', () => {
  const t = identityTemplate({});
  const [, role] = (Object.entries(t.findResources('AWS::IAM::Role')) as Array<[string, any]>)
    .find(([id]) => id.startsWith('OffboardingRole'))!;
  const statements: Statement[] = (role.Properties.Policies as any[]).flatMap((p) => p.PolicyDocument.Statement);
  const SERVICE_ADMIN = /\/user\/agent-echelon-admin"/;

  it('denies deleting the service admin and dropping its elevation', () => {
    const denies = statements.filter((s) => s.Effect === 'Deny' && SERVICE_ADMIN.test(JSON.stringify(s.Resource)));
    const denied = denies.flatMap((s) => list(s.Action));
    expect(denied).toEqual(expect.arrayContaining(['chime:DeleteAppInstanceUser', 'chime:DeleteAppInstanceAdmin']));
  });

  it('still deletes any person and their twin, by the AppInstanceUser alone', () => {
    const deleting = statements.filter((s) => s.Effect !== 'Deny' && list(s.Action).includes('chime:DeleteAppInstanceUser'));
    expect(deleting).toHaveLength(1);
    expect(list(deleting[0].Action)).toEqual(['chime:DeleteAppInstanceUser']);
    const resources = list(deleting[0].Resource).map((r) => JSON.stringify(r));
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatch(/\/user\/\*"/);
  });
});
