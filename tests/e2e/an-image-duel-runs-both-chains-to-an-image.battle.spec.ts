/**
 * AN IMAGE DUEL RUNS BOTH CHAINS TO AN IMAGE (ADR-064 slice 7), as premium, in the battle project (its pre-authed
 * storage state).
 *
 * `image_generation` is a workflow (gather, confirm, generate, done), and round 1 of a task-shaped side runs its chain
 * (ADR-026) on its own pinned version's text and image models. The request carries the complete brief (the subject, the
 * style and the composition), so `confirm` is passed (ADR-064 decision G, `when-incomplete`): each side goes from
 * `gather` straight to `generate` and draws in its first turn, its task is done, and no side parks on the person.
 * Arming refuses a side with no image model for the intent, so both sides end with an image, and each side's
 * scorecard shows its cost as its steps summed (text and image), never the em-dash of an unknown cost.
 *
 * GATED: `BATTLE_E2E=1`, `BATTLE_IMAGE_E2E=1` and `E2E_MODEL_ROUTES=1`; real image calls are billed.
 *
 * **Coverage:** `e2e/an-image-duel-runs-both-chains-to-an-image.battle.spec.ts`
 */
import { test, expect } from './helpers/fixtures';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import {
  activateBattleExperiment, battleImageExpId, ensureBattleExperimentExists, fireBattle, newBattleChannel,
} from './helpers/battle-setup';

test.describe('an image duel runs both chains to an image', () => {
  guardBackendErrors('an-image-duel-runs-both-chains-to-an-image');
  guardConsoleErrors();

  test('both sides draw an image, and each scorecard prices its steps', async ({ page }) => {
    test.skip(process.env.BATTLE_E2E !== '1' || process.env.BATTLE_IMAGE_E2E !== '1' || process.env.E2E_MODEL_ROUTES !== '1',
      'bills real image calls; set BATTLE_E2E=1, BATTLE_IMAGE_E2E=1 and E2E_MODEL_ROUTES=1');
    test.setTimeout(15 * 60_000);
    await ensureBattleExperimentExists(page, { expId: battleImageExpId(), image: true });
    await activateBattleExperiment(page, battleImageExpId());
    await newBattleChannel(page, 'E2E image duel chains', battleImageExpId());

    const count = await fireBattle(page, '/battle Generate a watercolor of a lighthouse on a rocky coast at dusk, wide landscape framing with the lighthouse on the right, no people.', 600_000);
    expect(count).toBeGreaterThanOrEqual(2);

    const imgs = page.locator('.battle-message .attachment-image');
    await expect.poll(() => imgs.count(), { timeout: 600_000, message: 'each side ends its chain with an image' }).toBeGreaterThanOrEqual(2);

    const cards = page.locator('.battle-scorecard');
    await expect(cards.last()).toBeVisible({ timeout: 120_000 });
    const text = await cards.last().innerText();
    // A summed cost renders as a dollar figure; an unknown one as an em-dash.
    expect(text, 'each side shows its summed cost').toMatch(/\$\d/);
  });
});
