<?php
require_once __DIR__ . '/SQLiteStore.php';

$store = new SQLiteStore();

// Exact failing payload from logs
$record = [
    'email' => 'admin@lightpos.com',
    'name' => 'Super Admin',
    'password_hash' => '0192023a7bbd73250516f069df18b500',
    'role' => null, // Suspicious NULL value
    'is_active' => 1,
    '_version' => 2,
    '_updatedAt' => 1768191510333,
    '_deleted' => 0,
    'permissions_json' => '{"pos":{"read":true,"write":true},"customers":{"read":true,"write":true},"shifts":{"read":true,"write":true},"items":{"read":true,"write":true},"suppliers":{"read":true,"write":true},"purchase_orders":{"read":true,"write":true},"stockin":{"read":true,"write":true},"stock-count":{"read":true,"write":true},"expenses":{"read":true,"write":true},"reports":{"read":true,"write":true},"users":{"read":true,"write":true},"migrate":{"read":true,"write":true},"returns":{"read":true,"write":true},"settings":{"read":true,"write":true}}'
];

try {
    echo "Attempting upsert admin (with NULL role)...\n";
    $store->upsert('users', $record);
    echo "Upsert admin successful!\n";
} catch (Exception $e) {
    echo "Upsert admin failed: " . $e->getMessage() . "\n";
}
