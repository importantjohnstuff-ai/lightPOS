# LightPOS - Project Instructions

This document provides essential context and instructions for AI agents and developers working on the LightPOS project.

## 🚀 Project Overview

LightPOS is a lightweight, **offline-first** Point of Sale and Inventory Management system. It is designed for reliability in environments with intermittent internet connectivity.

- **Architecture:** Hybrid Offline-First.
- **Frontend:** Vanilla JavaScript (ES6 Modules), Tailwind CSS, Chart.js.
- **Client-side DB:** IndexedDB via **Dexie.js**.
- **Backend:** PHP 7.4+, **SQLite 3** (WAL mode).
- **Sync Strategy:** Bidirectional delta-sync (Push/Pull) with conflict resolution (Last-Write-Wins).

## 📁 Key Directories

- `/api`: PHP Backend (Router, Sync, Core, Services).
- `/src`: JavaScript Frontend (Modules, Services, Workers).
- `/data`: SQLite database location (auto-created).
- `/tests`: Playwright E2E tests and PHPUnit tests.
- `/docs`: Project documentation and implementation details.

## 🛠️ Building and Running

### Prerequisites
- PHP 7.4+ with `pdo_sqlite` extension.
- Web server (Apache, Nginx, or XAMPP).
- Node.js (only for running Playwright tests).

### Commands
- **Install PHP Dependencies:** `composer install`
- **Run E2E Tests:** `npx playwright test`
- **Run PHP Unit Tests:** `./vendor/bin/phpunit`
- **Reset Application (Server):** `fetch('api/router.php?action=reset_all', { method: 'POST' })` (from browser console)
- **Repair Admin User:** `fetch('api/router.php?action=fix_admin').then(r => r.json()).then(console.log);`

## 🧠 Core Architectural Concepts

### 1. Offline-First Data Flow
All data operations (Create, Update, Delete) are performed on the local IndexedDB first. The `SyncEngine` then pushes these changes to the server and pulls deltas from other clients.

### 2. Self-Healing Schema
The backend API (`api/router.php` and `api/sync.php`) contains logic to automatically initialize and migrate the SQLite schema if it detects missing tables or columns.

### 3. Sync Engine (`src/services/SyncEngine.js`)
- **Push:** Scans the `outbox` table in Dexie and sends records to `api/sync.php`.
- **Pull:** Requests changes from the server using a `since` timestamp.
- **Conflict Resolution:** Uses `_version` and `_updatedAt` fields.

### 4. User Authentication
- Default Admin: `admin@lightpos.com` / `admin123`.
- Passwords are stored as MD5 hashes (legacy compatibility).
- Role-based permissions are stored as JSON in the `permissions_json` column.

## 📊 Data Schema (IndexedDB / Dexie)

The following collections are used in the local database:

- **items:** `++id, name, barcode, category, supplier_id, updatedAt...`
- **transactions:** `++id, timestamp, customer_id, *item_ids...`
- **users:** `email, name, is_active...`
- **shifts:** `++id, user_id, status...`
- **expenses:** `++id, date, category...`
- **outbox:** `++id, collection, docId, type, [collection+docId]` (Crucial for sync)
- **spatial_shelves / spatial_placements:** For floorplan-based inventory.
- **purchase_orders / inventory_metrics:** For procurement management.

## 📝 Development Conventions

- **No Build Step:** The project uses native ES6 modules. Do not introduce a transpilation step (Babel/Webpack) unless explicitly requested.
- **Surgical Edits:** When modifying PHP endpoints, ensure you don't break the `ob_start()` / `register_shutdown_function()` error handling wrapper which ensures clean JSON output even if warnings occur.
- **SQLite Performance:** Use transactions for batch inserts (already implemented in `router.php`). Always use `PRAGMA busy_timeout = 5000;` to avoid locking issues on XAMPP.
- **Idempotency:** Sync operations should be idempotent. Use `upsert` patterns instead of simple `insert`.

## 🧪 Testing Guidelines

- **E2E Tests:** Located in `tests/e2e`. These tests interact with a live instance of the application.
- **PHP Tests:** Located in `api/tests` and `tests/api`. Use PHPUnit for testing backend logic.
- **Validation:** Always verify changes by checking both the local IndexedDB (via browser DevTools) and the server-side SQLite database.
