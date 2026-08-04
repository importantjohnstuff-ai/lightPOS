import { checkPermission, requestManagerApproval } from "../auth.js";
import { addNotification } from "../services/notification-service.js";
import { generateUUID, handleError } from "../utils.js";
import { dbRepository as Repository } from "../db.js";
import { SyncEngine } from "../services/SyncEngine.js";
import { getSystemSettings, checkShiftDiscrepancy } from "./settings.js";

let currentShift = null;
let selectedShiftId = null;
let shiftList = [];

function getCurrentUser() {
    return JSON.parse(localStorage.getItem('pos_user'));
}

export async function checkActiveShift() {
    const user = getCurrentUser();
    if (!user) return null;

    try {
        // Ensure we have latest data from server
        await SyncEngine.sync();

        const shifts = await Repository.getAll('shifts');
        // Find open shift for this user
        const active = shifts.find(s => s.user_id === user.email && s.status === "open");

        if (active) {
            // Check if shift was opened on a previous day
            const startDate = new Date(active.start_time);
            const now = new Date();
            const isSameDay = startDate.getDate() === now.getDate() &&
                startDate.getMonth() === now.getMonth() &&
                startDate.getFullYear() === now.getFullYear();

            if (!isSameDay && startDate < now) {
                // Force close stale shift
                const expected = await calculateExpectedCash(active);
                const closedShift = {
                    ...active,
                    end_time: new Date().toISOString(),
                    status: 'closed',
                    closing_cash: 0, // Zero turnover as requested
                    total_closing_amount: (active.cashout || 0) + (active.closing_receipts?.reduce((s, r) => s + r.amount, 0) || 0),
                    expected_cash: expected,
                    variance: ((active.cashout || 0) + (active.closing_receipts?.reduce((s, r) => s + r.amount, 0) || 0)) - expected,
                    forced_closed: true
                };

                await Repository.upsert('shifts', closedShift);
                await SyncEngine.sync();

                alert(`Your previous shift from ${startDate.toLocaleDateString()} was automatically closed with 0 turnover.`);
                currentShift = null;
                return null;
            }

            currentShift = active;
            return currentShift;
        } else {
            currentShift = null;
        }
    } catch (error) {
        console.error("Error checking shift status:", error);
    }
    return null;
}

export async function startShift(openingCash) {
    const user = getCurrentUser();
    if (!user) return;

    // Prevent duplicate creation if a shift is already active
    const active = await checkActiveShift();
    if (active) return active;

    const shiftData = {
        id: generateUUID(),
        user_id: user.email,
        start_time: new Date(),
        end_time: null,
        opening_cash: parseFloat(openingCash),
        closing_cash: 0,
        cashout: 0,
        expected_cash: parseFloat(openingCash),
        status: "open",
        adjustments: [],
        remittances: []
    };

    try {
        // Save locally and queue for sync
        await Repository.upsert('shifts', shiftData);
        SyncEngine.sync(); // Background sync

        currentShift = shiftData;
        window.dispatchEvent(new CustomEvent('shift-updated'));
        return currentShift;
    } catch (error) {
        console.error("Error starting shift:", error);
        throw error;
    }
}

export function requireShift(callback) {
    if (currentShift) {
        callback();
    } else {
        showOpenShiftModal(callback);
    }
}

export async function getShiftFinancials(shift = currentShift, txList = null) {
    if (!shift) return { opening: 0, sales: 0, adjustments: 0, returns_net: 0, remittances: 0, expenses: 0, non_cash: 0, gross_accountability: 0, expected_in_drawer: 0 };

    // Query local Dexie transactions for this user since shift start
    const startTime = new Date(shift.start_time);
    const endTime = shift.end_time ? new Date(shift.end_time) : new Date();
    const userEmail = shift.user_id;

    const allTransactions = txList || await Repository.getAll('transactions');
    const transactions = allTransactions.filter(tx => {
        const txTime = new Date(tx.timestamp);
        return txTime >= startTime && txTime <= endTime &&
            tx.user_email === userEmail && !tx.is_voided &&
            (tx.payment_method?.toLowerCase() === 'cash' || !tx.payment_method);
    });

    let totalSales = 0;
    transactions.forEach(tx => {
        totalSales += parseFloat(tx.total_amount || 0);
    });

    // Calculate Non-Cash Transactions (Card, E-Wallet, Points, Split)
    const nonCashTransactions = allTransactions.filter(tx => {
        const txTime = new Date(tx.timestamp);
        const method = (tx.payment_method || 'Cash').toLowerCase();
        const isNonCashMethod = method !== 'cash' || (tx.points_used > 0 || tx.points_amount > 0);
        return txTime >= startTime && txTime <= endTime &&
            tx.user_email === userEmail && !tx.is_voided && isNonCashMethod;
    });

    let totalNonCash = 0;
    nonCashTransactions.forEach(tx => {
        const method = (tx.payment_method || 'Cash').toLowerCase();
        if (method === 'cash + points') {
            totalNonCash += parseFloat(tx.points_amount || (tx.points_used * 1.0) || 0);
        } else if (method === 'points') {
            totalNonCash += parseFloat(tx.total_amount || tx.points_amount || 0);
        } else {
            totalNonCash += parseFloat(tx.total_amount || 0);
        }
    });

    // Add adjustments
    const adjustments = shift.adjustments || [];
    const totalAdjustments = adjustments.reduce((sum, adj) => sum + (parseFloat(adj.amount) || 0), 0);

    // Remittances (Cash-out)
    const remittances = shift.remittances || [];
    const totalRemittances = remittances.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

    // Expenses (Closing Receipts)
    const expenses = shift.closing_receipts || [];
    const totalExpenses = expenses.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

    // Calculate returns/exchanges impact (Net Cash Effect)
    let totalExchangeCash = 0;
    allTransactions.forEach(tx => {
        if (tx.exchanges && Array.isArray(tx.exchanges)) {
            tx.exchanges.forEach(exch => {
                const exchTime = new Date(exch.timestamp);
                // Check if exchange happened during this shift by this user
                if (exchTime >= startTime && exchTime <= endTime && exch.processed_by === userEmail) {
                    const returnedTotal = (exch.returned || []).reduce((sum, item) => sum + (parseFloat(item.selling_price || 0) * (parseFloat(item.qty) || 1)), 0);
                    const takenTotal = (exch.taken || []).reduce((sum, item) => sum + (parseFloat(item.selling_price || 0) * (parseFloat(item.qty) || 1)), 0);
                    // If Taken > Returned, customer paid more cash (Positive)
                    // If Returned > Taken, store paid cash out (Negative)
                    const net = takenTotal - returnedTotal;
                    totalExchangeCash += net;
                }
            });
        }
    });

    const gross = (parseFloat(shift.opening_cash) || 0) + totalSales + totalAdjustments + totalExchangeCash;
    // Expected in Drawer = Gross - Remittances - Expenses
    const expected_in_drawer = gross - totalRemittances - totalExpenses;

    return {
        opening: parseFloat(shift.opening_cash) || 0,
        sales: totalSales,
        adjustments: totalAdjustments,
        remittances: totalRemittances,
        expenses: totalExpenses,
        non_cash: totalNonCash,
        returns_net: totalExchangeCash,
        gross_accountability: gross,
        expected_in_drawer: expected_in_drawer
    };
}

export async function calculateExpectedCash(shift = currentShift, txList = null) {
    // Legacy support: Returns Gross Accountability (for history table logic)
    const fins = await getShiftFinancials(shift, txList);
    return fins.gross_accountability;
}

export async function recordRemittance(amount, reason) {
    const user = getCurrentUser();
    if (!user) return;

    const active = await checkActiveShift();
    if (!active) throw new Error("No active shift");

    const remittance = {
        id: generateUUID(),
        amount: parseFloat(amount),
        reason: reason,
        timestamp: new Date().toISOString(),
        user: user.email
    };

    if (!active.remittances) active.remittances = [];
    active.remittances.push(remittance);

    active.cashout = (active.cashout || 0) + remittance.amount;

    await Repository.upsert('shifts', active);
    currentShift = active;
    SyncEngine.sync();

    await addNotification('Remittance', `Cash remittance of ₱${remittance.amount.toFixed(2)} recorded by ${user.email}`);

    return remittance;
}

export async function closeShift(closingCash) {
    if (!currentShift) return;

    const closing = parseFloat(closingCash);
    const financials = await getShiftFinancials(currentShift);

    const updatedShift = {
        ...currentShift,
        end_time: new Date(),
        closing_cash: closing,
        expected_cash: financials.gross_accountability, // Persist gross for history logic
        status: "closed"
    };

    await Repository.upsert('shifts', updatedShift);
    SyncEngine.sync();

    // Print Z-Report
    await printZReport({ ...updatedShift, ...financials });

    window.dispatchEvent(new CustomEvent('shift-updated'));

    // Variance = (Drawer + Remits + Expenses) - Gross
    const variance = (closing + financials.remittances + financials.expenses) - financials.gross_accountability;

    // Check for discrepancy notification threshold
    await checkShiftDiscrepancy(financials.expected_in_drawer, closing);

    const summary = {
        expected: financials.expected_in_drawer,
        actual: closing,
        difference: variance
    };

    currentShift = null;
    return summary;
}

export async function loadShiftsView() {
    const content = document.getElementById("main-content");
    if (!checkPermission("shifts", "read")) {
        content.innerHTML = `<div class="p-6 text-center text-red-600 font-bold">You do not have permission to view shifts.</div>`;
        return;
    }

    // Layout similar to suppliers.js: Left List, Right Details
    content.innerHTML = `
        <div class="max-w-6xl mx-auto h-[calc(100vh-140px)] flex flex-col">
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8 flex-1 min-h-0">
                <!-- Left Column: Shifts List -->
                <div class="flex flex-col h-full min-h-[400px] lg:min-h-0">
                    <div class="flex flex-col gap-2 mb-4 flex-shrink-0">
                        <h2 class="text-2xl font-bold text-gray-800">My Shifts</h2>
                        <div class="flex flex-wrap gap-2 items-end bg-white p-2 rounded border shadow-sm">
                            <div class="flex-1">
                                <label class="block text-xs font-bold text-gray-700 mb-1">Start</label>
                                <input type="date" id="shift-history-start" class="border rounded p-1 text-xs w-full">
                            </div>
                            <div class="flex-1">
                                <label class="block text-xs font-bold text-gray-700 mb-1">End</label>
                                <input type="date" id="shift-history-end" class="border rounded p-1 text-xs w-full">
                            </div>
                            <div class="w-16">
                                <label class="block text-xs font-bold text-gray-700 mb-1">Limit</label>
                                <input type="number" id="shift-history-limit" value="20" min="5" class="border rounded p-1 text-xs w-full">
                            </div>
                            <button id="btn-filter-shifts" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-1 px-3 rounded text-xs h-7">Filter</button>
                        </div>
                    </div>

                    <div class="bg-white shadow-md rounded overflow-y-auto flex-1 border">
                        <table class="min-w-full table-auto">
                            <thead class="sticky top-0 z-10 bg-gray-100">
                                <tr class="bg-gray-100 text-gray-600 uppercase text-xs leading-normal">
                                    <th class="py-3 px-4 text-left">Start Time</th>
                                    <th class="py-3 px-4 text-center">Status</th>
                                    <th class="py-3 px-4 text-right">Variance</th>
                                </tr>
                            </thead>
                            <tbody id="shifts-table-body" class="text-gray-600 text-sm font-light">
                                <tr><td colspan="3" class="py-3 px-6 text-center">Loading...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Right Column: Shift Details -->
                <div id="shift-details-panel" class="hidden flex flex-col h-full min-h-[400px] lg:min-h-0 bg-white shadow-md rounded border overflow-hidden">
                    <div class="p-4 border-b bg-gray-50 flex justify-between items-center">
                        <h3 class="text-lg font-bold text-gray-800">Shift Details</h3>
                        <div id="shift-details-status"></div>
                    </div>
                    <div id="shift-details-content" class="p-6 overflow-y-auto flex-1">
                        <!-- Details injected here -->
                    </div>
                </div>
            </div>
        </div>
    `;

    // Set default dates using local timezone string
    const today = new Date().toLocaleDateString('en-CA');
    const lastMonth = new Date();
    lastMonth.setDate(lastMonth.getDate() - 30);
    const lastMonthStr = lastMonth.toLocaleDateString('en-CA');
    document.getElementById('shift-history-start').value = lastMonthStr;
    document.getElementById('shift-history-end').value = today;

    document.getElementById('btn-filter-shifts').addEventListener('click', fetchShifts);
    selectedShiftId = null;

    await fetchShifts();
}

