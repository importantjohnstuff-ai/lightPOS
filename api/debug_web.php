<?php
header('Content-Type: text/plain');
echo "PHP Version: " . phpversion() . "\n";
echo "PHP_INT_MAX: " . PHP_INT_MAX . "\n";
echo "PDO Drivers: " . implode(', ', PDO::getAvailableDrivers()) . "\n";

try {
    $db = new PDO('sqlite:' . __DIR__ . '/../data/database.sqlite');
    echo "SQLite Version: " . $db->query('SELECT sqlite_version()')->fetchColumn() . "\n";
    
    $store = new PDO('sqlite::memory:');
    $store->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    // Determine native vs emulated default
    try {
        echo "ATTR_EMULATE_PREPARES default: " . ($store->getAttribute(PDO::ATTR_EMULATE_PREPARES) ? 'true' : 'false') . "\n";
    } catch (Exception $e) {
        echo "ATTR_EMULATE_PREPARES check failed: " . $e->getMessage() . "\n";
    }

    echo "\n--- Users in DB ---\n";
    $stmt = $db->query("SELECT email, name FROM users");
    $users = $stmt->fetchAll(PDO::FETCH_ASSOC);
    print_r($users);

} catch (Exception $e) {
    echo "DB Error: " . $e->getMessage() . "\n";
}
