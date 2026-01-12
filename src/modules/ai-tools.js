
import { dbPromise, dbRepository } from "../db.js";
import { renderHeader } from "../layout.js";

// --- State Management ---
let currentAnalysisResult = null;
let currentItems = [];
let aiWorker = null;

// Initialize Worker
if (window.Worker) {
    aiWorker = new Worker(new URL('../workers/ai-worker.js', import.meta.url), { type: "module" });
    aiWorker.onmessage = handleWorkerMessage;
}

import { addNotification } from "../services/notification-service.js"; // Import notification service

export async function loadAIToolsView() {
    const content = document.getElementById("main-content");
    content.innerHTML = `
        <div class="max-w-7xl mx-auto h-full flex flex-col">
            <h2 class="text-2xl font-bold text-gray-800 mb-6">AI Tools</h2>

            <!-- Tab Navigation -->
            <div class="border-b border-gray-200 mb-6">
                <nav class="flex -mb-px space-x-8">
                    <button data-tab="categories" class="ai-tab-btn border-blue-500 text-blue-600 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm">Category Analyzer</button>
                    <button data-tab="parents" class="ai-tab-btn border-transparent text-gray-500 hover:text-gray-700 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm">Item Parent Linker</button>
                </nav>
            </div>

            <!-- Category Analyzer Tab -->
            <div id="ai-tab-categories" class="ai-panel flex-1 flex flex-col min-h-0">
                <div class="bg-white p-6 rounded-lg shadow-sm border h-full flex flex-col">
                    
                    <!-- Header Actions -->
                    <div class="flex justify-between items-center mb-6">
                        <div class="flex items-center gap-4">
                            <div>
                                <h3 class="text-lg font-bold text-gray-700">Category Optimization</h3>
                                <div class="text-sm text-gray-500">
                                    Total Unique: <span id="category-count" class="font-bold text-gray-800">0</span>
                                </div>
                            </div>
                        </div>
                        <div class="flex gap-2">
                            <div class="relative">
                                <select id="audit-category-select" class="border rounded-lg p-2 text-sm w-48 hidden">
                                    <option value="">Select category to audit...</option>
                                </select>
                                <button id="btn-audit-category" class="bg-orange-500 hover:bg-orange-600 text-white font-bold py-2 px-4 rounded-lg shadow transition flex items-center gap-2 hidden">
                                    <span>🔍</span> Audit Category
                                </button>
                            </div>
                            <button id="btn-analyze-categories" class="bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded-lg shadow transition flex items-center gap-2">
                                <span>✨</span> Analyze All
                            </button>
                        </div>
                    </div>
                    
                    <div class="flex-1 flex gap-6 min-h-0">
                        
                        <!-- Left: Current Categories -->
                        <div class="w-1/4 flex flex-col min-h-0 border rounded-lg bg-gray-50">
                            <div class="p-3 border-b bg-gray-100 font-bold text-gray-700 text-sm">Current Categories</div>
                            <div class="flex-1 overflow-y-auto p-2">
                                <ul id="category-list" class="space-y-1">
                                    <li class="p-4 text-center text-gray-400 italic">Loading...</li>
                                </ul>
                            </div>
                        </div>

                        <!-- Right: Analysis Results (Split 3 ways) -->
                        <div class="flex-1 flex flex-col min-h-0 gap-4 relative">
                            
                            <!-- Section: Merged -->
                            <div class="flex-1 border rounded-lg bg-white flex flex-col min-h-0">
                                <div class="p-3 border-b bg-blue-50 font-bold text-blue-700 text-sm flex justify-between items-center">
                                    <span>Proposed Merges</span>
                                    <button id="btn-apply-merges" class="text-xs bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded disabled:opacity-50" disabled>Apply All Merges</button>
                                </div>
                                <div id="container-merged" class="flex-1 overflow-y-auto p-2 space-y-2 text-sm">
                                    <div class="text-center text-gray-400 py-4 italic">Run analysis to see suggestions</div>
                                </div>
                            </div>

                            <!-- Section: Removed -->
                            <div class="flex-1 border rounded-lg bg-white flex flex-col min-h-0">
                                <div class="p-3 border-b bg-red-50 font-bold text-red-700 text-sm flex justify-between items-center">
                                    <span>Categories to Remove</span>
                                    <button id="btn-process-removed" class="text-xs bg-red-600 hover:bg-red-700 text-white px-2 py-1 rounded disabled:opacity-50" disabled>Re-categorize Items (Batch 100)</button>
                                </div>
                                <div id="container-removed" class="flex-1 overflow-y-auto p-2 space-y-2 text-sm"></div>
                            </div>

                             <!-- Section: New -->
                             <div class="flex-1 border rounded-lg bg-white flex flex-col min-h-0">
                                <div class="p-3 border-b bg-green-50 font-bold text-green-700 text-sm">
                                    <span>Proposed New Categories</span>
                                </div>
                                <div id="container-new" class="flex-1 overflow-y-auto p-2 space-y-2 text-sm"></div>
                            </div>

                            <!-- Loading Overlay -->
                            <div id="ai-loading" class="absolute inset-0 bg-white/95 backdrop-blur-sm z-50 hidden flex flex-col items-center justify-center rounded-lg">
                                <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mb-4"></div>
                                <p id="ai-loading-text" class="text-purple-600 font-bold animate-pulse text-lg">Analyzing Store Data...</p>
                                <p id="ai-loading-subtext" class="text-sm text-gray-500 mt-2">Connecting to Local LLM...</p>
                                <div class="w-64 bg-gray-200 rounded-full h-2.5 mt-4 hidden" id="ai-progress-bar-container">
                                    <div id="ai-progress-bar" class="bg-purple-600 h-2.5 rounded-full" style="width: 0%"></div>
                                </div>
                            </div>

                        </div>
                    </div>
                </div>
            </div>

            <!-- Parent Linker Tab -->
            <div id="ai-tab-parents" class="ai-panel flex-1 flex flex-col min-h-0 hidden">
                 <div class="flex-1 flex gap-6 min-h-0">
                    <!-- Left: Supplier List -->
                    <div class="w-1/3 flex flex-col bg-white rounded-lg shadow-sm border overflow-hidden">
                        <div class="p-4 border-b bg-gray-50">
                            <h3 class="font-bold text-gray-700 mb-2">Select Supplier</h3>
                            <input type="text" id="ai-supplier-search" placeholder="Search suppliers..." class="w-full border rounded p-2 text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                        </div>
                        <div class="flex-1 overflow-y-auto">
                            <table class="min-w-full divide-y divide-gray-200">
                                <thead class="bg-gray-50 sticky top-0">
                                    <tr>
                                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Supplier</th>
                                        <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Items</th>
                                    </tr>
                                </thead>
                                <tbody id="ai-supplier-list" class="bg-white divide-y divide-gray-200 cursor-pointer"></tbody>
                            </table>
                        </div>
                    </div>

                    <!-- Right: Workspace -->
                    <div class="flex-1 flex flex-col bg-white rounded-lg shadow-sm border overflow-hidden">
                        <div id="ai-parent-workspace-empty" class="flex-1 flex flex-col items-center justify-center text-gray-400">
                            <svg class="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                            <p>Select a supplier to analyze</p>
                        </div>
                        
                        <div id="ai-parent-workspace-content" class="hidden flex-1 flex flex-col min-h-0">
                            <!-- Header -->
                            <div class="p-4 border-b bg-gray-50 flex justify-between items-center">
                                <div>
                                    <h3 id="ai-selected-supplier-name" class="text-xl font-bold text-gray-800">Supplier Name</h3>
                                    <div class="text-sm text-gray-500"><span id="ai-selected-item-count">0</span> items available</div>
                                </div>
                                <button id="btn-analyze-parents" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded-lg shadow transition flex items-center gap-2">
                                    <span>🔗</span> Analyze Links
                                </button>
                            </div>

                            <!-- Item Preview (Collapsible) -->
                            <div class="border-b bg-gray-50">
                                <button id="btn-toggle-items" class="w-full text-left px-4 py-2 text-xs font-bold text-gray-500 hover:bg-gray-100 flex justify-between items-center">
                                    <span>Current Items Preview</span>
                                    <span id="ai-arrow-items">▼</span>
                                </button>
                                <div id="ai-supplier-items-preview" class="hidden max-h-40 overflow-y-auto p-2 bg-gray-50 border-t text-xs text-gray-600 grid grid-cols-2 gap-2"></div>
                            </div>

                            <!-- Results Area -->
                            <div class="flex-1 p-4 overflow-y-auto bg-gray-50">
                                <div id="ai-parent-results-container" class="space-y-4">
                                    <!-- Results go here -->
                                    <div class="text-center text-gray-400 mt-10 italic">Click analyze to find relationships...</div>
                                </div>
                            </div>
                             
                            <!-- Footer Actions -->
                             <div id="ai-parent-actions" class="p-4 border-t bg-white hidden flex justify-between items-center">
                                <div class="text-sm text-gray-600">
                                    <span id="ai-link-count">0</span> links proposed
                                </div>
                                <div class="flex gap-2">
                                    <button onclick="document.getElementById('ai-parent-results-container').innerHTML=''" class="text-gray-500 hover:text-gray-700 px-3 py-1">Clear</button>
                                    <button id="btn-apply-links" class="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-6 rounded shadow">Apply Selected Links</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    setupTabListeners();
    currentItems = await loadCategories();

    document.getElementById("btn-analyze-categories").addEventListener("click", () => analyzeCategories(currentItems));
    document.getElementById("btn-apply-merges").addEventListener("click", applyMerges);
    document.getElementById("btn-process-removed").addEventListener("click", categorizeRemoved);

    // Audit Setup
    const auditBtn = document.getElementById("btn-audit-category");
    const auditSelect = document.getElementById("audit-category-select");
    if (auditBtn && auditSelect) {
        auditBtn.classList.remove("hidden");
        auditSelect.classList.remove("hidden");
        auditBtn.addEventListener("click", () => {
            const cat = auditSelect.value;
            if (cat) auditCategory(cat);
            else alert("Select a category first!");
        });
    }

    // Parent Linker Setup
    document.getElementById("ai-supplier-search").addEventListener("input", filterSupplierList);
    document.getElementById("btn-toggle-items").addEventListener("click", () => {
        const el = document.getElementById("ai-supplier-items-preview");
        const arrow = document.getElementById("ai-arrow-items");
        if (el.classList.contains("hidden")) {
            el.classList.remove("hidden");
            arrow.textContent = "▲";
        } else {
            el.classList.add("hidden");
            arrow.textContent = "▼";
        }
    });
    document.getElementById("btn-analyze-parents").addEventListener("click", analyzeParents);
    document.getElementById("btn-apply-links").addEventListener("click", applyParentLinks);

    // Initial Load
    loadSuppliersWithCounts();
}

function setupTabListeners() {
    const tabs = document.querySelectorAll('.ai-tab-btn');
    const panels = document.querySelectorAll('.ai-panel');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Deactivate all
            tabs.forEach(t => {
                t.classList.remove('border-blue-500', 'text-blue-600');
                t.classList.add('border-transparent', 'text-gray-500');
            });
            panels.forEach(p => p.classList.add('hidden'));

            // Activate clicked
            tab.classList.remove('border-transparent', 'text-gray-500');
            tab.classList.add('border-blue-500', 'text-blue-600');
            const target = tab.dataset.tab;
            document.getElementById(`ai-tab-${target}`).classList.remove('hidden');
        });
    });
}

async function loadCategories() {
    try {
        const db = await dbPromise;
        const items = await db.items.toArray();
        const categories = [...new Set(items.map(i => i.category))]
            .filter(c => c && c.trim() !== "" && c !== "NULL")
            .sort((a, b) => a.localeCompare(b));

        const listContainer = document.getElementById("category-list");
        const countSpan = document.getElementById("category-count");
        const auditSelect = document.getElementById("audit-category-select");

        if (!listContainer) return [];

        countSpan.textContent = categories.length;

        // Populate Audit Dropdown
        if (auditSelect) {
            auditSelect.innerHTML = '<option value="">Select to audit...</option>' +
                categories.map(c => `<option value="${c}">${c}</option>`).join('');
        }

        if (categories.length === 0) {
            listContainer.innerHTML = `<li class="p-4 text-center text-gray-400 italic">No categories found.</li>`;
            return [];
        }

        listContainer.innerHTML = categories.map(cat => `
            <li class="bg-white border border-gray-200 rounded px-3 py-2 text-xs text-gray-700 shadow-sm flex justify-between items-center group">
                <span class="font-medium truncate mr-2 w-3/4" title="${cat}">${cat}</span>
                <span class="text-[10px] bg-gray-100 rounded-full px-2 py-0.5 text-gray-500 whitespace-nowrap">
                    ${items.filter(i => i.category === cat).length}
                </span>
            </li>
        `).join('');

        return items;
    } catch (error) {
        console.error("Error loading categories:", error);
        return [];
    }
}

// --- Analysis Logic ---

async function analyzeCategories(allItems) {
    const aiSettings = JSON.parse(localStorage.getItem('ai_settings') || '{}');
    if (!aiSettings.url) return alert("Configure AI Settings first.");

    setLoading(true, "Analyzing Categories...");

    // Send to worker
    aiWorker.postMessage({
        type: 'analyze-categories',
        data: { items: allItems },
        aiSettings
    });
}

function renderAnalysisResults(result) {
    // 1. Merged
    const mergedContainer = document.getElementById("container-merged");
    document.getElementById("btn-apply-merges").disabled = !result.merged || result.merged.length === 0;

    if (result.merged && result.merged.length > 0) {
        mergedContainer.innerHTML = result.merged.map(m => `
            <div class="flex justify-between items-center bg-blue-50 p-2 rounded border border-blue-100">
                <span class="line-through text-gray-500">${m.old}</span>
                <span class="font-bold text-gray-400">→</span>
                <span class="font-bold text-blue-700">${m.new}</span>
            </div>
        `).join('');
    } else {
        mergedContainer.innerHTML = '<div class="text-gray-400 italic text-center p-2">No merges suggested.</div>';
    }

    // 2. Removed
    const removedContainer = document.getElementById("container-removed");
    document.getElementById("btn-process-removed").disabled = !result.removed || result.removed.length === 0;

    if (result.removed && result.removed.length > 0) {
        removedContainer.innerHTML = result.removed.map(r => `
            <div class="bg-red-50 p-2 rounded border border-red-100 flex justify-between">
                <span class="text-red-700 font-medium">${r}</span>
                <span class="text-xs text-red-400">Marked for removal</span>
            </div>
        `).join('');
    } else {
        removedContainer.innerHTML = '<div class="text-gray-400 italic text-center p-2">No categories marked for removal.</div>';
    }

    // 3. New
    const newContainer = document.getElementById("container-new");
    if (result.users_proposed_new && result.users_proposed_new.length > 0) {
        newContainer.innerHTML = result.users_proposed_new.map(n => `
             <div class="bg-green-50 p-2 rounded border border-green-100">
                <span class="text-green-700 font-bold">＋ ${n}</span>
            </div>
        `).join('');
    } else {
        newContainer.innerHTML = '<div class="text-gray-400 italic text-center p-2">No new categories proposed.</div>';
    }
}

// --- Action: Apply Merges ---

async function applyMerges() {
    if (!currentAnalysisResult || !currentAnalysisResult.merged) return;
    if (!confirm(`Apply ${currentAnalysisResult.merged.length} merges? This is irreversible.`)) return;

    setLoading(true, "Merging Categories...");

    aiWorker.postMessage({
        type: 'apply-merges',
        data: { merges: currentAnalysisResult.merged },
        aiSettings: JSON.parse(localStorage.getItem('ai_settings') || '{}')
    });
}

// --- Action: Categorize Removed Items (Batch 100) ---

async function categorizeRemoved() {
    if (!currentAnalysisResult || !currentAnalysisResult.removed) return;

    const itemsToProcess = currentItems.filter(i => currentAnalysisResult.removed.includes(i.category));

    if (itemsToProcess.length === 0) {
        alert("No items found in 'Removed' categories.");
        return;
    }

    const validCategories = [...new Set(currentItems.map(i => i.category))];

    setLoading(true, "Re-categorizing Items...");

    aiWorker.postMessage({
        type: 'categorize-removed',
        data: {
            items: itemsToProcess,
            removedCats: currentAnalysisResult.removed,
            validCats: validCategories,
            usersProposedNew: currentAnalysisResult.users_proposed_new,
            merged: currentAnalysisResult.merged
        },
        aiSettings: JSON.parse(localStorage.getItem('ai_settings') || '{}')
    });
}

// --- Action: Audit Category (Batch 50) ---

async function auditCategory(categoryName) {
    const itemsInCat = currentItems.filter(i => i.category === categoryName);
    if (itemsInCat.length === 0) return alert("Category is empty.");

    setLoading(true, `Auditing '${categoryName}'...`);

    aiWorker.postMessage({
        type: 'audit-category',
        data: {
            categoryName,
            items: itemsInCat,
            validCats: [...new Set(currentItems.map(i => i.category))]
        },
        aiSettings: JSON.parse(localStorage.getItem('ai_settings') || '{}')
    });
}

// --- Parent Linker Logic ---

let currentSupplierId = null;
let currentSupplierItems = [];
let currentParentLinks = [];

async function loadSuppliersWithCounts() {
    try {
        const db = await dbPromise;
        const suppliers = await db.suppliers.toArray();
        const items = await db.items.toArray();

        // Count items per supplier
        const counts = {}; // { supplierId: count }
        items.forEach(i => {
            if (i.supplier_id) {
                counts[i.supplier_id] = (counts[i.supplier_id] || 0) + 1;
            }
        });

        // Enrich suppliers with count
        const enriched = suppliers.map(s => ({
            ...s,
            itemCount: counts[s.id] || 0
        })).sort((a, b) => b.itemCount - a.itemCount); // Sort by most items

        const tbody = document.getElementById("ai-supplier-list");
        tbody.innerHTML = enriched.map(s => `
            <tr class="hover:bg-blue-50 transition border-b border-gray-100" onclick="window.selectAiSupplier('${s.id}', '${s.name.replace(/'/g, "\\'")}', ${s.itemCount})">
                <td class="px-4 py-3 text-sm font-medium text-gray-700 filter-name">${s.name}</td>
                <td class="px-4 py-3 text-right text-sm text-gray-500">${s.itemCount}</td>
            </tr>
        `).join('');

        // Expose to window for onclick
        window.selectAiSupplier = selectAiSupplier;

    } catch (e) {
        console.error("Error loading suppliers:", e);
    }
}

function filterSupplierList(e) {
    const term = e.target.value.toLowerCase().trim();
    const rows = document.querySelectorAll("#ai-supplier-list tr");

    rows.forEach(row => {
        const name = row.querySelector(".filter-name").textContent.toLowerCase();

        // 1. Simple Substring Match (Fast)
        if (name.includes(term)) {
            row.style.display = "";
            return;
        }

        // 2. Fuzzy Match (Levenshtein) - Allow ~2 typos for longer words
        const dist = levenshteinDistanceUI(term, name);
        const maxDist = Math.max(2, Math.floor(name.length * 0.3)); // Allow more errors for longer names

        // Also allow if characters appear in order (Acronym style) e.g. "cc" -> "Coca Cola"
        const isAcronym = fuzzyMatchAcronym(term, name);

        if (dist <= maxDist || isAcronym) {
            row.style.display = "";
        } else {
            row.style.display = "none";
        }
    });
}

function fuzzyMatchAcronym(needle, haystack) {
    let i = 0, j = 0;
    while (i < needle.length && j < haystack.length) {
        if (needle[i] === haystack[j]) {
            i++;
        }
        j++;
    }
    return i === needle.length;
}

function levenshteinDistanceUI(a, b) {
    // Optimization: if difference in lengths is greater than threshold, don't compute
    if (Math.abs(a.length - b.length) > 5) return 999;

    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) == a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
            }
        }
    }
    return matrix[b.length][a.length];
}

async function selectAiSupplier(id, name, count) {
    currentSupplierId = id;
    document.getElementById("ai-parent-workspace-empty").classList.add("hidden");
    document.getElementById("ai-parent-workspace-content").classList.remove("hidden");

    document.getElementById("ai-selected-supplier-name").textContent = name;
    document.getElementById("ai-selected-item-count").textContent = count;

    // Load items for display
    const db = await dbPromise;
    currentSupplierItems = await db.items.where('supplier_id').equals(id).toArray();

    const preview = document.getElementById("ai-supplier-items-preview");
    preview.innerHTML = currentSupplierItems.map(i => `
        <div class="truncate" title="${i.name}">${i.name}</div>
    `).join('');

    // Reset Results
    document.getElementById("ai-parent-results-container").innerHTML = '<div class="text-center text-gray-400 mt-10 italic">Click analyze to find relationships...</div>';
    document.getElementById("ai-parent-actions").classList.add("hidden");
}

async function analyzeParents() {
    if (!currentSupplierId || currentSupplierItems.length === 0) return alert("Select a supplier with items.");

    setLoading(true, "Analyzing Parent-Child Relationships...");

    // Send to worker
    aiWorker.postMessage({
        type: 'analyze-parents',
        data: {
            items: currentSupplierItems.map(i => ({ id: i.id, name: i.name, parent_id: i.parent_id }))
        },
        aiSettings: JSON.parse(localStorage.getItem('ai_settings') || '{}')
    });
}

function renderParentAnalysisResults(links) {
    currentParentLinks = links; // Store for application
    const container = document.getElementById("ai-parent-results-container");
    const actions = document.getElementById("ai-parent-actions");
    const countSpan = document.getElementById("ai-link-count");

    if (!links || links.length === 0) {
        container.innerHTML = '<div class="text-center text-gray-500 py-8">No parent-child relationships found.</div>';
        actions.classList.add("hidden");
        return;
    }

    actions.classList.remove("hidden");
    countSpan.textContent = links.length;

    container.innerHTML = links.map((link, index) => {
        const parent = currentSupplierItems.find(i => i.id === link.parent_id);
        const child = currentSupplierItems.find(i => i.id === link.child_id);
        if (!parent || !child) return ''; // Should not happen

        return `
            <div class="bg-white p-3 rounded border border-gray-200 shadow-sm flex items-center gap-4">
                <input type="checkbox" class="link-checkbox w-4 h-4 text-indigo-600 rounded" data-index="${index}" checked>
                
                <div class="flex-1 flex items-center justify-center gap-2">
                    <div class="flex-1 text-right">
                        <div class="font-bold text-gray-800 text-sm">${parent.name}</div>
                        <div class="text-xs text-indigo-600 font-bold">PARENT</div>
                    </div>
                    
                    <div class="flex flex-col items-center px-4">
                        <div class="text-xs text-gray-400 font-mono">contains</div>
                        <div class="bg-indigo-100 text-indigo-800 px-2 py-1 rounded font-bold text-sm border border-indigo-200">
                            ${link.conversion_factor}
                        </div>
                        <div class="text-2xl text-gray-300">↓</div>
                    </div>

                    <div class="flex-1 text-left">
                        <div class="font-bold text-gray-800 text-sm">${child.name}</div>
                        <div class="text-xs text-green-600 font-bold">CHILD</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

