import { checkPermission } from "../auth.js";
import { generateUUID } from "../utils.js";
import { dbRepository as Repository } from "../db.js";
import { SyncEngine } from "../services/SyncEngine.js";

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
            </div>

            <!-- Expenses Table -->
            <div class="bg-white shadow-md rounded-b-lg overflow-hidden flex-1 flex flex-col border">
                <div class="overflow-y-auto flex-1 h-full">
                    <table class="min-w-full table-auto">
                        <thead class="sticky top-0 bg-gray-100 shadow-sm z-10">
                            <tr class="text-gray-600 uppercase text-xs font-bold leading-normal">
                                <th class="py-3 px-6 text-left">Date</th>
                                <th class="py-3 px-6 text-left">Description</th>
                                <th class="py-3 px-6 text-left">Category</th>
                                <th class="py-3 px-6 text-left">Supplier</th>
                                <th class="py-3 px-6 text-right">Amount</th>
                                <th class="py-3 px-6 text-left">User</th>
                                <th class="py-3 px-6 text-center">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="expenses-table-body" class="text-gray-600 text-sm font-light divide-y divide-gray-100">
                            <tr><td colspan="7" class="py-10 text-center text-gray-400">Loading expenses...</td></tr>
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
                        <input type="number" step="0.01" id="exp-amount" class="w-full border rounded-lg py-2 px-3 text-lg font-bold focus:ring-2 focus:ring-red-500 outline-none" placeholder="0.00" required>
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
                                <option value="Other">Other</option>
                            </select>
                        </div>
                        <div class="mb-4">
                            <label class="block text-gray-700 text-xs font-bold uppercase mb-1">Date</label>
                            <input type="date" id="exp-date" class="w-full border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-red-500 outline-none" required>
                        </div>
                    </div>
                    <div class="mb-6">
                        <label class="block text-gray-700 text-xs font-bold uppercase mb-1">Supplier (Optional)</label>
                        <select id="exp-supplier" class="w-full border rounded-lg py-2 px-3 text-sm focus:ring-2 focus:ring-red-500 outline-none">
                            <option value="">None</option>
                        </select>
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

    await Promise.all([fetchSuppliers(), fetchExpenses()]);
}

async function fetchSuppliers() {
    try {
        suppliersList = await Repository.getAll('suppliers');

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
    const dateVal = document.getElementById("exp-date").value;

    const supplierName = supplierId ? suppliersList.find(s => s.id === supplierId)?.name : null;
    const user = JSON.parse(localStorage.getItem('pos_user'))?.email || "Unknown";

    const expenseData = {
        id: id || generateUUID(),
        description: desc,
        amount: amount,
        category: category,
        supplier_id: supplierId,
        supplier_name: supplierName,
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
                (exp.supplier_name && exp.supplier_name.toLowerCase().includes(searchTerm));

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
            tbody.innerHTML = `<tr><td colspan="7" class="py-10 text-center text-gray-400 italic">No expenses match your filters.</td></tr>`;
            return;
        }

        expenses.forEach(data => {
            const dateStr = data.date;

            const row = document.createElement("tr");
            row.className = "border-b border-gray-100 hover:bg-gray-50 transition-colors";
            row.innerHTML = `
                <td class="py-3 px-6 text-left whitespace-nowrap font-mono text-xs">${dateStr}</td>
                <td class="py-3 px-6 text-left font-medium text-gray-800">${data.description}</td>
                <td class="py-3 px-6 text-left"><span class="bg-gray-100 text-gray-600 py-1 px-3 rounded-full text-[10px] font-bold uppercase tracking-wider">${data.category}</span></td>
                <td class="py-3 px-6 text-left text-xs">${data.supplier_name || '-'}</td>
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
                document.getElementById("exp-date").value = data.date;
                document.getElementById("modal-add-expense").classList.remove("hidden");
            });

            row.querySelector(".delete-btn").addEventListener("click", async () => {
                if (confirm("Delete this expense record?")) {
                    await Repository.remove('expenses', data.id);
                    SyncEngine.sync();
                    fetchExpenses();
                }
            });

            tbody.appendChild(row);
        });
    } catch (error) {
        console.error("Error fetching expenses:", error);
        tbody.innerHTML = `<tr><td colspan="7" class="py-10 text-center text-red-500 font-bold">Error loading expense data.</td></tr>`;
    }
}