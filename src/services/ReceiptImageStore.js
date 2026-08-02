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

export const ReceiptImageStore = {

    /**
     * Save a receipt image blob to the local image database.
     * Marks it as 'pending' for server upload.
     * 
     * @param {string} expenseId - The expense this receipt belongs to
     * @param {Blob} blob - The JPEG image blob
     * @returns {Promise<void>}
     */
    async saveReceiptImage(expenseId, blob) {
        await imageDb.receipt_images.put({
            expense_id: expenseId,
            blob: blob,
            sync_status: 'pending',
            created_at: Date.now()
        });

        // Attempt immediate upload (fire-and-forget)
        this.syncPendingImages().catch(e => {
            console.warn('ReceiptImageStore: Background sync failed:', e.message);
        });
    },

    /**
     * Retrieve a receipt image from the local database.
     * 
     * @param {string} expenseId 
     * @returns {Promise<Blob|null>} The image blob, or null if not found
     */
    async getReceiptImage(expenseId) {
        const record = await imageDb.receipt_images.get(expenseId);
        return record ? record.blob : null;
    },

    /**
     * Delete a receipt image from the local database.
     * Also attempts to delete from the server.
     * 
     * @param {string} expenseId 
     * @returns {Promise<void>}
     */
    async deleteReceiptImage(expenseId) {
        await imageDb.receipt_images.delete(expenseId);

        // Try to delete from server too
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
     * Called after save, on sync-updated events, and periodically.
     * 
     * @returns {Promise<void>}
     */
    async syncPendingImages() {
        const reachable = await isServerReachable();
        if (!reachable) return;

        const pending = await imageDb.receipt_images
            .where('sync_status')
            .equals('pending')
            .toArray();

        if (pending.length === 0) return;

        console.log(`ReceiptImageStore: Uploading ${pending.length} pending receipt(s)...`);

        for (const record of pending) {
            try {
                const formData = new FormData();
                formData.append('expense_id', record.expense_id);
                formData.append('image', record.blob, `${record.expense_id}.jpg`);

                const response = await fetch(RECEIPTS_API, {
                    method: 'POST',
                    body: formData
                });

                if (response.ok) {
                    await imageDb.receipt_images.update(record.expense_id, {
                        sync_status: 'synced'
                    });
                    console.log(`ReceiptImageStore: Uploaded receipt for expense ${record.expense_id}`);
                } else {
                    console.warn(`ReceiptImageStore: Upload failed for ${record.expense_id}: ${response.status}`);
                    await imageDb.receipt_images.update(record.expense_id, {
                        sync_status: 'error'
                    });
                }
            } catch (e) {
                console.warn(`ReceiptImageStore: Upload error for ${record.expense_id}:`, e.message);
            }
        }
    },

    /**
     * Fetch a receipt image from the server and cache it locally.
     * Used when viewing an expense on a device that doesn't have the image locally.
     * 
     * @param {string} expenseId 
     * @returns {Promise<Blob|null>}
     */
    async fetchFromServer(expenseId) {
        try {
            const reachable = await isServerReachable();
            if (!reachable) return null;

            const response = await fetch(`${RECEIPTS_API}?expense_id=${encodeURIComponent(expenseId)}`);
            if (!response.ok) return null;

            const blob = await response.blob();

            // Cache locally
            await imageDb.receipt_images.put({
                expense_id: expenseId,
                blob: blob,
                sync_status: 'synced',
                created_at: Date.now()
            });

            return blob;
        } catch (e) {
            console.warn('ReceiptImageStore: Fetch from server failed:', e.message);
            return null;
        }
    },

    /**
     * Check if a receipt image exists (locally or on server).
     * 
     * @param {string} expenseId 
     * @returns {Promise<boolean>}
     */
    async hasReceiptImage(expenseId) {
        const record = await imageDb.receipt_images.get(expenseId);
        return !!record;
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
