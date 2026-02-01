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

// Camera State
let mobileStream = null;
let isCameraRunning = false;
let barcodeDetector = null;
let scanDebounce = false;


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

    // Check for mobile and show mobile button if applicable
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile) {
        document.getElementById('mobile-scan-btn-container').classList.remove('hidden');
    }
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
                <h2 class="text-2xl font-bold text-gray-800">Stock Management</h2>
                <div class="bg-gray-200 p-1 rounded-lg inline-flex mt-2 md:mt-0">
                    <button id="mode-in" class="px-4 py-2 rounded-md text-sm font-bold transition-colors bg-white text-green-700 shadow-sm border border-gray-200">Stock In (+)</button>
                    <button id="mode-out" class="px-4 py-2 rounded-md text-sm font-bold transition-colors text-gray-600 hover:text-gray-800">Stock Out (-)</button>
                </div>
            </div>
            
            <div class="grid grid-cols-1 lg:grid-cols-5 gap-8">
                <!-- Left side: Item selection and cart -->
                <div class="lg:col-span-3">
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
                                <input type="number" id="item-quantity" min="1" value="1" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm py-2">
                            </div>
                            <button type="submit" id="btn-add-to-cart" class="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-md shadow-sm">
                                Add to Cart (+)
                            </button>
                        </form>
                    </div>

                    <div class="bg-white p-6 rounded-lg shadow-md">
                        <h3 id="card-title-cart" class="text-lg font-semibold text-gray-700 mb-4">Stock In Cart</h3>
                        <div id="stock-in-cart-container">
                            <!-- Cart items will be rendered here -->
                        </div>
                        <div id="supplier-section" class="mt-4 border-t pt-4 hidden">
                            <label for="stockin-supplier" class="block text-sm font-medium text-gray-700">Optional: Set Supplier for items without one</label>
                            <select id="stockin-supplier" class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm">
                                <option value="">-- Select Supplier --</option>
                                <!-- Options populated by JS -->
                            </select>
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
    `;
    updateUIMode();
    renderStockInCart();

    // Inject Mobile Scanner UI
    const mobileUI = document.createElement('div');
    mobileUI.innerHTML = `
        < !--Floating Mobile Scan Button-- >
        <div id="mobile-scan-btn-container" class="fixed bottom-6 right-6 z-40 hidden">
             <button id="btn-open-mobile-scan" class="bg-blue-600 hover:bg-blue-700 text-white rounded-full p-4 shadow-xl flex items-center justify-center transition transform active:scale-95">
                <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 16h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"></path></svg>
            </button>
        </div>

        <!--Mobile Scanner Overlay-- >
        <div id="stock-mobile-scanner" class="fixed inset-0 bg-black z-[60] hidden flex flex-col">
            <div class="relative flex-1 bg-black overflow-hidden flex items-center justify-center">
                <video id="stock-mobile-video" class="absolute inset-0 w-full h-full object-cover" autoplay playsinline muted></video>

                <!-- Scanner Overlay -->
                <div class="absolute inset-0 border-2 border-red-500 opacity-50 pointer-events-none">
                    <div class="absolute top-1/2 left-0 right-0 h-0.5 bg-red-600 shadow-[0_0_10px_rgba(255,0,0,0.8)]"></div>
                </div>

                <!-- Success Overlay -->
                <div id="stock-scan-success" class="absolute inset-0 bg-green-500 opacity-0 z-30 pointer-events-none transition-opacity duration-300 flex items-center justify-center">
                    <svg class="w-24 h-24 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
                </div>

                <!-- Controls -->
                <button id="btn-close-stock-camera" class="absolute top-4 right-4 bg-gray-800 bg-opacity-50 text-white p-2 rounded-full z-20">
                    <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
                <button id="btn-toggle-stock-flash" class="absolute top-4 left-4 bg-gray-800 bg-opacity-50 text-white p-2 rounded-full z-20 hidden">
                    <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                </button>
            </div>
            <div class="p-4 bg-white text-center">
                <p class="text-sm font-bold text-gray-700">Point camera at barcode to add to cart</p>
                <div id="last-scanned-msg" class="text-xs text-green-600 mt-1 font-bold h-4"></div>
            </div>
        </div>
    `;
    document.body.appendChild(mobileUI);
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

    document.getElementById('save-stock-in-btn')?.addEventListener('click', saveStockIn);
    document.getElementById('clear-cart-btn')?.addEventListener('click', clearCart);
    document.getElementById('save-stock-in-btn')?.addEventListener('click', saveStockIn);
    document.getElementById('clear-cart-btn')?.addEventListener('click', clearCart);
    document.getElementById('btn-refresh-history')?.addEventListener('click', loadStockInHistory);

    // Mobile Scanner Listeners
    setupMobileScannerListeners();

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

    cartContainer.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const target = e.target;
            if (target.tagName !== 'INPUT') return;

            const isQty = target.classList.contains('cart-qty-input');
            const isCost = target.classList.contains('cart-cost-input');
            const selector = isQty ? '.cart-qty-input' : (isCost ? '.cart-cost-input' : '.cart-price-input');
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
        if (!confirm(`Switching to Stock ${mode === 'in' ? 'In' : 'Out'} will clear the current cart.Continue ? `)) return;
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

    if (!itemId || !quantity || quantity <= 0) {
        alert('Please select an item and enter a valid quantity.');
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
    if (!cartContainer) return;

    if (stockInCart.length === 0) {
        cartContainer.innerHTML = '<p class="text-gray-500">Cart is empty.</p>';
        cartActions.classList.add('hidden');
        supplierSection.classList.add('hidden');
        return;
    }

    cartActions.classList.remove('hidden');
    cartActions.classList.remove('hidden');
    supplierSection.classList.remove('hidden');

    // Add Suggest Price Button if not exists
    let suggestBtn = document.getElementById('start-suggest-price');
    if (!suggestBtn) {
        const btnContainer = document.createElement('div');
        btnContainer.className = "mt-2";
        btnContainer.innerHTML = `< button id = "start-suggest-price" class="text-blue-600 text-xs hover:underline font-bold" >✨ Suggest Selling Price</button > `;
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
        < tr class="border-b" >
            <td class="p-2">${item.name}</td>
            <td class="p-2 text-center">
                <div class="flex items-center justify-center gap-1">
                    <span class="text-xs font-bold ${isOut ? 'text-red-600' : 'text-green-600'}">${isOut ? '-' : '+'}</span>
                    <input type="number" min="1" class="w-16 border rounded text-center py-1 cart-qty-input" data-index="${index}" value="${item.quantity}">
                </div>
            </td>
            <td class="p-2 text-right">
                <div class="flex items-center justify-end">
                    <span class="mr-1 text-gray-400">₱</span>
                    <input type="number" step="0.01" min="0" class="w-24 border rounded text-right py-1 cart-price-input ${item.is_price_active ? 'text-gray-900 font-bold' : 'text-gray-400'}" data-index="${index}" value="${(item.selling_price || 0).toFixed(2)}">
                </div>
            </td>
            <td class="p-2 text-right">
                <div class="flex items-center justify-end">
                    <span class="mr-1 text-gray-400">₱</span>
                    <input type="number" step="0.01" min="0" class="w-24 border rounded text-right py-1 cart-cost-input" data-index="${index}" value="${item.cost_price.toFixed(2)}">
                </div>
            </td>
            <td class="p-2 text-right font-medium">₱${subtotal.toFixed(2)}</td>
            <td class="p-2 text-right">
                <button class="text-red-500 hover:text-red-700 remove-item-btn" data-item-id="${item.id}" title="Remove Item">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 pointer-events-none" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd" /></svg>
                </button>
            </td>
        </tr >
        `}).join('');

    cartContainer.innerHTML = `
        < table class="w-full text-sm" >
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
        </table >
        `;
}

