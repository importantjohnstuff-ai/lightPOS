import { dbPromise } from "../db.js";
import { renderSidebar } from "../layout.js";
import { SyncEngine } from "../services/SyncEngine.js";

const reportWorker = new Worker('src/workers/reportWorker.js', { type: 'module' });
let reportResolve = null;
let reportReject = null;

reportWorker.onmessage = (e) => {
    const { type, success, data, message } = e.data;
    if (type === 'Re:GENERATE') {
        if (success && reportResolve) reportResolve(data);
        else if (!success && reportReject) reportReject(new Error(message));
    }
};

const generalReportWorker = new Worker('src/workers/generalReportWorker.js?v=' + Date.now(), { type: 'module' });
let generalResolve = null;
let generalReject = null;
let lastShiftData = null; // Cache for navigation

let exportResolve = null;
let exportReject = null;

generalReportWorker.onmessage = (e) => {
    const { type, success, data, message, stack } = e.data;
    console.log('[Worker Response]', type, success ? '✅' : '❌');
    if (type === 'Re:GENERATE_SHIFTS' || type === 'Re:GENERATE_SUMMARY') {
        if (success && generalResolve) generalResolve(data);
        else if (!success && generalReject) generalReject(new Error(message));
    } else if (type === 'Re:GENERATE_EXPORT_DATA') {
        if (success && exportResolve) exportResolve(data);
        else if (!success && exportReject) exportReject(new Error(message));
    } else if (type === 'ERROR') {
        console.error('[Worker ERROR]', message, stack);
        // Reject whichever promise is pending
        if (exportReject) exportReject(new Error(message));
        else if (generalReject) generalReject(new Error(message));
    }
};

generalReportWorker.onerror = (e) => {
    console.error('[Worker FATAL]', e.message, e.filename, e.lineno);
    if (exportReject) exportReject(new Error(e.message));
    else if (generalReject) generalReject(new Error(e.message));
};

let currentModalReportId = null;

