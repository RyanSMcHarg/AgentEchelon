/**
 * Welcome-orientation e2e (Phase 2). A brand-new conversation must open with the config-driven
 * orientation the demo seeds (seed-demo.ts writes it to `${SSM_ROOT}/assistant/{tier}/welcome-orientation`):
 * the company, the signed-in user's access level, a few grounded example prompts, and a pointer to
 * learn about / customize the AgentEchelon platform. This is the first thing a demo user sees, so it
 * proves the orientation is wired end-to-end (SSM param -> router welcome path -> posted message).
 *
 * Gated by WELCOME_E2E=1 (a validate.mjs phase). Runs against the live deployment.
 */
import { test, expect } from '@playwright/test';
import { signIn, createConversation } from './helpers/agent-helpers';
import { getTestCredentials, type TestCredentials } from './helpers/test-credentials';

const RUN = process.env.WELCOME_E2E === '1';
const suite = RUN ? test.describe : test.describe.skip;

suite('Welcome orientation greets the demo user', () => {
  let creds: TestCredentials;
  test.beforeAll(async () => {
    creds = await getTestCredentials();
  });

  test('[premium] a new conversation opens with a Stratum, tier-aware orientation', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, creds.testAdmin.email, creds.testAdmin.password);
    await createConversation(page, `Welcome ${Date.now()}`, 'Premium');

    // The assistant's WelcomeIntent reply posts as the first assistant message in the fresh channel.
    const firstBot = page.locator('.assistant-message').first();
    await expect(firstBot).toBeVisible({ timeout: 60_000 });
    const text = (await firstBot.innerText()).toLowerCase();

    // Names the company + frames the user as an employee with a specific access level.
    expect(text, 'the welcome names the company').toContain('stratum technologies');
    expect(text, 'the welcome states the access level').toMatch(/leadership access|access:/);
    // Offers concrete, grounded things to try (premium examples: report / churn / ARR).
    expect(text, 'the welcome offers example tasks').toMatch(/a few things you can try/);
    expect(text, 'the examples are grounded in the premium data').toMatch(/report|churn|arr|retention/);
    // Points the user at learning / customizing the platform itself.
    expect(text, 'the welcome points at the platform').toContain('agentechelon');
  });
});
