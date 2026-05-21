import { checkPermission, getUserProfile } from "../auth.js";
import { generateUUID } from "../utils.js";
import { dbRepository as Repository } from "../db.js";
import { SyncEngine } from "../services/SyncEngine.js";

// Module-level state for the cart
let stockInCart = [];
let allItems = []; // Cache for item search
let suppliersList = [];
let historyCache = [];
let currentMode = 'in'; // 'in' or 'out'
let currentHeldId = null; // Track if we're working on a previously held stock-in

// Camera/Mobile State
let mobileStream = null;
let isCameraRunning = false;
let barcodeDetector = null;
let scanDebounce = false;
let audioCtx = null;


export async function loadStockInView() {
    if (!checkPermission('stockin', 'read')) {
        document.getElementById('main-content').innerHTML = '<div class="p-4">Access Denied</div>';
        return;
    }
    await render();

    // Set default dates (Last 30 days)
    const today = new Date().toISOString().split('T')[0];
    const lastMonth = new Date();
    lastMonth.setDate(lastMonth.getDate() - 30);
    document.getElementById('history-start-date').value = lastMonth.toISOString().split('T')[0];
    document.getElementById('history-end-date').value = today;

    await Promise.all([loadAllItems(), fetchSuppliers()]);
    attachEventListeners();
    populateSupplierDropdown();
    await loadStockInHistory();
    await loadPoToReceive();
}

async function loadPoToReceive() {
    const poJson = sessionStorage.getItem('poToReceive');
    if (poJson) {
        // PO Receiving is always Stock In
        currentMode = 'in';
        updateUIMode();

        try {
            const po = JSON.parse(poJson);
            const poItems = JSON.parse(po.items_json || '[]');

            const cartItems = [];
            for (const poItem of poItems) {
                const dbItem = allItems.find(i => i.name.toLowerCase() === poItem.name.toLowerCase());
                if (dbItem) {
                    cartItems.push({
                        id: dbItem.id,
                        name: dbItem.name,
                        quantity: poItem.qty,
                        cost_price: poItem.cost
                    });
                } else {
                    alert(`Item "${poItem.name}" from the PO was not found in the database and will be skipped.`);
                }
            }

            stockInCart = cartItems;

            document.getElementById('source-po-id').value = po.id;
            if (po.supplier_id) {
                document.getElementById('stockin-supplier').value = po.supplier_id;
            }

            renderStockInCart();
            sessionStorage.removeItem('poToReceive');
        } catch (error) {
            console.error("Error loading PO to receive:", error);
        }
    }
}

async function loadAllItems() {
    allItems = await Repository.getAll('items');
}

async function fetchSuppliers() {
    try {
        suppliersList = await Repository.getAll('suppliers');
        if (!Array.isArray(suppliersList)) suppliersList = [];
    } catch (error) {
        console.error("Error fetching suppliers:", error);
        suppliersList = [];
    }
}

function populateSupplierDropdown() {
    const select = document.getElementById("stockin-supplier");
    if (!select) return;
    suppliersList.forEach(sup => {
        const option = document.createElement("option");
        option.value = sup.id;
        option.textContent = sup.name;
        select.appendChild(option);
    });
}