async function fetchShifts() {
    const tbody = document.getElementById("shifts-table-body");
    const user = getCurrentUser();
    if (!user) {
        tbody.innerHTML = `<tr><td colspan="3" class="py-3 px-6 text-center">Please login to view shifts.</td></tr>`;
        return;
    }

    try {
        const shifts = await Repository.getAll('shifts');
        const allTransactions = await Repository.getAll('transactions');

        const startStr = document.getElementById('shift-history-start').value;
        const endStr = document.getElementById('shift-history-end').value;
        const limit = parseInt(document.getElementById('shift-history-limit').value) || 20;

        // Filter by user and sort desc (newest first)
        shiftList = shifts
            .filter(s => s.user_id === user.email)
            .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

        if (startStr && endStr) {
            const startDate = new Date(startStr + 'T00:00:00');
            const endDate = new Date(endStr + 'T23:59:59.999');
            shiftList = shiftList.filter(s => {
                const d = new Date(s.start_time);
                // ALWAYS include open shift for current user
                if (s.status === 'open' && s.user_id === user.email) return true;
                return d >= startDate && d <= endDate;
            });
        }

        // Force active shift to top if exists
        const openShiftIndex = shiftList.findIndex(s => s.status === 'open');
        if (openShiftIndex > -1) {
            const openShift = shiftList.splice(openShiftIndex, 1)[0];
            shiftList.unshift(openShift);
        }

        shiftList = shiftList.slice(0, limit);

        tbody.innerHTML = "";

        if (shiftList.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" class="py-3 px-6 text-center">No shifts found.</td></tr>`;
            return;
        }

        for (const data of shiftList) {
            const start = data.start_time ? new Date(data.start_time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : "-";

            const isClosed = data.status === 'closed';
            const expected = await calculateExpectedCash(data, allTransactions);

            const cashout = data.cashout || 0;
            const receipts = data.closing_receipts || [];
            const totalExpenses = receipts.reduce((sum, r) => sum + (r.amount || 0), 0);
            const turnover = (data.closing_cash || 0) + totalExpenses + cashout;

            const variance = isClosed ? turnover - expected : 0;
            const diffClass = isClosed ? (variance < 0 ? "text-red-600" : (variance > 0 ? "text-green-600" : "")) : "";

            // Store calculated values for detail view
            data._calculated = { expected, variance, turnover };

            const row = document.createElement("tr");
            row.className = `border-b border-gray-200 hover:bg-blue-50 cursor-pointer transition-colors ${selectedShiftId === data.id ? 'bg-blue-50' : ''}`;
            row.innerHTML = `
                <td class="py-3 px-4 text-left whitespace-nowrap font-medium">
                    ${start}
                    ${data.forced_closed ? '<span class="ml-2 text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded border border-red-200" title="Automatically closed by system">FORCED</span>' : ''}
                </td>
                <td class="py-3 px-4 text-center">
                    <span class="${data.status === 'open' ? 'bg-green-200 text-green-700' : 'bg-gray-200 text-gray-700'} py-1 px-3 rounded-full text-xs uppercase">${data.status}</span>
                </td>
                <td class="py-3 px-4 text-right font-bold ${diffClass}">${isClosed ? `₱${variance.toFixed(2)}` : '-'}</td>
            `;

            row.addEventListener("click", () => selectShift(data));
            tbody.appendChild(row);
        }
    } catch (error) {
        console.error("Error fetching shifts:", error);
        tbody.innerHTML = `<tr><td colspan="3" class="py-3 px-6 text-center text-red-500">Error loading shifts.</td></tr>`;
    }
}

async function selectShift(shift) {
    selectedShiftId = shift.id;

    // Highlight row
    document.querySelectorAll("#shifts-table-body tr").forEach(row => row.classList.remove("bg-blue-50"));
    // Re-render list to apply highlight class (or just find the row, but re-rendering is safe if list is small)
    // For simplicity, we'll just re-fetch or rely on the click handler adding the class if we didn't rebuild.
    // Since we built the rows in the loop, let's just re-render the details.

    // Actually, let's just highlight the clicked row if we passed the event, but here we passed data.
    // Let's just re-render the table to ensure consistency or find by index if we had it.
    // A simple way is to re-run fetchShifts but that's expensive.
    // Let's just render details.

    const panel = document.getElementById("shift-details-panel");
    const content = document.getElementById("shift-details-content");
    const statusHeader = document.getElementById("shift-details-status");

    panel.classList.remove("hidden");

    const isClosed = shift.status === 'closed';
    // Always recalculate to ensure accuracy against transactions
    const financials = await getShiftFinancials(shift);
    const expected = financials.expected_in_drawer;
    const gross = financials.gross_accountability;

    let variance = 0;
    if (isClosed) {
        variance = (shift.closing_cash || 0) - expected;
    }

    const varianceClass = variance < 0 ? "text-red-600 bg-red-50" : (variance > 0 ? "text-green-600 bg-green-50" : "text-gray-600 bg-gray-50");

    statusHeader.innerHTML = `
        <span class="${shift.status === 'open' ? 'bg-green-200 text-green-800' : 'bg-gray-200 text-gray-800'} px-3 py-1 rounded-full text-xs uppercase font-bold tracking-wide">${shift.status}</span>
        ${shift.forced_closed ? '<span class="ml-2 bg-red-100 text-red-600 px-2 py-1 rounded-full text-xs uppercase font-bold border border-red-200">Forced</span>' : ''}
    `;

    const canAdjust = checkPermission("shifts", "write");

    content.innerHTML = `
        <div class="mb-6">
            <div class="text-sm text-gray-500">Start Time</div>
            <div class="font-medium text-gray-800">${new Date(shift.start_time).toLocaleString()}</div>
            <div class="text-sm text-gray-500 mt-2">End Time</div>
            <div class="font-medium text-gray-800">${shift.end_time ? new Date(shift.end_time).toLocaleString() : 'Active'}</div>
        </div>

        <div class="overflow-x-auto mb-6">
            <table class="w-full text-sm border-collapse border border-gray-200">
                <tbody>
                    <tr class="bg-gray-50 border-b">
                        <td class="border p-2 font-bold text-gray-600 w-1/2">Opening Cash</td>
                        <td class="border p-2 text-right font-bold text-gray-800">₱${(shift.opening_cash || 0).toFixed(2)}</td>
                    </tr>
                    <tr class="bg-white border-b hover:bg-blue-50 cursor-pointer transition-colors" id="row-detail-cash-count">
                        <td class="border p-2 font-bold text-gray-600 w-1/2 flex items-center justify-between">
                            <span>Cash Count</span>
                            <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                        </td>
                        <td class="border p-2 text-right font-bold text-blue-600">₱${(shift.closing_cash || 0).toFixed(2)}</td>
                    </tr>
                    <tr class="bg-gray-50 border-b hover:bg-blue-50 cursor-pointer transition-colors" id="row-detail-precounted">
                        <td class="border p-2 font-bold text-gray-600 w-1/2 flex items-center justify-between">
                            <span>Precounted Money</span>
                             <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                        </td>
                        <td class="border p-2 text-right font-bold text-gray-800">₱${((shift.precounted_bills || 0) + (shift.precounted_coins || 0)).toFixed(2)}</td>
                    </tr>
                    <tr class="bg-white border-b">
                        <td class="border p-2 font-bold text-gray-600 w-1/2">Cashout</td>
                        <td class="border p-2 text-right font-bold text-purple-600">₱${financials.remittances.toFixed(2)}</td>
                    </tr>
                    <tr class="bg-gray-50 border-b hover:bg-blue-50 cursor-pointer transition-colors" id="row-detail-expenses">
                        <td class="border p-2 font-bold text-gray-600 w-1/2 flex items-center justify-between">
                            <span>Expenses</span>
                             <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                        </td>
                        <td class="border p-2 text-right font-bold text-red-600">₱${financials.expenses.toFixed(2)}</td>
                    </tr>
                    <tr class="bg-white border-b hover:bg-teal-50 cursor-pointer transition-colors" id="row-detail-non-cash">
                        <td class="border p-2 font-bold text-gray-600 w-1/2 flex items-center justify-between">
                            <span>Non-Cash Payments</span>
                             <svg class="w-4 h-4 text-teal-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                        </td>
                        <td class="border p-2 text-right font-bold text-teal-600">₱${(financials.non_cash || 0).toFixed(2)}</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div class="mb-6 p-4 ${varianceClass} rounded border border-opacity-20 flex justify-between items-center">
            <span class="font-bold text-sm uppercase">Variance</span>
            <span class="text-2xl font-bold">${isClosed ? `₱${variance.toFixed(2)}` : '-'}</span>
        </div>

        <div class="flex flex-col gap-3">
            <h4 class="font-bold text-gray-700 border-b pb-2 mb-2">Actions</h4>
            <div class="grid grid-cols-2 gap-3">
                ${canAdjust ? `<button id="btn-detail-adjust" class="bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 py-2 rounded font-bold text-sm transition">Adjust Cash</button>` : ''}
                <button id="btn-detail-remit" class="bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200 py-2 rounded font-bold text-sm transition">Remit Cash</button>
                <button id="btn-detail-history" class="bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200 py-2 rounded font-bold text-sm transition">View History</button>
                <button id="btn-detail-transactions" class="bg-teal-50 text-teal-700 hover:bg-teal-100 border border-teal-200 py-2 rounded font-bold text-sm transition">Transactions</button>
                ${shift.status === 'open' ? `<button id="btn-detail-xreport" class="bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 py-2 rounded font-bold text-sm transition">X-Report</button>` : ''}
                ${isClosed && canAdjust ? `<button id="btn-detail-edit-shift" class="bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 py-2 rounded font-bold text-sm transition flex items-center justify-center gap-1 col-span-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                    Edit Shift
                </button>` : ''}
            </div>
        </div>
    `;

    // Bind Actions
    if (canAdjust) {
        document.getElementById("btn-detail-adjust")?.addEventListener("click", () => showAdjustCashModal(shift.id, async () => {
            const updated = await Repository.get('shifts', shift.id);
            selectShift(updated);
        }));
    }
    document.getElementById("btn-detail-remit")?.addEventListener("click", () => showRemittanceHistoryModal(shift));
    document.getElementById("btn-detail-history")?.addEventListener("click", () => showShiftHistoryModal(shift.adjustments || []));
    document.getElementById("btn-detail-transactions")?.addEventListener("click", () => showShiftTransactions(shift));
    document.getElementById("btn-detail-xreport")?.addEventListener("click", () => showXReport());
    document.getElementById("btn-detail-edit-shift")?.addEventListener("click", () => openEditShiftModal(shift));

    // Row Click Listeners
    document.getElementById("row-detail-cash-count")?.addEventListener("click", () => showCashBreakdownModal(shift));
    document.getElementById("row-detail-precounted")?.addEventListener("click", () => showPrecountedModal(shift));
    document.getElementById("row-detail-expenses")?.addEventListener("click", () => showShiftExpensesModal(shift));
    document.getElementById("row-detail-non-cash")?.addEventListener("click", () => showNonCashPaymentsModal(shift));
}

function showCashBreakdownModal(shift) {
    const breakdown = shift.cash_breakdown || {};
    const hasData = Object.keys(breakdown).length > 0;

    const div = document.createElement("div");
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-[70]";

    // Sort denominations high to low
    const denoms = Object.keys(breakdown).sort((a, b) => parseFloat(b) - parseFloat(a));

    const rows = denoms.map(denom => `
        <div class="flex justify-between border-b py-2 last:border-0">
            <div class="font-bold text-gray-700">₱${denom}</div>
            <div class="text-gray-900 mx-2">x ${breakdown[denom]}</div>
            <div class="font-bold text-gray-900">₱${(parseFloat(denom) * breakdown[denom]).toLocaleString()}</div>
        </div>
    `).join("");

    div.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl p-6 w-96 max-w-full">
            <h3 class="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
                <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
                Cash Count Details
            </h3>
            <div class="mb-4 text-sm bg-gray-50 rounded p-3">
                ${hasData ? rows : '<div class="text-center text-gray-500 italic">No breakdown details available.</div>'}
            </div>
            <div class="flex justify-end pt-2 border-t">
                 <div class="flex-1 text-left font-bold text-lg text-blue-800 self-center">Total: ₱${(shift.closing_cash || 0).toLocaleString()}</div>
                 <button class="bg-gray-800 text-white px-4 py-2 rounded font-bold hover:bg-gray-700 transition" onclick="this.closest('.fixed').remove()">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(div);
}

function showPrecountedModal(shift) {
    const bills = parseFloat(shift.precounted_bills) || 0;
    const coins = parseFloat(shift.precounted_coins) || 0;

    const div = document.createElement("div");
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-[70]";
    div.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl p-6 w-80 max-w-full">
            <h3 class="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
                <svg class="w-6 h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                Precounted Money
            </h3>
            <div class="space-y-3 mb-6">
                <div class="flex justify-between items-center p-3 bg-green-50 rounded border border-green-100">
                    <span class="text-sm font-bold text-gray-600 uppercase">Bills</span>
                    <span class="text-xl font-bold text-green-700">₱${bills.toLocaleString()}</span>
                </div>
                <div class="flex justify-between items-center p-3 bg-yellow-50 rounded border border-yellow-100">
                    <span class="text-sm font-bold text-gray-600 uppercase">Coins</span>
                    <span class="text-xl font-bold text-yellow-700">₱${coins.toLocaleString()}</span>
                </div>
            </div>
            <div class="flex justify-end">
                 <button class="bg-gray-800 text-white px-4 py-2 rounded font-bold hover:bg-gray-700 transition w-full" onclick="this.closest('.fixed').remove()">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(div);
}

function showShiftExpensesModal(shift) {
    const expenses = shift.closing_receipts || [];
    const div = document.createElement("div");
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-[70]";

    const rows = expenses.map(exp => `
        <div class="flex justify-between items-center py-2 border-b last:border-0 hover:bg-gray-50 px-2">
            <div>
                <div class="font-bold text-gray-700 text-sm">${exp.description}</div>
                ${exp.category ? `<div class="text-[10px] text-gray-400 uppercase">${exp.category}</div>` : ''}
            </div>
            <div class="font-bold text-red-600">₱${(exp.amount || 0).toLocaleString()}</div>
        </div>
    `).join("");

    div.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl p-6 w-96 max-w-full max-h-[80vh] flex flex-col">
            <h3 class="text-xl font-bold text-gray-800 mb-4 flex items-center gap-2">
                <svg class="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 2H7a2 2 0 00-2 2v15a2 2 0 002 2z"></path></svg>
                Shift Expenses
            </h3>
            <div class="flex-1 overflow-y-auto mb-4 border rounded bg-white">
                ${expenses.length > 0 ? rows : '<div class="p-4 text-center text-gray-500 italic">No expenses recorded.</div>'}
            </div>
             <div class="flex justify-end pt-2 border-t">
                 <div class="flex-1 text-left font-bold text-lg text-red-800 self-center">Total: ₱${expenses.reduce((s, e) => s + (e.amount || 0), 0).toLocaleString()}</div>
                 <button class="bg-gray-800 text-white px-4 py-2 rounded font-bold hover:bg-gray-700 transition" onclick="this.closest('.fixed').remove()">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(div);
}

export async function showNonCashPaymentsModal(shift = currentShift) {
    if (!shift) return;

    const startTime = new Date(shift.start_time);
    const endTime = shift.end_time ? new Date(shift.end_time) : new Date();
    const userEmail = shift.user_id;

    const allTransactions = await Repository.getAll('transactions');
    const nonCashTxs = allTransactions.filter(tx => {
        const txTime = new Date(tx.timestamp);
        const method = (tx.payment_method || 'Cash').toLowerCase();
        const isNonCash = method !== 'cash' || (tx.points_used > 0 || tx.points_amount > 0);
        return txTime >= startTime && txTime <= endTime &&
            tx.user_email === userEmail && !tx.is_voided && isNonCash;
    }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    let grandTotalNonCash = 0;
    let totalCard = 0;
    let totalEWallet = 0;
    let totalPoints = 0;
    let totalOther = 0;

    const rows = nonCashTxs.map(tx => {
        const methodRaw = tx.payment_method || 'Card';
        const method = methodRaw.toLowerCase();
        const totalAmt = parseFloat(tx.total_amount || 0);
        const pointsAmt = parseFloat(tx.points_amount || (tx.points_used * 1.0) || 0);

        const components = [];

        // 1. Points Component
        if (pointsAmt > 0 && (method.includes('points') || tx.points_used > 0)) {
            components.push({
                type: 'Points',
                name: 'Points',
                amount: pointsAmt,
                badgeBg: 'bg-amber-100 text-amber-800 border-amber-300',
                textClass: 'text-amber-700 font-black'
            });
            totalPoints += pointsAmt;
        }

        // 2. Primary Non-Cash Component (Card, E-Wallet, Bank, etc.)
        let primaryName = methodRaw;
        if (methodRaw.includes('+')) {
            const parts = methodRaw.split('+').map(p => p.trim());
            primaryName = parts.find(p => p.toLowerCase() !== 'points') || 'Cash';
        }

        const primaryLower = primaryName.toLowerCase();
        if (primaryLower !== 'cash' && primaryLower !== 'points') {
            let primaryAmt = totalAmt;
            if (pointsAmt > 0 && method.includes('points')) {
                primaryAmt = Math.max(0, totalAmt - pointsAmt);
            }

            if (primaryAmt > 0) {
                if (primaryLower.includes('card') || primaryLower.includes('bank') || primaryLower.includes('debit') || primaryLower.includes('credit')) {
                    components.unshift({
                        type: 'Card / Bank',
                        name: primaryName,
                        amount: primaryAmt,
                        badgeBg: 'bg-blue-100 text-blue-800 border-blue-300',
                        textClass: 'text-blue-700 font-black'
                    });
                    totalCard += primaryAmt;
                } else if (primaryLower.includes('wallet') || primaryLower.includes('gcash') || primaryLower.includes('paymaya') || primaryLower.includes('maya')) {
                    components.unshift({
                        type: 'E-Wallet',
                        name: primaryName,
                        amount: primaryAmt,
                        badgeBg: 'bg-purple-100 text-purple-800 border-purple-300',
                        textClass: 'text-purple-700 font-black'
                    });
                    totalEWallet += primaryAmt;
                } else {
                    components.unshift({
                        type: primaryName,
                        name: primaryName,
                        amount: primaryAmt,
                        badgeBg: 'bg-teal-100 text-teal-800 border-teal-300',
                        textClass: 'text-teal-700 font-black'
                    });
                    totalOther += primaryAmt;
                }
            }
        }

        const txNonCashTotal = components.reduce((sum, c) => sum + c.amount, 0);
        grandTotalNonCash += txNonCashTotal;

        const timeStr = new Date(tx.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = new Date(tx.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });

        const componentChipsHtml = components.map(c => `
            <div class="flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-bold ${c.badgeBg}">
                <span>${c.name}:</span>
                <span class="${c.textClass}">₱${c.amount.toFixed(2)}</span>
            </div>
        `).join('');

        return `
            <div class="p-3.5 border-b last:border-0 hover:bg-gray-50 transition">
                <div class="flex justify-between items-start mb-1.5">
                    <div>
                        <div class="flex items-center gap-2">
                            <span class="font-bold text-gray-800 text-sm">${methodRaw}</span>
                            ${components.length > 1 ? '<span class="text-[9px] px-1.5 py-0.5 rounded font-black border uppercase bg-indigo-50 text-indigo-700 border-indigo-200">Split Tender</span>' : ''}
                        </div>
                        <div class="text-xs text-gray-500 mt-0.5">
                            ${dateStr} at ${timeStr} • Customer: ${tx.customer_name || tx.customer_id || 'Guest'}
                        </div>
                    </div>
                    <div class="text-right">
                        <div class="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Tx Non-Cash</div>
                        <div class="font-black text-gray-900 text-base">₱${txNonCashTotal.toFixed(2)}</div>
                    </div>
                </div>
                <div class="flex flex-wrap gap-2 mt-2 pt-2 border-t border-gray-100">
                    ${componentChipsHtml}
                </div>
            </div>
        `;
    }).join("");

    const summaryCategoryChips = [];
    if (totalCard > 0) {
        summaryCategoryChips.push(`
            <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-blue-50 border-blue-200 text-xs font-bold text-blue-900">
                <span class="w-2 h-2 rounded-full bg-blue-500"></span>
                <span>Card / Bank:</span>
                <span class="font-black text-blue-700">₱${totalCard.toFixed(2)}</span>
            </div>
        `);
    }
    if (totalEWallet > 0) {
        summaryCategoryChips.push(`
            <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-purple-50 border-purple-200 text-xs font-bold text-purple-900">
                <span class="w-2 h-2 rounded-full bg-purple-500"></span>
                <span>E-Wallet:</span>
                <span class="font-black text-purple-700">₱${totalEWallet.toFixed(2)}</span>
            </div>
        `);
    }
    if (totalPoints > 0) {
        summaryCategoryChips.push(`
            <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-amber-50 border-amber-200 text-xs font-bold text-amber-900">
                <span class="w-2 h-2 rounded-full bg-amber-500"></span>
                <span>Points:</span>
                <span class="font-black text-amber-700">₱${totalPoints.toFixed(2)}</span>
            </div>
        `);
    }
    if (totalOther > 0) {
        summaryCategoryChips.push(`
            <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-teal-50 border-teal-200 text-xs font-bold text-teal-900">
                <span class="w-2 h-2 rounded-full bg-teal-500"></span>
                <span>Other Non-Cash:</span>
                <span class="font-black text-teal-700">₱${totalOther.toFixed(2)}</span>
            </div>
        `);
    }

    const div = document.createElement("div");
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-[70]";
    div.innerHTML = `
        <div class="bg-white rounded-xl shadow-2xl p-6 w-full max-w-xl max-h-[85vh] flex flex-col">
            <div class="flex justify-between items-center border-b pb-3 mb-3">
                <h3 class="text-xl font-bold text-gray-800 flex items-center gap-2">
                    <svg class="w-6 h-6 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                    Non-Cash Shift Payments
                </h3>
                <button class="text-gray-400 hover:text-gray-600 text-2xl font-bold" onclick="this.closest('.fixed').remove()">&times;</button>
            </div>

            ${summaryCategoryChips.length > 0 ? `
                <div class="flex flex-wrap gap-2 mb-3 p-3 bg-gray-50 rounded-xl border border-gray-200">
                    ${summaryCategoryChips.join('')}
                </div>
            ` : ''}

            <div class="flex-1 overflow-y-auto mb-4 border rounded-xl bg-white shadow-inner">
                ${nonCashTxs.length > 0 ? rows : '<div class="p-8 text-center text-gray-400 italic">No non-cash payments recorded in this shift.</div>'}
            </div>

            <div class="flex justify-between items-center pt-3 border-t">
                <div>
                    <div class="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Grand Non-Cash Total</div>
                    <div class="font-black text-xl text-teal-800">₱${grandTotalNonCash.toFixed(2)}</div>
                </div>
                <button class="bg-gray-800 text-white px-6 py-2.5 rounded-xl font-bold hover:bg-black transition shadow" onclick="this.closest('.fixed').remove()">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(div);
}

function showOpenShiftModal(onSuccess) {
    let modal = document.getElementById("modal-open-shift");

    if (!modal) {
        const div = document.createElement("div");
        div.innerHTML = `
            <div id="modal-open-shift" class="fixed inset-0 bg-gray-900 bg-opacity-90 flex items-center justify-center z-50">
                <div class="bg-white rounded-lg shadow-xl p-8 w-96">
                    <div class="text-center mb-6">
                        <div class="mx-auto flex items-center justify-center h-16 w-16 rounded-full bg-blue-100 mb-4">
                            <svg class="h-8 w-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                        </div>
                        <h2 class="text-2xl font-bold text-gray-800">Start Shift</h2>
                        <p class="text-gray-600 text-sm mt-2">Please enter the opening petty cash amount to begin.</p>
                    </div>
                    
                    <form id="form-open-shift">
                        <div class="mb-6">
                            <label class="block text-gray-700 text-sm font-bold mb-2">Opening Cash (PHP)</label>
                            <input type="number" id="shift-opening-cash" class="shadow appearance-none border rounded w-full py-3 px-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 text-xl text-center" step="0.01" required min="0">
                        </div>
                        <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded focus:outline-none focus:shadow-outline transition duration-150">
                            Open Register
                        </button>
                    </form>
                    <div class="mt-4 text-center">
                        <a href="#dashboard" id="btn-cancel-open-shift" class="text-sm text-gray-500 hover:text-gray-700">Cancel and go to Dashboard</a>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(div.firstElementChild);
        modal = document.getElementById("modal-open-shift");

        document.getElementById("btn-cancel-open-shift").addEventListener("click", () => modal.remove());

        document.getElementById("form-open-shift").addEventListener("submit", async (e) => {
            e.preventDefault();

            const submitBtn = e.target.querySelector('button[type="submit"]');
            submitBtn.disabled = true;
            submitBtn.textContent = "Opening...";

            const amount = document.getElementById("shift-opening-cash").value;
            try {
                await startShift(amount);
                modal.remove();
                if (onSuccess) onSuccess();
            } catch (error) {
                console.error("Error starting shift:", error);
                alert("Failed to start shift. Please try again.");
                submitBtn.disabled = false;
                submitBtn.textContent = "Open Register";
            }
        });
    } else {
        modal.classList.remove("hidden");
    }
}

export async function openEditShiftModal(shift) {
    if (!checkPermission("shifts", "write")) {
        alert("You do not have permission to edit shifts.");
        return;
    }

    if (!(await requestManagerApproval())) return;

    let modal = document.getElementById("modal-close-shift");
    if (modal) modal.remove();
    let pickModal = document.getElementById("modal-pick-expense");
    if (pickModal) pickModal.remove();

    const modalDiv = document.createElement("div");
    modalDiv.id = "modal-close-shift";
    modalDiv.className = "fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center z-50";
    modalDiv.innerHTML = `
        <div class="bg-white rounded-lg shadow-lg p-6 w-full max-w-5xl h-[85vh] flex flex-col">
            <div class="flex justify-between items-center mb-6 border-b pb-4">
                <div>
                    <h3 class="text-2xl font-bold text-gray-800">Edit Shift Details</h3>
                    <p class="text-sm text-gray-500">Modify cash count and verify turnover for this shift.</p>
                </div>
                <button id="btn-cancel-close-shift-x" class="text-gray-400 hover:text-gray-600 text-3xl">&times;</button>
            </div>

            <div class="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-12 gap-6">
                <!-- Column 1: Cash Counter (4 cols) -->
                <div class="lg:col-span-4 flex flex-col h-full overflow-hidden border-r pr-4">
                    <div class="flex justify-between items-center mb-2">
                        <h4 class="font-bold text-gray-700 uppercase text-xs tracking-wider">Cash Denominations</h4>
                        <span class="text-xs text-gray-400">Enter count</span>
                    </div>
                    
                    <div class="flex-1 overflow-y-auto bg-gray-50 rounded-lg border p-4">
                        <div class="grid grid-cols-3 gap-2 mb-3 font-bold text-xs text-gray-500 uppercase border-b pb-2">
                            <div>Denom</div>
                            <div class="text-center">Count</div>
                            <div class="text-right">Total</div>
                        </div>
                        <div class="space-y-2" id="cash-counter-grid">
                            <!-- Denominations injected here -->
                        </div>
                    </div>
                </div>

                <!-- Column 2: Inputs (4 cols) -->
                <div class="lg:col-span-4 flex flex-col h-full overflow-y-auto border-r pr-4 space-y-4">
                    <!-- Other Cash -->
                    <div class="bg-gray-50 p-4 rounded-lg border">
                        <h4 class="font-bold text-gray-700 mb-3 uppercase text-xs tracking-wider border-b pb-1">Other Cash</h4>
                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <label class="block text-xs font-bold text-gray-500 mb-1">Precounted Bills</label>
                                <input type="number" id="precounted-bills" min="0" step="0.01" class="w-full border rounded p-2 text-right focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm" placeholder="0.00">
                            </div>
                            <div>
                                <label class="block text-xs font-bold text-gray-500 mb-1">Precounted Coins</label>
                                <input type="number" id="precounted-coins" min="0" step="0.01" class="w-full border rounded p-2 text-right focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm" placeholder="0.00">
                            </div>
                        </div>
                    </div>

                    <!-- Cashout -->
                    <div class="bg-gray-50 p-4 rounded-lg border">
                        <h4 class="font-bold text-gray-700 mb-3 uppercase text-xs tracking-wider border-b pb-1">Remittance (Cashout)</h4>
                        <div class="flex items-center gap-2">
                            <label class="text-sm text-gray-600 flex-1">Total Remitted:</label>
                            <input type="number" id="shift-cashout" min="0" step="0.01" class="w-32 border rounded p-2 text-right bg-gray-100 font-bold text-gray-700 cursor-not-allowed text-sm" readonly placeholder="0.00">
                        </div>
                    </div>

                    <!-- Expenses -->
                    <div class="flex-1 flex flex-col bg-gray-50 p-4 rounded-lg border min-h-[150px]">
                        <div class="flex justify-between items-center mb-2 border-b pb-1">
                            <h4 class="font-bold text-gray-700 uppercase text-xs tracking-wider">Expense Receipts</h4>
                            <div class="flex gap-1">
                                <button id="btn-pick-shift-receipt" class="text-[10px] bg-purple-100 text-purple-600 px-2 py-1 rounded font-bold hover:bg-purple-200 transition uppercase tracking-wide">Pick Exp</button>
                                <button id="btn-add-shift-receipt" class="text-[10px] bg-blue-100 text-blue-600 px-2 py-1 rounded font-bold hover:bg-blue-200 transition uppercase tracking-wide">+ Add</button>
                            </div>
                        </div>
                        <div class="flex-1 overflow-y-auto max-h-40 space-y-2 pr-2" id="shift-receipts-list">
                            <!-- Receipts injected here -->
                        </div>
                    </div>
                </div>

                <!-- Column 3: Summary (4 cols) -->
                <div class="lg:col-span-4 flex flex-col h-full overflow-y-auto pl-2">
                    <h4 class="font-bold text-gray-700 uppercase text-xs tracking-wider mb-4 border-b pb-2">Shift Summary</h4>
                    
                    <!-- Totals Breakdown -->
                    <div class="space-y-3">
                        <div class="flex justify-between items-center p-3 bg-blue-50 rounded border border-blue-100">
                            <span class="text-xs font-bold text-blue-500 uppercase">Physical Cash</span>
                            <span id="summary-physical-total" class="font-mono font-bold text-blue-700">₱0.00</span>
                        </div>
                        
                        <div class="flex justify-between items-center p-3 bg-gray-50 rounded border border-gray-200">
                            <span class="text-xs font-bold text-gray-500 uppercase">Precounted</span>
                            <span id="summary-precounted-total" class="font-mono font-bold text-gray-700">₱0.00</span>
                        </div>

                        <div class="flex justify-between items-center p-3 bg-purple-50 rounded border border-purple-100">
                            <span class="text-xs font-bold text-purple-500 uppercase">Remittance</span>
                            <span id="summary-remittance-total" class="font-mono font-bold text-purple-700">₱0.00</span>
                        </div>

                        <div class="flex justify-between items-center p-3 bg-red-50 rounded border border-red-100">
                            <span class="text-xs font-bold text-red-500 uppercase">Expenses</span>
                            <span id="summary-expenses-total" class="font-mono font-bold text-red-700">₱0.00</span>
                        </div>

                        <div id="row-summary-non-cash" class="flex justify-between items-center p-3 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded cursor-pointer transition-colors">
                            <div class="flex items-center gap-1.5">
                                <span class="text-xs font-bold text-teal-700 uppercase">Non-Cash Payments</span>
                                <svg class="w-3.5 h-3.5 text-teal-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                            </div>
                            <span id="summary-non-cash-total" class="font-mono font-bold text-teal-800">₱0.00</span>
                        </div>
                    </div>

                    <!-- Final Summary -->
                    <div class="mt-auto pt-6">
                        <div class="flex justify-between items-end mb-1">
                            <span class="text-gray-600 font-medium">Total Turnover</span>
                            <span id="shift-total-turnover" class="text-4xl font-bold text-gray-800 leading-none">₱0.00</span>
                        </div>
                        <p class="text-[10px] text-gray-400 text-right mb-6">Sum of Physical + Precounted + Remittance + Expenses</p>
                        
                        <div class="grid grid-cols-2 gap-4">
                            <button id="btn-cancel-close-shift" class="w-full bg-white border border-gray-300 text-gray-700 font-bold py-3 rounded-lg hover:bg-gray-50 transition">Cancel</button>
                            <button id="btn-confirm-close-shift" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg shadow-lg transition transform hover:scale-105">Save Changes</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modalDiv);

    const pickDiv = document.createElement("div");
    pickDiv.id = "modal-pick-expense";
    pickDiv.className = "fixed inset-0 bg-gray-600 bg-opacity-50 hidden flex items-center justify-center z-[60]";
    pickDiv.innerHTML = `
        <div class="bg-white rounded-lg shadow-lg p-6 w-full max-w-lg h-[60vh] flex flex-col">
            <div class="flex justify-between items-center mb-4">
                <h3 class="text-xl font-bold text-gray-800">Pick Shift's Expenses</h3>
                <button id="btn-close-pick-expense" class="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
            </div>
            <div class="mb-2">
                 <input type="text" id="pick-expense-search" placeholder="Search expenses..." class="w-full p-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-purple-500">
            </div>
            <div class="flex-1 overflow-y-auto border rounded bg-gray-50 p-2" id="pick-expense-list">
                <div class="text-center text-gray-400 italic mt-4">Loading...</div>
            </div>
            <div class="mt-4 flex justify-end gap-2">
                <button id="btn-cancel-pick-expense" class="bg-gray-500 hover:bg-gray-600 text-white font-bold py-2 px-4 rounded">Cancel</button>
                <button id="btn-confirm-pick-expense" class="bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded shadow">Add Selected</button>
            </div>
        </div>
    `;
    document.body.appendChild(pickDiv);

    const grid = document.getElementById("cash-counter-grid");
    const receiptsList = document.getElementById("shift-receipts-list");

    document.getElementById("precounted-bills").value = shift.precounted_bills !== undefined ? shift.precounted_bills : "";
    document.getElementById("precounted-coins").value = shift.precounted_coins !== undefined ? shift.precounted_coins : "";

    const totalRemittance = (shift.remittances || []).reduce((sum, r) => sum + (r.amount || 0), 0);
    document.getElementById("shift-cashout").value = totalRemittance.toFixed(2);

    const denoms = [1000, 500, 200, 100, 50, 20, 10, 5, 1, 0.01];
    const labels = ["1000", "500", "200", "100", "50", "20", "10", "5", "1", "Cents"];
    const cashBreakdown = shift.cash_breakdown || {};

    grid.innerHTML = denoms.map((d, i) => `
        <div class="grid grid-cols-3 gap-4 items-center py-2 border-b border-gray-200 last:border-0 hover:bg-white transition px-2 rounded">
            <label class="text-sm font-bold text-gray-600">${labels[i]}</label>
            <input type="number" min="0" step="1" 
                class="w-full border rounded p-2 text-sm text-center denom-input focus:ring-2 focus:ring-blue-500 outline-none font-mono" 
                data-denom="${d}" 
                value="${cashBreakdown[d] !== undefined ? cashBreakdown[d] : ''}"
                placeholder="0"
                ${i === 0 ? 'id="first-denom-input"' : ''}>
            <div class="text-right text-sm font-mono text-gray-800 font-bold denom-subtotal">₱0.00</div>
        </div>
    `).join('');

    const updateTotals = () => {
        let cashTotal = 0;
        grid.querySelectorAll(".denom-input").forEach(input => {
            const denom = parseFloat(input.dataset.denom);
            const count = parseInt(input.value) || 0;
            const subtotal = denom * count;
            cashTotal += subtotal;
            input.nextElementSibling.textContent = `₱${subtotal.toFixed(2)}`;
        });

        document.getElementById("summary-physical-total").textContent = `₱${cashTotal.toFixed(2)}`;

        const preBills = parseFloat(document.getElementById("precounted-bills").value) || 0;
        const preCoins = parseFloat(document.getElementById("precounted-coins").value) || 0;
        const precountedTotal = preBills + preCoins;
        document.getElementById("summary-precounted-total").textContent = `₱${precountedTotal.toFixed(2)}`;

        let receiptTotal = 0;
        receiptsList.querySelectorAll(".receipt-row").forEach(row => {
            const amt = parseFloat(row.querySelector(".receipt-amount").value) || 0;
            receiptTotal += amt;
        });
        document.getElementById("summary-expenses-total").textContent = `₱${receiptTotal.toFixed(2)}`;

        const cashout = parseFloat(document.getElementById("shift-cashout").value) || 0;
        document.getElementById("summary-remittance-total").textContent = `₱${cashout.toFixed(2)}`;

        const grandTotal = cashTotal + precountedTotal + receiptTotal + cashout;
        document.getElementById("shift-total-turnover").textContent = `₱${grandTotal.toFixed(2)}`;

        modalDiv.dataset.cashTotal = (cashTotal + precountedTotal);
        modalDiv.dataset.cashout = cashout;
        modalDiv.dataset.grandTotal = grandTotal;
    };

    const addReceiptRow = (desc = "", amount = "") => {
        const row = document.createElement("div");
        row.className = "flex gap-2 receipt-row";
        row.innerHTML = `
            <input type="text" placeholder="Description" class="flex-1 border rounded p-1 text-xs receipt-desc outline-none focus:ring-1 focus:ring-blue-500" value="${desc}">
            <input type="number" placeholder="Amount" class="w-24 border rounded p-1 text-xs text-right receipt-amount outline-none focus:ring-1 focus:ring-blue-500" step="0.01" value="${amount}">
            <button class="text-red-500 hover:text-red-700 btn-remove-receipt">&times;</button>
        `;
        row.querySelector(".btn-remove-receipt").onclick = () => {
            row.remove();
            updateTotals();
        };
        row.querySelector(".receipt-amount").oninput = updateTotals;
        receiptsList.appendChild(row);
        return row;
    };

    const receipts = shift.closing_receipts || [];
    receipts.forEach(r => {
        addReceiptRow(r.description, r.amount);
    });

    document.getElementById("btn-add-shift-receipt").onclick = () => {
        const row = addReceiptRow();
        row.querySelector(".receipt-desc").focus();
    };

    document.getElementById("precounted-bills").addEventListener("input", updateTotals);
    document.getElementById("precounted-coins").addEventListener("input", updateTotals);

    getShiftFinancials(shift).then(financials => {
        const el = document.getElementById("summary-non-cash-total");
        if (el) el.textContent = `₱${(financials.non_cash || 0).toFixed(2)}`;
    });
    document.getElementById("row-summary-non-cash")?.addEventListener("click", () => showNonCashPaymentsModal(shift));

    grid.querySelectorAll(".denom-input").forEach(input => {
        input.addEventListener("input", updateTotals);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const nextInput = input.closest('.grid-cols-3')?.nextElementSibling?.querySelector('.denom-input');
                if (nextInput) nextInput.focus();
                else document.getElementById("btn-confirm-close-shift").focus();
            }
        });
    });

    const cleanupModals = () => {
        modalDiv.remove();
        pickDiv.remove();
    };

    document.getElementById("btn-cancel-close-shift").onclick = cleanupModals;
    document.getElementById("btn-cancel-close-shift-x").onclick = cleanupModals;

    const pickModalEl = document.getElementById("modal-pick-expense");
    const pickList = document.getElementById("pick-expense-list");
    const pickSearch = document.getElementById("pick-expense-search");

    document.getElementById("btn-pick-shift-receipt").onclick = async () => {
        pickModalEl.classList.remove("hidden");
        pickList.innerHTML = '<div class="text-center text-gray-500 p-4">Loading expenses...</div>';

        let todayExpenses = [];
        let selectedOrderedIds = [];

        try {
            const allExpenses = await Repository.getAll('expenses');
            const shiftDateStr = new Date(shift.start_time).toLocaleDateString('en-CA');

            todayExpenses = allExpenses.filter(e => e.date === shiftDateStr);
            todayExpenses.sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());

            const renderExpenses = (filterText = "") => {
                const term = filterText.toLowerCase();
                const filtered = todayExpenses.filter(e =>
                    e.description.toLowerCase().includes(term) ||
                    (e.supplier_name && e.supplier_name.toLowerCase().includes(term))
                );

                pickList.innerHTML = "";
                if (filtered.length === 0) {
                    pickList.innerHTML = `<div class="text-center text-gray-400 p-2 text-sm">No matching expenses found for ${shiftDateStr}.</div>`;
                    return;
                }

                filtered.forEach(exp => {
                    const div = document.createElement("div");
                    div.className = "flex items-center gap-2 p-2 border-b last:border-0 hover:bg-purple-50 cursor-pointer select-none";
                    const isChecked = selectedOrderedIds.includes(exp.id);

                    div.innerHTML = `
                        <input type="checkbox" class="form-checkbox h-4 w-4 text-purple-600 cursor-pointer exp-checkbox" 
                            data-id="${exp.id}"
                            data-desc="${exp.description}" 
                            data-amt="${exp.amount}" 
                            data-supplier="${exp.supplier_name || ''}"
                            ${isChecked ? 'checked' : ''}>
                        <div class="flex-1 text-sm">
                            <div class="font-bold text-gray-700">${exp.description}</div>
                            <div class="text-[10px] text-gray-500">${exp.supplier_name || 'No Supplier'}</div>
                        </div>
                        <div class="font-bold text-gray-800">₱${exp.amount.toFixed(2)}</div>
                    `;

                    const cb = div.querySelector("input[type='checkbox']");
                    div.addEventListener("click", (e) => {
                        if (e.target !== cb) {
                            cb.click();
                        }
                    });

                    cb.addEventListener("change", (e) => {
                        if (e.target.checked) {
                            if (!selectedOrderedIds.includes(exp.id)) {
                                selectedOrderedIds.push(exp.id);
                            }
                        } else {
                            selectedOrderedIds = selectedOrderedIds.filter(id => id !== exp.id);
                        }
                    });

                    pickList.appendChild(div);
                });
            };

            renderExpenses();
            pickSearch.oninput = (e) => renderExpenses(e.target.value);
            pickSearch.value = "";
            pickSearch.focus();

        } catch (err) {
            console.error(err);
            pickList.innerHTML = '<div class="text-center text-red-500 p-2">Error loading expenses.</div>';
        }

        const closePickModal = () => pickModalEl.classList.add("hidden");
        document.getElementById("btn-close-pick-expense").onclick = closePickModal;
        document.getElementById("btn-cancel-pick-expense").onclick = closePickModal;

        document.getElementById("btn-confirm-pick-expense").onclick = () => {
            selectedOrderedIds.forEach(id => {
                const exp = todayExpenses.find(e => e.id === id);
                if (exp) {
                    const supplier = exp.supplier_name;
                    const finalDesc = supplier ? `${exp.description} (${supplier})` : exp.description;
                    addReceiptRow(finalDesc, exp.amount);
                }
            });
            updateTotals();
            closePickModal();
        };
    };

    document.getElementById("btn-confirm-close-shift").addEventListener("click", async () => {
        const cashTotal = parseFloat(modalDiv.dataset.cashTotal) || 0;
        const cashout = parseFloat(modalDiv.dataset.cashout) || 0;
        const grandTotal = parseFloat(modalDiv.dataset.grandTotal) || 0;

        const receipts = [];
        receiptsList.querySelectorAll(".receipt-row").forEach(row => {
            const desc = row.querySelector(".receipt-desc").value.trim();
            const amt = parseFloat(row.querySelector(".receipt-amount").value) || 0;
            if (desc && amt > 0) receipts.push({ description: desc, amount: amt });
        });

        try {
            const targetShift = await Repository.get('shifts', shift.id);
            if (targetShift) {
                targetShift.closing_cash = cashTotal;
                targetShift.precounted_bills = parseFloat(document.getElementById("precounted-bills").value) || 0;
                targetShift.precounted_coins = parseFloat(document.getElementById("precounted-coins").value) || 0;
                targetShift.cashout = cashout;
                targetShift.closing_receipts = receipts;
                targetShift.total_closing_amount = grandTotal;

                const cashBreakdown = {};
                grid.querySelectorAll(".denom-input").forEach(input => {
                    const denom = input.dataset.denom;
                    const count = parseInt(input.value) || 0;
                    if (count > 0) cashBreakdown[denom] = count;
                });
                targetShift.cash_breakdown = cashBreakdown;

                targetShift._version = (targetShift._version || 0) + 1;
                targetShift._updatedAt = Date.now();

                const financials = await getShiftFinancials(targetShift);
                targetShift.expected_cash = financials.gross_accountability;
                targetShift.variance = grandTotal - financials.gross_accountability;

                await Repository.upsert('shifts', targetShift);
                cleanupModals();

                try {
                    await SyncEngine.sync();
                } catch (syncErr) {
                    console.warn("Sync failed (saved locally):", syncErr);
                }

                alert("Shift updated successfully.");
                selectShift(targetShift);
                await fetchShifts();
            }
        } catch (error) {
            console.error("Error saving shift edit:", error);
            alert("Failed to save changes.");
        }
    });

    updateTotals();
}

export async function showCloseShiftModal(onSuccess) {
    let modal = document.getElementById("modal-close-shift");
    if (modal) modal.remove();

    const activeShift = await checkActiveShift();
    const activeFinancials = await getShiftFinancials(activeShift);
    const nonCashTotal = activeFinancials ? activeFinancials.non_cash : 0;

    const div = document.createElement("div");
    div.id = "modal-close-shift";
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-90 flex items-center justify-center z-50 overflow-y-auto";

    // We'll track expenses added during this modal session
    let sessionExpenses = [];

    const renderShiftUI = () => {
        const cashValue = document.getElementById("shift-closing-cash")?.value || "";
        const cashInput = parseFloat(cashValue) || 0;
        const totalExpenses = sessionExpenses.reduce((s, e) => s + e.amount, 0);
        const GRAND_TOTAL = cashInput + totalExpenses;

        const expenseRows = sessionExpenses.map((exp, idx) => `
            <div class="flex justify-between items-center bg-gray-50 border rounded p-2 mb-1 group">
                <div class="flex-1">
                    <div class="text-xs font-bold text-gray-800">${exp.description}</div>
                    <div class="text-[10px] text-gray-500 uppercase">${exp.category}</div>
                </div>
                <div class="text-sm font-black text-red-600 mr-2">₱${exp.amount.toFixed(2)}</div>
                <button type="button" class="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition btn-remove-session-exp" data-idx="${idx}">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
        `).join("");

        const body = `
            <div class="bg-white rounded-xl shadow-2xl p-8 w-full max-w-md my-8">
                <h2 class="text-2xl font-black text-gray-800 mb-2 text-center">End Shift</h2>
                <div class="text-center text-gray-500 text-xs mb-6 font-medium uppercase tracking-widest">Verify accountability</div>
                
                <div id="shift-summary-view" class="hidden">
                    <div class="bg-gray-50 rounded-lg p-6 mb-6 border-dashed border-2 border-gray-200">
                        <div class="flex justify-between mb-2">
                            <span class="text-sm text-gray-500">Expected (Net Cash):</span>
                            <span id="summary-expected" class="font-bold text-gray-800"></span>
                        </div>
                        <div class="flex justify-between mb-4">
                            <span class="text-sm text-gray-500">Actual (Cash + Exp):</span>
                            <span id="summary-actual" class="font-bold text-blue-600"></span>
                        </div>
                        <div class="border-t pt-4">
                            <div class="text-xs text-center text-gray-400 uppercase font-black mb-1">Total Variance</div>
                            <div id="summary-diff" class="text-center"></div>
                        </div>
                    </div>
                    <button id="btn-finish-shift" class="w-full bg-gray-800 hover:bg-black text-white font-black py-4 rounded-xl shadow-lg transition transform hover:scale-[1.02]">
                        PRINT & COMPLETE
                    </button>
                </div>

                <form id="form-close-shift" class="space-y-6">
                    <div class="bg-blue-50 p-4 rounded-xl border border-blue-100">
                        <label class="block text-blue-800 text-[10px] font-black uppercase mb-1">Cash in Drawer (Turn-over)</label>
                        <input type="number" id="shift-closing-cash" value="${cashValue}" class="w-full bg-white border-2 border-blue-200 rounded-lg py-3 px-4 text-gray-800 focus:border-blue-500 outline-none text-2xl font-black text-center" step="0.01" required min="0" placeholder="0.00">
                    </div>

                    <div>
                        <div class="flex justify-between items-center mb-2">
                             <label class="text-[10px] font-black text-gray-400 uppercase">Expense Receipts</label>
                             <div class="flex gap-2">
                                <button type="button" id="btn-add-receipt-main" class="text-[10px] font-black bg-blue-50 text-blue-600 px-2 py-1 rounded border border-blue-200 hover:bg-blue-100">+ Add Receipt</button>
                             </div>
                        </div>
                        <div id="session-expenses-list" class="max-h-40 overflow-y-auto mb-3">
                            ${expenseRows || '<div class="text-center py-4 text-gray-300 text-xs italic border-2 border-dashed rounded-lg">No receipts added</div>'}
                        </div>

                        <div id="btn-view-non-cash-main" class="p-3 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-xl cursor-pointer transition-colors flex justify-between items-center">
                            <div class="flex items-center gap-2">
                                <svg class="w-4 h-4 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                                <span class="text-[10px] font-black text-teal-800 uppercase">Non-Cash Payments (Card/E-Wallet/Points)</span>
                            </div>
                            <span class="text-sm font-black text-teal-700">₱${nonCashTotal.toFixed(2)}</span>
                        </div>
                    </div>

                    <div class="bg-gray-900 text-white p-4 rounded-xl shadow-inner">
                        <div class="flex justify-between text-[10px] font-black text-gray-400 uppercase mb-1">
                            <span>Subtotal (Exp + Cash)</span>
                            <span class="text-red-400">₱${totalExpenses.toFixed(2)} Receipts</span>
                        </div>
                        <div class="flex justify-between items-center">
                            <div class="text-3xl font-black">₱${GRAND_TOTAL.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
                            <div class="text-[10px] bg-white/10 px-2 py-1 rounded">CASHIER POS</div>
                        </div>
                    </div>

                    <div class="flex gap-2">
                        <button type="button" id="btn-cancel-close-shift" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold py-3 px-4 rounded-lg transition">Cancel</button>
                        <button type="submit" class="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-4 rounded-lg shadow-md transition">Confirm Closure</button>
                    </div>
                </form>
            </div>
        `;
        console.log("DEBUG: renderShiftUI generating body with buttons:", body.includes("btn-select-modal-exp") ? "YES" : "NO");
        div.innerHTML = body;

        // Bind inner actions
        document.getElementById("btn-view-non-cash-main")?.addEventListener("click", () => {
            showNonCashPaymentsModal(activeShift);
        });
        document.getElementById("btn-add-receipt-main").addEventListener("click", () => {
            showAddReceiptPrompt((choice) => {
                if (choice === 'existing') {
                    showExpenseSelector((selectedExp) => {
                        sessionExpenses.push(selectedExp);
                        renderShiftUI();
                    }, sessionExpenses);
                } else if (choice === 'new') {
                    showMiniExpenseForm((newExp) => {
                        sessionExpenses.push(newExp);
                        renderShiftUI();
                    });
                }
            });
        });

        document.querySelectorAll(".btn-remove-session-exp").forEach(btn => {
            btn.addEventListener("click", (e) => {
                const idx = e.currentTarget.dataset.idx;
                sessionExpenses.splice(idx, 1);
                renderShiftUI();
            });
        });

        document.getElementById("shift-closing-cash").addEventListener("input", () => {
            const val = parseFloat(document.getElementById("shift-closing-cash").value) || 0;
            const expTotal = sessionExpenses.reduce((s, e) => s + e.amount, 0);
            const total = val + expTotal;
            document.querySelector(".text-3xl.font-black").textContent = `₱${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        });

        document.getElementById("btn-cancel-close-shift").addEventListener("click", () => div.remove());

        document.getElementById("form-close-shift").addEventListener("submit", async (e) => {
            e.preventDefault();
            const amount = document.getElementById("shift-closing-cash").value;

            try {
                // Record session expenses to the shift and regular expense table
                const active = await checkActiveShift();
                if (active) {
                    if (!active.closing_receipts) active.closing_receipts = [];
                    for (const exp of sessionExpenses) {
                        // If it's linked, we don't save it to the 'expenses' table again, just to the shift receipts
                        if (exp._isLinked) {
                            active.closing_receipts.push({
                                ...exp,
                                linked_expense_id: exp.id // Keep reference
                            });
                        } else {
                            // New expense created in modal
                            const expenseRecord = {
                                id: generateUUID(),
                                ...exp,
                                date: new Date().toISOString().split('T')[0],
                                user_id: active.user_id,
                                created_at: new Date()
                            };
                            // Save to global expenses
                            try {
                                await Repository.upsert('expenses', expenseRecord);
                                active.closing_receipts.push(expenseRecord);
                            } catch (e) {
                                console.error("Error saving new expense", e);
                            }
                        }
                    }
                    await Repository.upsert('shifts', active);
                    currentShift = active;
                }

                const summary = await closeShift(amount);

                document.getElementById("form-close-shift").classList.add("hidden");
                document.getElementById("shift-summary-view").classList.remove("hidden");
                document.getElementById("summary-expected").textContent = `₱${summary.expected.toFixed(2)}`;
                document.getElementById("summary-actual").textContent = `₱${(summary.actual + totalExpenses).toFixed(2)}`;

                const diffEl = document.getElementById("summary-diff");
                diffEl.textContent = `₱${summary.difference.toFixed(2)}`;
                diffEl.className = `text-4xl font-black ${summary.difference < 0 ? 'text-red-600' : (summary.difference > 0 ? 'text-green-600' : 'text-gray-800')}`;

                document.getElementById("btn-finish-shift").addEventListener("click", () => {
                    div.remove();
                    if (onSuccess) onSuccess();
                });
            } catch (error) {
                console.error("Error closing shift:", error);
                alert("Failed to close shift: " + error.message);
            }
        });
    };

    document.body.appendChild(div);
    renderShiftUI();
}

