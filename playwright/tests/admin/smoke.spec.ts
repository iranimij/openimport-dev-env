import AxeBuilder from '@axe-core/playwright';
import { test, expect, magento, collectCspViolations } from '../fixture';

/** M0 baseline: OpenImport is installed on module-base, its settings and ACL are where 07 · Build Brief says. */
test.describe('OpenImport admin baseline', () => {
  test('module and base module are enabled', async () => {
    const status = magento('module:status', 'Iranimij_Base', 'Iranimij_OpenImport');
    expect(status).not.toMatch(/disabled/i);
  });

  test('settings section shows runs and safety with the defaults', async ({ page }) => {
    const violations = collectCspViolations(page);
    await page.goto('/admin/admin/system_config/edit/section/openimport/');
    await expect(page.locator('#openimport_general-head')).toBeVisible();
    await expect(page.locator('#openimport_security-head')).toBeVisible();
    for (const head of ['#openimport_general-head', '#openimport_security-head']) {
      if ((await page.locator(head).getAttribute('class'))?.includes('open') !== true) {
        await page.locator(head).click();
      }
    }
    await expect(page.locator('#openimport_general_keep_files_days')).toHaveValue('14');
    await expect(page.locator('#openimport_security_safety_threshold_percent')).toHaveValue('10');
    await expect(page.locator('#openimport_security_allowed_hosts')).toHaveValue(/files/);
    const axe = await new AxeBuilder({ page }).include('#config-edit-form').analyze();
    const serious = axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    expect(violations).toEqual([]);
  });

  test('ACL tree lists OpenImport under System > Data Transfer', async ({ page }) => {
    await page.goto('/admin/admin/user_role/editrole/');
    await page.getByRole('tab', { name: 'Role Resources' }).click();
    await page.locator('select[name="all"]').selectOption('0');
    const tree = page.locator('[data-role="resource-tree"], .tree-actions, #role-edit-form');
    await expect(tree.getByText('OpenImport', { exact: true }).first()).toBeVisible();
    await expect(tree.getByText('Confirm runs above the safety limit (Replace, Delete)')).toBeVisible();
  });
});
