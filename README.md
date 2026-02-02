# 🛒 LightPOS

A lightweight, **offline-first** Point of Sale and Inventory Management system designed for speed, reliability, and scalability. Built for small to medium retail businesses that need robust POS capabilities with or without constant internet connectivity.

![Status](https://img.shields.io/badge/status-active-brightgreen)
![PHP](https://img.shields.io/badge/PHP-7.4%2B-blue)
![License](https://img.shields.io/badge/license-proprietary-red)

## ✨ Key Features

### 🏪 Point of Sale
- **Fast Item Search** – Barcode scanning or text-based search
- **Keyboard Shortcuts** – F1 (Search), F2 (Checkout), F3 (Cart Navigation), F4 (Hold), F8 (Reprint)
- **Transaction Suspension** – Hold sales and resume from any terminal
- **Offline Transaction Queue** – Complete sales without internet; auto-sync when connected
- **Discount Codes** – Apply percentage-based promotional discounts
- **Mobile Barcode Scanning** – Camera-based barcode detection on mobile devices

### 📦 Inventory Management
- **Items Master** – Complete product catalog with cost, price, stock levels, and categories
- **Stock-In/Out** – Receive deliveries with supplier tracking and automated stock movements
- **Stock Count (Audit)** – Physical inventory reconciliation with variance logging
- **Automatic Unit Breakdown** – Auto-convert parent units (cases) to child units (cans)
- **Spatial Inventory** – Visual floorplan-based shelf placement system

### 📊 Reporting & Analytics
- **Financial Reports** – Gross Sales, Net Profit, Tax Liability, Cashflow
- **Inventory Valuation** – Historical OHLC, Shrinkage Analysis
- **Sales Insights** – Sales Velocity, Product Affinity (Basket Analysis)
- **Performance Matrix** – Product categorization (Winners, Dogs, Sleepers)
- **Customer Analytics** – Purchase history, loyalty tracking

### 💰 Financial Management
- **Shift Management** – Opening/Closing cash with X-Reports and Z-Reports
- **Cash Control** – Track discrepancies and cash variances
- **Expense Tracking** – Record operational costs with shift integration
- **Remittance Recording** – Mid-shift cash deposits

### 👥 User & Customer Management
- **Role-Based Access** – Granular permissions (Read/Write per module)
- **Customer Profiles** – Purchase history and loyalty points
- **Supplier Management** – Vendor details and performance tracking

### ⚙️ Administration
- **Purchase Orders** – Create and manage supplier orders
- **Data Migration** – Bulk import/export via CSV/JSON
- **Backup & Restore** – Full system backup and restore
- **Settings Management** – Store branding, receipt customization, security

---

## 🏗️ System Architecture

LightPOS utilizes a **"Self-Healing" Offline-First Architecture**:

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                         │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Vanilla JS  │  │ Tailwind CSS│  │ Chart.js (Visualization)│  │
│  │ ES6 Modules │  │             │  │                         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                           │                                     │
│              ┌────────────▼────────────┐                       │
│              │   IndexedDB (Dexie.js)  │                       │
│              │   Local Data Storage    │                       │
│              └────────────┬────────────┘                       │
└───────────────────────────┼─────────────────────────────────────┘
                            │ Delta Sync (Push/Pull)
┌───────────────────────────▼─────────────────────────────────────┐
│                        SERVER (PHP)                             │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  PHP 7.4+ API Router (api/router.php, api/sync.php)     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                           │                                     │
│              ┌────────────▼────────────┐                       │
│              │  SQLite 3 (WAL Mode)    │                       │
│              │  Hybrid Relational/Doc  │                       │
│              └─────────────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

### Sync Strategy
- **Delta-based synchronization** – Only changed records are transferred
- **Outbox pattern** – Local changes queued for server push
- **Last-Write-Wins (LWW)** – Conflict resolution via versioning
- **Auto-sync** – Every 30 seconds + on reconnection

---

## 📁 Project Structure

```
lightPOS/
├── api/                    # PHP Backend
│   ├── router.php          # Main API endpoint
│   ├── sync.php            # Delta sync handler
│   ├── core/               # SQLiteStore class
│   └── services/           # Backend services
├── src/                    # JavaScript Frontend
│   ├── main.js             # App entry point
│   ├── auth.js             # Authentication
│   ├── db.js               # Dexie.js database wrapper
│   ├── router.js           # Client-side routing
│   ├── modules/            # Feature modules
│   │   ├── pos.js          # Point of Sale
│   │   ├── items.js        # Inventory items
│   │   ├── Reportsv2.js    # Analytics engine
│   │   ├── settings.js     # App configuration
│   │   └── ...             # Other modules
│   └── services/           # Sync engine, repositories
├── data/                   # SQLite database (auto-created)
├── tests/                  # Playwright E2E tests
├── docs/                   # Documentation
├── schema.sql              # Database schema
└── index.html              # Single Page Application entry
```

---

## 🚀 Installation

### Prerequisites
- **PHP 7.4+** with PDO SQLite extension
- **Web Server** – Apache, Nginx, XAMPP, LAMPP
- **Modern Browser** – Chrome, Firefox, Edge

### Quick Start

1. **Clone/Copy the project** to your web server's document root:
   ```bash
   cp -r lightPOS /var/www/html/
   # or for XAMPP
   cp -r lightPOS /opt/lampp/htdocs/
   ```

2. **Set permissions** on the data directory:
   ```bash
   chmod -R 777 data/
   ```

3. **Access the application**:
   ```
   http://localhost/lightPOS
   ```
   
   > The database schema initializes automatically on first run.

4. **Default Login**:
   - **Email**: `admin@lightpos.com`
   - **Password**: `admin123`

---

## ⌨️ Keyboard Shortcuts (POS)

| Key | Action |
|-----|--------|
| `F1` | Focus search / Clear search |
| `F2` | Open checkout modal |
| `F3` | Enter cart navigation mode |
| `F4` | Suspend transaction |
| `F8` | Reprint last receipt |
| `Escape` | Close modal / Clear cart |
| `Arrow Keys` | Navigate cart items (in F3 mode) |
| `Delete` | Remove item from cart (in F3 mode) |

---

## 🔧 Troubleshooting

### Sync Errors (503 Service Unavailable)
```javascript
// Run in browser console (F12)
fetch('api/router.php?action=reset_all', { method: 'POST' });
```

### Reset Admin Password
```javascript
fetch('api/router.php?action=fix_admin').then(r => r.json()).then(console.log);
localStorage.clear();
window.location.reload();
```

### Full Data Reset
Navigate to **Settings → Advanced → Reset Application Data**

---

## 🧪 Testing

```bash
# Run E2E tests
npx playwright test

# Run PHP unit tests
vendor/bin/phpunit
```

---

## 📄 Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vanilla JavaScript (ES6), Tailwind CSS, Chart.js |
| Local DB | IndexedDB via Dexie.js |
| Backend | PHP 7.4+, SQLite 3 (WAL mode) |
| Testing | Playwright (E2E), PHPUnit |
| Build | No build step – Direct ES6 modules |

---

## 📚 Documentation

- [Detailed README](docs/README.md) – Extended system documentation
- [Deployment Guide](docs/deployment_notes.md) – Server setup instructions
- [Test Guide](docs/how_to_run_tests.md) – Testing procedures

---

## 📝 License

Proprietary software – All rights reserved.

---

*Built with ❤️ for retail businesses that demand reliability.*
