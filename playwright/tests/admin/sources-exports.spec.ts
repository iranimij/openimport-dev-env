import { Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, magento, services, collectCspViolations, seedProducts, sql, adminCredentials } from '../fixture';

/**
 * M3 scenarios: a URL source and an SFTP source with "Test connection", a schedule, and exports (products to
 * Excel for download, then to the SFTP server). Runs are processed with bin/magento openimport:queue:run.
 */
const suffix = Date.now().toString(36);

const consoleLog: string[] = [];
let lastFields = '';
const fieldsLog: string[] = [];

async function openNewProfile(page: Page, name: string, entity: string, direction = 'import'): Promise<void> {
  consoleLog.length = 0;
  page.on('console', (message) => consoleLog.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => consoleLog.push(`pageerror: ${error.message}`));
  page.on('response', async (response) => {
    if (response.url().includes('/openimport/profile/fields')) {
      const sent = (response.request().postData() || '').replace(/form_key=[^&]*&?/, '').slice(0, 300);
      lastFields = (await response.text().catch(() => '')).slice(0, 600);
      fieldsLog.push(`${new Date().toISOString()} sent ${sent} → ${lastFields.slice(0, 200)}`);
    }
  });
  await page.goto('/admin/openimport/profile/new/');
  await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
  await page.locator('input[name="name"]').fill(name);
  if (direction !== 'import') {
    await page.locator('select[name="direction"]').selectOption(direction);
  }
  await page.locator('select[name="entity"]').selectOption(entity);
}

async function saveAndDryRun(page: Page): Promise<number> {
  await page.getByRole('button', { name: 'Save and dry run' }).click();
  await page.waitForURL(/openimport\/run\/view\/id\/(\d+)/, { timeout: 60_000 });
  return Number(page.url().match(/\/id\/(\d+)/)![1]);
}

async function processQueue(page: Page): Promise<void> {
  magento('openimport:queue:run');
  await page.reload();
}

async function testConnection(page: Page, expected: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.locator('.openimport-test-source .message')).toContainText(expected, { timeout: 60_000 });
}

/** Auto-match with diagnostics (console, fields answer, mapping markup) when the notice does not appear. */
async function autoMatch(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Auto-match' }).click();
  try {
    await expect(page.locator('.openimport-mapping .message-notice')).toContainText('matched');
  } catch (error) {
    const html = await page.locator('.openimport-mapping').innerHTML().catch(() => '(no .openimport-mapping)');
    const text = `Auto-match showed no notice.\nConsole:\n${consoleLog.slice(-30).join('\n')}\nFields requests:\n${fieldsLog.join('\n')}\nMapping: ${html.slice(0, 1500)}`;
    mkdirSync(resolve(__dirname, '../../diagnostics'), { recursive: true });
    writeFileSync(resolve(__dirname, '../../diagnostics/automatch.txt'), text);
    throw new Error(text);
  }
  await expect(page.locator('.openimport-mapping-table tbody tr').first()).toBeVisible();
}

