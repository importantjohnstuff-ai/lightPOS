#!/bin/bash
# remote_finish.sh - Runs on the remote server to finalize setup

TARGET_DIR="${1:-/opt/lampp/htdocs/lightPOS}"
XAMPP_USER="daemon"
XAMPP_GROUP="daemon"

echo "=== Finalizing Remote Setup ==="

# 1. Setup WASM
if [ -f "$TARGET_DIR/src/libs/sql.wasm" ]; then
    cp "$TARGET_DIR/src/libs/sql.wasm" "$TARGET_DIR/src/libs/sql-wasm.wasm"
fi

# 2. Permissions
echo "Setting permissions..."
mkdir -p "$TARGET_DIR/data"
chown -R $XAMPP_USER:$XAMPP_GROUP "$TARGET_DIR"
find "$TARGET_DIR" -type d -exec chmod 755 {} \;
find "$TARGET_DIR" -type f -exec chmod 644 {} \;
chmod -R 777 "$TARGET_DIR/data"

# 3. Database
echo "Configuring database..."
if [ ! -f "$TARGET_DIR/data/database.sqlite" ]; then
    echo "Initializing new database..."
    if [ -f "$TARGET_DIR/schema.sql" ]; then
        sqlite3 "$TARGET_DIR/data/database.sqlite" < "$TARGET_DIR/schema.sql"
        sqlite3 "$TARGET_DIR/data/database.sqlite" "INSERT OR IGNORE INTO sync_metadata (key, value, _updatedAt) VALUES ('db_initialized', '1', $(date +%s)000);"
    fi
fi

if [ -f "$TARGET_DIR/data/database.sqlite" ]; then
    chmod 777 "$TARGET_DIR/data/database.sqlite"
    # Enable WAL
    sqlite3 "$TARGET_DIR/data/database.sqlite" "PRAGMA journal_mode=WAL;"
    # Ensure WAL files are writable if they exist (or will exist)
    touch "$TARGET_DIR/data/database.sqlite-wal" "$TARGET_DIR/data/database.sqlite-shm"
    chmod 777 "$TARGET_DIR/data/database.sqlite"*
    chown $XAMPP_USER:$XAMPP_GROUP "$TARGET_DIR/data/database.sqlite"*
fi

# 4. Config
echo "Updating Configs..."
sed -i 's/^;extension=pdo_sqlite/extension=pdo_sqlite/' /opt/lampp/etc/php.ini

if ! grep -q "application/wasm" /opt/lampp/etc/httpd.conf; then
    echo "AddType application/wasm .wasm" >> /opt/lampp/etc/httpd.conf
fi

# 5. Start XAMPP
echo "Starting XAMPP..."
/opt/lampp/lampp start

echo "=== Remote Setup Complete ==="
