/**
 * AN EXPERIMENT'S BATTLES ARE READ ON ITS PAGE, AND A BATTLE OPENS ITS CONVERSATION.
 *
 * An experiment has a goal and results; when Battle Mode is on it can also run battles, each a sub-result
 * of the experiment: someone in battle mode gets both versions' answers over a few turns and picks the
 * better one. So battles have no view of their own. This spec reaches them the way a person does: through
 * the experiment's page, to the Battles section, and from a battle's row to its conversation.
 *
 * THE SPEC BRINGS ITS OWN BATTLE. It arms a battle experiment of its own on premium through the signed admin
 * API (the battle specs' `ensureBattleExperimentExists`), turns Battle Mode on for premium when it was off,
 * opens a premium conversation with Battle Mode on, and fires one short text `/battle`. It waits for both
 * round-1 replies on the page's own message socket and for the duel to release its channel, then for the
 * battle to reach the analytics read (`battle_results`, an Aurora projection behind archival). Afterwards it
 * ends and deletes the experiment and puts Battle Mode back as it found it, so the deployment is left as found.
 *
 * WHAT IT ASSERTS: the retired `?admin=battles` and `?admin=duels` links land on the Experiments list; the
 * battle this spec ran is a row on its experiment's page; the row opens the conversation the battle ran in,
 * through the console's conversation view (`admin=conversations&conv=<channel>&msg=<message>&at=<time>`), at
 * the /battle message that started it, highlighted, with no "isn't available" note; and a battle nobody
 * picked reads "Not picked yet", never "Tie".
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT: what either side answered, or which side a person would pick. The
 * battle specs own the duel itself; this spec owns reading one from its experiment.
 */
import { test, expect, declareWait, trackConversation } from './helpers/fixtures';
import { Page } from '@playwright/test';
import { signIn, idTokenOf, answerAdminReasonPrompts } from './helpers/agent-helpers';
import { getAdminUser, missingUserReason } from './helpers/test-credentials';
import { guardBackendErrors, guardConsoleErrors } from './helpers/turn-guards';
import {
  ensureBattleExperimentExists,
  enableBattleForClassification,
  newBattleChannelWithId,
} from './helpers/battle-setup';
import { readActiveBattle } from './helpers/battle-state-backend';
import { ChannelWireRecorder, type WireMessage } from './helpers/channel-wire';
import { pollFor } from './helpers/task-backend';
import { signedAdminContext, signedAnalyticsPost } from './helpers/signed-analytics';
import { ADMIN_API_URL, adminApiServes, adminUrl, personApiServes } from './helpers/api-urls';
import { fillSecret } from './helpers/unrecorded-secret';

const ADMIN_BASE_URL = process.env.E2E_ADMIN_BASE_URL || process.env.E2E_BASE_URL || 'http://localhost:5174';
const CHAT_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';
test.use({ baseURL: ADMIN_BASE_URL });

const RUN = process.env.EXPERIMENT_BATTLES_E2E === '1';
const suite = RUN ? test.describe.serial : test.describe.skip;

guardBackendErrors('experiment-battles');
guardConsoleErrors();

/** The classification the battle runs in: the one battle's helpers arm and its challenger belongs to. */
const CLASSIFICATION = 'premium';
/** A short opinion prompt, answered in one turn by each side, so the duel finishes quickly and asks nothing back. */
const PROMPT = 'Is a five-minute daily standup worth it for a team of five? One sentence, with a clear yes or no.';

/** Open a console URL, signing in first when the session is not there yet. */
async function openConsole(page: Page, search: string): Promise<void> {
  const admin = await getAdminUser();
  test.skip(!admin.password, missingUserReason('testAdmin'));
  await page.goto(new URL(`/${search}`, ADMIN_BASE_URL).toString());
  const needsLogin = await page
    .locator('input[type="password"]').first()
    .isVisible({ timeout: 5_000 }).catch(() => false);
  if (needsLogin) {
    await signIn(page, admin.email, admin.password);
    await page.goto(new URL(`/${search}`, ADMIN_BASE_URL).toString());
  }
}

