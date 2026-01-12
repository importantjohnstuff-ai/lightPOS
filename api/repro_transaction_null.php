<?php
require_once __DIR__ . '/SQLiteStore.php';

$store = new SQLiteStore();

$record = [
    'email' => 'admin@lightpos.com',
    'name' => 'Super Admin',
    'password_hash' => '0192023a7bbd73250516f069df18b500',
    'role' => null, // Suspicious NULL value
    'is_active' => 1,
    '_version' => 3, // Bump version
    '_updatedAt' => 1768191510335,
    '_deleted' => 0,
    'permissions_json' => '{"pos":{"read":true,"write":true}}'
];

try {
    echo "Attempting upsert admin (Transaction + NULL role)...\n";
    $store->pdo->beginTransaction();
    $store->upsert('users', $record);
    $store->pdo->commit();
    echo "Upsert admin successful!\n";
} catch (Exception $e) {
    if ($store->pdo->inTransaction()) {
        $store->pdo->rollBack();
    }
    echo "Upsert admin failed: " . $e->getMessage() . "\n";
}
