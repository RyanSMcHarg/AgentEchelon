/**
 * A CONSOLE GRANT REACHES THE ROUTES ITS CAPABILITIES NAME AND NO SIBLING BENEATH THEM (`routesReachedBeyondHeld`).
 *
 * A path parameter is granted as `*`, which IAM matches across `/`, so a grant on `GET admin/meetings/{meetingId}`
 * (`view-meeting-analytics`) also matches `GET admin/meetings/{meetingId}/transcript` (`view-events`, conversation
 * content). A role holding the figures and not the content is denied the transcript route by name.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Template } from 'aws-cdk-lib/assertions';
import { ADMIN_CAPABILITIES, declaredExecuteApiResources, routesReachedBeyond } from '../../lib/config/admin-capabilities';
import { grantAdminRolesOnApi } from '../../lib/constructs/admin-role-grants';

const resourcesOf = (key: string) => ADMIN_CAPABILITIES[key].resources
  .filter((r) => r.api === 'admin-conversations').map((r) => ({ method: r.method, path: `/${r.path}` }));

describe('a console grant reaches no sibling route', () => {
  it("DENY: the meeting figures' grant names the transcript route as one it would reach and does not hold", () => {
    const beyond = routesReachedBeyond(resourcesOf('view-meeting-analytics'), declaredExecuteApiResources('admin-conversations'));
    expect(beyond).toContainEqual({ method: 'GET', path: '/admin/meetings/{meetingId}/transcript' });
    // A different method is a different resource: the end route is not reached by a GET grant.
    expect(beyond).not.toContainEqual(expect.objectContaining({ path: '/admin/meetings/{meetingId}/end' }));
  });

  it('names nothing a grant holds itself, so a role holding both the figures and the content keeps both', () => {
    const both = [...resourcesOf('view-meeting-analytics'), ...resourcesOf('view-events')];
    const beyond = routesReachedBeyond(both, declaredExecuteApiResources('admin-conversations'));
    expect(beyond).not.toContainEqual(expect.objectContaining({ path: '/admin/meetings/{meetingId}/transcript' }));
  });

  it('each console role is granted what it holds, and denied by name whatever a wildcard reaches beyond it', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Grants');
    const roles = {
      admins: new iam.Role(stack, 'Admins', { assumedBy: new iam.AccountRootPrincipal() }),
      'team-members': new iam.Role(stack, 'Team', { assumedBy: new iam.AccountRootPrincipal() }),
    };
    const arns: string[] = [];
    grantAdminRolesOnApi(stack, { arnFor: (m: string, p: string) => { const a = `arn:${m}${p.replace(/\{[^}]+\}/g, '*')}`; arns.push(a); return a; } } as never, roles);
    const policies = Template.fromStack(stack).findResources('AWS::IAM::ManagedPolicy');
    const statements = Object.values(policies).flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Array<{ Effect: string; Resource: unknown }> } } }).Properties.PolicyDocument.Statement);
    const allowed = statements.filter((s) => s.Effect === 'Allow').flatMap((s) => [s.Resource].flat() as string[]);
    const denied = statements.filter((s) => s.Effect === 'Deny').flatMap((s) => [s.Resource].flat() as string[]);
    // No role is denied a route it is also granted in the same policy.
    for (const d of denied) expect(allowed.filter((a) => a === d)).toEqual([]);
    expect(allowed.length).toBeGreaterThan(0);
  });
});
