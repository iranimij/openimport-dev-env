import { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, magento, magentoRoot, collectCspViolations, seedProducts, sql } from '../fixture';

/**
 * 1.3 slices 5–8: URL keys from a pattern, conditional transforms in the mapping editor, several files per run and
 * presets.
 */
const suffix = Date.now().toString(36);
const files = resolve(__dirname, '../../../fixtures/files');

function cliProfile(profile: Record<string, unknown>): void {
  mkdirSync(resolve(magentoRoot, 'var'), { recursive: true });
  const file = `var/openimport-helpers-${suffix}-${String(profile.name).replace(/[^a-z0-9]+/gi, '-')}.json`;
  writeFileSync(resolve(magentoRoot, file), JSON.stringify({ openimport: 1, profiles: [profile] }));
  magento('openimport:profiles:import', file);
}

function runCli(...args: string[]): string {
  try {
    return magento('openimport:run', ...args);
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? error);
  }
}

const productMapping = [
  { target: 'sku', source: 'sku', transforms: [] },
  { target: 'name', source: 'name', transforms: [] },
  { target: 'price', static: '5', transforms: [] },
  { target: 'attribute_set_code', static: 'Default', transforms: [] },
  { target: 'product_type', static: 'simple', transforms: [] },
  { target: 'product_websites', static: 'base', transforms: [] },
  { target: 'visibility', static: 'Catalog, Search', transforms: [] },
];

async function mappingRow(page: Page, field: string) {
  const rows = page.locator('.openimport-mapping-table tbody tr');
  const index = await rows.evaluateAll((elements, wanted) => elements.findIndex((row) => {
    const input = row.querySelector('input.openimport-mapping-other') as HTMLInputElement | null;
    return input?.value === wanted;
  }), field);
  expect(index, `mapping row for ${field}`).toBeGreaterThanOrEqual(0);
  return rows.nth(index);
}

test.describe.serial('OpenImport catalog helpers', () => {
  test.setTimeout(180_000);

  test('URL keys from a pattern', async () => {
    const sku = `OI-E2E-URL-${suffix}`;
    cliProfile({
      name: `URL keys ${suffix}`, direction: 'import', entity: 'catalog_product', is_active: false,
      source_type: 'upload', format: 'csv', behavior: 'add_update', on_error: 'stop', allowed_errors: 0,
      import_options: { url_key_pattern: '{name}-{sku}', url_redirects: '1' }, mapping: productMapping,
    });
    writeFileSync(resolve(magentoRoot, `var/openimport-url-${suffix}.csv`), `sku,name\n${sku},Grüne Jacke\n`);
    expect(runCli(`URL keys ${suffix}`, '--file', `var/openimport-url-${suffix}.csv`)).toContain('URL keys made from the pattern: 1.');
    const key = sql(`SELECT v.value FROM catalog_product_entity_varchar v JOIN catalog_product_entity e ON e.entity_id = v.entity_id
      JOIN eav_attribute a ON a.attribute_id = v.attribute_id AND a.attribute_code = 'url_key' AND a.entity_type_id = 4
      WHERE e.sku = '${sku}' AND v.store_id = 0`)[0][0];
    // Magento's transliteration without a German locale: ü → u.
    expect(key).toBe(`grune-jacke-${sku.toLowerCase()}`);
  });

  test('several files per run: one run per file', async () => {
    const folder = `e2e-multi-${suffix}`;
    mkdirSync(resolve(magentoRoot, `var/openimport/${folder}`), { recursive: true });
    writeFileSync(resolve(magentoRoot, `var/openimport/${folder}/part-1.csv`), `sku,name\nOI-E2E-MF1-${suffix},First ${suffix}\n`);
    writeFileSync(resolve(magentoRoot, `var/openimport/${folder}/part-2.csv`), `sku,name\nOI-E2E-MF2-${suffix},Second ${suffix}\n`);
    cliProfile({
      name: `Multi ${suffix}`, direction: 'import', entity: 'catalog_product', is_active: false,
      source_type: 'folder', source_config: { path: folder, pattern: 'part-*.csv', pick: 'all' },
      after_success: 'move', format: 'csv', behavior: 'add_update', on_error: 'stop', allowed_errors: 0,
      mapping: productMapping,
    });
    expect(runCli(`Multi ${suffix}`)).toMatch(/File 1 of 2: part-1\.csv\. The other files are queued as runs \d+\./);
    magento('openimport:queue:run');
    expect(sql(`SELECT COUNT(*) FROM catalog_product_entity WHERE sku IN ('OI-E2E-MF1-${suffix}', 'OI-E2E-MF2-${suffix}')`)[0][0]).toBe('2');
  });

  test('a transform that only runs when a condition holds', async ({ page }) => {
    seedProducts(`helpers-${suffix}`);
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/profile/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('input[name="name"]').fill(`Only when ${suffix}`);
    await page.locator('select[name="entity"]').selectOption('openimport_stock_price');
    const answer = page.waitForResponse((r) => r.url().includes('/openimport/profile/upload'), { timeout: 60_000 });
    await page.locator('.openimport-upload input[type="file"]').setInputFiles(resolve(files, 'stock-de.csv'));
    await answer;
    await expect(page.locator('.openimport-sample table')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Auto-match' }).click();
    const price = await mappingRow(page, 'price');
    await price.getByRole('textbox', { name: 'Only when (optional)' }).fill("{Artikelnummer} = 'OI-FIX-1'");
    await price.getByRole('combobox', { name: 'Add a transform' }).selectOption({ label: 'Change price by %' });
    await price.locator('.openimport-add-transform input').first().fill('100');
    await price.locator('.openimport-add-transform').getByRole('button', { name: 'Add' }).click();
    await expect(price.locator('.openimport-chip').last()).toContainText("only when {Artikelnummer} = 'OI-FIX-1'");

    await page.getByRole('button', { name: 'Save and dry run' }).click();
    await page.waitForURL(/openimport\/run\/view\/id\/(\d+)/, { timeout: 60_000 });
    magento('openimport:queue:run');
    await page.reload();
    const preview = page.locator('.openimport-run table').first();
    await expect(preview).toContainText('39.8');
    await expect(preview).not.toContainText('49');
    expect(violations).toEqual([]);
  });

  test('a profile from the Shopify preset', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/profile/importJson/');
    await expect(page.getByRole('heading', { name: 'Or start from a preset' })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Shopify products', exact: true }).click();
    await page.waitForURL(/openimport\/profile\/edit\/id\/\d+/, { timeout: 60_000 });
    await expect(page.locator('.message-success')).toContainText('created from the preset');
    await expect(page.locator('.message-notice')).toContainText('Variants without a SKU');
    await expect(page.locator('input[name="name"]')).toHaveValue(/^Shopify products/);
    expect(violations).toEqual([]);
  });
});
