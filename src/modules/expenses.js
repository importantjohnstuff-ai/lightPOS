import { checkPermission } from "../auth.js";
import { generateUUID } from "../utils.js";
import { dbRepository as Repository } from "../db.js";
import { SyncEngine } from "../services/SyncEngine.js";
import { showToast } from "../utils.js";
import { warpPerspective, canvasToBlob, loadImageFromFile, scaleImage } from "../utils/PerspectiveWarp.js";
import { ReceiptImageStore } from "../services/ReceiptImageStore.js";

let suppliersList = [];
// Receipt state — reset on each modal open
let _receiptBlob = null;       // The cropped JPEG Blob ready to save
let _receiptSourceImg = null;  // The raw uploaded Image element (for crop modal)
let _receiptCorners = null;    // 4 corner points [{x,y},...]

export async function loadExpensesView() {
    const content = document.getElementById("main-content");
    const canWrite = checkPermission("expenses", "write");

    content.innerHTML = `
        <div class="max-w-6xl mx-auto h-[calc(100vh-120px)] flex flex-col p-4">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4 shrink-0">
                <h2 class="text-2xl font-bold text-gray-800">Expense Management</h2>
                <div class="flex flex-wrap gap-2 items-center">
                    <div class="bg-red-50 border border-red-200 px-4 py-2 rounded shadow-sm text-center min-w-[150px]">
                        <div class="text-[10px] uppercase font-bold text-red-400">Total for Period</div>
                        <div id="expenses-total-display" class="text-xl font-black text-red-600">₱0.00</div>
                    </div>
                    <button id="btn-add-expense" class="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-6 rounded-lg shadow-md transition duration-150 ${canWrite ? '' : 'hidden'} h-[48px]">
                        + Record Expense
                    </button>
                </div>
            </div>
            
            <!-- Quick Sum Floating Widget -->
            <div id="quick-sum-widget" class="fixed bottom-8 left-1/2 transform -translate-x-1/2 bg-gray-900 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-6 z-50 transition-all duration-300 translate-y-20 opacity-0 pointer-events-none">
                <div class="flex flex-col">
                    <span class="text-[10px] uppercase font-bold text-gray-400 tracking-wider" id="qs-count">0 ITEMS</span>
                    <span class="text-xl font-bold text-white tracking-tight" id="qs-total">₱0.00</span>
                </div>
                <div class="h-8 w-px bg-gray-700"></div>
                <button id="btn-clear-selection" class="text-gray-400 hover:text-white transition-colors text-sm font-bold flex items-center gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
                    Clear
                </button>
            </div>

            <!-- Filters Toolbar -->
            <div class="bg-white p-4 rounded-t-lg border border-b-0 shadow-sm flex flex-wrap gap-4 items-end shrink-0">
                <div class="flex-1 min-w-[200px]">
                    <label class="block text-[10px] font-bold text-gray-400 uppercase mb-1">Search Description/Category</label>
                    <div class="relative">
                        <input type="text" id="exp-search" placeholder="Search..." class="w-full pl-8 pr-3 py-2 border rounded-md text-sm focus:ring-2 focus:ring-red-500 outline-none">
                        <svg class="w-4 h-4 absolute left-2.5 top-2.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                    </div>
                </div>
                <div>
                    <label class="block text-[10px] font-bold text-gray-400 uppercase mb-1">From</label>
                    <input type="date" id="exp-filter-start" class="border rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-red-500 outline-none">
                </div>
                <div>
                    <label class="block text-[10px] font-bold text-gray-400 uppercase mb-1">To</label>
                    <input type="date" id="exp-filter-end" class="border rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-red-500 outline-none">
                </div>
                <button id="btn-clear-filters" class="text-xs text-gray-500 hover:text-red-500 font-bold mb-2">Clear</button>
                <button id="btn-export-expenses" class="flex items-center gap-1.5 px-4 py-2 border border-green-600 text-green-600 rounded-lg hover:bg-green-50 transition text-xs font-bold shadow-sm">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                    Export CSV
                </button>
            </div>

            <!-- Expenses Table -->
            <div class="bg-white shadow-md rounded-b-lg overflow-hidden flex-1 flex flex-col border">
                <div class="overflow-y-auto flex-1 h-full">
                    <table class="min-w-full table-auto">
                        <thead class="sticky top-0 bg-gray-100 shadow-sm z-10">
                            <tr class="text-gray-600 uppercase text-xs font-bold leading-normal">
                                <th class="py-3 px-6 text-center w-10">
                                    <input type="checkbox" id="select-all-expenses" class="form-checkbox h-4 w-4 text-red-600 rounded border-gray-300 focus:ring-red-500 cursor-pointer">
                                </th>
                                <th class="py-3 px-6 text-left">Date</th>
                                <th class="py-3 px-6 text-left">Description</th>
                                <th class="py-3 px-6 text-left">Category</th>
                                <th class="py-3 px-6 text-left">Supplier</th>
                                <th class="py-3 px-6 text-left">Invoice No.</th>
                                <th class="py-3 px-6 text-right">Amount</th>
                                <th class="py-3 px-6 text-left">User</th>
                                <th class="py-3 px-6 text-center">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="expenses-table-body" class="text-gray-600 text-sm font-light divide-y divide-gray-100">
                            <tr><td colspan="9" class="py-10 text-center text-gray-400">Loading expenses...</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <!-- Add/Edit Expense Modal -->
        <div id="modal-add-expense" class="fixed inset-0 bg-gray-900 bg-opacity-50 hidden overflow-y-auto h-full w-full z-50 flex items-center justify-center">
            <div class="relative mx-auto p-6 border w-96 shadow-2xl rounded-xl bg-white scale-in">
                <h3 id="expense-modal-title" class="text-xl font-black text-gray-800 text-center mb-6">Record Expense</h3>
                <form id="form-add-expense">
                    <input type="hidden" id="exp-id">
                    <div class="mb-4">
                        <label class="block text-gray-700 text-xs font-bold uppercase mb-1">Description</label>
                        <input type="text" id="exp-desc" class="w-full border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-red-500 outline-none" placeholder="e.g. Electricity Bill" required>
                    </div>
                    <div class="mb-4">
                        <label class="block text-gray-700 text-xs font-bold uppercase mb-1">Amount (PHP)</label>
                        <input type="number" step="0.01" id="exp-amount" class="w-full border rounded-lg py-2 px-3 text-lg font-bold focus:ring-2 focus:ring-red-500 outline-none no-spinner" placeholder="0.00" required onwheel="this.blur()">
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div class="mb-4">
                            <label class="block text-gray-700 text-xs font-bold uppercase mb-1">Category</label>
                            <select id="exp-category" class="w-full border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-red-500 outline-none">
                                <option value="Procurement">Procurement</option>
                                <option value="Utilities">Utilities</option>
                                <option value="Rent">Rent</option>
                                <option value="Salary">Salary</option>
                                <option value="Maintenance">Maintenance</option>
                                <option value="Karinderya">Karinderya</option>
                                <option value="CHMSU">CHMSU</option>
                                <option value="Other">Other</option>
                            </select>
                        </div>
                        <div class="mb-4">
                            <label class="block text-gray-700 text-xs font-bold uppercase mb-1">Date</label>
                            <input type="date" id="exp-date" class="w-full border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-red-500 outline-none" required>
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-4 mb-6">
                        <div>
                            <label class="block text-gray-700 text-xs font-bold uppercase mb-1">Supplier (Optional)</label>
                            <select id="exp-supplier" class="w-full border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-red-500 outline-none">
                                <option value="">None</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-gray-700 text-xs font-bold uppercase mb-1">Sales Invoice No.</label>
                            <input type="text" id="exp-invoice-no" class="w-full border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-red-500 outline-none" placeholder="e.g. 00123">
                        </div>
                    </div>

                    <div class="mb-6 border border-red-200 bg-red-50 p-4 rounded-lg">
                        <label class="block text-red-700 text-xs font-bold uppercase mb-1">Has this been Stocked In?</label>
                        <select id="exp-stocked-in" class="w-full border border-red-300 rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-red-500 outline-none bg-white">
                            <option value="No">No</option>
                            <option value="Yes">Yes</option>
                        </select>
                        <p class="text-[10px] text-red-500 mt-1 font-medium">Expenses must be stocked in before recording.</p>
                    </div>

                    <!-- Receipt Attachment -->
                    <div class="mb-6">
                        <label class="block text-gray-700 text-xs font-bold uppercase mb-2">📎 Receipt Image (Optional)</label>
                        <div id="receipt-preview-area" class="hidden mb-2 relative group">
                            <img id="receipt-thumbnail" src="" alt="Receipt" class="w-full h-32 object-cover rounded-lg border border-gray-200 cursor-pointer" title="Click to view full size">
                            <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all rounded-lg flex items-center justify-center">
                                <span class="text-white opacity-0 group-hover:opacity-100 font-bold text-xs transition-all">Click to view</span>
                            </div>
                            <button type="button" id="btn-remove-receipt" class="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold shadow hover:bg-red-600 transition">✕</button>
                        </div>
                        <div id="receipt-upload-area" class="flex gap-2">
                            <label class="flex-1 cursor-pointer">
                                <div class="border-2 border-dashed border-gray-300 rounded-lg py-3 px-4 text-center hover:border-red-400 hover:bg-red-50 transition-all">
                                    <svg class="w-6 h-6 mx-auto text-gray-400 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                                    <span class="text-xs text-gray-500 font-medium">Upload / Capture Receipt</span>
                                </div>
                                <input type="file" id="receipt-file-input" accept="image/*" capture="environment" class="hidden">
                            </label>
                        </div>
                    </div>
                    
                    <div class="flex items-center gap-2 pt-2">
                        <button type="button" id="btn-cancel-expense" class="w-1/3 bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold py-2 rounded-lg transition duration-150">Cancel</button>
                        <button type="submit" class="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-2 rounded-lg shadow-md transition duration-150">Save Expense</button>
                    </div>
                </form>
            </div>
        </div>

        <!-- Perspective Crop Modal -->
        <div id="modal-receipt-crop" class="fixed inset-0 bg-black bg-opacity-90 hidden z-[60] flex flex-col">
            <div class="flex items-center justify-between p-4 text-white shrink-0">
                <h3 class="text-lg font-bold">📐 Adjust Corners</h3>
                <div class="flex gap-2">
                    <button id="btn-reset-corners" class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs font-bold transition">Reset</button>
                    <button id="btn-cancel-crop" class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded text-xs font-bold transition">Cancel</button>
                    <button id="btn-apply-crop" class="px-4 py-1.5 bg-green-600 hover:bg-green-500 rounded text-xs font-bold transition">✓ Apply Crop</button>
                </div>
            </div>
            <div id="crop-canvas-container" class="flex-1 relative overflow-hidden flex items-center justify-center">
                <canvas id="crop-canvas" class="max-w-full max-h-full"></canvas>
                <!-- Corner handles are appended dynamically -->
            </div>
            <div class="p-3 text-center text-gray-400 text-xs shrink-0">Drag the 4 corners to match the receipt edges, then tap Apply</div>
        </div>

        <!-- Receipt Viewer Lightbox -->
        <div id="modal-receipt-viewer" class="fixed inset-0 bg-black bg-opacity-90 hidden z-[60] flex flex-col items-center justify-center">
            <div class="absolute top-4 right-4 flex gap-2 z-10">
                <button id="btn-download-receipt" class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs font-bold transition">⬇ Download</button>
                <button id="btn-close-viewer" class="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded text-xs font-bold transition">✕ Close</button>
            </div>
            <img id="receipt-viewer-img" src="" alt="Receipt" class="max-w-[90vw] max-h-[85vh] object-contain rounded shadow-2xl">
        </div>
    `;

    // Set default filter date (Today)
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    document.getElementById("exp-filter-start").value = today;
    document.getElementById("exp-filter-end").value = today;
    document.getElementById("exp-date").value = today;

    // Event Listeners
    const modal = document.getElementById("modal-add-expense");
    if (canWrite) {
        document.getElementById("btn-add-expense").addEventListener("click", () => {
            document.getElementById("expense-modal-title").textContent = "Record Expense";
            document.getElementById("exp-id").value = "";
            document.getElementById("form-add-expense").reset();
            document.getElementById("exp-date").value = today;
            document.getElementById("exp-stocked-in").value = "No";
            resetReceiptState();

            const pendingDataStr = localStorage.getItem('pending_expense');
            if (pendingDataStr) {
                try {
                    const pendingData = JSON.parse(pendingDataStr);
                    document.getElementById("exp-desc").value = pendingData.description || "";
                    document.getElementById("exp-amount").value = pendingData.amount || "";
                    document.getElementById("exp-category").value = pendingData.category || "Procurement";
                    setTimeout(() => {
                        document.getElementById("exp-supplier").value = pendingData.supplier_id || "";
                    }, 100);
                    document.getElementById("exp-invoice-no").value = pendingData.invoice_number || "";
                    document.getElementById("exp-date").value = pendingData.date || today;
                    localStorage.removeItem('pending_expense');
                } catch (e) { }
            }

            modal.classList.remove("hidden");
        });
    }

    document.getElementById("btn-cancel-expense").addEventListener("click", () => modal.classList.add("hidden"));

    document.getElementById("form-add-expense").addEventListener("submit", async (e) => {
        e.preventDefault();
        await saveExpense();
    });

    // Filtering Listeners
    document.getElementById("exp-search").addEventListener("input", fetchExpenses);
    document.getElementById("exp-filter-start").addEventListener("change", fetchExpenses);
    document.getElementById("exp-filter-end").addEventListener("change", fetchExpenses);
    document.getElementById("btn-clear-filters").addEventListener("click", () => {
        document.getElementById("exp-search").value = "";
        document.getElementById("exp-filter-start").value = today;
        document.getElementById("exp-filter-end").value = today;
        fetchExpenses();
    });

    // Export CSV Listener
    document.getElementById("btn-export-expenses").addEventListener("click", async () => {
        await exportExpensesCSV();
    });

    // Quick Sum Listeners
    document.getElementById("btn-clear-selection").addEventListener("click", () => {
        document.querySelectorAll(".expense-checkbox").forEach(cb => cb.checked = false);
        document.getElementById("select-all-expenses").checked = false;
        updateQuickSum();
    });

    // Handle Select All
    document.getElementById("select-all-expenses").addEventListener("change", (e) => {
        const isChecked = e.target.checked;
        document.querySelectorAll(".expense-checkbox").forEach(cb => cb.checked = isChecked);
        updateQuickSum();
    });

    // --- Receipt Event Listeners ---
    setupReceiptListeners();

    await Promise.all([fetchSuppliers(), fetchExpenses()]);
}

