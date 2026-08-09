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

// Create a completely separate Dexie database for images
const imageDb = new Dexie(IMAGE_DB_NAME);
imageDb.version(1).stores({
    receipt_images: 'expense_id, sync_status, created_at'
});
imageDb.version(2).stores({
    receipt_images: 'id, expense_id, sync_status, created_at'
}).upgrade(tx => {
    return tx.table('receipt_images').toCollection().modify(item => {
        if (!item.id && item.expense_id) {
            item.id = `${item.expense_id}_${item.image_index || 0}`;
            item.image_index = item.image_index || 0;
        }
    });
});

export const ReceiptImageStore = {

    /**
     * Save multiple receipt image blobs for an expense.
     * 
     * @param {string} expenseId 
     * @param {Blob[]} blobs 
     * @returns {Promise<void>}
     */
    async saveReceiptImages(expenseId, blobs) {
        await this.deleteLocalReceiptImages(expenseId);

        for (let i = 0; i < blobs.length; i++) {
            const id = `${expenseId}_${i}`;
            await imageDb.receipt_images.put({
                id: id,
                expense_id: expenseId,
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
     * @param {string} expenseId 
     * @returns {Promise<Blob[]>}
     */
    async getReceiptImages(expenseId) {
        let records = [];
        try {
            records = await imageDb.receipt_images
                .where('expense_id')
                .equals(expenseId)
                .toArray();
            records.sort((a, b) => (a.image_index || 0) - (b.image_index || 0));
        } catch (e) { }

        if (records.length === 0) {
            const legacyRecord = await imageDb.receipt_images.get(expenseId);
            if (legacyRecord && legacyRecord.blob) {
                records = [legacyRecord];
            }
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
        try {
            const records = await imageDb.receipt_images
                .where('expense_id')
                .equals(expenseId)
                .toArray();
            const keys = records.map(r => r.id || r.expense_id);
            if (keys.length > 0) {
                await imageDb.receipt_images.bulkDelete(keys);
            }
        } catch (e) { }
        await imageDb.receipt_images.delete(expenseId);
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

        let pending = [];
        try {
            pending = await imageDb.receipt_images
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
                    await imageDb.receipt_images.update(key, {
                        sync_status: 'synced'
                    });
                    console.log(`ReceiptImageStore: Uploaded receipt image ${key}`);
                } else {
                    console.warn(`ReceiptImageStore: Upload failed for ${key}: ${response.status}`);
                    await imageDb.receipt_images.update(key, {
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

            for (const idx of indices) {
                const res = await fetch(`${RECEIPTS_API}?expense_id=${encodeURIComponent(expenseId)}&index=${idx}`);
                if (res.ok) {
                    const blob = await res.blob();
                    blobs.push(blob);

                    const recKey = `${expenseId}_${idx}`;
                    await imageDb.receipt_images.put({
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
