#!/usr/bin/env bash
# Builds the OpenImport fixture store on a GitHub Actions runner (the CI twin of bin/setup, without Warden):
# Magento Open Source from the public Magento mirror, iranimij/module-base from Packagist and OpenImport from its main
# branch (or OPENIMPORT_REF). MariaDB, OpenSearch and Redis run as job services; nginx + PHP-FPM serve on :80, so the
# admin is http://localhost/admin.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

: "${MAGENTO_ROOT:?}" "${MAGENTO_VERSION:=2.4.9}"
: "${DB_HOST:=127.0.0.1}" "${DB_NAME:=magento}" "${DB_USER:=magento}" "${DB_PASSWORD:=magento}"
: "${ADMIN_USER:?}" "${ADMIN_PASSWORD:?}"
# OPENIMPORT_INSTALL=none builds the store without OpenImport (benchmarks of core alone, README install job).
: "${OPENIMPORT_INSTALL:=main}" "${OPENIMPORT_REF:=main}"
export MIRROR=https://repo-magento-mirror.fooman.co.nz/

echo "::group::Composer project"
if [ -n "${GITHUB_TOKEN:-}" ]; then composer config -g github-oauth.github.com "$GITHUB_TOKEN"; fi
composer create-project --no-interaction --no-progress --no-install --repository-url="$MIRROR" \
  "magento/project-community-edition=$MAGENTO_VERSION" "$MAGENTO_ROOT"
cd "$MAGENTO_ROOT"
# The project template points at repo.magento.com (needs keys); use only the public mirror.
php -r '$f = "composer.json"; $c = json_decode(file_get_contents($f), true);
  $c["repositories"] = ["magento-mirror" => ["type" => "composer", "url" => getenv("MIRROR")]];
  file_put_contents($f, json_encode($c, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");'
grep -q repo.magento.com composer.json && { echo "repo.magento.com still configured"; exit 1; }
composer config repositories.iranimij-openimport vcs https://github.com/iranimij/openimport
composer config minimum-stability dev
composer config prefer-stable true
composer config --no-plugins allow-plugins.magento/composer-dependency-version-audit-plugin false
composer config --no-plugins allow-plugins.magento/* true
composer config --no-plugins allow-plugins.laminas/laminas-dependency-plugin true
composer config --no-plugins allow-plugins.dealerdirect/phpcodesniffer-composer-installer true
composer config --no-plugins allow-plugins.php-http/discovery true
iranimij=('iranimij/module-base:^1.0')
if [ "$OPENIMPORT_INSTALL" = main ]; then
  iranimij+=("iranimij/openimport:dev-${OPENIMPORT_REF} as 1.0.0")
fi
composer require --no-update --no-interaction "${iranimij[@]}"
composer install --no-interaction --no-progress --prefer-dist \
  || { echo "composer install failed, retrying once"; composer clear-cache; composer install --no-interaction --no-progress --prefer-dist; }
echo "::endgroup::"

echo "::group::setup:install"
bin/magento setup:install --no-interaction \
  --base-url=http://localhost/ --backend-frontname=admin \
  --db-host="$DB_HOST" --db-name="$DB_NAME" --db-user="$DB_USER" --db-password="$DB_PASSWORD" \
  --search-engine=opensearch --opensearch-host=127.0.0.1 --opensearch-port=9200 --opensearch-enable-auth=0 \
  --session-save=redis --session-save-redis-host=127.0.0.1 --session-save-redis-db=2 \
  --cache-backend=redis --cache-backend-redis-server=127.0.0.1 --cache-backend-redis-db=0 \
  --admin-user="$ADMIN_USER" --admin-password="$ADMIN_PASSWORD" --admin-email=admin@openimport.test \
  --admin-firstname=Open --admin-lastname=Import \
  --language=en_US --currency=EUR --timezone=Europe/Berlin --use-rewrites=1
# No two-factor auth and no first-login popups (usage data, release notes) over the dashboard (fixture only).
bin/magento module:disable Magento_TwoFactorAuth Magento_AdminAdobeImsTwoFactorAuth Magento_AdminAnalytics \
  Magento_ReleaseNotification
bin/magento setup:upgrade --no-interaction
echo "::endgroup::"

echo "::group::Store configuration"
bin/magento config:set admin/security/use_form_key 0
bin/magento indexer:set-mode schedule
php "$SCRIPT_DIR/fixture-data.php"
bin/magento indexer:reindex
bin/magento cache:flush
echo "::endgroup::"
