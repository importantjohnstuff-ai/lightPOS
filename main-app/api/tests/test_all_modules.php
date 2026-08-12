<?php
// api/test_all_modules.php
ini_set('display_errors', 1);
error_reporting(E_ALL);
require_once __DIR__ . '/../core/SQLiteStore.php';

$store = new SQLiteStore();
$results = [];

function assertTest($name, $condition, &$results) {
    if ($condition) {
        echo "[PASS] $name\n";
        $results[] = true;
    } else {
        echo "[FAIL] $name\n";
        $results[] = false;
    }
}

function runCrudTest($store, $collection, $payload, &$results) {
    echo "\n>>> Testing Module: $collection <<<\n";
    $id = $payload['id'] ?? $payload['sku_id'] ?? $payload['supplier_id'] ?? $payload['key'] ?? null;
    
    if (!$id && $collection === 'users') $id = $payload['email'];

    try {
        // CREATE
        $store->pdo->beginTransaction();
        $store->upsert($collection, $payload);
        $store->pdo->commit();
        assertTest("INSERT $collection", true, $results);

        // READ
        $idCol = ($collection === 'users') ? 'email' : 
                 (($collection === 'inventory_metrics') ? 'sku_id' : 
                 (($collection === 'supplier_config') ? 'supplier_id' : 
                 (($collection === 'sync_metadata') ? 'key' : 'id')));

        $stmt = $store->pdo->prepare("SELECT * FROM $collection WHERE $idCol = ?");
        $stmt->execute([$id]);
        $record = $stmt->fetch(PDO::FETCH_ASSOC);
        assertTest("READ $collection", $record && $record[$idCol] === $id, $results);

        // UPDATE (Check Float/Int handling)
        $payload['_version']++;
        $store->pdo->beginTransaction();
        $store->upsert($collection, $payload);
        $store->pdo->commit();
        
        $stmt->execute([$id]);
        $updated = $stmt->fetch(PDO::FETCH_ASSOC);
        assertTest("UPDATE $collection (_version incremented)", $updated['_version'] == $payload['_version'], $results);

        // DELETE
        if ($collection !== 'sync_metadata') {
             $store->delete($collection, $id);
             $stmt->execute([$id]);
             $deleted = $stmt->fetch(PDO::FETCH_ASSOC);
             assertTest("DELETE $collection (Soft)", $deleted['_deleted'] == 1, $results);
             
             // HARD CLEANUP
             $store->pdo->exec("DELETE FROM $collection WHERE $idCol = '$id'");
        } else {
             $store->pdo->exec("DELETE FROM sync_metadata WHERE key = '$id'");
        }

    } catch (Throwable $e) {
        echo "[CRITICAL FAIL] Module $collection: " . $e->getMessage() . "\n";
        if ($store->pdo->inTransaction()) {
            $store->pdo->rollBack();
        }
        $results[] = false;
    }
}

echo "=== Starting Full 17-Module System Check ===\n";

$timestamp = time() * 1000;

// 1. Items
runCrudTest($store, 'items', [
    'id' => 'test_item_' . time(),
    'name' => 'Auto Test Item',
    'stock_level' => 50,
    'selling_price' => 19.99,
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 2. Transactions
runCrudTest($store, 'transactions', [
    'id' => 'test_txn_' . time(),
    'total_amount' => 105.50,
    'items_json' => json_encode(['foo' => 'bar']),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 3. Users
runCrudTest($store, 'users', [
    'email' => 'test_user_' . time() . '@lp.com',
    'name' => 'Test Module User',
    'is_active' => 1,
    'password_hash' => md5('test'),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 4. Customers (JSON Body)
runCrudTest($store, 'customers', [
    'id' => 'test_cust_' . time(),
    'json_body' => json_encode(['name' => 'John Doe', 'loyalty' => 100]),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 5. Suppliers (JSON Body)
runCrudTest($store, 'suppliers', [
    'id' => 'test_supp_' . time(),
    'json_body' => json_encode(['company' => 'Acme Corp']),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 6. Shifts
runCrudTest($store, 'shifts', [
    'id' => 'test_shift_' . time(),
    'json_body' => json_encode(['cash_start' => 200, 'cash_end' => 500]),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 7. Expenses
runCrudTest($store, 'expenses', [
    'id' => 'test_exp_' . time(),
    'json_body' => json_encode(['amount' => 50.00, 'category' => 'Food']),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 8. Returns
runCrudTest($store, 'returns', [
    'id' => 'test_ret_' . time(),
    'json_body' => json_encode(['reason' => 'Damaged']),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 9. Stock Movements
runCrudTest($store, 'stock_movements', [
    'id' => 'test_move_' . time(),
    'json_body' => json_encode(['qty' => 5, 'direction' => 'in']),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 10. Adjustments
runCrudTest($store, 'adjustments', [
    'id' => 'test_adj_' . time(),
    'json_body' => json_encode(['reason' => 'Theft']),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 11. Stockins
runCrudTest($store, 'stockins', [
    'id' => 'test_stockin_' . time(),
    'json_body' => json_encode(['supplier' => 'Acme', 'items' => []]),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 12. Suspended Transactions
runCrudTest($store, 'suspended_transactions', [
    'id' => 'test_susp_' . time(),
    'json_body' => json_encode(['note' => 'customer forgot wallet']),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 13. Notifications
runCrudTest($store, 'notifications', [
    'id' => 'test_notif_' . time(),
    'json_body' => json_encode(['msg' => 'Low Stock']),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 14. Settings
runCrudTest($store, 'settings', [
    'id' => 'test_setting_' . time(),
    'json_body' => json_encode(['theme' => 'dark']),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 15. Inventory Metrics (PO Module)
runCrudTest($store, 'inventory_metrics', [
    'sku_id' => 'test_sku_' . time(),
    'abc_class' => 'A',
    'daily_velocity' => 1.5,
    'cv_value' => 0.2,
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 16. Supplier Config (PO Module)
runCrudTest($store, 'supplier_config', [
    'supplier_id' => 'test_supp_conf_' . time(),
    'lead_time_days' => 7,
    'monthly_otb' => 5000.00,
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);

// 17. Purchase Orders (PO Module)
runCrudTest($store, 'purchase_orders', [
    'id' => 'test_po_' . time(),
    'status' => 'draft',
    'total_amount' => 1500.50,
    'items_json' => json_encode([]),
    '_version' => 1, '_updatedAt' => $timestamp, '_deleted' => 0
], $results);


echo "\n=== All Module Tests Complete ===\n";
if (in_array(false, $results, true)) {
    echo "RESULT: FAILURES DETECTED\n";
} else {
    echo "RESULT: ALL MODULES GREEN 🟢\n";
}
