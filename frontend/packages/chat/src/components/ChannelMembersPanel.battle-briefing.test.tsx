/**
 * ChannelMembersPanel — the battle toggle must PUBLISH its config change.
 *
 * THE DEFECT THIS EXISTS FOR. The battle config is server state held in TWO places: this panel (which
 * owns the on/off toggle) and `ConversationInterface` (which owns the battle BRIEFING banner - the
 * decision line and prompt chips). The interface fetched it once per conversation, in an effect keyed
 * on `conversationArn`/`modelTier`, and nothing refetched it. So a moderator who opened a premium
 * conversation and then turned Battle Mode ON saw NO briefing at all: no decision line, no chips,
 * until they switched conversations or reloaded the app. That is precisely the moment the briefing
 * exists to serve, and it is a headline part of the battle experience.
 *
 * It surfaced as an e2e failure (`battle.spec.ts` B-E2, `.battle-briefing` never visible after 120s)
 * that looked like a rendering bug. The backend was correct throughout - the active experiment carried
 * its `objective.statement` and every `ChannelBattleConfig` row carried the resulting
 * `briefingStatement`. Only the client's second copy was stale.
 *
 * The assertion is on the CALLBACK rather than on a rendered banner, because the banner lives in a
 * different component: the contract this file defends is "the toggle tells the rest of the app", which
 * is the thing that was missing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const enableBattle = vi.fn();
const disableBattle = vi.fn();
const getBattleConfig = vi.fn();

vi.mock('../services/channelBattleService', () => ({
  enableBattle: (...a: unknown[]) => enableBattle(...a),
  disableBattle: (...a: unknown[]) => disableBattle(...a),
  getBattleConfig: (...a: unknown[]) => getBattleConfig(...a),
}));

const ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';

// STABLE references. The panel's battle effect depends on `activeConversation`, so a mock that built
// a fresh object per render would re-run the effect every render and spin forever - the real provider
// returns a stable reference. (This hung the run with no output at all, which is what an infinite
// render loop looks like from outside.)
const ACTIVE_CONVERSATION = { conversationArn: ARN, modelTier: 'premium' };
const NO_MEMBERS: never[] = [];
const CONVERSATIONS = { activeConversation: ACTIVE_CONVERSATION, channelMembers: NO_MEMBERS };
const AWS_CLIENT = { userArn: SELF };
const MODERATORS = new Set([SELF]);

vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => CONVERSATIONS,
}));
vi.mock('../providers/AwsClientProvider', () => ({
  useAwsClient: () => AWS_CLIENT,
}));
vi.mock('../services/chimeService', () => ({
  // The panel reads the LIVE moderator list; the toggle only renders for a moderator.
  chimeService: { listModerators: () => Promise.resolve(MODERATORS) },
}));
vi.mock('../services/conversationManagementService', () => ({ removeConversationMember: vi.fn() }));
// A full replacement, NOT `importOriginal`: pulling the real @ae/shared barrel here hangs the run at
// import time (it reaches AWS SDK modules that never settle under jsdom). The panel only needs these
// two runtime symbols from it; `ChannelMember` is a type and erases.
vi.mock('@ae/shared', () => ({
  useAuth: () => ({ user: { isAdmin: true } }),
  listExperiments: () => Promise.resolve([]),
}));
// i18n is not initialised in this harness; the panel's copy all carries defaultValue, so return that.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? '' }),
}));

import ChannelMembersPanel from './ChannelMembersPanel';

beforeEach(() => {
  enableBattle.mockReset().mockResolvedValue(undefined);
  disableBattle.mockReset().mockResolvedValue(undefined);
  getBattleConfig.mockReset().mockResolvedValue({ channelArn: ARN, enabled: false, battleEligible: true });
});

/** The panel's battle toggle, whichever label the copy currently uses. */
async function battleButton(name: RegExp) {
  return waitFor(() => screen.getByRole('button', { name }), { timeout: 3000 });
}

describe('the battle section gates on the profile capability', () => {
  it('shows the toggle when the profile is battle-eligible', async () => {
    getBattleConfig.mockResolvedValue({ channelArn: ARN, enabled: false, battleEligible: true });
    render(<ChannelMembersPanel isOpen onClose={vi.fn()} onBattleConfigChange={vi.fn()} />);
    expect(await battleButton(/turn on|enable/i)).toBeTruthy();
  });

  it('HIDES the toggle when the profile is not battle-eligible', async () => {
    // The behaviour that was never wired. The panel used to gate on `modelTier === 'premium'` read from
    // mutable channel metadata, so `battleEligible` was unobservable here: turning it on for a
    // non-premium profile left the toggle invisible, and turning it OFF for premium still showed it.
    getBattleConfig.mockResolvedValue({ channelArn: ARN, enabled: false, battleEligible: false });
    render(<ChannelMembersPanel isOpen onClose={vi.fn()} onBattleConfigChange={vi.fn()} />);
    await waitFor(() => expect(getBattleConfig).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /turn on|enable/i })).toBeNull();
  });

  it('fails CLOSED when the backend does not report eligibility at all', async () => {
    // A capability gate must not open on a missing field.
    getBattleConfig.mockResolvedValue({ channelArn: ARN, enabled: false });
    render(<ChannelMembersPanel isOpen onClose={vi.fn()} onBattleConfigChange={vi.fn()} />);
    await waitFor(() => expect(getBattleConfig).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /turn on|enable/i })).toBeNull();
  });
});

describe('the battle toggle publishes its config change', () => {
  it('reports the REFRESHED config after enabling, so the briefing can appear immediately', async () => {
    const onBattleConfigChange = vi.fn();
    // The enable response is what carries `briefingStatement` — the banner's whole input.
    getBattleConfig
      .mockResolvedValueOnce({ channelArn: ARN, enabled: false, battleEligible: true })
      .mockResolvedValue({ channelArn: ARN, enabled: true, battleEligible: true, briefingStatement: 'Decide the base model.' });

    render(<ChannelMembersPanel isOpen onClose={vi.fn()} onBattleConfigChange={onBattleConfigChange} />);
    fireEvent.click(await battleButton(/turn on|enable/i));

    await waitFor(() => expect(enableBattle).toHaveBeenCalledWith(ARN));
    await waitFor(() => {
      expect(onBattleConfigChange).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, briefingStatement: 'Decide the base model.' }),
      );
    });
  });

  it('reports the OFF config after disabling, so a stale briefing is retracted', async () => {
    const onBattleConfigChange = vi.fn();
    getBattleConfig.mockResolvedValue({ channelArn: ARN, enabled: true, battleEligible: true, briefingStatement: 'Decide.' });
    vi.stubGlobal('confirm', () => true);

    render(<ChannelMembersPanel isOpen onClose={vi.fn()} onBattleConfigChange={onBattleConfigChange} />);
    fireEvent.click(await battleButton(/turn off|disable/i));

    await waitFor(() => expect(disableBattle).toHaveBeenCalledWith(ARN));
    await waitFor(() => {
      expect(onBattleConfigChange).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    });
  });

  it('does not report anything when the enable FAILS — no phantom briefing', async () => {
    const onBattleConfigChange = vi.fn();
    enableBattle.mockRejectedValue(new Error('Slot is bound to another active battle experiment'));

    render(<ChannelMembersPanel isOpen onClose={vi.fn()} onBattleConfigChange={onBattleConfigChange} />);
    fireEvent.click(await battleButton(/turn on|enable/i));

    await waitFor(() => expect(enableBattle).toHaveBeenCalled());
    expect(onBattleConfigChange).not.toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });
});
