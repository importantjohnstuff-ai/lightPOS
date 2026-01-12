<?php
ini_set('display_errors', 1);
ini_set('display_startup_errors', 1);
error_reporting(E_ALL);

require_once __DIR__ . '/SQLiteStore.php';

$store = new SQLiteStore();

echo "Starting Repro Reset...\n";

try {
    // Transaction 1: Wipe
    $store->pdo->beginTransaction();
    echo "Transaction 1 started (Wipe).\n";

    echo "Wiping users...\n";
    $store->wipe('users');
    echo "Users wiped.\n";
    
    $store->pdo->commit();
    echo "Transaction 1 committed.\n";

    // Transaction 2: Seed
    $store->pdo->beginTransaction();
    echo "Transaction 2 started (Seed).\n";

    echo "Seeding admin...\n";
    $defaultAdmin = [
        "email" => "admin@lightpos.com",
        "name" => "Super Admin",
        "password_hash" => md5("admin123"),
        "role" => null, 
        "is_active" => true,
        "_version" => 1,
        "_updatedAt" => round(microtime(true) * 1000),
        "_deleted" => 0,
        "permissions_json" => '{"pos":{"read":true}}'
    ];
    $store->upsert('users', $defaultAdmin);
    echo "Admin seeded.\n";

    $store->pdo->commit();
    echo "Reset Successful!\n";

} catch (Throwable $e) {
    echo "RESET FAILED (Throwable): " . $e->getMessage() . "\n";
    echo "Trace: " . $e->getTraceAsString() . "\n";
    if ($store->pdo->inTransaction()) {
        $store->pdo->rollBack();
        echo "Rolled back.\n";
    }
}