function render() {
    const content = document.getElementById('main-content');
    content.innerHTML = `
        <div class="p-4 md:p-6">
            <div class="flex flex-col md:flex-row justify-between items-center mb-6">
                <div class="flex items-center gap-4">
                    <h2 class="text-2xl font-bold text-gray-800">Stock Management</h2>
                    <button id="btn-mobile-mode" class="bg-blue-600 hover:bg-blue-700 text-white p-2 rounded-full shadow-lg transition transform hover:scale-105" title="Switch to Mobile View">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                    </button>
                </div>

                <div class="bg-gray-200 p-1 rounded-lg inline-flex mt-2 md:mt-0">
                    <button id="mode-in" class="px-4 py-2 rounded-md text-sm font-bold transition-colors bg-white text-green-700 shadow-sm border border-gray-200">Stock In (+)</button>
                    <button id="mode-out" class="px-4 py-2 rounded-md text-sm font-bold transition-colors text-gray-600 hover:text-gray-800">Stock Out (-)</button>
                </div>
            </div>
            
            <div class="grid grid-cols-1 lg:grid-cols-5 gap-8">
                <!-- Left side: Item selection and cart -->
                <div class="lg:col-span-3">
                    <!-- Supplier Selection (moved above Add Item) -->
                    <div class="bg-white p-4 rounded-lg shadow-md mb-4">
                        <label for="stockin-supplier" class="block text-sm font-medium text-gray-700 mb-1">Select Supplier</label>
                        <select id="stockin-supplier" class="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm py-2">
                            <option value="">-- Select Supplier --</option>
                            <!-- Options populated by JS -->
                        </select>
                    </div>

                    <div class="bg-white p-6 rounded-lg shadow-md mb-6">
                        <h3 id="card-title-add" class="text-lg font-semibold text-gray-700 mb-4">Add Item to Inventory (Stock In)</h3>
                        <form id="stockin-form" class="flex flex-col sm:flex-row items-start sm:items-end gap-4">
                            <input type="hidden" id="source-po-id">
                            <div class="flex-grow w-full relative">
                                <label for="item-search" class="block text-sm font-medium text-gray-700">Search Item (Name or Barcode)</label>
                                <input type="text" id="item-search" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm py-2" placeholder="e.g., 'Coffee' or '123456789'" autocomplete="off">
                                <div id="search-results" class="absolute z-10 w-full bg-white border border-gray-300 mt-1 rounded-md shadow-lg max-h-60 overflow-y-auto hidden"></div>
                                <input type="hidden" id="selected-item-id">
                            </div>
                            <div class="w-full sm:w-auto">
                                <label for="item-quantity" class="block text-sm font-medium text-gray-700">Quantity</label>
                                <input type="number" id="item-quantity" min="0" value="1" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm py-2">
                            </div>
                            <button type="submit" id="btn-add-to-cart" class="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-md shadow-sm">
                                Add to Cart (+)
                            </button>
                        </form>
                    </div>

                    <div class="bg-white p-6 rounded-lg shadow-md">
                        <div class="flex items-center justify-between mb-4">
                            <h3 id="card-title-cart" class="text-lg font-semibold text-gray-700">Stock In Cart</h3>
                            <div class="flex gap-2">
                                <button id="btn-hold-stockin" class="text-[10px] bg-orange-500 hover:bg-orange-600 text-white px-2 py-1 rounded font-bold hidden" title="Hold current cart">HOLD</button>
                                <button id="btn-view-held-stockins" class="text-[10px] bg-yellow-600 hover:bg-yellow-700 text-white px-2 py-1 rounded font-bold" title="View held stock-ins">HELD</button>
                            </div>
                        </div>
                        <div id="stock-in-cart-container">
                            <!-- Cart items will be rendered here -->
                        </div>
                        <div id="supplier-section" class="mt-4 border-t pt-4 hidden">
                            <!-- Suggest Selling Price button gets dynamically added here -->
                        </div>
                        <div id="cart-actions" class="mt-4 flex justify-end gap-2 hidden">
                             <button id="clear-cart-btn" class="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded-md shadow-sm">
                                Clear Cart
                            </button>
                            <button id="save-stock-in-btn" class="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-md shadow-sm">
                                Save Stock In
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Right side: Recent history -->
                <div class="lg:col-span-2">
                    <div class="bg-white p-6 rounded-lg shadow-md">
                        <h3 class="text-lg font-semibold text-gray-700 mb-4">Recent History</h3>
                        
                        <div class="flex flex-wrap gap-2 mb-4 items-end bg-gray-50 p-2 rounded border border-gray-200">
                            <div class="flex-1 min-w-[100px]">
                                <label class="block text-xs font-bold text-gray-600">Start</label>
                                <input type="date" id="history-start-date" class="w-full border rounded p-1 text-xs">
                            </div>
                            <div class="flex-1 min-w-[100px]">
                                <label class="block text-xs font-bold text-gray-600">End</label>
                                <input type="date" id="history-end-date" class="w-full border rounded p-1 text-xs">
                            </div>
                            <div class="w-16">
                                <label class="block text-xs font-bold text-gray-600">Rows</label>
                                <input type="number" id="history-limit" value="20" min="5" class="w-full border rounded p-1 text-xs">
                            </div>
                            <button id="btn-refresh-history" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-xs font-bold h-[26px]">Go</button>
                        </div>

                        <div id="stockin-history-container" class="max-h-[28rem] overflow-y-auto">
                            <p class="text-gray-500">Loading history...</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Suggest Price Modal -->
        <div id="modal-suggest-price" class="fixed inset-0 bg-gray-600 bg-opacity-50 hidden flex items-center justify-center z-50">
            <div class="bg-white rounded-lg shadow-lg p-6 w-96">
                <h3 class="text-lg font-bold text-gray-800 mb-4">Suggest Selling Price</h3>
                <p class="text-xs text-gray-500 mb-4">Automatically calculate selling prices for items where the cost has changed.</p>
                <div class="mb-4">
                    <label class="block text-sm font-bold text-gray-700 mb-1">Percentage Increase (%)</label>
                    <input type="number" id="suggest-percent" class="w-full border rounded p-2" placeholder="e.g. 10">
                </div>
                <div class="mb-6">
                    <label class="block text-sm font-bold text-gray-700 mb-1">Cap on Addition (₱)</label>
                    <input type="number" id="suggest-cap" class="w-full border rounded p-2" placeholder="e.g. 50">
                </div>
                <div class="flex justify-end gap-2">
                    <button id="btn-cancel-suggest" class="text-gray-500 hover:text-gray-700 font-bold py-2 px-4 rounded">Cancel</button>
                    <button id="btn-apply-suggest" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded">Apply</button>
                </div>
            </div>
        </div>

        <!-- Held Stock-Ins Modal -->
        <div id="modal-held-stockins" class="fixed inset-0 bg-gray-600 bg-opacity-50 hidden flex items-center justify-center z-50">
            <div class="bg-white rounded-lg shadow-lg p-6 w-full max-w-2xl mx-4">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-xl font-bold text-gray-800">Held Stock-Ins</h3>
                    <div class="flex items-center gap-2">
                        <button id="btn-delete-all-held" class="text-red-600 hover:text-red-800 text-sm font-bold">Delete All</button>
                        <button id="btn-close-held" class="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
                    </div>
                </div>
                <div id="held-stockins-list" class="max-h-96 overflow-y-auto">
                    <div class="text-center p-4 text-gray-500">No held stock-ins.</div>
                </div>
                <div class="mt-4 flex justify-end">
                    <button id="btn-cancel-held" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded">Close</button>
                </div>
            </div>
        </div>

        <!-- Mobile View Container -->
        <div id="mobile-view-container" class="fixed inset-0 bg-gray-900 z-50 hidden flex flex-col font-sans">
            <!-- Mobile Header with Search -->
            <div class="bg-gray-800 p-2 pt-safe-top flex gap-2 items-center shadow-lg z-30 shrink-0 border-b border-gray-700">
                <button id="btn-exit-mobile" class="text-gray-300 p-3 hover:bg-gray-700 hover:text-white rounded-full shrink-0 transition-colors">
                    <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"></path></svg>
                </button>
                <div class="relative flex-grow">
                    <input type="text" id="mobile-search-input" placeholder="Type or Scan..." class="w-full pl-10 pr-4 py-3 bg-gray-700 text-white border-none rounded-xl text-lg placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:bg-gray-600 transition-all outline-none" autocomplete="off">
                    <svg class="w-5 h-5 absolute left-3 top-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                </div>
                 <!-- Qty Input -->
                 <div class="flex flex-col items-center bg-gray-700 rounded-xl px-2 py-1 shrink-0 border border-gray-600">
                     <span class="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Qty</span>
                     <input type="number" id="mobile-qty-input" value="1" min="0" class="w-10 text-center bg-transparent text-white font-bold text-xl border-none focus:ring-0 p-0 leading-none">
                </div>
            </div>

            <!-- Camera Viewport -->
            <div class="flex-1 relative bg-black overflow-hidden w-full flex flex-col">
                <video id="mobile-camera-video" class="absolute inset-0 w-full h-full object-cover hidden" autoplay playsinline muted></video>
                
                <!-- Scanner Guide Overlay -->
                <div id="scanner-overlay" class="absolute inset-0 z-10 hidden pointer-events-none flex flex-col items-center justify-center">
                    <div class="w-72 h-48 border-2 border-white/60 rounded-2xl relative shadow-[0_0_100px_rgba(0,0,0,0.5)]">
                        <div class="absolute top-1/2 left-4 right-4 h-0.5 bg-red-500/80 shadow-[0_0_10px_rgba(255,0,0,0.8)]"></div>
                        <!-- Corner Markers -->
                        <div class="absolute -top-0.5 -left-0.5 w-6 h-6 border-t-4 border-l-4 border-blue-500 rounded-tl-lg"></div>
                        <div class="absolute -top-0.5 -right-0.5 w-6 h-6 border-t-4 border-r-4 border-blue-500 rounded-tr-lg"></div>
                        <div class="absolute -bottom-0.5 -left-0.5 w-6 h-6 border-b-4 border-l-4 border-blue-500 rounded-bl-lg"></div>
                        <div class="absolute -bottom-0.5 -right-0.5 w-6 h-6 border-b-4 border-r-4 border-blue-500 rounded-br-lg"></div>
                    </div>
                </div>

                <!-- Success Overlay -->
                <div id="scan-success-overlay" class="absolute inset-0 bg-green-500/90 backdrop-blur-sm opacity-0 z-40 pointer-events-none transition-all duration-300 flex items-center justify-center transform scale-95 data-[active=true]:scale-100">
                    <div class="bg-white rounded-full p-6 shadow-2xl">
                         <svg class="w-16 h-16 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>
                    </div>
                </div>

                <!-- Start Camera Button (Centered) -->
                <button id="btn-start-camera" class="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-20 bg-blue-600 hover:bg-blue-500 text-white rounded-full w-32 h-32 flex flex-col items-center justify-center shadow-2xl transition hover:scale-105 active:scale-95 group">
                    <svg class="w-10 h-10 mb-2 group-hover:animate-bounce" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                    <span class="font-bold text-sm uppercase tracking-wider">Tap to Scan</span>
                </button>

                <!-- Bottom Controls Bar -->
                <div id="camera-controls" class="absolute bottom-0 left-0 right-0 z-30 hidden">
                    <div class="bg-gradient-to-t from-black/90 via-black/60 to-transparent pb-8 pt-12 px-8 flex justify-between items-end">
                        
                         <!-- Flash -->
                         <button id="btn-toggle-flash" class="flex flex-col items-center justify-center gap-1.5 group p-2 rounded-2xl active:bg-white/10 transition-colors">
                             <div class="w-14 h-14 rounded-full bg-gray-600/50 backdrop-blur-md border border-white/20 flex items-center justify-center group-active:scale-95 transition-transform shadow-lg">
                                <svg class="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                             </div>
                             <span class="text-[10px] font-bold text-white/90 uppercase tracking-wide text-shadow-sm">Flash</span>
                         </button>

                         <!-- Switch Cam -->
                         <button id="btn-switch-camera" class="flex flex-col items-center justify-center gap-1.5 group p-2 rounded-2xl active:bg-white/10 transition-colors">
                             <div class="w-14 h-14 rounded-full bg-gray-600/50 backdrop-blur-md border border-white/20 flex items-center justify-center group-active:scale-95 transition-transform shadow-lg">
                                <svg class="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                             </div>
                             <span class="text-[10px] font-bold text-white/90 uppercase tracking-wide text-shadow-sm">Flip</span>
                         </button>

                         <!-- Cart Button (Prominent) -->
                         <button id="btn-view-mobile-cart" class="flex flex-col items-center justify-center gap-1.5 group relative">
                            <div class="w-16 h-16 rounded-2xl bg-blue-600 shadow-[0_4px_20px_rgba(37,99,235,0.6)] border border-blue-400 flex items-center justify-center group-active:scale-95 transition-transform">
                                <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"></path></svg>
                            </div>
                            <span id="mobile-cart-badge" class="absolute -top-1 right-1 bg-red-500 text-white text-[10px] font-bold h-6 min-w-[1.5rem] px-1.5 rounded-full flex items-center justify-center border-2 border-black hidden shadow-sm">0</span>
                            <span class="text-[10px] font-bold text-blue-200 uppercase tracking-wide text-shadow-sm">Cart</span>
                         </button>
                    </div>
                </div>
            </div>
            <div id="mobile-notification" class="fixed inset-0 z-[70] hidden flex flex-col items-center justify-center text-center p-8 transition-colors duration-300">
                <div id="mobile-notif-icon" class="mb-4"></div>
                <h2 id="mobile-notif-title" class="text-4xl font-black text-white mb-2"></h2>
                <p id="mobile-notif-msg" class="text-white text-lg opacity-90"></p>
            </div>
        </div>
    `;
    updateUIMode();
    renderStockInCart();
}