test.describe.serial('OpenImport sources and exports', () => {
  test.setTimeout(180_000);

  test('a web address as source: test connection, dry run with the downloaded file', async ({ page }) => {
    const violations = collectCspViolations(page);
    await openNewProfile(page, `URL ${suffix}`, 'openimport_stock_price');
    await page.locator('select[name="source_type"]').selectOption('url');
    await page.locator('input[name="source_config[url]"]:visible').fill(`${services.filesUrl}/stock-de.csv`);
    await testConnection(page, 'Downloaded stock-de.csv');

    // Private addresses are refused unless allowed (the fixture allows its own services only).
    await page.locator('input[name="source_config[url]"]:visible').fill('http://169.254.169.254/latest/meta-data/');
    await testConnection(page, 'private or local address');
    await page.locator('input[name="source_config[url]"]:visible').fill(`${services.filesUrl}/stock-de.csv`);

    // "Test connection" also loads the first rows, so the mapping step can auto-match.
    await expect(page.locator('.openimport-sample table')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.openimport-sample thead')).toContainText('Preis');
    await autoMatch(page);

    await saveAndDryRun(page);
    await processQueue(page);
    await expect(page.locator('.openimport-run')).toContainText(/Dry run|Nothing to import/, { timeout: 60_000 });
    await expect(page.locator('.openimport-run')).toContainText('stock-de.csv');
    expect(violations).toEqual([]);
  });

  test('an SFTP folder as source with a file pattern', async ({ page }) => {
    await openNewProfile(page, `SFTP ${suffix}`, 'catalog_product');
    await page.locator('select[name="source_type"]').selectOption('sftp');
    await page.locator('input[name="source_config[host]"]:visible').fill(services.sftpHost);
    await page.locator('input[name="source_config[port]"]:visible').fill(services.sftpPort);
    await page.locator('input[name="source_config[username]"]:visible').fill('openimport');
    await page.locator('input[name="source_config[password]"]:visible').fill('openimport-sftp');
    await page.locator('input[name="source_config[path]"]:visible').fill('fixtures');
    await page.locator('input[name="source_config[pattern]"]:visible').fill('products-*.csv');
    await testConnection(page, /the next run reads products-small\.csv/);

    await page.locator('input[name="source_config[password]"]:visible').fill('wrong');
    await testConnection(page, 'login was refused');
  });

  test('a schedule is saved and shown in the grid', async ({ page }) => {
    const name = `Nightly ${suffix}`;
    await openNewProfile(page, name, 'catalog_product');
    await page.getByRole('button', { name: 'Add field' }).click();
    await page.locator('.openimport-mapping-table tbody tr').last().getByRole('textbox', { name: 'Other Magento field (code)' }).fill('sku');
    await page.locator('.fieldset-wrapper-title', { hasText: '6 · When' }).click();
    await page.locator('select[name="schedule_preset"]').selectOption('custom');
    await page.locator('input[name="schedule_custom"]').fill('30 2 * * 1-5');
    await page.locator('input[name="is_active"] + label').click(); // Magento toggle: the label is the switch
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.message-success')).toContainText('saved', { timeout: 60_000 });
    await page.goto('/admin/openimport/profile/index/');
    const row = page.locator('.data-grid tr', { hasText: name });
    await expect(row).toContainText('30 2 * * 1-5', { timeout: 60_000 });
    expect(magento('openimport:profile:list')).toContain('30 2 * * 1-5');
  });

  test('products to Excel: every column, a renamed price, download from the run page, then SFTP', async ({ page }) => {
    const violations = collectCspViolations(page);
    expect(seedProducts(suffix), 'seed products through the CLI').toMatch(/success|partial/i);
    await openNewProfile(page, `Export ${suffix}`, 'catalog_product', 'export');
    await expect(page.locator('select[name="source_type"]')).toBeHidden();
    await page.locator('select[name="format"]').selectOption('xlsx');
    await page.locator('select[name="export_options[destination]"]').selectOption('download');
    await page.locator('input[name="export_options[file_name]"]:visible').fill('products-{date}.{ext}');
    await page.getByRole('button', { name: 'Add every column' }).click();
    const rows = page.locator('.openimport-mapping-table tbody tr');
    await expect(rows.first()).toBeVisible();
    const price = rows.filter({ has: page.locator('select', { hasText: 'price' }) }).first();
    await page.getByRole('button', { name: 'Add field' }).click();
    const custom = rows.last();
    await custom.getByRole('textbox', { name: 'Column in the file' }).fill('Preis');
    await custom.getByRole('combobox', { name: 'Magento column' }).selectOption('price');
    await custom.getByRole('combobox', { name: 'Add a transform' }).selectOption({ label: 'Number' });
    const inputs = custom.locator('.openimport-add-transform input');
    await inputs.nth(0).fill('2');
    await inputs.nth(1).fill(',');
    await custom.locator('.openimport-add-transform').getByRole('button', { name: 'Add' }).click();

    const runId = await saveAndDryRun(page);
    await processQueue(page);
    await expect(page.locator('.openimport-run')).toContainText('Dry run:', { timeout: 60_000 });
    await expect(page.locator('.openimport-run')).toContainText('not delivered');
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download the export' }).click();
    const path = await (await download).path();
    expect(readFileSync(path).subarray(0, 2).toString('latin1')).toBe('PK');
    expect(runId).toBeGreaterThan(0);

    // The same profile to the SFTP server, for real.
    await page.getByRole('link', { name: 'Edit profile' }).click();
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('select[name="export_options[destination]"]').selectOption('sftp');
    await page.locator('input[name="export_options[host]"]:visible').fill(services.sftpHost);
    await page.locator('input[name="export_options[port]"]:visible').fill(services.sftpPort);
    await page.locator('input[name="export_options[username]"]:visible').fill('openimport');
    await page.locator('input[name="export_options[password]"]:visible').fill('openimport-sftp');
    await page.locator('input[name="export_options[path]"]:visible').fill('out');
    const second = await saveAndDryRun(page);
    expect(second).toBeGreaterThan(runId);
    await processQueue(page);
    await expect(page.locator('.openimport-run')).toContainText('not delivered', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Run for real' }).click();
    await page.waitForURL((url) => !url.pathname.includes(`/id/${second}/`), { timeout: 60_000 });
    await processQueue(page);
    await expect(page.locator('.openimport-run')).toContainText('Uploaded to', { timeout: 60_000 });
    expect(violations).toEqual([]);
  });

  test('German admin locale: grids and the form are translated', async ({ page }) => {
    const user = adminCredentials().user.replace(/'/g, "''");
    sql(`UPDATE admin_user SET interface_locale = 'de_DE' WHERE username = '${user}'`);
    // Magento caches UI component labels per configuration, not per locale (core behaviour): clean it.
    magento('cache:clean', 'config');
    try {
      await page.goto('/admin/openimport/profile/index/');
      const grid = page.locator('.data-grid').filter({ has: page.locator('tbody td') }).first();
      await expect(grid).toContainText('Letzter Lauf', { timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Profil hinzufügen' })).toBeVisible();
      await page.goto('/admin/openimport/profile/new/');
      await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Feld hinzufügen' })).toBeVisible();
    } finally {
      sql(`UPDATE admin_user SET interface_locale = 'en_US' WHERE username = '${user}'`);
      magento('cache:clean', 'config');
    }
  });
});