function showMiniExpenseForm(onSave) {
    const div = document.createElement("div");
    div.className = "fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-[100]";
    div.innerHTML = `
        <div class="bg-white rounded-xl shadow-2xl p-6 w-80 transform scale-in">
            <h3 class="font-black text-gray-800 mb-4 text-center uppercase tracking-wider">New Receipt</h3>
            <form id="mini-exp-form" class="space-y-4">
                <div>
                    <label class="block text-[10px] font-black text-gray-400 uppercase mb-1">Description</label>
                    <input type="text" id="mini-desc" class="w-full border rounded-lg p-2 text-sm focus:ring-2 focus:ring-red-500 outline-none" placeholder="e.g. Drinking Water" required>
                </div>
                <div>
                    <label class="block text-[10px] font-black text-gray-400 uppercase mb-1">Amount</label>
                    <input type="number" id="mini-amount" class="w-full border rounded-lg p-2 font-black text-lg focus:ring-2 focus:ring-red-500 outline-none" placeholder="0.00" step="0.01" required>
                </div>
                <div>
                    <label class="block text-[10px] font-black text-gray-400 uppercase mb-1">Category</label>
                    <select id="mini-cat" class="w-full border rounded-lg p-2 text-sm">
                        <option value="Karinderya">Karinderya</option>
                        <option value="Procurement">Procurement</option>
                        <option value="Utilities">Utilities</option>
                        <option value="Salary">Salary</option>
                        <option value="Maintenance">Maintenance</option>
                        <option value="Other">Other</option>
                    </select>
                </div>
                <div class="flex gap-2 pt-2">
                    <button type="button" id="btn-mini-cancel" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-500 font-bold py-2 rounded-lg">Back</button>
                    <button type="submit" class="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-2 rounded-lg shadow-md">Add</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(div);

    document.getElementById("btn-mini-cancel").addEventListener("click", () => div.remove());
    document.getElementById("mini-exp-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const data = {
            description: document.getElementById("mini-desc").value,
            amount: parseFloat(document.getElementById("mini-amount").value),
            category: document.getElementById("mini-cat").value
        };
        onSave(data);
        div.remove();
    });
}

export function showAdjustCashModal(shiftId, onSuccess) {
    let modal = document.getElementById("modal-adjust-cash");

    if (!modal) {
        const div = document.createElement("div");
        div.innerHTML = `
            <div id="modal-adjust-cash" class="fixed inset-0 bg-gray-900 bg-opacity-90 flex items-center justify-center z-50">
                <div class="bg-white rounded-lg shadow-xl p-8 w-96">
                    <h2 class="text-2xl font-bold text-gray-800 mb-4 text-center">Adjust Cash</h2>
                    <p class="text-gray-600 text-sm mb-6 text-center">Enter amount to add (positive) or remove (negative).</p>
                    
                    <form id="form-adjust-cash">
                        <div class="mb-4">
                            <label class="block text-gray-700 text-sm font-bold mb-2">Amount (PHP)</label>
                            <input type="number" id="adjust-amount" class="shadow appearance-none border rounded w-full py-3 px-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500 text-xl text-center" step="0.01" required>
                        </div>
                        <div class="mb-6">
                            <label class="block text-gray-700 text-sm font-bold mb-2">Reason</label>
                            <input type="text" id="adjust-reason" class="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-500" required placeholder="e.g. Petty Cash Replenish">
                        </div>
                        <div class="flex gap-2">
                            <button type="button" id="btn-cancel-adjust" class="w-1/2 bg-gray-500 hover:bg-gray-600 text-white font-bold py-3 px-4 rounded">Cancel</button>
                            <button type="submit" class="w-1/2 bg-yellow-600 hover:bg-yellow-700 text-white font-bold py-3 px-4 rounded">Save</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
        document.body.appendChild(div.firstElementChild);
        modal = document.getElementById("modal-adjust-cash");

        document.getElementById("btn-cancel-adjust").addEventListener("click", () => modal.remove());

        document.getElementById("form-adjust-cash").addEventListener("submit", async (e) => {
            e.preventDefault();
            const amount = document.getElementById("adjust-amount").value;
            const reason = document.getElementById("adjust-reason").value;
            try {
                await adjustCash(shiftId, amount, reason);
                modal.remove();
                if (onSuccess) onSuccess();
            } catch (error) {
                console.error("Error adjusting cash:", error);
                alert("Failed to adjust cash.");
            }
        });
    } else {
        modal.classList.remove("hidden");
    }
}

