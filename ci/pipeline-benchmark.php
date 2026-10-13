<?php
/**
 * Copyright © Iman Aboheydary. All rights reserved.
 * See LICENSE for license details (MIT).
 *
 * M1 check (07 · Build Brief §6, Performance): the whole OpenImport pipeline on the generated datasets, each pass in
 * its own bin/magento process so peak memory is comparable between 10k and 50k rows.
 *
 * Run from the Magento root: php <dev-env>/ci/pipeline-benchmark.php <datasets dir> <output json> [products-10k ...]
 *
 * Per dataset: a profile maps every column 1:1, with transforms on sku, url_key and name (another prefix, so the
 * pipeline creates its own products), delta on. Passes: dry run, live import, the same file again (delta: every row
 * unchanged), the same file with --full (every row sent again), and a file with 1 % of the rows changed (delta).
 */

declare(strict_types=1);

// phpcs:ignoreFile -- benchmark script, runs outside the module.

use Iranimij\OpenImport\Api\Data\ProfileInterfaceFactory;
use Iranimij\OpenImport\Api\Data\RunInterface;
use Iranimij\OpenImport\Api\ProfileRepositoryInterface;
use Iranimij\OpenImport\Api\RunRepositoryInterface;
use Magento\Framework\Api\SearchCriteriaBuilder;
use Magento\Framework\Api\SortOrderBuilder;
use Magento\Framework\App\Bootstrap;
use Magento\Framework\App\State;

require getcwd() . '/app/bootstrap.php';

$datasets = rtrim($argv[1] ?? '', '/');
$output = $argv[2] ?? 'pipeline-benchmark.json';
$sets = array_slice($argv, 3) ?: ['products-10k', 'products-50k'];
$entities = ['products-10k' => 'catalog_product', 'products-50k' => 'catalog_product',
    'configurables-2k' => 'catalog_product', 'customers-20k' => 'customer_composite'];

$bootstrap = Bootstrap::create(BP, $_SERVER);
$om = $bootstrap->getObjectManager();
$om->get(State::class)->setAreaCode('adminhtml');
$profiles = $om->get(ProfileRepositoryInterface::class);

function header_of(string $file): array
{
    $handle = fopen($file, 'r');
    $header = fgetcsv($handle, null, ',', '"', '\\');
    fclose($handle);

    return $header;
}

/** A copy of the file with every 100th data row changed (price or e-mail name), for the 1 % delta pass. */
function one_percent(string $file, string $target): int
{
    $in = fopen($file, 'r');
    $out = fopen($target, 'w');
    $header = fgetcsv($in, null, ',', '"', '\\');
    fputcsv($out, $header, ',', '"', '\\');
    $changed = 0;
    $line = 0;
    while (($row = fgetcsv($in, null, ',', '"', '\\')) !== false) {
        $assoc = array_combine($header, $row);
        $line++;
        if ($line % 100 === 0 && ($assoc['store_view_code'] ?? '') === '') {
            foreach (['price', 'firstname'] as $column) {
                if (isset($assoc[$column]) && $assoc[$column] !== '') {
                    $assoc[$column] = is_numeric($assoc[$column]) ? (string) ((float) $assoc[$column] + 1) : $assoc[$column] . 'x';
                    $changed++;
                    break;
                }
            }
        }
        fputcsv($out, array_values($assoc), ',', '"', '\\');
    }
    fclose($in);
    fclose($out);

    return $changed;
}

$results = [];
foreach ($sets as $set) {
    $file = "$datasets/$set.csv";
    if (!is_file($file)) {
        fwrite(STDERR, "missing $file\n");
        exit(1);
    }
    $mapping = [];
    foreach (header_of($file) as $column) {
        $transforms = match ($column) {
            'sku', 'configurable_variations' => [['name' => 'replace', 'args' => ['OI-', 'OP-']]],
            'url_key' => [['name' => 'replace', 'args' => ['oi-', 'op-']]],
            'email' => [['name' => 'replace', 'args' => ['oi.customer', 'op.customer']]],
            'name' => [['name' => 'prefix', 'args' => ['OP ']]],
            default => [],
        };
        $mapping[] = ['target' => $column, 'source' => $column, 'transforms' => $transforms];
    }
    $name = 'Benchmark ' . $set;
    $profile = $om->get(ProfileInterfaceFactory::class)->create()
        ->setName($name)
        ->setEntity($entities[$set])
        ->setFormat('csv')
        ->setDelta(true)
        ->setOnError('skip')
        ->setAllowedErrors(1000)
        ->setMapping($mapping);
    $profiles->save($profile);
    $changedFile = "$datasets/$set-1pct.csv";
    $changedRows = one_percent($file, $changedFile);

    $passes = [
        ['dry run', $file, '--dry-run'],
        ['import', $file, ''],
        ['same file (delta)', $file, ''],
        ['same file (--full)', $file, '--full'],
        ["1 % changed ($changedRows rows, delta)", $changedFile, ''],
    ];
    foreach ($passes as [$pass, $passFile, $flag]) {
        $started = microtime(true);
        $command = sprintf(
            'php -d memory_limit=-1 bin/magento openimport:run %s --file=%s %s 2>&1',
            escapeshellarg($name),
            escapeshellarg($passFile),
            $flag
        );
        exec($command, $lines, $exit);
        $seconds = microtime(true) - $started;
        $criteria = $om->create(SearchCriteriaBuilder::class)
            ->addFilter('profile_name', $name)
            ->setSortOrders([$om->create(SortOrderBuilder::class)->setField('run_id')->setDescendingDirection()->create()])
            ->setPageSize(1)
            ->create();
        $items = $om->create(RunRepositoryInterface::class)->getList($criteria)->getItems();
        $run = reset($items);
        $line = [
            'dataset' => $set,
            'pass' => $pass,
            'status' => $run instanceof RunInterface ? $run->getStatus() : 'missing',
            'read' => $run instanceof RunInterface ? $run->getCount('read') : 0,
            'unchanged' => $run instanceof RunInterface ? $run->getCount('unchanged') : 0,
            'created' => $run instanceof RunInterface ? $run->getCount('created') : 0,
            'updated' => $run instanceof RunInterface ? $run->getCount('updated') : 0,
            'errors' => $run instanceof RunInterface ? $run->getCount('errors') : 0,
            'seconds' => round($seconds, 1),
            'peak_mb' => $run instanceof RunInterface ? $run->getPeakMemoryMb() : 0,
            'exit' => $exit,
            'message' => $run instanceof RunInterface ? $run->getMessage() : implode("\n", array_slice($lines, -5)),
        ];
        $lines = [];
        $results[] = $line;
        echo json_encode($line), "\n";
        file_put_contents($output, json_encode(['php' => PHP_VERSION, 'results' => $results], JSON_PRETTY_PRINT));
    }
}
