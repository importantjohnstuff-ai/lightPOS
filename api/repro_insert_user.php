<?php
ini_set('display_errors', 1);
error_reporting(E_ALL);
require_once __DIR__ . '/SQLiteStore.php';

$store = new SQLiteStore();
echo "Attempting to INSERT new user...\n";

try {
    // The exact failing payload from the logs
    $userPayload = [
        "email" => "b@lp.com",
        "name" => "123",
        "is_active" => 1, // Integer 1 (not boolean true)
        "_version" => 1,
        "_updatedAt" => 1768195805088,
        "_deleted" => 0,
        "password_hash" => "25f9e794323b453885f5181f1b624d0b",
        "permissions_json" => '{"pos":{"read":true,"write":true},"customers":{"read":true,"write":true},"shifts":{"read":true,"write":true},"items":{"read":true,"write":true},"suppliers":{"read":true,"write":true},"purchase_orders":{"read":true,"write":true},"stockin":{"read":true,"write":true},"stock-count":{"read":true,"write":true},"expenses":{"read":true,"write":true},"reports":{"read":true,"write":true},"users":{"read":true,"write":true},"migrate":{"read":true,"write":true},"returns":{"read":true,"write":true},"settings":{"read":true,"write":true}}'
    ];

    // Wipe first to ensure we hit INSERT path
    echo "Wiping users table first to force INSERT...\n";
    $store->wipe('users');

    echo "Payload: " . json_encode($userPayload) . "\n";
    
    // Explicitly check _updatedAt type
    echo "Type of _updatedAt: " . gettype($userPayload['_updatedAt']) . "\n";

    echo "Starting Transaction...\n";
    $store->pdo->beginTransaction();
    echo "Calling upsert...\n";
    $store->upsert('users', $userPayload);
    echo "Upsert returned.\n";
    $store->pdo->commit();

    echo "INSERT Successful!\n";

} catch (Throwable $e) {
    echo "INSERT FAILED: " . $e->getMessage() . "\n";
    if ($store->pdo->inTransaction()) {
        $store->pdo->rollBack();
        echo "Rolled back.\n";
    }
}