async function adjustCash(shiftId, amount, reason) {
    if (!checkPermission("shifts", "write")) {
        alert("You do not have permission to adjust shift cash.");
        return;
    }

    if (!(await requestManagerApproval())) return;

    const user = getCurrentUser();

    const adjustment = {
        amount: parseFloat(amount),
        reason: reason,
        timestamp: new Date(),
        user: user ? user.email : 'unknown'
    };

    // Optimistic update: Update local DB first
    const shift = await Repository.get('shifts', shiftId);
    if (shift) {
        if (!shift.adjustments) shift.adjustments = [];
        shift.adjustments.push(adjustment);

        if (shift.status === 'closed') {
            shift.closing_cash = (shift.closing_cash || 0) + adjustment.amount;
        } else {
            shift.expected_cash = (shift.expected_cash || 0) + adjustment.amount;
        }

        await Repository.upsert('shifts', shift);
        SyncEngine.sync();
    }

    await addNotification('Adjustment', `Cash adjustment of ₱${adjustment.amount} for shift ${shiftId} by ${user ? user.email : 'unknown'}`);

    if (currentShift && currentShift.id === shiftId) {
        if (!currentShift.adjustments) currentShift.adjustments = [];
        currentShift.adjustments.push(adjustment);
        currentShift.expected_cash = (currentShift.expected_cash || 0) + adjustment.amount;
    }
}