/** Sign the admin user into the chat app, where the battle runs. Auth is per origin, so this is its own sign-in. */
async function signInOnChat(page: Page): Promise<void> {
  const admin = await getAdminUser();
  expect(admin.password, missingUserReason('testAdmin')).toBeTruthy();
  await page.goto(CHAT_BASE_URL);
  const needsLogin = await page
    .locator('input[type="password"]').first()
    .isVisible({ timeout: 10_000 }).catch(() => false);
  if (needsLogin) {
    await page.locator('input[type="email"]').fill(admin.email);
    await fillSecret(page.locator('input[type="password"]'), admin.password);
    await page.locator('button[type="submit"]').click();
  }
  await page.waitForSelector('.app-header', { timeout: 30_000 });
}

/** The Battles section once its read has settled: its tables, or its own empty copy. */
async function settledBattles(page: Page) {
  const section = page.getByTestId('experiment-battles');
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByText('Loading battles…')).toHaveCount(0, { timeout: 60_000 });
  return section;
}

/** The last day, as the analytics read takes it. */
function todayRange(): { dateRange: { start: string; end: string } } {
  const end = new Date();
  const start = new Date(end.getTime() - 86_400_000);
  return { dateRange: { start: start.toISOString(), end: end.toISOString() } };
}

const battleSettingsUrl = (): string => adminUrl('assistant-admin', '/admin/experiments/battle-settings');

/** Whether Battle Mode is on for a classification, read through the signed admin API the console uses. */
async function battleIsOn(idToken: string, classification: string): Promise<boolean> {
  const api = signedAdminContext(idToken);
  try {
    const resp = await api.get(battleSettingsUrl());
    expect(resp.ok(), `read battle settings: ${resp.status()} ${await resp.text()}`).toBeTruthy();
    const settings = ((await resp.json())?.settings ?? []) as Array<{ classification: string; capable: boolean; enabled: boolean }>;
    const mine = settings.find((s) => s.classification === classification);
    expect(mine?.capable, `this deployment does not wire battle for '${classification}'; battle settings read ${JSON.stringify(settings)}`).toBe(true);
    return mine!.enabled;
  } finally {
    await api.dispose();
  }
}

/** What this file changed on the deployment, so `afterAll` puts each back. */
const arranged: { idToken?: string; experimentId?: string; turnedBattleOn?: boolean } = {};

