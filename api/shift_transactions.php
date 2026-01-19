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

require_once __DIR__ . '/SQLiteStore.php';

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

    // Parse shift times - handle both date objects and ISO strings
    $startTime = null;
    $endTime = null;

    if (isset($targetShift['start_time'])) {
        $startTime = is_numeric($targetShift['start_time'])
            ? $targetShift['start_time']
            : strtotime($targetShift['start_time']) * 1000;
    }

    if (isset($targetShift['end_time']) && $targetShift['end_time']) {
        $endTime = is_numeric($targetShift['end_time'])
            ? $targetShift['end_time']
            : strtotime($targetShift['end_time']) * 1000;
    } else {
        // If shift is still open, use current time
        $endTime = round(microtime(true) * 1000);
    }

    // Get user email for filtering
    $userEmail = $targetShift['user_id'] ?? $targetShift['user_email'] ?? null;

    // Fetch all transactions
    $allTransactions = $store->getAll('transactions');

    // Filter transactions by time range and user
    $shiftTransactions = [];
    foreach ($allTransactions as $tx) {
        $txTime = null;

        if (isset($tx['timestamp'])) {
            $txTime = is_numeric($tx['timestamp'])
                ? $tx['timestamp']
                : strtotime($tx['timestamp']) * 1000;
        }

        if ($txTime === null)
            continue;

        // Check if transaction is within shift time range
        if ($txTime >= $startTime && $txTime <= $endTime) {
            // Optional: also filter by user
            $txUser = $tx['user_email'] ?? $tx['user_id'] ?? null;

            // Normalize for comparison
            $userMatch = true;
            if ($userEmail && $txUser) {
                $userMatch = strtolower(trim($userEmail)) === strtolower(trim($txUser));
            }

            if ($userMatch) {
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
            'start_time' => $targetShift['start_time'],
            'end_time' => $targetShift['end_time'] ?? 'OPEN',
            'status' => $targetShift['status'] ?? 'unknown'
        ],
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