export function showShiftHistoryModal(adjustments) {
    let modal = document.getElementById("modal-shift-history");
    if (modal) modal.remove();

    const div = document.createElement("div");
    div.id = "modal-shift-history";
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-90 flex items-center justify-center z-50";

    let rows = "";
    if (!adjustments || adjustments.length === 0) {
        rows = `<tr><td colspan="4" class="py-8 text-center text-gray-500 italic">No adjustments recorded for this shift.</td></tr>`;
    } else {
        // Sort by timestamp desc
        const sorted = [...adjustments].sort((a, b) => {
            const tA = new Date(a.timestamp);
            const tB = new Date(b.timestamp);
            return tB - tA;
        });

        rows = sorted.map(adj => {
            const date = new Date(adj.timestamp).toLocaleString();
            const amtClass = adj.amount >= 0 ? 'text-green-600' : 'text-red-600';
            const sign = adj.amount >= 0 ? '+' : '-';
            return `
                <tr class="border-b border-gray-100 hover:bg-gray-50 transition">
                    <td class="py-3 px-4 text-xs text-gray-500">${date}</td>
                    <td class="py-3 px-4 text-sm font-medium text-gray-700">${adj.user || 'System'}</td>
                    <td class="py-3 px-4 text-sm text-gray-600">${adj.reason}</td>
                    <td class="py-3 px-4 text-right font-bold ${amtClass}">${sign}₱${Math.abs(adj.amount).toFixed(2)}</td>
                </tr>
            `;
        }).join("");
    }

    div.innerHTML = `
        <div class="bg-white rounded-lg shadow-2xl p-6 w-full max-w-2xl transform transition-all">
            <div class="flex justify-between items-center mb-6 border-b pb-4">
                <h2 class="text-xl font-bold text-gray-800">Shift Adjustment History</h2>
                <button id="close-history-modal-x" class="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
            </div>
            <div class="overflow-x-auto max-h-[60vh] rounded-lg border border-gray-200">
                <table class="min-w-full table-auto">
                    <thead class="bg-gray-50">
                        <tr class="text-xs uppercase text-gray-500 font-bold tracking-wider">
                            <th class="py-3 px-4 text-left">Date & Time</th>
                            <th class="py-3 px-4 text-left">User</th>
                            <th class="py-3 px-4 text-left">Reason</th>
                            <th class="py-3 px-4 text-right">Amount</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">
                        ${rows}
                    </tbody>
                </table>
            </div>
            <div class="mt-8 flex justify-end">
                <button id="btn-close-history" class="bg-gray-800 hover:bg-gray-900 text-white px-6 py-2 rounded-lg font-bold transition shadow-md">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(div);

    const closeModal = () => div.remove();
    document.getElementById("close-history-modal-x").addEventListener("click", closeModal);
    document.getElementById("btn-close-history").addEventListener("click", closeModal);
}

export function showRemittanceHistoryModal(shift) {
    let modal = document.getElementById("modal-remittance-history");
    if (modal) modal.remove();

    const remittances = shift.remittances || [];
    const div = document.createElement("div");
    div.id = "modal-remittance-history";
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-90 flex items-center justify-center z-50";

    let rows = remittances && remittances.length > 0
        ? remittances.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).map(r => `
            <tr class="border-b border-gray-100 hover:bg-gray-50 transition">
                <td class="py-3 px-4 text-xs text-gray-500">${new Date(r.timestamp).toLocaleString()}</td>
                <td class="py-3 px-4 text-sm font-medium text-gray-700">${r.user || 'System'}</td>
                <td class="py-3 px-4 text-sm text-gray-600">${r.reason}</td>
                <td class="py-3 px-4 text-right font-bold text-purple-600">₱${r.amount.toFixed(2)}</td>
            </tr>
        `).join("")
        : `<tr><td colspan="4" class="py-8 text-center text-gray-500 italic">No remittances recorded for this shift.</td></tr>`;

    div.innerHTML = `
        <div class="bg-white rounded-lg shadow-2xl p-6 w-full max-w-2xl">
            <div class="flex justify-between items-center mb-6 border-b pb-4">
                <h2 class="text-xl font-bold text-gray-800">Shift Remittance History</h2>
                ${shift.status === 'open' ? `<button id="btn-add-remit-modal" class="bg-purple-600 text-white px-3 py-1 rounded text-sm font-bold hover:bg-purple-700">+ Add Remittance</button>` : ''}
                <button id="close-remit-modal-x" class="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
            </div>
            <div class="overflow-x-auto max-h-[60vh] rounded-lg border border-gray-200">
                <table class="min-w-full table-auto">
                    <thead class="bg-gray-50">
                        <tr class="text-xs uppercase text-gray-500 font-bold tracking-wider">
                            <th class="py-3 px-4 text-left">Date & Time</th>
                            <th class="py-3 px-4 text-left">User</th>
                            <th class="py-3 px-4 text-left">Reason</th>
                            <th class="py-3 px-4 text-right">Amount</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">
                        ${rows}
                    </tbody>
                </table>
            </div>
            <div class="mt-8 flex justify-end">
                <button id="btn-close-remit-history" class="bg-gray-800 hover:bg-gray-900 text-white px-6 py-2 rounded-lg font-bold transition shadow-md">Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(div);
    const closeModal = () => div.remove();
    document.getElementById("close-remit-modal-x").addEventListener("click", closeModal);
    document.getElementById("btn-close-remit-history").addEventListener("click", closeModal);
    if (shift.status === 'open') {
        document.getElementById("btn-add-remit-modal").addEventListener("click", () => showAddRemittanceModal(closeModal));
    }
}

