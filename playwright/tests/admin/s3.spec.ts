import { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test, expect, collectCspViolations, sql } from '../fixture';

/**
 * 1.4 slice 2: a saved S3 connection to an S3-compatible server and a profile that reads its file from the bucket.
 * CI starts the server and sets OI_S3 = "endpoint|access key|secret key|bucket" (the bucket holds
 * feeds/products-small.csv); without it the spec is skipped.
 */
const suffix = Date.now().toString(36);
const [endpoint, accessKey, secretKey, bucket] = (process.env.OI_S3 ?? '').split('|');
const connectionName = `Fixture bucket ${suffix}`;

async function noSeriousAxeViolations(page: Page, selector = '#container'): Promise<void> {
  const axe = await new AxeBuilder({ page }).include(selector).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
}

async function testConnection(page: Page, expected: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.locator('.openimport-test-source .message')).toContainText(expected, { timeout: 60_000 });
}

test.describe.serial('OpenImport S3 storage', () => {
  test.skip(!process.env.OI_S3, 'OI_S3 is set where an S3-compatible server runs (CI)');
  test.setTimeout(180_000);

  test('a saved S3 connection: wrong secret, then connected', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/connection/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('input[name="name"]').fill(connectionName);
    await page.locator('select[name="type"]').selectOption('s3');
    await expect(page.locator('input[name="settings[host]"]')).toBeHidden();
    await page.locator('input[name="settings[bucket]"]').fill(bucket);
    await page.locator('input[name="settings[region]"]').fill('us-east-1');
    await page.locator('input[name="settings[endpoint]"]').fill(endpoint);
    await page.locator('input[name="settings[path_style]"] + label').click(); // Magento toggle: the label is the switch
    await page.locator('input[name="settings[access_key]"]').fill(accessKey);
    await page.locator('input[name="settings[secret_key]"]').fill('not-the-secret');
    await testConnection(page, 'the secret key does not fit the access key');
    await page.locator('input[name="settings[secret_key]"]').fill(secretKey);
    await testConnection(page, `Connected to bucket ${bucket}`);
    await noSeriousAxeViolations(page);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.message-success')).toContainText(`The connection "${connectionName}" was saved.`, { timeout: 60_000 });
    const grid = page.locator('.data-grid').filter({ has: page.locator('tbody td') }).first();
    await expect(grid.locator('tr', { hasText: connectionName })).toContainText(`${bucket} @ ${endpoint}`, { timeout: 60_000 });
    const stored = sql(`SELECT settings FROM openimport_connection WHERE name = '${connectionName}'`)[0][0];
    expect(stored).not.toContain(secretKey);
    expect(violations).toEqual([]);
  });

  test('a profile reads its file from the bucket', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/profile/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('input[name="name"]').fill(`From a bucket ${suffix}`);
    await page.locator('select[name="entity"]').selectOption('catalog_product');
    await page.locator('select[name="source_type"]').selectOption('s3');
    // S3 always uses a saved connection: there is no "enter the login here".
    const login = page.locator('select[name="source_config[connection_id]"]');
    await expect(login.locator('option', { hasText: 'Enter the login here' })).toHaveCount(0);
    await login.selectOption({ label: connectionName });
    await page.locator('input[name="source_config[path]"]:visible').fill('feeds');
    await page.locator('input[name="source_config[pattern]"]:visible').fill('products-*.csv');
    await testConnection(page, /the next run reads products-small\.csv/);
    await expect(page.locator('.openimport-sample thead')).toContainText('name_de', { timeout: 30_000 });
    expect(violations).toEqual([]);
  });
});
