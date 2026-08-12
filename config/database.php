<?php
/**
 * Shared Database Configuration for Monorepo Applications
 * Shared across main-app/ and Reports-module/
 */

if (!defined('DB_TYPE')) {
    define('DB_TYPE', 'sqlite');
}

if (!defined('DB_PATH')) {
    define('DB_PATH', __DIR__ . '/../data/database.sqlite');
}

if (!defined('DB_HOST')) {
    define('DB_HOST', 'localhost');
}

if (!defined('DB_NAME')) {
    define('DB_NAME', 'lightpos_db');
}

if (!defined('DB_USER')) {
    define('DB_USER', 'root');
}

if (!defined('DB_PASS')) {
    define('DB_PASS', '');
}

/**
 * Returns a shared PDO connection instance to MySQL or SQLite.
 */
function getSharedDbConnection() {
    static $pdo = null;
    if ($pdo === null) {
        try {
            if (DB_TYPE === 'sqlite') {
                $dataDir = dirname(DB_PATH);
                if (!is_dir($dataDir)) {
                    @mkdir($dataDir, 0777, true);
                }
                $pdo = new PDO('sqlite:' . DB_PATH);
                $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
                $pdo->exec('PRAGMA busy_timeout = 5000;');
                $pdo->exec('PRAGMA journal_mode = WAL;');
            } else {
                $dsn = "mysql:host=" . DB_HOST . ";dbname=" . DB_NAME . ";charset=utf8mb4";
                $pdo = new PDO($dsn, DB_USER, DB_PASS, [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
                ]);
            }
        } catch (PDOException $e) {
            error_log("Database connection error: " . $e->getMessage());
            throw $e;
        }
    }
    return $pdo;
}
?>
