<?php

require_once __DIR__ . '/../db/Database.php';

class SQLiteStore
{
    // Version identifier - update this when making changes to verify deployment
    const VERSION = '2026-01-19-v4-DEBUG_LOGGING';

    public $pdo;
    private $collections;
    private $schemaCache = [];

    public function __construct()
    {
        // Log version to verify correct file is deployed
        error_log("SQLiteStore VERSION: " . self::VERSION);

        $this->pdo = Database::getInstance()->getConnection();
        // Disable WAL mode to prevent locking issues on some filesystems
        // Enable WAL mode for better concurrency
        $this->pdo->exec("PRAGMA journal_mode=WAL;");
        $this->pdo->exec("PRAGMA busy_timeout = 5000;");
        // Disable emulated prepares to avoid "General error: 21 bad parameter or other API misuse"
        // Native SQLite binding correctly handles high-precision numbers and NULL values.
        try {
            $this->pdo->setAttribute(PDO::ATTR_EMULATE_PREPARES, false);
            error_log("SQLiteStore initialized with ATTR_EMULATE_PREPARES=false (Fix for Error 21)");
        } catch (Exception $e) {
            error_log("SQLiteStore warning: Could not set ATTR_EMULATE_PREPARES: " . $e->getMessage());
        }
        $this->collections = [
            'items',
            'transactions',
            'users',
            'customers',
            'suppliers',
            'shifts',
            'expenses',
            'returns',
            'stock_movements',
            'adjustments',
            'stockins',
            'suspended_transactions',
            'sync_metadata',
            'stock_logs',
            'settings',
            'notifications',
            'purchase_orders',
            'supplier_config',
            'inventory_metrics',
            'discount_codes',
            'spatial_shelves',
            'spatial_placements'
        ];
    }

    private function getTableColumns($collection)
    {
        if (isset($this->schemaCache[$collection])) {
            return $this->schemaCache[$collection];
        }

        $stmt = $this->pdo->prepare("PRAGMA table_info($collection)");
        $stmt->execute();
        $columns = $stmt->fetchAll(PDO::FETCH_COLUMN, 1);
        $this->schemaCache[$collection] = $columns;
        return $columns;
    }

    public function getAll($collection)
    {
        if (!in_array($collection, $this->collections)) {
            throw new Exception("Unknown collection: $collection");
        }
        $stmt = $this->pdo->prepare("SELECT * FROM $collection WHERE _deleted = 0");
        $stmt->execute();
        $results = $stmt->fetchAll(PDO::FETCH_ASSOC);
        return array_map([$this, 'hydrate'], $results);
    }

    public function getChanges($collection, $since, $limit = null, $offset = 0)
    {
        if (!in_array($collection, $this->collections)) {
            throw new Exception("Unknown collection: $collection");
        }
        try {
            $sql = "SELECT * FROM $collection WHERE _updatedAt > ? ORDER BY _updatedAt ASC";
            $params = [$since];
            if ($limit !== null) {
                $sql .= " LIMIT " . (int)$limit . " OFFSET " . (int)$offset;
            }
            $stmt = $this->pdo->prepare($sql);
            $stmt->execute($params);
            $results = $stmt->fetchAll(PDO::FETCH_ASSOC);
            return array_map([$this, 'hydrate'], $results);
        } catch (PDOException $e) {
            // Table may not exist yet — return empty rather than crashing
            error_log("SQLiteStore::getChanges('$collection'): " . $e->getMessage());
            return [];
        }
    }

