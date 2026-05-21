import { checkPermission } from "../auth.js";
import { generateUUID } from "../utils.js";
import { dbRepository as Repository } from "../db.js";
import { SyncEngine } from "../services/SyncEngine.js";
import { showToast } from "../utils.js";

let suppliersList = [];

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
                    
                    <div class="flex items-center gap-2 pt-2">
                        <button type="button" id="btn-cancel-expense" class="w-1/3 bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold py-2 rounded-lg transition duration-150">Cancel</button>
                        <button type="submit" class="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-2 rounded-lg shadow-md transition duration-150">Save Expense</button>
                    </div>
                </form>
            </div>
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
        _updatedAt: Date.now()
    };

    if (!id) {
        expenseData.created_at = new Date();
    }

    try {
        await Repository.upsert('expenses', expenseData);
        SyncEngine.sync();

        document.getElementById("modal-add-expense").classList.add("hidden");
        document.getElementById("form-add-expense").reset();

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
                        <button class="text-blue-500 hover:text-blue-700 edit-btn transition ${canWrite ? '' : 'hidden'}" data-id="${data.id}">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        </button>
                        <button class="text-red-400 hover:text-red-600 delete-btn transition ${canWrite ? '' : 'hidden'}" data-id="${data.id}">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                    </div>
                </td>
            `;

            row.querySelector(".edit-btn").addEventListener("click", () => {
                document.getElementById("expense-modal-title").textContent = "Edit Expense";
                document.getElementById("exp-id").value = data.id;
                document.getElementById("exp-desc").value = data.description;
                document.getElementById("exp-amount").value = data.amount;
                document.getElementById("exp-category").value = data.category;
                document.getElementById("exp-supplier").value = data.supplier_id || "";
                document.getElementById("exp-invoice-no").value = data.invoice_number || "";
                document.getElementById("exp-date").value = data.date;
                document.getElementById("exp-stocked-in").value = "Yes";
                document.getElementById("modal-add-expense").classList.remove("hidden");
            });

            row.querySelector(".delete-btn").addEventListener("click", async () => {
                if (confirm("Delete this expense record?")) {
                    await Repository.remove('expenses', data.id);
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