function attachEventListeners() {
    const searchInput = document.getElementById('item-search');
    const searchResults = document.getElementById('search-results');
    const stockinForm = document.getElementById('stockin-form');
    const cartContainer = document.getElementById('stock-in-cart-container');

    document.getElementById('mode-in').addEventListener('click', () => setMode('in'));
    document.getElementById('mode-out').addEventListener('click', () => setMode('out'));

    searchInput.addEventListener('input', handleSearch);
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const first = searchResults.querySelector('.search-result-item');
            if (first) first.focus();
        }
    });
    searchInput.addEventListener('blur', () => setTimeout(() => {
        if (!searchResults.contains(document.activeElement)) searchResults.classList.add('hidden');
    }, 200));
    stockinForm.addEventListener('submit', handleAddItemToCart);
    setupMobileEventListeners();

    document.getElementById('save-stock-in-btn')?.addEventListener('click', saveStockIn);
    document.getElementById('clear-cart-btn')?.addEventListener('click', clearCart);
    document.getElementById('btn-refresh-history')?.addEventListener('click', loadStockInHistory);

    // Hold / Held buttons
    document.getElementById('btn-hold-stockin')?.addEventListener('click', holdCurrentStockIn);
    document.getElementById('btn-view-held-stockins')?.addEventListener('click', openHeldStockInsModal);
    document.getElementById('btn-close-held')?.addEventListener('click', closeHeldModal);
    document.getElementById('btn-cancel-held')?.addEventListener('click', closeHeldModal);
    document.getElementById('btn-delete-all-held')?.addEventListener('click', deleteAllHeldStockIns);
    updateHeldCount();

    // Suggest Price Modal Listeners
    document.getElementById('start-suggest-price')?.addEventListener('click', () => {
        document.getElementById('modal-suggest-price').classList.remove('hidden');
    });
    document.getElementById('btn-cancel-suggest')?.addEventListener('click', () => {
        document.getElementById('modal-suggest-price').classList.add('hidden');
    });
    document.getElementById('btn-apply-suggest')?.addEventListener('click', applySuggestedPrice);

    cartContainer.addEventListener('change', (e) => {
        const index = parseInt(e.target.dataset.index);
        if (e.target.classList.contains('cart-qty-input')) {
            updateCartQty(index, parseInt(e.target.value));
        } else if (e.target.classList.contains('cart-cost-input')) {
            updateCartCost(index, parseFloat(e.target.value));
        } else if (e.target.classList.contains('cart-price-input')) {
            updateCartPrice(index, parseFloat(e.target.value));
        }
    });

    cartContainer.addEventListener('focusin', (e) => {
        if (e.target.tagName === 'INPUT') {
            e.target.select();
        }
    });

    // Prevent scroll wheel from changing values on price/cost inputs
    cartContainer.addEventListener('wheel', (e) => {
        if (e.target.tagName === 'INPUT' && e.target.type === 'number') {
            e.target.blur();
        }
    }, { passive: true });

    cartContainer.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const target = e.target;
            if (target.tagName !== 'INPUT') return;

            const isQty = target.classList.contains('cart-qty-input');
            const isCost = target.classList.contains('cart-cost-input');
            const isPrice = target.classList.contains('cart-price-input');

            // For price/cost inputs, block ArrowUp/ArrowDown from incrementing values
            if (isCost || isPrice) {
                e.preventDefault();
                return;
            }

            // For qty inputs, allow navigating between rows
            const selector = '.cart-qty-input';
            const inputs = Array.from(cartContainer.querySelectorAll(selector));
            const index = inputs.indexOf(target);

            if (e.key === 'ArrowUp' && index > 0) {
                e.preventDefault();
                inputs[index - 1].focus();
            } else if (e.key === 'ArrowDown' && index < inputs.length - 1) {
                e.preventDefault();
                inputs[index + 1].focus();
            }
        }
    });

    cartContainer.addEventListener('click', (e) => {
        if (e.target.closest('.remove-item-btn')) {
            const button = e.target.closest('.remove-item-btn');
            const itemId = button.dataset.itemId;
            removeFromCart(itemId);
        }
    });

    searchResults.addEventListener('click', (e) => {
        if (e.target.classList.contains('search-result-item')) {
            const itemId = e.target.dataset.id;
            const itemName = e.target.textContent;
            selectSearchItem(itemId, itemName);
        }
    });
}

function setMode(mode) {
    if (mode === currentMode) return;
    if (stockInCart.length > 0) {
        if (!confirm(`Switching to Stock ${mode === 'in' ? 'In' : 'Out'} will clear the current cart. Continue?`)) return;
        stockInCart = [];
        renderStockInCart();
    }
    currentMode = mode;
    updateUIMode();
}

