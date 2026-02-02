<?php
header('Content-Type: application/json');
require_once __DIR__ . '/../core/SQLiteStore.php';

$store = new SQLiteStore();

// Get Joyce's shift and related data
$shifts = $store->getAll('shifts');
$joyceShift = null;
foreach ($shifts as $s) {
    if ($s['id'] === 'b3ee08af-c432-4735-a453-b0f138b7b79a') {
        $joyceShift = $s;
        break;
    }
}

// Get some transactions by Joyce
$allTx = $store->getAll('transactions');
$joyceTxSamples = [];
foreach ($allTx as $tx) {
    $user = strtolower(trim($tx['user_email'] ?? $tx['user_id'] ?? ''));
    if ($user === 'joycenvista@lightpos.com') {
        $joyceTxSamples[] = [
            'id' => substr($tx['id'], 0, 8),
            'timestamp_raw' => $tx['timestamp'],
            'total' => $tx['total_amount'] ?? $tx['total'] ?? 0
        ];
        if (count($joyceTxSamples) >= 5) break;
    }
}

echo json_encode([
    'server_timezone' => date_default_timezone_get(),
    'server_time_now' => date('Y-m-d H:i:s'),
    'server_time_utc' => gmdate('Y-m-d H:i:s'),
    'joyce_shift' => [
        'start_raw' => $joyceShift['start_time'] ?? null,
        'end_raw' => $joyceShift['end_time'] ?? null,
    ],
    'joyce_latest_transactions' => $joyceTxSamples,
    'total_joyce_transactions' => count(array_filter($allTx, fn($t) => 
        strtolower(trim($t['user_email'] ?? $t['user_id'] ?? '')) === 'joycenvista@lightpos.com'
    ))
], JSON_PRETTY_PRINT);
