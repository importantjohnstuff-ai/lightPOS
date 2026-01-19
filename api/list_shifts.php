<?php
/**
 * Endpoint to list all shifts or search by partial ID
 * Usage: 
 *   GET /api/list_shifts.php - List all shifts
 *   GET /api/list_shifts.php?search=b3ee - Search by partial ID
 *   GET /api/list_shifts.php?today=1 - Only today's shifts
 * 
 * Example curl:
 * curl "http://192.168.0.177/lightPOS/api/list_shifts.php?today=1"
 */

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate');
header("Access-Control-Allow-Origin: *");

require_once __DIR__ . '/SQLiteStore.php';

$store = new SQLiteStore();

$search = $_GET['search'] ?? null;
$todayOnly = isset($_GET['today']) && $_GET['today'] === '1';

try {
    $allShifts = $store->getAll('shifts');

    // Sort by start_time descending (most recent first)
    usort($allShifts, function ($a, $b) {
        $timeA = $a['start_time'] ?? 0;
        $timeB = $b['start_time'] ?? 0;

        // Handle ISO strings
        if (!is_numeric($timeA))
            $timeA = strtotime($timeA);
        if (!is_numeric($timeB))
            $timeB = strtotime($timeB);

        return $timeB - $timeA; // Descending
    });

    $filteredShifts = [];
    $todayStart = strtotime('today') * 1000;
    $todayEnd = strtotime('tomorrow') * 1000;

    foreach ($allShifts as $shift) {
        // Search filter
        if ($search && stripos($shift['id'], $search) === false) {
            continue;
        }

        // Today filter
        if ($todayOnly) {
            $shiftStart = $shift['start_time'] ?? 0;
            if (!is_numeric($shiftStart)) {
                $shiftStart = strtotime($shiftStart) * 1000;
            }

            if ($shiftStart < $todayStart || $shiftStart >= $todayEnd) {
                continue;
            }
        }

        // Format for display
        $filteredShifts[] = [
            'id' => $shift['id'],
            'user' => $shift['user_id'] ?? $shift['user_email'] ?? 'unknown',
            'start_time' => $shift['start_time'],
            'end_time' => $shift['end_time'] ?? 'OPEN',
            'status' => $shift['status'] ?? 'unknown',
            'opening_cash' => $shift['opening_cash'] ?? 0,
            'closing_cash' => $shift['closing_cash'] ?? null
        ];
    }

    echo json_encode([
        'count' => count($filteredShifts),
        'filters' => [
            'search' => $search,
            'today_only' => $todayOnly
        ],
        'shifts' => $filteredShifts
    ], JSON_PRETTY_PRINT);

} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'error' => 'Server error: ' . $e->getMessage()
    ]);
}
