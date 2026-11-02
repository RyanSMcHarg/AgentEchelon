import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ProfilesTab from './ProfilesTab';
import * as svc from '../../services/profileService';
import { CapabilityTestProvider } from '../../capabilities';
import { canActivateVersion } from './ProfileVersionProvenance';

/**
 * A VERSION SAYS WHERE IT CAME FROM (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5, §3.6).
 *
 * `listProfile` returns `derivedFrom` on an experiment's candidate and `promotedFrom` on a version a
 * promotion copied in. A candidate is labeled with its experiment and is never offered for activation (the
 * server refuses it as a rollback target; Promote is the way it reaches the live assistant). A promoted
 * version names the candidate and the experiment it came from.
 */
vi.mock('../../services/profileService', () => ({
  DEFAULT_MODEL: 'default',
  listProfilesAndTools: vi.fn(),
  createProfileVersion: vi.fn(),
  editProfileDraft: vi.fn(),
  validateProfileDraft: vi.fn(),
  activateProfileDraft: vi.fn(),
  rollbackProfile: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
}));
vi.mock('../../services/ownershipService', () => ({
  listOwnership: vi.fn().mockResolvedValue([]),
  setOwnership: vi.fn(),
}));

const ALT = {
  profileName: 'alt-primary-premium',
  activeVersion: null,
  hasDraft: false,
  versions: [
    { version: 4, configId: 'cfg-candidate-4', active: false, derivedFrom: { experimentId: 'exp-sonnet', variantId: 'treatment', baseProfile: 'advisor', baseVersion: 3 } },
  ],
};
const LIVE = {
  profileName: 'advisor',
  activeVersion: 5,
  hasDraft: false,
  versions: [
    { version: 5, configId: 'cfg-candidate-4', active: true, promotedFrom: { profileName: 'alt-primary-premium', version: 4, experimentId: 'exp-sonnet' } },
    { version: 3, configId: 'cfg-old-3', active: false },
  ],
};

async function open(name: string, capabilities = ['activate-profiles', 'edit-profiles']) {
  render(
    <CapabilityTestProvider capabilities={capabilities}>
      <ProfilesTab />
    </CapabilityTestProvider>,
  );
  fireEvent.click(await screen.findByText(name));
  fireEvent.click(await screen.findByTestId('assistant-nav-versions'));
}

describe('ProfilesTab: derived and promoted versions are marked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(svc.listProfilesAndTools).mockResolvedValue({
      profiles: [ALT, LIVE] as unknown as svc.ProfileListing[], tools: [], runtimeAssistants: [], rosterTargets: [],
    });
    vi.mocked(svc.exportProfile).mockRejectedValue(new Error('not needed'));
  });

  it('a candidate is labeled with its experiment and its base, and offers no activation', async () => {
    await open('alt-primary-premium');
    const mark = await screen.findByTestId('version-derived');
    expect(mark).toHaveTextContent('Candidate of exp-sonnet (treatment)');
    expect(mark).toHaveTextContent('from advisor v3');
    expect(screen.getByTestId('version-not-activatable')).toHaveTextContent(
      'Never served; cannot be activated. Promote it from experiment exp-sonnet.',
    );
    expect(screen.queryByRole('button', { name: /^Roll back to v/ })).toBeNull();
  });

  it('a promoted version names the candidate and the experiment it came from; an ordinary version can still be rolled back to', async () => {
    await open('advisor');
    expect(await screen.findByTestId('version-promoted')).toHaveTextContent(
      'Promoted from alt-primary-premium v4 (experiment exp-sonnet)',
    );
    const rollbacks = screen.getAllByRole('button', { name: /^Roll back to v/ });
    expect(rollbacks).toHaveLength(1);
    const row = rollbacks[0].closest('tr')!;
    expect(within(row).getByText('3')).toBeTruthy();
  });
});

describe('canActivateVersion', () => {
  it('never a candidate, never the active version, otherwise yes', () => {
    expect(canActivateVersion({ active: false, derivedFrom: { experimentId: 'e', variantId: 'treatment' } })).toBe(false);
    expect(canActivateVersion({ active: true })).toBe(false);
    expect(canActivateVersion({ active: false })).toBe(true);
  });
});
