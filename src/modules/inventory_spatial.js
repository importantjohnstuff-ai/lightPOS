import { dbPromise, dbRepository as Repository } from "../db.js";
import { SyncEngine } from "../services/SyncEngine.js";

// ... [existing imports/code] ...

async function addNewShelf() {
    const db = await dbPromise;
    const newShelf = {
        label: "New Shelf",
        type: "standard",
        x: 100,
        y: 100,
        width: 100,
        height: 40,
        rotation: 0,
        structure: { levels: 4, divisions: 2 },
        sync_status: 'created',
        _version: 1,
        _updatedAt: new Date().toISOString(),
        _deleted: 0
    };

    // 1. Add to DB to get ID (since auto-increment)
    const id = await db.spatial_shelves.add(newShelf);
    newShelf.id = id;






    // 2. Add to Outbox Manually (Pattern for ++id)
    await db.outbox.add({
        collection: 'spatial_shelves',
        docId: id,
        type: 'upsert',
        payload: { ...newShelf, id }
    });

    shelves.push(newShelf);
    renderFloorplan();
}


export async function loadInventorySpatialView() {
    const content = document.getElementById("main-content");
    content.innerHTML = `
        <div class="flex flex-col h-full">
            <!-- Header -->
            <div class="flex justify-between items-center mb-4">
                <h1 class="text-2xl font-bold text-gray-800">Inventory Spatial Management</h1>
                <div class="flex gap-2 items-center">
                    <div class="relative">
                        <input type="text" id="spatial-search" placeholder="Search item to highlight..." 
                               class="border border-gray-300 rounded-full py-2 px-4 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm">
                        <span class="absolute right-3 top-2.5 text-gray-400 text-xs">🔍</span>
                    </div>
                    <button id="btn-manual-sync" class="bg-gray-600 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded shadow flex items-center gap-2">
                        <span>🔄</span> Sync
                    </button>
                    <button id="btn-toggle-heatmap" class="bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded shadow">
                        Toggle Heatmap
                    </button>
                    <button id="btn-add-shelf" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded shadow">
                        Add Shelf
                    </button>
                </div>
            </div>

            <!-- Main Workspace -->
            <div class="flex flex-1 gap-4 overflow-hidden">
                <!-- Floorplan Canvas Area -->
                <div class="flex-1 bg-white rounded-lg shadow border border-gray-200 relative overflow-hidden" id="floorplan-container">
                    <div class="absolute inset-0 grid-background" id="floorplan-grid">
                        <!-- Shelves will be rendered here -->
                    </div>
                </div>

                <!-- Shelf Detail / Properties Panel -->
                <div class="w-96 bg-white rounded-lg shadow border border-gray-200 flex flex-col hidden" id="shelf-detail-panel">
                    <div class="p-4 border-b flex justify-between items-center bg-gray-50">
                        <h3 class="font-bold text-lg">Shelf Details</h3>
                        <button id="btn-close-detail" class="text-gray-500 hover:text-gray-700">&times;</button>
                    </div>
                    <div class="p-4 flex-1 overflow-y-auto" id="shelf-detail-content">
                        <!-- Specific shelf views go here -->
                        <p class="text-gray-500 text-center mt-10">Select a shelf to view details</p>
                    </div>
                </div>
            </div>
        </div>
        <style>
            .grid-background {
                background-size: 20px 20px;
                background-image:
                    linear-gradient(to right, #e5e7eb 1px, transparent 1px),
                    linear-gradient(to bottom, #e5e7eb 1px, transparent 1px);
            }
            .shelf-item {
                position: absolute;
                background-color: #cbd5e1; /* slate-300 */
                border: 2px solid #64748b; /* slate-500 */
                cursor: grab;
                transition: box-shadow 0.2s, opacity 0.3s ease;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 0.75rem;
                font-weight: bold;
                color: #334155;
            }
            /* ... existing styles ... */
            .shelf-item:active {
                cursor: grabbing;
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
                z-index: 10;
            }
            .shelf-item.selected {
                border-color: #2563eb; /* blue-600 */
                box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
            }
            .shelf-dimmed {
                opacity: 0.25;
            }
        </style>
    `;

    setupEventListeners();
    await loadFloorplan();
}

