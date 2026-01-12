<?php
// api/test_suite.php
ini_set('display_errors', 1);
error_reporting(E_ALL);
require_once __DIR__ . '/SQLiteStore.php';

$store = new SQLiteStore();
$testId = 'test_item_' . time();
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

echo "=== Starting Full System Health Check ===\n\n";

try {
    // TEST 1: INSERT ITEM (Checking Float/Int binding with mixed types)
    // This verifies that our 'Nuclear String Cast' fix works for specific schema columns (REAL, INTEGER)
    echo "--- Test 1: INSERT Item (Float/Int/String) ---\n";
    $itemPayload = [
        'id' => $testId,
        'name' => 'Test Product ' . time(),
        'barcode' => '999999',
        'selling_price' => 10.50, // Float
        'stock_level' => 100,     // Int
        'cost_price' => 5.25,     // Float
        '_version' => 1,
        '_updatedAt' => time() * 1000,
        '_deleted' => 0
    ];
    
    echo "Inserting Payload: " . json_encode($itemPayload) . "\n";
    
    $store->pdo->beginTransaction();
    $store->upsert('items', $itemPayload);
    $store->pdo->commit();
    assertTest("Insert Item Completed", true, $results);

    // TEST 2: READ ITEM
    echo "\n--- Test 2: READ Item ---\n";
    $stmt = $store->pdo->prepare("SELECT * FROM items WHERE id = ?");
    $stmt->execute([$testId]);
    $item = $stmt->fetch(PDO::FETCH_ASSOC);
    
    // Verify data integrity
    assertTest("Item Found in DB", $item && $item['id'] === $testId, $results);
    assertTest("Float Value Preserved (10.5)", isset($item['selling_price']) && abs($item['selling_price'] - 10.50) < 0.01, $results);
    assertTest("Int Value Preserved (100)", isset($item['stock_level']) && $item['stock_level'] == 100, $results);

    // TEST 3: UPDATE ITEM
    echo "\n--- Test 3: UPDATE Item ---\n";
    $item['selling_price'] = 20.99;
    $item['stock_level'] = 50;
    $item['_version'] = 2;
    
    echo "Updating to Price: 20.99, Stock: 50\n";
    
    $store->pdo->beginTransaction();
    $store->upsert('items', $item);
    $store->pdo->commit();

    // Re-Read to verify update
    $stmt->execute([$testId]);
    $updatedItem = $stmt->fetch(PDO::FETCH_ASSOC);
    
    assertTest("Price Updated to 20.99", abs($updatedItem['selling_price'] - 20.99) < 0.01, $results);
    assertTest("Stock Updated to 50", $updatedItem['stock_level'] == 50, $results);
    
    // TEST 4: DELETE ITEM (Soft Delete)
    echo "\n--- Test 4: DELETE Item (Soft) ---\n";
    $store->delete('items', $testId);
    
    $stmt->execute([$testId]);
    $deletedItem = $stmt->fetch(PDO::FETCH_ASSOC);
    assertTest("Item marked as deleted (_deleted = 1)", $deletedItem['_deleted'] == 1, $results);

    // TEST 5: CLEANUP (Hard Delete)
    echo "\n--- Test 5: Cleanup ---\n";
    $store->pdo->exec("DELETE FROM items WHERE id = '$testId'");
    echo "[INFO] Test data cleaned up.\n";

} catch (Throwable $e) {
    echo "\n[CRITICAL FAIL] " . $e->getMessage() . "\n";
    echo $e->getTraceAsString();
    if ($store->pdo->inTransaction()) {
        $store->pdo->rollBack();
    }
}

echo "\n=== Tests Complete ===\n";
if (in_array(false, $results, true)) {
    echo "RESULT: FAILURES DETECTED\n";
} else {
    echo "RESULT: ALL SYSTEMS GO 🚀\n";
}
