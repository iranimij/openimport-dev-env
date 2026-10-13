<?php
/**
 * Copyright © Iman Aboheydary. All rights reserved.
 * See LICENSE for license details (MIT).
 *
 * M0 baseline (07 · Build Brief §4.4): how long Magento's own import takes for the generated datasets, and how much
 * OpenImport's core bridge adds when the same rows come through MappedSource instead of core's CSV source.
 * Run from the Magento root: php <dev-env>/ci/benchmark.php <datasets dir> <output json> [products-10k ...]
 *
 * Each measurement is a fresh import (new entities) followed by the same file again (every entity updated, no data
 * changes), so both "first import" and "nightly re-import" are measured. The OpenImport pass imports the same rows
 * with another SKU / e-mail prefix, so it creates its own entities too.
 */

declare(strict_types=1);

// phpcs:ignoreFile -- benchmark script, runs outside the module.

use Iranimij\OpenImport\Model\Bridge\CoreImporter;
use Iranimij\OpenImport\Model\Bridge\ImportRequest;
use Iranimij\OpenImport\Model\Source\MappedSource;
use Magento\Framework\App\Bootstrap;
use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\App\State;
use Magento\Framework\Filesystem;
use Magento\ImportExport\Model\Import\Source\Csv;

require getcwd() . '/app/bootstrap.php';

$datasets = rtrim($argv[1] ?? '', '/');
$output = $argv[2] ?? 'benchmark.json';
$sets = array_slice($argv, 3) ?: ['products-10k', 'customers-20k', 'products-50k'];
$entities = ['products-10k' => 'catalog_product', 'products-50k' => 'catalog_product', 'customers-20k' => 'customer_composite'];

$bootstrap = Bootstrap::create(BP, $_SERVER);
$om = $bootstrap->getObjectManager();
$om->get(State::class)->setAreaCode('adminhtml');
$importer = $om->get(CoreImporter::class);
$filesystem = $om->get(Filesystem::class);
$root = $filesystem->getDirectoryWrite(DirectoryList::ROOT);

/** Rows of a CSV file as associative arrays, with SKU / e-mail / URL key prefixes swapped for OpenImport's pass. */
function rows(string $file, bool $swap): \Generator
{
    $handle = fopen($file, 'r');
    $header = fgetcsv($handle, null, ',', '"', '\\');
    while (($row = fgetcsv($handle, null, ',', '"', '\\')) !== false) {
        $assoc = array_combine($header, $row);
        if ($swap) {
            foreach (['sku', 'url_key', 'email', 'configurable_variations'] as $column) {
                if (isset($assoc[$column]) && $assoc[$column] !== '') {
                    $assoc[$column] = str_replace(['OI-', 'oi-', 'oi.customer'], ['OB-', 'ob-', 'ob.customer'], $assoc[$column]);
                }
            }
        }
        yield $assoc;
    }
    fclose($handle);
}

function header_of(string $file): array
{
    $handle = fopen($file, 'r');
    $header = fgetcsv($handle, null, ',', '"', '\\');
    fclose($handle);

    return $header;
}

$results = [];
foreach ($sets as $set) {
    $file = "$datasets/$set.csv";
    if (!is_file($file)) {
        fwrite(STDERR, "missing $file\n");
        exit(1);
    }
    $entity = $entities[$set];
    foreach (['core', 'openimport'] as $path) {
        foreach (['create', 'update'] as $pass) {
            gc_collect_cycles();
            memory_reset_peak_usage();
            $source = $path === 'core'
                ? $om->create(Csv::class, ['file' => $file, 'directory' => $root])
                : new MappedSource(header_of($file), static fn () => rows($file, true));
            $started = microtime(true);
            $result = $importer->run(new ImportRequest($entity, historyLabel: "benchmark-$set-$path-$pass.csv"), $source);
            $seconds = microtime(true) - $started;
            $line = [
                'dataset' => $set,
                'path' => $path,
                'pass' => $pass,
                'rows' => $result->rows,
                'entities' => $result->entities,
                'created' => $result->created,
                'updated' => $result->updated,
                'invalid' => $result->invalidRows,
                'imported' => $result->imported,
                'seconds' => round($seconds, 1),
                'rows_per_minute' => $seconds > 0 ? (int) round($result->rows / $seconds * 60) : 0,
                'peak_mb' => round(memory_get_peak_usage(true) / 1048576, 1),
                'first_error' => $result->errors[0]->message ?? null,
            ];
            $results[] = $line;
            echo json_encode($line), "\n";
            file_put_contents($output, json_encode([
                'magento' => $om->get(\Magento\Framework\App\ProductMetadataInterface::class)->getVersion(),
                'php' => PHP_VERSION,
                'cpu' => trim((string) @shell_exec('nproc')),
                'results' => $results,
            ], JSON_PRETTY_PRINT));
        }
    }
}
