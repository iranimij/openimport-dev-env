import { test as base, expect, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * How specs reach the fixture's database and CLI.
 * - Local (default): the Warden environment of this repository (`warden env exec`).
 * - CI (`OI_FIXTURE=shell`): Magento in `MAGENTO_ROOT`, MySQL from `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`.
 */
const shell = process.env.OI_FIXTURE === 'shell';
const repoRoot = resolve(__dirname, '../..');

export const magentoRoot = shell ? (process.env.MAGENTO_ROOT ?? repoRoot) : repoRoot;

/** The fixture's file services as Magento reaches them: Warden service names locally, host ports in CI. */
export const services = shell
  ? { filesUrl: 'http://localhost:8081', sftpHost: 'localhost', sftpPort: '2222' }
  : { filesUrl: 'http://files', sftpHost: 'sftp', sftpPort: '22' };

/**
 * Imports the small product file through the CLI (profile JSON + openimport:run), so a spec that needs the
 * OI-FIX products does not depend on another spec having created them. Returns the run output.
 */
export function seedProducts(suffix: string): string {
  const name = `Seed ${suffix}`;
  const profile = {
    openimport: 1,
    profiles: [{
      name,
      direction: 'import',
      entity: 'catalog_product',
      is_active: false,
      source_type: 'upload',
      format: 'auto',
      behavior: 'add_update',
      on_error: 'skip',
      allowed_errors: 10,
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
  };
  mkdirSync(resolve(magentoRoot, 'var'), { recursive: true });
  writeFileSync(resolve(magentoRoot, `var/openimport-seed-${suffix}.json`), JSON.stringify(profile));
  copyFileSync(resolve(repoRoot, 'fixtures/files/products-small.csv'), resolve(magentoRoot, `var/openimport-seed-${suffix}.csv`));
  magento('openimport:profiles:import', `var/openimport-seed-${suffix}.json`);
  return magento('openimport:run', name, '--file', `var/openimport-seed-${suffix}.csv`);
}

/** Runs SQL and returns tab-separated rows. */
export function sql(query: string): string[][] {
  const args = ['-N', '-B', '-e', query];
  const out = shell
    ? execFileSync('mysql', [
      '-h', process.env.DB_HOST ?? '127.0.0.1',
      '-u', process.env.DB_USER ?? 'magento',
      `-p${process.env.DB_PASSWORD ?? 'magento'}`,
      process.env.DB_NAME ?? 'magento',
      ...args,
    ], { encoding: 'utf8' })
    : execFileSync('warden', ['env', 'exec', '-T', 'db', 'mysql', '-umagento', '-pmagento', 'magento', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  return out.trim() === '' ? [] : out.trim().split('\n').map((line) => line.split('\t'));
}

/** Runs bin/magento. */
export function magento(...args: string[]): string {
  return shell
    ? execFileSync('php', ['bin/magento', ...args], { cwd: magentoRoot, encoding: 'utf8' })
    : execFileSync('warden', ['env', 'exec', '-T', 'php-fpm', 'bin/magento', ...args], { cwd: repoRoot, encoding: 'utf8' });
}

/** Admin credentials: environment (CI) or admin.env (local). */
export function adminCredentials(): { user: string; password: string } {
  if (process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) {
    return { user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD };
  }
  const file = resolve(repoRoot, 'admin.env');
  if (!existsSync(file)) {
    throw new Error('Set ADMIN_USER / ADMIN_PASSWORD or create admin.env (see admin.env.example).');
  }
  const env = Object.fromEntries(readFileSync(file, 'utf8').split('\n')
    .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => [m[1], m[2]]));
  return { user: env.ADMIN_USER, password: env.ADMIN_PASSWORD };
}

/** Collects CSP violation reports of a page (admin CSP runs in report-only mode, violations still fire events). */
export function collectCspViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to (load|execute|apply)/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  return violations;
}

export const test = base;
export { expect };