async function fetchSuppliers() {
    try {
        suppliersList = await Repository.getAll('suppliers');
        suppliersList.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

        const select = document.getElementById("exp-supplier");
        select.innerHTML = '<option value="">None</option>';

        suppliersList.forEach(sup => {
            const option = document.createElement("option");
            option.value = sup.id;
            option.textContent = sup.name;
            select.appendChild(option);
        });
    } catch (error) {
        console.error("Error loading suppliers:", error);
    }
}

async function saveExpense() {
    const id = document.getElementById("exp-id").value;
    const desc = document.getElementById("exp-desc").value;
    const amount = parseFloat(document.getElementById("exp-amount").value);
    const category = document.getElementById("exp-category").value;
    const supplierId = document.getElementById("exp-supplier").value;
    const invoiceNo = document.getElementById("exp-invoice-no").value;
    const dateVal = document.getElementById("exp-date").value;
    const stockedIn = document.getElementById("exp-stocked-in").value;

    if (stockedIn === "No") {
        const pendingData = {
            description: desc,
            amount: amount,
            category: category,
            supplier_id: supplierId,
            invoice_number: invoiceNo,
            date: dateVal
        };
        localStorage.setItem('pending_expense', JSON.stringify(pendingData));

        document.getElementById("modal-add-expense").classList.add("hidden");
        window.location.hash = "#stockin";
        setTimeout(() => showToast("Please Stock In all Expenses", "error"), 500);
        return;
    }

    const supplierName = supplierId ? suppliersList.find(s => s.id === supplierId)?.name : null;
    const user = JSON.parse(localStorage.getItem('pos_user'))?.email || "Unknown";

    const expenseData = {
        id: id || generateUUID(),
        description: desc,
        amount: amount,
        category: category,
        supplier_id: supplierId,
        supplier_name: supplierName,
        invoice_number: invoiceNo,
        date: dateVal,
        user_id: user,
        has_receipt: !!_receiptBlob,
        _updatedAt: Date.now()
    };

    if (!id) {
        expenseData.created_at = new Date();
    }

    try {
        await Repository.upsert('expenses', expenseData);

        // Save receipt image (if any) to the separated image store
        if (_receiptBlob) {
            await ReceiptImageStore.saveReceiptImage(expenseData.id, _receiptBlob);
        }

        SyncEngine.sync();

        document.getElementById("modal-add-expense").classList.add("hidden");
        document.getElementById("form-add-expense").reset();
        resetReceiptState();

        fetchExpenses();
    } catch (error) {
        console.error("Error saving expense:", error);
        alert("Failed to save expense.");
    }
}

