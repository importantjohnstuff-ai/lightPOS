import { dbPromise } from "../db.js";
import { handleError } from "../utils.js";
import { isServerReachable } from "./ServerReachability.js";

const SYNC_URL = 'api/sync.php';

/**
 * Sync Engine managing the flow of data between Client and Server.
 * Uses Web Locks to prevent concurrent sync operations.
 */
export const SyncEngine = {
    isSyncing: false,
    async sync() {
        const db = await dbPromise;
        // Don't rely on navigator.onLine — it only checks for WAN/internet connectivity,
        // not LAN reachability. Instead, check actual server reachability.
        const reachable = await isServerReachable();
        if (!reachable) return;

        // Tab-local check
        if (this.isSyncing) {
            console.log("SyncEngine: Sync already in progress in this tab. Skipping.");
            return;
        }

        const tabId = Math.random().toString(36).substring(2);

        const performSync = async () => {
            this.isSyncing = true;
            window.dispatchEvent(new CustomEvent('sync-started'));
            console.log("Sync started...");
            
            // Create a keep-alive for localStorage lock if Web Locks is not available
            let lockInterval = null;
            if (!navigator.locks) {
                lockInterval = setInterval(() => {
                    localStorage.setItem('sync_lock_localStorage', JSON.stringify({ tabId, timestamp: Date.now() }));
                }, 5000);
            }

            try {
                // await db.open(); // Not needed for SQLite
                console.log("SyncEngine: --- Pushing changes... ---");
                await this.push();
                console.log("SyncEngine: --- Pushing complete. Pulling changes... ---");
                await this.pull();
                console.log("SyncEngine: --- Pulling complete. ---");
                localStorage.setItem('last_sync_timestamp', new Date().toISOString());
                window.dispatchEvent(new CustomEvent('sync-updated'));
                console.log("Sync completed.");
            } catch (error) {
                if (error.name === 'DatabaseClosedError') {
                    console.warn("SyncEngine: Database is closed (likely reloading/restoring). Aborting sync.");
                    return;
                }
                console.error("SyncEngine: An error occurred during the sync process:", error);
                handleError(error, 'SyncEngine');
                window.dispatchEvent(new CustomEvent('sync-failed'));
            } finally {
                this.isSyncing = false;
                if (lockInterval) {
                    clearInterval(lockInterval);
                }
                if (!navigator.locks) {
                    const currentLock = localStorage.getItem('sync_lock_localStorage');
                    if (currentLock) {
                        try {
                            const lockObj = JSON.parse(currentLock);
                            if (lockObj.tabId === tabId) {
                                localStorage.removeItem('sync_lock_localStorage');
                            }
                        } catch (e) {}
                    }
                }
            }
        };

        // Use Web Locks API to ensure only one tab performs sync (requires Secure Context/HTTPS)
        if (navigator.locks) {
            return await navigator.locks.request('sync_lock', performSync);
        } else {
            // LocalStorage cross-tab fallback
            const now = Date.now();
            const existingLock = localStorage.getItem('sync_lock_localStorage');
            if (existingLock) {
                try {
                    const lockObj = JSON.parse(existingLock);
                    // Lock is active and not expired (expire after 2 minutes)
                    if (lockObj.tabId !== tabId && (now - lockObj.timestamp) < 120000) {
                        console.warn("SyncEngine: Sync lock held by another tab:", lockObj.tabId);
                        return;
                    }
                } catch (e) {
                    // JSON parsing error, ignore and override
                }
            }
            // Acquire lock
            localStorage.setItem('sync_lock_localStorage', JSON.stringify({ tabId, timestamp: now }));
            return await performSync();
        }
    },

    async push() {
        const db = await dbPromise;
        const outboxItems = await db.outbox.toArray();
        if (outboxItems.length === 0) return;

        console.log(`SyncEngine: Total outbox items to push: ${outboxItems.length}`);

        const CHUNK_SIZE = 200;
        for (let i = 0; i < outboxItems.length; i += CHUNK_SIZE) {
            const chunk = outboxItems.slice(i, i + CHUNK_SIZE);
            console.log(`SyncEngine: Pushing chunk ${i / CHUNK_SIZE + 1} (${chunk.length} items)...`);

            const response = await fetch(SYNC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ outbox: chunk })
            });

            if (response.ok) {
                const ids = chunk.map(item => item.id);
                await db.outbox.bulkDelete(ids);
                console.log(`SyncEngine: Chunk ${i / CHUNK_SIZE + 1} pushed successfully.`);
            } else {
                const errorText = await response.text();
                console.error("SyncEngine: Push failed for chunk. Status:", response.status, "Response:", errorText);
                throw new Error(`Push failed: ${response.status} ${errorText}`);
            }
        }
    },

    async applyDeltas(collection, items, isFirstSync = false) {
        const db = await dbPromise;
        if (!db[collection]) return;

        try {
            await db.transaction('rw', [db[collection], db.outbox], async () => {
                const idField = db[collection].schema.primKey.name;

                if (isFirstSync) {
                    console.log(`SyncEngine: Fast-path bulk putting ${items.length} items in [${collection}]`);
                    await db[collection].bulkPut(items);
                    return;
                }

                // Prepare IDs for bulk fetch
                const serverItemsMap = new Map();
                const idsToFetch = [];

                for (const item of items) {
                    const docId = item[idField];
                    if (docId !== undefined && docId !== null) {
                        idsToFetch.push(docId);
                        serverItemsMap.set(docId, item);
                    }
                }

                // Bulk Get existing local items
                const localItems = await db[collection].bulkGet(idsToFetch);

                const itemsToPut = [];
                const docIdsToClearOutbox = [];

                for (let i = 0; i < idsToFetch.length; i++) {
                    const docId = idsToFetch[i];
                    const serverItem = serverItemsMap.get(docId);
                    const localItem = localItems[i]; // Corresponding local item (or undefined)

                    const localVersion = localItem?._version || 0;
                    const serverVersion = serverItem._version || 0;
                    const localUpdated = localItem?._updatedAt || 0;
                    const serverUpdated = serverItem._updatedAt || 0;

                    // Conflict Resolution:
                    // Update if:
                    // 1. Local doesn't exist
                    // 2. Server version is strictly higher
                    // 3. Versions match but Server is newer (Clock Drift / LWW tie-breaker)
                    const shouldUpdate = !localItem ||
                        serverVersion > localVersion ||
                        (serverVersion === localVersion && serverUpdated > localUpdated);

                    if (shouldUpdate) {
                        itemsToPut.push(serverItem);
                        docIdsToClearOutbox.push(docId);
                    }
                }

                if (itemsToPut.length > 0) {
                    console.log(`SyncEngine: Bulk updating ${itemsToPut.length} items in [${collection}]`);
                    await db[collection].bulkPut(itemsToPut);

                    try {
                        const outboxKeysToDelete = [];
                        const outboxItems = await db.outbox.where('collection').equals(collection).toArray();

                        for (const outboxItem of outboxItems) {
                            if (docIdsToClearOutbox.includes(outboxItem.docId)) {
                                outboxKeysToDelete.push(outboxItem.id);
                            }
                        }

                        if (outboxKeysToDelete.length > 0) {
                            await db.outbox.bulkDelete(outboxKeysToDelete);
                        }
                    } catch (e) {
                        console.warn("Soft error clearing outbox:", e);
                    }
                }
            });
        } catch (error) {
            console.error(`SyncEngine: FAILED to process collection [${collection}]. Transaction rolled back.`, error);
        }
    },

    async pull() {
        const db = await dbPromise;
        console.log("SyncEngine: --- pull() method was entered ---");
        const lastSyncMeta = await db.sync_metadata.get('last_pull_timestamp');
        const since = lastSyncMeta ? lastSyncMeta.value : 0;
        const isFirstSync = (since === 0);
        console.log(`SyncEngine: Pulling changes since timestamp: ${since}`);

        const collections = [
            'items', 'transactions', 'shifts', 'expenses', 'users',
            'stock_movements', 'adjustments', 'customers', 'suppliers',
            'stockins', 'suspended_transactions', 'returns', 'notifications',
            'stock_logs', 'settings', 'purchase_orders', 'supplier_config',
            'inventory_metrics', 'spatial_shelves', 'spatial_placements',
            'discount_codes'
        ];

        let maxServerTime = 0;
        let needsRestore = false;

        // 1. Fetch change counts from the server
        console.log("SyncEngine: Fetching change counts...");
        let counts = {};
        try {
            const countsResponse = await fetch(`${SYNC_URL}?action=counts&since=${since}`);
            if (!countsResponse.ok) {
                console.error("SyncEngine: Failed to fetch change counts. Falling back to serial pull.");
            } else {
                const countsData = await countsResponse.json();
                if (countsData.status === 'needs_restore') {
                    needsRestore = true;
                } else {
                    counts = countsData.counts || {};
                    maxServerTime = countsData.serverTime || 0;
                }
            }
        } catch (error) {
            console.error("SyncEngine: Error getting counts, falling back:", error);
        }

        if (needsRestore) {
            console.warn("Server database needs restore. Initiating full upload from client.");
            await this.performFullRestore();
            return;
        }

        // Filter collections that actually have updates
        const activeCollections = collections.filter(col => (counts[col] !== undefined ? counts[col] > 0 : true));
        if (activeCollections.length === 0) {
            console.log("SyncEngine: No changes to pull.");
            if (maxServerTime > 0) {
                await db.sync_metadata.put({ key: 'last_pull_timestamp', value: maxServerTime });
            }
            return;
        }

        // Calculate total rows for progress tracking
        const totalRows = activeCollections.reduce((sum, col) => sum + (counts[col] || 0), 0);
        let rowsProcessed = 0;

        const reportProgress = (collection, fetchedRows) => {
            rowsProcessed += fetchedRows;
            const percent = totalRows > 0 ? Math.min(100, Math.round((rowsProcessed / totalRows) * 100)) : 100;
            window.dispatchEvent(new CustomEvent('sync-progress', {
                detail: {
                    phase: 'pulling',
                    collection,
                    percent,
                    rowsProcessed,
                    totalRows
                }
            }));
        };

        // Group into small collections (less than 2000 updates) and large collections
        const limit = 2000;
        const smallCols = activeCollections.filter(col => (counts[col] !== undefined && counts[col] < limit));
        const largeCols = activeCollections.filter(col => (counts[col] !== undefined && counts[col] >= limit));

        console.log(`SyncEngine: Small collections in bulk: [${smallCols.join(', ')}]`);
        console.log(`SyncEngine: Large collections paginated: [${largeCols.join(', ')}]`);

        // Fetch small collections in one bulk request
        if (smallCols.length > 0) {
            try {
                const response = await fetch(`${SYNC_URL}?since=${since}&collections=${smallCols.join(',')}`);
                if (!response.ok) {
                    throw new Error(`Status ${response.status}`);
                }
                const data = await response.json();
                if (data.status === 'needs_restore') {
                    await this.performFullRestore();
                    return;
                }
                if (data.serverTime > maxServerTime) {
                    maxServerTime = data.serverTime;
                }
                const deltas = data.deltas || {};
                for (const col of smallCols) {
                    const items = deltas[col] || [];
                    if (items.length > 0) {
                        const localCount = await db[col].count();
                        const isCollectionEmpty = (localCount === 0);
                        await this.applyDeltas(col, items, isFirstSync || isCollectionEmpty);
                    }
                    reportProgress(col, counts[col] || items.length);
                }
            } catch (error) {
                console.error("SyncEngine: Failed to fetch small collections in bulk, falling back to serial:", error);
                largeCols.push(...smallCols);
            }
        }

        // Fetch large collections with concurrency control (max 3 concurrent)
        if (largeCols.length > 0) {
            const pullTasks = largeCols.map(collection => async () => {
                let offset = 0;
                let hasMore = true;

                const localCount = await db[collection].count();
                const isCollectionEmpty = (localCount === 0);

                while (hasMore) {
                    const response = await fetch(`${SYNC_URL}?since=${since}&collection=${collection}&limit=${limit}&offset=${offset}`);
                    if (!response.ok) {
                        const text = await response.text();
                        console.error(`SyncEngine: Pull failed for ${collection}. Status:`, response.status, "Response:", text);
                        throw new Error(`Pull failed for ${collection}. Status: ${response.status}. Response: ${text}`);
                    }

                    const data = await response.json();
                    if (data.status === 'needs_restore') {
                        needsRestore = true;
                        break;
                    }

                    if (data.serverTime > maxServerTime) {
                        maxServerTime = data.serverTime;
                    }

                    const items = data.deltas?.[collection] || [];
                    if (items.length > 0) {
                        await this.applyDeltas(collection, items, isFirstSync || isCollectionEmpty);
                        reportProgress(collection, items.length);
                    }

                    if (items.length < limit) {
                        hasMore = false;
                    } else {
                        offset += limit;
                    }
                }
            });

            // Run tasks sequentially to prevent Dexie's zone-tracking corruption with parallel async tasks
            const executeTasks = async (tasks) => {
                for (const task of tasks) {
                    if (needsRestore) break;
                    await task();
                }
            };

            await executeTasks(pullTasks);
        }

        if (needsRestore) {
            console.warn("Server database needs restore. Initiating full upload from client.");
            await this.performFullRestore();
            return;
        }

        if (maxServerTime > 0) {
            await db.sync_metadata.put({ key: 'last_pull_timestamp', value: maxServerTime });
        }
    },

    async performFullRestore() {
        const db = await dbPromise;
        window.dispatchEvent(new CustomEvent('restore-started'));
        try {
            const fullData = {};
            const tablesToBackup = db.tables.map(t => t.name).filter(name => name !== 'outbox');

            for (const tableName of tablesToBackup) {
                fullData[tableName] = await db.table(tableName).toArray();
            }

            const response = await fetch('api/router.php?action=restore_from_client', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fullData)
            });

            if (!response.ok) {
                throw new Error('Server failed to accept the restore data.');
            }

            // Clear local timestamp to force a full re-sync to get consistent server timestamps
            await db.sync_metadata.delete('last_pull_timestamp');

            window.dispatchEvent(new CustomEvent('restore-finished'));

            // Trigger a new sync to align everything after locks are released
            setTimeout(() => this.sync(), 500);

        } catch (error) {
            handleError(error, 'FullRestore');
            window.dispatchEvent(new CustomEvent('restore-failed'));
        }
    }
};

// Auto-sync when coming back online
window.addEventListener('online', () => SyncEngine.sync());

// Periodic sync every 30 seconds
setInterval(() => SyncEngine.sync(), 30000);