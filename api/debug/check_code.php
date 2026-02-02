<?php
$content = file_get_contents(__DIR__ . '/../core/SQLiteStore.php');
if (strpos($content, 'SELECT 1 FROM $collection') !== false) {
    echo "VERIFIED: SQLiteStore.php contains 'SELECT 1' logic.\n";
} else {
    echo "FAILED: SQLiteStore.php does NOT contain 'SELECT 1' logic.\n";
}

if (strpos($content, 'closeCursor') !== false) {
    echo "VERIFIED: SQLiteStore.php contains 'closeCursor'.\n";
} else {
    echo "FAILED: SQLiteStore.php does NOT contain 'closeCursor'.\n";
}
