import { APIRequestContext } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, magento, magentoRoot, sql, adminCredentials, collectCspViolations } from '../fixture';

/**
 * 1.6 automation: triggers (step 6 › "Also run when").
 * - An export profile that runs after product saves: set up in the admin, an OpenImport import of products queues
 *   nothing, two product saves through the REST API queue one live run with "Event" as its start, which then exports.
 */
const suffix = Date.now().toString(36);

function queued(profileName: string): string[][] {
  return sql(`SELECT r.run_trigger, r.requested_by, r.mode FROM openimport_run r JOIN openimport_profile p ON p.profile_id = r.profile_id
    WHERE p.name = '${profileName}' AND r.status = 'queued'`);
}

/** Imports two products of this spec's own (other specs count the shared OI-FIX products as new). */
function importProducts(): string {
  const name = `Trigger products ${suffix}`;
  mkdirSync(resolve(magentoRoot, 'var'), { recursive: true });
  writeFileSync(resolve(magentoRoot, `var/openimport-trigger-${suffix}.json`), JSON.stringify({
    openimport: 1,
    profiles: [{
      name, direction: 'import', entity: 'catalog_product', is_active: false, source_type: 'upload', format: 'csv',
      behavior: 'add_update', on_error: 'stop', allowed_errors: 0,
      mapping: [
        { target: 'sku', source: 'sku', transforms: [] },
        { target: 'name', source: 'name', transforms: [] },
        { target: 'price', source: 'price', transforms: [] },
        { target: 'qty', source: 'qty', transforms: [] },
        { target: 'attribute_set_code', static: 'Default', transforms: [] },
        { target: 'product_type', static: 'simple', transforms: [] },
        { target: 'product_websites', static: 'base', transforms: [] },
      ],
    }],
  }));
  writeFileSync(resolve(magentoRoot, `var/openimport-trigger-${suffix}.csv`),
    `sku,name,price,qty\nOI-TRG-${suffix}-1,Trigger one,10,5\nOI-TRG-${suffix}-2,Trigger two,12,3\n`);
  magento('openimport:profiles:import', `var/openimport-trigger-${suffix}.json`);
  return magento('openimport:run', name, '--file', `var/openimport-trigger-${suffix}.csv`);
}

/** Saves a product through Magento's REST API (an admin token; the fixture has two-factor login switched off). */
async function saveProduct(request: APIRequestContext, sku: string, name: string): Promise<void> {
  const { user, password } = adminCredentials();
  const login = await request.post('/rest/V1/integration/admin/token', { data: { username: user, password } });
  expect(login.status(), await login.text()).toBe(200);
  const token = await login.json() as string;
  const saved = await request.put(`/rest/all/V1/products/${encodeURIComponent(sku)}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { product: { sku, name } },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

test.describe.serial('OpenImport 1.6 automation', () => {
  test.setTimeout(240_000);
  const exportName = `After product saves ${suffix}`;

  test('a trigger set up in step 6 shows in the profile grid', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/profile/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('input[name="name"]').fill(exportName);
    await page.locator('select[name="direction"]').selectOption('export');
    await page.locator('select[name="entity"]').selectOption('catalog_product');
    await page.locator('select[name="format"]').selectOption('csv');
    await page.locator('select[name="export_options[destination]"]').selectOption('folder');
    await page.locator('input[name="export_options[path]"]:visible').fill(`trigger-${suffix}`);
    await page.getByRole('button', { name: 'Add every column' }).click();
    await expect(page.locator('.openimport-mapping-table tbody tr').first()).toBeVisible();

    await page.locator('.fieldset-wrapper-title', { hasText: '6 · When' }).click();
    const events = page.locator('select[name="triggers[events]"]');
    await expect(events).toBeVisible();
    // The status list belongs to "An order changes status" only.
    await expect(page.locator('select[name="triggers[order_statuses]"]')).toBeHidden();
    await events.selectOption(['order_status_changed']);
    await expect(page.locator('select[name="triggers[order_statuses]"]')).toBeVisible();
    await events.selectOption(['product_saved']);
    await expect(page.locator('select[name="triggers[order_statuses]"]')).toBeHidden();
    const active = page.locator('[data-index="is_active"]');
    await expect(active).toContainText('Automatic runs are on');
    await page.locator('input[name="is_active"] + label').click(); // Magento toggle: the label is the switch
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.message-success')).toContainText('saved', { timeout: 60_000 });

    await page.goto('/admin/openimport/profile/index/');
    const row = page.locator('.data-grid tr', { hasText: exportName });
    await expect(row).toContainText('After: product saved', { timeout: 60_000 });
    expect(violations).toEqual([]);
  });

  test('an OpenImport import queues nothing; a product saved through the API queues one run', async ({ request }) => {
    // Clear what other specs left in the queue, so the waiting-run check starts from nothing.
    magento('openimport:queue:run');
    expect(queued(exportName)).toEqual([]);

    expect(importProducts(), 'import products through the CLI').toMatch(/success/i);
    expect(queued(exportName), 'what OpenImport writes starts no triggered run').toEqual([]);

    await saveProduct(request, `OI-TRG-${suffix}-1`, `Trigger one ${suffix}`);
    await saveProduct(request, `OI-TRG-${suffix}-1`, `Trigger one ${suffix} again`);
    expect(queued(exportName), 'two saves, one waiting run').toEqual([['event', 'product saved', 'live']]);

    magento('openimport:queue:run');
    const run = sql(`SELECT r.run_id, r.status FROM openimport_run r JOIN openimport_profile p ON p.profile_id = r.profile_id
      WHERE p.name = '${exportName}' ORDER BY r.run_id DESC LIMIT 1`)[0];
    expect(run[1], `run ${run[0]}`).toMatch(/success|partial/);
    // The export of that run is not an event of its own: nothing new waits.
    expect(queued(exportName)).toEqual([]);
  });

  test('a profile switched off ignores the event', async ({ page, request }) => {
    sql(`UPDATE openimport_profile SET is_active = 0 WHERE name = '${exportName}'`);
    await saveProduct(request, `OI-TRG-${suffix}-2`, `Trigger two ${suffix}`);
    expect(queued(exportName)).toEqual([]);
    await page.goto('/admin/openimport/profile/index/');
    await expect(page.locator('.data-grid tr', { hasText: exportName })).toContainText('(off)', { timeout: 60_000 });
  });
});