function setupEventListeners() {
    document.getElementById('btn-add-shelf')?.addEventListener('click', () => {
        addNewShelf();
    });

    // Manual Sync Handler
    const syncBtn = document.getElementById('btn-manual-sync');
    if (syncBtn) {
        syncBtn.addEventListener('click', async () => {
            syncBtn.disabled = true;
            syncBtn.querySelector('span').classList.add('animate-spin');

            // Force Queue All Local Spatial Data (Heal/Onboard old items)
            try {
                const db = await dbPromise;
                const shelves = await db.spatial_shelves.filter(s => !s._deleted).toArray();
                const placements = await db.spatial_placements.filter(p => !p._deleted).toArray();

                const outboxEntries = [];

                // Helper to check if already in outbox to avoid excessive dups (optional but nice)
                // Actually, just pushing is safer to ensure latest state is sent.

                shelves.forEach(s => {
                    outboxEntries.push({
                        collection: 'spatial_shelves',
                        docId: s.id,
                        type: 'upsert',
                        payload: s
                    });
                });

                placements.forEach(p => {
                    outboxEntries.push({
                        collection: 'spatial_placements',
                        docId: p.id,
                        type: 'upsert',
                        payload: p
                    });
                });

                if (outboxEntries.length > 0) {
                    console.log(`Manual Sync: Queueing ${outboxEntries.length} items for force sync.`);
                    await db.outbox.bulkAdd(outboxEntries);
                }
            } catch (e) {
                console.error("Error gathering local data for sync:", e);
            }

            SyncEngine.sync();
        });

        // Listeners for feedback (global sync events)
        const resetSyncBtn = () => {
            syncBtn.disabled = false;
            syncBtn.querySelector('span').classList.remove('animate-spin');
        };

        window.addEventListener('sync-updated', resetSyncBtn);
        window.addEventListener('sync-failed', () => {
            resetSyncBtn();
            alert("Sync failed. Check console/connection.");
        });
        // Just in case sync finishes with no updates
        window.addEventListener('sync-completed', resetSyncBtn); // Assuming SyncEngine dispatches this?
        // Actually SyncEngine dispatches `sync-updated` on success.
    }

    document.getElementById('btn-close-detail')?.addEventListener('click', () => {
        document.getElementById('shelf-detail-panel').classList.add('hidden');
        document.querySelectorAll('.shelf-item').forEach(el => el.classList.remove('selected'));
        currentShelf = null;
    });

    document.getElementById('btn-toggle-heatmap')?.addEventListener('click', toggleHeatmap);

    document.getElementById('spatial-search')?.addEventListener('input', (e) => {
        searchText = e.target.value.toLowerCase();
        renderFloorplan();
    });

    window.addEventListener('sync-updated', async () => {
        if (!document.getElementById('floorplan-grid')) return;
        console.log("Sync updated detected - reloading floorplan");
        await loadFloorplan();
    });
}

// State
let shelves = [];
let draggingShelf = null;
let offset = { x: 0, y: 0 };
let currentShelf = null;
let currentPlacements = [];
// Heatmap State
let heatmapMode = 'none'; // 'none', 'value', 'velocity'
let shelfMetrics = new Map(); // Map<shelfId, { value: number, velocity: number }>
// Search State
let searchText = '';
let shelfContentIndex = new Map(); // Map<shelfId, Set<string (normalized item names)>>

async function loadFloorplan() {
    const db = await dbPromise;
    shelves = await db.spatial_shelves.filter(s => !s._deleted).toArray();

    // Build search index
    await buildSearchIndex();

    renderFloorplan();
}

async function buildSearchIndex() {
    const db = await dbPromise;
    const allPlacements = await db.spatial_placements.filter(p => !p._deleted).toArray();
    const itemIds = [...new Set(allPlacements.map(p => p.item_id))];
    const items = await db.items.where('id').anyOf(itemIds).toArray();
    const itemMap = new Map(items.map(i => [i.id, i]));

    shelfContentIndex.clear();

    allPlacements.forEach(p => {
        if (!shelfContentIndex.has(p.shelf_id)) {
            shelfContentIndex.set(p.shelf_id, new Set());
        }
        const item = itemMap.get(p.item_id);
        if (item) {
            // Add name, barcode, category for searching
            const terms = [item.name, item.barcode, item.category].filter(Boolean).map(t => t.toLowerCase());
            terms.forEach(t => shelfContentIndex.get(p.shelf_id).add(t));
        }
    });
}

function renderFloorplan() {
    const container = document.getElementById('floorplan-grid');
    container.innerHTML = ''; // Clear

    // Find Max for Heatmap Normalization
    let maxMetric = 1;
    if (heatmapMode !== 'none') {
        const values = Array.from(shelfMetrics.values()).map(m => m[heatmapMode]);
        maxMetric = Math.max(...values, 10); // Minimum 10 baseline
    }

    shelves.forEach(shelf => {
        const el = document.createElement('div');
        el.className = 'shelf-item select-none flex flex-col items-center justify-center text-center leading-tight overflow-hidden p-1';
        el.style.left = shelf.x + 'px';
        el.style.top = shelf.y + 'px';
        el.style.width = shelf.width + 'px';
        el.style.height = shelf.height + 'px';
        el.style.transform = `rotate(${shelf.rotation || 0}deg)`;

        // Search Highlighting Logic
        if (searchText.length > 0) {
            const contentSet = shelfContentIndex.get(shelf.id);
            let match = false;
            // Check label
            if (shelf.label.toLowerCase().includes(searchText)) match = true;

            // Check contents
            if (!match && contentSet) {
                for (let term of contentSet) {
                    if (term.includes(searchText)) {
                        match = true;
                        break;
                    }
                }
            }

            if (!match) {
                el.classList.add('shelf-dimmed');
            } else {
                // Highlight matches? Maybe a border or glow?
                el.style.zIndex = 20; // Bring matches to top visual
                el.style.boxShadow = '0 0 0 4px rgba(59, 130, 246, 0.5)';
            }
        }

        // Dynamic background color based on type or Heatmap
        let bgColor = '';
        if (heatmapMode !== 'none') {
            const metrics = shelfMetrics.get(shelf.id);
            if (metrics) {
                const color = getHeatmapColor(metrics[heatmapMode], maxMetric, heatmapMode);
                if (color) {
                    bgColor = color;
                    el.style.color = metrics[heatmapMode] > (maxMetric / 2) ? 'white' : 'black';
                    el.style.textShadow = metrics[heatmapMode] > (maxMetric / 2) ? '0 1px 2px rgba(0,0,0,0.5)' : 'none';
                }
            }
        }

        if (!bgColor) {
            if (shelf.type === 'refrigerator') bgColor = '#bae6fd';
            else if (shelf.type === 'rack') bgColor = '#fed7aa';
            else bgColor = '#cbd5e1';
            el.style.color = '#334155';
        }
        el.style.backgroundColor = bgColor;

        // Metric Label Overlay
        let label = shelf.label;
        if (heatmapMode === 'value') {
            const val = shelfMetrics.get(shelf.id)?.value || 0;
            label += `<br><span class="text-[9px] font-normal">₱${val.toLocaleString()}</span>`;
        } else if (heatmapMode === 'velocity') {
            const val = shelfMetrics.get(shelf.id)?.velocity || 0;
            label += `<br><span class="text-[9px] font-normal">${val} units</span>`;
        }

        el.innerHTML = `
            <span class="font-bold text-[10px] w-full truncate pointer-events-none">${label}</span>
            <div class="resize-handle absolute bottom-0 right-0 w-4 h-4 bg-gray-500 cursor-se-resize opacity-0 hover:opacity-100 transition-opacity"></div>
        `;
        el.dataset.id = shelf.id;

        if (currentShelf && currentShelf.id === shelf.id) {
            el.classList.add('selected');
            el.querySelector('.resize-handle').classList.remove('opacity-0'); // Always show handle if selected
        }

        // Mouse events for dragging
        el.addEventListener('mousedown', handleMouseDown);
        el.addEventListener('click', (e) => handleShelfClick(e, shelf));

        // Resize handle
        el.querySelector('.resize-handle').addEventListener('mousedown', (e) => handleResizeMouseDown(e, shelf));

        container.appendChild(el);
    });
}

