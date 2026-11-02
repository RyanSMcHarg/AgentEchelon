/**
 * THE SAMPLE TEAM (SPEC-ADMIN-CONSOLE "Admin and team-member groups"): the ops team owns the Ops assistant.
 *
 * The console role for people who own an assistant is shown through one sample: the sample deployment
 * declares the premium ops assistant (`ops-premium`), its profile declares `ownerTeam: 'ops'`, which the
 * ownership function seeds onto its identity as the `owner-team` tag when it is provisioned, and the test
 * users include a member of `team-ops` and a team member in no team. If any of the three drifts, the
 * sample stops showing what a team member sees.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveDeploymentProfiles } from '../lib/config/profiles';

const BACKEND_DIR = path.join(__dirname, '..');
const example = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'deploy.config.example.json'), 'utf8'));
const provision = fs.readFileSync(path.join(BACKEND_DIR, 'scripts', 'provision-test-users.mjs'), 'utf8');

describe('the sample deployment carries a team that owns an assistant', () => {
  const config = resolveDeploymentProfiles(example.profiles);

  it('deploys the Ops assistant', () => {
    expect(example.profiles).toContain('ops-premium');
    expect(config.profiles.map((p) => p.name)).toContain('ops-premium');
    expect(config.classifications.find((c) => c.value === 'premium')?.roles).toContain('ops');
  });

  it('declares the ops team as its owner, which the ownership function seeds at provisioning', () => {
    expect(config.profiles.find((p) => p.name === 'ops-premium')?.ownerTeam).toBe('ops');
  });

  it('provisions a member of the ops team and a team member in no team', () => {
    expect(provision).toMatch(/testuser-team-ops@\$\{EMAIL_DOMAIN\}[^\n]*groups: \['premium', 'team-members', 'team-ops'\]/);
    expect(provision).toMatch(/testuser-team-none@\$\{EMAIL_DOMAIN\}[^\n]*groups: \['premium', 'team-members'\]/);
  });
});
