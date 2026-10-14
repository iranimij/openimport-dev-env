import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, magento, sql, collectCspViolations } from '../fixture';

/**
 * M2 admin scenarios (08 · UX Spec §7, the ones that need no SFTP or schedules):
 * - a product file with a German store-view column, through upload, auto-match, dry run and Run for real (2);
 * - a price +15 % with .99 endings through transform chips, checked in the preview (3);
 * - 3 bad rows and the error report with the original rows (7);
 * - Delete above the safety limit and its typed confirmation (4);
 * - keyboard use of the mapping step, axe-core and CSP on every OpenImport page (8).
 *
 * Runs are processed with bin/magento openimport:queue:run (what the cron will do every minute).
 */
const files = resolve(__dirname, '../../../fixtures/files');
const suffix = Date.now().toString(36);

async function noSeriousAxeViolations(page: Page, selector = '#anchor-content'): Promise<void> {
  const axe = await new AxeBuilder({ page }).include(selector).analyze();
  const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
}

async function openNewProfile(page: Page, name: string, entity: string): Promise<void> {
  consoleLog.length = 0;
  page.on('console', (message) => consoleLog.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => consoleLog.push(`pageerror: ${error.message}`));
  await page.goto('/admin/openimport/profile/new/');
  await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
  await page.locator('input[name="name"]').fill(name);
  await page.locator('select[name="entity"]').selectOption(entity);
}

const consoleLog: string[] = [];

async function upload(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  const response = page.waitForResponse((r) => r.url().includes('/openimport/profile/upload'), { timeout: 60_000 });
  await page.locator('.openimport-upload input[type="file"]').setInputFiles(file);
  const answer = await response;
  const body = await answer.text();
  expect(answer.status(), `upload answer: ${body.slice(0, 800)}`).toBe(200);
  expect(body.startsWith('{') && !('error' in JSON.parse(body)), `upload answer: ${body.slice(0, 800)}`).toBe(true);
  try {
    await expect(page.locator('.openimport-upload .admin__field-note strong')).not.toBeEmpty({ timeout: 20_000 });
  } catch (error) {
    const html = await page.locator('.openimport-upload').innerHTML();
    const text = `The upload field did not show the file name.\nConsole:\n${consoleLog.slice(-30).join('\n')}\nAnswer: ${body.slice(0, 1500)}\nField: ${html.slice(0, 2000)}`;
    mkdirSync(resolve(__dirname, '../../diagnostics'), { recursive: true });
    writeFileSync(resolve(__dirname, '../../diagnostics/upload.txt'), text);
    throw new Error(text);
  }
  await expect(page.locator('.openimport-sample table')).toBeVisible({ timeout: 30_000 });
}