// Drag State
let startX = 0;
let startY = 0;
let initialShelfX = 0;
let initialShelfY = 0;

function handleMouseDown(e) {
    if (e.target.classList.contains('shelf-item') || e.target.closest('.shelf-item')) {
        // Ignore if clicking resize handle
        if (e.target.classList.contains('resize-handle')) return;

        draggingShelf = e.target.closest('.shelf-item');
        if (!draggingShelf) return;

        startX = e.clientX;
        startY = e.clientY;
        initialShelfX = parseInt(draggingShelf.style.left || 0);
        initialShelfY = parseInt(draggingShelf.style.top || 0);

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        e.preventDefault(); // Prevent text selection
    }
}

function handleMouseMove(e) {
    if (draggingShelf) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newX = initialShelfX + dx;
        let newY = initialShelfY + dy;

        // Snap to grid (20px)
        newX = Math.round(newX / 20) * 20;
        newY = Math.round(newY / 20) * 20;

        draggingShelf.style.left = newX + 'px';
        draggingShelf.style.top = newY + 'px';
    }
}

async function handleMouseUp(e) {
    if (draggingShelf) {
        const id = parseInt(draggingShelf.dataset.id);
        const x = parseInt(draggingShelf.style.left);
        const y = parseInt(draggingShelf.style.top);

        // Save position
        const db = await dbPromise;
        await db.spatial_shelves.update(id, { x, y });

        // Update local state
        const shelf = shelves.find(s => s.id === id);
        if (shelf) {
            shelf.x = x;
            shelf.y = y;
        }

        draggingShelf = null;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
    }
}

// Resize State
let resizingShelf = null;
let startWidth = 0;
let startHeight = 0;

function handleResizeMouseDown(e, shelf) {
    e.stopPropagation(); // Don't trigger drag
    resizingShelf = shelf;
    startX = e.clientX;
    startY = e.clientY;
    startWidth = shelf.width;
    startHeight = shelf.height;

    document.addEventListener('mousemove', handleResizeMouseMove);
    document.addEventListener('mouseup', handleResizeMouseUp);
}

function handleResizeMouseMove(e) {
    if (resizingShelf) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        // Snap to grid for resize too? Yes, usually better.
        let newW = Math.max(40, startWidth + dx);
        let newH = Math.max(40, startHeight + dy);

        newW = Math.round(newW / 20) * 20;
        newH = Math.round(newH / 20) * 20;

        // Update DOM immediately for feedback
        const el = document.querySelector(`.shelf-item[data-id="${resizingShelf.id}"]`);
        if (el) {
            el.style.width = newW + 'px';
            el.style.height = newH + 'px';
        }
    }
}

async function handleResizeMouseUp(e) {
    if (resizingShelf) {
        const el = document.querySelector(`.shelf-item[data-id="${resizingShelf.id}"]`);
        const width = parseInt(el.style.width);
        const height = parseInt(el.style.height);

        const db = await dbPromise;
        await db.spatial_shelves.update(resizingShelf.id, { width, height });

        // Update local
        const s = shelves.find(x => x.id === resizingShelf.id);
        if (s) {
            s.width = width;
            s.height = height;
        }

        // If details pane open for this shelf, update inputs
        if (currentShelf && currentShelf.id === resizingShelf.id) {
            const wInput = document.getElementById('shelf-width-input');
            const hInput = document.getElementById('shelf-height-input');
            if (wInput) wInput.value = width;
            if (hInput) hInput.value = height;
        }

        resizingShelf = null;
        document.removeEventListener('mousemove', handleResizeMouseMove);
        document.removeEventListener('mouseup', handleResizeMouseUp);
    }
}

