/**
 * ReceiptImageStore.js
 * 
 * Manages receipt images in a SEPARATE Dexie database from the main app data.
 * This keeps large image blobs completely isolated from the SyncEngine's
 * delta-sync pipeline, preventing database bloat and sync performance issues.
 * 
 * Images are synced to the server via a dedicated api/receipts.php endpoint
 * using simple multipart uploads — not through the JSON-based outbox system.
 */

import Dexie from '../libs/dexie.mjs';
import { isServerReachable } from './ServerReachability.js';

// Derive DB name from the same path-based convention as the main DB
const pathSegments = globalThis.location.pathname.split('/').filter(Boolean);
const IMAGE_DB_NAME = (pathSegments[0] || 'lightPOS') + '_Images_DB';
const RECEIPTS_API = 'api/receipts.php';

// Initialize Dexie instance with primary key 'id'
let imageDb = new Dexie(IMAGE_DB_NAME);
imageDb.version(1).stores({
    receipt_images: 'id, expense_id, sync_status, created_at'
});

/**
 * Safely ensure the image database is open and schema matches.
 * Deletes and recreates database cleanly if upgrading primary keys fails.
 */
async function getDb() {
    if (imageDb.isOpen()) return imageDb;
    try {
        await imageDb.open();
    } catch (e) {
        console.warn("ReceiptImageStore: Primary key schema upgrade needed, resetting local image cache...", e);
        try {
            imageDb.close();
        } catch (_) {}
        await Dexie.delete(IMAGE_DB_NAME);
        imageDb = new Dexie(IMAGE_DB_NAME);
        imageDb.version(1).stores({
            receipt_images: 'id, expense_id, sync_status, created_at'
        });
        await imageDb.open();
    }
    return imageDb;
}