export async function showXReport() {
    if (!currentShift) {
        alert("No active shift found.");
        return;
    }

    // Calculate live metrics
    const txs = await Repository.getAll('transactions');
    const shiftTxs = txs.filter(t => {
        const d = new Date(t.timestamp);
        const start = new Date(currentShift.start_time);
        return d >= start && t.user_email === currentShift.user_id && !t.is_voided;
    });

    // Sales by Payment Method
    const payments = {};
    let totalSales = 0;
    shiftTxs.forEach(tx => {
        const method = tx.payment_method || 'Cash';
        payments[method] = (payments[method] || 0) + tx.total_amount;
        totalSales += tx.total_amount;
    });

    const expected = await calculateExpectedCash();
    const settings = await getSystemSettings();
    const store = settings.store || { name: "LightPOS", data: "" };

    // Printer Styles
    const defaultPrint = {
        paper_width: 76,
        header: { font_size: 14, font_family: "monospace", bold: true },
        body: { font_size: 12, font_family: "monospace" }
    };
    const p = { ...defaultPrint, ...(settings.print || {}) };
    const getStyle = (s) => `font-size: ${s.font_size}px; font-family: ${s.font_family}; font-weight: ${s.bold ? 'bold' : 'normal'};`;

    // Construct Report HTML
    const printWindow = window.open('', '_blank', 'width=300,height=600');
    printWindow.document.write(`
        <html>
        <head>
            <style>
                @page { margin: 0; }
                body { width: ${p.paper_width}mm; padding: 5mm; margin: 0; ${getStyle(p.body)} color: #000; }
                .text-center { text-align: center; }
                .text-right { text-align: right; }
                .bold { font-weight: bold; }
                .hr { border-bottom: 1px dashed #000; margin: 5px 0; }
                table { width: 100%; border-collapse: collapse; }
                .header-sec { ${getStyle(p.header)} }
            </style>
        </head>
        <body onload="window.print();window.close();">
            <div class="text-center header-sec">
                ${store.logo ? `<img src="${store.logo}" style="max-width:40mm;max-height:20mm;filter:grayscale(1)"><br>` : ''}
                ${store.name}<br>X-REPORT (Mid-Shift)
            </div>
            <div class="hr"></div>
            <div>
                User: ${currentShift.user_id}<br>
                Start: ${new Date(currentShift.start_time).toLocaleString()}<br>
                Generated: ${new Date().toLocaleString()}
            </div>
            <div class="hr"></div>
            <div class="bold">Opening Cash: <span style="float:right">${(currentShift.opening_cash || 0).toFixed(2)}</span></div>
            <div class="hr"></div>
            <div class="bold">Sales Summary</div>
            <table>
                ${Object.entries(payments).map(([m, a]) => `<tr><td>${m}</td><td class="text-right">${a.toFixed(2)}</td></tr>`).join('')}
            </table>
            <div class="hr"></div>
            <div class="bold" style="font-size:1.1em">Total Sales: <span style="float:right">${totalSales.toFixed(2)}</span></div>
            <div class="bold" style="font-size:1.1em">Expected Cash: <span style="float:right">${expected.toFixed(2)}</span></div>
            <div class="hr"></div>
            <div class="text-center italic">-- End of Report --</div>
        </body>
        </html>
    `);
    printWindow.document.close();
}

