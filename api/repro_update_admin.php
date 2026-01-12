<?php
ini_set('display_errors', 1);
error_reporting(E_ALL);
require_once __DIR__ . '/SQLiteStore.php';

$store = new SQLiteStore();
echo "Attempting to update Admin user...\n";

try {
    // 1. Fetch current admin to ensure it exists
    $adminEmail = 'admin@lightpos.com';
    $users = $store->getAll('users');
    $adminUser = null;
    foreach ($users as $u) {
        if ($u['email'] === $adminEmail) {
            $adminUser = $u;
            break;
        }
    }

    if (!$adminUser) {
        die("Admin user not found! Please reset system first.\n");
    }

    echo "Found Admin: " . $adminUser['name'] . "\nRole: " . var_export($adminUser['role'], true) . "\n";

    // 2. Prepare Update Payload
    // Simulate what the client might send: Full object with modified permissions
    $updatePayload = $adminUser;
    $updatePayload['_updatedAt'] = round(microtime(true) * 1000);
    $updatePayload['_version'] = (int)$updatePayload['_version'] + 1;
    // Ensure role is explicitly set to match what we assume fails (NULL)
    $updatePayload['role'] = null; 
    
    // Modify permissions slightly to ensure it's a real change
    $perms = json_decode($updatePayload['permissions_json'], true);
    if (!$perms) $perms = [];
    $perms['test_update_'.time()] = true;
    $updatePayload['permissions_json'] = json_encode($perms);

    echo "Payload prepared. Role is: " . var_export($updatePayload['role'], true) . "\n";

    // 3. Execute Upsert (Update)
    echo "Starting Transaction...\n";
    $store->pdo->beginTransaction();
    echo "Calling upsert...\n";
    $store->upsert('users', $updatePayload);
    echo "Upsert returned.\n";
    $store->pdo->commit();

    echo "Update Successful!\n";

} catch (Throwable $e) {
    echo "UPDATE FAILED: " . $e->getMessage() . "\n";
    if ($store->pdo->inTransaction()) {
        $store->pdo->rollBack();
        echo "Rolled back.\n";
    }
}