function updateUIMode() {
    const btnIn = document.getElementById('mode-in');
    const btnOut = document.getElementById('mode-out');
    const saveBtn = document.getElementById('save-stock-in-btn');
    const addBtn = document.getElementById('btn-add-to-cart');
    const titleAdd = document.getElementById('card-title-add');
    const titleCart = document.getElementById('card-title-cart');

    if (currentMode === 'in') {
        btnIn.className = "px-4 py-2 rounded-md text-sm font-bold transition-colors bg-white text-green-700 shadow-sm border border-gray-200";
        btnOut.className = "px-4 py-2 rounded-md text-sm font-bold transition-colors text-gray-600 hover:text-gray-800";
        if (saveBtn) { saveBtn.className = "bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-md shadow-sm"; saveBtn.textContent = "Save Stock In"; }
        if (addBtn) { addBtn.className = "w-full sm:w-auto bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-md shadow-sm"; addBtn.textContent = "Add to Cart (+)"; }
        if (titleAdd) titleAdd.textContent = "Add Item to Stock (In)";
        if (titleCart) titleCart.textContent = "Stock In Cart";
    } else {
        btnIn.className = "px-4 py-2 rounded-md text-sm font-bold transition-colors text-gray-600 hover:text-gray-800";
        btnOut.className = "px-4 py-2 rounded-md text-sm font-bold transition-colors bg-white text-red-700 shadow-sm border border-gray-200";
        if (saveBtn) { saveBtn.className = "bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-md shadow-sm"; saveBtn.textContent = "Save Stock Out"; }
        if (addBtn) { addBtn.className = "w-full sm:w-auto bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-md shadow-sm"; addBtn.textContent = "Add to Cart (-)"; }
        if (titleAdd) titleAdd.textContent = "Remove Item from inventory (Stock Out)";
        if (titleCart) titleCart.textContent = "Stock Out Cart";
    }
}

function selectSearchItem(itemId, itemName) {
    document.getElementById('selected-item-id').value = itemId;
    document.getElementById('item-search').value = itemName;
    document.getElementById('search-results').classList.add('hidden');
    const qtyInput = document.getElementById('item-quantity');
    qtyInput.focus();
    qtyInput.select();
}

function addToCart(item, quantity) {
    const existingCartItem = stockInCart.find(cartItem => cartItem.id === item.id);

    if (existingCartItem) {
        existingCartItem.quantity += quantity;
    } else {
        stockInCart.push({
            id: item.id,
            name: item.name,
            quantity: quantity,
            cost_price: item.cost_price || 0,
            original_cost_price: item.cost_price || 0, // Track original cost
            selling_price: item.selling_price || 0,
            is_price_active: false // Initially grayed out
        });
    }
    renderStockInCart();
}

function handleSearch(e) {
    const query = e.target.value;
    const searchInput = e.target;
    const searchResults = document.getElementById('search-results');

    // Quick Add on exact barcode match
    const exactBarcodeMatch = allItems.find(item => item.barcode && item.barcode === query && query.length > 2);
    if (exactBarcodeMatch) {
        addToCart(exactBarcodeMatch, 1);
        searchInput.value = '';
        searchResults.classList.add('hidden');
        return;
    }

    const lowerQuery = query.toLowerCase();
    if (lowerQuery.length < 2) {
        searchResults.classList.add('hidden');
        return;
    }

    const results = allItems.filter(item =>
        (item.name || "").toLowerCase().includes(lowerQuery) ||
        (item.barcode && item.barcode.includes(lowerQuery))
    ).slice(0, 10);

    searchResults.innerHTML = results.map(item =>
        `<div class="p-2 hover:bg-gray-100 cursor-pointer search-result-item focus:bg-blue-100 focus:outline-none" tabindex="0" data-id="${item.id}">${item.name}</div>`
    ).join('');
    searchResults.classList.remove('hidden');

    const items = searchResults.querySelectorAll('.search-result-item');
    items.forEach((div, index) => {
        div.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                selectSearchItem(results[index].id, results[index].name);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                items[index + 1]?.focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (index > 0) items[index - 1].focus();
                else document.getElementById('item-search').focus();
            }
        });
    });
}

function applySuggestedPrice() {
    const percentInput = document.getElementById('suggest-percent');
    const capInput = document.getElementById('suggest-cap');
    const percent = parseFloat(percentInput.value);
    const cap = parseFloat(capInput.value);

    if (isNaN(percent) || isNaN(cap)) {
        alert("Please enter valid numbers for Percentage and Cap.");
        return;
    }

    let updatedCount = 0;
    stockInCart.forEach(item => {
        // Only apply if cost has changed from original
        if (item.cost_price !== item.original_cost_price) {
            const markup = item.cost_price * (percent / 100);
            const addedVal = Math.min(markup, cap);
            const newPrice = item.cost_price + addedVal;

            // Round to 2 decimals
            item.selling_price = Math.round(newPrice * 100) / 100;
            item.is_price_active = true;
            updatedCount++;
        }
    });

    if (updatedCount > 0) {
        renderStockInCart();
        document.getElementById('modal-suggest-price').classList.add('hidden');
        // Simple feedback
        const btn = document.getElementById('start-suggest-price');
        if (btn) btn.textContent = `✅ Updated ${updatedCount} items!`;
        setTimeout(() => { if (btn) btn.innerHTML = `✨ Suggest Selling Price`; }, 2000);
    } else {
        alert("No items found with modified costs.");
    }
}

async function handleAddItemToCart(e) {
    e.preventDefault();
    const itemId = document.getElementById('selected-item-id').value;
    const quantityInput = document.getElementById('item-quantity');
    const quantity = parseInt(quantityInput.value, 10);

    if (!itemId || isNaN(quantity) || quantity < 0) {
        alert('Please select an item and enter a valid quantity (0 or more).');
        return;
    }

    const item = allItems.find(i => i.id === itemId);
    if (!item) {
        alert('Item not found.');
        return;
    }

    addToCart(item, quantity);

    // Reset form
    document.getElementById('stockin-form').reset();
    document.getElementById('selected-item-id').value = '';
    quantityInput.value = 1;
    document.getElementById('item-search').focus();
}