function handleShelfClick(e, shelf) {
    e.stopPropagation(); // Prevent deselecting when clicking the shelf

    // Visual selection
    currentShelf = shelf;
    document.querySelectorAll('.shelf-item').forEach(el => {
        el.classList.remove('selected');
        el.querySelector('.resize-handle').classList.add('opacity-0');
    });
    e.currentTarget.classList.add('selected');
    e.currentTarget.querySelector('.resize-handle').classList.remove('opacity-0');

    showShelfDetail(shelf);
}



async function showShelfDetail(shelf) {
    const panel = document.getElementById('shelf-detail-panel');
    const content = document.getElementById('shelf-detail-content');

    // Load placements
    const db = await dbPromise;
    currentPlacements = await db.spatial_placements.where('shelf_id').equals(shelf.id).toArray();

    // Enrich placements with Item Names
    const itemIds = currentPlacements.map(p => p.item_id);
    const items = await db.items.where('id').anyOf(itemIds).toArray();
    const itemMap = new Map(items.map(i => [i.id, i]));

    currentPlacements.forEach(p => {
        p.item = itemMap.get(p.item_id);
    });

    panel.classList.remove('hidden');
    content.innerHTML = `
        <div class="space-y-4">
            <div class="space-y-2">
                <label class="block text-xs font-bold text-gray-500 uppercase">Shelf Configuration</label>
                <div>
                    <label class="block text-sm font-bold text-gray-700">Label</label>
                    <input type="text" id="shelf-label-input" value="${shelf.label}" class="w-full border rounded p-2 text-sm">
                </div>
                <div>
                   <label class="block text-sm font-bold text-gray-700">Type</label>
                   <select id="shelf-type-input" class="w-full border rounded p-2 text-sm">
                       <option value="standard" ${shelf.type === 'standard' ? 'selected' : ''}>Standard Shelf</option>
                       <option value="refrigerator" ${shelf.type === 'refrigerator' ? 'selected' : ''}>Refrigerator</option>
                       <option value="rack" ${shelf.type === 'rack' ? 'selected' : ''}>Display Rack</option>
                   </select>
                </div>
            </div>

            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="block text-sm font-bold text-gray-700">Width (px)</label>
                    <input type="number" id="shelf-width-input" min="40" step="20" value="${shelf.width}" class="w-full border rounded p-2 text-sm">
                </div>
                <div>
                    <label class="block text-sm font-bold text-gray-700">Height (px)</label>
                    <input type="number" id="shelf-height-input" min="40" step="20" value="${shelf.height}" class="w-full border rounded p-2 text-sm">
                </div>
            </div>
            
            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="block text-sm font-bold text-gray-700">Levels</label>
                    <input type="number" id="shelf-levels-input" min="1" max="10" value="${shelf.structure.levels}" class="w-full border rounded p-2 text-sm">
                </div>
                <div>
                    <label class="block text-sm font-bold text-gray-700">Divisions</label>
                    <input type="number" id="shelf-divisions-input" min="1" max="10" value="${shelf.structure.divisions}" class="w-full border rounded p-2 text-sm">
                </div>
            </div>

            <hr>

            <div>
                <h4 class="font-bold text-gray-700 mb-2">Shelf Layout (Side View)</h4>
                <p class="text-xs text-gray-500 mb-2">Click a slot to assign products.</p>
                <div id="shelf-side-view" class="border rounded bg-gray-50 p-4 flex flex-col gap-2 overflow-y-auto" style="min-height: 200px;">
                    ${renderSideView(shelf)}
                </div>
            </div>
            
            <div class="flex justify-end pt-4">
                <button id="btn-delete-shelf" class="text-red-500 text-xs hover:underline">Delete Shelf</button>
            </div>
        </div>
    `;

    // Event Listeners for Shelf Config
    document.getElementById('shelf-label-input').addEventListener('change', async (e) => {
        const val = e.target.value;
        await updateShelf(shelf.id, { label: val });
    });

    document.getElementById('shelf-type-input').addEventListener('change', async (e) => {
        await updateShelf(shelf.id, { type: e.target.value });
    });

    document.getElementById('shelf-width-input').addEventListener('change', async (e) => {
        const val = parseInt(e.target.value);
        await updateShelf(shelf.id, { width: val });
    });

    document.getElementById('shelf-height-input').addEventListener('change', async (e) => {
        const val = parseInt(e.target.value);
        await updateShelf(shelf.id, { height: val });
    });

    document.getElementById('shelf-levels-input').addEventListener('change', async (e) => {
        const levels = parseInt(e.target.value);
        const structure = { ...shelf.structure, levels };
        await updateShelf(shelf.id, { structure });
        refreshSideView(shelf);
    });

    document.getElementById('shelf-divisions-input').addEventListener('change', async (e) => {
        const divisions = parseInt(e.target.value);
        const structure = { ...shelf.structure, divisions };
        await updateShelf(shelf.id, { structure });
        refreshSideView(shelf);
    });

    document.getElementById('btn-delete-shelf').addEventListener('click', async () => {
        if (confirm('Are you sure you want to delete this shelf?')) {
            const db = await dbPromise;

            // Soft Delete Shelf
            const existing = await db.spatial_shelves.get(shelf.id);
            if (existing) {
                const updateData = {
                    ...existing,
                    _deleted: 1,
                    _version: (existing._version || 0) + 1,
                    _updatedAt: new Date().toISOString()
                };
                await db.spatial_shelves.put(updateData);
                await db.outbox.add({
                    collection: 'spatial_shelves',
                    docId: shelf.id,
                    type: 'upsert',
                    payload: updateData
                });
            }

            // Also Soft Delete Placements locally?
            // Technically we could just leave them or soft delete them batch.
            // For now, let's strictly follow the shelf deletion.
            // Ideally, we should soft delete all placements too so they sync as deleted.
            const placements = await db.spatial_placements.where('shelf_id').equals(shelf.id).toArray();
            for (const p of placements) {
                const pUpdate = { ...p, _deleted: 1, _updatedAt: new Date().toISOString() };
                await db.spatial_placements.put(pUpdate); // local soft delete
                await db.outbox.add({
                    collection: 'spatial_placements',
                    docId: p.id,
                    type: 'upsert',
                    payload: pUpdate
                });
            }

            shelves = shelves.filter(s => s.id !== shelf.id);
            renderFloorplan();
            document.getElementById('shelf-detail-panel').classList.add('hidden');
            currentShelf = null;
        }
    });

    // Slot click handlers
    document.querySelectorAll('.shelf-slot').forEach(slot => {
        slot.addEventListener('click', () => handleSlotClick(slot.dataset.level, slot.dataset.division, shelf));
    });
}

