# LightPOS – AI Agent Codebase Guide

This document provides structured context for AI agents working on the LightPOS codebase. It describes the project architecture, key files, common patterns, and important conventions.

---

## 🎯 Project Overview

**LightPOS** is an offline-first Point of Sale (POS) and Inventory Management system for retail businesses.

| Aspect | Details |
|--------|---------|
| **Type** | Single Page Application (SPA) + PHP API |
| **Frontend** | Vanilla JavaScript (ES6 Modules), Tailwind CSS |
| **Backend** | PHP 7.4+ with SQLite 3 |
| **Local Storage** | IndexedDB via Dexie.js |
| **Sync Strategy** | Delta-based, Last-Write-Wins (LWW) |

---

## 📂 Directory Structure

```
lightPOS/
├── api/                    # PHP Backend
│   ├── router.php          # Main REST API (GET/POST handlers)
│   ├── sync.php            # Delta synchronization endpoint
│   ├── core/
│   │   └── SQLiteStore.php # PDO wrapper for SQLite operations
│   └── services/           # Business logic services
├── src/                    # JavaScript Frontend
│   ├── main.js             # App bootstrap, auth flow
│   ├── auth.js             # Login/logout, permission checks
│   ├── db.js               # Dexie.js database abstraction
│   ├── router.js           # Client-side hash router
│   ├── layout.js           # Sidebar, header rendering
│   ├── modules/            # Feature modules (see below)
│   ├── services/
│   │   ├── SyncEngine.js   # Push/pull sync logic
│   │   └── DexieRepository.js # Data access layer
│   └── utils/              # Helper utilities
├── data/
│   └── database.sqlite     # Server SQLite database
├── tests/                  # Playwright E2E tests
├── schema.sql              # Database schema definition
└── index.html              # SPA entry point
```

---

## 🔑 Key Files for Common Tasks

### Adding/Modifying a Module
| File | Purpose |
|------|---------|
| `src/modules/<module>.js` | Main module logic, UI rendering |
| `src/router.js` | Route registration |
| `src/layout.js` | Sidebar menu entry |
| `src/db.js` | Database collection (if new data type) |

### Modifying Database Schema
| File | Purpose |
|------|---------|
| `schema.sql` | Server SQLite schema |
| `src/db.js` | Dexie.js schema (client-side) |
| `api/core/SQLiteStore.php` | Ensure collection is recognized |

### Modifying Sync Behavior
| File | Purpose |
|------|---------|
| `src/services/SyncEngine.js` | Client sync logic |
| `api/sync.php` | Server sync endpoint |

### Modifying Permissions/Auth
| File | Purpose |
|------|---------|
| `src/auth.js` | `checkPermission()`, `requestManagerApproval()` |
| `src/modules/users.js` | `ROLES` constant, user management |

---

## 🏛️ Architecture Patterns

### 1. Module Pattern
Each module in `src/modules/` follows a consistent pattern:

```javascript
// Typical module structure
import { checkPermission } from "../auth.js";
import { dbRepository as Repository } from "../db.js";

export function loadModuleView() {
    // Permission check
    if (!checkPermission('module', 'read')) {
        content.innerHTML = `<p>Access Denied</p>`;
        return;
    }
    
    // Render UI
    content.innerHTML = `<div>...</div>`;
    
    // Setup event listeners
    setupListeners();
    
    // Load data
    loadData();
}
```

### 2. Data Access Pattern
All data operations go through the Repository abstraction:

```javascript
import { dbRepository as Repository } from "../db.js";

// CRUD Operations
await Repository.getAll('items');           // Read all
await Repository.get('items', id);          // Read one
await Repository.upsert('items', itemData); // Create/Update
await Repository.delete('items', id);       // Delete (soft)
```

### 3. Sync Pattern
Data modifications follow an offline-first approach:

1. **Write locally** (Dexie.js/IndexedDB)
2. **Queue in outbox** (automatic)
3. **Push on sync** (SyncEngine)
4. **Pull deltas** (server changes since last sync)

### 4. Permission Pattern
```javascript
import { checkPermission, requestManagerApproval } from "../auth.js";

// Simple permission check
if (!checkPermission('pos', 'write')) return;

// Manager override for sensitive operations
const approved = await requestManagerApproval();
if (!approved) return;
```

---

## 📊 Database Schema

### Standard Columns (All Tables)
| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Primary key (UUID or email for users) |
| `_version` | INTEGER | Sync version for LWW |
| `_updatedAt` | INTEGER | Unix timestamp (ms) |
| `_deleted` | INTEGER | Soft delete flag (0/1) |
| `json_body` | TEXT | Flexible JSON payload |