function renderStockInCart() {
    const cartContainer = document.getElementById('stock-in-cart-container');
    const cartActions = document.getElementById('cart-actions');
    const supplierSection = document.getElementById('supplier-section');
    const holdBtn = document.getElementById('btn-hold-stockin');
    if (!cartContainer) return;

    if (stockInCart.length === 0) {
        cartContainer.innerHTML = '<p class="text-gray-500">Cart is empty.</p>';
        cartActions.classList.add('hidden');
        supplierSection.classList.add('hidden');
        if (holdBtn) holdBtn.classList.add('hidden');
        return;
    }

    cartActions.classList.remove('hidden');
    supplierSection.classList.remove('hidden');
    if (holdBtn) holdBtn.classList.remove('hidden');

    // Add Suggest Price Button if not exists
    let suggestBtn = document.getElementById('start-suggest-price');
    if (!suggestBtn) {
        const btnContainer = document.createElement('div');
        btnContainer.className = "mt-2";
        btnContainer.innerHTML = `<button id="start-suggest-price" class="text-blue-600 text-xs hover:underline font-bold">✨ Suggest Selling Price</button>`;
        supplierSection.appendChild(btnContainer);
        // Re-attach listener since we just added it dynamically
        setTimeout(() => {
            document.getElementById('start-suggest-price')?.addEventListener('click', () => {
                document.getElementById('modal-suggest-price').classList.remove('hidden');
            });
        }, 0);
    }

    let grandTotal = 0;
    const isOut = currentMode === 'out';

    const tableRows = stockInCart.map((item, index) => {
        const subtotal = item.quantity * item.cost_price;
        grandTotal += subtotal;
        return `
        <tr class="border-b">
            <td class="p-2">${item.name}</td>
            <td class="p-2 text-center">
                <div class="flex items-center justify-center gap-1">
                    <span class="text-xs font-bold ${isOut ? 'text-red-600' : 'text-green-600'}">${isOut ? '-' : '+'}</span>
                    <input type="number" min="0" class="w-16 border rounded text-center py-1 cart-qty-input" data-index="${index}" value="${item.quantity}">
                </div>
            </td>
            <td class="p-2 text-right">
                <div class="flex items-center justify-end">
                    <span class="mr-1 text-gray-400">₱</span>
                    <input type="number" step="0.01" min="0" class="w-24 border rounded text-right py-1 cart-price-input no-spinner ${item.is_price_active ? 'text-gray-900 font-bold' : 'text-gray-400'}" data-index="${index}" value="${(item.selling_price || 0).toFixed(2)}">
                </div>
            </td>
            <td class="p-2 text-right">
                <div class="flex items-center justify-end">
                    <span class="mr-1 text-gray-400">₱</span>
                    <input type="number" step="0.01" min="0" class="w-24 border rounded text-right py-1 cart-cost-input no-spinner" data-index="${index}" value="${item.cost_price.toFixed(2)}">
                </div>
            </td>
            <td class="p-2 text-right font-medium">₱${subtotal.toFixed(2)}</td>
            <td class="p-2 text-right">
                <button class="text-red-500 hover:text-red-700 remove-item-btn" data-item-id="${item.id}" title="Remove Item">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 pointer-events-none" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd" /></svg>
                </button>
            </td>
        </tr>
    `}).join('');

    cartContainer.innerHTML = `
        <table class="w-full text-sm">
            <thead class="bg-gray-50">
                <tr class="border-b">
                    <th class="text-left p-2 font-semibold">Item</th>
                    <th class="text-center p-2 font-semibold">Qty</th>
                    <th class="text-right p-2 font-semibold">Price</th>
                    <th class="text-right p-2 font-semibold">Cost</th>
                    <th class="text-right p-2 font-semibold">Subtotal</th>
                    <th class="text-right p-2 font-semibold">Actions</th>
                </tr>
            </thead>
            <tbody>
                ${tableRows}
            </tbody>
            <tfoot>
                <tr class="font-bold text-blue-600">
                    <td colspan="4" class="p-2 text-right">Total Invoice Value:</td>
                    <td class="p-2 text-right">₱${grandTotal.toFixed(2)}</td>
                    <td></td>
                </tr>
            </tfoot>
        </table>
    `;
}

function removeFromCart(itemId) {
    stockInCart = stockInCart.filter(item => item.id !== itemId);
    renderStockInCart();
}

function updateCartQty(index, newQty) {
    if (isNaN(newQty) || newQty < 0) {
        renderStockInCart();
        return;
    }
    stockInCart[index].quantity = newQty;
    renderStockInCart();
}

function updateCartCost(index, newCost) {
    if (isNaN(newCost) || newCost < 0) {
        renderStockInCart();
        return;
    }
    stockInCart[index].cost_price = newCost;
    stockInCart[index].is_price_active = true; // Activate selling price visual
    renderStockInCart();
}

function updateCartPrice(index, newPrice) {
    if (isNaN(newPrice) || newPrice < 0) {
        renderStockInCart();
        return;
    }
    stockInCart[index].selling_price = newPrice;
    stockInCart[index].is_price_active = true; // Also activate if manually edited
    renderStockInCart();
}

function clearCart() {
    if (confirm('Are you sure you want to clear the cart?')) {
        stockInCart = [];
        currentHeldId = null;
        renderStockInCart();
    }
}

