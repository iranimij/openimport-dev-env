import { Page } from '@playwright/test';
import { test, expect, magento, sql, collectCspViolations } from '../fixture';

/**
 * 1.5 entities through the admin: URL rewrites (a 301 from an old address), a cart price rule with a coupon,
 * newsletter subscribers and search terms — upload, auto-match, dry run, run for real, the records in Magento.
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

async function dryRun(page: Page): Promise<number> {
  await page.getByRole('button', { name: 'Save and dry run' }).click();
  await page.waitForURL(/openimport\/run\/view\/id\/(\d+)/, { timeout: 60_000 });
  const runId = Number(page.url().match(/\/id\/(\d+)/)![1]);
  magento('openimport:queue:run');
  await page.reload();
  await expect(page.locator('.openimport-run')).toContainText('Dry run', { timeout: 60_000 });
  return runId;
}

async function runForReal(page: Page): Promise<void> {
  const before = page.url();
  await page.getByRole('button', { name: 'Run for real' }).click();
  await page.waitForURL((url) => url.toString() !== before && /openimport\/run\/view\/id\/\d+/.test(url.toString()), { timeout: 60_000 });
  magento('openimport:queue:run');
  await page.reload();
  const runId = Number(page.url().match(/\/id\/(\d+)/)![1]);
  const errors = sql(`SELECT CONCAT(source_row, ' ', field, ': ', message) FROM openimport_run_error WHERE run_id = ${runId} LIMIT 10`).map((row) => row[0]).join(' | ');
  await expect(page.locator('.openimport-run'), `run ${runId} errors: ${errors}`).toContainText(/Success|Erfolgreich/, { timeout: 60_000 });
}

test.describe.serial('OpenImport 1.5 sales and marketing entities', () => {
  test.setTimeout(180_000);

  test('URL rewrites: a 301 from an old address, the storefront answers', async ({ page, request }) => {
    const violations = collectCspViolations(page);
    await openNewProfile(page, `Rewrites ${suffix}`, 'openimport_url_rewrite');
    await upload(page, 'redirects.csv', `old url;new url;redirect\noi-${suffix}-old.html;oi-${suffix}-new.html;301\n`);
    await autoMatch(page);
    await dryRun(page);
    expect(sql(`SELECT COUNT(*) FROM url_rewrite WHERE request_path = 'oi-${suffix}-old.html'`)).toEqual([['0']]);
    await runForReal(page);
    expect(sql(`SELECT target_path, redirect_type, entity_type FROM url_rewrite WHERE request_path = 'oi-${suffix}-old.html'`)).toEqual([[`oi-${suffix}-new.html`, '301', 'custom']]);
    const response = await request.get(`/oi-${suffix}-old.html`, { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    expect(response.headers()['location']).toContain(`oi-${suffix}-new.html`);
    expect(violations).toEqual([]);
  });

  test('a cart price rule with a coupon code', async ({ page }) => {
    const violations = collectCspViolations(page);
    await openNewProfile(page, `Cart rules ${suffix}`, 'openimport_cart_rule');
    await upload(page, 'rules.csv', `name;coupon;action;discount;subtotal;customer_groups\nOI ${suffix} ten;OI${suffix.toUpperCase()};by_percent;10;20;all\n`);
    await autoMatch(page);
    await dryRun(page);
    await runForReal(page);
    const rule = sql(`SELECT rule_id, simple_action, discount_amount, coupon_type FROM salesrule WHERE name = 'OI ${suffix} ten'`);
    expect(rule).toHaveLength(1);
    expect(rule[0].slice(1)).toEqual(['by_percent', '10.0000', '2']);
    expect(sql(`SELECT code FROM salesrule_coupon WHERE rule_id = ${rule[0][0]} AND is_primary = 1`)).toEqual([[`OI${suffix.toUpperCase()}`]]);
    expect(sql(`SELECT conditions_serialized LIKE '%base_subtotal%' FROM salesrule WHERE rule_id = ${rule[0][0]}`)).toEqual([['1']]);
    expect(violations).toEqual([]);
  });

  test('newsletter subscribers and search terms', async ({ page }) => {
    await openNewProfile(page, `Newsletter ${suffix}`, 'openimport_newsletter');
    await upload(page, 'subscribers.csv', `email;status\noi-${suffix}@example.com;subscribed\n`);
    await autoMatch(page);
    await dryRun(page);
    await runForReal(page);
    expect(sql(`SELECT subscriber_status FROM newsletter_subscriber WHERE subscriber_email = 'oi-${suffix}@example.com'`)).toEqual([['1']]);

    await openNewProfile(page, `Search terms ${suffix}`, 'openimport_search_term');
    await upload(page, 'terms.csv', `Suchbegriff;Weiterleitung\noi ${suffix} shirts;https://example.com/shirts\n`);
    await autoMatch(page);
    await dryRun(page);
    await runForReal(page);
    expect(sql(`SELECT redirect FROM search_query WHERE query_text = 'oi ${suffix} shirts'`)).toEqual([['https://example.com/shirts']]);
  });
});