### Key Collections
| Collection | Primary Key | Key Fields |
|------------|-------------|------------|
| `users` | `email` | `password_hash`, `role`, `permissions_json` |
| `items` | `id` | `barcode`, `name`, `category`, `stock_level` |
| `transactions` | `id` | `timestamp`, `user_email`, `total_amount`, `items_json` |
| `customers` | `id` | `json_body` (name, phone, loyalty) |
| `suppliers` | `id` | `json_body` (name, contact) |
| `shifts` | `id` | `json_body` (start/end times, cash) |
| `stock_movements` | `id` | `json_body` (type, item_id, qty) |

---

## 📦 Module Reference

### Core Modules
| Module | File | Description |
|--------|------|-------------|
| **POS** | `src/modules/pos.js` | Point of sale interface, cart, checkout |
| **Items** | `src/modules/items.js` | Product catalog management |
| **Reports** | `src/modules/Reportsv2.js` | Analytics and reporting engine |
| **Settings** | `src/modules/settings.js` | Application configuration |
| **Shift** | `src/modules/shift.js` | Shift open/close, cash management |

### Inventory Modules
| Module | File | Description |
|--------|------|-------------|
| **Stock-In** | `src/modules/stockin.js` | Receive deliveries |
| **Stock Count** | `src/modules/stock-count.js` | Physical inventory |
| **Suppliers** | `src/modules/suppliers.js` | Vendor management |
| **Purchase Orders** | `src/modules/purchase_orders.js` | PO creation/tracking |
| **Spatial** | `src/modules/inventory_spatial.js` | Visual shelf placement |

### Other Modules
| Module | File | Description |
|--------|------|-------------|
| **Customers** | `src/modules/customers.js` | CRM, loyalty |
| **Users** | `src/modules/users.js` | User/role management |
| **Expenses** | `src/modules/expenses.js` | Expense tracking |
| **Returns** | `src/modules/returns.js` | Return processing |
| **Dashboard** | `src/modules/dashboard.js` | Overview widgets |

---

## 🔧 Common Modification Tasks

### Adding a New Report
1. Edit `src/modules/Reportsv2.js`
2. Add report config to `REPORTS_CONFIG` object
3. Implement data fetching function
4. Add rendering function for chart/table

### Adding a New Setting
1. Edit `src/modules/settings.js`
2. Add to `DEFAULT_SETTINGS` constant
3. Add UI element in appropriate tab
4. Implement save/load handlers

### Adding a New Permission
1. Edit `src/modules/users.js` – add to `ROLES`
2. Edit `src/auth.js` if new check logic needed
3. Apply `checkPermission()` in relevant module

### Adding a New Data Collection
1. Add table to `schema.sql`
2. Add Dexie store in `src/db.js`
3. Ensure sync handles it in `api/sync.php`
4. Create CRUD operations in relevant module

---

## ⚠️ Important Conventions

### Naming
- **Files**: `kebab-case.js` (modules), `PascalCase.js` (services)
- **Functions**: `camelCase` (load*, render*, setup*, handle*)
- **CSS**: Tailwind utility classes (no custom CSS)

### Data Flow
- Always use `Repository` for data access, never direct Dexie calls
- Set `_updatedAt: Date.now()` and `_version++` on mutations
- Set `sync_status: 'pending'` for new/modified records

### UI Patterns
- Modals: `<div id="modal-{name}" class="hidden fixed inset-0...">`
- Tables: `<table class="min-w-full divide-y divide-gray-200">`
- Buttons: `<button class="bg-blue-600 hover:bg-blue-700 text-white...">`

### Error Handling
```javascript
import { handleError } from "../utils.js"; // Global error handler
try {
    // operation
} catch (error) {
    handleError(error, 'Context description');
}
```

---

## 🧪 Testing

### E2E Tests (Playwright)
```bash
npx playwright test                    # Run all tests
npx playwright test tests/pos.spec.js  # Run specific test
```

### Test Files
| File | Coverage |
|------|----------|
| `tests/pos.spec.js` | POS checkout flow |
| `api/tests/` | PHP unit tests |
| `src/modules/*.test.js` | Module unit tests |

---

## 🔗 API Endpoints

### `api/router.php`
| Method | Params | Description |
|--------|--------|-------------|
| GET | `?file=<collection>` | Get all records from collection |
| POST | `?file=<collection>` | Upsert records to collection |
| GET | `?action=fix_admin` | Reset admin credentials |
| POST | `?action=login` | Authenticate user |

### `api/sync.php`
| Method | Params | Description |
|--------|--------|-------------|
| GET | `?since=<timestamp>` | Get deltas since timestamp |
| POST | `{outbox: [...]}` | Push local changes |

---

## 💡 Quick Tips for Agents

1. **Always check permissions** before implementing feature UIs
2. **Use the Repository pattern** – avoid direct database calls
3. **Preserve offline capability** – never require network for basic operations
4. **Follow existing code style** – match patterns in similar modules
5. **Test sync behavior** – ensure changes propagate correctly
6. **Check conversation history** – prior conversations contain context on recent changes
7. **Large modules** – `pos.js`, `settings.js`, `Reportsv2.js` are complex; review outlines first

---

*This document is intended for AI agents assisting with LightPOS development.*
