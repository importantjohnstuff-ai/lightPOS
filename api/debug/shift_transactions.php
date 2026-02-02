<?php
/**
 * Endpoint to fetch transactions for a specific shift
 * Usage: GET /api/shift_transactions.php?shift_id=<shift_id>
 * 
 * Example curl:
 * curl "http://192.168.0.177/lightPOS/api/shift_transactions.php?shift_id=abc123"
 */

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate');
header("Access-Control-Allow-Origin: *");

require_once __DIR__ . '/../core/SQLiteStore.php';

$store = new SQLiteStore();

$shiftId = $_GET['shift_id'] ?? null;

if (!$shiftId) {
    http_response_code(400);
    echo json_encode([
        'error' => 'Missing shift_id parameter',
        'usage' => 'GET /api/shift_transactions.php?shift_id=<shift_id>'
    ]);
    exit;
}

// Helper to parse timestamp to milliseconds
function parseTimestampMs($ts)
{
    if ($ts === null)
        return null;
    if (is_numeric($ts))
        return (int) $ts;
    $parsed = strtotime($ts);
    return $parsed !== false ? $parsed * 1000 : null;
}

try {
    // Get the shift details first
    $shifts = $store->getAll('shifts');
    $targetShift = null;

    foreach ($shifts as $shift) {
        if ($shift['id'] === $shiftId) {
            $targetShift = $shift;
            break;
        }
    }

    if (!$targetShift) {
        http_response_code(404);
        echo json_encode([
            'error' => 'Shift not found',
            'shift_id' => $shiftId
        ]);
        exit;
    }

    // Parse shift times to milliseconds
    $startTimeMs = parseTimestampMs($targetShift['start_time']);
    $endTimeMs = parseTimestampMs($targetShift['end_time']);

    // If shift is still open, use current time
    if ($endTimeMs === null) {
        $endTimeMs = round(microtime(true) * 1000);
    }

    // Get user email for filtering
    $userEmail = strtolower(trim($targetShift['user_id'] ?? $targetShift['user_email'] ?? ''));

    // Fetch all transactions
    $allTransactions = $store->getAll('transactions');

    // Filter transactions by time range and user
    $shiftTransactions = [];
    $debugMatchInfo = ['checked' => 0, 'in_range' => 0, 'user_match' => 0];

    foreach ($allTransactions as $tx) {
        $txTimeMs = parseTimestampMs($tx['timestamp']);
        $debugMatchInfo['checked']++;

        if ($txTimeMs === null)
            continue;

        // Check if transaction is within shift time range
        if ($txTimeMs >= $startTimeMs && $txTimeMs <= $endTimeMs) {
            $debugMatchInfo['in_range']++;

            // Filter by user
            $txUser = strtolower(trim($tx['user_email'] ?? $tx['user_id'] ?? ''));

            if ($userEmail === '' || $txUser === $userEmail) {
                $debugMatchInfo['user_match']++;
                $shiftTransactions[] = $tx;
            }
        }
    }

    // Calculate summary
    $totalSales = 0;
    $totalVoids = 0;
    $cashSales = 0;
    $gcashSales = 0;

    foreach ($shiftTransactions as $tx) {
        $amount = floatval($tx['total_amount'] ?? $tx['total'] ?? 0);
        $isVoided = $tx['is_voided'] ?? $tx['voided'] ?? false;

        if ($isVoided) {
            $totalVoids += $amount;
        } else {
            $totalSales += $amount;

            $paymentMethod = strtolower($tx['payment_method'] ?? 'cash');
            if ($paymentMethod === 'gcash') {
                $gcashSales += $amount;
            } else {
                $cashSales += $amount;
            }
        }
    }

    echo json_encode([
        'shift' => [
            'id' => $targetShift['id'],
            'user' => $userEmail,
            'start_time_raw' => $targetShift['start_time'],
            'end_time_raw' => $targetShift['end_time'] ?? 'OPEN',
            'start_time_ms' => $startTimeMs,
            'end_time_ms' => $endTimeMs,
            'status' => $targetShift['status'] ?? 'unknown'
        ],
        'debug' => $debugMatchInfo,
        'summary' => [
            'transaction_count' => count($shiftTransactions),
            'total_sales' => round($totalSales, 2),
            'total_voids' => round($totalVoids, 2),
            'cash_sales' => round($cashSales, 2),
            'gcash_sales' => round($gcashSales, 2)
        ],
        'transactions' => $shiftTransactions
    ], JSON_PRETTY_PRINT);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'error' => 'Server error: ' . $e->getMessage()
    ]);
}
