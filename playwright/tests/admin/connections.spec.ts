import { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { test, expect, magento, magentoRoot, services, collectCspViolations, sql } from '../fixture';

/**
 * 1.4 slice 1: a saved SFTP connection (form, Test connection, grid), used by a profile instead of its own login,
 * named in a profile file, and kept while a profile uses it.
 */
const suffix = Date.now().toString(36);
const connectionName = `Fixture SFTP ${suffix}`;

async function noSeriousAxeViolations(page: Page, selector = '#container'): Promise<void> {
  const axe = await new AxeBuilder({ page }).include(selector).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
}

async function testConnection(page: Page, expected: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.locator('.openimport-test-source .message')).toContainText(expected, { timeout: 60_000 });
}

test.describe.serial('OpenImport saved connections', () => {
  test.setTimeout(180_000);

  test('a saved SFTP connection: test, save, listed in the grid', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/connection/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('input[name="name"]').fill(connectionName);
    await page.locator('select[name="type"]').selectOption('sftp');
    await page.locator('input[name="settings[host]"]').fill(services.sftpHost);
    await page.locator('input[name="settings[port]"]').fill(services.sftpPort);
    await page.locator('input[name="settings[username]"]:visible').fill('openimport');
    await page.locator('input[name="settings[password]"]:visible').fill('wrong');
    await testConnection(page, 'login was refused');
    await page.locator('input[name="settings[password]"]:visible').fill('openimport-sftp');
    await testConnection(page, /Connected to .+\. The login folder has \d+ file\(s\)\./);
    await noSeriousAxeViolations(page);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.message-success')).toContainText(`The connection "${connectionName}" was saved.`, { timeout: 60_000 });
    const grid = page.locator('.data-grid').filter({ has: page.locator('tbody td') }).first();
    await expect(grid).toContainText(connectionName, { timeout: 60_000 });
    await expect(grid).toContainText(`openimport@${services.sftpHost}:${services.sftpPort}`);
    await noSeriousAxeViolations(page);

    // The password is stored encrypted.
    const stored = sql(`SELECT settings FROM openimport_connection WHERE name = '${connectionName}'`)[0][0];
    expect(stored).not.toContain('openimport-sftp');
    expect(violations).toEqual([]);
  });

  test('a profile reads from the saved connection without its own login', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/profile/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('input[name="name"]').fill(`Via connection ${suffix}`);
    await page.locator('select[name="entity"]').selectOption('catalog_product');
    await page.locator('select[name="source_type"]').selectOption('sftp');
    await expect(page.locator('input[name="source_config[host]"]')).toBeVisible();
    await page.locator('select[name="source_config[connection_id]"]').selectOption({ label: connectionName });
    await expect(page.locator('input[name="source_config[host]"]')).toBeHidden();
    // Two password fields share the name (URL login and server login): none is shown.
    await expect(page.locator('input[name="source_config[password]"]:visible')).toHaveCount(0);
    await page.locator('input[name="source_config[path]"]:visible').fill('fixtures');
    await page.locator('input[name="source_config[pattern]"]:visible').fill('products-*.csv');
    await testConnection(page, /the next run reads products-small\.csv/);

    // Back to a login of its own: the fields come back.
    await page.locator('select[name="source_config[connection_id]"]').selectOption({ label: 'Enter the login here' });
    await expect(page.locator('input[name="source_config[host]"]')).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('a profile file names the connection, and a connection in use is kept', async ({ page }) => {
    const profileName = `Connection file ${suffix}`;
    const file = `var/openimport-connection-${suffix}.json`;
    mkdirSync(resolve(magentoRoot, 'var'), { recursive: true });
    writeFileSync(resolve(magentoRoot, file), JSON.stringify({ openimport: 1, profiles: [{
      name: profileName, direction: 'import', entity: 'catalog_product', is_active: false,
      source_type: 'sftp', source_config: { connection: connectionName, path: 'fixtures', pattern: 'products-*.csv' },
      format: 'csv', behavior: 'add_update', on_error: 'stop', allowed_errors: 0,
      mapping: [
        { target: 'sku', source: 'sku', transforms: [] },
        { target: 'name', source: 'name', transforms: [] },
        { target: 'attribute_set_code', static: 'Default', transforms: [] },
        { target: 'product_type', static: 'simple', transforms: [] },
        { target: 'product_websites', static: 'base', transforms: [] },
      ],
    }] }));
    magento('openimport:profiles:import', file);
    const config = sql(`SELECT source_config FROM openimport_profile WHERE name = '${profileName}'`)[0][0];
    expect(config).toContain('"connection_id"');
    expect(config).not.toContain(connectionName);

    await page.goto('/admin/openimport/connection/index/');
    const grid = page.locator('.data-grid').filter({ has: page.locator('tbody td') }).first();
    await expect(grid.locator('tr', { hasText: connectionName })).toContainText(profileName, { timeout: 60_000 });
    await grid.locator('tr', { hasText: connectionName }).first().click();
    await expect(page.locator('input[name="name"]')).toHaveValue(connectionName, { timeout: 60_000 });
    await expect(page.locator('#container')).toContainText(`Used by: ${profileName}`);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.locator('.modal-popup._show .action-accept').click();
    await expect(page.locator('.message-error')).toContainText(`is used by ${profileName}`, { timeout: 60_000 });
  });
});