async function saveStockIn() {
    if (stockInCart.length === 0) {
        alert('Cart is empty. Add items before saving.');
        return;
    }

    const saveBtn = document.getElementById('save-stock-in-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    const user = getUserProfile();
    const supplierId = document.getElementById('stockin-supplier').value;
    const isOut = currentMode === 'out';

    try {
        // 1. Update local items DB
        for (const cartItem of stockInCart) {
            const item = await Repository.get('items', cartItem.id);
            if (item) {
                const change = isOut ? -cartItem.quantity : cartItem.quantity;
                item.stock_level = (item.stock_level || 0) + change;
                item.cost_price = cartItem.cost_price;
                item.selling_price = cartItem.selling_price; // Update selling price
                if (supplierId && !item.supplier_id) {
                    item.supplier_id = supplierId;
                }
                await Repository.upsert('items', item);
            }
        }
        await loadAllItems();

        // 2. Create local history and movement records
        const historyRecord = {
            id: generateUUID(), // Use UUID for server
            user_id: user.email,
            username: user.name,
            items: stockInCart.map(item => ({
                item_id: item.id,
                name: item.name,
                quantity: item.quantity,
                cost_price: item.cost_price,
                movement_id: generateUUID()
            })),
            timestamp: new Date().toISOString(),
            item_count: stockInCart.reduce((sum, item) => sum + item.quantity, 0),
            supplier_id_override: supplierId || null,
            type: currentMode // 'in' or 'out'
        };
        await Repository.upsert('stockins', historyRecord);

        const movements = [];
        for (const item of historyRecord.items) {
            const movement = {
                id: item.movement_id,
                item_id: item.item_id,
                item_name: item.name,
                timestamp: historyRecord.timestamp,
                type: isOut ? 'Stock-Out' : 'Stock-In',
                qty: isOut ? -item.quantity : item.quantity,
                user: user.name || user.email,
                reason: isOut ? 'Manual Stock Out' : 'Supplier Delivery'
            };
            await Repository.upsert('stock_movements', movement);
        }

        // 3. Trigger Background Sync
        SyncEngine.sync();

        const poId = document.getElementById('source-po-id').value;
        if (poId) {
            const po = await Repository.get('purchase_orders', poId);
            if (po) {
                po.status = 'received';
                await Repository.upsert('purchase_orders', po);
            }
            document.getElementById('source-po-id').value = '';
        }

        // If this was a held stock-in, remove it from held list
        if (currentHeldId) {
            removeHeldStockIn(currentHeldId);
            currentHeldId = null;
        }

        alert(`Stock-${isOut ? 'out' : 'in'} successful! Data is saved locally and will sync with the server.`);

        stockInCart = [];
        renderStockInCart();
        updateHeldCount();
        await loadStockInHistory();

    } catch (error) {
        console.error('Failed to save stock-in:', error);
        alert('An error occurred while saving the stock-in. Please try again.');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = isOut ? 'Save Stock Out' : 'Save Stock In';
    }
}

async function loadStockInHistory() {
    const historyContainer = document.getElementById('stockin-history-container');
    historyContainer.innerHTML = '<p class="text-gray-500">Loading history...</p>';

    try {
        const history = await Repository.getAll('stockins');
        historyCache = history;

        const startStr = document.getElementById('history-start-date').value;
        const endStr = document.getElementById('history-end-date').value;
        const limit = parseInt(document.getElementById('history-limit').value) || 20;

        let filtered = history;
        if (startStr && endStr) {
            const startDate = new Date(startStr);
            const endDate = new Date(endStr);
            endDate.setHours(23, 59, 59, 999);
            filtered = history.filter(h => {
                const d = new Date(h.timestamp);
                return d >= startDate && d <= endDate;
            });
        }

        // Sort by timestamp desc and limit
        filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const recentHistory = filtered.slice(0, limit);

        if (recentHistory.length === 0) {
            historyContainer.innerHTML = '<p class="text-gray-500">No recent stock-in history.</p>';
            return;
        }

        historyContainer.innerHTML = `
            <div class="overflow-x-auto">
                <table class="min-w-full text-sm">
                    <thead>
                        <tr class="border-b bg-gray-50">
                            <th class="text-left p-2 font-semibold">Date</th>
                            <th class="text-center p-2 font-semibold">Type</th>
                            <th class="text-left p-2 font-semibold">User</th>
                            <th class="text-center p-2 font-semibold">Items</th>
                            <th class="text-right p-2 font-semibold">Action</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-200">
                        ${recentHistory.map(entry => `
                            <tr>
                                <td class="p-2 whitespace-nowrap text-xs">${new Date(entry.timestamp).toLocaleString()}</td>
                                <td class="p-2 text-center">
                                    <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ${entry.type === 'out' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}">
                                        ${entry.type === 'out' ? 'OUT' : 'IN'}
                                    </span>
                                </td>
                                <td class="p-2">${entry.username || 'N/A'}</td>
                                <td class="p-2 text-center">
                                    ${entry.item_count || (entry.items ? entry.items.reduce((sum, i) => sum + (i.quantity || i.qty || 0), 0) : 0)}
                                </td>
                                <td class="p-2 text-right">
                                    <button class="text-blue-600 hover:text-blue-800 view-details-btn font-medium" data-id="${entry.id}">
                                        View
                                    </button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;

        historyContainer.querySelectorAll('.view-details-btn').forEach(btn => {
            btn.addEventListener('click', () => showStockInDetails(btn.dataset.id));
        });
    } catch (error) {
        console.error('Failed to load stock-in history:', error);
        historyContainer.innerHTML = '<p class="text-red-500">Failed to load history.</p>';
    }
}

async function showStockInDetails(id) {
    const entry = historyCache.find(e => e.id === id);
    if (!entry) return;

    // --- Robust normalization of the items field ---
    // Handle various formats that may exist due to sync encoding issues:
    // 1. entry.items is already a proper array (ideal case)
    // 2. entry.items is a JSON string that needs parsing
    // 3. entry.items_json exists instead of entry.items (legacy double-encoding)
    // 4. entry.items is missing entirely (fall back to stock_movements)

    // Case 3: items_json exists but items doesn't
    if ((!entry.items || (Array.isArray(entry.items) && entry.items.length === 0)) && entry.items_json) {
        try {
            const parsed = typeof entry.items_json === 'string' ? JSON.parse(entry.items_json) : entry.items_json;
            if (Array.isArray(parsed) && parsed.length > 0) {
                entry.items = parsed;
            }
        } catch (e) {
            console.warn("Failed to parse items_json:", e);
        }
    }

    // Case 2: items is a JSON string
    if (typeof entry.items === 'string') {
        try {
            const parsed = JSON.parse(entry.items);
            if (Array.isArray(parsed)) {
                entry.items = parsed;
            }
        } catch (e) {
            console.warn("Failed to parse items string:", e);
            entry.items = [];
        }
    }

    // Case 4: Fallback to stock_movements if items is still missing
    if (!entry.items || !Array.isArray(entry.items) || entry.items.length === 0) {
        try {
            const movements = await Repository.query('stock_movements', {
                where: { timestamp: entry.timestamp }
            });

            if (movements && movements.length > 0) {
                entry.items = movements.map(m => ({
                    id: m.item_id,
                    name: m.item_name || 'Unknown Item',
                    quantity: Math.abs(m.qty),
                    cost_price: 0,
                    qty: Math.abs(m.qty)
                }));
            }
        } catch (e) {
            console.error("Failed to recover items from movements:", e);
        }
    }

    let modal = document.getElementById('stockin-details-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'stockin-details-modal';
        modal.className = 'fixed inset-0 bg-gray-600 bg-opacity-50 hidden flex items-center justify-center z-50';
        document.body.appendChild(modal);
    }

    // DEBUG: Log the entry data to diagnose zero values
    console.log('[StockIn Details] Entry:', JSON.stringify(entry, null, 2));
    console.log('[StockIn Details] items type:', typeof entry.items, 'isArray:', Array.isArray(entry.items));
    if (Array.isArray(entry.items) && entry.items.length > 0) {
        console.log('[StockIn Details] First item:', JSON.stringify(entry.items[0]));
        console.log('[StockIn Details] First item keys:', Object.keys(entry.items[0]));
    }

    const itemRows = (entry.items || []).map(item => {
        const qty = item.quantity || item.qty || 0;
        const cost = item.cost_price || 0;
        const isOut = entry.type === 'out';
        return `
        <tr class="border-b">
            <td class="p-2">${item.name}</td>
            <td class="p-2 text-center font-bold ${isOut ? 'text-red-600' : 'text-green-600'}">${isOut ? '-' : '+'}${qty}</td>
            <td class="p-2 text-right">₱${cost.toFixed(2)}</td>
            <td class="p-2 text-right">₱${(qty * cost).toFixed(2)}</td>
        </tr>
    `}).join('');

    modal.innerHTML = `
        <div class="bg-white rounded-lg shadow-lg p-6 w-full max-w-2xl mx-4">
            <div class="flex justify-between items-center mb-4">
                <h3 class="text-xl font-bold text-gray-800">Transaction Details</h3>
                <button class="text-gray-500 hover:text-gray-700 text-2xl close-modal">&times;</button>
            </div>
            <div class="mb-4 text-sm text-gray-600 grid grid-cols-2 gap-2">
                <div><strong>Date:</strong> ${new Date(entry.timestamp).toLocaleString()}</div>
                <div><strong>User:</strong> ${entry.username || 'N/A'}</div>
                <div><strong>Type:</strong> <span class="uppercase font-bold ${entry.type === 'out' ? 'text-red-600' : 'text-green-600'}">${entry.type === 'out' ? 'Stock Out' : 'Stock In'}</span></div>
            </div>
            ${(!entry.items || entry.items.length === 0) ?
            `<div class="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-4">
                    <p class="text-sm text-yellow-700">Detailed item information is not available for this record.</p>
                 </div>`
            : ''}
            <div class="max-h-96 overflow-y-auto border rounded">
                <table class="w-full text-sm">
                    <thead class="bg-gray-50">
                        <tr class="border-b">
                            <th class="text-left p-2 font-semibold">Item</th>
                            <th class="text-center p-2 font-semibold">Qty</th>
                            <th class="text-right p-2 font-semibold">Cost</th>
                            <th class="text-right p-2 font-semibold">Subtotal</th>
                        </tr>
                    </thead>
                    <tbody>${itemRows}</tbody>
                </table>
            </div>
            <div class="mt-6 flex justify-end">
                <button class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded shadow close-modal">Close</button>
            </div>
        </div>
    `;

    modal.classList.remove('hidden');
    modal.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', () => modal.classList.add('hidden'));
    });
}