function showAddRemittanceModal(onSuccess) {
    const div = document.createElement("div");
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-90 flex items-center justify-center z-[60]";
    div.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl p-8 w-96">
            <h2 class="text-2xl font-bold text-gray-800 mb-4 text-center">Add Remittance</h2>
            <form id="form-add-remit">
                <div class="mb-4">
                    <label class="block text-gray-700 text-sm font-bold mb-2">Amount (PHP)</label>
                    <input type="number" id="new-remit-amount" class="shadow appearance-none border rounded w-full py-3 px-4 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-purple-500 text-xl text-center" step="0.01" required min="0">
                </div>
                <div class="mb-6">
                    <label class="block text-gray-700 text-sm font-bold mb-2">Reason / Reference</label>
                    <input type="text" id="new-remit-reason" class="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:ring-2 focus:ring-purple-500" required placeholder="e.g. Safe Drop">
                </div>
                <div class="flex gap-2">
                    <button type="button" id="btn-cancel-new-remit" class="w-1/2 bg-gray-500 hover:bg-gray-600 text-white font-bold py-3 px-4 rounded">Cancel</button>
                    <button type="submit" class="w-1/2 bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-4 rounded">Save</button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(div);

    document.getElementById("btn-cancel-new-remit").addEventListener("click", () => div.remove());
    document.getElementById("form-add-remit").addEventListener("submit", async (e) => {
        e.preventDefault();
        const amount = document.getElementById("new-remit-amount").value;
        const reason = document.getElementById("new-remit-reason").value;
        try {
            await recordRemittance(amount, reason);
            div.remove();
            if (onSuccess) onSuccess();
            // Refresh shift details
            if (selectedShiftId) {
                const updatedShift = await Repository.get('shifts', selectedShiftId);
                selectShift(updatedShift);
            }
        } catch (error) {
            console.error("Error adding remittance:", error);
            alert("Failed to add remittance: " + error.message);
        }
    });
}

async function showShiftTransactions(shift) {
    const div = document.createElement("div");
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-90 flex items-center justify-center z-50";
    div.innerHTML = `
        <div class="bg-white rounded-lg shadow-2xl p-6 w-full max-w-4xl h-[80vh] flex flex-col">
            <div class="flex justify-between items-center mb-4 border-b pb-4 shrink-0">
                <h2 class="text-xl font-bold text-gray-800">Transactions for Shift</h2>
                <button id="close-tx-modal" class="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
            </div>
            <div class="overflow-y-auto flex-1">
                <table class="min-w-full table-auto">
                    <thead class="bg-gray-50 sticky top-0">
                        <tr class="text-xs uppercase text-gray-500 font-bold tracking-wider">
                            <th class="py-3 px-4 text-left">Time</th>
                            <th class="py-3 px-4 text-left">ID</th>
                            <th class="py-3 px-4 text-left">Customer</th>
                            <th class="py-3 px-4 text-right">Total</th>
                            <th class="py-3 px-4 text-center">Status</th>
                            <th class="py-3 px-4 text-center">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="shift-tx-body" class="divide-y divide-gray-100">
                        <tr><td colspan="6" class="text-center py-4">Loading...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    `;
    document.body.appendChild(div);
    document.getElementById("close-tx-modal").addEventListener("click", () => div.remove());

    const tbody = document.getElementById("shift-tx-body");

    try {
        const allTxs = await Repository.getAll('transactions');
        const start = new Date(shift.start_time);
        const end = shift.end_time ? new Date(shift.end_time) : new Date();

        const entries = [];

        allTxs.forEach(tx => {
            const txDate = new Date(tx.timestamp);
            // 1. Original Sale
            if (txDate >= start && txDate <= end && tx.user_email === shift.user_id) {
                entries.push({ type: 'Sale', data: tx, timestamp: txDate, id: tx.id, total: tx.total_amount, is_voided: tx.is_voided });
            }
            // 2. Exchanges
            if (tx.exchanges && Array.isArray(tx.exchanges)) {
                tx.exchanges.forEach((ex, idx) => {
                    const exDate = new Date(ex.timestamp);
                    if (exDate >= start && exDate <= end && ex.processed_by === shift.user_id) {
                        const returnedTotal = ex.returned.reduce((sum, i) => sum + (i.selling_price * i.qty), 0);
                        const takenTotal = ex.taken.reduce((sum, i) => sum + (i.selling_price * i.qty), 0);
                        entries.push({
                            type: 'Exchange',
                            data: tx,
                            timestamp: exDate,
                            id: `${tx.id}-EX${idx + 1}`,
                            total: takenTotal - returnedTotal,
                            is_voided: false,
                            is_exchange: true
                        });
                    }
                });
            }
        });

        const sortedEntries = entries.sort((a, b) => b.timestamp - a.timestamp);

        if (sortedEntries.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-gray-500 italic">No transactions found for this shift.</td></tr>`;
            return;
        }

        tbody.innerHTML = sortedEntries.map(entry => {
            const tx = entry.data;
            const isExchange = entry.is_exchange;
            const statusColor = entry.is_voided ? 'text-red-600' : (isExchange ? 'text-blue-600' : 'text-green-600');
            const statusText = entry.is_voided ? 'Voided' : (isExchange ? 'Exchange' : 'Valid');

            return `
            <tr class="hover:bg-gray-50 transition ${entry.is_voided ? 'bg-red-50 opacity-75' : ''}">
                <td class="py-2 px-4 text-xs text-gray-600">${entry.timestamp.toLocaleTimeString()}</td>
                <td class="py-2 px-4 text-xs font-mono text-gray-500">${entry.id.slice(-12)}</td>
                <td class="py-2 px-4 text-sm text-gray-800">${tx.customer_name || 'Guest'}</td>
                <td class="py-2 px-4 text-right font-bold text-gray-800">₱${entry.total.toFixed(2)}</td>
                <td class="py-2 px-4 text-center text-xs font-bold uppercase ${statusColor}">${statusText}</td>
                <td class="py-2 px-4 text-center flex justify-center gap-2">
                    ${!isExchange ? `<button class="bg-indigo-100 text-indigo-700 hover:bg-indigo-200 px-2 py-1 rounded text-xs font-bold btn-view-tx" data-id="${tx.id}">View</button>` : ''}
                    ${!isExchange ? `<button class="bg-blue-100 text-blue-700 hover:bg-blue-200 px-2 py-1 rounded text-xs font-bold btn-print-tx" data-id="${tx.id}">Print</button>` : ''}
                    ${!entry.is_voided && !isExchange ? `<button class="bg-red-100 text-red-700 hover:bg-red-200 px-2 py-1 rounded text-xs font-bold btn-void-tx" data-id="${tx.id}">Void</button>` : ''}
                </td>
            </tr>
            `;
        }).join('');

        tbody.querySelectorAll(".btn-view-tx").forEach(btn => {
            btn.addEventListener("click", () => {
                const tx = allTxs.find(t => t.id === btn.dataset.id);
                if (tx) viewShiftTransactionDetails(tx);
            });
        });

        tbody.querySelectorAll(".btn-print-tx").forEach(btn => {
            btn.addEventListener("click", async () => {
                const tx = allTxs.find(t => t.id === btn.dataset.id);
                if (tx) await printTransaction(tx, true);
            });
        });

        tbody.querySelectorAll(".btn-void-tx").forEach(btn => {
            btn.addEventListener("click", async () => {
                await voidShiftTransaction(btn.dataset.id, shift.id);
                div.remove(); // Close to refresh
                const updatedShift = await Repository.get('shifts', shift.id);
                showShiftTransactions(updatedShift); // Reopen
            });
        });

    } catch (error) {
        console.error("Error loading transactions:", error);
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-red-500">Error loading data.</td></tr>`;
    }
}

async function voidShiftTransaction(txId, shiftId) {
    if (!confirm("Are you sure you want to VOID this transaction?")) return;
    if (!(await requestManagerApproval())) return;

    const reason = prompt("Enter reason for voiding:");
    if (reason === null) return;

    try {
        const tx = await Repository.get('transactions', txId);
        if (!tx) return;

        const user = getCurrentUser();

        await Repository.upsert('transactions', {
            ...tx,
            is_voided: true,
            voided_at: new Date().toISOString(),
            voided_by: user ? user.email : "System",
            void_reason: reason || "No reason provided"
        });

        // 2. Reverse Stock
        for (const item of tx.items) {
            const current = await Repository.get('items', item.id);
            if (current) {
                await Repository.upsert('items', { ...current, stock_level: current.stock_level + item.qty });
                await Repository.upsert('stock_movements', {
                    id: generateUUID(), item_id: item.id, item_name: item.name, timestamp: new Date().toISOString(),
                    type: 'Void', qty: item.qty, user: user ? user.email : "System", reason: `Void Shift Tx ${txId}`
                });
            }
        }

        SyncEngine.sync();
        alert("Transaction voided successfully.");
    } catch (e) {
        console.error("Void Error", e);
        alert("Failed to void.");
    }
}

