<?php
/**
 * Receipt Image API Endpoint
 * 
 * Dedicated handler for receipt image upload/download.
 * Completely independent of sync.php — images are stored as flat files
 * in data/receipts/ to keep the main SQLite database lean.
 * 
 * POST: Upload a receipt image (multipart/form-data)
 * GET:  Download a receipt image by expense_id
 * DELETE: Remove a receipt image by expense_id
 */

// Buffer output to prevent stray warnings corrupting responses
ob_start();

ini_set('display_errors', 0);
ini_set('log_errors', 1);
error_reporting(E_ALL);

// Shutdown handler for clean error output
register_shutdown_function(function () {
    $error = error_get_last();
    if ($error && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR])) {
        if (ob_get_length()) ob_end_clean();
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode([
            'error' => 'PHP Fatal Error',
            'message' => $error['message']
        ]);
    }
});

header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

$receiptsDir = __DIR__ . '/../data/receipts/';

// Ensure receipts directory exists
if (!is_dir($receiptsDir)) {
    @mkdir($receiptsDir, 0777, true);
}

if (!is_writable($receiptsDir)) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Receipts directory is not writable.']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];

// ─────────────────────────────────────────────────────────
// POST: Upload a receipt image
// ─────────────────────────────────────────────────────────
if ($method === 'POST') {
    header('Content-Type: application/json');

    $expenseId = $_POST['expense_id'] ?? null;

    if (!$expenseId) {
        http_response_code(400);
        echo json_encode(['error' => 'Missing expense_id']);
        exit;
    }

    // Sanitize expense_id to prevent path traversal
    $expenseId = preg_replace('/[^a-zA-Z0-9\-_]/', '', $expenseId);

    if (!isset($_FILES['image']) || $_FILES['image']['error'] !== UPLOAD_ERR_OK) {
        $uploadError = $_FILES['image']['error'] ?? 'No file received';
        http_response_code(400);
        echo json_encode(['error' => 'Image upload failed', 'detail' => $uploadError]);
        exit;
    }

    $tmpFile = $_FILES['image']['tmp_name'];
    $targetFile = $receiptsDir . $expenseId . '.jpg';

    // Move the uploaded file
    if (move_uploaded_file($tmpFile, $targetFile)) {
        $size = filesize($targetFile);

        // Flush output buffer before sending JSON
        if (ob_get_length()) ob_end_clean();

        echo json_encode([
            'success' => true,
            'expense_id' => $expenseId,
            'size' => $size
        ]);

        error_log("Receipt uploaded: $expenseId ($size bytes)");
    } else {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to save receipt file']);
    }
    exit;
}

// ─────────────────────────────────────────────────────────
// GET: Download a receipt image
// ─────────────────────────────────────────────────────────
if ($method === 'GET') {
    $expenseId = $_GET['expense_id'] ?? null;

    if (!$expenseId) {
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Missing expense_id']);
        exit;
    }

    // Sanitize
    $expenseId = preg_replace('/[^a-zA-Z0-9\-_]/', '', $expenseId);
    $filePath = $receiptsDir . $expenseId . '.jpg';

    if (!file_exists($filePath)) {
        http_response_code(404);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Receipt not found']);
        exit;
    }

    // Flush output buffer before sending binary
    if (ob_get_length()) ob_end_clean();

    header('Content-Type: image/jpeg');
    header('Content-Length: ' . filesize($filePath));
    header('Cache-Control: public, max-age=86400'); // Cache for 24h
    readfile($filePath);
    exit;
}

// ─────────────────────────────────────────────────────────
// DELETE: Remove a receipt image
// ─────────────────────────────────────────────────────────
if ($method === 'DELETE') {
    header('Content-Type: application/json');

    $expenseId = $_GET['expense_id'] ?? null;

    if (!$expenseId) {
        http_response_code(400);
        echo json_encode(['error' => 'Missing expense_id']);
        exit;
    }

    // Sanitize
    $expenseId = preg_replace('/[^a-zA-Z0-9\-_]/', '', $expenseId);
    $filePath = $receiptsDir . $expenseId . '.jpg';

    if (file_exists($filePath)) {
        unlink($filePath);
        error_log("Receipt deleted: $expenseId");
    }

    echo json_encode(['success' => true, 'expense_id' => $expenseId]);
    exit;
}

// Unsupported method
http_response_code(405);
header('Content-Type: application/json');
echo json_encode(['error' => 'Method not allowed']);
?>
