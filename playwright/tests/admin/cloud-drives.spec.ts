import { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test, expect, collectCspViolations, sql } from '../fixture';

/**
 * 1.4 slice 4: Dropbox and OneDrive connections signed in through OAuth, against OpenImport's stand-in for both
 * APIs (CI starts it and sets OI_CLOUD). The consent page of the stand-in sends the browser straight back with a
 * code, so the whole round trip (state, PKCE, token exchange, account lookup) runs through the real admin pages.
 */
const suffix = Date.now().toString(36);

async function noSeriousAxeViolations(page: Page, selector = '#container'): Promise<void> {
  const axe = await new AxeBuilder({ page }).include(selector).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
}

async function testConnection(page: Page, expected: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.locator('.openimport-test-source .message')).toContainText(expected, { timeout: 60_000 });
}

async function signedInConnection(page: Page, type: 'dropbox' | 'onedrive', name: string, service: string): Promise<void> {
  const violations = collectCspViolations(page);
  await page.goto('/admin/openimport/connection/new/');
  await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
  await page.locator('input[name="name"]').fill(name);
  await page.locator('select[name="type"]').selectOption(type);
  await page.locator('input[name="settings[client_id]"]:visible').fill('client-id');
  await page.locator('input[name="settings[client_secret]"]:visible').fill('client-secret');
  if (type === 'onedrive') {
    await expect(page.locator('input[name="settings[tenant]"]')).toBeVisible();
    await expect(page.locator('input[name="settings[site]"]')).toBeVisible();
  }
  // Not signed in yet: the test says so, the redirect URI is shown, the sign-in link waits for the save.
  await expect(page.locator('#container')).toContainText('openimport/connection/oauthCallback');
  await expect(page.locator('#container')).toContainText('Save the connection with its client ID and client secret, then sign in.');
  await noSeriousAxeViolations(page);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.message-success')).toContainText(`The connection "${name}" was saved.`, { timeout: 60_000 });

  await page.locator('.data-grid tr', { hasText: name }).first().click();
  const signIn = page.getByRole('link', { name: `Sign in with ${service}` });
  await expect(signIn).toBeVisible({ timeout: 60_000 });
  await signIn.click();
  // Consent page of the stand-in → callback → the connection form with the account.
  await expect(page.locator('.message-success')).toContainText(`"${name}" is signed in to ${service} as shop@example.com`, { timeout: 60_000 });
  await expect(page.locator('.openimport-oauth-signin')).toContainText('Signed in as');
  await expect(page.locator('.openimport-oauth-signin')).toContainText('shop@example.com');
  await testConnection(page, /Connected to (Dropbox|OneDrive)/);
  const stored = sql(`SELECT settings FROM openimport_connection WHERE name = '${name}'`)[0][0];
  expect(stored).toContain('shop@example.com');
  expect(stored).not.toContain('refresh-dbx');
  expect(stored).not.toContain('refresh-ms');
  expect(stored).not.toContain('client-secret');
  expect(violations).toEqual([]);
}

async function profileReadsFrom(page: Page, type: 'dropbox' | 'onedrive', connectionName: string): Promise<void> {
  const violations = collectCspViolations(page);
  await page.goto('/admin/openimport/profile/new/');
  await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
  await page.locator('input[name="name"]').fill(`From ${type} ${suffix}`);
  await page.locator('select[name="entity"]').selectOption('catalog_product');
  await page.locator('select[name="source_type"]').selectOption(type);
  await page.locator('select[name="source_config[connection_id]"]').selectOption({ label: connectionName });
  await page.locator('input[name="source_config[path]"]:visible').fill('Supplier/incoming');
  await page.locator('input[name="source_config[pattern]"]:visible').fill('products-*.csv');
  await testConnection(page, /the next run reads products-small\.csv/);
  await expect(page.locator('.openimport-sample thead')).toContainText('name_de', { timeout: 30_000 });
  expect(violations).toEqual([]);
}

test.describe.serial('OpenImport Dropbox and OneDrive', () => {
  test.skip(!process.env.OI_CLOUD, 'OI_CLOUD is set where the cloud API stand-in runs (CI)');
  test.setTimeout(180_000);

  test('a Dropbox connection signs in and a profile reads from it', async ({ page }) => {
    const name = `Fixture Dropbox ${suffix}`;
    await signedInConnection(page, 'dropbox', name, 'Dropbox');
    await profileReadsFrom(page, 'dropbox', name);
  });

  test('a OneDrive connection signs in and a profile reads from it', async ({ page }) => {
    const name = `Fixture OneDrive ${suffix}`;
    await signedInConnection(page, 'onedrive', name, 'Microsoft');
    await profileReadsFrom(page, 'onedrive', name);
  });

  test('a refused consent is reported', async ({ page }) => {
    await page.goto('/admin/openimport/connection/oauthCallback/?error=access_denied&state=nothing');
    await expect(page.locator('.message-error')).toContainText('The sign-in was refused: access_denied', { timeout: 60_000 });
  });
});
