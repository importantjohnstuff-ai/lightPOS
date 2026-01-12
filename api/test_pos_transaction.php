<?php
// api/test_pos_transaction.php
ini_set('display_errors', 1);
error_reporting(E_ALL);
require_once __DIR__ . '/SQLiteStore.php';

$store = new SQLiteStore();
$testId = 'txn_test_' . time();
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

echo "=== Starting POS Transaction Health Check ===\n\n";

try {
    // TEST 1: INSERT TRANSACTION
    // Testing heavy JSON blob (items_json) and typical POS fields (total, tax, timestamp)
    echo "--- Test 1: INSERT Transaction ---\n";
    
    $itemsJson = json_encode([
        [
            "name" => "Test Item A",
            "price" => 10.00,
            "qty" => 2,
            "subtotal" => 20.00
        ],
        [
            "name" => "Test Item B",
            "price" => 5.50,
            "qty" => 1,
            "subtotal" => 5.50
        ]
    ]);

    $txnPayload = [
        'id' => $testId,
        'timestamp' => time() * 1000,
        'user_email' => 'admin@lightpos.com',
        'customer_id' => 'guest',
        'total_amount' => 25.50,              // Float
        'items_json' => $itemsJson,           // JSON String
        '_version' => 1,
        '_updatedAt' => time() * 1000,
        '_deleted' => 0
    ];
    
    echo "Inserting Transaction ID: $testId\n";
    echo "Total: " . $txnPayload['total_amount'] . "\n";
    
    $store->pdo->beginTransaction();
    $store->upsert('transactions', $txnPayload);
    $store->pdo->commit();
    assertTest("Insert Transaction Completed", true, $results);

    // TEST 2: READ TRANSACTION
    echo "\n--- Test 2: READ Transaction ---\n";
    $stmt = $store->pdo->prepare("SELECT * FROM transactions WHERE id = ?");
    $stmt->execute([$testId]);
    $txn = $stmt->fetch(PDO::FETCH_ASSOC);
    
    // Verify Integrity
    assertTest("Transaction Found", $txn && $txn['id'] === $testId, $results);
    assertTest("Total Amount Preserved (25.50)", isset($txn['total_amount']) && abs($txn['total_amount'] - 25.50) < 0.01, $results);
    
    $decodedItems = json_decode($txn['items_json'] ?? '[]', true);
    assertTest("JSON Items Preserved (Count=2)", count($decodedItems) === 2, $results);
    assertTest("Item Content Valid", $decodedItems[0]['name'] === "Test Item A", $results);

    // TEST 3: DELETE TRANSACTION
    echo "\n--- Test 3: DELETE Transaction (Cleanup) ---\n";
    $store->delete('transactions', $testId);
    
    // Hard cleanup for test hygiene
    $store->pdo->exec("DELETE FROM transactions WHERE id = '$testId'");
    assertTest("Cleanup Completed", true, $results);

} catch (Throwable $e) {
    echo "\n[CRITICAL FAIL] " . $e->getMessage() . "\n";
    echo $e->getTraceAsString();
    if ($store->pdo->inTransaction()) {
        $store->pdo->rollBack();
    }
}

echo "\n=== POS Test Complete ===\n";
if (in_array(false, $results, true)) {
    echo "RESULT: FAILURES DETECTED\n";
} else {
    echo "RESULT: POS TRANSACTION SYSTEM GO 🚀\n";
}
