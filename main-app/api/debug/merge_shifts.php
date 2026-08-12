<?php
/**
 * Utility to merge two shifts
 * Usage: GET /api/merge_shifts.php
 */
header('Content-Type: application/json');
require_once __DIR__ . '/../core/SQLiteStore.php';

$store = new SQLiteStore();

// Hardcoded IDs for safety based on our conversation
$userEmail = 'joycenvista@lightpos.com';
$shiftA_Id = '41f42fd8-1f40-4ba4-8e18-bee465a21943';
$shiftB_Id = 'b3ee08af-c432-4735-a453-b0f138b7b79a';

try {
    $shifts = $store->getAll('shifts');
    $shiftA = null;
    $shiftB = null;

    foreach ($shifts as $s) {
        if ($s['id'] === $shiftA_Id)
            $shiftA = $s;
        if ($s['id'] === $shiftB_Id)
            $shiftB = $s;
    }

    if (!$shiftA || !$shiftB) {
        echo json_encode(['error' => 'One or both shifts not found']);
        exit;
    }

    // Merge Logic:
    // 1. Update Shift A End Time -> Shift B End Time
    // 2. Update Shift A Closing Cash -> Shift B Closing Cash (usually the final cash count is the one that matters)
    // 3. Delete Shift B

    // Backup for safety
    $shiftA_Backup = $shiftA;

    // 1. Update End Time
    $shiftA['end_time'] = $shiftB['end_time'];

    // 2. Update Cash (Use the latest closing count from Shift B)
    $shiftA['closing_cash'] = $shiftB['closing_cash'];

    // Update metadata
    $shiftA['_updatedAt'] = round(microtime(true) * 1000);
    $shiftA['_version'] = ($shiftA['_version'] ?? 0) + 1;

    // 3. Mark Shift B as deleted
    $shiftB['_deleted'] = 1;
    $shiftB['_updatedAt'] = round(microtime(true) * 1000);
    $shiftB['_version'] = ($shiftB['_version'] ?? 0) + 1;

    // Execute Transaction
    $store->beginTransaction();
    $store->upsert('shifts', $shiftA);
    $store->upsert('shifts', $shiftB);
    $store->commit();

    echo json_encode([
        'success' => true,
        'message' => 'Shifts merged successfully.',
        'merged_shift' => [
            'id' => $shiftA['id'],
            'start' => $shiftA['start_time'],
            'end' => $shiftA['end_time'],
            'closing_cash' => $shiftA['closing_cash']
        ],
        'deleted_shift' => $shiftB['id']
    ], JSON_PRETTY_PRINT);

} catch (Exception $e) {
    if ($store->pdo->inTransaction()) {
        $store->rollBack();
    }
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