export const ReceiptImageStore = {

    /**
     * Save multiple receipt image blobs for an expense.
     * 
     * @param {string} expenseId 
     * @param {Blob[]} blobs 
     * @returns {Promise<void>}
     */
    async saveReceiptImages(expenseId, blobs) {
        const db = await getDb();
        const expIdStr = String(expenseId);
        await this.deleteLocalReceiptImages(expenseId);

        for (let i = 0; i < blobs.length; i++) {
            const id = `${expIdStr}_${i}`;
            await db.receipt_images.put({
                id: id,
                expense_id: expIdStr,
                image_index: i,
                blob: blobs[i],
                sync_status: 'pending',
                created_at: Date.now()
            });
        }

        this.syncPendingImages().catch(e => {
            console.warn('ReceiptImageStore: Background sync failed:', e.message);
        });
    },

    /**
     * Legacy helper for saving a single receipt image.
     */
    async saveReceiptImage(expenseId, blob) {
        if (blob) {
            await this.saveReceiptImages(expenseId, [blob]);
        }
    },

    /**
     * Retrieve all receipt image blobs for an expense from local database.
     * 
     * @param {string|number} expenseId 
     * @returns {Promise<Blob[]>}
     */
    async getReceiptImages(expenseId) {
        const db = await getDb();
        const expIdStr = String(expenseId);
        const expIdNum = Number(expenseId);
        let records = [];

        try {
            // 1. Try index lookup with string representation
            records = await db.receipt_images
                .where('expense_id')
                .equals(expIdStr)
                .toArray();

            // 2. Try index lookup with numeric representation if empty
            if (records.length === 0 && !isNaN(expIdNum)) {
                records = await db.receipt_images
                    .where('expense_id')
                    .equals(expIdNum)
                    .toArray();
            }

            // 3. Fallback scan by ID prefix or expense_id matching
            if (records.length === 0) {
                const prefix = expIdStr + '_';
                records = await db.receipt_images
                    .filter(r => String(r.expense_id) === expIdStr || (r.id && String(r.id).startsWith(prefix)))
                    .toArray();
            }

            records.sort((a, b) => (a.image_index || 0) - (b.image_index || 0));
        } catch (e) {
            console.warn('ReceiptImageStore: IndexedDB query error:', e);
        }

        if (records.length === 0) {
            try {
                const legacyRecord = await db.receipt_images.get(expIdStr);
                if (legacyRecord && legacyRecord.blob) {
                    records = [legacyRecord];
                }
            } catch (e) { }
        }

        return records.map(r => r.blob).filter(Boolean);
    },

    /**
     * Retrieve single receipt image (first one) for legacy callers.
     */
    async getReceiptImage(expenseId) {
        const images = await this.getReceiptImages(expenseId);
        return images.length > 0 ? images[0] : null;
    },

    /**
     * Delete local images for an expense.
     */
    async deleteLocalReceiptImages(expenseId) {
        const db = await getDb();
        const expIdStr = String(expenseId);
        try {
            const records = await db.receipt_images
                .filter(r => String(r.expense_id) === expIdStr || (r.id && String(r.id).startsWith(expIdStr + '_')) || r.id === expIdStr)
                .toArray();
            const keys = records.map(r => r.id);
            if (keys.length > 0) {
                await db.receipt_images.bulkDelete(keys);
            }
        } catch (e) { }
        try {
            await db.receipt_images.delete(expIdStr);
        } catch (e) { }
    },

    /**
     * Delete all receipt images from local database and server.
     * 
     * @param {string} expenseId 
     * @returns {Promise<void>}
     */
    async deleteReceiptImage(expenseId) {
        await this.deleteLocalReceiptImages(expenseId);

        try {
            const reachable = await isServerReachable();
            if (reachable) {
                await fetch(`${RECEIPTS_API}?expense_id=${encodeURIComponent(expenseId)}`, {
                    method: 'DELETE'
                });
            }
        } catch (e) {
            console.warn('ReceiptImageStore: Server delete failed:', e.message);
        }
    },

    /**
     * Upload all pending images to the server.
     */
    async syncPendingImages() {
        const reachable = await isServerReachable();
        if (!reachable) return;

        const db = await getDb();
        let pending = [];
        try {
            pending = await db.receipt_images
                .where('sync_status')
                .equals('pending')
                .toArray();
        } catch (e) {
            return;
        }

        if (pending.length === 0) return;

        console.log(`ReceiptImageStore: Uploading ${pending.length} pending receipt image(s)...`);

        for (const record of pending) {
            const key = record.id || record.expense_id;
            try {
                const formData = new FormData();
                formData.append('expense_id', record.expense_id);
                formData.append('index', record.image_index || 0);
                formData.append('image', record.blob, `${key}.jpg`);

                const response = await fetch(RECEIPTS_API, {
                    method: 'POST',
                    body: formData
                });

                if (response.ok) {
                    await db.receipt_images.update(key, {
                        sync_status: 'synced'
                    });
                    console.log(`ReceiptImageStore: Uploaded receipt image ${key}`);
                } else {
                  console.warn(`ReceiptImageStore: Upload failed for ${key}: ${response.status}`);
                    await db.receipt_images.update(key, {
                        sync_status: 'error'
                    });
                }
            } catch (e) {
                console.warn(`ReceiptImageStore: Upload error for ${key}:`, e.message);
            }
        }
    },

    /**
     * Fetch all receipt images for an expense from the server and cache locally.
     * 
     * @param {string} expenseId 
     * @returns {Promise<Blob[]>}
     */
    async fetchFromServer(expenseId) {
        try {
            const reachable = await isServerReachable();
            if (!reachable) return [];

            const listRes = await fetch(`${RECEIPTS_API}?expense_id=${encodeURIComponent(expenseId)}&list=1`);
            if (!listRes.ok) return [];

            const listData = await listRes.json();
            const indices = listData.indices || [0];
            const blobs = [];

            const db = await getDb();
            for (const idx of indices) {
                const res = await fetch(`${RECEIPTS_API}?expense_id=${encodeURIComponent(expenseId)}&index=${idx}`);
                if (res.ok) {
                    const blob = await res.blob();
                    blobs.push(blob);

                    const recKey = `${expenseId}_${idx}`;
                    await db.receipt_images.put({
                        id: recKey,
                        expense_id: expenseId,
                        image_index: idx,
                        blob: blob,
                        sync_status: 'synced',
                        created_at: Date.now()
                    });
                }
            }

            return blobs;
        } catch (e) {
            console.warn('ReceiptImageStore: Fetch from server failed:', e.message);
            return [];
        }
    },

    /**
     * Check if a receipt image exists (locally or on server).
     * 
     * @param {string} expenseId 
     * @returns {Promise<boolean>}
     */
    async hasReceiptImage(expenseId) {
        const images = await this.getReceiptImages(expenseId);
        return images.length > 0;
    }
};

// Piggyback image sync on main SyncEngine events
window.addEventListener('sync-updated', () => {
    ReceiptImageStore.syncPendingImages().catch(() => {});
});

// Periodic sync for images (every 60s, offset from main 30s sync)
setInterval(() => {
    ReceiptImageStore.syncPendingImages().catch(() => {});
}, 60000);