const REPORTS_CONFIG = {
    products: [
        { id: 'prod-perf', title: 'Product Performance', desc: 'In-depth sales metrics, margins, and Retailer\'s Matrix categorization.', icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z', implemented: true },
        { id: 'prod-risk', title: 'Risk & Quality', desc: 'Analyze return rates and shrinkage per product to identify quality issues.', icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z', implemented: false },
        { id: 'prod-affinity', title: 'Product Affinity', desc: 'Identify which items are frequently bought together to optimize bundles.', icon: 'M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01', implemented: false },
        { id: 'prod-lowstock', title: 'Low Stock Report', desc: 'Real-time list of products nearing or below their minimum stock threshold.', icon: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z', implemented: false },
        { id: 'prod-velocity', title: 'Sales Velocity', desc: 'Track how fast items sell and predict days of stock remaining.', icon: 'M13 10V3L4 14h7v7l9-11h-7z', implemented: false }
    ],
    inventory: [
        { id: 'inv-val', title: 'Inventory Valuation', desc: 'Current items with quantity, unit cost, and valuation subtotal.', icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z', implemented: true },
        { id: 'inv-ledger', title: 'Inventory Ledger', desc: 'Generate a snapshot of total inventory at any historical date.', icon: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z', implemented: false },
        { id: 'inv-history', title: 'Stock-In History', desc: 'Detailed log of all inventory receipts and replenishments.', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', implemented: false },
        { id: 'inv-audit', title: 'Adjustments (Audit)', desc: 'Track manual stock changes, user responsible, and reason codes.', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4', implemented: false },
        { id: 'inv-movement', title: 'Movement Log', desc: 'Granular log of every single stock change (Sales, Returns, Voids).', icon: 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4', implemented: true },
        { id: 'inv-shrinkage', title: 'Shrinkage Analysis', desc: 'Identify patterns in inventory loss from theft or admin errors.', icon: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16', implemented: false },
        { id: 'inv-slow', title: 'Slow Moving Items', desc: 'Discover items that haven\'t moved in weeks to clear dead stock.', icon: 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z', implemented: false },
        { id: 'inv-returns', title: 'Returns & Defectives', desc: 'Track customer returns and defective items by supplier.', icon: 'M16 15v-6a4 4 0 00-4-4H4m0 0l4-4m-4 4l4 4', implemented: false },
        { id: 'inv-conversions', title: 'Stock Conversions', desc: 'Log item breakdowns and transformations (e.g., bulk to retail).', icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15', implemented: false }
    ],
    financials: [
        { id: 'fin-summary', title: 'Sales Summary', desc: 'Revenue breakdown by payment method and net profit metrics.', icon: 'M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z', implemented: true },
        { id: 'fin-shift-history', title: 'Shift History', desc: 'View comprehensive history of all shifts, sales, and variances.', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', implemented: true },
        { id: 'fin-shift-reports', title: 'Closing Reports', desc: 'Full end-of-shift reconciliation and expense tracking.', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z', implemented: true },
        { id: 'fin-cashflow', title: 'Cashflow Trend', desc: 'Daily bar chart comparing cash inflows and outflows.', icon: 'M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z', implemented: false }
    ],
    insights: [
        { id: 'ins-customers', title: 'Customer Insights', desc: 'VIP ranking and outstanding loyalty point liability.', icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z', implemented: false },
        { id: 'ins-suppliers', title: 'Supplier Performance', desc: 'Analyze vendor sell-through rates and purchase history.', icon: 'M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z', implemented: false },
        { id: 'ins-velocity-trend', title: 'Hourly Sales Trend', desc: 'Heatmap of sales throughout the day on average.', icon: 'M12 11V7l3-3m6 3a9 9 0 11-18 0 9 9 0 0118 0z', implemented: false }
    ],
    system: [
        { id: 'sys-audit', title: 'System Audit', desc: 'Log of sensitive actions like voids and price changes.', icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z', implemented: false }
    ]
};

export async function loadReportsView() {
    const content = document.getElementById("main-content");
    currentModalReportId = null;

    content.innerHTML = `
        <div class="max-w-7xl mx-auto relative">
            <div class="flex justify-between items-center mb-6">
                <h2 class="text-2xl font-bold text-gray-800">Reports Dashboard (v2)</h2>
            </div>
            
            <div class="border-b border-gray-200 mb-6 bg-white sticky top-0 z-1 shadow-sm flex justify-between items-center pr-4">
                <nav class="flex space-x-8 px-4 overflow-x-auto" aria-label="Tabs">
                    <button data-tab="products" class="tab-btn border-blue-500 text-blue-600 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors">Products</button>
                    <button data-tab="inventory" class="tab-btn border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors">Inventory</button>
                    <button data-tab="financials" class="tab-btn border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors">Financials</button>
                    <button data-tab="insights" class="tab-btn border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors">Insights</button>
                    <button data-tab="system" class="tab-btn border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm transition-colors">System</button>
                </nav>
                 <!-- Report Range Picker & Refresh -->
                <div class="flex items-center gap-2">
                    <button id="btn-refresh-reports" class="bg-gray-100 hover:bg-gray-200 text-gray-600 p-2 rounded-lg border border-gray-300 transition" title="Sync & Refresh Data">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                    </button>
                    <div id="report-range" class="flex items-center bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2 cursor-pointer hover:bg-gray-100">
                        <svg class="w-4 h-4 text-gray-500 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                        <span id="report-range-label">Select Date Range</span>
                        <svg class="w-4 h-4 text-gray-500 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                    </div>
                </div>
            </div>

            <div id="report-grid-container" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-20">
                <!-- Cards injected here -->
            </div>
        </div>

        <!-- Unified Report Modal -->
        <div id="report-modal" class="hidden fixed inset-0 z-50 overflow-hidden" aria-labelledby="modal-title" role="dialog" aria-modal="true">
            <div class="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" aria-hidden="true" id="modal-backdrop"></div>
            
            <div class="flex items-center justify-center min-h-screen px-4 py-6">
                <!-- Modal Panel: Fixed height, Flex Column -->
                <div class="bg-white rounded-lg shadow-xl transform transition-all w-full max-w-7xl h-[90vh] flex flex-col">
                    
                    <!-- 1. Header (Fixed) -->
                    <div class="flex-none flex justify-between items-center bg-gray-50 px-6 py-4 border-b border-gray-200 rounded-t-lg">
                         <div>
                            <h3 class="text-xl leading-6 font-bold text-gray-900" id="report-modal-title">Report Title</h3>
                            <p class="text-sm text-gray-500 mt-1" id="report-modal-desc">Report Description</p>
                         </div>
                         <button type="button" id="close-report-modal" class="text-gray-400 hover:text-gray-500 focus:outline-none transition-colors">
                            <span class="sr-only">Close</span>
                            <svg class="h-8 w-8" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                         </button>
                    </div>

                    <!-- 2. Metrics/KPI Bar (Sticky/Fixed) -->
                    <div id="report-metrics-container" class="flex-none bg-white border-b border-gray-100 empty:hidden">
                        <!-- KPIs injected here -->
                    </div>

                    <!-- 3. Main Content (Scrollable) -->
                    <div id="report-modal-content" class="flex-1 overflow-y-auto p-6 bg-white relative">
                         <!-- Table injected here -->
                        <div class="text-center py-20 text-gray-400">
                            <svg class="w-16 h-16 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                            <p class="text-lg">Select a report to generate...</p>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    `;

    renderReportCards('products'); // Default tab

    // Setup Tab Listeners
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn').forEach(b => {
                b.classList.remove('border-blue-500', 'text-blue-600');
                b.classList.add('border-transparent', 'text-gray-500');
            });
            e.target.classList.remove('border-transparent', 'text-gray-500');
            e.target.classList.add('border-blue-500', 'text-blue-600');
            renderReportCards(e.target.dataset.tab);
        });
    });

    // Close Modal Listener
    document.getElementById("close-report-modal").addEventListener("click", closeReportModal);

    // Refresh Listener
    document.getElementById("btn-refresh-reports").addEventListener("click", async () => {
        const btn = document.getElementById("btn-refresh-reports");
        btn.classList.add("animate-spin");
        await SyncEngine.sync();
        btn.classList.remove("animate-spin");
        if (currentModalReportId) {
            generateReport(currentModalReportId);
        } else {
            // Maybe refresh dashboard tiles in future?
        }
    });

    // Initialize Date Range Picker
    if (typeof $ !== 'undefined' && $('#report-range').length) {
        const start = moment().startOf('month');
        const end = moment().endOf('month');

        function cb(start, end) {
            $('#report-range span').html(start.format('MMM D, YYYY') + ' - ' + end.format('MMM D, YYYY'));
            if (currentModalReportId) generateReport(currentModalReportId);
        }

        $('#report-range').daterangepicker({
            startDate: start,
            endDate: end,
            ranges: {
                'Today': [moment(), moment()],
                'Yesterday': [moment().subtract(1, 'days'), moment().subtract(1, 'days')],
                'Last 7 Days': [moment().subtract(6, 'days'), moment()],
                'Last 30 Days': [moment().subtract(29, 'days'), moment()],
                'This Month': [moment().startOf('month'), moment().endOf('month')],
                'Last Month': [moment().subtract(1, 'month').startOf('month'), moment().subtract(1, 'month').endOf('month')]
            }
        }, cb);
        cb(start, end);
    }
}

function renderReportCards(category) {
    const container = document.getElementById("report-grid-container");
    container.innerHTML = "";

    const reports = REPORTS_CONFIG[category] || [];
    reports.forEach(report => {
        const isImplemented = report.implemented;
        const card = document.createElement("div");
        const opacityClass = isImplemented ? "bg-white hover:shadow-md cursor-pointer" : "bg-gray-50 opacity-60 cursor-not-allowed grayscale";

        card.className = `${opacityClass} rounded-xl shadow-sm p-6 border border-gray-100 flex flex-col justify-between h-full transition-all`;

        card.innerHTML = `
            <div class="flex items-start justify-between mb-4">
                <div class="p-3 bg-blue-50 rounded-lg text-blue-600">
                    <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${report.icon}"></path></svg>
                </div>
                <span class="bg-gray-100 text-gray-600 text-xs px-2 py-1 rounded-full font-medium uppercase tracking-wider">${category}</span>
            </div>
            <div>
                <h3 class="text-lg font-bold text-gray-800 mb-2 ${isImplemented ? 'group-hover:text-blue-600' : ''} transition-colors">${report.title}</h3>
                <p class="text-sm text-gray-500 line-clamp-2">${report.desc}</p>
            </div>
            <div class="mt-6 pt-4 border-t border-gray-50 flex justify-between items-center text-sm font-medium ${isImplemented ? 'text-blue-600' : 'text-gray-400'}">
                <span>${isImplemented ? 'View Report' : 'Coming Soon'}</span>
                ${isImplemented ? '<span class="transform transition-transform group-hover:translate-x-1">→</span>' : ''}
            </div>
        `;
        if (isImplemented) {
            card.addEventListener("click", () => openReportModal(report));
        }
        container.appendChild(card);
    });
}

async function openReportModal(report) {
    if (!report.implemented) return;

    currentModalReportId = report.id;
    const modal = document.getElementById("report-modal");
    document.getElementById("report-modal-title").textContent = report.title;
    document.getElementById("report-modal-desc").textContent = report.desc;
    document.getElementById("report-modal-content").innerHTML = `
        <div class="flex justify-center items-center h-64">
            <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
        </div>
    `;
    modal.classList.remove("hidden");

    // Trigger generation
    await generateReport(report.id);
}

async function generateReport(reportId) {
    console.log('[Reports] generateReport called, id:', reportId);
    if (!reportId) return;

    // Fetch Date Range
    const drp = $('#report-range').data('daterangepicker');
    if (!drp) return;
    const startDate = drp.startDate.clone().startOf('day').toDate();
    const endDate = drp.endDate.clone().endOf('day').toDate();
    const startStr = startDate.toISOString();
    const endStr = endDate.toISOString();

    const db = await dbPromise;

    // Movement Log Logic
    if (reportId === 'inv-movement') {
        const limit = 2000; // Hard limit to prevent hanging

        // Fetch Required Data for Worker Synthesis
        // Note: Query both string and integer timestamps to handle mixed formats
        const [txsStr, txsInt, retStr, retInt, movements] = await Promise.all([
            db.transactions.where('timestamp').between(startStr, endStr, true, true).reverse().limit(limit).toArray(),
            db.transactions.where('timestamp').between(startDate.getTime(), endDate.getTime(), true, true).reverse().limit(limit).toArray(),
            db.returns.where('timestamp').between(startStr, endStr, true, true).reverse().limit(limit).toArray(),
            db.returns.where('timestamp').between(startDate.getTime(), endDate.getTime(), true, true).reverse().limit(limit).toArray(),
            db.stock_movements.where('timestamp').between(startStr, endStr, true, true).reverse().limit(limit).toArray()
        ]);

        const transactions = [...txsStr, ...txsInt].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, limit);
        const returns = [...retStr, ...retInt];

        // Dispatch to Worker
        reportWorker.postMessage({
            type: 'GENERATE',
            payload: {
                transactions,
                returns,
                filteredMovements: movements, 
                startDate: startStr,
                endDate: endStr,
                allItems: await db.items.toArray(), // Needed for names
                suppliers: [],
                filteredAdjustments: [],
                filteredStockIn: [],
                filteredExpenses: []
            }
        });

        // Wait for result
        const result = await new Promise((resolve, reject) => {
            reportResolve = resolve;
            reportReject = reject;
        });

        // Check if we hit the limit
        const hitLimit = transactions.length === limit || returns.length === limit || stockMovements.length === limit;
        renderStockMovement(result.movements);

        if (hitLimit) {
            const metrics = document.getElementById("report-metrics-container");
            metrics.innerHTML = `
                <div class="bg-yellow-50 border-b border-yellow-200 p-3 text-sm text-yellow-800 text-center font-medium flex items-center justify-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                    Data limited to the last ${limit} records. Please narrow your date range for accuracy.
                </div>
             `;
        }
    } else if (reportId === 'fin-shift-reports' || reportId === 'fin-shift-history') {
        // Force Sync to ensure other computers' shifts are visible
        await SyncEngine.sync();

        const shifts = await db.shifts.toArray();
        const transactions = await db.transactions.toArray(); // Needed for sales calc

        generalReportWorker.postMessage({
            type: 'GENERATE_SHIFTS',
            payload: {
                shifts,
                transactions,
                startDate: startStr,
                endDate: endStr
            }
        });

        const result = await new Promise((resolve, reject) => {
            generalResolve = resolve;
            generalReject = reject;
        });

        renderShiftReports(result);
    } else if (reportId === 'fin-summary') {
        const transactions = await db.transactions.toArray();
        const items = await db.items.toArray();

        generalReportWorker.postMessage({
            type: 'GENERATE_SUMMARY',
            payload: {
                transactions,
                items,
                startDate: startStr,
                endDate: endStr
            }
        });

        const result = await new Promise((resolve, reject) => {
            generalResolve = resolve;
            generalReject = reject;
        });

        renderSalesSummary(result);
    }
    else if (reportId === 'prod-perf') {
        const [txsStr, txsInt, retStr, retInt] = await Promise.all([
            db.transactions.where('timestamp').between(startStr, endStr, true, true).toArray(),
            db.transactions.where('timestamp').between(startDate.getTime(), endDate.getTime(), true, true).toArray(),
            db.returns.where('timestamp').between(startStr, endStr, true, true).toArray(),
            db.returns.where('timestamp').between(startDate.getTime(), endDate.getTime(), true, true).toArray()
        ]);

        const transactions = [...txsStr, ...txsInt];
        const returns = [...retStr, ...retInt];
        const items = await db.items.toArray();

        // Reuse reportWorker for aggregation
        reportWorker.postMessage({
            type: 'GENERATE',
            payload: {
                transactions,
                allItems: items,
                returns,
                filteredAdjustments: [],
                filteredMovements: [],
                filteredStockIn: [],
                filteredExpenses: [],
                startDate: startStr,
                endDate: endStr,
                suppliers: [],
                taxRate: 0
            }
        });

        const result = await new Promise((resolve, reject) => {
            reportResolve = resolve;
            reportReject = reject;
        });

        renderProductPerformance(result);
    } else if (reportId === 'inv-val') {
        const items = await db.items.toArray();
        const suppliers = await db.suppliers.toArray();
        renderInventoryValuation(items, suppliers);
    }
}

let perfCurrentItems = [];
let perfCurrentFilter = 'all';
let perfSort = { key: 'qty', dir: 'desc' }; // Default sort by Volume (High to Low)

function renderProductPerformance(data) {
    const { products } = data;
    const content = document.getElementById("report-modal-content");
    const metrics = document.getElementById("report-metrics-container");

    // 1. Calculate Centroid (Volume = Qty, Efficiency = MarginPct)
    // Filter out items with 0 volume if we want to focus on active performance,
    // but the user said "dynamic from sales data", implying we check sold items.
    // products array from worker only includes items with sales or stock?
    // Worker: iterates validTxs items. So products only contains items that were sold in the period.

    // Calculate Averages (Centroid)
    const totalQty = products.reduce((sum, p) => sum + p.qty, 0);
    // const totalMarginPct = products.reduce((sum, p) => sum + p.marginPct, 0);
    // Weighted Average Margin? Or simple average of margin percentages?
    // "Centroid of cartesian plane" usually implies arithmetic mean of the points.
    const count = products.length || 1;
    const avgVolume = totalQty / count;
    const avgEfficiency = products.reduce((sum, p) => sum + p.marginPct, 0) / count;

    // 2. Tag Items
    const taggedProducts = products.map(p => {
        let tag = '';
        const isHighVol = p.qty >= avgVolume;
        const isHighEff = p.marginPct >= avgEfficiency;

        // Q1: High Vol, High Eff (Winners/Stars)
        if (isHighVol && isHighEff) tag = 'Winner';
        // Q2: Low Vol, High Eff (Sleepers/Opportunities)
        else if (!isHighVol && isHighEff) tag = 'Sleeper';
        // Q3: Low Vol, Low Eff (Bleeders/Dogs)
        else if (!isHighVol && !isHighEff) tag = 'Bleeder';
        // Q4: High Vol, Low Eff (Traffic/Cash Cows)
        else tag = 'Traffic Builder';

        return { ...p, tag };
    });

    perfCurrentItems = taggedProducts; // Store for table

    // UPDATE DB with new tags (Persist for Items Module)
    (async () => {
        try {
            const db = await dbPromise;
            const updates = [];
            // We need to fetch current items to preserve other fields if we use bulkPut, 
            // OR we can use modify() if we knew the keys, but bulkPut is safer if we read first.
            // Actually, we can just use keys to update specific field if we iterate.
            // But for bulk, let's try to update efficiently.

            // Optimization: Create a Map for O(1) lookup
            const tagMap = new Map(taggedProducts.map(p => [p.id, p.tag]));

            await db.transaction('rw', db.items, async () => {
                // Apply tags to items in DB who have a tag calculated
                // We use Modify which is good for updating specific props without reading whole object if supported,
                // otherwise we iterate.
                // Dexie Collection.modify is supported.
                // BUT we have different values for different items.
                // So we have to loop.

                const allItems = await db.items.toArray();
                const itemsToUpdate = [];

                allItems.forEach(item => {
                    const newTag = tagMap.get(item.id);
                    // If we have a tag for this item and it's different, update it.
                    // If the item was not in the report (filtered out?), we leave it or set to default?
                    // Let's only update explicitly tagged items to be safe.
                    if (newTag && item.performance_tag !== newTag) {
                        item.performance_tag = newTag;
                        itemsToUpdate.push(item);
                    }
                });

                if (itemsToUpdate.length > 0) {
                    await db.items.bulkPut(itemsToUpdate);
                    console.log(`Updated performance tags for ${itemsToUpdate.length} items`);
                }
            });
        } catch (err) {
            console.error("Failed to persist performance tags:", err);
        }
    })();

    // 3. Render Quadrant Cards
    const counts = { Winner: 0, Sleeper: 0, Bleeder: 0, 'Traffic Builder': 0 };
    taggedProducts.forEach(p => counts[p.tag]++);

    metrics.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4 p-4">
            <!-- Winner -->
            <div class="cursor-pointer bg-green-50 hover:bg-green-100 border border-green-200 rounded-lg p-4 transition-colors perf-card" data-filter="Winner">
                <div class="flex justify-between items-start">
                    <div class="p-2 bg-green-200 rounded text-green-700">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"></path></svg>
                    </div>
                    <span class="text-xs font-bold bg-white px-2 py-1 rounded border border-green-100 text-green-600">High Vol / High Eff</span>
                </div>
                <div class="mt-3">
                    <h3 class="text-xl font-bold text-gray-800">${counts.Winner} Items</h3>
                    <p class="text-sm text-gray-500">Winners</p>
                </div>
            </div>

            <!-- Traffic Builder -->
            <div class="cursor-pointer bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg p-4 transition-colors perf-card" data-filter="Traffic Builder">
                <div class="flex justify-between items-start">
                     <div class="p-2 bg-blue-200 rounded text-blue-700">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path></svg>
                    </div>
                    <span class="text-xs font-bold bg-white px-2 py-1 rounded border border-blue-100 text-blue-600">High Vol / Low Eff</span>
                </div>
                <div class="mt-3">
                    <h3 class="text-xl font-bold text-gray-800">${counts['Traffic Builder']} Items</h3>
                    <p class="text-sm text-gray-500">Traffic Builders</p>
                </div>
            </div>

             <!-- Sleeper -->
            <div class="cursor-pointer bg-yellow-50 hover:bg-yellow-100 border border-yellow-200 rounded-lg p-4 transition-colors perf-card" data-filter="Sleeper">
                <div class="flex justify-between items-start">
                     <div class="p-2 bg-yellow-200 rounded text-yellow-700">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    </div>
                    <span class="text-xs font-bold bg-white px-2 py-1 rounded border border-yellow-100 text-yellow-600">Low Vol / High Eff</span>
                </div>
                <div class="mt-3">
                    <h3 class="text-xl font-bold text-gray-800">${counts.Sleeper} Items</h3>
                    <p class="text-sm text-gray-500">Sleepers</p>
                </div>
            </div>

            <!-- Bleeder -->
             <div class="cursor-pointer bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg p-4 transition-colors perf-card" data-filter="Bleeder">
                <div class="flex justify-between items-start">
                     <div class="p-2 bg-red-200 rounded text-red-700">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 14l9-5-9-5-9 5 9 5z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 14l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z"></path></svg>
                    </div>
                     <span class="text-xs font-bold bg-white px-2 py-1 rounded border border-red-100 text-red-600">Low Vol / Low Eff</span>
                </div>
                <div class="mt-3">
                    <h3 class="text-xl font-bold text-gray-800">${counts.Bleeder} Items</h3>
                    <p class="text-sm text-gray-500">Bleeders</p>
                </div>
            </div>
        </div>
        <div class="px-6 pb-2 text-xs text-center text-gray-500">
            Analysis Centroid: <b>${avgVolume.toFixed(1)} Units</b> (Avg Vol) / <b>${avgEfficiency.toFixed(1)}%</b> (Avg Efficiency)
        </div>
    `;

    // 4. Render Table Container
    content.innerHTML = `
        <div class="flex justify-between items-center mb-4">
             <div class="relative">
                <span class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <svg class="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                </span>
                <input type="text" id="perf-search" class="pl-10 pr-4 py-2 border rounded-lg text-sm focus:ring-blue-500 focus:border-blue-500 w-64" placeholder="Search items...">
            </div>
            <div id="perf-filter-label" class="text-sm font-bold text-gray-700 bg-gray-100 px-3 py-1 rounded">All Categories</div>
        </div>
        
        <div class="bg-white border rounded-lg overflow-hidden shadow-sm">
            <div class="overflow-x-auto">
                <table class="min-w-full divide-y divide-gray-200">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Item</th>
                            <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors select-none group" id="sort-vol" data-key="qty">
                                 Volume (Qty)
                                 <span class="ml-1 inline-block ${perfSort.key === 'qty' ? '' : 'text-gray-300'}">
                                    ${perfSort.key === 'qty' ? (perfSort.dir === 'desc' ? '↓' : '↑') : '↓'}
                                 </span>
                            </th>
                            <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors select-none group" id="sort-eff" data-key="marginPct">
                                 Efficiency (Margin%)
                                 <span class="ml-1 inline-block ${perfSort.key === 'marginPct' ? '' : 'text-gray-300'}">
                                    ${perfSort.key === 'marginPct' ? (perfSort.dir === 'desc' ? '↓' : '↑') : '↓'}
                                 </span>
                            </th>
                            <th class="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Tag</th>
                            <th class="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                        </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-200" id="perf-table-body">
                        <!-- Rows -->
                    </tbody>
                </table>
            </div>
            <div class="bg-gray-50 px-4 py-3 border-t border-gray-200 flex items-center justify-between sm:px-6">
                 <button id="perf-prev" class="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Previous</button>
                 <span id="perf-page-info" class="text-sm text-gray-700">Page 1</span>
                 <button id="perf-next" class="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">Next</button>
            </div>
        </div>

        <!-- Quick Edit Modal (Hidden) -->
        <div id="quick-edit-modal" class="hidden fixed inset-0 z-[60] overflow-hidden" aria-labelledby="modal-title" role="dialog" aria-modal="true">
             <div class="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" aria-hidden="true"></div>
              <div class="flex items-center justify-center min-h-screen px-4">
                 <div class="bg-white rounded-lg shadow-xl transform transition-all max-w-sm w-full p-6">
                    <h3 class="text-lg font-medium text-gray-900 mb-4">Quick Edit Item</h3>
                    <input type="hidden" id="qe-id">
                    <div class="mb-4">
                        <label class="block text-sm font-medium text-gray-700">Item Name</label>
                        <input type="text" id="qe-name" class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 text-sm bg-gray-100" readonly>
                    </div>
                    <div class="grid grid-cols-2 gap-4 mb-4">
                         <div>
                            <label class="block text-sm font-medium text-gray-700">Cost Price</label>
                            <input type="number" step="0.01" id="qe-cost" class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Selling Price</label>
                            <input type="number" step="0.01" id="qe-price" class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2">
                        </div>
                    </div>
                     <div class="flex justify-end gap-2">
                        <button type="button" id="qe-cancel" class="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300">Cancel</button>
                        <button type="button" id="qe-save" class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">Save</button>
                    </div>
                 </div>
              </div>
        </div>
    `;

    // Initialize Table
    setupPerfTable();

    // Event Listeners for Cards
    metrics.querySelectorAll('.perf-card').forEach(card => {
        card.addEventListener('click', () => {
            const filter = card.dataset.filter;
            // Toggle
            if (perfCurrentFilter === filter) perfCurrentFilter = 'all';
            else perfCurrentFilter = filter;

            // Update Card Styles
            metrics.querySelectorAll('.perf-card').forEach(c => {
                if (perfCurrentFilter !== 'all' && c.dataset.filter !== perfCurrentFilter) {
                    c.classList.add('opacity-50', 'grayscale');
                } else {
                    c.classList.remove('opacity-50', 'grayscale');
                }
            });

            document.getElementById("perf-filter-label").textContent = perfCurrentFilter === 'all' ? 'All Categories' : perfCurrentFilter + 's';
            renderPerfRows(1);
        });
    });

}

let perfPage = 1;
const perfLimit = 50;

function setupPerfTable() {
    renderPerfRows(1);

    document.getElementById("perf-search").addEventListener("input", () => {
        perfPage = 1;
        renderPerfRows(1);
    });

    document.getElementById("perf-prev").addEventListener("click", () => {
        if (perfPage > 1) {
            perfPage--;
            renderPerfRows(perfPage);
        }
    });

    document.getElementById("perf-next").addEventListener("click", () => {
        // Check max page
        const filtered = getFilteredPerfItems();
        const maxPage = Math.ceil(filtered.length / perfLimit);
        if (perfPage < maxPage) {
            perfPage++;
            renderPerfRows(perfPage);
        }
    });

    // Sorting Headers
    ['sort-vol', 'sort-eff'].forEach(id => {
        const header = document.getElementById(id);
        header.addEventListener("click", () => {
            const key = header.dataset.key;
            if (perfSort.key === key) {
                perfSort.dir = perfSort.dir === 'desc' ? 'asc' : 'desc';
            } else {
                perfSort.key = key;
                perfSort.dir = 'desc'; // Default to desc for metrics
            }
            // Re-render whole table structure to update indicators?
            // Or just update arrows and rows. It's cleaner to re-render rows and just text content of arrows.
            // Let's just re-render rows and update the arrow indicators manually here.

            // Update Arrows
            ['sort-vol', 'sort-eff'].forEach(hId => {
                const h = document.getElementById(hId);
                const span = h.querySelector('span');
                const isCurrent = h.dataset.key === perfSort.key;
                span.className = `ml-1 inline-block ${isCurrent ? '' : 'text-gray-300'}`;
                span.textContent = isCurrent ? (perfSort.dir === 'desc' ? '↓' : '↑') : '↓';
            });

            perfPage = 1;
            renderPerfRows(1);
        });
    });

    // Quick Edit Logic
    const qeModal = document.getElementById("quick-edit-modal");
    document.getElementById("qe-cancel").addEventListener("click", () => qeModal.classList.add("hidden"));

    document.getElementById("qe-save").addEventListener("click", async () => {
        const id = document.getElementById("qe-id").value;
        const cost = parseFloat(document.getElementById("qe-cost").value);
        const price = parseFloat(document.getElementById("qe-price").value);

        if (id) {
            const db = await dbPromise;
            // Update in DB
            await db.items.update(id, { cost_price: cost, selling_price: price });

            // Update Local Cache (perfCurrentItems) so table updates without refresh
            const item = perfCurrentItems.find(i => i.id === id);
            if (item) {
                // item.cost = cost; // Do not update total cost with unit cost
                // Updating price/cost changes margin, efficiency, and potentially the tag.
                // Ideally we re-run the whole report, but that's heavy.
                // Let's just update the display values and notify user.
                alert("Item updated. Refresh report to see new performance stats.");
                qeModal.classList.add("hidden");
                // We could reload report: generateReport('prod-perf');
                // But simply closing is fine for "Quick Edit".
            }
        }
    });
}

function getFilteredPerfItems() {
    const search = document.getElementById("perf-search").value.toLowerCase();

    // Filter
    let items = perfCurrentItems.filter(item => {
        const matchesFilter = perfCurrentFilter === 'all' || item.tag === perfCurrentFilter;
        const matchesSearch = (item.name || "").toLowerCase().includes(search) || (item.id || "").toLowerCase().includes(search);
        return matchesFilter && matchesSearch;
    });

    // Sort
    items.sort((a, b) => {
        const valA = a[perfSort.key];
        const valB = b[perfSort.key];
        if (valA < valB) return perfSort.dir === 'asc' ? -1 : 1;
        if (valA > valB) return perfSort.dir === 'asc' ? 1 : -1;
        return 0;
    });

    return items;
}

function renderPerfRows(page) {
    perfPage = page;
    const body = document.getElementById("perf-table-body");
    const items = getFilteredPerfItems();
    const start = (page - 1) * perfLimit;
    const end = start + perfLimit;
    const pageItems = items.slice(start, end);

    body.innerHTML = "";

    if (pageItems.length === 0) {
        body.innerHTML = `<tr><td colspan="5" class="px-6 py-4 text-center text-gray-500">No items found.</td></tr>`;
        return;
    }

    pageItems.forEach(item => {
        const tr = document.createElement("tr");
        tr.className = "hover:bg-gray-50";

        let tagColor = "gray";
        if (item.tag === 'Winner') tagColor = "green";
        if (item.tag === 'Sleeper') tagColor = "yellow";
        if (item.tag === 'Bleeder') tagColor = "red";
        if (item.tag === 'Traffic Builder') tagColor = "blue";

        tr.innerHTML = `
            <td class="px-6 py-4 whitespace-nowrap">
                <div class="text-sm font-medium text-gray-900">${item.name}</div>
                <div class="text-xs text-gray-500">ID: ${item.id.slice(0, 8)}...</div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-500 font-mono">
                ${item.qty}
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-500 font-mono">
                ${item.marginPct.toFixed(1)}% <span class="text-xs text-gray-400">(${(item.revenue - item.cost).toFixed(2)})</span>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-center">
                <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-${tagColor}-100 text-${tagColor}-800">
                    ${item.tag}
                </span>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-center text-sm font-medium">
                <button class="text-indigo-600 hover:text-indigo-900 bg-indigo-50 px-3 py-1 rounded btn-quick-edit" data-id="${item.id}">Edit</button>
            </td>
        `;
        body.appendChild(tr);
    });

    // Attach Edit Listeners
    document.querySelectorAll(".btn-quick-edit").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            const id = e.target.getAttribute("data-id");
            const db = await dbPromise;
            const item = await db.items.get(id);
            if (item) {
                document.getElementById("qe-id").value = id;
                document.getElementById("qe-name").value = item.name;
                document.getElementById("qe-cost").value = item.cost_price;
                document.getElementById("qe-price").value = item.selling_price;
                document.getElementById("quick-edit-modal").classList.remove("hidden");
            }
        });
    });

    // Update Pagination Info
    document.getElementById("perf-page-info").textContent = `Page ${perfPage} of ${Math.ceil(items.length / perfLimit) || 1}`;
}

function renderSalesSummary(data) {
    console.log('[Reports] renderSalesSummary called', data);
    const { summary, paymentMethods, categorySales } = data;
    const metricsContainer = document.getElementById("report-metrics-container");
    const contentContainer = document.getElementById("report-modal-content");

    // Metrics Bar
    metricsContainer.innerHTML = `
        <div class="grid grid-cols-4 gap-6 p-6">
            <div class="p-4 bg-blue-50 rounded-lg border border-blue-100 flex flex-col justify-center">
                <div class="text-xs text-blue-500 uppercase font-bold tracking-wider">Total Revenue</div>
                <div class="text-3xl font-bold text-blue-800 mt-1">₱${summary.totalRevenue.toFixed(2)}</div>
            </div>
            <div class="p-4 bg-purple-50 rounded-lg border border-purple-100 flex flex-col justify-center">
                <div class="text-xs text-purple-500 uppercase font-bold tracking-wider">Transactions</div>
                <div class="text-3xl font-bold text-purple-800 mt-1">${summary.transactionCount}</div>
            </div>
            <div class="p-4 bg-green-50 rounded-lg border border-green-100 flex flex-col justify-center">
                <div class="text-xs text-green-500 uppercase font-bold tracking-wider">Gross Profit</div>
                <div class="text-3xl font-bold text-green-800 mt-1">₱${summary.grossProfit.toFixed(2)}</div>
            </div>
            <div class="p-4 bg-yellow-50 rounded-lg border border-yellow-100 flex flex-col justify-center">
                <div class="text-xs text-yellow-600 uppercase font-bold tracking-wider">Avg Ticket</div>
                <div class="text-3xl font-bold text-yellow-800 mt-1">₱${summary.avgTicket.toFixed(2)}</div>
            </div>
        </div>
        <div class="px-6 pb-4 flex justify-end">
            <button id="btn-open-export" class="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-bold shadow transition-colors">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                Export Sales Data
            </button>
        </div>
    `;

    // Main Content
    contentContainer.innerHTML = `
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <!-- Payment Methods -->
            <div class="bg-white border rounded-lg shadow-sm p-6 flex flex-col">
                <h4 class="font-bold text-gray-800 mb-4 border-b pb-2 flex items-center">
                    <svg class="w-5 h-5 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"></path></svg>
                    Payment Methods
                </h4>
                <div class="flex-1 flex justify-center items-center min-h-[300px]">
                     <canvas id="chart-payment-methods" style="max-height: 300px;"></canvas>
                </div>
            </div>

            <!-- Top Categories -->
            <div class="bg-white border rounded-lg shadow-sm p-6 flex flex-col">
                 <h4 class="font-bold text-gray-800 mb-4 border-b pb-2 flex items-center">
                    <svg class="w-5 h-5 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path></svg>
                    Sales by Category
                </h4>
                 <div class="flex-1 flex justify-center items-center min-h-[300px]">
                     <canvas id="chart-categories" style="max-height: 300px;"></canvas>
                </div>
            </div>
        </div>
    `;

    // Initialize Charts if Chart.js is available
    if (typeof Chart !== 'undefined') {
        const bgColors = [
            'rgb(59, 130, 246)', 'rgb(16, 185, 129)', 'rgb(245, 158, 11)', 'rgb(239, 68, 68)',
            'rgb(139, 92, 246)', 'rgb(236, 72, 153)', 'rgb(99, 102, 241)', 'rgb(20, 184, 166)'
        ];

        // destroy existing charts if strict mode, but we just rebuilt innerHTML so canvases are fresh

        // Payment Methods Chart
        new Chart(document.getElementById('chart-payment-methods'), {
            type: 'pie',
            data: {
                labels: Object.keys(paymentMethods),
                datasets: [{
                    data: Object.values(paymentMethods),
                    backgroundColor: bgColors,
                    borderWidth: 1
                }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });

        // Category Chart
        const sortedCats = Object.entries(categorySales).sort((a, b) => b[1] - a[1]); // Top categories
        new Chart(document.getElementById('chart-categories'), {
            type: 'pie',
            data: {
                labels: sortedCats.map(x => x[0]),
                datasets: [{
                    data: sortedCats.map(x => x[1]),
                    backgroundColor: bgColors,
                    borderWidth: 1
                }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });
    } else {
        contentContainer.innerHTML += `<div class="w-full text-center text-red-500 mt-4">Chart.js library not found. Charts cannot be displayed.</div>`;
    }

    // Attach Export Button Listener
    const exportBtn = document.getElementById('btn-open-export');
    console.log('[Reports] Export button found:', !!exportBtn);
    exportBtn?.addEventListener('click', () => {
        console.log('[Export] Export button clicked');
        openSalesExportPanel();
    });
}

function renderShiftReports(data) {
    lastShiftData = data; // Cache for back navigation
    const { shifts, summary } = data;
    const metricsContainer = document.getElementById("report-metrics-container");
    const contentContainer = document.getElementById("report-modal-content");

    // Clear previous
    metricsContainer.innerHTML = "";
    contentContainer.innerHTML = "";

    if (!shifts || shifts.length === 0) {
        contentContainer.innerHTML = `<div class="p-10 text-center text-gray-500">No closed shifts found for this period.</div>`;
        return;
    }

    // Render Metrics (Fixed Top)
    metricsContainer.innerHTML = `
        <div class="grid grid-cols-4 gap-6 p-6">
            <div class="p-4 bg-blue-50 rounded-lg border border-blue-100 flex flex-col justify-center">
                <div class="text-xs text-blue-500 uppercase font-bold tracking-wider">Total Shifts</div>
                <div class="text-3xl font-bold text-blue-800 mt-1">${summary.totalShifts}</div>
            </div>
            <div class="p-4 bg-purple-50 rounded-lg border border-purple-100 flex flex-col justify-center">
                <div class="text-xs text-purple-500 uppercase font-bold tracking-wider">Total Sales</div>
                <div class="text-3xl font-bold text-purple-800 mt-1">₱${(summary.totalSales || 0).toFixed(2)}</div>
            </div>
            <div class="p-4 bg-green-50 rounded-lg border border-green-100 flex flex-col justify-center">
                <div class="text-xs text-green-500 uppercase font-bold tracking-wider">Total Cashout</div>
                <div class="text-3xl font-bold text-green-800 mt-1">₱${summary.totalCashout.toFixed(2)}</div>
            </div>
            <div class="p-4 ${summary.totalVariance < 0 ? 'bg-red-50 border-red-100' : 'bg-gray-50 border-gray-100'} rounded-lg border flex flex-col justify-center">
                <div class="text-xs ${summary.totalVariance < 0 ? 'text-red-500' : 'text-gray-500'} uppercase font-bold tracking-wider">Net Variance</div>
                <div class="text-3xl font-bold ${summary.totalVariance < 0 ? 'text-red-800' : 'text-gray-800'} mt-1">₱${summary.totalVariance.toFixed(2)}</div>
            </div>
        </div>
    `;

    // Render Table (Scrollable)
    contentContainer.innerHTML = `
        <div class="overflow-hidden border border-gray-200 rounded-lg">
            <table class="min-w-full bg-white border border-gray-200">
                <thead class="bg-gray-50">
                    <tr>
                        <th class="py-2 px-4 border-b text-left text-xs font-semibold text-gray-600 uppercase">Started</th>
                        <th class="py-2 px-4 border-b text-left text-xs font-semibold text-gray-600 uppercase">User</th>
                         <th class="py-2 px-4 border-b text-center text-xs font-semibold text-gray-600 uppercase">Status</th>
                        <th class="py-2 px-4 border-b text-right text-xs font-semibold text-gray-600 uppercase">Variance</th>
                    </tr>
                </thead>
                <tbody class="text-sm divide-y divide-gray-100">
                    ${shifts.map(s => `
                        <tr class="hover:bg-blue-50 cursor-pointer transition-colors shift-row" data-id="${s.id}">
                            <td class="py-3 px-4 whitespace-nowrap">
                                <span class="block font-medium text-gray-800">${new Date(s.start_time).toLocaleDateString()}</span>
                                <span class="text-xs text-gray-500">${new Date(s.start_time).toLocaleTimeString()}</span>
                            </td>
                            <td class="py-3 px-4 text-gray-600">${s.user_id}</td>
                             <td class="py-3 px-4 text-center">
                                <span class="px-2 py-1 rounded-full text-xs font-bold ${s.status === 'closed' ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-600'}">${s.status}</span>
                            </td>
                            <td class="py-3 px-4 text-right font-mono font-bold ${s.variance < 0 ? 'text-red-500' : (s.variance > 0 ? 'text-green-600' : 'text-gray-400')}">${s.variance > 0 ? '+' : ''}${s.variance.toFixed(2)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;

    // Attach Listeners
    contentContainer.querySelectorAll('.shift-row').forEach(row => {
        row.addEventListener('click', () => {
            const id = row.getAttribute('data-id');
            renderShiftDetail(id);
        });
    });
}

async function renderShiftDetail(shiftId) {
    const shift = lastShiftData.shifts.find(s => s.id === shiftId);
    if (!shift) return;

    // Fetch full shift object from DB to get adjustments/remittances not fully in summary if needed
    // But our worker payload 'shifts' was raw DB dump passed to worker logic, wait.
    // In Reportsv2: `const shifts = await db.shifts.toArray();`
    // Then worker processed it. `result.shifts` are lightweight mapped objects.
    // They basically contain what we need, including `adjustment_count` and `remittance_total`, 
    // but maybe not the actual arrays for the detail view?
    // Checking worker: `shifts.map(s => ({ ... adjustment_count ... }))`
    // Ah, the worker DOES NOT return the arrays.
    // So we need to fetch the single shift from DB again or pass it.
    // It's cleaner to fetch fresh from DB here.

    // We can't access `db` variable easily if it's not in scope of this function?
    // `db` is available in `Reportsv2.js` as imports usually? No, `Reportsv2.js` imports `dbPromise`.
    // Wait, `loadReportsView` imports `dbPromise` as `db`.
    // I need `db` here. 
    // Let's assume `db` is available or I need to use the imported `dbPromise`.
    // Actually, `Reportsv2.js` top-level code: `import { dbPromise as db } from '../db.js';` ?
    // No, `Reportsv2.js` does NOT have top level imports shown in previous Steps... 
    // Wait, let me check imports.
    // Step 443 showed imports: `import { dbPromise as db } from '../db.js';`. OK.

    const db = await dbPromise;
    const fullShift = await db.shifts.get(shiftId);
    if (!fullShift) {
        alert("Shift not found");
        return;
    }

    const metricsContainer = document.getElementById("report-metrics-container");
    const contentContainer = document.getElementById("report-modal-content");

    // Calculate Sales & Returns for Reconciliation
    const startTime = new Date(fullShift.start_time);
    const endTime = fullShift.end_time ? new Date(fullShift.end_time) : new Date();
    const userEmailNormalized = (fullShift.user_id || "").trim().toLowerCase();

    // Fetch transactions for this shift period (using JS filter for reliable date matching)
    const allTransactions = await db.transactions.toArray();
    const txs = allTransactions.filter(tx => {
        const txTime = new Date(tx.timestamp);
        return txTime >= startTime && txTime <= endTime;
    });

    // Initialize calculation variables
    let calcSales = 0;
    let calcExchange = 0;
    const adjustments = fullShift.adjustments || [];

    txs.forEach(tx => {
        const txUserNormalized = (tx.user_email || "").trim().toLowerCase();
        // Sales: Cash payments by this user
        if (txUserNormalized === userEmailNormalized && !tx.is_voided) {
            const pm = (tx.payment_method || 'Cash').toLowerCase();
            if (pm === 'cash') {
                calcSales += (parseFloat(tx.total_amount) || 0);
            }
        }

        // Exchanges: Processed by this user (check array)
        if (tx.exchanges && Array.isArray(tx.exchanges)) {
            tx.exchanges.forEach(exch => {
                const exchTime = new Date(exch.timestamp);
                const exchUserNormalized = (exch.processed_by || "").trim().toLowerCase();
                if (exchTime >= startTime && exchTime <= endTime && exchUserNormalized === userEmailNormalized) {
                    const returned = (exch.returned || []).reduce((s, i) => s + (parseFloat(i.selling_price || 0) * (parseFloat(i.qty) || 1)), 0);
                    const taken = (exch.taken || []).reduce((s, i) => s + (parseFloat(i.selling_price || 0) * (parseFloat(i.qty) || 1)), 0);
                    calcExchange += (taken - returned);
                }
            });
        }
    });

    const netAdjustments = (fullShift.adjustments || []).reduce((sum, a) => sum + (parseFloat(a.amount) || 0), 0);
    const remittances = fullShift.remittances || [];
    const totalRemittances = remittances.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
    const expenses = fullShift.closing_receipts || [];
    const totalExpenses = expenses.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);

    const grossAccountability = (parseFloat(fullShift.opening_cash) || 0) + calcSales + calcExchange + netAdjustments;
    const expectedInDrawer = grossAccountability - totalRemittances - totalExpenses;

    // Detail Header (in Metrics Area)
    metricsContainer.innerHTML = `
        <div class="p-4 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
            <div class="flex gap-2">
                <button id="btn-back-shifts" class="flex items-center text-gray-600 hover:text-blue-600 transition font-medium px-3 py-1 rounded hover:bg-white border border-transparent hover:border-gray-200">
                    <svg class="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
                    Back to List
                </button>
            </div>
            <div class="text-right">
                <div class="text-sm text-gray-500">Shift ID: <span class="font-mono text-xs">${fullShift.id.slice(0, 8)}...</span></div>
                <div class="font-bold text-gray-800">${new Date(fullShift.start_time).toLocaleString()}</div>
            </div>
        </div>
        
        <div class="mb-6">
            <div class="text-sm text-gray-500">Start Time</div>
            <div class="font-medium text-gray-800">${new Date(fullShift.start_time).toLocaleString()}</div>
            <div class="text-sm text-gray-500 mt-2">End Time</div>
            <div class="font-medium text-gray-800">${fullShift.end_time ? new Date(fullShift.end_time).toLocaleString() : 'Active'}</div>
        </div>

        <div class="overflow-x-auto mb-6">
            <table class="w-full text-sm border-collapse border border-gray-200">
                <tbody>
                    <tr class="bg-gray-50 border-b">
                        <td class="border p-2 font-bold text-gray-600 w-1/2">Opening Cash</td>
                        <td class="border p-2 text-right font-bold text-gray-800">₱${(parseFloat(fullShift.opening_cash) || 0).toFixed(2)}</td>
                    </tr>
                    <tr class="bg-white border-b hover:bg-blue-50 cursor-pointer transition-colors" id="row-report-cash-count">
                        <td class="border p-2 font-bold text-gray-600 w-1/2 flex items-center justify-between">
                            <span>Cash Count</span>
                            <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                        </td>
                        <td class="border p-2 text-right font-bold text-blue-600">₱${(parseFloat(fullShift.closing_cash) || 0).toFixed(2)}</td>
                    </tr>
                    <tr class="bg-gray-50 border-b hover:bg-blue-50 cursor-pointer transition-colors" id="row-report-precounted">
                        <td class="border p-2 font-bold text-gray-600 w-1/2 flex items-center justify-between">
                            <span>Precounted Money</span>
                             <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                        </td>
                        <td class="border p-2 text-right font-bold text-gray-800">₱${((parseFloat(fullShift.precounted_bills) || 0) + (parseFloat(fullShift.precounted_coins) || 0)).toFixed(2)}</td>
                    </tr>
                    <tr class="bg-white border-b">
                        <td class="border p-2 font-bold text-gray-600 w-1/2">Cashout</td>
                        <td class="border p-2 text-right font-bold text-purple-600">₱${totalRemittances.toFixed(2)}</td>
                    </tr>
                    <tr class="bg-gray-50 border-b">
                        <td class="border p-2 font-bold text-gray-600 w-1/2">Expenses</td>
                        <td class="border p-2 text-right font-bold text-red-600">₱${totalExpenses.toFixed(2)}</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div class="mb-6 p-4 ${(((parseFloat(fullShift.closing_cash) || 0) + totalRemittances + totalExpenses) - grossAccountability) < 0 ? "text-red-600 bg-red-50" : "text-gray-600 bg-gray-50"} rounded border border-opacity-20 flex justify-between items-center">
            <span class="font-bold text-sm uppercase">Variance</span>
            <span class="text-2xl font-bold">₱${(((parseFloat(fullShift.closing_cash) || 0) + totalRemittances + totalExpenses) - grossAccountability).toFixed(2)}</span>
        </div>
    `;

    contentContainer.innerHTML += `
        <div class="flex flex-col gap-3 mb-6">
            <h4 class="font-bold text-gray-700 border-b pb-2 mb-2">Actions</h4>
            <div class="grid grid-cols-2 gap-3">
                <button id="btn-detail-transactions" class="bg-teal-50 text-teal-700 hover:bg-teal-100 border border-teal-200 py-2 rounded font-bold text-sm transition">Transactions</button>
                <button id="btn-detail-history" class="bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200 py-2 rounded font-bold text-sm transition">View Adjustments & Remittances</button>
            </div>
        </div>
    `;

    // Detail Body (Adjustments & Remittances) -> Hidden initially just like Shifts
    contentContainer.innerHTML += `
        <div id="report-shift-details-history" class="hidden space-y-6">
            <!--Adjustments -->
            <div class="border rounded-lg overflow-hidden">
                <div class="bg-gray-100 px-4 py-2 font-bold text-sm text-gray-700">Cash Adjustments</div>
                ${adjustments.length === 0 ? '<div class="p-4 text-center text-gray-500 text-sm">No adjustments.</div>' : `
                <table class="min-w-full text-sm">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="py-2 px-4 text-left font-medium text-gray-500">Time</th>
                            <th class="py-2 px-4 text-left font-medium text-gray-500">Reason</th>
                            <th class="py-2 px-4 text-left font-medium text-gray-500">User</th>
                            <th class="py-2 px-4 text-right font-medium text-gray-500">Amount</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">
                        ${adjustments.map(a => `
                            <tr>
                                <td class="py-2 px-4 text-gray-600">${new Date(a.timestamp).toLocaleTimeString()}</td>
                                <td class="py-2 px-4 text-gray-800">${a.reason}</td>
                                <td class="py-2 px-4 text-gray-500">${a.user}</td>
                                <td class="py-2 px-4 text-right font-bold ${a.amount >= 0 ? 'text-green-600' : 'text-red-600'}">₱${Math.abs(a.amount).toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
                `}
            </div>

            <!--Remittances -->
             <div class="border rounded-lg overflow-hidden">
                <div class="bg-gray-100 px-4 py-2 font-bold text-sm text-gray-700">Remittances (Cash Out)</div>
                ${remittances.length === 0 ? '<div class="p-4 text-center text-gray-500 text-sm">No remittances.</div>' : `
                <table class="min-w-full text-sm">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="py-2 px-4 text-left font-medium text-gray-500">Time</th>
                            <th class="py-2 px-4 text-left font-medium text-gray-500">Reason</th>
                            <th class="py-2 px-4 text-left font-medium text-gray-500">User</th>
                            <th class="py-2 px-4 text-right font-medium text-gray-500">Amount</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">
                        ${remittances.map(r => `
                            <tr>
                                <td class="py-2 px-4 text-gray-600">${new Date(r.timestamp).toLocaleTimeString()}</td>
                                <td class="py-2 px-4 text-gray-800">${r.reason}</td>
                                <td class="py-2 px-4 text-gray-500">${r.user}</td>
                                <td class="py-2 px-4 text-right font-bold text-purple-600">₱${r.amount.toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
                `}
            </div>
            
            <!--Receipts / Expenses Scan if any-->
        ${(fullShift.closing_receipts && fullShift.closing_receipts.length > 0) ? `
             <div class="border rounded-lg overflow-hidden">
                <div class="bg-gray-100 px-4 py-2 font-bold text-sm text-gray-700">Closing Expenses</div>
                <table class="min-w-full text-sm">
                    <tbody class="divide-y divide-gray-100">
                         ${fullShift.closing_receipts.map(r => `
                            <tr>
                                <td class="py-2 px-4 text-gray-800">${r.description || 'Expense'}</td>
                                <td class="py-2 px-4 text-right font-bold text-gray-800">₱${(r.amount || 0).toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
             </div>
             ` : ''
        }

        </div>
        `;

    document.getElementById("btn-back-shifts").addEventListener("click", () => {
        renderShiftReports(lastShiftData);
    });
    document.getElementById("btn-detail-transactions")?.addEventListener("click", () => showShiftTransactions(fullShift));
    document.getElementById("btn-detail-history")?.addEventListener("click", () => {
        const historyDiv = document.getElementById("report-shift-details-history");
        historyDiv.classList.toggle("hidden");
    });
    document.getElementById("row-report-cash-count")?.addEventListener("click", () => showReportCashBreakdownModal(fullShift));
    document.getElementById("row-report-precounted")?.addEventListener("click", () => showReportPrecountedModal(fullShift));
}

function showReportCashBreakdownModal(shift) {
    const breakdown = shift.cash_breakdown || {};
    const hasData = Object.keys(breakdown).length > 0;

    const div = document.createElement("div");
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-[70]";

    const denoms = Object.keys(breakdown).sort((a, b) => parseFloat(b) - parseFloat(a));

    const rows = denoms.map(denom => `
        <div class="flex justify-between border-b py-2 last:border-0">
            <div class="font-bold text-gray-700">₱${denom}</div>
            <div class="text-gray-900 mx-2">x ${breakdown[denom]}</div>
            <div class="font-bold text-gray-900">₱${(parseFloat(denom) * breakdown[denom]).toLocaleString()}</div>
        </div>
        `).join("");

    div.innerHTML = `
        </div>
        `;
    document.body.appendChild(div);
}

function showReportPrecountedModal(shift) {
    const bills = parseFloat(shift.precounted_bills) || 0;
    const coins = parseFloat(shift.precounted_coins) || 0;

    const div = document.createElement("div");
    div.className = "fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-[70]";
    div.innerHTML = `
        </div>
        `;
    document.body.appendChild(div);
}

// --- Drill Down Views ---

async function showShiftTransactions(shift) {
    const db = await dbPromise;
    const startTime = new Date(shift.start_time);
    const endTime = shift.end_time ? new Date(shift.end_time) : new Date();
    const userEmailNormalized = (shift.user_id || "").trim().toLowerCase();

    // Fetch transactions for this shift (using JS filter for reliable date matching)
    const allTransactions = await db.transactions.toArray();
    const txs = allTransactions.filter(tx => {
        const txTime = new Date(tx.timestamp);
        return txTime >= startTime && txTime <= endTime;
    });

    // Filter to user with normalized comparison
    const userTxs = txs.filter(t => {
        const txUserNormalized = (t.user_email || "").trim().toLowerCase();
        return txUserNormalized === userEmailNormalized && !t.is_voided;
    });

    const contentContainer = document.getElementById("report-modal-content");
    const metricsContainer = document.getElementById("report-metrics-container");

    // Update Header for context
    metricsContainer.innerHTML = `
        </div>
        `;

    document.getElementById("btn-back-shift-detail").addEventListener("click", () => renderShiftDetail(shift.id));

    if (userTxs.length === 0) {
        contentContainer.innerHTML = `<div class="p-10 text-center text-gray-500"> No transactions found for this shift.</div>`;
        return;
    }

    contentContainer.innerHTML = `
        <div class="overflow-hidden border border-gray-200 rounded-lg">
            <table class="min-w-full bg-white">
                <thead class="bg-gray-50 border-b border-gray-200">
                    <tr>
                        <th class="py-2 px-4 text-left text-xs font-semibold text-gray-600 uppercase">Time</th>
                        <th class="py-2 px-4 text-left text-xs font-semibold text-gray-600 uppercase">Type</th>
                        <th class="py-2 px-4 text-center text-xs font-semibold text-gray-600 uppercase">Method</th>
                        <th class="py-2 px-4 text-right text-xs font-semibold text-gray-600 uppercase">Total</th>
                        <th class="py-2 px-4 text-right text-xs font-semibold text-gray-600 uppercase"></th>
                    </tr>
                </thead>
                <tbody class="text-sm divide-y divide-gray-100">
                    ${userTxs.map(tx => `
                        <tr class="hover:bg-blue-50 cursor-pointer transition-colors tx-row" data-id="${tx.id}">
                            <td class="py-3 px-4 text-gray-700 whitespace-nowrap">${new Date(tx.timestamp).toLocaleTimeString()}</td>
                            <td class="py-3 px-4">
                                <span class="bg-blue-100 text-blue-800 text-[10px] px-2 py-1 rounded-full font-bold">SALE</span>
                            </td>
                            <td class="py-3 px-4 text-center text-gray-600 text-xs">${tx.payment_method || 'Cash'}</td>
                            <td class="py-3 px-4 text-right font-bold text-gray-800">₱${(tx.total_amount || 0).toFixed(2)}</td>
                             <td class="py-3 px-4 text-right text-gray-400">→</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        `;

    contentContainer.querySelectorAll('.tx-row').forEach(row => {
        row.addEventListener('click', () => {
            const tx = userTxs.find(t => t.id == row.dataset.id); // Loose select for ID
            if (tx) showTransactionDetails(tx, shift);
        });
    });
}

function showTransactionDetails(tx, shift) {
    const contentContainer = document.getElementById("report-modal-content");
    const metricsContainer = document.getElementById("report-metrics-container");

    // Update Header
    metricsContainer.innerHTML = `
        < div class="p-4 bg-gray-50 border-b border-gray-200 flex justify-between items-center" >
             <button id="btn-back-tx-list" class="flex items-center text-gray-600 hover:text-blue-600 transition font-medium">
                <svg class="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
                Back to Transactions
            </button>
            <div class="text-right">
                <div class="text-xs text-gray-500">Transaction ID</div>
                <div class="font-mono text-sm font-bold text-gray-800">#${tx.id}</div>
            </div>
        </div >
        `;

    document.getElementById("btn-back-tx-list").addEventListener("click", () => showShiftTransactions(shift));

    const items = tx.items || [];

    contentContainer.innerHTML = `
        < div class="p-4 bg-white rounded-lg border shadow-sm max-w-2xl mx-auto mt-4" >
            <div class="flex justify-between items-center mb-4 border-b pb-4">
                <div>
                    <div class="text-sm text-gray-500">Date</div>
                    <div class="font-bold">${new Date(tx.timestamp).toLocaleString()}</div>
                </div>
                 <div class="text-right">
                    <div class="text-sm text-gray-500">Payment</div>
                    <div class="font-bold text-blue-600 uppercase">${tx.payment_method || 'Cash'}</div>
                </div>
            </div>

            <table class="min-w-full text-sm mb-6">
                <thead class="bg-gray-50">
                    <tr>
                        <th class="py-2 px-3 text-left font-medium text-gray-600">Item</th>
                        <th class="py-2 px-3 text-center font-medium text-gray-600">Qty</th>
                        <th class="py-2 px-3 text-right font-medium text-gray-600">Price</th>
                        <th class="py-2 px-3 text-right font-medium text-gray-600">Total</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-gray-100">
                    ${items.map(item => `
                        <tr>
                            <td class="py-2 px-3 text-gray-800">
                                <div class="font-medium">${item.name}</div>
                                <div class="text-[10px] text-gray-500">${item.barcode || ''}</div>
                            </td>
                            <td class="py-2 px-3 text-center text-gray-600">x${item.qty}</td>
                            <td class="py-2 px-3 text-right text-gray-600">₱${item.price.toFixed(2)}</td>
                            <td class="py-2 px-3 text-right font-bold text-gray-800">₱${(item.price * item.qty).toFixed(2)}</td>
                        </tr>
                    `).join('')}
                </tbody>
                <tfoot class="border-t border-gray-200">
                    <tr>
                        <td colspan="3" class="py-3 px-3 text-right font-bold text-gray-600">Total</td>
                        <td class="py-3 px-3 text-right font-bold text-xl text-blue-700">₱${(tx.total_amount || 0).toFixed(2)}</td>
                    </tr>
                     ${tx.cash_received ? `
                    <tr>
                        <td colspan="3" class="py-1 px-3 text-right text-gray-500 text-xs">Cash Tendered</td>
                        <td class="py-1 px-3 text-right text-gray-600 text-xs">₱${tx.cash_received.toFixed(2)}</td>
                    </tr>
                    <tr>
                        <td colspan="3" class="py-1 px-3 text-right text-gray-500 text-xs">Change</td>
                        <td class="py-1 px-3 text-right text-gray-600 text-xs">₱${(tx.change || 0).toFixed(2)}</td>
                    </tr>
                    ` : ''}
                </tfoot>
            </table>
        </div >
        `;
}

function renderStockMovement(movements) {
    const metricsContainer = document.getElementById("report-metrics-container");
    const contentContainer = document.getElementById("report-modal-content");

    // Clear Metrics for this view (or add summary later)
    metricsContainer.innerHTML = "";
    contentContainer.innerHTML = "";

    if (!movements || movements.length === 0) {
        contentContainer.innerHTML = `< div class="p-10 text-center text-gray-500" > No movements found for this period.</div > `;
        return;
    }

    // Check for limit warning (which we prepended before, but now we must handle carefully since we clear innerHTML)
    // The caller might modify DOM after this, but let's handle it purely. 
    // Actually, the caller codes: prepend(warning).
    // So we just set the main table here.

    contentContainer.innerHTML = `
        < div class="overflow-hidden border border-gray-200 rounded-lg" >
            <table class="min-w-full bg-white">
                <thead class="bg-gray-50 border-b border-gray-200">
                    <tr>
                        <th class="py-2 px-4 border-b text-left text-xs font-semibold text-gray-600 uppercase">Date</th>
                        <th class="py-2 px-4 border-b text-left text-xs font-semibold text-gray-600 uppercase">Input</th>
                        <th class="py-2 px-4 border-b text-left text-xs font-semibold text-gray-600 uppercase">Item</th>
                        <th class="py-2 px-4 border-b text-right text-xs font-semibold text-gray-600 uppercase">Qty</th>
                        <th class="py-2 px-4 border-b text-left text-xs font-semibold text-gray-600 uppercase">Reason</th>
                        <th class="py-2 px-4 border-b text-left text-xs font-semibold text-gray-600 uppercase">User</th>
                    </tr>
                </thead>
                <tbody class="text-sm divide-y divide-gray-100">
                    ${movements.map(m => `
                        <tr class="hover:bg-gray-50">
                            <td class="py-2 px-4 text-gray-900 whitespace-nowrap">${new Date(m.timestamp).toLocaleString()}</td>
                             <td class="py-2 px-4">
                                <span class="px-2 py-1 rounded text-xs font-bold ${m.type === 'Sale' ? 'bg-green-100 text-green-800' :
            m.type === 'Return' ? 'bg-yellow-100 text-yellow-800' :
                m.type === 'Shrinkage' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-800'
        }">${m.type}</span>
                            </td>
                            <td class="py-2 px-4 text-gray-700">${m.item_name || 'Unkown'} <span class="text-xs text-gray-400">(${m.item_id || '-'})</span></td>
                            <td class="py-2 px-4 text-right ${m.qty < 0 ? 'text-red-600' : 'text-green-600'} font-bold">${m.qty}</td>
                            <td class="py-2 px-4 text-gray-500">${m.reason || '-'}</td>
                             <td class="py-2 px-4 text-gray-500 text-xs">${m.user || '-'}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div >
        `;
}

function closeReportModal() {
    document.getElementById("report-modal").classList.add("hidden");
    document.getElementById("report-metrics-container").innerHTML = "";
    document.getElementById("report-modal-content").innerHTML = "";
    currentModalReportId = null;
}

// --- Inventory Valuation Logic ---
// Updated: Enabled and Implemented (with Charts)

let invValAllItems = [];
let invValSuppliers = []; // Store for mapping
let invValState = {
    search: '',
    hideZeroNegative: false,
    sortKey: 'name',
    sortDir: 'asc',
    chartGroupBy: 'category', // 'category' | 'supplier'
    chartMetric: 'value'      // 'qty' | 'value'
};
let invValChartInstance = null;

function renderInventoryValuation(items, suppliers = []) {
    invValAllItems = items.map(i => ({
        ...i,
        subtotal: (i.cost_price || 0) * (i.stock_level || 0)
    }));
    invValSuppliers = suppliers;

    // Reset state for new report view
    invValState = {
        search: '',
        hideZeroNegative: false,
        sortKey: 'name',
        sortDir: 'asc',
        chartGroupBy: 'category',
        chartMetric: 'value'
    };

    const content = document.getElementById("report-modal-content");

    // Render Metrics
    renderInvValMetrics();

    // Render Layout
    content.innerHTML = `
        < !--Chart Section-- >
        <div class="bg-white border rounded-lg shadow-sm p-4 mb-6">
            <div class="flex flex-col sm:flex-row justify-between items-center mb-4">
                <h4 class="font-bold text-gray-800 flex items-center gap-2">
                    <svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"></path></svg>
                    Inventory Distribution
                </h4>
                <div class="flex gap-2 text-xs">
                    <div class="flex bg-gray-100 rounded-lg p-1">
                        <button class="px-3 py-1 rounded-md font-medium transition-colors ${invValState.chartGroupBy === 'category' ? 'bg-white shadow text-blue-600' : 'text-gray-600 hover:text-gray-900'}" id="iv-chart-grp-cat">By Category</button>
                        <button class="px-3 py-1 rounded-md font-medium transition-colors ${invValState.chartGroupBy === 'supplier' ? 'bg-white shadow text-blue-600' : 'text-gray-600 hover:text-gray-900'}" id="iv-chart-grp-sup">By Supplier</button>
                    </div>
                    <div class="w-px bg-gray-300 mx-1"></div>
                     <div class="flex bg-gray-100 rounded-lg p-1">
                        <button class="px-3 py-1 rounded-md font-medium transition-colors ${invValState.chartMetric === 'qty' ? 'bg-white shadow text-blue-600' : 'text-gray-600 hover:text-gray-900'}" id="iv-chart-met-qty">By Qty</button>
                        <button class="px-3 py-1 rounded-md font-medium transition-colors ${invValState.chartMetric === 'value' ? 'bg-white shadow text-blue-600' : 'text-gray-600 hover:text-gray-900'}" id="iv-chart-met-val">By Value</button>
                    </div>
                </div>
            </div>
            <div class="h-64 relative w-full">
                <canvas id="inv-val-chart"></canvas>
            </div>
        </div>

        <!--Controls -->
        <div class="flex flex-col sm:flex-row justify-between items-center mb-4 gap-4">
             <div class="relative w-full sm:w-auto">
                <span class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <svg class="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                </span>
                <input type="text" id="inv-val-search" class="pl-10 pr-4 py-2 border rounded-lg text-sm focus:ring-blue-500 focus:border-blue-500 w-full sm:w-64" placeholder="Search items...">
            </div>
            
            <div class="flex items-center gap-4">
                <label class="flex items-center space-x-2 text-sm text-gray-700 font-medium cursor-pointer select-none">
                    <input type="checkbox" id="inv-val-filter-zero" class="rounded text-blue-600 focus:ring-blue-500 border-gray-300 h-4 w-4">
                    <span>Hide Zero/Negative Qty</span>
                </label>
                
                <button id="inv-val-export" class="flex items-center justify-center px-4 py-2 border border-green-600 text-green-600 rounded-lg hover:bg-green-50 transition text-sm font-bold">
                    <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                    Export CSV
                </button>
            </div>
        </div>
        
        <div class="bg-white border rounded-lg overflow-hidden shadow-sm">
            <div class="overflow-x-auto">
                <table class="min-w-full divide-y divide-gray-200">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 group inv-val-sort" data-key="name">
                                Item Name <span class="sort-icon ml-1 text-gray-300">↓</span>
                            </th>
                            <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 group inv-val-sort" data-key="stock_level">
                                Quantity <span class="sort-icon ml-1 text-gray-300">↓</span>
                            </th>
                            <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 group inv-val-sort" data-key="cost_price">
                                Unit Cost <span class="sort-icon ml-1 text-gray-300">↓</span>
                            </th>
                            <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 group inv-val-sort" data-key="subtotal">
                                Subtotal <span class="sort-icon ml-1 text-gray-300">↓</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-200" id="inv-val-table-body">
                        <!-- Rows -->
                    </tbody>
                </table>
            </div>
             <div class="bg-gray-50 px-4 py-3 border-t border-gray-200 text-sm text-gray-500 text-right" id="inv-val-count">
                Showing 0 items
            </div>
        </div>
    `;

    // Initial Render
    renderInvValRows();
    renderInvValChart();

    // Listeners
    document.getElementById("inv-val-search").addEventListener("input", (e) => {
        invValState.search = e.target.value;
        renderInvValRows();
    });

    document.getElementById("inv-val-filter-zero").addEventListener("change", (e) => {
        invValState.hideZeroNegative = e.target.checked;
        renderInvValRows();
        renderInvValChart(); // Update chart too to match visible data? Or keep chart global?
        // Usually chart reflects filtered data, but "Hide Zero" specifically affects active inventory view. 
        // Let's update chart to match the "Active" perspective if checked.
    });

    // Chart Controls
    const updateChartState = (key, val) => {
        invValState[key] = val;
        // Update Button Styles
        const states = {
            chartGroupBy: ['cat', 'sup'],
            chartMetric: ['qty', 'val']
        };

        // This is a bit manual, but robust enough
        if (key === 'chartGroupBy') {
            document.getElementById('iv-chart-grp-cat').className = `px - 3 py - 1 rounded - md font - medium transition - colors ${val === 'category' ? 'bg-white shadow text-blue-600' : 'text-gray-600 hover:text-gray-900'} `;
            document.getElementById('iv-chart-grp-sup').className = `px - 3 py - 1 rounded - md font - medium transition - colors ${val === 'supplier' ? 'bg-white shadow text-blue-600' : 'text-gray-600 hover:text-gray-900'} `;
        }
        if (key === 'chartMetric') {
            document.getElementById('iv-chart-met-qty').className = `px - 3 py - 1 rounded - md font - medium transition - colors ${val === 'qty' ? 'bg-white shadow text-blue-600' : 'text-gray-600 hover:text-gray-900'} `;
            document.getElementById('iv-chart-met-val').className = `px - 3 py - 1 rounded - md font - medium transition - colors ${val === 'value' ? 'bg-white shadow text-blue-600' : 'text-gray-600 hover:text-gray-900'} `;
        }
        renderInvValChart();
    };

    document.getElementById('iv-chart-grp-cat').addEventListener('click', () => updateChartState('chartGroupBy', 'category'));
    document.getElementById('iv-chart-grp-sup').addEventListener('click', () => updateChartState('chartGroupBy', 'supplier'));
    document.getElementById('iv-chart-met-qty').addEventListener('click', () => updateChartState('chartMetric', 'qty'));
    document.getElementById('iv-chart-met-val').addEventListener('click', () => updateChartState('chartMetric', 'value'));


    document.querySelectorAll(".inv-val-sort").forEach(th => {
        th.addEventListener("click", () => {
            const key = th.dataset.key;
            if (invValState.sortKey === key) {
                invValState.sortDir = invValState.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                invValState.sortKey = key;
                invValState.sortDir = 'asc'; // Default
            }
            renderInvValRows();
        });
    });

    document.getElementById("inv-val-export").addEventListener("click", exportInvValCSV);
}

function renderInvValChart() {
    const canvas = document.getElementById("inv-val-chart");
    if (!canvas) return;

    if (invValChartInstance) invValChartInstance.destroy();

    // Aggregate Data
    const { chartGroupBy, chartMetric, hideZeroNegative } = invValState;
    const items = invValAllItems.filter(i => !hideZeroNegative || i.stock_level > 0);

    // Group
    const groups = {};
    const supplierMap = new Map(invValSuppliers.map(s => [s.id, s.name]));

    items.forEach(item => {
        let key = 'Uncategorized';
        if (chartGroupBy === 'category') {
            key = item.category || 'Uncategorized';
        } else {
            // Supplier
            if (item.supplier_id) {
                key = supplierMap.get(item.supplier_id) || 'Unknown Supplier';
            } else {
                key = 'No Supplier';
            }
        }

        if (!groups[key]) groups[key] = 0;

        if (chartMetric === 'value') {
            groups[key] += (item.subtotal || 0);
        } else {
            groups[key] += (item.stock_level || 0);
        }
    });

    // Sort and Top 10
    const sorted = Object.entries(groups).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(x => x[0]).slice(0, 15);
    const data = sorted.map(x => x[1]).slice(0, 15);

    // Render
    const ctx = canvas.getContext('2d');
    invValChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: chartMetric === 'value' ? 'Inventory Value' : 'Item Quantity',
                data: data,
                backgroundColor: chartMetric === 'value' ? '#10b981' : '#3b82f6',
                borderRadius: 4,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (chartMetric === 'value') {
                                label += new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(context.raw);
                            } else {
                                label += context.raw;
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: function (value) {
                            if (chartMetric === 'value') return '₱' + value / 1000 + 'k';
                            return value;
                        }
                    }
                },
                x: {
                    grid: { display: false }
                }
            }
        }
    });
}


function renderInvValMetrics() {
    const metrics = document.getElementById("report-metrics-container");
    const totalValuation = invValAllItems.reduce((sum, i) => sum + i.subtotal, 0);
    const totalItems = invValAllItems.length;

    // Low stock count (assuming threshold in item or default 10)
    const lowStockItems = invValAllItems.filter(i => i.stock_level <= (i.min_stock || 10)).length;

    metrics.innerHTML = `
        < div class="grid grid-cols-1 md:grid-cols-3 gap-6 p-6" >
            <div class="p-4 bg-green-50 rounded-lg border border-green-100 flex flex-col justify-center">
                <div class="text-xs text-green-600 uppercase font-bold tracking-wider">Total Inventory Value</div>
                <div class="text-3xl font-bold text-green-800 mt-1">₱${totalValuation.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            </div>
            <div class="p-4 bg-blue-50 rounded-lg border border-blue-100 flex flex-col justify-center">
                <div class="text-xs text-blue-500 uppercase font-bold tracking-wider">Total Items</div>
                <div class="text-3xl font-bold text-blue-800 mt-1">${totalItems}</div>
            </div>
            <div class="p-4 bg-yellow-50 rounded-lg border border-yellow-100 flex flex-col justify-center">
                <div class="text-xs text-yellow-600 uppercase font-bold tracking-wider">Low Stock Items</div>
                <div class="text-3xl font-bold text-yellow-800 mt-1">${lowStockItems}</div>
            </div>
        </div >
        `;
}

function getFilteredInvValItems() {
    let items = invValAllItems.filter(item => {
        const matchesSearch = (item.name || "").toLowerCase().includes(invValState.search.toLowerCase());
        const passesZeroCheck = !invValState.hideZeroNegative || item.stock_level > 0;
        return matchesSearch && passesZeroCheck;
    });

    // Sort
    items.sort((a, b) => {
        const valA = a[invValState.sortKey];
        const valB = b[invValState.sortKey];

        // Handle undefined values
        if (valA === undefined) return 1;
        if (valB === undefined) return -1;

        let comparison = 0;
        if (typeof valA === 'string') {
            comparison = valA.localeCompare(valB);
        } else {
            comparison = valA - valB;
        }

        return invValState.sortDir === 'asc' ? comparison : -comparison;
    });

    return items;
}

function renderInvValRows() {
    const tbody = document.getElementById("inv-val-table-body");
    const filtered = getFilteredInvValItems();

    // Update Arrow Indicators
    document.querySelectorAll(".inv-val-sort").forEach(th => {
        const key = th.dataset.key;
        const icon = th.querySelector(".sort-icon");
        if (key === invValState.sortKey) {
            th.classList.add("text-gray-900");
            th.classList.remove("text-gray-500");
            icon.textContent = invValState.sortDir === 'asc' ? '↑' : '↓';
            icon.classList.remove("text-gray-300");
            icon.classList.add("text-gray-600");
        } else {
            th.classList.remove("text-gray-900");
            th.classList.add("text-gray-500");
            icon.textContent = '↓';
            icon.classList.add("text-gray-300");
            icon.classList.remove("text-gray-600");
        }
    });

    // Update Count
    document.getElementById("inv-val-count").textContent = `Showing ${filtered.length} items`;

    if (filtered.length === 0) {
        tbody.innerHTML = `< tr > <td colspan="4" class="px-6 py-4 text-center text-gray-500">No items found matching criteria.</td></tr > `;
        return;
    }

    const limit = 500;
    const displayItems = filtered.slice(0, limit);

    tbody.innerHTML = displayItems.map(item => `
        < tr class="hover:bg-gray-50" >
            <td class="px-6 py-4 whitespace-nowrap">
                <div class="text-sm font-medium text-gray-900">${item.name}</div>
                <div class="text-xs text-gray-500">${item.barcode || '-'}</div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-700 font-mono">
                ${item.stock_level}
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-right text-sm text-gray-500 font-mono">
                ₱${(item.cost_price || 0).toFixed(2)}
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-bold text-gray-900 font-mono">
                ₱${(item.subtotal || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
        </tr >
        `).join('') + (filtered.length > limit ? ` < tr > <td colspan="4" class="text-center py-2 text-xs text-gray-500">...and ${filtered.length - limit} more items (export to see all)</td></tr > ` : '');
}

function exportInvValCSV() {
    const items = getFilteredInvValItems();
    if (items.length === 0) {
        alert("No data to export");
        return;
    }

    const headers = ["Item Name", "Barcode", "Category", "Supplier ID", "Quantity", "Unit Cost", "Subtotal Value"];
    const rows = items.map(i => [
        `"${(i.name || '').replace(/"/g, '""')}"`, // Escape quotes
        `"${(i.barcode || '')}"`,
        `"${(i.category || '')}"`,
        `"${(i.supplier_id || '')}"`,
        i.stock_level,
        (i.cost_price || 0).toFixed(2),
        (i.subtotal || 0).toFixed(2)
    ]);

    const csvContent = [
        headers.join(","),
        ...rows.map(r => r.join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `inventory_valuation_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ============================================
// ===== Sales Summary Export Panel Logic ======
// ============================================

let exportPanelData = null; // Cached export data for download

function openSalesExportPanel() {
    console.log('[Export] Opening sales export panel');
    const contentContainer = document.getElementById("report-modal-content");

    // Get current report range dates for defaults
    const drp = $('#report-range').data('daterangepicker');
    const defaultStart = drp ? drp.startDate.format('YYYY-MM-DD') : new Date().toISOString().split('T')[0];
    const defaultEnd = drp ? drp.endDate.format('YYYY-MM-DD') : new Date().toISOString().split('T')[0];

    contentContainer.innerHTML = `
        <div class="max-w-5xl mx-auto">
            <!-- Export Panel Header -->
            <div class="flex items-center justify-between mb-6">
                <div class="flex items-center gap-3">
                    <button id="btn-export-back" class="flex items-center text-gray-600 hover:text-blue-600 transition font-medium px-3 py-1 rounded hover:bg-white border border-transparent hover:border-gray-200">
                        <svg class="w-5 h-5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
                        Back to Summary
                    </button>
                </div>
                <h3 class="text-lg font-bold text-gray-800">Export Sales Data</h3>
            </div>

            <!-- Config Card -->
            <div class="bg-white border border-gray-200 rounded-xl shadow-sm p-6 mb-6">
                <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <!-- Date Range -->
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Date Range</label>
                        <div class="flex gap-2">
                            <div class="flex-1">
                                <label class="block text-xs text-gray-400 mb-1">Start</label>
                                <input type="date" id="export-start-date" value="${defaultStart}" class="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-indigo-500 focus:border-indigo-500">
                            </div>
                            <div class="flex-1">
                                <label class="block text-xs text-gray-400 mb-1">End</label>
                                <input type="date" id="export-end-date" value="${defaultEnd}" class="w-full border border-gray-300 rounded-lg p-2 text-sm focus:ring-indigo-500 focus:border-indigo-500">
                            </div>
                        </div>
                    </div>

                    <!-- Detail Level -->
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Detail Level</label>
                        <div class="flex bg-gray-100 rounded-lg p-1 mt-1">
                            <button class="export-mode-btn flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors bg-white shadow text-indigo-600" data-mode="summarized">Summarized</button>
                            <button class="export-mode-btn flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors text-gray-600 hover:text-gray-900" data-mode="daily">Daily (Transactions)</button>
                        </div>
                        <p class="text-xs text-gray-400 mt-2" id="export-mode-desc">One row per day with totals.</p>
                    </div>

                    <!-- Format -->
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Export Format</label>
                        <div class="flex gap-2 mt-1">
                            <button class="export-fmt-btn flex-1 px-3 py-2 rounded-lg border-2 text-sm font-bold transition-all border-indigo-500 bg-indigo-50 text-indigo-700" data-fmt="csv">
                                <svg class="w-4 h-4 mx-auto mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                                CSV
                            </button>
                            <button class="export-fmt-btn flex-1 px-3 py-2 rounded-lg border-2 text-sm font-bold transition-all border-gray-200 bg-white text-gray-600 hover:border-gray-400" data-fmt="json">
                                <svg class="w-4 h-4 mx-auto mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path></svg>
                                JSON
                            </button>
                            <button class="export-fmt-btn flex-1 px-3 py-2 rounded-lg border-2 text-sm font-bold transition-all border-gray-200 bg-white text-gray-600 hover:border-gray-400" data-fmt="pdf">
                                <svg class="w-4 h-4 mx-auto mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path></svg>
                                PDF
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Action Buttons -->
                <div class="flex justify-between items-center mt-6 pt-4 border-t border-gray-100">
                    <button id="btn-generate-preview" class="flex items-center gap-2 px-5 py-2.5 bg-gray-800 hover:bg-gray-900 text-white rounded-lg text-sm font-bold shadow transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
                        Generate Preview
                    </button>
                    <button id="btn-download-export" class="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-bold shadow transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                        Download
                    </button>
                </div>
            </div>

            <!-- Preview Area -->
            <div id="export-preview-area" class="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                <div class="p-10 text-center text-gray-400">
                    <svg class="w-12 h-12 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                    <p class="text-sm">Click "Generate Preview" to see your data before exporting.</p>
                </div>
            </div>
        </div>
    `;

    // State
    let currentMode = 'summarized';
    let currentFormat = 'csv';
    exportPanelData = null;

    // Back button
    document.getElementById('btn-export-back').addEventListener('click', () => {
        generateReport('fin-summary');
    });

    // Mode toggle
    document.querySelectorAll('.export-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentMode = btn.dataset.mode;
            document.querySelectorAll('.export-mode-btn').forEach(b => {
                b.classList.remove('bg-white', 'shadow', 'text-indigo-600');
                b.classList.add('text-gray-600');
            });
            btn.classList.remove('text-gray-600');
            btn.classList.add('bg-white', 'shadow', 'text-indigo-600');
            document.getElementById('export-mode-desc').textContent = currentMode === 'summarized'
                ? 'One row per day with totals.'
                : 'One row per transaction with full details.';
            // Clear preview when mode changes
            exportPanelData = null;
            console.log('[Export] Mode changed to:', currentMode);
            document.getElementById('export-preview-area').innerHTML = `
                <div class="p-10 text-center text-gray-400">
                    <svg class="w-12 h-12 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                    <p class="text-sm">Click "Generate Preview" to see your data before exporting.</p>
                </div>
            `;
        });
    });

    // Format toggle
    document.querySelectorAll('.export-fmt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentFormat = btn.dataset.fmt;
            document.querySelectorAll('.export-fmt-btn').forEach(b => {
                b.classList.remove('border-indigo-500', 'bg-indigo-50', 'text-indigo-700');
                b.classList.add('border-gray-200', 'bg-white', 'text-gray-600');
            });
            btn.classList.remove('border-gray-200', 'bg-white', 'text-gray-600');
            btn.classList.add('border-indigo-500', 'bg-indigo-50', 'text-indigo-700');
        });
    });

    // Shared helper: fetch export data from worker
    async function fetchExportData() {
        const startDate = document.getElementById('export-start-date').value;
        const endDate = document.getElementById('export-end-date').value;
        if (!startDate || !endDate) { alert('Please select both start and end dates.'); return null; }
        if (new Date(startDate) > new Date(endDate)) { alert('Start date must be before end date.'); return null; }

        console.log(`[Export] Fetching data: ${startDate} to ${endDate}, mode: ${currentMode}`);
        const t0 = performance.now();

        const startStr = new Date(startDate + 'T00:00:00').toISOString();
        const endStr = new Date(endDate + 'T23:59:59').toISOString();

        const db = await dbPromise;
        console.log('[Export] DB opened');

        // Pre-filter transactions by date at DB level (avoids loading entire history)
        const transactions = await db.transactions
            .where('timestamp').between(startStr, endStr, true, true)
            .toArray();
        console.log(`[Export] Loaded ${transactions.length} transactions (filtered) in ${(performance.now() - t0).toFixed(0)}ms`);

        // Build lightweight cost map instead of sending all item objects
        const allItems = await db.items.toArray();
        const itemCostMap = {};
        allItems.forEach(i => { itemCostMap[i.id] = { cost_price: i.cost_price || 0, category: i.category || 'Uncategorized' }; });
        console.log(`[Export] Built cost map for ${allItems.length} items`);

        // Strip transactions to ONLY fields the worker needs (avoids massive structured clone)
        const leanTxs = transactions.map(tx => ({
            id: tx.id,
            timestamp: tx.timestamp,
            is_voided: tx.is_voided,
            total_amount: tx.total_amount,
            user_email: tx.user_email,
            payment_method: tx.payment_method,
            items: (tx.items || []).map(li => ({ id: li.id, qty: li.qty, cost: li.cost, price: li.price }))
        }));
        console.log(`[Export] Stripped ${leanTxs.length} transactions for worker in ${(performance.now() - t0).toFixed(0)}ms`);

        console.log('[Export] Dispatching to worker...');
        generalReportWorker.postMessage({
            type: 'GENERATE_EXPORT_DATA',
            payload: { transactions: leanTxs, itemCostMap, startDate: startStr, endDate: endStr, mode: currentMode }
        });
        console.log(`[Export] postMessage sent in ${(performance.now() - t0).toFixed(0)}ms`);

        const result = await new Promise((resolve, reject) => {
            exportResolve = resolve;
            exportReject = reject;
        });

        console.log(`[Export] Worker returned ${result.totalRows} rows in ${(performance.now() - t0).toFixed(0)}ms total`);
        exportPanelData = result;
        return result;
    }

    // Generate Preview (optional — just for viewing)
    document.getElementById('btn-generate-preview').addEventListener('click', async () => {
        const previewArea = document.getElementById('export-preview-area');
        previewArea.innerHTML = `<div class="flex justify-center items-center p-10"><div class="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600"></div></div>`;
        try {
            const result = await fetchExportData();
            if (result) renderExportPreview(result);
        } catch (err) {
            console.error('[Export] Preview error:', err);
            previewArea.innerHTML = `<div class="p-6 text-center text-red-500"><p class="font-bold">Error generating preview</p><p class="text-sm mt-1">${err.message}</p></div>`;
        }
    });

    // Download — works independently, fetches data if not already cached
    document.getElementById('btn-download-export').addEventListener('click', async () => {
        const startDate = document.getElementById('export-start-date').value;
        const endDate = document.getElementById('export-end-date').value;
        console.log(`[Export] Download clicked, format: ${currentFormat}`);

        try {
            // Fetch data if not already available
            if (!exportPanelData) {
                console.log('[Export] No cached data, fetching first...');
                const btn = document.getElementById('btn-download-export');
                btn.innerHTML = `<div class="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div> Preparing...`;
                btn.disabled = true;
                const result = await fetchExportData();
                btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg> Download`;
                btn.disabled = false;
                if (!result) return;
            }

            console.log(`[Export] Exporting as ${currentFormat}, ${exportPanelData.totalRows} rows`);
            if (currentFormat === 'csv') exportSalesCSV(exportPanelData, startDate, endDate);
            else if (currentFormat === 'json') exportSalesJSON(exportPanelData, startDate, endDate);
            else if (currentFormat === 'pdf') exportSalesPDF(exportPanelData, startDate, endDate);
        } catch (err) {
            console.error('[Export] Download error:', err);
            alert('Export failed: ' + err.message);
        }
    });
}

function renderExportPreview(data) {
    console.log('[Export] Rendering preview table...');
    const t0 = performance.now();
    const previewArea = document.getElementById('export-preview-area');
    const { mode, rows, totalRows } = data;
    const previewRows = rows.slice(0, 15);

    if (rows.length === 0) {
        previewArea.innerHTML = `
            <div class="p-10 text-center text-gray-400">
                <svg class="w-12 h-12 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path></svg>
                <p class="text-sm font-medium">No transactions found for this date range.</p>
            </div>
        `;
        return;
    }

    let tableHTML = '';

    if (mode === 'daily') {
        tableHTML = `
            <div class="bg-gray-50 px-4 py-3 border-b border-gray-200 flex justify-between items-center">
                <span class="text-sm font-bold text-gray-700">Preview — Daily Transactions</span>
                <span class="text-xs text-gray-500">${totalRows} total rows${totalRows > 15 ? ' (showing first 15)' : ''}</span>
            </div>
            <div class="overflow-x-auto">
                <table class="min-w-full divide-y divide-gray-200 text-sm">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Transaction ID</th>
                            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Cashier</th>
                            <th class="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase">Payment</th>
                            <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Items</th>
                            <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Gross Sales</th>
                            <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">COGS</th>
                            <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Net Sales</th>
                        </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-100">
                        ${previewRows.map(r => `
                            <tr class="hover:bg-gray-50">
                                <td class="px-4 py-2 text-gray-700">${r.date}</td>
                                <td class="px-4 py-2 text-gray-500">${r.time}</td>
                                <td class="px-4 py-2 font-mono text-xs text-gray-500">${(r.transactionId || '').slice(0, 12)}...</td>
                                <td class="px-4 py-2 text-gray-600">${r.cashier}</td>
                                <td class="px-4 py-2 text-center"><span class="px-2 py-0.5 rounded-full text-xs font-bold ${r.paymentMethod === 'Cash' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}">${r.paymentMethod}</span></td>
                                <td class="px-4 py-2 text-right font-mono text-gray-600">${r.itemCount}</td>
                                <td class="px-4 py-2 text-right font-mono font-medium text-gray-800">₱${r.grossSales.toFixed(2)}</td>
                                <td class="px-4 py-2 text-right font-mono text-red-500">₱${r.cogs.toFixed(2)}</td>
                                <td class="px-4 py-2 text-right font-mono font-bold text-green-700">₱${r.netSales.toFixed(2)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    } else {
        tableHTML = `
            <div class="bg-gray-50 px-4 py-3 border-b border-gray-200 flex justify-between items-center">
                <span class="text-sm font-bold text-gray-700">Preview — Daily Summary</span>
                <span class="text-xs text-gray-500">${totalRows} total rows${totalRows > 15 ? ' (showing first 15)' : ''}</span>
            </div>
            <div class="overflow-x-auto">
                <table class="min-w-full divide-y divide-gray-200 text-sm">
                    <thead class="bg-gray-50">
                        <tr>
                            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                            <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Transactions</th>
                            <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Gross Sales</th>
                            <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">COGS</th>
                            <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Net Sales</th>
                            <th class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Avg Ticket</th>
                            <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Payment Methods</th>
                        </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-100">
                        ${previewRows.map(r => `
                            <tr class="hover:bg-gray-50">
                                <td class="px-4 py-2 font-medium text-gray-800">${r.date}</td>
                                <td class="px-4 py-2 text-right font-mono text-gray-600">${r.transactionCount}</td>
                                <td class="px-4 py-2 text-right font-mono font-medium text-gray-800">₱${r.grossSales.toFixed(2)}</td>
                                <td class="px-4 py-2 text-right font-mono text-red-500">₱${r.cogs.toFixed(2)}</td>
                                <td class="px-4 py-2 text-right font-mono font-bold text-green-700">₱${r.netSales.toFixed(2)}</td>
                                <td class="px-4 py-2 text-right font-mono text-gray-600">₱${r.avgTicket.toFixed(2)}</td>
                                <td class="px-4 py-2 text-gray-500 text-xs">${r.paymentMethods}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // Grand totals
    const totalGross = rows.reduce((s, r) => s + r.grossSales, 0);
    const totalCogs = rows.reduce((s, r) => s + r.cogs, 0);
    const totalNet = rows.reduce((s, r) => s + r.netSales, 0);

    tableHTML += `
        <div class="bg-gray-50 px-4 py-3 border-t border-gray-200 flex justify-between items-center text-sm">
            <span class="font-bold text-gray-700">Totals</span>
            <div class="flex gap-6">
                <span class="text-gray-600">Gross: <b class="text-gray-800">₱${totalGross.toFixed(2)}</b></span>
                <span class="text-gray-600">COGS: <b class="text-red-600">₱${totalCogs.toFixed(2)}</b></span>
                <span class="text-gray-600">Net: <b class="text-green-700">₱${totalNet.toFixed(2)}</b></span>
            </div>
        </div>
    `;

    previewArea.innerHTML = tableHTML;
    console.log(`[Export] Preview rendered in ${(performance.now() - t0).toFixed(0)}ms`);
}

// --- Export Download Functions ---

function exportSalesCSV(data, startDate, endDate) {
    console.log('[Export] Building CSV...');
    const { mode, rows } = data;
    let headers, csvRows;

    if (mode === 'daily') {
        headers = ['Date', 'Time', 'Transaction ID', 'Cashier', 'Payment Method', 'Item Count', 'Gross Sales', 'COGS', 'Net Sales'];
        csvRows = rows.map(r => [
            `"${r.date}"`, `"${r.time}"`, `"${r.transactionId}"`, `"${r.cashier}"`,
            `"${r.paymentMethod}"`, r.itemCount, r.grossSales.toFixed(2), r.cogs.toFixed(2), r.netSales.toFixed(2)
        ]);
    } else {
        headers = ['Date', 'Transactions', 'Gross Sales', 'COGS', 'Net Sales', 'Avg Ticket', 'Payment Methods'];
        csvRows = rows.map(r => [
            `"${r.date}"`, r.transactionCount, r.grossSales.toFixed(2), r.cogs.toFixed(2),
            r.netSales.toFixed(2), r.avgTicket.toFixed(2), `"${r.paymentMethods}"`
        ]);
    }

    const csvContent = [headers.join(','), ...csvRows.map(r => r.join(','))].join('\n');
    downloadFile(csvContent, `sales_${mode}_${startDate}_to_${endDate}.csv`, 'text/csv;charset=utf-8;');
    console.log('[Export] CSV download triggered');
}

function exportSalesJSON(data, startDate, endDate) {
    console.log('[Export] Building JSON...');
    const { mode, rows } = data;
    const exportObj = {
        reportType: 'Sales Summary',
        mode,
        dateRange: { start: startDate, end: endDate },
        generatedAt: new Date().toISOString(),
        totalRows: rows.length,
        data: rows.map(r => {
            // Strip internal fields
            const clean = { ...r };
            delete clean._sortDate;
            delete clean.paymentBreakdown;
            return clean;
        })
    };
    const jsonStr = JSON.stringify(exportObj, null, 2);
    downloadFile(jsonStr, `sales_${mode}_${startDate}_to_${endDate}.json`, 'application/json');
    console.log('[Export] JSON download triggered');
}

function exportSalesPDF(data, startDate, endDate) {
    console.log('[Export] Building PDF...');
    const { mode, rows } = data;

    if (typeof window.jspdf === 'undefined') {
        alert('PDF library not loaded. Please check your internet connection and refresh.');
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape' });

    // Title
    doc.setFontSize(16);
    doc.text('Sales Summary Report', 14, 18);
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Period: ${startDate} to ${endDate}  |  Mode: ${mode === 'daily' ? 'Daily Transactions' : 'Daily Summary'}  |  Generated: ${new Date().toLocaleString()}`, 14, 25);

    let head, body;

    if (mode === 'daily') {
        head = [['Date', 'Time', 'Transaction ID', 'Cashier', 'Payment', 'Items', 'Gross Sales', 'COGS', 'Net Sales']];
        body = rows.map(r => [
            r.date, r.time, (r.transactionId || '').slice(0, 16), r.cashier,
            r.paymentMethod, r.itemCount, r.grossSales.toFixed(2), r.cogs.toFixed(2), r.netSales.toFixed(2)
        ]);
    } else {
        head = [['Date', 'Transactions', 'Gross Sales', 'COGS', 'Net Sales', 'Avg Ticket', 'Payment Methods']];
        body = rows.map(r => [
            r.date, r.transactionCount, r.grossSales.toFixed(2), r.cogs.toFixed(2),
            r.netSales.toFixed(2), r.avgTicket.toFixed(2), r.paymentMethods
        ]);
    }

    // Grand totals row
    const totalGross = rows.reduce((s, r) => s + r.grossSales, 0);
    const totalCogs = rows.reduce((s, r) => s + r.cogs, 0);
    const totalNet = rows.reduce((s, r) => s + r.netSales, 0);

    if (mode === 'daily') {
        body.push(['', '', '', '', 'TOTALS', '', totalGross.toFixed(2), totalCogs.toFixed(2), totalNet.toFixed(2)]);
    } else {
        const totalTx = rows.reduce((s, r) => s + r.transactionCount, 0);
        body.push(['TOTALS', totalTx, totalGross.toFixed(2), totalCogs.toFixed(2), totalNet.toFixed(2), '', '']);
    }

    doc.autoTable({
        head,
        body,
        startY: 30,
        theme: 'grid',
        headStyles: { fillColor: [67, 56, 202], fontSize: 8 },
        bodyStyles: { fontSize: 7 },
        alternateRowStyles: { fillColor: [245, 247, 250] },
        didParseCell: function(data) {
            // Bold the totals row
            if (data.row.index === body.length - 1) {
                data.cell.styles.fontStyle = 'bold';
                data.cell.styles.fillColor = [229, 231, 235];
            }
        }
    });

    doc.save(`sales_${mode}_${startDate}_to_${endDate}.pdf`);
    console.log('[Export] PDF download triggered');
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