async function applyParentLinks() {
    const checkboxes = document.querySelectorAll(".link-checkbox:checked");
    if (checkboxes.length === 0) return alert("Select at least one link to apply.");

    const selectedIndices = Array.from(checkboxes).map(cb => parseInt(cb.dataset.index));
    const linksToApply = selectedIndices.map(i => currentParentLinks[i]);

    if (!confirm(`Apply ${linksToApply.length} parent-child links?`)) return;

    const db = await dbPromise;
    let appliedCount = 0;

    for (const link of linksToApply) {
        // We update the CHILD item to set its parent_id and conv_factor
        await db.items.update(link.child_id, {
            parent_id: link.parent_id,
            conv_factor: link.conversion_factor
        });
        appliedCount++;
    }

    alert(`Successfully linked ${appliedCount} items!`);

    // Refresh
    selectAiSupplier(currentSupplierId, document.getElementById("ai-selected-supplier-name").textContent, document.getElementById("ai-selected-item-count").textContent);
}

function handleWorkerMessage(e) {
    const { type, result, error, message, current, total, count } = e.data;

    // Stop loading if error or final success (except progress)
    if (type !== 'progress') {
        const loadingEl = document.getElementById("ai-loading");
        if (loadingEl && !loadingEl.classList.contains("hidden")) {
            setLoading(false);
        }
    }

    if (type === 'error') {
        alert("AI Error: " + error);
        console.error("AI Worker Error:", error);
    } else if (type === 'progress') {
        // Only update UI if we are on the page
        if (document.getElementById("ai-loading")) {
            // Make sure loading is shown if it was hidden (e.g. user navigated back)
            // Actually, setLoading(true) might reset text, so we handle UI manually here
            const p = document.getElementById("ai-progress-bar");
            const pc = document.getElementById("ai-progress-bar-container");
            const st = document.getElementById("ai-loading-subtext");

            if (p && pc && total > 0) {
                pc.classList.remove("hidden");
                const pect = Math.round((current / total) * 100);
                p.style.width = `${pect}%`;
            }
            if (st) st.textContent = message;
        }
    } else if (type === 'success') {
        // Determine context based on result structure or state
        if (result && result.merged) {
            // Analyze Categories Result
            currentAnalysisResult = result;
            // If UI is active, render.
            if (document.getElementById("container-merged")) {
                renderAnalysisResults(result);
            }
            addNotification("AI", "Category analysis complete.");
        } else if (count !== undefined) {
            // Categorize Removed or Audit
            addNotification("AI", `Operation complete. processed ${count} items.`);
            // Refresh
            loadCategories().then(items => {
                currentItems = items;
                if (document.getElementById("category-count")) {
                    alert("Operation Complete!");
                }
            });
        } else if (result && result.links) {
            // Parent Linker Result
            renderParentAnalysisResults(result.links);
            addNotification("AI", `Analysis complete. Found ${result.links.length} potential links.`);
        } else {
            // Apply Merges
            addNotification("AI", "Category merges applied.");
            loadCategories().then(items => {
                currentItems = items;
                if (document.getElementById("container-merged")) {
                    document.getElementById("btn-apply-merges").disabled = true;
                    document.getElementById("container-merged").innerHTML = '<div class="text-green-600 custom-center p-2">Merges applied!</div>';
                    alert("Merges applied successfully!");
                }
            });
        }
    }
}

// --- Helper: Call LLM ---
// function callLLM removed (moved to worker)

function setLoading(isLoading, text = "") {
    const el = document.getElementById("ai-loading");
    if (isLoading) {
        el.classList.remove("hidden");
        document.getElementById("ai-loading-text").textContent = text;
    } else {
        el.classList.add("hidden");
        document.getElementById("ai-progress-bar-container")?.classList.add("hidden");
    }
}