/* Mobile & Camera Logic */
function setupMobileEventListeners() {
    const btnMobileMode = document.getElementById("btn-mobile-mode");
    const mobileContainer = document.getElementById("mobile-view-container");
    const btnExitMobile = document.getElementById("btn-exit-mobile");
    const btnStartCamera = document.getElementById("btn-start-camera");
    const btnSwitchCamera = document.getElementById("btn-switch-camera");
    const btnToggleFlash = document.getElementById("btn-toggle-flash");
    const mobileSearch = document.getElementById("mobile-search-input");
    const btnViewCart = document.getElementById("btn-view-mobile-cart");

    if (btnMobileMode) {
        btnMobileMode.addEventListener("click", () => {
            mobileContainer.classList.remove("hidden");
            mobileSearch.focus();
            updateMobileCartBadge();
        });
    }

    if (btnExitMobile) {
        btnExitMobile.addEventListener("click", () => {
            stopCamera();
            mobileContainer.classList.add("hidden");
            renderStockInCart(); // Refresh main view
        });
    }

    btnStartCamera?.addEventListener("click", startCamera);
    btnSwitchCamera?.addEventListener("click", switchCamera);
    btnToggleFlash?.addEventListener("click", toggleFlash);

    btnViewCart?.addEventListener("click", () => {
        stopCamera();
        mobileContainer.classList.add("hidden");
        document.getElementById("stock-in-cart-container")?.scrollIntoView({ behavior: 'smooth' });
    });

    // Manual Mobile Input
    mobileSearch?.addEventListener("keydown", (e) => {
        if (e.key === 'Enter') {
            const val = mobileSearch.value.trim();
            if (val) {
                const item = allItems.find(i => i.barcode === val);
                if (item) {
                    handleScannedCode(val);
                    mobileSearch.value = "";
                } else {
                    showMobileNotification('error', 'Barcode not found');
                    setTimeout(() => document.getElementById("mobile-notification").classList.add("hidden"), 1500);
                }
            }
        }
    });
}

function updateMobileCartBadge() {
    const badge = document.getElementById("mobile-cart-badge");
    if (!badge) return;
    const count = stockInCart.reduce((sum, i) => sum + i.quantity, 0);
    badge.textContent = count;
    if (count > 0) badge.classList.remove("hidden");
    else badge.classList.add("hidden");
}

async function startCamera() {
    if (isCameraRunning) return;

    const video = document.getElementById("mobile-camera-video");
    const btnStart = document.getElementById("btn-start-camera");
    const controls = document.getElementById("camera-controls");
    const overlay = document.getElementById("scanner-overlay");

    try {
        if ('BarcodeDetector' in window) {
            barcodeDetector = new BarcodeDetector({
                formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf']
            });
        } else {
            console.warn("BarcodeDetector not supported");
        }

        const savedFacingMode = localStorage.getItem('stock_camera_facing') || 'environment';

        mobileStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: savedFacingMode }
        });

        video.srcObject = mobileStream;
        video.classList.remove("hidden");
        btnStart.classList.add("hidden");
        controls.classList.remove("hidden");
        overlay.classList.remove("hidden");

        isCameraRunning = true;
        scanDebounce = false;
        requestAnimationFrame(scanLoop);

        const track = mobileStream.getVideoTracks()[0];
        if (track && track.getCapabilities) {
            const capabilities = track.getCapabilities();
            if (capabilities.torch) {
                const btnFlash = document.getElementById("btn-toggle-flash");
                btnFlash.classList.remove("hidden");
            }
        }

    } catch (err) {
        console.error("Camera error:", err);
        alert("Could not access camera. Ensure permissions are granted.");
    }
}

function stopCamera() {
    if (mobileStream) {
        mobileStream.getTracks().forEach(track => track.stop());
        mobileStream = null;
    }
    isCameraRunning = false;
    document.getElementById("mobile-camera-video").classList.add("hidden");
    document.getElementById("btn-start-camera").classList.remove("hidden");
    document.getElementById("camera-controls").classList.add("hidden");
    document.getElementById("scanner-overlay").classList.add("hidden");
}

async function switchCamera() {
    stopCamera();
    const current = localStorage.getItem('stock_camera_facing') || 'environment';
    const next = current === 'environment' ? 'user' : 'environment';
    localStorage.setItem('stock_camera_facing', next);
    await startCamera();
}

async function toggleFlash() {
    if (mobileStream) {
        const track = mobileStream.getVideoTracks()[0];
        if (track && track.getCapabilities && track.getCapabilities().torch) {
            const current = track.getSettings().torch;
            await track.applyConstraints({ advanced: [{ torch: !current }] });
            const btn = document.getElementById("btn-toggle-flash");
            if (!current) {
                btn.classList.add("text-yellow-400");
                btn.classList.remove("text-white");
            } else {
                btn.classList.remove("text-yellow-400");
                btn.classList.add("text-white");
            }
        }
    }
}

async function scanLoop() {
    if (!isCameraRunning) return;

    const video = document.getElementById("mobile-camera-video");
    if (!video) { isCameraRunning = false; return; }

    if (barcodeDetector && !scanDebounce && video.readyState === video.HAVE_ENOUGH_DATA) {
        try {
            const barcodes = await barcodeDetector.detect(video);
            if (barcodes.length > 0) {
                handleScannedCode(barcodes[0].rawValue);
            }
        } catch (e) { }
    }

    if (isCameraRunning) requestAnimationFrame(scanLoop);
}

async function handleScannedCode(code) {
    if (scanDebounce) return;
    scanDebounce = true;

    const item = allItems.find(i => i.barcode === code);

    if (item) {
        playBeep();

        const overlay = document.getElementById("scan-success-overlay");
        overlay?.classList.remove("opacity-0");
        overlay?.classList.add("opacity-75");

        await new Promise(r => setTimeout(r, 300));

        overlay?.classList.remove("opacity-75");
        overlay?.classList.add("opacity-0");

        const qtyInput = document.getElementById("mobile-qty-input");
        const qty = parseInt(qtyInput?.value || "1");

        addToCart(item, qty);
        updateMobileCartBadge();

        showMobileNotification('success', `${item.name} (+${qty})`);

        setTimeout(() => {
            document.getElementById("mobile-notification").classList.add("hidden");
            scanDebounce = false;
        }, 1000);

    } else {
        showMobileNotification('error', `Not Found: ${code}`);
        setTimeout(() => {
            document.getElementById("mobile-notification").classList.add("hidden");
            scanDebounce = false;
        }, 2000);
    }
}

function playBeep(freq = 880, dur = 0.1) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = freq;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + dur);
    osc.stop(audioCtx.currentTime + dur);
}

function showMobileNotification(type, msg) {
    const notif = document.getElementById("mobile-notification");
    const title = document.getElementById("mobile-notif-title");
    const message = document.getElementById("mobile-notif-msg");
    const icon = document.getElementById("mobile-notif-icon");

    if (type === 'success') {
        notif.className = "fixed inset-0 z-[70] flex flex-col items-center justify-center text-center p-8 transition-colors duration-300 bg-green-600";
        title.textContent = "Added";
        icon.innerHTML = `<svg class="w-24 h-24 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>`;
    } else {
        notif.className = "fixed inset-0 z-[70] flex flex-col items-center justify-center text-center p-8 transition-colors duration-300 bg-red-600";
        title.textContent = "Error";
        icon.innerHTML = `<svg class="w-24 h-24 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>`;
    }

    message.textContent = msg;
    notif.classList.remove("hidden");
}

/* =============================================
   Hold / Resume Stock-In Logic
   Uses suspended_transactions table (synced)
   with source:'stockin' to differentiate from POS
   ============================================= */

async function getHeldStockIns() {
    try {
        const all = await Repository.getAll('suspended_transactions');
        return all.filter(entry => entry.source === 'stockin');
    } catch (e) {
        console.error('Error fetching held stock-ins:', e);
        return [];
    }
}

