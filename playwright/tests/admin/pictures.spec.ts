import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, magento, magentoRoot, services, collectCspViolations, sql } from '../fixture';

/**
 * 1.3 slice 1: product pictures from web addresses. The fixture's "files" service serves fixtures/files/pictures;
 * the run downloads them through OpenImport (not core), a second run asks with the ETag, a missing picture fails its
 * row or is left out, and the profile form offers the option for products only.
 */
const suffix = Date.now().toString(36);

function profileJson(name: string, importOptions: Record<string, string>): string {
  return JSON.stringify({
    openimport: 1,
    profiles: [{
      name,
      direction: 'import',
      entity: 'catalog_product',
      is_active: false,
      source_type: 'upload',
      format: 'csv',
      behavior: 'add_update',
      on_error: 'skip',
      allowed_errors: 10,
      import_options: importOptions,
      mapping: [
        { target: 'sku', source: 'sku', transforms: [] },
        { target: 'name', source: 'name', transforms: [] },
        { target: 'price', static: '19.90', transforms: [] },
        { target: 'base_image', source: 'picture', transforms: [] },
        { target: 'small_image', source: 'picture', transforms: [] },
        { target: 'thumbnail_image', source: 'picture', transforms: [] },
        { target: 'additional_images', source: 'more', transforms: [] },
        { target: 'attribute_set_code', static: 'Default', transforms: [] },
        { target: 'product_type', static: 'simple', transforms: [] },
        { target: 'product_websites', static: 'base', transforms: [] },
        { target: 'visibility', static: 'Catalog, Search', transforms: [] },
      ],
    }],
  });
}

/** Writes the profile and the file into var/, imports the profile and runs it. Returns the CLI output. */
function runWithPictures(name: string, rows: string[][], importOptions: Record<string, string> = {}): string {
  mkdirSync(resolve(magentoRoot, 'var'), { recursive: true });
  const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  writeFileSync(resolve(magentoRoot, `var/openimport-${slug}.json`), profileJson(name, importOptions));
  writeFileSync(
    resolve(magentoRoot, `var/openimport-${slug}.csv`),
    ['sku,name,picture,more', ...rows.map((row) => row.map((cell) => `"${cell}"`).join(','))].join('\n') + '\n',
  );
  try {
    magento('openimport:profiles:import', `var/openimport-${slug}.json`);
  } catch {
    // The profile exists from an earlier run of this spec: the import updates it, a failure here means "unchanged".
  }
  try {
    return magento('openimport:run', name, '--file', `var/openimport-${slug}.csv`);
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? error);
  }
}

test.describe.serial('OpenImport product pictures', () => {
  test.setTimeout(180_000);
  const sku = `OI-PIC-${suffix}`;
  const pictures = `${services.filesUrl}/pictures`;

  test('pictures from web addresses are downloaded once and shown on the product', async ({ page }) => {
    const first = runWithPictures(`Pictures ${suffix}`, [
      [sku, `Picture product ${suffix}`, `${pictures}/red.png`, `${pictures}/blue.png,${pictures}/green.png`],
    ]);
    expect(first).toContain('Pictures: 3 downloaded, 0 unchanged, 0 could not be read.');

    const gallery = sql(`SELECT g.value FROM catalog_product_entity_media_gallery g
      JOIN catalog_product_entity_media_gallery_value_to_entity e ON e.value_id = g.value_id
      JOIN catalog_product_entity p ON p.entity_id = e.entity_id WHERE p.sku = '${sku}'`).map((row) => row[0]);
    expect(gallery).toHaveLength(3);
    expect(gallery.join(' ')).toMatch(/\/red(_\d+)?\.png/);

    // Within the refresh time (24 hours by default) the pictures are not asked for again.
    const second = runWithPictures(`Pictures ${suffix}`, [
      [sku, `Picture product ${suffix}`, `${pictures}/red.png`, `${pictures}/blue.png,${pictures}/green.png`],
    ]);
    expect(second).toContain('Pictures: 0 downloaded, 3 unchanged');

    const id = sql(`SELECT entity_id FROM catalog_product_entity WHERE sku = '${sku}'`)[0][0];
    await page.goto(`/admin/catalog/product/edit/id/${id}/`);
    await page.getByText('Images And Videos', { exact: true }).click();
    await expect(page.locator('#media_gallery_content [data-role="image"] img.product-image')).toHaveCount(3, { timeout: 60_000 });
  });

  test('a picture that cannot be read fails its row, or the row is imported without it', async () => {
    const missing = `${pictures}/missing.png`;
    const failed = runWithPictures(`Pictures missing ${suffix}`, [
      [`${sku}-M`, `Missing picture ${suffix}`, missing, ''],
    ]);
    expect(failed).toContain('answered with HTTP 404');
    expect(sql(`SELECT COUNT(*) FROM catalog_product_entity WHERE sku = '${sku}-M'`)[0][0]).toBe('0');

    const skipped = runWithPictures(`Pictures skipped ${suffix}`, [
      [`${sku}-S`, `Skipped picture ${suffix}`, missing, `${pictures}/red.png`],
    ], { images_on_error: 'skip' });
    expect(skipped).toContain(`Imported without the picture: ${sku}-S`);
    expect(sql(`SELECT COUNT(*) FROM catalog_product_entity WHERE sku = '${sku}-S'`)[0][0]).toBe('1');
  });

  test('the profile form offers the picture option for products only', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/openimport/profile/new/');
    await expect(page.locator('input[name="name"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('select[name="entity"]').selectOption('catalog_product');
    await page.locator('.fieldset-wrapper-title', { hasText: '5 · Rules' }).click();
    const option = page.locator('select[name="import_options[images_on_error]"]');
    await expect(option).toBeVisible();
    await expect(option).toHaveValue('error');
    await expect(option.locator('option')).toHaveText(['Report the row as an error', 'Import the row without the picture']);
    await page.locator('select[name="entity"]').selectOption('customer');
    await expect(option).toBeHidden();
    expect(violations).toEqual([]);
  });
});