async function updateShelf(id, changes) {
    const db = await dbPromise;

    // 1. Partial Update
    // Note: We should also update _version and _updatedAt
    const updateData = {
        ...changes,
        _version: (currentShelf?._version || 0) + 1, // approximate version increment or fetch fresh?
        _updatedAt: new Date().toISOString()
    };
    // Proper Version Logic: Fetch first to get version?
    const existing = await db.spatial_shelves.get(id);
    if (existing) {
        updateData._version = (existing._version || 0) + 1;
    }

    await db.spatial_shelves.update(id, updateData);

    // 2. Queue for Sync (Upsert needs key)
    const updatedShelf = await db.spatial_shelves.get(id);
    if (updatedShelf) {
        await db.outbox.add({
            collection: 'spatial_shelves',
            docId: id,
            type: 'upsert',
            payload: updatedShelf
        });
    }

    // Update local state
    const s = shelves.find(x => x.id === id);
    if (s) Object.assign(s, updateData);
    renderFloorplan();
}

function renderSideView(shelf) {
    let html = '';
    const levels = shelf.structure.levels;
    const divisions = shelf.structure.divisions;

    for (let l = levels; l >= 1; l--) { // From top to bottom
        html += `<div class="flex gap-2 h-16 w-full">`;
        for (let d = 1; d <= divisions; d++) {
            // Get ALL placements for this slot
            const placements = currentPlacements.filter(p => p.level == l && p.division == d);

            let bgClass = '';
            let bgStyle = '';
            let textColor = 'text-blue-900';
            let subTextColor = 'text-gray-500';
            let content = '';

            if (placements.length > 0) {
                // Check Heatmap
                if (heatmapMode !== 'none') {
                    let metricVal = 0;
                    // Find max metric for normalization if needed, or pass it in? 
                    // We can access shelfMetrics global but that's for shelves. 
                    // We need a max for normalization. Let's recalculate or use a static/global one?
                    // Ideally we passed maxMetric to renderSideView, but simpler to just use a rough scale 
                    // OR re-calculate max from *current shelf items*?
                    // If we want consistency with the floorplan, we should use the same maxMetric.
                    // But we don't have it easily here without recalcing. 
                    // Let's use `shelfMetrics` to find the max from global state roughly, or just re-calc for local scale.
                    // Let's re-calc max from shelfMetrics values to ensure consistency.
                    let maxMetric = 1;
                    const values = Array.from(shelfMetrics.values()).map(m => m[heatmapMode]);
                    maxMetric = Math.max(...values, 10);

                    if (heatmapMode === 'value') {
                        // Value of this slot (Projected from Global Stock as per request)
                        // Use the FIRST item's stock value for simplicity if multiple, or sum them?
                        // If mixed, maybe sum?
                        placements.forEach(p => {
                            if (p.item) metricVal += (p.item.selling_price || 0) * (p.item.stock_level || 0);
                        });

                        const color = getHeatmapColor(metricVal, maxMetric, 'value');
                        if (color) bgStyle = `background-color: ${color}; border-color: ${color}`;
                    } else if (heatmapMode === 'velocity') {
                        // Simplify: use generic velocity color for item slots if active to indicate presence
                        // Or use item velocity?
                    }

                    if (bgStyle) {
                        textColor = 'text-white';
                        subTextColor = 'text-white opacity-90';
                        bgStyle += '; border: 1px solid rgba(0,0,0,0.1)';
                    } else {
                        bgClass = 'bg-blue-100 border-blue-300';
                    }
                } else {
                    bgClass = 'bg-blue-100 border-blue-300';
                }

                if (placements.length === 1) {
                    const p = placements[0];
                    if (p.item) {
                        content = `<div class="text-[10px] text-center font-bold ${textColor} leading-tight line-clamp-2">${p.item.name}</div>
                                   <div class="text-[9px] ${subTextColor}">${p.quantity || '0'} units</div>
                                   ${heatmapMode === 'value' ? `<div class="text-[8px] ${subTextColor}">Stock Val: ₱${((p.item.selling_price || 0) * (p.item.stock_level || 0)).toLocaleString()}</div>` : ''}`;
                    } else {
                        content = `<div class="text-[10px] text-red-500 font-bold">Unknown</div>`;
                    }
                } else {
                    // Multiple items
                    let totalStockVal = 0;
                    if (heatmapMode === 'value') {
                        placements.forEach(p => { if (p.item) totalStockVal += (p.item.selling_price || 0) * (p.item.stock_level || 0); });
                    }
                    content = `<div class="text-[10px] text-center font-bold ${textColor} leading-tight">${placements.length} Items</div>
                                <div class="text-[9px] ${subTextColor}">Mixed</div>
                                ${heatmapMode === 'value' ? `<div class="text-[8px] ${subTextColor}">Val: ₱${totalStockVal.toLocaleString()}</div>` : ''}`;
                }
            } else {
                bgClass = 'bg-white border-gray-300 hover:bg-gray-100';
                content = `<div class="text-gray-300 text-xs font-bold">+</div>`;
            }

            if (!bgStyle && !bgClass) bgClass = 'bg-blue-100 border-blue-300';

            html += `
                <div class="shelf-slot flex-1 border ${bgClass} rounded shadow-sm flex flex-col items-center justify-center cursor-pointer transition-all relative overflow-hidden" 
                     style="${bgStyle}"
                     data-level="${l}" data-division="${d}" title="Level ${l}, Div ${d}">
                    ${content}
                </div>
            `;
        }
        html += `</div>`;
    }
    return html;
}