async function removeHeldStockIn(id) {
    try {
        await Repository.remove('suspended_transactions', id);
    } catch (e) {
        console.error('Error removing held stock-in:', e);
    }
}

async function holdCurrentStockIn() {
    if (stockInCart.length === 0) {
        alert('Cart is empty. Add items before holding.');
        return;
    }

    const user = getUserProfile();
    const supplierId = document.getElementById('stockin-supplier')?.value || '';
    const supplierName = suppliersList.find(s => s.id === supplierId)?.name || '';

    const heldEntry = {
        id: currentHeldId || generateUUID(),
        source: 'stockin', // Differentiates from POS suspended transactions
        items: JSON.parse(JSON.stringify(stockInCart)),
        supplier_id: supplierId,
        supplier_name: supplierName,
        mode: currentMode,
        user_email: user?.email || 'Unknown',
        user_name: user?.name || 'Unknown',
        timestamp: new Date().toISOString(),
        created_at: new Date().toISOString(),
        total_items: stockInCart.reduce((sum, i) => sum + i.quantity, 0),
        total: stockInCart.reduce((sum, i) => sum + (i.quantity * i.cost_price), 0)
    };

    try {
        await Repository.upsert('suspended_transactions', heldEntry);
        SyncEngine.sync(); // Trigger sync so other devices can see it

        // Clear the cart
        stockInCart = [];
        currentHeldId = null;
        renderStockInCart();
        await updateHeldCount();

        alert(`Stock-${currentMode === 'out' ? 'out' : 'in'} held successfully. ${heldEntry.total_items} item(s) saved.`);
    } catch (error) {
        console.error('Error holding stock-in:', error);
        alert('Failed to hold stock-in. Please try again.');
    }
}

async function openHeldStockInsModal() {
    const container = document.getElementById('held-stockins-list');
    const modal = document.getElementById('modal-held-stockins');
    if (!container || !modal) return;

    modal.classList.remove('hidden');
    container.innerHTML = '<div class="text-center p-4">Loading...</div>';

    const held = await getHeldStockIns();

    if (held.length === 0) {
        container.innerHTML = '<div class="text-center p-4 text-gray-500">No held stock-ins.</div>';
        return;
    }

    // Sort by timestamp ascending (oldest first, like POS)
    held.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    container.innerHTML = `
        <table class="w-full text-sm">
            <thead class="bg-gray-50">
                <tr class="border-b">
                    <th class="text-left p-2">Time</th>
                    <th class="text-center p-2">Type</th>
                    <th class="text-left p-2">Supplier</th>
                    <th class="text-left p-2">User</th>
                    <th class="text-center p-2">Items</th>
                    <th class="text-center p-2">Action</th>
                </tr>
            </thead>
            <tbody>
                ${held.map(entry => `
                    <tr class="border-b hover:bg-gray-50">
                        <td class="p-2 text-xs">${new Date(entry.timestamp).toLocaleString()}</td>
                        <td class="p-2 text-center">
                            <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ${entry.mode === 'out' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}">
                                ${entry.mode === 'out' ? 'OUT' : 'IN'}
                            </span>
                        </td>
                        <td class="p-2 text-xs">${entry.supplier_name || '—'}</td>
                        <td class="p-2 text-xs">${entry.user_name || entry.user_email || 'N/A'}</td>
                        <td class="p-2 text-center font-bold">${entry.total_items || (Array.isArray(entry.items) ? entry.items.length : 0)}</td>
                        <td class="p-2 text-center flex justify-center gap-2">
                            <button class="bg-blue-600 hover:bg-blue-700 text-white text-xs px-2 py-1 rounded btn-resume-held" data-id="${entry.id}">Resume</button>
                            <button class="bg-red-100 text-red-600 hover:bg-red-200 text-xs px-2 py-1 rounded btn-delete-held" data-id="${entry.id}">Delete</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    // Attach Resume handlers
    container.querySelectorAll('.btn-resume-held').forEach(btn => {
        btn.onclick = () => resumeHeldStockIn(btn.dataset.id);
    });

    // Attach Delete handlers
    container.querySelectorAll('.btn-delete-held').forEach(btn => {
        btn.onclick = () => deleteHeldStockIn(btn.dataset.id);
    });
}

function closeHeldModal() {
    document.getElementById('modal-held-stockins')?.classList.add('hidden');
}

async function resumeHeldStockIn(id) {
    if (stockInCart.length > 0 && !confirm('Current cart is not empty. Overwrite with held stock-in?')) {
        return;
    }

    try {
        const entry = await Repository.get('suspended_transactions', id);
        if (!entry || entry.source !== 'stockin') {
            alert('Could not find held stock-in.');
            return;
        }

        // Robustly parse items (may be stringified JSON after server sync)
        let items = entry.items;
        if (typeof items === 'string') {
            try { items = JSON.parse(items); } catch (e) { console.warn("Failed to parse items string", e); }
        }
        if (!items && entry.items_json) {
            try { items = typeof entry.items_json === 'string' ? JSON.parse(entry.items_json) : entry.items_json; } catch (e) {}
        }
        if (!items && entry.json_body) {
            try {
                const body = typeof entry.json_body === 'string' ? JSON.parse(entry.json_body) : entry.json_body;
                if (body.items) items = body.items;
            } catch (e) {}
        }

        // Restore cart
        stockInCart = Array.isArray(items) ? items : [];
        currentHeldId = entry.id;

        // Restore mode
        if (entry.mode && entry.mode !== currentMode) {
            currentMode = entry.mode;
            updateUIMode();
        }

        // Restore supplier
        const supplierSelect = document.getElementById('stockin-supplier');
        if (supplierSelect && entry.supplier_id) {
            supplierSelect.value = entry.supplier_id;
        }

        // Remove from held list
        await Repository.remove('suspended_transactions', id);
        SyncEngine.sync();

        renderStockInCart();
        closeHeldModal();
        await updateHeldCount();
    } catch (error) {
        console.error('Error resuming held stock-in:', error);
        alert('Error resuming: ' + error.message);
    }
}

async function deleteHeldStockIn(id) {
    if (!confirm('Are you sure you want to delete this held stock-in?')) return;

    await removeHeldStockIn(id);
    SyncEngine.sync();
    await updateHeldCount();
    await openHeldStockInsModal(); // Refresh the list
}

async function deleteAllHeldStockIns() {
    if (!confirm('Are you sure you want to delete ALL held stock-ins?')) return;

    try {
        const held = await getHeldStockIns();
        if (held.length > 0) {
            await Promise.all(held.map(entry => Repository.remove('suspended_transactions', entry.id)));
            SyncEngine.sync();
        }
        await updateHeldCount();
        await openHeldStockInsModal(); // Refresh
    } catch (error) {
        console.error('Error deleting all held stock-ins:', error);
        alert('Failed to delete held stock-ins.');
    }
}

async function updateHeldCount() {
    const held = await getHeldStockIns();
    const count = held.length;
    const btn = document.getElementById('btn-view-held-stockins');
    if (!btn) return;

    // Remove existing badge
    const existingBadge = btn.querySelector('.held-badge');
    if (existingBadge) existingBadge.remove();

    if (count > 0) {
        const badge = document.createElement('span');
        badge.className = 'held-badge ml-1 bg-white text-yellow-700 px-1.5 py-0.5 rounded-full font-bold text-[9px]';
        badge.textContent = count;
        btn.appendChild(badge);
    }
}