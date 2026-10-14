<?php
/**
 * Copyright © Iman Aboheydary. All rights reserved.
 * See LICENSE for license details (MIT).
 *
 * Fixture data for the OpenImport dev store, run from the Magento root (local: bin/fixture-data, CI:
 * ci/install-fixture.sh). Idempotent.
 *
 * - Store view "de" (German, de_DE) next to "default", for store-view columns such as name_de.
 * - OpenImport safety settings: the fixture's private services "files" (HTTP) and "sftp" are allowed as sources.
 */

declare(strict_types=1);

// phpcs:ignoreFile -- fixture script, runs outside the module.

use Magento\Framework\App\Bootstrap;
use Magento\Framework\App\Config\Storage\WriterInterface;
use Magento\Framework\App\State;
use Magento\Store\Model\GroupFactory;
use Magento\Store\Model\ResourceModel\Store as StoreResource;
use Magento\Store\Model\StoreFactory;
use Magento\Store\Model\StoreManagerInterface;

require getcwd() . '/app/bootstrap.php';

$bootstrap = Bootstrap::create(BP, $_SERVER);
$om = $bootstrap->getObjectManager();
$om->get(State::class)->setAreaCode('adminhtml');
$storeManager = $om->get(StoreManagerInterface::class);
$config = $om->get(WriterInterface::class);

$stores = $storeManager->getStores(true, true);
if (!isset($stores['de'])) {
    $group = $om->get(GroupFactory::class)->create()->load($storeManager->getDefaultStoreView()->getStoreGroupId());
    $store = $om->get(StoreFactory::class)->create();
    $store->setData([
        'code' => 'de',
        'name' => 'Deutsch',
        'website_id' => $group->getWebsiteId(),
        'group_id' => $group->getId(),
        'sort_order' => 10,
        'is_active' => 1,
    ]);
    $om->get(StoreResource::class)->save($store);
    echo "store view de created\n";
}
$storeManager->reinitStores();
$de = $storeManager->getStore('de');
$config->save('general/locale/code', 'de_DE', 'stores', (int) $de->getId());

$config->save('openimport/security/allowed_hosts', "files\nsftp\nlocalhost\n127.0.0.1");
echo "OpenImport: files, sftp and localhost allowed as private hosts (fixture only)\n";