/** Index of the mapping row whose Magento field is `field` (fields are typed into a text input too). */
async function mappingRow(page: Page, field: string, store = '') {
  const rows = page.locator('.openimport-mapping-table tbody tr');
  const index = await rows.evaluateAll((elements, wanted) => elements.findIndex((row) => {
    const input = row.querySelector('input.openimport-mapping-other') as HTMLInputElement | null;
    const selects = row.querySelectorAll('select');
    const storeSelect = selects.length > 3 ? selects[1] as HTMLSelectElement : null;
    return input?.value === wanted.field && (storeSelect === null || storeSelect.value === wanted.store);
  }), { field, store });
  expect(index, `mapping row for ${field}`).toBeGreaterThanOrEqual(0);
  return rows.nth(index);
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

test.describe.serial('OpenImport admin', () => {
  test.setTimeout(180_000);

  let productProfile = '';

  test('products with a German store-view column: upload, auto-match, dry run, run for real', async ({ page }) => {
    const violations = collectCspViolations(page);
    productProfile = `Products ${suffix}`;
    await openNewProfile(page, productProfile, 'catalog_product');
    await upload(page, resolve(files, 'products-small.csv'));
    await expect(page.locator('.openimport-sample thead')).toContainText('name_de');

    await page.getByRole('button', { name: 'Auto-match' }).click();
    await expect(page.locator('.openimport-mapping .message-notice')).toContainText('matched');
    await page.getByRole('button', { name: 'Add required fields' }).click();
    for (const [field, value] of [['attribute_set_code', 'Default'], ['product_type', 'simple'], ['product_websites', 'base']]) {
      const row = await mappingRow(page, field);
      await row.getByRole('textbox', { name: 'Fixed value' }).fill(value);
    }
    // name_de was matched to the German store view.
    await mappingRow(page, 'name', 'de');

    await page.getByRole('button', { name: 'Preview the first rows' }).click();
    await expect(page.locator('.openimport-preview table')).toContainText('Trailschuh', { timeout: 30_000 });
    await noSeriousAxeViolations(page, '.openimport-mapping');

    const runId = await saveAndDryRun(page);
    await processQueue(page);
    await expect(page.locator('.openimport-run')).toContainText('What would change');
    await expect(page.locator('.openimport-count', { hasText: 'Will be created' })).toContainText('3');
    await expect(page.locator('.openimport-run table').first()).toContainText('Regenjacke');
    await noSeriousAxeViolations(page);

    await page.getByRole('button', { name: 'Run for real' }).click();
    await page.waitForURL((url) => !url.pathname.includes(`/id/${runId}/`), { timeout: 60_000 });
    await processQueue(page);
    await expect(page.locator('.openimport-run')).toContainText('Success');
    await expect(page.locator('.openimport-count', { hasText: 'Created' })).toContainText('3');
    const names = sql("SELECT v.value FROM catalog_product_entity_varchar v JOIN catalog_product_entity e ON e.entity_id = v.entity_id JOIN store s ON s.store_id = v.store_id JOIN eav_attribute a ON a.attribute_id = v.attribute_id WHERE e.sku = 'OI-FIX-2' AND s.code = 'de' AND a.attribute_code = 'name'");
    expect(names.flat()).toContain('Regenjacke');
    expect(violations).toEqual([]);
  });

  test('stock and prices: +15 % with .99 endings, shown before → after in the dry run', async ({ page }) => {
    const violations = collectCspViolations(page);
    await openNewProfile(page, `Stock ${suffix}`, 'openimport_stock_price');
    await upload(page, resolve(files, 'stock-de.csv'));
    await page.getByRole('button', { name: 'Auto-match' }).click();
    const price = await mappingRow(page, 'price');
    await expect(price.getByRole('combobox', { name: 'Column of the file' })).toHaveValue('Preis');

    const add = async (label: string, args: string[] = []) => {
      await price.getByRole('combobox', { name: 'Add a transform' }).selectOption({ label });
      const inputs = price.locator('.openimport-add-transform input');
      for (let i = 0; i < args.length; i++) {
        await inputs.nth(i).fill(args[i]);
      }
      await price.locator('.openimport-add-transform').getByRole('button', { name: 'Add' }).click();
    };
    await add('Decimal comma → dot');
    await add('Change price by %', ['15']);
    await add('Round', ['2', 'ending', '.99']);
    await expect(price.locator('.openimport-chip')).toHaveCount(3);
    // Reorder with buttons only (no drag): move the rounding up and back down.
    await price.locator('.openimport-chip').nth(2).getByRole('button', { name: 'Move up' }).click();
    await expect(price.locator('.openimport-chip').nth(1)).toContainText('round');
    await price.locator('.openimport-chip').nth(1).getByRole('button', { name: 'Move down' }).click();
    await expect(price.locator('.openimport-chip').nth(2)).toContainText('round');

    await saveAndDryRun(page);
    await processQueue(page);
    const preview = page.locator('.openimport-run table').first();
    await expect(preview).toContainText('22.99');
    await expect(page.locator('.openimport-count', { hasText: 'Will change' })).toContainText('3');
    expect(violations).toEqual([]);
  });

  test('three bad rows: the run imports the rest and the error report has the original rows', async ({ page }) => {
    await openNewProfile(page, `Bad rows ${suffix}`, 'openimport_stock_price');
    await upload(page, {
      name: 'stock-bad.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Artikelnummer;Bestand;Preis\nOI-FIX-1;5;teuer\nOI-FIX-2;6;x\nOI-FIX-3;7;?\n'),
    });
    await page.getByRole('button', { name: 'Auto-match' }).click();
    const price = await mappingRow(page, 'price');
    await price.getByRole('combobox', { name: 'Add a transform' }).selectOption({ label: 'Number' });
    await price.locator('.openimport-add-transform').getByRole('button', { name: 'Add' }).click();
    await page.locator('.fieldset-wrapper-title', { hasText: '5 · Rules' }).click();
    await page.locator('select[name="on_error"]').selectOption('skip');
    await page.locator('input[name="allowed_errors"]').fill('10');

    await saveAndDryRun(page);
    await processQueue(page);
    await expect(page.locator('.openimport-run')).toContainText('Partial');
    await expect(page.locator('.openimport-count', { hasText: 'Errors' })).toContainText('3');
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download error report' }).click();
    const report = readFileSync(await (await download).path(), 'utf8').replace(/^\uFEFF/, '');
    expect(report).toContain('Row,Record,Field,Error,Artikelnummer,Bestand,Preis');
    expect(report.trim().split('\n')).toHaveLength(4);
    expect(report).toContain('teuer');
  });

  test('delete above the safety limit waits for the typed word', async ({ page }) => {
    await openNewProfile(page, `Delete ${suffix}`, 'catalog_product');
    await upload(page, resolve(files, 'products-small.csv'));
    await page.getByRole('button', { name: 'Add field' }).click();
    const row = page.locator('.openimport-mapping-table tbody tr').last();
    await row.getByRole('textbox', { name: 'Other Magento field (code)' }).fill('sku');
    await row.getByRole('combobox', { name: 'Column of the file' }).selectOption('sku');
    await page.locator('.fieldset-wrapper-title', { hasText: '5 · Rules' }).click();
    await page.locator('select[name="behavior"]').selectOption('delete');
    await page.locator('input[name="safety_threshold"]').fill('1');

    await saveAndDryRun(page);
    await processQueue(page);
    await expect(page.locator('.openimport-count', { hasText: 'Will be deleted' })).toContainText('3');
    await page.locator('#openimport-confirmation').fill('delete');
    await page.getByRole('button', { name: 'Run for real' }).click();
    await expect(page.locator('.message-error')).toContainText('Type DELETE to confirm.');
    await page.locator('#openimport-confirmation').fill('DELETE');
    await page.getByRole('button', { name: 'Run for real' }).click();
    await processQueue(page);
    await expect(page.locator('.openimport-run')).toContainText('Success');
    expect(sql("SELECT COUNT(*) FROM catalog_product_entity WHERE sku LIKE 'OI-FIX-%'")).toEqual([['0']]);
  });

  test('grids, keyboard and accessibility', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/profile/index/');
    await expect(page.locator('.data-grid')).toContainText(productProfile, { timeout: 60_000 });
    await expect(page.locator('.data-grid')).toContainText('Run #');
    await noSeriousAxeViolations(page);
    await page.goto('/admin/openimport/run/index/');
    await expect(page.locator('.data-grid')).toContainText('Success', { timeout: 60_000 });
    await noSeriousAxeViolations(page);

    // The mapping step works with the keyboard alone.
    await openNewProfile(page, `Keyboard ${suffix}`, 'catalog_product');
    await upload(page, resolve(files, 'products-small.csv'));
    await page.getByRole('button', { name: 'Add field' }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Preview the first rows' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', { name: 'Magento field' }).last()).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.type('sku');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', { name: 'Store view' }).last()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', { name: 'Column of the file' }).last()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('textbox', { name: 'Fixed value' }).last()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', { name: 'Add a transform' }).last()).toBeFocused();
    await noSeriousAxeViolations(page, '#container');
    expect(violations).toEqual([]);
  });
});
