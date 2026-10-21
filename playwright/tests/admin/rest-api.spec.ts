import { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test, expect, collectCspViolations, sql } from '../fixture';

/**
 * 1.4 slice 5: a saved REST connection (API key in a header) and a profile that pages through the API, against
 * OpenImport's stand-in for a JSON API (CI starts it and sets OI_REST).
 */
const suffix = Date.now().toString(36);
const connectionName = `Fixture API ${suffix}`;

async function noSeriousAxeViolations(page: Page, selector = '#container'): Promise<void> {
  const axe = await new AxeBuilder({ page }).include(selector).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
}

async function testConnection(page: Page, expected: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.locator('.openimport-test-source .message')).toContainText(expected, { timeout: 60_000 });
}

test.describe.serial('OpenImport REST API', () => {
  test.skip(!process.env.OI_REST, 'OI_REST is set where the REST API stand-in runs (CI)');
  test.setTimeout(180_000);

  test('a REST connection with an API key', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/connection/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('input[name="name"]').fill(connectionName);
    await page.locator('select[name="type"]').selectOption('rest');
    await page.locator('input[name="settings[base_url]"]:visible').fill(`${process.env.OI_REST}/v1`);
    await page.locator('select[name="settings[auth_rest]"]').selectOption('header');
    await page.locator('input[name="settings[header_name]"]:visible').fill('X-Api-Key');
    await page.locator('input[name="settings[token]"]:visible').fill('wrong-key');
    await testConnection(page, 'The API refused the login (HTTP 401)');
    await page.locator('input[name="settings[token]"]:visible').fill('key-1');
    await testConnection(page, /Reached http:\/\/127\.0\.0\.1:8092\/v1 \(HTTP 200\)/);
    await noSeriousAxeViolations(page);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.message-success')).toContainText(`The connection "${connectionName}" was saved.`, { timeout: 60_000 });
    const stored = sql(`SELECT settings FROM openimport_connection WHERE name = '${connectionName}'`)[0][0];
    expect(stored).toContain('X-Api-Key');
    expect(stored).not.toContain('key-1');
    expect(violations).toEqual([]);
  });

  test('a profile pages through the API', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/profile/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('input[name="name"]').fill(`From API ${suffix}`);
    await page.locator('select[name="entity"]').selectOption('catalog_product');
    await page.locator('select[name="source_type"]').selectOption('rest');
    await page.locator('select[name="source_config[connection_id]"]').selectOption({ label: connectionName });
    await page.locator('input[name="source_config[path]"]:visible').fill('/products?status=active');
    await page.locator('input[name="source_config[records]"]:visible').fill('data.items');
    await page.locator('select[name="source_config[paging]"]:visible').selectOption('page');
    await testConnection(page, /Connected\. The first page has 2 record\(s\) with the fields sku, name, stock/);
    await expect(page.locator('.openimport-sample thead')).toContainText('sku', { timeout: 30_000 });
    await noSeriousAxeViolations(page);
    expect(violations).toEqual([]);
  });
});
