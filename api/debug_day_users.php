<?php
header('Content-Type: application/json');
require_once __DIR__ . '/SQLiteStore.php';

$store = new SQLiteStore();
$date = $_GET['date'] ?? date('Y-m-d'); // Default to today

function parseTimestampMs($ts)
{
    if ($ts === null)
        return null;
    if (is_numeric($ts))
        return (int) $ts;
    $parsed = strtotime($ts);
    return $parsed !== false ? $parsed * 1000 : null;
}

$startMs = strtotime("$date 00:00:00") * 1000;
$endMs = strtotime("$date 23:59:59") * 1000;

$allTx = $store->getAll('transactions');
$usersInDay = [];

foreach ($allTx as $tx) {
    $txMs = parseTimestampMs($tx['timestamp']);
    if ($txMs >= $startMs && $txMs <= $endMs) {
        $txUser = strtolower(trim($tx['user_email'] ?? $tx['user_id'] ?? 'unknown'));
        if (!isset($usersInDay[$txUser])) {
            $usersInDay[$txUser] = [
                'count' => 0,
                'total' => 0,
                'min_ts' => $txMs,
                'max_ts' => $txMs,
                'min_human' => date('H:i:s', $txMs / 1000),
                'max_human' => date('H:i:s', $txMs / 1000)
            ];
        }
        $usersInDay[$txUser]['count']++;
        $usersInDay[$txUser]['total'] += floatval($tx['total_amount'] ?? $tx['total'] ?? 0);

        if ($txMs < $usersInDay[$txUser]['min_ts']) {
            $usersInDay[$txUser]['min_ts'] = $txMs;
            $usersInDay[$txUser]['min_human'] = date('H:i:s', $txMs / 1000);
        }
        if ($txMs > $usersInDay[$txUser]['max_ts']) {
            $usersInDay[$txUser]['max_ts'] = $txMs;
            $usersInDay[$txUser]['max_human'] = date('H:i:s', $txMs / 1000);
        }
    }
}

echo json_encode([
    'date' => $date,
    'day_range' => ['start' => $startMs, 'end' => $endMs],
    'users_with_transactions' => $usersInDay
], JSON_PRETTY_PRINT);
