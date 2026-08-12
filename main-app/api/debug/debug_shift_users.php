<?php
header('Content-Type: application/json');
require_once __DIR__ . '/../core/SQLiteStore.php';

$store = new SQLiteStore();
$shiftId = $_GET['shift_id'] ?? null;

if (!$shiftId) { echo json_encode(['error' => 'Need shift_id']); exit; }

function parseTimestampMs($ts) {
    if ($ts === null) return null;
    if (is_numeric($ts)) return (int)$ts;
    $parsed = strtotime($ts);
    return $parsed !== false ? $parsed * 1000 : null;
}

$shifts = $store->getAll('shifts');
$targetShift = null;
foreach ($shifts as $shift) {
    if ($shift['id'] === $shiftId) { $targetShift = $shift; break; }
}

if (!$targetShift) { echo json_encode(['error' => 'Shift not found']); exit; }

$startMs = parseTimestampMs($targetShift['start_time']);
$endMs = parseTimestampMs($targetShift['end_time']);
$shiftUser = strtolower(trim($targetShift['user_id'] ?? $targetShift['user_email'] ?? ''));

$allTx = $store->getAll('transactions');
$usersInRange = [];

foreach ($allTx as $tx) {
    $txMs = parseTimestampMs($tx['timestamp']);
    if ($txMs >= $startMs && $txMs <= $endMs) {
        $txUser = strtolower(trim($tx['user_email'] ?? $tx['user_id'] ?? 'unknown'));
        if (!isset($usersInRange[$txUser])) {
            $usersInRange[$txUser] = ['count' => 0, 'total' => 0];
        }
        $usersInRange[$txUser]['count']++;
        $usersInRange[$txUser]['total'] += floatval($tx['total_amount'] ?? $tx['total'] ?? 0);
    }
}

echo json_encode([
    'shift_user' => $shiftUser,
    'shift_time' => ['start' => $targetShift['start_time'], 'end' => $targetShift['end_time']],
    'users_with_transactions_in_this_period' => $usersInRange
], JSON_PRETTY_PRINT);
