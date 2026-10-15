import { Page } from '@playwright/test';
import { test, expect, magento, sql, collectCspViolations } from '../fixture';

/**
 * 1.1 entities through the admin: categories from a German file (auto-match, dry run, run for real, store-view name),
 * CMS blocks, and the REST trigger's admin side (a run started by the API shows up in the run grid).
 */
const suffix = Date.now().toString(36);

async function openNewProfile(page: Page, name: string, entity: string): Promise<void> {
  await page.goto('/admin/openimport/profile/new/');
  await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
  await page.locator('input[name="name"]').fill(name);
  await page.locator('select[name="entity"]').selectOption(entity);
}

async function upload(page: Page, name: string, content: string): Promise<void> {
  const response = page.waitForResponse((r) => r.url().includes('/openimport/profile/upload'), { timeout: 60_000 });
  await page.locator('.openimport-upload input[type="file"]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content) });
  expect((await response).status()).toBe(200);
  await expect(page.locator('.openimport-sample table')).toBeVisible({ timeout: 30_000 });
}

async function autoMatch(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Auto-match' }).click();
  await expect(page.locator('.openimport-mapping .message-notice')).toContainText('matched');
}

async function saveDryRunAndProcess(page: Page): Promise<number> {
  await page.getByRole('button', { name: 'Save and dry run' }).click();
  await page.waitForURL(/openimport\/run\/view\/id\/(\d+)/, { timeout: 60_000 });
  const runId = Number(page.url().match(/\/id\/(\d+)/)![1]);
  magento('openimport:queue:run');
  await page.reload();
  return runId;
}

async function runForReal(page: Page): Promise<void> {
  const before = page.url();
  await page.getByRole('button', { name: 'Run for real' }).click();
  await page.waitForURL((url) => url.toString() !== before && /openimport\/run\/view\/id\/\d+/.test(url.toString()), { timeout: 60_000 });
  magento('openimport:queue:run');
  await page.reload();
}

/** The run succeeded; otherwise the run's own errors in the failure message. */
async function expectSuccess(page: Page): Promise<void> {
  const runId = Number(page.url().match(/\/id\/(\d+)/)![1]);
  const errors = sql(`SELECT CONCAT(source_row, ' ', field, ': ', message) FROM openimport_run_error WHERE run_id = ${runId} LIMIT 10`).map((row) => row[0]).join(' | ')
    // What Magento holds for this test's categories (a failed category run explains itself).
    + ' || rewrites: ' + sql(`SELECT CONCAT(url_rewrite_id, ':', entity_type, '#', entity_id, ' ', request_path, ' s', store_id) FROM url_rewrite WHERE request_path LIKE 'oi-${suffix}%' ORDER BY url_rewrite_id LIMIT 20`).map((row) => row[0]).join(', ')
    + ' || categories: ' + sql(`SELECT CONCAT(e.entity_id, ' ', e.path, ' L', e.level, ' ', v.store_id, '=', v.value) FROM catalog_category_entity e JOIN catalog_category_entity_varchar v ON v.entity_id = e.entity_id JOIN eav_attribute a ON a.attribute_id = v.attribute_id AND a.attribute_code IN ('name', 'url_key', 'url_path') WHERE e.entity_id >= (SELECT entity_id FROM catalog_category_entity_varchar WHERE value = 'OI ${suffix}' LIMIT 1) ORDER BY e.entity_id LIMIT 30`).map((row) => row[0]).join(', ');
  await expect(page.locator('.openimport-run'), `run ${runId} errors: ${errors}`).toContainText(/Success|Erfolgreich/, { timeout: 60_000 });
}

test.describe.serial('OpenImport 1.1 entities', () => {
  test.setTimeout(180_000);

  test('categories from a German file: auto-match, dry run with preview, run for real, store-view name', async ({ page }) => {
    const violations = collectCspViolations(page);
    const root = sql('SELECT v.value FROM catalog_category_entity e JOIN catalog_category_entity_varchar v ON v.entity_id = e.entity_id AND v.store_id = 0 JOIN eav_attribute a ON a.attribute_id = v.attribute_id AND a.attribute_code = \'name\' WHERE e.level = 1 ORDER BY e.entity_id LIMIT 1')[0][0];
    await openNewProfile(page, `Categories ${suffix}`, 'openimport_category');
    await upload(page, 'kategorien.csv', `Kategoriepfad;Aktiv;name_de\n${root}/OI ${suffix}/Shoes;1;Schuhe\n${root}/OI ${suffix}/Jackets;0;Jacken\n`);
    await autoMatch(page);
    await saveDryRunAndProcess(page);
    await expect(page.locator('.openimport-run')).toContainText('Dry run', { timeout: 60_000 });
    await expect(page.locator('.openimport-run')).toContainText(`OI ${suffix}/Shoes`);
    expect(sql(`SELECT COUNT(*) FROM catalog_category_entity_varchar WHERE value = 'OI ${suffix}'`)).toEqual([['0']]);

    await runForReal(page);
    await expectSuccess(page);
    const german = sql(`SELECT v.value FROM catalog_category_entity_varchar v JOIN store s ON s.store_id = v.store_id AND s.code = 'de' JOIN eav_attribute a ON a.attribute_id = v.attribute_id AND a.attribute_code = 'name' JOIN catalog_category_entity_varchar d ON d.entity_id = v.entity_id AND d.store_id = 0 AND d.attribute_id = a.attribute_id AND d.value = 'Shoes'`);
    expect(german.map((row) => row[0])).toContain('Schuhe');
    expect(violations).toEqual([]);
  });

  test('CMS blocks: upload, dry run, run for real', async ({ page }) => {
    await openNewProfile(page, `Blocks ${suffix}`, 'openimport_cms_block');
    await upload(page, 'blocks.csv', `identifier,title,content,active,stores\noi-${suffix}-promo,Promo,<p>Free shipping</p>,1,all\n`);
    await autoMatch(page);
    await saveDryRunAndProcess(page);
    await expect(page.locator('.openimport-run')).toContainText('Dry run', { timeout: 60_000 });
    await runForReal(page);
    await expectSuccess(page);
    expect(sql(`SELECT content FROM cms_block WHERE identifier = 'oi-${suffix}-promo'`)).toEqual([['<p>Free shipping</p>']]);
  });
});