suite('an experiment\'s battles are read on its page', () => {
  for (const old of ['battles', 'duels']) {
    test(`the retired ?admin=${old} link lands on the Experiments list`, async ({ page }) => {
      test.setTimeout(3 * 60_000);
      await openConsole(page, `?admin=${old}`);
      await expect(page.locator('#admin-tab-experiments')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
      await expect(page).toHaveURL(/[?&]admin=experiments\b/);
      await expect(page.locator('#admin-tab-battles, #admin-tab-duels')).toHaveCount(0);
    });
  }

  test('a battle row opens the conversation the battle ran in', async ({ page }) => {
    // Arming, one duel of two short rounds, and the archival lag before the battle reaches the analytics read.
    test.setTimeout(15 * 60_000);
    expect(personApiServes('battle'), 'this deployment does not serve battle (VITE_PERSON_API_CAPABILITIES does not name battle)').toBe(true);
    expect(adminApiServes('experiments'), 'VITE_ADMIN_API_CAPABILITIES must name experiments to arm a battle experiment').toBe(true);
    const analyticsApi = ADMIN_API_URL ? adminUrl('analytics', '/') : '';
    expect(analyticsApi, 'VITE_ADMIN_API_URL must be set to read the battle back from analytics').toBeTruthy();

    // The page's message socket, recorded from the first navigation, is what the duel's replies arrive on.
    const wire = new ChannelWireRecorder();
    wire.attach(page);
    await answerAdminReasonPrompts(page);
    await signInOnChat(page);
    const idToken = await idTokenOf(page);
    expect(idToken, 'the chat sign-in left no id token').toBeTruthy();
    arranged.idToken = idToken;

    // BATTLE MODE ON FOR PREMIUM, remembering whether it already was, so afterAll puts it back as found.
    if (!(await battleIsOn(idToken, CLASSIFICATION))) {
      await enableBattleForClassification(page, CLASSIFICATION);
      arranged.turnedBattleOn = true;
    }
    const battleOnAt = Date.now();

    // ARM THIS FILE'S OWN BATTLE EXPERIMENT, active on premium with both sides pinned, in one call.
    const experimentId = `e2e-battle-row-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    arranged.experimentId = experimentId;
    await ensureBattleExperimentExists(page, { expId: experimentId });

    // A setting written by the admin API reaches every warm container within 30 seconds (`appliesWithinSeconds`).
    // When this run is what turned it on, the conversation's enable waits out that timer rather than racing it.
    if (arranged.turnedBattleOn) {
      const dueAt = battleOnAt + 30_000;
      if (dueAt > Date.now()) {
        declareWait('the battle setting reaching every warm container', dueAt);
        await page.waitForTimeout(dueAt - Date.now());
      }
    }

    // A PREMIUM CONVERSATION WITH BATTLE MODE ON, and one short text /battle in it.
    const channelId = await newBattleChannelWithId(page, 'E2E experiment battle row', experimentId);
    const inChannel = (m: WireMessage): boolean => m.channelArn.endsWith(`/channel/${channelId}`);
    trackConversation(channelId);
    await page.locator('.message-textarea').fill(`/battle ${PROMPT}`, { timeout: 30_000 });
    await page.keyboard.press('Enter');

    // BOTH ROUND-1 REPLIES, each attributed to this experiment and its own side, read off the socket as they land.
    const repliedSides = (all: WireMessage[]): Set<string> => new Set(all
      .filter((m) => inChannel(m) && m.isBot && m.metadata?.experimentId === experimentId
        && String(m.metadata?.battleRound ?? '1') === '1')
      .map((m) => String(m.metadata?.variantId)));
    const seen = await wire.waitUntil((all) => {
      const sides = repliedSides(all);
      return sides.has('control') && sides.has('treatment');
    }, 5 * 60_000);
    expect(
      [...repliedSides(seen)].sort(),
      `both sides answer round 1 of the battle on ${experimentId}; the socket carried `
      + `${seen.filter(inChannel).length} frames for the conversation (connected: ${wire.connected})`,
    ).toEqual(['control', 'treatment']);

    // THE DUEL FINISHES: round 2 runs on its own, and the channel's battle pointer is released when the duel
    // completes. The pointer is a table row that raises no event, so it is read on an interval.
    declareWait('the battle\'s second round finishing and releasing the conversation', Date.now() + 4 * 60_000);
    const pointer = await pollFor(
      () => readActiveBattle(channelId).battleId ?? 'released',
      (v) => v === 'released',
      { timeoutMs: 4 * 60_000, intervalMs: 5_000 },
    );
    expect(pointer, `the battle in ${channelId} completes and releases the conversation`).toBe('released');

    // THE BATTLE REACHES THE ANALYTICS READ the Battles section makes. The rows come from the archived exchanges in
    // Aurora, behind archival lag, with no event the runner can subscribe to, so it is a declared wait read by `pollFor`.
    type BattleRow = { battle_id: string; channel_arn: string | null; start_message_id: string | null; started_at: string | null };
    const readBattles = async (): Promise<BattleRow[]> => {
      const j = await signedAnalyticsPost(analyticsApi, idToken, { queryType: 'battle_results', experimentId, ...todayRange() });
      return ((j?.data ?? []) as BattleRow[]).filter((r) => String(r.channel_arn ?? '').endsWith(`/channel/${channelId}`));
    };
    declareWait('the battle archiving into the battle results', Date.now() + 5 * 60_000);
    const battles = await pollFor(readBattles, (rows) => rows.some((r) => !!r.start_message_id), {
      timeoutMs: 5 * 60_000,
      intervalMs: 10_000,
    });
    const battle = battles.find((r) => !!r.start_message_id);
    expect(battle, `the battle in ${channelId} reaches battle_results for ${experimentId} with its /battle message`).toBeTruthy();

    // THE EXPERIMENT'S PAGE reads Goal, Results, Battles, Settings, and lists this battle.
    await openConsole(page, `?admin=experiments&exp=${encodeURIComponent(experimentId)}`);
    await expect(page.getByTestId('experiment-page')).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`[?&]exp=${experimentId}\\b`));
    await expect(page.getByTestId('experiment-goal')).toBeVisible();
    await expect(page.getByTestId('experiment-settings')).toBeVisible();
    const section = await settledBattles(page);
    await expect(section).not.toContainText(/duel/i);

    // The experiment is this file's own, so the one battle it ran is the one row.
    const rows = section.getByTestId('battle-row');
    await expect(rows, `the Battles section of ${experimentId} lists the battle this test ran`).toHaveCount(1, { timeout: 30_000 });

    // NOT PICKED IS NOT A TIE.
    for (const outcome of await rows.locator('td[data-col="outcome"]').allInnerTexts()) {
      expect(outcome.trim()).not.toBe('');
      if (/Not picked yet/.test(outcome)) expect(outcome).not.toMatch(/\bTie\b/);
    }

    // The row opens the conversation the battle ran in, in the console's conversation view, AT the /battle
    // message that started it. Nothing expands.
    await rows.first().locator('td[data-col="room"]').click();
    await expect(page).toHaveURL(/[?&]admin=conversations\b/, { timeout: 30_000 });
    await expect(page).toHaveURL(/[?&]conv=/);
    await expect(page).toHaveURL(/[?&]msg=/);
    await expect(page).toHaveURL(/[?&]at=/);
    const url = new URL(page.url());
    expect(url.searchParams.get('conv'), 'the row opens the conversation the battle ran in').toBe(channelId);
    expect(url.searchParams.get('msg'), 'the row opens at the /battle message that started the battle').toBe(battle!.start_message_id);
    expect(url.searchParams.get('at'), 'the link carries the time the battle started').toBeTruthy();
    expect(url.searchParams.get('battle')).toBeNull();

    // The /battle message is the highlighted row, found by its own id, and no fallback note shows.
    const focused = page.locator('tr[aria-current="true"]');
    await expect(focused).toHaveCount(1, { timeout: 60_000 });
    await expect(focused).toHaveAttribute('data-row-key', battle!.start_message_id!);
    await expect(focused).toHaveClass(/data-table-row--focus/);
    await expect(focused).toContainText('/battle');
    await expect(focused).toBeInViewport();
    await expect(page.getByTestId('message-link-note')).toHaveCount(0);
  });

  // LEAVE THE DEPLOYMENT AS FOUND: the experiment ended and deleted, and Battle Mode back to what it was. Every step
  // is attempted, and any that fails is named, because a battle experiment left active keeps splitting premium traffic.
  test.afterAll(async () => {
    if (!arranged.idToken) return;
    const api = signedAdminContext(arranged.idToken);
    const failures: string[] = [];
    try {
      if (arranged.experimentId) {
        const id = arranged.experimentId;
        const ended = await api.post(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(id)}/status`), { data: { status: 'completed' } });
        if (!ended.ok() && ended.status() !== 404) failures.push(`end ${id}: ${ended.status()} ${await ended.text()}`);
        const deleted = await api.delete(adminUrl('assistant-admin', `/admin/experiments/${encodeURIComponent(id)}`));
        if (!deleted.ok() && deleted.status() !== 404) failures.push(`delete ${id}: ${deleted.status()} ${await deleted.text()}`);
      }
      if (arranged.turnedBattleOn) {
        const off = await api.post(battleSettingsUrl(), { data: { classification: CLASSIFICATION, enabled: false } });
        if (!off.ok()) failures.push(`turn battle back off for ${CLASSIFICATION}: ${off.status()} ${await off.text()}`);
      }
    } finally {
      await api.dispose();
    }
    if (failures.length) {
      throw new Error(`experiment-battles could not leave the deployment as it found it: ${failures.join('; ')}`);
    }
  });
});
