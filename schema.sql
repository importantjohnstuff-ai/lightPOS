-- Refactored schema for SQLite migration, aligning with sqlite_ipp.md

-- Use WAL mode for better concurrency
PRAGMA journal_mode=WAL;

-- Main tables with hybrid relational/document structure

CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    barcode TEXT,
    name TEXT,
    category TEXT,
    supplier_id TEXT,
    stock_level REAL,
    full_data TEXT, -- JSON payload for other fields
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_items_supplier_id ON items(supplier_id);
CREATE INDEX IF NOT EXISTS idx_items_updatedAt ON items(_updatedAt);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    timestamp INTEGER,
    user_email TEXT,
    customer_id TEXT,
    total_amount REAL,
    voided_at INTEGER,
    items_json TEXT, -- JSON array of transaction items
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_transactions_timestamp ON transactions(timestamp);
CREATE INDEX IF NOT EXISTS idx_transactions_user_email ON transactions(user_email);
CREATE INDEX IF NOT EXISTS idx_transactions_updatedAt ON transactions(_updatedAt);

CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT,
    password_hash TEXT,
    role TEXT,
    is_active INTEGER DEFAULT 1,
    permissions_json TEXT, -- JSON for flexible permissions
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_updatedAt ON users(_updatedAt);

-- Standardized tables (using json_body for unstructured data)

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    json_body TEXT,
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_customers_updatedAt ON customers(_updatedAt);

CREATE TABLE IF NOT EXISTS suppliers (
    id TEXT PRIMARY KEY,
    json_body TEXT,
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_suppliers_updatedAt ON suppliers(_updatedAt);

CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    json_body TEXT,
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_shifts_updatedAt ON shifts(_updatedAt);

CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    json_body TEXT,
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_expenses_updatedAt ON expenses(_updatedAt);

CREATE TABLE IF NOT EXISTS returns (
    id TEXT PRIMARY KEY,
    json_body TEXT,
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_returns_updatedAt ON returns(_updatedAt);

CREATE TABLE IF NOT EXISTS stock_movements (
    id TEXT PRIMARY KEY,
    json_body TEXT,
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_updatedAt ON stock_movements(_updatedAt);

CREATE TABLE IF NOT EXISTS adjustments (
    id TEXT PRIMARY KEY,
    json_body TEXT,
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_adjustments_updatedAt ON adjustments(_updatedAt);

CREATE TABLE IF NOT EXISTS stockins (
    id TEXT PRIMARY KEY,
    json_body TEXT,
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stockins_updatedAt ON stockins(_updatedAt);

CREATE TABLE IF NOT EXISTS suspended_transactions (
    id TEXT PRIMARY KEY,
    json_body TEXT,
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_suspended_transactions_updatedAt ON suspended_transactions(_updatedAt);

CREATE TABLE IF NOT EXISTS stock_logs (
    id TEXT PRIMARY KEY,
    json_body TEXT,
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stock_logs_updatedAt ON stock_logs(_updatedAt);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    json_body TEXT,
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notifications_updatedAt ON notifications(_updatedAt);

CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY,
    json_body TEXT,
    _version INTEGER,
    _updatedAt INTEGER,
    _deleted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_settings_updatedAt ON settings(_updatedAt);


-- Sync and client-side specific tables

CREATE TABLE IF NOT EXISTS sync_metadata (
    key TEXT PRIMARY KEY,
    value TEXT,
    _updatedAt INTEGER
);

-- This table is for the client-side sync queue, leave as is.
CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection TEXT,
    docId TEXT,
    type TEXT
);