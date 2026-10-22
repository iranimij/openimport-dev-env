import { Page } from '@playwright/test';
import { test, expect, magento, sql, seedProducts, collectCspViolations } from '../fixture';

/**
 * 1.6 automation: triggers (step 6 › "Also run when").
 * - An export profile that runs after product saves: set up in the admin, an OpenImport import of products queues
 *   nothing, a product saved in the admin queues one live run with "Event" as its start, which then exports.
 */
const suffix = Date.now().toString(36);

function queued(profileName: string): string[][] {
  return sql(`SELECT r.run_trigger, r.requested_by, r.mode FROM openimport_run r JOIN openimport_profile p ON p.profile_id = r.profile_id
    WHERE p.name = '${profileName}' AND r.status = 'queued'`);
}

async function saveProductInAdmin(page: Page, sku: string, name: string): Promise<void> {
  const id = sql(`SELECT entity_id FROM catalog_product_entity WHERE sku = '${sku}'`)[0][0];
  await page.goto(`/admin/catalog/product/edit/id/${id}/`);
  const field = page.locator('input[name="product[name]"]');
  await expect(field).toBeVisible({ timeout: 90_000 });
  await field.fill(name);
  await page.locator('#save-button').click();
  await expect(page.locator('.message-success')).toContainText('You saved the product', { timeout: 90_000 });
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

  test('an OpenImport import queues nothing; a product saved in the admin queues one run', async ({ page }) => {
    // Clear what other specs left in the queue, so the waiting-run check starts from nothing.
    magento('openimport:queue:run');
    expect(queued(exportName)).toEqual([]);

    expect(seedProducts(`trigger-${suffix}`), 'seed products through the CLI').toMatch(/success|partial/i);
    expect(queued(exportName), 'what OpenImport writes starts no triggered run').toEqual([]);

    await saveProductInAdmin(page, 'OI-FIX-1', `Trail shoe ${suffix}`);
    await saveProductInAdmin(page, 'OI-FIX-1', `Trail shoe ${suffix} again`);
    expect(queued(exportName), 'two saves, one waiting run').toEqual([['event', 'product saved', 'live']]);

    magento('openimport:queue:run');
    const run = sql(`SELECT r.run_id, r.status FROM openimport_run r JOIN openimport_profile p ON p.profile_id = r.profile_id
      WHERE p.name = '${exportName}' ORDER BY r.run_id DESC LIMIT 1`)[0];
    expect(run[1], `run ${run[0]}`).toMatch(/success|partial/);
    // The export of that run is not an event of its own: nothing new waits.
    expect(queued(exportName)).toEqual([]);
  });

  test('a profile switched off ignores the event', async ({ page }) => {
    sql(`UPDATE openimport_profile SET is_active = 0 WHERE name = '${exportName}'`);
    await saveProductInAdmin(page, 'OI-FIX-2', `Rain jacket ${suffix}`);
    expect(queued(exportName)).toEqual([]);
    await page.goto('/admin/openimport/profile/index/');
    await expect(page.locator('.data-grid tr', { hasText: exportName })).toContainText('(off)', { timeout: 60_000 });
  });
});
