import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, magento, magentoRoot, collectCspViolations, sql } from '../fixture';

/**
 * 1.3 slice 2: configurable products from simple rows. The variation attributes are created with OpenImport's
 * attribute import; a product file with a parent column becomes a configurable product with linked variants.
 */
const suffix = Date.now().toString(36);

async function formKey(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/admin/openimport/profile/new/');
  await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
  return page.evaluate(() => (window as unknown as { FORM_KEY: string }).FORM_KEY);
}

function importProfile(name: string, entity: string, mapping: object[], importOptions: Record<string, string>, csv: string): string {
  mkdirSync(resolve(magentoRoot, 'var'), { recursive: true });
  const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  writeFileSync(resolve(magentoRoot, `var/openimport-${slug}.json`), JSON.stringify({
    openimport: 1,
    profiles: [{
      name, direction: 'import', entity, is_active: false, source_type: 'upload', format: 'csv',
      behavior: 'add_update', on_error: 'skip', allowed_errors: 10, import_options: importOptions, mapping,
    }],
  }));
  writeFileSync(resolve(magentoRoot, `var/openimport-${slug}.csv`), csv);
  magento('openimport:profiles:import', `var/openimport-${slug}.json`);
  try {
    return magento('openimport:run', name, '--file', `var/openimport-${slug}.csv`);
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? error);
  }
}

test.describe.serial('OpenImport configurable products', () => {
  test.setTimeout(180_000);
  const parent = `OI-E2E-CFG-${suffix}`;

  test('variation attributes and a product file become a configurable product', async () => {
    const attributes = importProfile(`Variation attributes ${suffix}`, 'openimport_attribute', [
      { target: 'attribute_code', source: 'code', transforms: [] },
      { target: 'label', source: 'label', transforms: [] },
      { target: 'frontend_input', static: 'select', transforms: [] },
      { target: 'scope', static: 'global', transforms: [] },
      { target: 'options', source: 'options', transforms: [] },
      { target: 'attribute_set', static: 'Default', transforms: [] },
    ], {}, 'code,label,options\noi_e2e_color,E2E Color,Red|Blue\noi_e2e_size,E2E Size,S|M\n');
    expect(attributes).toMatch(/success/);

    const rows = [['Red', 'S'], ['Red', 'M'], ['Blue', 'M']]
      .map(([color, size]) => `${parent}-${color}-${size},Shirt ${parent} ${color} ${size},25,${color},${size},${parent}`);
    const products = importProfile(`Configurables ${suffix}`, 'catalog_product', [
      { target: 'sku', source: 'sku', transforms: [] },
      { target: 'name', source: 'name', transforms: [] },
      { target: 'price', source: 'price', transforms: [] },
      { target: 'oi_e2e_color', source: 'color', transforms: [] },
      { target: 'oi_e2e_size', source: 'size', transforms: [] },
      { target: 'configurable:parent_sku', source: 'model', transforms: [] },
      { target: 'attribute_set_code', static: 'Default', transforms: [] },
      { target: 'product_type', static: 'simple', transforms: [] },
      { target: 'product_websites', static: 'base', transforms: [] },
      { target: 'qty', static: '5', transforms: [] },
      { target: 'is_in_stock', static: '1', transforms: [] },
    ], { configurable: '1', configurable_attributes: 'oi_e2e_color,oi_e2e_size' },
    ['sku,name,price,color,size,model', ...rows].join('\n') + '\n');
    expect(products).toContain('Configurable products: 1 built from 3 variants.');

    expect(sql(`SELECT type_id FROM catalog_product_entity WHERE sku = '${parent}'`)[0][0]).toBe('configurable');
    const links = sql(`SELECT COUNT(*) FROM catalog_product_super_link l
      JOIN catalog_product_entity p ON p.entity_id = l.parent_id WHERE p.sku = '${parent}'`)[0][0];
    expect(links).toBe('3');
  });

  test('the mapping fields include the parent SKU', async ({ page }) => {
    const answer = await page.request.post('/admin/openimport/profile/fields/', {
      form: { entity: 'catalog_product', direction: 'import', form_key: await formKey(page) },
    });
    expect(await answer.text()).toContain('configurable:parent_sku');
  });

  test('the profile form offers the variation attributes when building is on', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/profile/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('select[name="entity"]').selectOption('catalog_product');
    await page.locator('.fieldset-wrapper-title', { hasText: '5 · Rules' }).click();
    const attributes = page.locator('select[name="import_options[configurable_attributes]"]');
    await expect(attributes).toBeHidden();
    await page.locator('input[name="import_options[configurable]"] + label').click(); // Magento toggle: the label is the switch
    await expect(attributes).toBeVisible();
    await expect(attributes.locator('option', { hasText: 'oi_e2e_color' })).toHaveCount(1);
    await expect(page.locator('select[name="import_options[configurable_child_visibility]"]')).toHaveValue('hide');

    expect(violations).toEqual([]);
  });
});
