# openimport-dev-env

Fixture store and end-to-end tests for [OpenImport](https://github.com/iranimij/openimport), the free MIT import and
export for Magento 2.

The store: Magento Open Source 2.4.9 (no sample data), OpenSearch, Redis, all indexers on "Update by Schedule", a
German store view `de`, `iranimij/module-base` from Packagist and OpenImport from `./modules/openimport`. Next to it
run an **SFTP server** (`sftp`, user `openimport` / `openimport-sftp`) and an **HTTP file server** (`files`, public
at `/`, basic auth `openimport` / `openimport-http` at `/private/`), both serving `fixtures/files`, so profiles can be
tested against real remote sources. Credentials are fixture-only.

This repository versions only the environment definition, setup scripts, fixture files and Playwright tests. The
Magento installation created by `bin/setup` is ignored.

## Build the store (Warden)

```bash
cp .env.example .env && cp admin.env.example admin.env   # set an admin password
git clone https://github.com/iranimij/openimport modules/openimport
warden sign-certificate openimport.test
warden env up -d
bin/setup        # Magento, module-base + OpenImport (bin/install-modules), fixture data (bin/fixture-data)
bin/datasets     # optional: 10k / 50k products, 2k configurables, 20k customers into fixtures/files/generated
```

- Admin: https://app.openimport.test/admin (credentials in `admin.env`; two-factor auth and admin URL secret keys are
  off on this dev store only).
- Docker memory: run one Magento stack at a time, and never run integration tests and Playwright at the same time.

## Playwright

```bash
cd playwright && npm install && npx playwright install chromium
npx playwright test
```

`admin-setup` logs in once (credentials from `admin.env`, or `ADMIN_USER` / `ADMIN_PASSWORD`); `admin-chromium` runs
the admin specs serially. CI (`.github/workflows/e2e.yml`) builds the same store from public sources with
`ci/install-fixture.sh` and installs OpenImport from the branch in `.github/ci/openimport-ref` (stacked PRs) or `main`.

## Licence

MIT, see [LICENSE](LICENSE).