function removeFromCart(itemId) {
    stockInCart = stockInCart.filter(item => item.id !== itemId);
    renderStockInCart();
}

function updateCartQty(index, newQty) {
    if (isNaN(newQty) || newQty < 1) {
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

        alert(`Stock - ${isOut ? 'out' : 'in'} successful! Data is saved locally and will sync with the server.`);

        stockInCart = [];
        renderStockInCart();
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
        < div class="overflow-x-auto" >
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
                </tbody >
            </table >
            </div >
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

    // Fallback for missing items (e.g. lost during sync)
    if (!entry.items || !Array.isArray(entry.items) || entry.items.length === 0) {
        try {
            // Attempt to find movements with the same timestamp
            // Note: This relies on timestamp uniqueness.
            const movements = await Repository.query('stock_movements', {
                where: { timestamp: entry.timestamp }
            });

            if (movements && movements.length > 0) {
                entry.items = movements.map(m => ({
                    name: m.item_name,
                    quantity: Math.abs(m.qty),
                    // We might not have cost/price in movement, so we leave it or fetch item
                }));
            }
        } catch (e) {
            console.warn("Failed to recover items from movements", e);
        }
    }
}
// ... (existing showStockInDetails logic continued if any, but since it was truncated in view, I will wrap up here)

// --- Mobile Scanner Logic ---

function setupMobileScannerListeners() {
    const btnOpen = document.getElementById('btn-open-mobile-scan');
    const btnClose = document.getElementById('btn-close-stock-camera');
    const btnFlash = document.getElementById('btn-toggle-stock-flash');

    btnOpen?.addEventListener('click', startStockCamera);
    btnClose?.addEventListener('click', stopStockCamera);
    btnFlash?.addEventListener('click', toggleStockFlash);
}

async function startStockCamera() {
    if (isCameraRunning) return;
    const scannerUI = document.getElementById('stock-mobile-scanner');
    const video = document.getElementById('stock-mobile-video');
    const btnFlash = document.getElementById('btn-toggle-stock-flash');

    try {
        if ('BarcodeDetector' in window) {
            barcodeDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'] });
        } else {
            console.warn("BarcodeDetector not supported");
        }

        mobileStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }
        });

        video.srcObject = mobileStream;
        scannerUI.classList.remove('hidden');
        isCameraRunning = true;
        scanDebounce = false;
        requestAnimationFrame(scanStockLoop);

        // Flash check
        const track = mobileStream.getVideoTracks()[0];
        if (track && track.getCapabilities && track.getCapabilities().torch) {
            btnFlash.classList.remove('hidden');
        }

    } catch (err) {
        console.error("Camera start failed:", err);
        alert("Could not access camera.");
    }
}

