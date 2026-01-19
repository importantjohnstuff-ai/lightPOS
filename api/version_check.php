<?php
/**
 * Quick diagnostic to verify which SQLiteStore version is deployed
 */
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate');

require_once __DIR__ . '/SQLiteStore.php';

$response = [
    'timestamp' => date('Y-m-d H:i:s'),
    'php_version' => PHP_VERSION,
    'file_path' => realpath(__DIR__ . '/SQLiteStore.php'),
    'file_modified' => date('Y-m-d H:i:s', filemtime(__DIR__ . '/SQLiteStore.php')),
];

// Check if VERSION constant exists
if (defined('SQLiteStore::VERSION')) {
    $response['sqlite_store_version'] = SQLiteStore::VERSION;
    $response['status'] = 'Version constant found';
} else {
    $response['sqlite_store_version'] = 'NOT DEFINED';
    $response['status'] = 'Old version without VERSION constant - file not updated!';
}

echo json_encode($response, JSON_PRETTY_PRINT);
