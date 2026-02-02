<?php
require_once __DIR__ . '/../core/SQLiteStore.php';

try {
    $store = new SQLiteStore();
    echo "SQLiteStore initialized.\n";

    // Create users table if not exists (mimic ensureSchema)
    $store->pdo->exec("CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        name TEXT,
        password_hash TEXT,
        role TEXT,
        is_active INTEGER DEFAULT 1,
        permissions_json TEXT,
        _version INTEGER,
        _updatedAt INTEGER,
        _deleted INTEGER DEFAULT 0
    )");
    
    // Seed a user
    $store->pdo->exec("INSERT OR IGNORE INTO users (email, name, password_hash, _deleted) VALUES ('test@test.com', 'Test', 'hash', 0)");

    // Mimic the login flow: getAll users
    echo "Attempting to get all users...\n";
    $users = $store->getAll('users');
    echo "Got " . count($users) . " users.\n";
    
    // Dump first user to see structure
    if (!empty($users)) {
        print_r($users[0]);
    }

} catch (Exception $e) {
    echo "Crash: " . $e->getMessage() . "\n";
    echo $e->getTraceAsString();
}