function refreshSideView(shelf) {
    document.getElementById('shelf-side-view').innerHTML = renderSideView(shelf);
    document.querySelectorAll('.shelf-slot').forEach(slot => {
        slot.addEventListener('click', () => handleSlotClick(slot.dataset.level, slot.dataset.division, shelf));
    });
}

// Helper to remove placement
async function removePlacement(id, shelf, level, division) {
    const db = await dbPromise;

    // Soft Delete Implementation for Sync
    const existing = await db.spatial_placements.get(id);
    if (existing) {
        const updateData = {
            ...existing,
            _deleted: 1,
            _version: (existing._version || 0) + 1,
            _updatedAt: new Date().toISOString()
        };

        await db.spatial_placements.put(updateData);

        // Outbox Sync
        await db.outbox.add({
            collection: 'spatial_placements',
            docId: id,
            type: 'upsert', // Sync engine handles _deleted property
            payload: updateData
        });
    }
    // Refresh detail background
    showShelfDetail(shelf);
    // Refresh modal list if open
    await refreshSlotPlacements(shelf, level, division);
    // Update Search Index
    await buildSearchIndex();

    // If modal is open, refresh its search list to show the removed item again
    const modal = document.getElementById('item-picker-modal');
    if (modal && modal.activeSearchRefresher) {
        modal.activeSearchRefresher();
    }
}

// Helper to refresh the placement list inside the open modal
async function refreshSlotPlacements(shelf, level, division) {
    const container = document.getElementById('current-slot-placements');
    if (!container) return;

    const db = await dbPromise;
    const placements = await db.spatial_placements.where({ shelf_id: shelf.id, level: parseInt(level), division: parseInt(division) })
        .filter(p => !p._deleted)
        .toArray();

    // Enrich
    const itemIds = placements.map(p => p.item_id);
    const items = await db.items.where('id').anyOf(itemIds).toArray();
    const itemMap = new Map(items.map(i => [i.id, i]));
    placements.forEach(p => p.item = itemMap.get(p.item_id));

    if (placements.length === 0) {
        container.innerHTML = '<p class="text-sm text-gray-400 italic">Empty Slot</p>';
    } else {
        container.innerHTML = placements.map(p => `
            <div class="flex justify-between items-center bg-blue-50 p-2 rounded border border-blue-100">
                <div class="overflow-hidden">
                     <div class="font-bold text-sm text-blue-900 truncate">${p.item?.name || 'Unknown'}</div>
                     <div class="text-xs text-gray-500">${p.quantity || 0} units</div>
                </div>
                <button class="btn-remove-placement text-red-500 hover:text-red-700 p-1" data-id="${p.id}">&times;</button>
            </div>
        `).join('');
    }

    // Re-attach listeners
    container.querySelectorAll('.btn-remove-placement').forEach(btn => {
        btn.addEventListener('click', () => removePlacement(parseInt(btn.dataset.id), shelf, level, division));
    });
}

