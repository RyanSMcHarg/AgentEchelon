/**
 * ONE GRANT PER FUNCTION (SPEC-ADMIN-CONSOLE FR46).
 *
 * A handler trusts an IAM-signed caller only because the resource the gateway admitted them to
 * authorizes one capability and nothing else. Two capabilities sharing a route would make a grant of
 * either a grant of both, and the gateway could no longer tell them apart. So no route - a method on a
 * path on an API, team routes included - may appear under two capabilities.
 */
import { ADMIN_CAPABILITIES } from '../lib/config/admin-capabilities';

describe('the capability catalog', () => {
  it('names every route under exactly one capability', () => {
    const owner = new Map<string, string>();
    const shared: string[] = [];
    for (const cap of Object.values(ADMIN_CAPABILITIES)) {
      for (const r of [...cap.resources, ...(cap.teamResources ?? [])]) {
        const key = `${r.api} ${r.method} /${r.path}`;
        const prior = owner.get(key);
        if (prior && prior !== cap.key) shared.push(`${key}: ${prior} and ${cap.key}`);
        owner.set(key, cap.key);
      }
    }
    expect(owner.size).toBeGreaterThan(40);
    expect(shared).toEqual([]);
  });
});

describe('who holds the administration identity', () => {
  const { needsAdministrationIdentity, rolesNeedingAdministrationIdentity } = jest.requireActual('../lib/config/admin-capabilities') as typeof import('../lib/config/admin-capabilities');

  it('is decided by the capabilities that act in the Amazon Chime SDK, not by a group name', () => {
    for (const key of ['view-live-members', 'redact', 'delete', 'manage-membership', 'delete-conversation']) {
      expect(needsAdministrationIdentity(ADMIN_CAPABILITIES[key])).toBe(true);
    }
    for (const key of ['view-messages', 'attachment-read', 'view-analytics', 'archive-conversation']) {
      expect(needsAdministrationIdentity(ADMIN_CAPABILITIES[key])).toBe(false);
    }
  });

  it('is the admins role today, and never a team member', () => {
    expect(rolesNeedingAdministrationIdentity()).toEqual(['admins']);
  });
});