async function fetchExpenses() {
    const tbody = document.getElementById("expenses-table-body");
    const totalDisplay = document.getElementById("expenses-total-display");
    const canWrite = checkPermission("expenses", "write");

    const searchTerm = document.getElementById("exp-search")?.value.toLowerCase() || "";
    const startDate = document.getElementById("exp-filter-start")?.value || "";
    const endDate = document.getElementById("exp-filter-end")?.value || "";

    try {
        let expenses = await Repository.getAll('expenses');

        // Apply Filters
        expenses = expenses.filter(exp => {
            const matchesSearch = exp.description.toLowerCase().includes(searchTerm) ||
                exp.category.toLowerCase().includes(searchTerm) ||
                (exp.supplier_name && exp.supplier_name.toLowerCase().includes(searchTerm)) ||
                (exp.invoice_number && exp.invoice_number.toLowerCase().includes(searchTerm));

            const expDate = exp.date; // YYYY-MM-DD
            const matchesStart = !startDate || expDate >= startDate;
            const matchesEnd = !endDate || expDate <= endDate;

            return matchesSearch && matchesStart && matchesEnd;
        });

        // Sort by date desc
        expenses.sort((a, b) => b.date.localeCompare(a.date) || (b._updatedAt || 0) - (a._updatedAt || 0));

        // Calculate Total
        const totalAmount = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
        if (totalDisplay) totalDisplay.textContent = `₱${totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        tbody.innerHTML = "";

        if (expenses.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" class="py-10 text-center text-gray-400 italic">No expenses match your filters.</td></tr>`;
            return;
        }

        expenses.forEach(data => {
            const dateStr = data.date;

            const row = document.createElement("tr");
            row.className = "border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer"; // Added cursor-pointer

            // Allow clicking row to toggle checkbox (except on buttons)
            row.addEventListener('click', (e) => {
                if (e.target.closest('button') || e.target.closest('input[type="checkbox"]')) return;
                const cb = row.querySelector('.expense-checkbox');
                cb.checked = !cb.checked;
                updateQuickSum();
            });

            row.innerHTML = `
                <td class="py-3 px-6 text-center">
                     <input type="checkbox" class="expense-checkbox form-checkbox h-4 w-4 text-red-600 rounded border-gray-300 focus:ring-red-500 cursor-pointer" data-amount="${data.amount}">
                </td>
                <td class="py-3 px-6 text-left whitespace-nowrap font-mono text-xs">${dateStr}</td>
                <td class="py-3 px-6 text-left font-medium text-gray-800">${data.description}</td>
                <td class="py-3 px-6 text-left"><span class="bg-gray-100 text-gray-600 py-1 px-3 rounded-full text-[10px] font-bold uppercase tracking-wider">${data.category}</span></td>
                <td class="py-3 px-6 text-left text-xs">${data.supplier_name || '-'}</td>
                <td class="py-3 px-6 text-left text-xs font-mono text-gray-500">${data.invoice_number || '-'}</td>
                <td class="py-3 px-6 text-right font-black text-red-600">₱${data.amount.toFixed(2)}</td>
                <td class="py-3 px-6 text-left text-[10px] text-gray-500">${data.user_id}</td>
                <td class="py-3 px-6 text-center">
                    <div class="flex items-center justify-center gap-2">
                        <button class="view-receipt-btn text-gray-400 hover:text-amber-600 transition ${data.has_receipt ? '' : 'hidden'}" data-id="${data.id}" title="View Receipt">
                            📎
                        </button>
                        <button class="text-blue-500 hover:text-blue-700 edit-btn transition ${canWrite ? '' : 'hidden'}" data-id="${data.id}">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        </button>
                        <button class="text-red-400 hover:text-red-600 delete-btn transition ${canWrite ? '' : 'hidden'}" data-id="${data.id}">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                    </div>
                </td>
            `;

            row.querySelector(".edit-btn").addEventListener("click", async () => {
                document.getElementById("expense-modal-title").textContent = "Edit Expense";
                document.getElementById("exp-id").value = data.id;
                document.getElementById("exp-desc").value = data.description;
                document.getElementById("exp-amount").value = data.amount;
                document.getElementById("exp-category").value = data.category;
                document.getElementById("exp-supplier").value = data.supplier_id || "";
                document.getElementById("exp-invoice-no").value = data.invoice_number || "";
                document.getElementById("exp-date").value = data.date;
                document.getElementById("exp-stocked-in").value = "Yes";
                // Load existing receipt if any
                resetReceiptState();
                if (data.has_receipt) {
                    await loadExistingReceipt(data.id);
                }
                document.getElementById("modal-add-expense").classList.remove("hidden");
            });

            // View receipt button in table row
            const viewReceiptBtn = row.querySelector(".view-receipt-btn");
            if (viewReceiptBtn) {
                viewReceiptBtn.addEventListener("click", async (e) => {
                    e.stopPropagation();
                    await showReceiptViewer(data.id);
                });
            }

            row.querySelector(".delete-btn").addEventListener("click", async () => {
                if (confirm("Delete this expense record?")) {
                    await Repository.remove('expenses', data.id);
                    // Also delete receipt if exists
                    if (data.has_receipt) {
                        await ReceiptImageStore.deleteReceiptImage(data.id);
                    }
                    SyncEngine.sync();
                    fetchExpenses();
                }
            });


            // Individual checkbox listener
            row.querySelector(".expense-checkbox").addEventListener("change", updateQuickSum);

            tbody.appendChild(row);
        });

        // Reset select all
        document.getElementById("select-all-expenses").checked = false;
        updateQuickSum(); // Reset widget on reload

    } catch (error) {
        console.error("Error fetching expenses:", error);
        tbody.innerHTML = `<tr><td colspan="9" class="py-10 text-center text-red-500 font-bold">Error loading expense data.</td></tr>`;
    }
}

