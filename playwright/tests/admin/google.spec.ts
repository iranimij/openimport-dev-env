import { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { test, expect, collectCspViolations, sql } from '../fixture';

/**
 * 1.4 slice 3: a saved Google Drive connection with a service account key, against OpenImport's stand-in for Google's
 * API. CI starts it and sets OI_GOOGLE = "<key file>|<folder id>" (the folder holds products-small.csv).
 */
const suffix = Date.now().toString(36);
const [keyFile, folder] = (process.env.OI_GOOGLE ?? '').split('|');
const connectionName = `Fixture Drive ${suffix}`;

async function noSeriousAxeViolations(page: Page, selector = '#container'): Promise<void> {
  const axe = await new AxeBuilder({ page }).include(selector).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
}

async function testConnection(page: Page, expected: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.locator('.openimport-test-source .message')).toContainText(expected, { timeout: 60_000 });
}

test.describe.serial('OpenImport Google Drive', () => {
  test.skip(!process.env.OI_GOOGLE, 'OI_GOOGLE is set where the Google API stand-in runs (CI)');
  test.setTimeout(180_000);

  test('a Google connection with a service account key', async ({ page }) => {
    const violations = collectCspViolations(page);
    const key = readFileSync(keyFile, 'utf8');
    await page.goto('/admin/openimport/connection/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('input[name="name"]').fill(connectionName);
    await page.locator('select[name="type"]').selectOption('google_drive');
    await expect(page.locator('select[name="settings[auth_google]"]')).toHaveValue('service_account');
    await expect(page.locator('input[name="settings[client_id]"]:visible')).toHaveCount(0);
    await page.locator('textarea[name="settings[service_account_json]"]').fill(key);
    await testConnection(page, 'Connected to Google Drive');
    await noSeriousAxeViolations(page);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.message-success')).toContainText(`The connection "${connectionName}" was saved.`, { timeout: 60_000 });
    const stored = sql(`SELECT settings FROM openimport_connection WHERE name = '${connectionName}'`)[0][0];
    expect(stored).toContain('e2e@openimport-e2e.iam.gserviceaccount.com');
    expect(stored).not.toContain('PRIVATE KEY');

    // The form names the account to share folders with; the key never comes back.
    await page.locator('.data-grid tr', { hasText: connectionName }).first().click();
    await expect(page.locator('#container')).toContainText('e2e@openimport-e2e.iam.gserviceaccount.com', { timeout: 60_000 });
    await expect(page.locator('textarea[name="settings[service_account_json]"]')).toHaveValue('');

    // A Google account login shows its redirect URI and asks to save before signing in.
    await page.locator('select[name="settings[auth_google]"]').selectOption('oauth');
    await expect(page.locator('#container')).toContainText('openimport/connection/oauthCallback');
    expect(violations).toEqual([]);
  });

  test('a profile reads its file from a Drive folder', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/profile/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('input[name="name"]').fill(`From Drive ${suffix}`);
    await page.locator('select[name="entity"]').selectOption('catalog_product');
    await page.locator('select[name="source_type"]').selectOption('google_drive');
    await page.locator('select[name="source_config[connection_id]"]').selectOption({ label: connectionName });
    await page.locator('input[name="source_config[path]"]:visible').fill(`https://drive.google.com/drive/folders/${folder}?usp=sharing`);
    await page.locator('input[name="source_config[pattern]"]:visible').fill('products-*.csv');
    await testConnection(page, /the next run reads products-small\.csv/);
    await expect(page.locator('.openimport-sample thead')).toContainText('name_de', { timeout: 30_000 });
    expect(violations).toEqual([]);
  });
});
