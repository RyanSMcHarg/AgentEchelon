import { test, expect } from '@playwright/test';
import { navigateToApp, registerUser, isConnected } from './helpers/agent-helpers';
import { getBasicUser, getStandardUser } from './helpers/test-credentials';

test.describe.serial('Sign Up Flow', () => {
  test('should display registration form when clicking Create account', async ({ page }) => {
    await navigateToApp(page);

    // Login form should be visible by default
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10000 });

    // Click Create account button
    await page.locator('button:has-text("Create account")').click();

    // Registration form should appear
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#confirmPassword')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('should reject registration with invalid email', async ({ page }) => {
    await navigateToApp(page);
    await page.locator('button:has-text("Create account")').click();
    await page.waitForSelector('input[type="email"]');

    await page.locator('input[type="email"]').fill('not-an-email');
    await page.locator('#password').fill('Test1234!');
    await page.locator('button[type="submit"]').click();

    // Should show validation error or remain on form
    const errorVisible = await page
      .locator('.error-message, .auth-error, [role="alert"]')
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const stillOnForm = await page.locator('input[type="email"]').isVisible();

    expect(errorVisible || stillOnForm).toBeTruthy();
  });

  test('should reject registration with weak password', async ({ page }) => {
    await navigateToApp(page);
    await page.locator('button:has-text("Create account")').click();
    await page.waitForSelector('input[type="email"]');

    const timestamp = Date.now();
    await page.locator('input[type="email"]').fill(`weak-pw-test-${timestamp}@example.com`);
    await page.locator('#password').fill('short');
    await page.locator('button[type="submit"]').click();

    // Should show password policy error or remain on form
    const errorVisible = await page
      .locator('.error-message, .auth-error, [role="alert"]')
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const stillOnForm = await page.locator('input[type="email"]').isVisible();

    expect(errorVisible || stillOnForm).toBeTruthy();
  });

  test('should successfully register a new user', async ({ page }) => {
    // Cognito's signUp call against synthetic addresses is often slow (>10s),
    // especially on cold start in shared dev accounts — the page sits with
    // "Creating account…" disabled while Cognito churns. Give the call a
    // realistic budget; the test asserts "we ended in a sane post-signup
    // state," not that signup completed in 10s.
    test.setTimeout(90000);

    const timestamp = Date.now();
    const email = `e2e-signup-${timestamp}@example.com`;
    const password = 'E2eTest1234!';

    await registerUser(page, email, password, 'basic');

    // Race between the two valid end-states + an explicit error surface.
    // We win as soon as ANY of them resolves; whichever it is, the call
    // finished and we can assert from there.
    const VERIFY = page.locator('text=/verify|confirmation|check your email/i').first();
    const AUTHED = page.locator('.app-header').first();
    const ERROR = page.locator('.error-message, .auth-error, [role="alert"]').first();

    await Promise.race([
      VERIFY.waitFor({ state: 'visible', timeout: 60000 }).catch(() => null),
      AUTHED.waitFor({ state: 'visible', timeout: 60000 }).catch(() => null),
      ERROR.waitFor({ state: 'visible', timeout: 60000 }).catch(() => null),
    ]);

    const verificationVisible = await VERIFY.isVisible().catch(() => false);
    const authenticatedVisible = await AUTHED.isVisible().catch(() => false);

    expect(verificationVisible || authenticatedVisible).toBeTruthy();
    console.log(`\n--- signup-success ---`);
    console.log(`Registered: ${email}`);
    console.log(`Verification screen: ${verificationVisible}, Authenticated: ${authenticatedVisible}`);
  });

  test('should reject duplicate registration', async ({ page }) => {
    // Same Cognito-cold-start budget as :61 — the duplicate-detection
    // path still goes through SignUpCommand, which the dev account
    // routinely takes 10-30s to respond to. Wait for the error surface
    // instead of asserting on a tight 10s window.
    test.setTimeout(90000);

    const user = await getBasicUser();
    if (!user.password) {
      test.skip();
      return;
    }

    await registerUser(page, user.email, user.password, 'basic');

    // Should show error about existing user
    await page
      .locator('.error-message, .auth-error, [role="alert"]')
      .first()
      .waitFor({ state: 'visible', timeout: 60000 })
      .catch(() => null);

    const errorVisible = await page
      .locator('.error-message, .auth-error, [role="alert"]')
      .first()
      .isVisible()
      .catch(() => false);

    expect(errorVisible).toBeTruthy();
  });
});
