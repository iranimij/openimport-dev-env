import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, magento, magentoRoot, collectCspViolations, sql } from '../fixture';

/**
 * 1.3 slices 3 and 4: products missing from the file (scope: a supplier) and quantities as changes.
 */
const suffix = Date.now().toString(36);

function run(name: string, entity: string, mapping: object[], importOptions: Record<string, string>, csv: string, extra: string[] = []): string {
  mkdirSync(resolve(magentoRoot, 'var'), { recursive: true });
  const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  writeFileSync(resolve(magentoRoot, `var/openimport-${slug}.json`), JSON.stringify({
    openimport: 1,
    profiles: [{
      name, direction: 'import', entity, is_active: false, source_type: 'upload', format: 'csv',
      behavior: 'add_update', on_error: 'stop', allowed_errors: 0, safety_threshold: 100,
      import_options: importOptions, mapping,
    }],
  }));
  writeFileSync(resolve(magentoRoot, `var/openimport-${slug}.csv`), csv);
  magento('openimport:profiles:import', `var/openimport-${slug}.json`);
  try {
    return magento('openimport:run', name, '--file', `var/openimport-${slug}.csv`, ...extra);
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? error);
  }
}

const productMapping = [
  { target: 'sku', source: 'sku', transforms: [] },
  { target: 'name', source: 'sku', transforms: [] },
  { target: 'price', static: '9', transforms: [] },
  { target: 'qty', static: '10', transforms: [] },
  { target: 'is_in_stock', static: '1', transforms: [] },
  { target: 'oi_e2e_supplier', source: 'supplier', transforms: [] },
  { target: 'attribute_set_code', static: 'Default', transforms: [] },
  { target: 'product_type', static: 'simple', transforms: [] },
  { target: 'product_websites', static: 'base', transforms: [] },
  { target: 'product_online', static: '1', transforms: [] },
];

test.describe.serial('OpenImport catalog rules', () => {
  test.setTimeout(180_000);
  const supplier = `Acme ${suffix}`;
  const prefix = `OI-E2E-MIS-${suffix}`;

  test('products a supplier no longer lists are disabled', async () => {
    expect(run(`Suppliers ${suffix}`, 'openimport_attribute', [
      { target: 'attribute_code', static: 'oi_e2e_supplier', transforms: [] },
      { target: 'label', static: 'E2E Supplier', transforms: [] },
      { target: 'frontend_input', static: 'select', transforms: [] },
      { target: 'options', source: 'options', transforms: [] },
      { target: 'attribute_set', static: 'Default', transforms: [] },
    ], {}, `options\n${supplier}|Other ${suffix}\n`)).toMatch(/success/);

    const all = [1, 2, 3, 4].map((i) => `${prefix}-${i},${supplier}`);
    expect(run(`Supplier products ${suffix}`, 'catalog_product', productMapping, {},
      ['sku,supplier', ...all, `${prefix}-X,Other ${suffix}`].join('\n') + '\n')).toMatch(/success/);

    const output = run(`Complete list ${suffix}`, 'catalog_product', productMapping, {
      missing_action: 'disable', missing_scope: 'attribute', missing_attribute: 'oi_e2e_supplier', missing_value: supplier,
    }, ['sku,supplier', ...all.slice(0, 2)].join('\n') + '\n');
    expect(output).toContain(`Products missing from the file: disabled 2 (${prefix}-3, ${prefix}-4).`);

    const status = (sku: string): string => sql(`SELECT i.value FROM catalog_product_entity_int i
      JOIN catalog_product_entity e ON e.entity_id = i.entity_id
      JOIN eav_attribute a ON a.attribute_id = i.attribute_id AND a.attribute_code = 'status' AND a.entity_type_id = 4
      WHERE e.sku = '${sku}' AND i.store_id = 0`)[0][0];
    expect(status(`${prefix}-3`)).toBe('2');
    expect(status(`${prefix}-1`)).toBe('1');
    expect(status(`${prefix}-X`)).toBe('1');
  });

  test('a delivery file adds to the stock', async () => {
    const output = run(`Deliveries ${suffix}`, 'openimport_stock_price', [
      { target: 'sku', source: 'sku', transforms: [] },
      { target: 'qty', source: 'change', transforms: [] },
    ], { qty_mode: 'add' }, `sku,change\n${prefix}-1,+5\n${prefix}-2,-3\n`);
    expect(output).toContain('Quantities changed by the file: 2.');
    const qty = (sku: string): number => Number(sql(`SELECT s.qty FROM cataloginventory_stock_item s
      JOIN catalog_product_entity e ON e.entity_id = s.product_id WHERE e.sku = '${sku}' AND s.stock_id = 1`)[0][0]);
    expect(qty(`${prefix}-1`)).toBe(15);
    expect(qty(`${prefix}-2`)).toBe(7);
  });

  test('step 5 offers the new rules for the right entities', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/profile/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('select[name="entity"]').selectOption('catalog_product');
    await page.locator('.fieldset-wrapper-title', { hasText: '5 · Rules' }).click();
    const action = page.locator('select[name="import_options[missing_action]"]');
    const scope = page.locator('select[name="import_options[missing_scope]"]');
    await expect(action).toBeVisible();
    await expect(scope).toBeHidden();
    await action.selectOption('disable');
    await expect(scope).toBeVisible();
    await scope.selectOption('attribute');
    await expect(page.locator('input[name="import_options[missing_attribute]"]')).toBeVisible();
    await expect(page.locator('select[name="import_options[qty_mode]"]')).toBeVisible();

    await page.locator('select[name="entity"]').selectOption('openimport_stock_price');
    await expect(action).toBeHidden();
    await expect(page.locator('select[name="import_options[qty_mode]"]')).toBeVisible();
    expect(violations).toEqual([]);
  });
});
