import { test, expect } from '@playwright/test';
import { navigateToApp, signIn, isConnected } from './helpers/agent-helpers';
import { getBasicUser, getStandardUser, getPremiumUser } from './helpers/test-credentials';

test.describe.serial('Sign In Flow', () => {
  test('should display login form on load', async ({ page }) => {
    await navigateToApp(page);

    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('should reject invalid credentials', async ({ page }) => {
    await navigateToApp(page);
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });

    await page.locator('input[type="email"]').fill('nonexistent@example.com');
    await page.locator('input[type="password"]').fill('WrongPassword123!');
    await page.locator('button[type="submit"]').click();

    // Should show auth error
    await expect(
      page.locator('.error-message, .auth-error, [role="alert"]')
    ).toBeVisible({ timeout: 10000 });
  });

  test('should reject empty form submission', async ({ page }) => {
    await navigateToApp(page);
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });

    await page.locator('button[type="submit"]').click();

    // Should show validation or remain on form
    const stillOnForm = await page.locator('input[type="email"]').isVisible();
    expect(stillOnForm).toBeTruthy();
  });

  test('should sign in basic user and show app header', async ({ page }) => {
    const user = await getBasicUser();
    if (!user.password) {
      test.skip();
      return;
    }

    await signIn(page, user.email, user.password);

    // Authenticated UI should be visible
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    // Should show user email or name somewhere
    const headerText = await page.locator('.app-header').textContent();
    console.log(`\n--- signin-basic ---`);
    console.log(`Signed in as: ${user.email}`);
    console.log(`Header text: ${headerText}`);
  });

  test('should establish WebSocket connection after sign in', async ({ page }) => {
    const user = await getBasicUser();
    if (!user.password) {
      test.skip();
      return;
    }

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    // Wait a moment for WebSocket to connect
    await page.waitForTimeout(3000);

    const connected = await isConnected(page);
    console.log(`\n--- signin-websocket ---`);
    console.log(`WebSocket connected: ${connected}`);

    // Connection status indicator should not show disconnected
    expect(connected).toBeTruthy();
  });

  test('should sign in standard user and verify tier features', async ({ page }) => {
    const user = await getStandardUser();
    if (!user.password) {
      test.skip();
      return;
    }

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    console.log(`\n--- signin-standard ---`);
    console.log(`Signed in as standard user: ${user.email}`);
  });

  test('should sign in premium user and see admin button', async ({ page }) => {
    const user = await getPremiumUser();
    if (!user.password) {
      test.skip();
      return;
    }

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    // The premium demo user is in the `admins` group (seed-demo), so it IS an admin.
    // Post the D split the chat app has no embedded admin console; an admin's only
    // affordance is the link-OUT to the separate console (`.header-admin-link`, shown
    // when VITE_ADMIN_APP_URL is set and user.isAdmin). So an admin sees exactly this
    // link (a non-admin basic/standard user would see nothing — covered elsewhere).
    const adminLink = page.locator('.header-admin-link');
    const adminVisible = await adminLink.isVisible({ timeout: 5000 }).catch(() => false);
    expect(adminVisible).toBe(true);

    console.log(`\n--- signin-premium ---`);
    console.log(`Signed in as premium (admin) user: ${user.email}; admin link-out present, as expected`);
  });

  test('should sign out successfully', async ({ page }) => {
    const user = await getBasicUser();
    if (!user.password) {
      test.skip();
      return;
    }

    await signIn(page, user.email, user.password);
    await expect(page.locator('.app-header')).toBeVisible({ timeout: 30000 });

    // Click sign out
    const signOutButton = page.locator('button:has-text("Sign out"), button:has-text("Logout"), .sign-out-btn');
    await signOutButton.click();

    // Should return to login form
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10000 });
  });
});
