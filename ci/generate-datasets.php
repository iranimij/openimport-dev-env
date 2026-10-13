<?php
/**
 * Copyright © Iman Aboheydary. All rights reserved.
 * See LICENSE for license details (MIT).
 *
 * Deterministic benchmark datasets in Magento's own import CSV format (the format core's import reads, so the
 * baseline measures core alone). Usage: php ci/generate-datasets.php <output dir> [all|products-10k|products-50k|
 * configurables-2k|customers-20k] ...
 *
 * - products-10k / products-50k: simple products, 3 categories each, stock, price, special price on every 7th,
 *   description, weight, a German store-view name row on every 10th product.
 * - configurables-2k: 2,000 configurable products with 6 simple children each (color x size), 14,000 rows; the
 *   attributes "color" and "size" and their options must exist (the generator lists the option labels it uses).
 * - customers-20k: customers with one default billing/shipping address (customer_composite entity).
 */

declare(strict_types=1);

// phpcs:ignoreFile -- fixture script, runs outside the module.

$dir = rtrim($argv[1] ?? 'fixtures/files/generated', '/');
$sets = array_slice($argv, 2) ?: ['all'];
if (in_array('all', $sets, true)) {
    $sets = ['products-10k', 'products-50k', 'configurables-2k', 'customers-20k'];
}
if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
    fwrite(STDERR, "Cannot create $dir\n");
    exit(1);
}

mt_srand(20261013);

const CATEGORIES = [
    'Default Category/Outdoor/Shoes', 'Default Category/Outdoor/Jackets', 'Default Category/Outdoor/Bags',
    'Default Category/Outdoor/Tents', 'Default Category/Home/Kitchen', 'Default Category/Home/Garden',
    'Default Category/Sale', 'Default Category/New',
];
const WORDS = ['trail', 'alpine', 'rain', 'light', 'pro', 'classic', 'urban', 'summit', 'river', 'forest', 'storm', 'sun'];
const COLORS = ['Black', 'Blue', 'Green'];
const SIZES = ['S', 'M'];

function writer(string $file): \Closure
{
    $handle = fopen($file, 'w');
    return static function (?array $row) use ($handle, $file): void {
        if ($row === null) {
            fclose($handle);
            echo $file . "\n";
            return;
        }
        fputcsv($handle, $row, ',', '"', '\\');
    };
}

function name(int $i): string
{
    return ucfirst(WORDS[$i % 12]) . ' ' . WORDS[intdiv($i, 12) % 12] . ' ' . $i;
}

function simple(string $sku, int $i, string $visibility = 'Catalog, Search', array $extra = []): array
{
    $categories = [CATEGORIES[$i % 8], CATEGORIES[($i + 3) % 8], CATEGORIES[($i + 5) % 8]];
    return $extra + [
        'sku' => $sku,
        'store_view_code' => '',
        'attribute_set_code' => 'Default',
        'product_type' => 'simple',
        'categories' => implode(',', array_unique($categories)),
        'product_websites' => 'base',
        'name' => name($i),
        'description' => '<p>' . str_repeat('Built for ' . WORDS[$i % 12] . ' days. ', 8) . '</p>',
        'short_description' => 'Model ' . $i,
        'weight' => number_format(0.2 + ($i % 40) / 10, 2, '.', ''),
        'product_online' => '1',
        'tax_class_name' => 'Taxable Goods',
        'visibility' => $visibility,
        'price' => number_format(9.99 + ($i % 300), 2, '.', ''),
        'special_price' => $i % 7 === 0 ? number_format(7.99 + ($i % 250), 2, '.', '') : '',
        'url_key' => 'oi-' . strtolower(str_replace(' ', '-', name($i))) . '-' . strtolower($sku),
        'qty' => (string) ($i % 50),
        'is_in_stock' => $i % 50 === 0 ? '0' : '1',
        'configurable_variations' => '',
        'additional_attributes' => '',
    ];
}

$productColumns = array_keys(simple('X', 1));

foreach ($sets as $set) {
    switch ($set) {
        case 'products-10k':
        case 'products-50k':
            $count = $set === 'products-10k' ? 10000 : 50000;
            $write = writer("$dir/$set.csv");
            $write($productColumns);
            for ($i = 1; $i <= $count; $i++) {
                $write(array_values(simple(sprintf('OI-S%06d', $i), $i)));
                if ($i % 10 === 0) {
                    $row = array_fill_keys($productColumns, '');
                    $row['sku'] = sprintf('OI-S%06d', $i);
                    $row['store_view_code'] = 'de';
                    // Core validates the rows of a product that is new in the file as new products: type and
                    // attribute set are required on store-view rows too.
                    $row['attribute_set_code'] = 'Default';
                    $row['product_type'] = 'simple';
                    $row['name'] = 'DE ' . name($i);
                    $write(array_values($row));
                }
            }
            $write(null);
            break;

        case 'configurables-2k':
            $write = writer("$dir/$set.csv");
            $write($productColumns);
            $n = 0;
            for ($p = 1; $p <= 2000; $p++) {
                $variations = [];
                foreach (COLORS as $color) {
                    foreach (SIZES as $size) {
                        $sku = sprintf('OI-C%05d-%s-%s', $p, strtolower($color), strtolower($size));
                        $write(array_values(simple($sku, ++$n, 'Not Visible Individually', [
                            'additional_attributes' => 'color=' . $color . ',size=' . $size,
                        ])));
                        $variations[] = 'sku=' . $sku . ',color=' . $color . ',size=' . $size;
                    }
                }
                $parent = simple(sprintf('OI-C%05d', $p), 100000 + $p);
                $parent['product_type'] = 'configurable';
                $parent['qty'] = '';
                $parent['configurable_variations'] = implode('|', $variations);
                $write(array_values($parent));
            }
            $write(null);
            echo 'needs options: color=' . implode('/', COLORS) . ' size=' . implode('/', SIZES) . "\n";
            break;

        case 'customers-20k':
            $write = writer("$dir/$set.csv");
            $columns = ['email', '_website', '_store', 'firstname', 'lastname', 'group_id', 'dob', 'gender',
                '_address_firstname', '_address_lastname', '_address_street', '_address_postcode', '_address_city',
                '_address_country_id', '_address_telephone', '_address_default_billing_', '_address_default_shipping_'];
            $write($columns);
            $cities = [['10115', 'Berlin'], ['60437', 'Frankfurt am Main'], ['80331', 'München'], ['20095', 'Hamburg']];
            for ($i = 1; $i <= 20000; $i++) {
                [$postcode, $city] = $cities[$i % 4];
                $first = ucfirst(WORDS[$i % 12]);
                $last = 'Kunde' . $i;
                $write([
                    sprintf('oi.customer%05d@example.com', $i), 'base', 'default', $first, $last, (string) (1 + $i % 3),
                    sprintf('19%02d-%02d-%02d', 50 + $i % 50, 1 + $i % 12, 1 + $i % 28), (string) (1 + $i % 2),
                    $first, $last, 'Musterstraße ' . (1 + $i % 200), $postcode, $city, 'DE', '+49 69 ' . (100000 + $i),
                    '1', '1',
                ]);
            }
            $write(null);
            break;

        default:
            fwrite(STDERR, "Unknown dataset $set\n");
            exit(1);
    }
}