function viewShiftTransactionDetails(tx) {
    let modal = document.getElementById("modal-shift-tx-details");
    if (modal) modal.remove();

    const div = document.createElement("div");
    div.id = "modal-shift-tx-details";
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-70 flex items-center justify-center z-[60]";

    const itemsHtml = tx.items.map(item => `
        <tr class="border-b hover:bg-gray-50">
            <td class="py-2 px-3 font-medium text-gray-800">${item.name}</td>
            <td class="py-2 px-3 text-center">${item.qty} ${item.unit || 'pcs'}</td>
            <td class="py-2 px-3 text-right">₱${(item.selling_price || item.price || 0).toFixed(2)}</td>
            <td class="py-2 px-3 text-right font-bold">₱${((item.selling_price || item.price || 0) * item.qty).toFixed(2)}</td>
        </tr>
    `).join('');

    const subtotal = tx.subtotal !== undefined ? tx.subtotal : (tx.total_amount + (tx.discount_amount || 0));

    div.innerHTML = `
        <div class="bg-white rounded-lg shadow-lg w-full max-w-3xl flex flex-col h-[80vh]">
            <!-- Header -->
            <div class="p-4 border-b bg-gray-50 flex justify-between items-center shrink-0 rounded-t-lg">
                <div>
                    <h3 class="text-lg font-bold text-gray-800">Transaction Details</h3>
                    <p class="text-xs text-gray-500 font-mono">${new Date(tx.timestamp).toLocaleString()} | ID: ${tx.id.substring(0, 8)}...</p>
                </div>
                <button id="btn-close-shift-tx-details" class="text-gray-500 hover:text-gray-700 text-2xl font-bold">&times;</button>
            </div>
            
            <!-- Content -->
            <div class="flex-1 overflow-y-auto p-4 bg-gray-50">
                <table class="min-w-full text-sm border bg-white rounded shadow-sm">
                    <thead class="bg-gray-100 text-gray-600 text-[10px] uppercase">
                        <tr>
                            <th class="py-2 px-3 text-left">Item Name</th>
                            <th class="py-2 px-3 text-center">Qty</th>
                            <th class="py-2 px-3 text-right">Unit Price</th>
                            <th class="py-2 px-3 text-right">Total</th>
                        </tr>
                    </thead>
                    <tbody class="text-gray-700 text-xs">
                        ${itemsHtml}
                    </tbody>
                </table>
            </div>

            <!-- Footer / Summary -->
            <div class="p-4 border-t bg-white shrink-0 rounded-b-lg">
                <div class="flex justify-end">
                    <div class="w-64 space-y-2 text-sm">
                        <div class="flex justify-between text-gray-600">
                            <span>Subtotal:</span>
                            <span class="font-mono">₱${subtotal.toFixed(2)}</span>
                        </div>
                        <div class="flex justify-between text-red-500">
                            <span>Discount:</span>
                            <span class="font-mono">-₱${(tx.discount_amount || 0).toFixed(2)}</span>
                        </div>
                        <div class="flex justify-between font-bold text-gray-800 text-lg border-t pt-2">
                            <span>Total:</span>
                            <span class="font-mono">₱${(tx.total_amount || 0).toFixed(2)}</span>
                        </div>
                        <div class="flex justify-between text-gray-600 text-xs pt-2">
                            <span>Amount Tendered:</span>
                            <span class="font-mono font-bold">₱${(tx.amount_tendered || 0).toFixed(2)}</span>
                        </div>
                        <div class="flex justify-between text-green-600 text-xs font-bold">
                            <span>Change:</span>
                            <span class="font-mono">₱${(tx.change || 0).toFixed(2)}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(div);
    document.getElementById("btn-close-shift-tx-details").addEventListener("click", () => div.remove());
}

async function printTransaction(tx, isReprint = false) {
    try {
        const settings = await getSystemSettings();
        const store = settings.store || { name: "LightPOS", data: "" };

        const defaultPrint = {
            paper_width: 76,
            show_dividers: true,
            header: { text: "", font_size: 14, font_family: "'Courier New', Courier, monospace", bold: true, italic: false },
            items: { font_size: 12, font_family: "'Courier New', Courier, monospace", bold: false, italic: false },
            body: { font_size: 12, font_family: "'Courier New', Courier, monospace", bold: false, italic: false },
            footer: { text: "Thank you for shopping!", font_size: 10, font_family: "'Courier New', Courier, monospace", bold: false, italic: true }
        };

        const p = {
            ...defaultPrint,
            ...(settings.print || {}),
            header: { ...defaultPrint.header, ...(settings.print?.header || {}) },
            items: { ...defaultPrint.items, ...(settings.print?.items || {}) },
            body: { ...defaultPrint.body, ...(settings.print?.body || {}) },
            footer: { ...defaultPrint.footer, ...(settings.print?.footer || {}) }
        };

        const pWidth = p.paper_width || 76;
        const showHR = p.show_dividers !== false;

        const getStyle = (s) => `
            font-size: ${s.font_size}px; 
            font-family: ${s.font_family}; 
            font-weight: ${s.bold ? 'bold' : 'normal'}; 
            font-style: ${s.italic ? 'italic' : 'normal'};
        `;

        const headerText = p.header?.text || `${store.name}\n${store.data}`;

        // Simplified print logic for history
        const printWindow = window.open('', '_blank', 'width=300,height=600');
        if (!printWindow) {
            throw new Error("Failed to open print window. Pop-up blocker might be enabled.");
        }
        const itemsStyle = p.items ? getStyle(p.items) : getStyle(p.body);

        const itemsHtml = tx.items.map(item => `
            <tr style="${itemsStyle}">
                <td colspan="2" style="padding-top: 5px;">${item.name}</td>
            </tr>
            <tr style="${itemsStyle}">
                <td style="font-size: 0.9em; opacity: 0.8;">${item.qty} x ${item.selling_price.toFixed(2)}</td>
                <td style="text-align: right;">${(item.qty * item.selling_price).toFixed(2)}</td>
            </tr>
        `).join('');

        printWindow.document.write(`<html>
        <head>
            <style>
                @page { margin: 0; }
                body { 
                    width: ${pWidth}mm;
                    ${getStyle(p.body)}
                    padding: 5mm;
                    margin: 0;
                    color: #000;
                }
                .text-center { text-align: center; }
                .text-right { text-align: right; }
                .bold { font-weight: bold; }
                .hr { border-bottom: 1px dashed #000; margin: 5px 0; }
                table { width: 100%; border-collapse: collapse; }
                .header-sec { ${getStyle(p.header)} }
                .body-sec { ${getStyle(p.body)} }
                .footer-sec { margin-top: 20px; ${getStyle(p.footer)} }
            </style>
        </head>
        <body onload="window.print();window.close();">
            <div class="text-center header-sec">
                ${store.logo ? `<img src="${store.logo}" style="max-width: 40mm; max-height: 20mm; margin-bottom: 5px; filter: grayscale(1);"><br>` : ''}
                <div style="white-space: pre-wrap;">${headerText}</div>
            </div>
            ${showHR ? '<div class="hr"></div>' : ''}
            <div class="body-sec">
                Tx: ${tx.id.slice(-6)}<br>
                ${isReprint ? '*** REPRINT ***<br>' : ''}
            </div>
            ${showHR ? '<div class="hr"></div>' : ''}
            <table>${itemsHtml}</table>
            ${showHR ? '<div class="hr"></div>' : ''}
            <div style="text-align:right;font-weight:bold;">Total: ${tx.total_amount.toFixed(2)}</div>
        </body></html>`);
        printWindow.document.close();
    } catch (error) {
        handleError(error, 'Transaction Reprint');
    }
}

export async function printZReport(data) {
    try {
        // data contains shift object mixed with financials
        const settings = await getSystemSettings();
        const store = settings.store || { name: "LightPOS", data: "" };

        const defaultPrint = {
            paper_width: 76,
            header: { font_size: 14, font_family: "monospace", bold: true },
            body: { font_size: 12, font_family: "monospace" }
        };
        const p = { ...defaultPrint, ...(settings.print || {}) };
        const getStyle = (s) => `font-size: ${s.font_size}px; font-family: ${s.font_family}; font-weight: ${s.bold ? 'bold' : 'normal'};`;

        const printWindow = window.open('', '_blank', 'width=300,height=600');
        if (!printWindow) {
            throw new Error("Failed to open print window. Pop-up blocker might be enabled.");
        }

        // Variance calculation for Receipt
        // Variance = (Closing + Remits + Expenses) - (Open + Sales + Adj + Returns)
        const accountability = data.gross_accountability;
        const turnover = data.closing_cash + data.remittances + (data.expenses || 0);
        const variance = turnover - accountability;

        printWindow.document.write(`
            <html>
            <head>
                <style>
                    @page { margin: 0; }
                    body { width: ${p.paper_width}mm; padding: 5mm; margin: 0; ${getStyle(p.body)} color: #000; }
                    .text-center { text-align: center; }
                    .text-right { text-align: right; }
                    .bold { font-weight: bold; }
                    .hr { border-bottom: 1px dashed #000; margin: 5px 0; }
                    table { width: 100%; border-collapse: collapse; }
                    .header-sec { ${getStyle(p.header)} }
                    .row { display: flex; justify-content: space-between; }
                    .indent { padding-left: 10px; }
                </style>
            </head>
            <body onload="window.print();window.close();">
                <div class="text-center header-sec">
                    ${store.name}<br>Z-REPORT (Shift Close)
                </div>
                <div class="hr"></div>
                <div>
                    User: ${data.user_id}<br>
                    Start: ${new Date(data.start_time).toLocaleString()}<br>
                    End: ${new Date().toLocaleString()}
                </div>
                <div class="hr"></div>
                
                <div class="bold">CASH BREAKDOWN</div>
                <div class="row"><span>Opening Cash:</span> <span>${data.opening.toFixed(2)}</span></div>
                <div class="row"><span>+ Sales (Cash):</span> <span>${data.sales.toFixed(2)}</span></div>
                <div class="row"><span>+ Adjustments:</span> <span>${data.adjustments.toFixed(2)}</span></div>
                <div class="row"><span>+ Net Returns:</span> <span>${data.returns_net.toFixed(2)}</span></div>
                <div class="hr"></div>
                <div class="row bold"><span>= Gross Account:</span> <span>${data.gross_accountability.toFixed(2)}</span></div>
                <div class="row"><span>- Remittances:</span> <span>${data.remittances.toFixed(2)}</span></div>
                <div class="row"><span>- Expenses:</span> <span>${(data.expenses || 0).toFixed(2)}</span></div>
                <div class="hr" style="border-bottom: 2px solid #000"></div>
                <div class="row bold" style="font-size: 1.1em"><span>EXPECTED IN DRAWER:</span> <span>${data.expected_in_drawer.toFixed(2)}</span></div>
                <br>
                <div class="row"><span>ACTUAL COUNT:</span> <span>${data.closing_cash.toFixed(2)}</span></div>
                <div class="row bold"><span>VARIANCE:</span> <span>${variance.toFixed(2)}</span></div>
                
                <div class="hr"></div>
                <div class="text-center italic">Signature: ________________</div>
            </body>
            </html>
        `);
        printWindow.document.close();
    } catch (error) {
        handleError(error, 'Z-Report Printing');
    }
}

function showAddReceiptPrompt(onChoice) {
    const div = document.createElement("div");
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-90 flex items-center justify-center z-[70]";
    div.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl p-6 w-80 transform scale-in">
            <h3 class="font-bold text-gray-800 mb-4 text-center">Add Receipt</h3>
            <div class="flex flex-col gap-3">
                <button id="btn-choice-existing" class="bg-blue-50 text-blue-700 border border-blue-200 py-3 rounded-lg font-bold hover:bg-blue-100 transition">
                    Select from Expenses
                </button>
                <div class="text-center text-xs text-gray-400 font-bold">- OR -</div>
                <button id="btn-choice-new" class="bg-red-50 text-red-700 border border-red-200 py-3 rounded-lg font-bold hover:bg-red-100 transition">
                    New Shift Expense
                </button>
                <button id="btn-choice-cancel" class="mt-2 text-gray-500 hover:text-gray-700 text-sm font-medium">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(div);

    document.getElementById("btn-choice-existing").addEventListener("click", () => {
        div.remove();
        onChoice('existing');
    });

    document.getElementById("btn-choice-new").addEventListener("click", () => {
        div.remove();
        onChoice('new');
    });

    document.getElementById("btn-choice-cancel").addEventListener("click", () => div.remove());
}