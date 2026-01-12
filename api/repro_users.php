<?php
require_once __DIR__ . '/SQLiteStore.php';

$store = new SQLiteStore();

// failing payload from logs
$record = [
    'email' => 'lp@lp.com',
    'name' => 'sd',
    'is_active' => 1,
    '_version' => 1,
    '_updatedAt' => 1768188304378,
    '_deleted' => 0,
    'password_hash' => '5f4dcc3b5aa765d61d8327deb882cf99',
    'permissions_json' => '{"pos":{"read":true,"write":true},"customers":{"read":true,"write":true},"shifts":{"read":true,"write":true},"items":{"read":false,"write":false},"suppliers":{"read":false,"write":false},"purchase_orders":{"read":false,"write":false},"stockin":{"read":false,"write":false},"stock-count":{"read":false,"write":false},"expenses":{"read":false,"write":false},"reports":{"read":false,"write":false},"users":{"read":false,"write":false},"migrate":{"read":false,"write":false},"returns":{"read":true,"write":true},"settings":{"read":false,"write":false}}'
];

try {
    echo "Attempting upsert users...\n";
    $store->upsert('users', $record);
    echo "Upsert users successful!\n";
} catch (Exception $e) {
    echo "Upsert users failed: " . $e->getMessage() . "\n";
}
