import { dbPromise } from "../db.js";
import { handleError } from "../utils.js";

const SYNC_URL = 'api/sync.php';

/**
 * Sync Engine managing the flow of data between Client and Server.
 * Uses Web Locks to prevent concurrent sync operations.
 */
export const SyncEngine = {
    async sync() {
        const db = await dbPromise;
        if (!navigator.onLine) return;

        const performSync = async () => {
            window.dispatchEvent(new CustomEvent('sync-started'));
            console.log("Sync started...");
            console.log('SyncEngine: db object before db.open():', db); // ADDED LOG
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
                console.error("SyncEngine: An error occurred during the sync process:", error);
                handleError(error, 'SyncEngine');
                window.dispatchEvent(new CustomEvent('sync-failed'));
            }
        };

        // Use Web Locks API to ensure only one tab performs sync (requires Secure Context/HTTPS)
        if (navigator.locks) {
            return await navigator.locks.request('sync_lock', performSync);
        } else {
            return await performSync();
        }
    },

    async push() {
        const db = await dbPromise;
        const outboxItems = await db.outbox.toArray();
        console.log("SyncEngine: Outbox items to push:", outboxItems.map(i => ({ id: i.id, collection: i.collection, docId: i.docId, payloadKeys: Object.keys(i.payload) })));
        if (outboxItems.length === 0) return;

        const response = await fetch(SYNC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outbox: outboxItems })
        });

        if (response.ok) {
            const ids = outboxItems.map(i => i.id);
            await db.outbox.bulkDelete(ids);
        } else {
            const errorText = await response.text();
            console.error("SyncEngine: Push failed. Status:", response.status, "Response:", errorText);
            throw new Error(`Push failed: ${response.status} ${errorText}`);
        }
    },

    async pull() {
        const db = await dbPromise;
        console.log("SyncEngine: --- pull() method was entered ---");
        const lastSyncMeta = await db.sync_metadata.get('last_pull_timestamp');
        const since = lastSyncMeta ? lastSyncMeta.value : 0;
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

        for (const collection of collections) {
            console.log(`SyncEngine: Pulling collection [${collection}]`);
            const limit = 500;
            let offset = 0;
            let hasMore = true;

            while (hasMore) {
                const response = await fetch(`${SYNC_URL}?since=${since}&collection=${collection}&limit=${limit}&offset=${offset}`);
                const text = await response.text();

                if (!response.ok) {
                    console.error(`SyncEngine: Pull failed for ${collection} (offset: ${offset}). Status:`, response.status, "Response:", text);
                    throw new Error(`Pull failed for ${collection}: ${response.status} ${text}`);
                }

                let data;
                try {
                    data = JSON.parse(text);
                } catch (e) {
                    console.error(`SyncEngine: JSON Parse Error for ${collection}. Raw response:`, text);
                    throw new Error(`Server returned invalid JSON for ${collection}. Check console for details.`);
                }

                if (data.status === 'needs_restore') {
                    needsRestore = true;
                    hasMore = false;
                    break;
                }

                const { deltas, serverTime } = data;
                if (serverTime > maxServerTime) {
                    maxServerTime = serverTime;
                }

                if (!deltas || !deltas[collection] || deltas[collection].length === 0) {
                    hasMore = false;
                    break;
                }

                const items = deltas[collection];
                console.log(`SyncEngine: Processing [${items.length}] items for collection [${collection}] (offset: ${offset})`);

                if (items.length < limit) {
                    hasMore = false;
                } else {
                    offset += limit;
                }

                if (!db[collection]) continue;

                try {
                    await db.transaction('rw', [db[collection], db.outbox], async () => {
                        const idField = db[collection].schema.primKey.name;
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
            }
            if (needsRestore) break;
        }

        if (needsRestore) {
            console.warn("Server database needs restore. Initiating full upload from client.");
            await this.performFullRestore();
            return; // Stop normal pull process
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

            // Trigger a new sync to align everything
            this.sync();

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