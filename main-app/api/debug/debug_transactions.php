<?php
/**
 * Debug endpoint to analyze transactions around a specific time period
 * Usage: GET /api/debug_transactions.php?date=2026-01-19
 */

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate');
header("Access-Control-Allow-Origin: *");

require_once __DIR__ . '/../core/SQLiteStore.php';

$store = new SQLiteStore();

$targetDate = $_GET['date'] ?? date('Y-m-d');
$userFilter = $_GET['user'] ?? null;

try {
    $allTransactions = $store->getAll('transactions');

    $dayStart = strtotime($targetDate . ' 00:00:00') * 1000;
    $dayEnd = strtotime($targetDate . ' 23:59:59') * 1000;

    $todayTransactions = [];
    $timestampFormats = [];

    foreach ($allTransactions as $tx) {
        $rawTimestamp = $tx['timestamp'] ?? null;
        $txTime = null;
        $format = 'unknown';

        if ($rawTimestamp !== null) {
            if (is_numeric($rawTimestamp)) {
                $txTime = (int) $rawTimestamp;
                $format = 'numeric_ms';
            } else {
                $parsed = strtotime($rawTimestamp);
                if ($parsed !== false) {
                    $txTime = $parsed * 1000;
                    $format = 'iso_string';
                }
            }
        }

        // Track formats for debugging
        if (!isset($timestampFormats[$format])) {
            $timestampFormats[$format] = 0;
        }
        $timestampFormats[$format]++;

        // Check if within target day
        if ($txTime !== null && $txTime >= $dayStart && $txTime <= $dayEnd) {
            $txUser = $tx['user_email'] ?? $tx['user_id'] ?? 'unknown';

            // User filter
            if ($userFilter && stripos($txUser, $userFilter) === false) {
                continue;
            }

            $todayTransactions[] = [
                'id' => $tx['id'] ?? 'no-id',
                'timestamp_raw' => $rawTimestamp,
                'timestamp_parsed' => $txTime,
                'timestamp_human' => date('Y-m-d H:i:s', $txTime / 1000),
                'user' => $txUser,
                'total' => $tx['total_amount'] ?? $tx['total'] ?? 0,
                'is_voided' => $tx['is_voided'] ?? false,
                'payment_method' => $tx['payment_method'] ?? 'cash'
            ];
        }
    }

    // Sort by timestamp
    usort($todayTransactions, function ($a, $b) {
        return ($a['timestamp_parsed'] ?? 0) - ($b['timestamp_parsed'] ?? 0);
    });

    // Get shift time for comparison
    $shiftId = $_GET['shift_id'] ?? null;
    $shiftInfo = null;

    if ($shiftId) {
        $shifts = $store->getAll('shifts');
        foreach ($shifts as $shift) {
            if ($shift['id'] === $shiftId) {
                $shiftStart = $shift['start_time'];
                $shiftEnd = $shift['end_time'];

                // Parse shift times
                if (!is_numeric($shiftStart)) {
                    $shiftStart = strtotime($shiftStart) * 1000;
                }
                if ($shiftEnd && !is_numeric($shiftEnd)) {
                    $shiftEnd = strtotime($shiftEnd) * 1000;
                }

                $shiftInfo = [
                    'id' => $shiftId,
                    'start_raw' => $shift['start_time'],
                    'end_raw' => $shift['end_time'],
                    'start_ms' => $shiftStart,
                    'end_ms' => $shiftEnd,
                    'start_human' => date('Y-m-d H:i:s', $shiftStart / 1000),
                    'end_human' => $shiftEnd ? date('Y-m-d H:i:s', $shiftEnd / 1000) : 'OPEN',
                    'user' => $shift['user_id'] ?? $shift['user_email'] ?? 'unknown'
                ];
                break;
            }
        }
    }

    echo json_encode([
        'target_date' => $targetDate,
        'day_range_ms' => ['start' => $dayStart, 'end' => $dayEnd],
        'total_transactions_in_db' => count($allTransactions),
        'transactions_on_target_date' => count($todayTransactions),
        'timestamp_formats_found' => $timestampFormats,
        'shift_info' => $shiftInfo,
        'transactions' => array_slice($todayTransactions, 0, 50) // Limit output
    ], JSON_PRETTY_PRINT);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'error' => 'Server error: ' . $e->getMessage()
    ]);
}