    public function upsert($collection, $record)
    {
        if (!in_array($collection, $this->collections)) {
            throw new Exception("Unknown collection: $collection");
        }

        $tableColumns = $this->getTableColumns($collection);
        $jsonColumn = in_array('full_data', $tableColumns) ? 'full_data' : (in_array('json_body', $tableColumns) ? 'json_body' : null);

        $dbRecord = [];
        $jsonData = [];

        // Special handling for nested JSON objects from old format
        if (isset($record['items']) && is_array($record['items'])) {
            $record['items_json'] = json_encode($record['items']);
            unset($record['items']);
        }
        if (isset($record['permissions']) && is_array($record['permissions'])) {
            $record['permissions_json'] = json_encode($record['permissions']);
            unset($record['permissions']);
        }

        // Hotfix for sync_metadata value being an array
        if ($collection === 'sync_metadata' && isset($record['value']) && is_array($record['value'])) {
            $record['value'] = json_encode($record['value']);
        }

        foreach ($record as $key => $value) {
            if (in_array($key, $tableColumns)) {
                $dbRecord[$key] = $value;
            } else {
                if (strpos($key, '_') !== 0) {
                    $jsonData[$key] = $value;
                }
            }
        }

        if ($jsonColumn && !empty($jsonData)) {
            $dbRecord[$jsonColumn] = json_encode($jsonData);
        }

        $dbRecord['_updatedAt'] = round(microtime(true) * 1000);
        if ($collection !== 'sync_metadata') {
            if (!isset($dbRecord['_version'])) {
                $dbRecord['_version'] = 1;
            }
            // Force _deleted to be a boolean 0 or 1 to prevent bad data from sync
            if (isset($dbRecord['_deleted'])) {
                $dbRecord['_deleted'] = $dbRecord['_deleted'] ? 1 : 0;
            } else {
                $dbRecord['_deleted'] = 0;
            }
        }

        // Use the centralized helper to determine ID column
        $idColumn = $this->getIdColumn($collection);

        if (empty($dbRecord[$idColumn])) {
            // The original JSON record might have the key, even if it's not a DB column (e.g. 'id' for sync_metadata)
            if (isset($record[$idColumn])) {
                $dbRecord[$idColumn] = $record[$idColumn];
            } else {
                throw new Exception("Record for collection '$collection' is missing required ID field '$idColumn'");
            }
        }

        // Validation: Ensure mandatory fields (like ID) are present
        if (!isset($dbRecord[$idColumn])) {
            throw new Exception("Missing ID column '$idColumn' for collection '$collection'");
        }

        $columns = array_keys($dbRecord);

        // 1. Check if record exists
        $sqlCheck = "SELECT 1 FROM $collection WHERE $idColumn = ?";
        $stmtCheck = $this->pdo->prepare($sqlCheck);
        $stmtCheck->execute([$dbRecord[$idColumn]]);
        $exists = $stmtCheck->fetchColumn();
        $stmtCheck->closeCursor();

        if ($exists) {
            // UPDATE
            $updateColumns = array_filter($columns, fn($c) => $c !== $idColumn);
            $updateSet = array_map(fn($c) => "$c = ?", $updateColumns);

            if (!empty($updateSet)) {
                $sqlUtils = "UPDATE $collection SET " . implode(', ', $updateSet) . " WHERE $idColumn = ?";
                $stmtUpdate = $this->pdo->prepare($sqlUtils);

                $updateParams = [];
                foreach ($updateColumns as $col) {
                    $updateParams[] = $dbRecord[$col];
                }
                $updateParams[] = $dbRecord[$idColumn];

                // DEBUG: Log what we're about to bind
                error_log("SQLiteStore UPDATE Debug - SQL: $sqlUtils");
                error_log("SQLiteStore UPDATE Debug - Param count: " . count($updateParams));

                // Bind ALL values as PDO::PARAM_STR (except NULL as PARAM_NULL)
                // Even with emulated prepares, explicit binding ensures consistency.
                foreach ($updateParams as $i => $val) {
                    $paramType = gettype($val);
                    $paramPos = $i + 1;

                    if (is_null($val)) {
                        $stmtUpdate->bindValue($paramPos, null, PDO::PARAM_NULL);
                    } elseif (is_bool($val)) {
                        $strVal = $val ? '1' : '0';
                        $stmtUpdate->bindValue($paramPos, $strVal, PDO::PARAM_STR);
                    } elseif (is_int($val)) {
                        $stmtUpdate->bindValue($paramPos, $val, PDO::PARAM_INT);
                    } elseif (is_array($val) || is_object($val)) {
                        $jsonVal = json_encode($val);
                        $stmtUpdate->bindValue($paramPos, $jsonVal, PDO::PARAM_STR);
                    } else {
                        $strVal = (string) $val;
                        $stmtUpdate->bindValue($paramPos, $strVal, PDO::PARAM_STR);
                    }
                }

                error_log("SQLiteStore UPDATE Debug - All binds complete, calling execute");
                $this->executeWithRetry($stmtUpdate);
                error_log("SQLiteStore UPDATE Debug - Execute successful");
            }
        } else {
            // INSERT
            $placeholders = array_fill(0, count($columns), '?');
            $bindParams = array_values($dbRecord);

            $sql = "INSERT INTO $collection (" . implode(', ', $columns) . ") 
                    VALUES (" . implode(', ', $placeholders) . ")";

            $stmt = $this->pdo->prepare($sql);

            // Bind ALL values as PDO::PARAM_STR (except NULL as PARAM_NULL)
            foreach ($bindParams as $i => $val) {
                if (is_null($val)) {
                    $stmt->bindValue($i + 1, null, PDO::PARAM_NULL);
                } elseif (is_bool($val)) {
                    $stmt->bindValue($i + 1, $val ? '1' : '0', PDO::PARAM_STR);
                } elseif (is_int($val)) {
                    $stmt->bindValue($i + 1, $val, PDO::PARAM_INT);
                } elseif (is_array($val) || is_object($val)) {
                    $stmt->bindValue($i + 1, json_encode($val), PDO::PARAM_STR);
                } else {
                    $stmt->bindValue($i + 1, (string) $val, PDO::PARAM_STR);
                }
            }

            $this->executeWithRetry($stmt, null, $bindParams);
        }
    }