function updateQuickSum() {
    const checkboxes = document.querySelectorAll('.expense-checkbox:checked');
    const widget = document.getElementById("quick-sum-widget");
    const countDisplay = document.getElementById("qs-count");
    const totalDisplay = document.getElementById("qs-total");

    if (checkboxes.length > 0) {
        let total = 0;
        checkboxes.forEach(cb => {
            total += parseFloat(cb.dataset.amount || 0);
        });

        countDisplay.textContent = `${checkboxes.length} ITEM${checkboxes.length > 1 ? 'S' : ''}`;
        totalDisplay.textContent = `₱${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        // Show widget
        widget.classList.remove("translate-y-20", "opacity-0", "pointer-events-none");
    } else {
        // Hide widget
        widget.classList.add("translate-y-20", "opacity-0", "pointer-events-none");
    }

    // Update Select All Checkbox state
    const allCheckboxes = document.querySelectorAll('.expense-checkbox');
    const selectAll = document.getElementById("select-all-expenses");
    if (allCheckboxes.length > 0 && checkboxes.length === allCheckboxes.length) {
        selectAll.checked = true;
        selectAll.indeterminate = false;
    } else if (checkboxes.length > 0) {
        selectAll.checked = false;
        selectAll.indeterminate = true;
    } else {
        selectAll.checked = false;
        selectAll.indeterminate = false;
    }
}

async function exportExpensesCSV() {
    const searchTerm = document.getElementById("exp-search")?.value.toLowerCase() || "";
    const startDate = document.getElementById("exp-filter-start")?.value || "";
    const endDate = document.getElementById("exp-filter-end")?.value || "";

    try {
        let expenses = await Repository.getAll('expenses');

        // Apply same filters as the table view
        expenses = expenses.filter(exp => {
            const matchesSearch = exp.description.toLowerCase().includes(searchTerm) ||
                exp.category.toLowerCase().includes(searchTerm) ||
                (exp.supplier_name && exp.supplier_name.toLowerCase().includes(searchTerm)) ||
                (exp.invoice_number && exp.invoice_number.toLowerCase().includes(searchTerm));

            const expDate = exp.date;
            const matchesStart = !startDate || expDate >= startDate;
            const matchesEnd = !endDate || expDate <= endDate;

            return matchesSearch && matchesStart && matchesEnd;
        });

        // Sort by date desc
        expenses.sort((a, b) => b.date.localeCompare(a.date) || (b._updatedAt || 0) - (a._updatedAt || 0));

        if (expenses.length === 0) {
            showToast("No expenses to export", "error");
            return;
        }

        const headers = ["Date", "Description", "Category", "Supplier", "Invoice No.", "Amount", "Recorded By"];
        const rows = expenses.map(exp => [
            `"${exp.date}"`,
            `"${(exp.description || '').replace(/"/g, '""')}"`,
            `"${exp.category || ''}"`,
            `"${(exp.supplier_name || '').replace(/"/g, '""')}"`,
            `"${exp.invoice_number || ''}"`,
            (exp.amount || 0).toFixed(2),
            `"${exp.user_id || ''}"`
        ]);

        // Add total row
        const totalAmount = expenses.reduce((sum, exp) => sum + (exp.amount || 0), 0);
        rows.push([`""`, `"TOTAL"`, `""`, `""`, `""`, totalAmount.toFixed(2), `""`]);

        const csvContent = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");

        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);

        const dateLabel = startDate && endDate ? `${startDate}_to_${endDate}` : new Date().toISOString().split('T')[0];
        link.setAttribute("download", `expenses_${dateLabel}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        showToast(`Exported ${expenses.length} expense(s) to CSV`, "success");
    } catch (error) {
        console.error("Error exporting expenses:", error);
        showToast("Failed to export expenses", "error");
    }
}

// ─────────────────────────────────────────────────────────
// Receipt Helper Functions
// ─────────────────────────────────────────────────────────

function resetReceiptState() {
    _receiptBlob = null;
    _receiptSourceImg = null;
    _receiptCorners = null;
    const previewArea = document.getElementById("receipt-preview-area");
    const uploadArea = document.getElementById("receipt-upload-area");
    const fileInput = document.getElementById("receipt-file-input");
    if (previewArea) previewArea.classList.add("hidden");
    if (uploadArea) uploadArea.classList.remove("hidden");
    if (fileInput) fileInput.value = "";
}

function updateReceiptPreview(blob) {
    const previewArea = document.getElementById("receipt-preview-area");
    const uploadArea = document.getElementById("receipt-upload-area");
    const thumbnail = document.getElementById("receipt-thumbnail");
    if (!previewArea || !thumbnail) return;

    const url = URL.createObjectURL(blob);
    thumbnail.onload = () => URL.revokeObjectURL(url);
    thumbnail.src = url;
    previewArea.classList.remove("hidden");
    uploadArea.classList.add("hidden");
}

async function loadExistingReceipt(expenseId) {
    let blob = await ReceiptImageStore.getReceiptImage(expenseId);
    if (!blob) {
        blob = await ReceiptImageStore.fetchFromServer(expenseId);
    }
    if (blob) {
        _receiptBlob = blob;
        updateReceiptPreview(blob);
    }
}

async function showReceiptViewer(expenseId) {
    const viewer = document.getElementById("modal-receipt-viewer");
    const viewerImg = document.getElementById("receipt-viewer-img");
    if (!viewer || !viewerImg) return;

    viewerImg.src = "";
    viewer.classList.remove("hidden");

    let blob = await ReceiptImageStore.getReceiptImage(expenseId);
    if (!blob) {
        blob = await ReceiptImageStore.fetchFromServer(expenseId);
    }
    if (blob) {
        const url = URL.createObjectURL(blob);
        viewerImg.onload = () => URL.revokeObjectURL(url);
        viewerImg.src = url;
        // Store for download
        viewer.dataset.currentBlob = url;
        viewer.dataset.currentExpenseId = expenseId;
    } else {
        viewer.classList.add("hidden");
        showToast("Receipt image not found", "error");
    }
}

function setupReceiptListeners() {
    // File input handler — opens crop modal after image selection
    const fileInput = document.getElementById("receipt-file-input");
    if (fileInput) {
        fileInput.addEventListener("change", async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const img = await loadImageFromFile(file);
                const scaledCanvas = scaleImage(img, 1200);
                _receiptSourceImg = scaledCanvas;
                openCropModal(scaledCanvas);
            } catch (err) {
                console.error("Failed to load image:", err);
                showToast("Failed to load image", "error");
            }
        });
    }

    // Remove receipt button
    const removeBtn = document.getElementById("btn-remove-receipt");
    if (removeBtn) {
        removeBtn.addEventListener("click", () => {
            resetReceiptState();
        });
    }

    // Thumbnail click → open viewer with current blob
    const thumbnail = document.getElementById("receipt-thumbnail");
    if (thumbnail) {
        thumbnail.addEventListener("click", () => {
            if (_receiptBlob) {
                const viewer = document.getElementById("modal-receipt-viewer");
                const viewerImg = document.getElementById("receipt-viewer-img");
                const url = URL.createObjectURL(_receiptBlob);
                viewerImg.onload = () => URL.revokeObjectURL(url);
                viewerImg.src = url;
                viewer.classList.remove("hidden");
            }
        });
    }

    // --- Crop Modal Controls ---
    const cropModal = document.getElementById("modal-receipt-crop");
    
    document.getElementById("btn-cancel-crop")?.addEventListener("click", () => {
        cropModal.classList.add("hidden");
        removeCropHandles();
    });

    document.getElementById("btn-reset-corners")?.addEventListener("click", () => {
        if (_receiptSourceImg) {
            const w = _receiptSourceImg.width;
            const h = _receiptSourceImg.height;
            const margin = 0.1;
            _receiptCorners = [
                { x: w * margin, y: h * margin },
                { x: w * (1 - margin), y: h * margin },
                { x: w * (1 - margin), y: h * (1 - margin) },
                { x: w * margin, y: h * (1 - margin) }
            ];
            drawCropOverlay();
        }
    });

    document.getElementById("btn-apply-crop")?.addEventListener("click", async () => {
        if (!_receiptSourceImg || !_receiptCorners) return;
        try {
            // Scale corners from display coordinates to source coordinates
            const canvas = document.getElementById("crop-canvas");
            const scaleX = _receiptSourceImg.width / canvas.width;
            const scaleY = _receiptSourceImg.height / canvas.height;
            const srcCorners = _receiptCorners.map(c => ({
                x: c.x * scaleX,
                y: c.y * scaleY
            }));

            const warpedCanvas = warpPerspective(_receiptSourceImg, srcCorners);
            _receiptBlob = await canvasToBlob(warpedCanvas, 0.75);
            updateReceiptPreview(_receiptBlob);
            cropModal.classList.add("hidden");
            removeCropHandles();
            showToast("Receipt cropped successfully", "success");
        } catch (err) {
            console.error("Perspective warp failed:", err);
            showToast("Crop failed: " + err.message, "error");
        }
    });

    // --- Viewer Lightbox Controls ---
    document.getElementById("btn-close-viewer")?.addEventListener("click", () => {
        document.getElementById("modal-receipt-viewer").classList.add("hidden");
    });

    document.getElementById("btn-download-receipt")?.addEventListener("click", () => {
        const viewerImg = document.getElementById("receipt-viewer-img");
        if (viewerImg.src) {
            const a = document.createElement("a");
            a.href = viewerImg.src;
            a.download = "receipt.jpg";
            a.click();
        }
    });
}

// ─────────────────────────────────────────────────────────
// Crop Modal Logic
// ─────────────────────────────────────────────────────────

function openCropModal(sourceCanvas) {
    const cropModal = document.getElementById("modal-receipt-crop");
    const canvas = document.getElementById("crop-canvas");
    const container = document.getElementById("crop-canvas-container");
    if (!cropModal || !canvas || !container) return;

    cropModal.classList.remove("hidden");

    // Fit source to container
    const containerRect = container.getBoundingClientRect();
    const maxW = containerRect.width - 40;
    const maxH = containerRect.height - 40;
    const ratio = Math.min(maxW / sourceCanvas.width, maxH / sourceCanvas.height, 1);
    const displayW = Math.round(sourceCanvas.width * ratio);
    const displayH = Math.round(sourceCanvas.height * ratio);

    canvas.width = displayW;
    canvas.height = displayH;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(sourceCanvas, 0, 0, displayW, displayH);

    // Initialize corners at 10% margin
    const margin = 0.1;
    _receiptCorners = [
        { x: displayW * margin, y: displayH * margin },
        { x: displayW * (1 - margin), y: displayH * margin },
        { x: displayW * (1 - margin), y: displayH * (1 - margin) },
        { x: displayW * margin, y: displayH * (1 - margin) }
    ];

    drawCropOverlay();
    createCropHandles(canvas);
}

function drawCropOverlay() {
    const canvas = document.getElementById("crop-canvas");
    if (!canvas || !_receiptCorners || !_receiptSourceImg) return;
    const ctx = canvas.getContext("2d");

    // Redraw source image
    ctx.drawImage(_receiptSourceImg, 0, 0, canvas.width, canvas.height);

    // Draw semi-transparent overlay outside the selection
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Clear the selected region
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(_receiptCorners[0].x, _receiptCorners[0].y);
    for (let i = 1; i < 4; i++) {
        ctx.lineTo(_receiptCorners[i].x, _receiptCorners[i].y);
    }
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(_receiptSourceImg, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Draw border lines
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(_receiptCorners[0].x, _receiptCorners[0].y);
    for (let i = 1; i < 4; i++) {
        ctx.lineTo(_receiptCorners[i].x, _receiptCorners[i].y);
    }
    ctx.closePath();
    ctx.stroke();
}

function removeCropHandles() {
    document.querySelectorAll(".crop-handle").forEach(h => h.remove());
}

function createCropHandles(canvas) {
    removeCropHandles();
    const container = document.getElementById("crop-canvas-container");
    if (!container || !_receiptCorners) return;

    const canvasRect = canvas.getBoundingClientRect();
    const labels = ["TL", "TR", "BR", "BL"];
    const colors = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b"];

    _receiptCorners.forEach((corner, idx) => {
        const handle = document.createElement("div");
        handle.className = "crop-handle";
        handle.style.cssText = `
            position: absolute;
            width: 28px; height: 28px;
            border-radius: 50%;
            background: ${colors[idx]};
            border: 3px solid white;
            cursor: grab;
            z-index: 10;
            display: flex; align-items: center; justify-content: center;
            font-size: 9px; font-weight: bold; color: white;
            box-shadow: 0 2px 8px rgba(0,0,0,0.5);
            touch-action: none;
            user-select: none;
        `;
        handle.textContent = labels[idx];
        container.appendChild(handle);

        const updateHandlePosition = () => {
            const cr = canvas.getBoundingClientRect();
            const containerR = container.getBoundingClientRect();
            handle.style.left = (cr.left - containerR.left + corner.x - 14) + "px";
            handle.style.top = (cr.top - containerR.top + corner.y - 14) + "px";
        };
        updateHandlePosition();

        // Drag logic (mouse + touch)
        const startDrag = (startX, startY) => {
            handle.style.cursor = "grabbing";
            const moveHandler = (mx, my) => {
                const cr = canvas.getBoundingClientRect();
                let nx = mx - cr.left;
                let ny = my - cr.top;
                nx = Math.max(0, Math.min(canvas.width, nx));
                ny = Math.max(0, Math.min(canvas.height, ny));
                corner.x = nx;
                corner.y = ny;
                updateHandlePosition();
                drawCropOverlay();
            };

            const onMouseMove = (e) => moveHandler(e.clientX, e.clientY);
            const onTouchMove = (e) => {
                e.preventDefault();
                const t = e.touches[0];
                moveHandler(t.clientX, t.clientY);
            };
            const endDrag = () => {
                handle.style.cursor = "grab";
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", endDrag);
                document.removeEventListener("touchmove", onTouchMove);
                document.removeEventListener("touchend", endDrag);
            };
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", endDrag);
            document.addEventListener("touchmove", onTouchMove, { passive: false });
            document.addEventListener("touchend", endDrag);
        };

        handle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            startDrag(e.clientX, e.clientY);
        });
        handle.addEventListener("touchstart", (e) => {
            e.preventDefault();
            const t = e.touches[0];
            startDrag(t.clientX, t.clientY);
        }, { passive: false });
    });
}