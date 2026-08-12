<?php

class Database
{
    private static $instance = null;
    private $pdo;

    private function __construct()
    {
        $dbPath = __DIR__ . '/../../data/database.sqlite';

        try {
            $this->pdo = new PDO('sqlite:' . $dbPath);
            $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $this->pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
            $this->pdo->exec("PRAGMA journal_mode=WAL;");
            $this->pdo->exec("PRAGMA busy_timeout = 5000;");
        } catch (PDOException $e) {
            // Handle connection error — return JSON so the shutdown handler doesn't corrupt output
            error_log("Database connection failed: " . $e->getMessage());
            http_response_code(500);
            header('Content-Type: application/json; charset=UTF-8');
            echo json_encode(["error" => "Database connection failed: " . $e->getMessage()]);
            exit;
        }
    }

    public static function getInstance()
    {
        if (self::$instance == null) {
            self::$instance = new Database();
        }
        return self::$instance;
    }

    public function getConnection()
    {
        return $this->pdo;
    }
}