function stopStockCamera() {
    if (mobileStream) {
        mobileStream.getTracks().forEach(track => track.stop());
        mobileStream = null;
    }
    isCameraRunning = false;
    document.getElementById('stock-mobile-scanner').classList.add('hidden');
    document.getElementById('btn-toggle-stock-flash').classList.add('hidden');
}

async function toggleStockFlash() {
    if (mobileStream) {
        const track = mobileStream.getVideoTracks()[0];
        const btn = document.getElementById('btn-toggle-stock-flash');
        try {
            const current = track.getSettings().torch;
            await track.applyConstraints({ advanced: [{ torch: !current }] });
            if (!current) {
                btn.classList.remove("text-white");
                btn.classList.add("text-yellow-400");
            } else {
                btn.classList.add("text-white");
                btn.classList.remove("text-yellow-400");
            }
        } catch (e) {
            console.warn("Flash toggle failed", e);
        }
    }
}

async function scanStockLoop() {
    if (!isCameraRunning) return;
    const video = document.getElementById('stock-mobile-video');

    if (barcodeDetector && !scanDebounce && video.readyState === video.HAVE_ENOUGH_DATA) {
        try {
            const barcodes = await barcodeDetector.detect(video);
            if (barcodes.length > 0) {
                await handleStockScannedCode(barcodes[0].rawValue);
            }
        } catch (e) { }
    }

    if (isCameraRunning) requestAnimationFrame(scanStockLoop);
}

async function handleStockScannedCode(code) {
    if (scanDebounce) return;
    scanDebounce = true;

    const item = allItems.find(i => i.barcode === code);

    const feedback = document.getElementById('last-scanned-msg');
    const successOverlay = document.getElementById('stock-scan-success');

    if (item) {
        addToCart(item, 1);

        // Visual Feedback
        if (successOverlay) {
            successOverlay.classList.remove("opacity-0");
        }
        if (feedback) feedback.textContent = `Added: ${item.name} `;

        // Beep if possible (reusing from other modules if available or simple web audio)
        // For now simple visual is enough or we can add AudioContext later

        await new Promise(r => setTimeout(r, 600)); // Pause

        if (successOverlay) {
            successOverlay.classList.add("opacity-0");
        }

    } else {
        if (feedback) {
            feedback.textContent = `Unknown Item: ${code} `;
            feedback.classList.remove('text-green-600');
            feedback.classList.add('text-red-500');
        }
        await new Promise(r => setTimeout(r, 1000));
        if (feedback) {
            feedback.textContent = "";
            feedback.classList.add('text-green-600');
            feedback.classList.remove('text-red-500');
        }
    }

    scanDebounce = false;
}


let modal = document.getElementById('stockin-details-modal');
if (!modal) {
    modal = document.createElement('div');
    modal.id = 'stockin-details-modal';
    modal.className = 'fixed inset-0 bg-gray-600 bg-opacity-50 hidden flex items-center justify-center z-50';
    document.body.appendChild(modal);
}

const itemRows = (entry.items || []).map(item => {
    const qty = item.quantity || item.qty || 0;
    const cost = item.cost_price || 0;
    const isOut = entry.type === 'out';
    return `
        < tr class="border-b" >
            <td class="p-2">${item.name}</td>
            <td class="p-2 text-center font-bold ${isOut ? 'text-red-600' : 'text-green-600'}">${isOut ? '-' : '+'}${qty}</td>
            <td class="p-2 text-right">₱${cost.toFixed(2)}</td>
            <td class="p-2 text-right">₱${(qty * cost).toFixed(2)}</td>
        </tr >
        `;
}).join('');

modal.innerHTML = `
        < div class="bg-white rounded-lg shadow-lg p-6 w-full max-w-2xl mx-4" >
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
        : ''
    }
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
        </div >
        `;

modal.classList.remove('hidden');
modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => modal.classList.add('hidden'));
});
}