async function handleSlotClick(level, division, shelf) {
    // Get ALL placements
    const placements = currentPlacements.filter(p => p.level == level && p.division == division);

    // Create a simple modal for selection
    const modalId = 'item-picker-modal';
    let modal = document.getElementById(modalId);
    if (modal) modal.remove();

    const db = await dbPromise;
    const allItems = await db.items.limit(100).toArray();

    const modalHtml = `
        <div id="${modalId}" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div class="bg-white rounded-lg shadow-xl w-[900px] h-[600px] flex flex-col">
                <div class="p-4 border-b flex justify-between items-center flex-shrink-0">
                    <h3 class="font-bold text-lg">Edit Slot Content (Level ${level}, Div ${division})</h3>
                    <button id="close-picker" class="text-gray-500 hover:text-gray-700 text-xl">&times;</button>
                </div>
                
                <div class="flex flex-1 overflow-hidden">
                    <!-- LEFT COLUMN: SEARCH & ADD -->
                    <div class="w-1/2 flex flex-col border-r border-gray-200 bg-gray-50 p-4">
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-2">Search Items to Add</label>
                        <div class="relative mb-3 flex-shrink-0">
                            <input type="text" id="item-search" placeholder="Type name, barcode..." 
                                   class="w-full border border-gray-300 rounded-lg p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                                   autofocus>
                            <div class="absolute right-3 top-3 text-gray-400">🔍</div>
                        </div>
                        
                        <div class="flex-1 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-inner" id="item-list">
                            <!-- Items List -->
                        </div>
                         <p class="text-[10px] text-gray-400 mt-2 text-center">Items already in this slot are hidden from search.</p>
                    </div>

                    <!-- RIGHT COLUMN: CURRENT CONTENTS -->
                    <div class="w-1/2 flex flex-col p-4 bg-white">
                        <label class="block text-xs font-bold text-gray-500 uppercase mb-2">Detailed Content List</label>
                        <div id="current-slot-placements" class="flex-1 overflow-y-auto space-y-2 pr-1">
                             <!-- Existing items populated here -->
                             <p class="text-gray-400 italic text-sm text-center mt-10">Loading...</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Initial Render of Current Content
    await refreshSlotPlacements(shelf, level, division);

    // Event Listeners for Remove (handled inside refreshSlotPlacements effectively, but we need to re-render search when removal happens)
    // We'll hook into removePlacement to trigger a search refresh if needed? 
    // Actually `removePlacement` calls `refreshSlotPlacements` but doesn't call `renderList`. 
    // We should expose a way to refresh the search list too.

    const renderList = (items) => {
        const listEl = document.getElementById('item-list');
        // Filter out items already in the slot
        // Re-fetch placements current state to be sure? 
        // We can check `currentPlacements` global but it might be stale if we didn't update it. 
        // `refreshSlotPlacements` fetches fresh from DB but doesn't update global `currentPlacements` array perfectly in sync unless we do it.
        // Let's fetch fresh placements for filtering.

        db.spatial_placements.where({ shelf_id: shelf.id, level: parseInt(level), division: parseInt(division) }).toArray().then(currentSlotPlacements => {
            const addedItemIds = new Set(currentSlotPlacements.map(p => p.item_id));

            const filteredItems = items.filter(i => !addedItemIds.has(i.id));

            if (filteredItems.length === 0) {
                listEl.innerHTML = `<div class="p-4 text-center text-sm text-gray-400 italic">No matching items found (or all added).</div>`;
                return;
            }

            listEl.innerHTML = filteredItems.map(i => `
                <div class="p-3 border-b last:border-b-0 hover:bg-blue-50 cursor-pointer flex justify-between items-center group transition-colors item-option" data-id="${i.id}">
                    <div class="overflow-hidden">
                        <div class="font-bold text-sm text-gray-800 truncate group-hover:text-blue-700">${i.name}</div>
                        <div class="text-xs text-gray-500 font-mono">${i.barcode || '-'}</div>
                    </div>
                    <div class="text-blue-600 opacity-0 group-hover:opacity-100 font-bold text-xl leading-none">+</div>
                </div>
            `).join('');

            listEl.querySelectorAll('.item-option').forEach(el => {
                el.addEventListener('click', async () => {
                    await assignItem(el.dataset.id, shelf, level, division);
                    // Re-run search/render to remove the added item from the list
                    const currentTerm = document.getElementById('item-search').value.toLowerCase();
                    triggerSearch(currentTerm);
                });
            });
        });
    };

    const triggerSearch = async (term) => {
        if (term.length < 2) {
            renderList(allItems);
            return;
        }
        const filtered = await db.items
            .filter(i => i.name.toLowerCase().includes(term) || (i.barcode && i.barcode.includes(term)))
            .limit(20)
            .toArray();
        renderList(filtered);
    };

    renderList(allItems);

    // Filter
    document.getElementById('item-search').addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        triggerSearch(term);
    });

    document.getElementById('close-picker').addEventListener('click', () => document.getElementById(modalId).remove());

    // EXPOSE triggerSearch to global scope or attach to modal element so assignItem/removeItem can call it?
    // Or just make assignItem re-trigger it.
    // simpler: assignItem calls refreshSlotPlacements. 
    // We can attach a callback to refreshSlotPlacements? No, that's defined outside.
    // Let's just modify assignItem to also dispatch an event or we can attach the refresher to the DOM element 
    // so we can find it.

    const container = document.getElementById('item-picker-modal');
    container.activeSearchRefresher = () => {
        const term = document.getElementById('item-search').value.toLowerCase();
        triggerSearch(term);
    };
}

async function assignItem(itemId, shelf, level, division) {
    const db = await dbPromise;
    // Handle both numeric IDs and String UUIDs
    const queryId = isNaN(Number(itemId)) ? itemId : Number(itemId);
    const item = await db.items.get(queryId);

    if (!item) {
        console.error("Item not found for ID:", itemId);
        alert("Error: Item not found.");
        return;
    }

    const existing = await db.spatial_placements.where({ shelf_id: shelf.id, level: parseInt(level), division: parseInt(division), item_id: item.id })
        .filter(p => !p._deleted)
        .first();

    if (existing) {
        // Optional: Flash notification
        const container = document.getElementById('current-slot-placements');
        const existingEl = Array.from(container.querySelectorAll('.item-option')).find(el => el.textContent.includes(item.name));
        // Logic to highlight existing... simpler just to alert or ignore
        // alert("Item already added.");
        // For batch speed, better to just ignore silently or flash.
        console.log("Item already in slot");
    } else {
        const newPlacement = {
            shelf_id: shelf.id,
            level: parseInt(level),
            division: parseInt(division),
            item_id: item.id,
            quantity: 1, // Start with 1
            sync_status: 'created',
            _version: 1,
            _updatedAt: new Date().toISOString(),
            _deleted: 0
        };

        const id = await db.spatial_placements.add(newPlacement);
        newPlacement.id = id;

        // Outbox Sync
        await db.outbox.add({
            collection: 'spatial_placements',
            docId: id,
            type: 'upsert',
            payload: { ...newPlacement, id }
        });

        // Refresh UI
        showShelfDetail(shelf); // Updates background
        await refreshSlotPlacements(shelf, level, division); // Updates modal
        // Update Search
        await buildSearchIndex();
    }
}

async function toggleHeatmap() {
    const btn = document.getElementById('btn-toggle-heatmap');

    if (heatmapMode === 'none') {
        heatmapMode = 'value';
        btn.textContent = 'Heatmap: Value ($)';
        btn.classList.remove('bg-purple-600', 'hover:bg-purple-700');
        btn.classList.add('bg-green-600', 'hover:bg-green-700');
        await calculateMetrics();
    } else if (heatmapMode === 'value') {
        heatmapMode = 'velocity';
        btn.textContent = 'Heatmap: Velocity (Qty)';
        btn.classList.remove('bg-green-600', 'hover:bg-green-700');
        btn.classList.add('bg-red-600', 'hover:bg-red-700');
        await calculateMetrics();
    } else {
        heatmapMode = 'none';
        btn.textContent = 'Toggle Heatmap';
        btn.classList.remove('bg-red-600', 'hover:bg-red-700');
        btn.classList.add('bg-purple-600', 'hover:bg-purple-700');
    }

    renderFloorplan();
    if (currentShelf) showShelfDetail(currentShelf);
}

async function calculateMetrics() {
    const db = await dbPromise;
    shelfMetrics.clear();

    const allPlacements = await db.spatial_placements.filter(p => !p._deleted).toArray();
    const itemIds = [...new Set(allPlacements.map(p => p.item_id))];
    const items = await db.items.where('id').anyOf(itemIds).toArray();
    const itemMap = new Map(items.map(i => [i.id, i]));

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const transactions = await db.transactions.where('timestamp').above(thirtyDaysAgo.toISOString()).toArray();

    const itemVelocity = new Map();
    transactions.forEach(t => {
        if (t.item_ids && Array.isArray(t.item_ids)) {
            t.item_ids.forEach(id => {
                itemVelocity.set(id, (itemVelocity.get(id) || 0) + 1);
            });
        }
    });

    shelves.forEach(shelf => {
        let totalValue = 0;
        let totalVelocity = 0;
        const processedItems = new Set();

        const shelfPlacements = allPlacements.filter(p => p.shelf_id === shelf.id);

        shelfPlacements.forEach(p => {
            const item = itemMap.get(p.item_id);
            if (item) {
                // Value: Selling Price * Stock Level (Global)
                // We deduplicate per shelf so we don't sum the same global stock multiple times for multiple facings
                if (!processedItems.has(item.id)) {
                    totalValue += (item.selling_price || 0) * (item.stock_level || 0);
                    processedItems.add(item.id);
                }

                // Velocity can still be cumulative per placement or per item? 
                // Usually velocity is per item. If multiple facings, it's still the same item velocity.
                // Let's count velocity once per item per shelf too, to represent "This shelf holds High Velocity items"
                // rather than "This shelf holds 2x High Velocity items".
                // However, previous logic was summing it up. Let's stick to previous velocity logic or match value logic?
                // Users request was specifically about Value. I will leave velocity as summation or change?
                // Previous: totalVelocity += (itemVelocity.get(item.id) || 0);
                // If I have 10 facings, velocity sum is 10x. That implies "More facings = More velocity capacity"?
                // Let's leave velocity as is (summation of placements) unless asked, 
                // BUT for Value, using Global Stock, deduplication is critical.

                totalVelocity += (itemVelocity.get(item.id) || 0);
            }
        });
        shelfMetrics.set(shelf.id, { value: totalValue, velocity: totalVelocity });
    });
}

function getHeatmapColor(val, max, mode) {
    if (val === 0) return null;
    const intensity = Math.min(val / max, 1);

    if (mode === 'value') {
        const l = 95 - (intensity * 55);
        return `hsl(142, 70%, ${l}%)`;
    } else if (mode === 'velocity') {
        const l = 95 - (intensity * 55);
        return `hsl(0, 90%, ${l}%)`;
    }
    return null;
}