    public function getIdColumn($collection)
    {
        $idColumn = 'id';
        if ($collection === 'users') {
            $idColumn = 'email';
        } elseif ($collection === 'sync_metadata') {
            $idColumn = 'key';
        } elseif ($collection === 'supplier_config') {
            $idColumn = 'supplier_id';
        } elseif ($collection === 'inventory_metrics') {
            $idColumn = 'sku_id';
        }
        return $idColumn;
    }

    public function delete($collection, $id)
    {
        if (!in_array($collection, $this->collections)) {
            throw new Exception("Unknown collection: $collection");
        }

        $idColumn = $this->getIdColumn($collection);

        $stmt = $this->pdo->prepare("UPDATE $collection SET _deleted = 1, _updatedAt = ?, _version = COALESCE(_version, 0) + 1 WHERE $idColumn = ?");
        $this->executeWithRetry($stmt, [round(microtime(true) * 1000), $id]);
        $stmt->closeCursor();
    }

    public function wipe($collection)
    {
        if (!in_array($collection, $this->collections)) {
            throw new Exception("Unknown collection: $collection");
        }
        $stmt = $this->pdo->prepare("DELETE FROM $collection");
        $this->executeWithRetry($stmt);
        $stmt->closeCursor();
    }

    private function executeWithRetry($stmt, $params = null, $debugParams = null)
    {
        $retries = 0;
        while (true) {
            try {
                if ($params !== null) {
                    $stmt->execute($params);
                } else {
                    $stmt->execute();
                }
                return;
            } catch (PDOException $e) {
                // Check for "database is locked" error (SQLSTATE HY000, Error 5)
                if (strpos($e->getMessage(), 'database is locked') !== false && $retries < 5) {
                    $retries++;
                    usleep(500000); // Wait 500ms
                    continue;
                }
                // Enhance error message with SQL and Params for debugging
                $logParams = $params ?? $debugParams ?? 'null';
                $debugMsg = $e->getMessage() . " | SQL: " . $stmt->queryString . " | Params: " . json_encode($logParams);
                throw new Exception($debugMsg, (int) $e->getCode(), $e);
            }
        }
    }

    public function beginTransaction()
    {
        $retries = 0;
        while (true) {
            try {
                return $this->pdo->beginTransaction();
            } catch (PDOException $e) {
                if (strpos($e->getMessage(), 'database is locked') !== false && $retries < 5) {
                    $retries++;
                    usleep(500000);
                    continue;
                }
                throw $e;
            }
        }
    }

    public function commit()
    {
        return $this->pdo->commit();
    }

    public function rollBack()
    {
        return $this->pdo->rollBack();
    }

    public function inTransaction()
    {
        return $this->pdo->inTransaction();
    }

    private function hydrate($row)
    {
        $jsonKeysToRemove = [];
        $dataToMerge = [];

        foreach ($row as $key => $value) {
            if (is_string($value) && (str_ends_with($key, '_json') || $key === 'full_data' || $key === 'json_body')) {
                $decoded = json_decode($value, true);
                if (json_last_error() === JSON_ERROR_NONE) {
                    if (str_ends_with($key, '_json')) {
                        $newKey = substr($key, 0, -5); // e.g., 'items_json' -> 'items'
                        $row[$newKey] = $decoded;
                    } else {
                        // For 'full_data' or 'json_body', prepare to merge
                        if (is_array($decoded)) {
                            $dataToMerge = array_merge($dataToMerge, $decoded);
                        }
                    }
                }
                $jsonKeysToRemove[] = $key;
            }
        }

        // Merge data from json_body/full_data, but do not overwrite existing top-level columns
        foreach ($dataToMerge as $key => $value) {
            if (!isset($row[$key])) {
                $row[$key] = $value;
            }
        }

        // Remove the original JSON string columns
        foreach ($jsonKeysToRemove as $key) {
            unset($row[$key]);
        }

        return $row;
    }
}
