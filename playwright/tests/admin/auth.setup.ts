import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminCredentials } from '../fixture';

setup('admin login', async ({ page }) => {
  const { user, password } = adminCredentials();
  await page.goto('/admin');
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(password);
  await page.locator('button.action-login').click();
  await expect(page.locator('.page-title, h1').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#username')).toHaveCount(0);
  mkdirSync('.auth', { recursive: true });
  await page.context().storageState({ path: '.auth/admin.json' });
});
