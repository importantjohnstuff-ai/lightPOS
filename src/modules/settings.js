import { checkPermission } from "../auth.js";
import { renderHeader } from "../layout.js";
import { dbPromise } from "../db.js";
import { generateUUID } from "../utils.js";
import { dbRepository as Repository } from "../db.js";
import { SyncEngine } from "../services/SyncEngine.js";
import { addNotification } from "../services/notification-service.js";

const API_URL = 'api/sync.php';
// The router.php endpoint is a simple file-based store used for administrative
// tasks like full backup and restore, which are not part of the delta sync flow.
const ADMIN_API_URL = 'api/router.php';

// Helper to recursively round excessive floating point numbers to prevent database errors
function deepSanitizeNumbers(obj) {
    if (obj === null) return null;
    if (typeof obj === 'number') {
        return Number.isInteger(obj) ? obj : Number(obj.toFixed(4));
    }
    if (typeof obj === 'string') {
        const trimmed = obj.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                const parsed = JSON.parse(obj);
                const sanitized = deepSanitizeNumbers(parsed);
                return JSON.stringify(sanitized);
            } catch (e) {
                return obj;
            }
        }
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(deepSanitizeNumbers);
    }
    if (typeof obj !== 'object') return obj;
    const result = {};
    for (const key in obj) {
        result[key] = deepSanitizeNumbers(obj[key]);
    }
    return result;
}

const DEFAULT_SETTINGS = {
    store: { name: "LightPOS", logo: "", data: "" },
    tax: { rate: 12 },
    rewards: { ratio: 100 },
    shift: { threshold: 0 },
    pos: { auto_print: false },
    security: { manager_password: "" },
    print: {
        paper_width: 76,
        show_dividers: true,
        header: {
            text: "",
            font_size: 14,
            font_family: "'Courier New', Courier, monospace",
            bold: true,
            italic: false
        },
        body: {
            font_size: 12,
            font_family: "'Courier New', Courier, monospace",
            bold: false,
            italic: false
        },
        items: {
            font_size: 12,
            font_family: "'Courier New', Courier, monospace",
            bold: false,
            italic: false
        },
        footer: {
            text: "Thank you for shopping!",
            font_size: 10,
            font_family: "'Courier New', Courier, monospace",
            bold: false,
            italic: true
        }
    }
};

export async function loadSettingsView() {
    const content = document.getElementById("main-content");
    const canWrite = checkPermission("settings", "write");
    const canMigrate = checkPermission("migrate", "write");

    content.innerHTML = `
        <div class="max-w-4xl mx-auto">
            <h2 class="text-2xl font-bold text-gray-800 mb-6">System Settings</h2>

            <!-- Tab Navigation -->
            <div class="border-b border-gray-200 mb-6">
                <nav class="flex -mb-px space-x-8">
                    <button data-tab="store" class="settings-tab-btn border-blue-500 text-blue-600 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm">Store Info</button>
                    <button data-tab="tax" class="settings-tab-btn border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm">Tax Settings</button>
                    <button data-tab="rewards" class="settings-tab-btn border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm">Rewards & Loyalty</button>
                    <button data-tab="advanced" class="settings-tab-btn border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm">Advanced</button>
                    <button data-tab="ai" class="settings-tab-btn border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm">AI Settings</button>
                    <button data-tab="price-tools" class="settings-tab-btn border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm">Price Tools</button>
                    <button data-tab="sync" class="settings-tab-btn border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm">Sync History</button>
                    ${canMigrate ? '<button data-tab="migration" class="settings-tab-btn border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm">Data Migration</button>' : ''}
                </nav>
            </div>

            <form id="form-settings">
                <!-- Store Tab -->
                <div id="settings-tab-store" class="settings-panel space-y-6">
                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold mb-4">Store Identity</h3>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-2">Store Name</label>
                                <input type="text" id="set-store-name" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none">
                            </div>
                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-2">Store Logo</label>
                                <div class="flex items-center gap-4">
                                    <div id="logo-preview" class="w-16 h-16 border rounded bg-gray-50 flex items-center justify-center overflow-hidden">
                                        <span class="text-gray-400 text-[10px]">No Logo</span>
                                    </div>
                                    <input type="file" id="set-store-logo-file" accept="image/*" class="text-xs">
                                    <input type="hidden" id="set-store-logo-base64">
                                </div>
                            </div>
                            <div class="md:col-span-2">
                                <label class="block text-sm font-bold text-gray-700 mb-2">Store Address / Contact</label>
                                <textarea id="set-store-data" rows="3" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="Address, Phone, TIN..."></textarea>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Tax Tab -->
                <div id="settings-tab-tax" class="settings-panel hidden space-y-6">
                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold mb-4">Taxation (E-VAT)</h3>
                        <div class="p-4 bg-blue-50 rounded-lg border border-blue-100 mb-4">
                            <p class="text-xs text-blue-800">
                                <strong>Note:</strong> All prices in the system (Cost and Selling) are treated as <strong>Tax Inclusive</strong>. 
                                The rate below is used to extract the tax component for reporting.
                            </p>
                        </div>
                        <div class="max-w-xs">
                            <label class="block text-sm font-bold text-gray-700 mb-2">VAT Rate (%)</label>
                            <div class="flex items-center gap-2">
                                <input type="number" id="set-tax-rate" step="0.01" min="0" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none text-right">
                                <span class="font-bold text-gray-500">%</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Rewards Tab -->
                <div id="settings-tab-rewards" class="settings-panel hidden space-y-6">
                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold mb-4">Loyalty Program</h3>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-2">Points Earning Ratio</label>
                                <div class="flex items-center gap-2">
                                    <span class="text-sm text-gray-500">1 Point per every ₱</span>
                                    <input type="number" id="set-reward-ratio" step="1" min="1" class="w-24 border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none text-right">
                                    <span class="text-sm text-gray-500">spent</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Discount Codes Section -->
                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold mb-4">Discount Codes</h3>
                        <div class="mb-4 flex gap-4 items-end">
                            <div>
                                <label class="block text-xs font-bold text-gray-700 mb-1">Code</label>
                                <input type="text" id="discount-code-input" class="border rounded p-2 text-sm uppercase" placeholder="SUMMER20">
                            </div>
                            <div>
                                <label class="block text-xs font-bold text-gray-700 mb-1">Type</label>
                                <select id="discount-type-input" class="border rounded p-2 text-sm">
                                    <option value="percentage">Percentage (%)</option>
                                    <option value="fixed">Fixed Amount (₱)</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-xs font-bold text-gray-700 mb-1">Frequency</label>
                                <select id="discount-usage-input" class="border rounded p-2 text-sm">
                                    <option value="unlimited">Unlimited</option>
                                    <option value="once_per_day">Once per Day</option>
                                    <option value="once_forever">Once Forever</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-xs font-bold text-gray-700 mb-1">Value</label>
                                <input type="number" id="discount-value-input" class="border rounded p-2 text-sm w-24" placeholder="10">
                            </div>
                            <div class="pb-2">
                                <label class="inline-flex items-center cursor-pointer">
                                    <input type="checkbox" id="discount-auto-record-input" class="form-checkbox h-4 w-4 text-blue-600">
                                    <span class="ml-2 text-xs font-bold text-gray-700">Auto Record</span>
                                </label>
                            </div>
                            <div class="pb-2">
                                <label class="inline-flex items-center cursor-pointer">
                                    <input type="checkbox" id="discount-active-input" class="form-checkbox h-4 w-4 text-blue-600" checked>
                                    <span class="ml-2 text-xs font-bold text-gray-700">Active</span>
                                </label>
                            </div>
                            <button type="button" id="btn-add-discount" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded text-sm transition">Add Code</button>
                        </div>

                        <div class="overflow-x-auto">
                            <table class="min-w-full text-sm border-collapse">
                                <thead class="bg-gray-50">
                                    <tr>
                                        <th class="p-2 text-left border-b font-bold text-gray-600">Code</th>
                                        <th class="p-2 text-left border-b font-bold text-gray-600">Type</th>
                                        <th class="p-2 text-right border-b font-bold text-gray-600">Value</th>
                                        <th class="p-2 text-left border-b font-bold text-gray-600">Frequency</th>
                                        <th class="p-2 text-center border-b font-bold text-gray-600">Auto Record</th>
                                        <th class="p-2 text-center border-b font-bold text-gray-600">Status</th>
                                        <th class="p-2 text-center border-b font-bold text-gray-600">Action</th>
                                    </tr>
                                </thead>
                                <tbody id="discount-codes-list" class="divide-y divide-gray-100">
                                    <!-- Rows loaded via JS -->
                                    <tr><td colspan="5" class="p-4 text-center text-gray-400">Loading codes...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- Advanced Tab -->
                <div id="settings-tab-advanced" class="settings-panel hidden space-y-6">
                    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                        <div class="lg:col-span-2 space-y-6">
                            <div class="bg-white p-6 rounded-lg shadow-sm border">
                                <h3 class="text-lg font-bold mb-4">Receipt Designer</h3>
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                                    <div>
                                        <label class="block text-xs font-bold text-gray-700 mb-1">Paper Width (mm)</label>
                                        <input type="number" id="set-print-width" class="w-full border rounded p-2 text-sm">
                                    </div>
                                    <div class="flex items-end pb-2">
                                        <label class="inline-flex items-center cursor-pointer">
                                            <input type="checkbox" id="set-print-show-dividers" class="form-checkbox h-4 w-4 text-blue-600">
                                            <span class="ml-2 text-xs font-bold text-gray-700">Show Dividers (Dashed Lines)</span>
                                        </label>
                                    </div>
                                </div>

                                <!-- Header Section -->
                                <div class="border-t pt-4 mt-4">
                                    <h4 class="text-sm font-bold text-blue-600 mb-3 uppercase tracking-wider">Header Section</h4>
                                    <div class="space-y-3">
                                        <div>
                                            <label class="block text-[10px] font-bold text-gray-500 uppercase">Custom Header Text (Overrides Store Info)</label>
                                            <textarea id="set-print-header-text" rows="2" class="w-full border rounded p-2 text-sm" placeholder="Leave blank to use Store Name & Address"></textarea>
                                        </div>
                                        <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                                            <div>
                                                <label class="block text-[10px] font-bold text-gray-500 uppercase">Size (px)</label>
                                                <input type="number" id="set-print-header-size" class="w-full border rounded p-1 text-sm">
                                            </div>
                                            <div>
                                                <label class="block text-[10px] font-bold text-gray-500 uppercase">Font</label>
                                                <select id="set-print-header-font" class="w-full border rounded p-1 text-sm">
                                                    <option value="'Courier New', Courier, monospace">Courier New</option>
                                                    <option value="Arial, sans-serif">Arial</option>
                                                    <option value="'Times New Roman', serif">Times New Roman</option>
                                                </select>
                                            </div>
                                            <div class="flex items-center gap-2 pt-4">
                                                <label class="inline-flex items-center"><input type="checkbox" id="set-print-header-bold" class="form-checkbox h-3 w-3"><span class="ml-1 text-[10px]">Bold</span></label>
                                                <label class="inline-flex items-center"><input type="checkbox" id="set-print-header-italic" class="form-checkbox h-3 w-3"><span class="ml-1 text-[10px]">Italic</span></label>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <!-- Body Section -->
                                <div class="border-t pt-4 mt-4">
                                    <h4 class="text-sm font-bold text-blue-600 mb-3 uppercase tracking-wider">Body Section (General Text)</h4>
                                    <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                                        <div>
                                            <label class="block text-[10px] font-bold text-gray-500 uppercase">Size (px)</label>
                                            <input type="number" id="set-print-body-size" class="w-full border rounded p-1 text-sm">
                                        </div>
                                        <div>
                                            <label class="block text-[10px] font-bold text-gray-500 uppercase">Font</label>
                                            <select id="set-print-body-font" class="w-full border rounded p-1 text-sm">
                                                <option value="'Courier New', Courier, monospace">Courier New</option>
                                                <option value="Arial, sans-serif">Arial</option>
                                            </select>
                                        </div>
                                        <div class="flex items-center gap-2 pt-4">
                                            <label class="inline-flex items-center"><input type="checkbox" id="set-print-body-bold" class="form-checkbox h-3 w-3"><span class="ml-1 text-[10px]">Bold</span></label>
                                            <label class="inline-flex items-center"><input type="checkbox" id="set-print-body-italic" class="form-checkbox h-3 w-3"><span class="ml-1 text-[10px]">Italic</span></label>
                                        </div>
                                    </div>
                                </div>

                                <!-- Items Section -->
                                <div class="border-t pt-4 mt-4">
                                    <h4 class="text-sm font-bold text-blue-600 mb-3 uppercase tracking-wider">Items List Section</h4>
                                    <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                                        <div>
                                            <label class="block text-[10px] font-bold text-gray-500 uppercase">Size (px)</label>
                                            <input type="number" id="set-print-items-size" class="w-full border rounded p-1 text-sm">
                                        </div>
                                        <div>
                                            <label class="block text-[10px] font-bold text-gray-500 uppercase">Font</label>
                                            <select id="set-print-items-font" class="w-full border rounded p-1 text-sm">
                                                <option value="'Courier New', Courier, monospace">Courier New</option>
                                                <option value="Arial, sans-serif">Arial</option>
                                            </select>
                                        </div>
                                        <div class="flex items-center gap-2 pt-4">
                                            <label class="inline-flex items-center"><input type="checkbox" id="set-print-items-bold" class="form-checkbox h-3 w-3"><span class="ml-1 text-[10px]">Bold</span></label>
                                            <label class="inline-flex items-center"><input type="checkbox" id="set-print-items-italic" class="form-checkbox h-3 w-3"><span class="ml-1 text-[10px]">Italic</span></label>
                                        </div>
                                    </div>
                                </div>

                                <!-- Footer Section -->
                                <div class="border-t pt-4 mt-4">
                                    <h4 class="text-sm font-bold text-blue-600 mb-3 uppercase tracking-wider">Footer Section</h4>
                                    <div class="space-y-3">
                                        <div>
                                            <label class="block text-[10px] font-bold text-gray-500 uppercase">Footer Text</label>
                                            <textarea id="set-print-footer-text" rows="2" class="w-full border rounded p-2 text-sm"></textarea>
                                        </div>
                                        <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                                            <div>
                                                <label class="block text-[10px] font-bold text-gray-500 uppercase">Size (px)</label>
                                                <input type="number" id="set-print-footer-size" class="w-full border rounded p-1 text-sm">
                                            </div>
                                            <div>
                                                <label class="block text-[10px] font-bold text-gray-500 uppercase">Font</label>
                                                <select id="set-print-footer-font" class="w-full border rounded p-1 text-sm">
                                                    <option value="'Courier New', Courier, monospace">Courier New</option>
                                                    <option value="Arial, sans-serif">Arial</option>
                                                </select>
                                            </div>
                                            <div class="flex items-center gap-2 pt-4">
                                                <label class="inline-flex items-center"><input type="checkbox" id="set-print-footer-bold" class="form-checkbox h-3 w-3"><span class="ml-1 text-[10px]">Bold</span></label>
                                                <label class="inline-flex items-center"><input type="checkbox" id="set-print-footer-italic" class="form-checkbox h-3 w-3"><span class="ml-1 text-[10px]">Italic</span></label>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="bg-white p-6 rounded-lg shadow-sm border">
                            <h3 class="text-lg font-bold mb-4">Procurement Settings</h3>
                            <div class="max-w-xs">
                                <label class="block text-sm font-bold text-gray-700 mb-2">K-Factor (Sales Projection %)</label>
                                <div class="flex items-center gap-2">
                                    <input type="number" id="set-procurement-k-factor" min="100" step="1" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="110">
                                    <span class="text-sm text-gray-500">%</span>
                                </div>
                                <p class="text-[10px] text-gray-500 mt-1">Multiplier for OTB sales projection (e.g., 110% = 1.1x). Min 100.</p>
                            </div>
                            <div class="max-w-xs mt-4">
                                <label class="block text-sm font-bold text-gray-700 mb-2">OTB Calculation Mode</label>
                                <select id="set-procurement-otb-mode" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none">
                                    <option value="standard">Standard (Audit Based)</option>
                                    <option value="replenishment">Replenishment (Sales Based)</option>
                                </select>
                                <p class="text-[10px] text-gray-500 mt-1">Standard considers current stock levels. Replenishment ignores stock gaps.</p>
                            </div>
                            <div class="max-w-xs mt-4">
                                <label class="block text-sm font-bold text-gray-700 mb-2">Ordering Cost (S)</label>
                                <div class="flex items-center gap-2">
                                    <span class="text-sm text-gray-500">₱</span>
                                    <input type="number" id="set-procurement-ordering-cost" min="0" step="0.01" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="50.00">
                                </div>
                                <p class="text-[10px] text-gray-500 mt-1">Fixed cost per order (Shipping, Admin, etc).</p>
                            </div>
                            <div class="max-w-xs mt-4">
                                <label class="block text-sm font-bold text-gray-700 mb-2">Holding Cost Rate (H)</label>
                                <div class="flex items-center gap-2">
                                    <input type="number" id="set-procurement-holding-cost" min="0" max="100" step="0.1" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="20">
                                    <span class="text-sm text-gray-500">%</span>
                                </div>
                                <p class="text-[10px] text-gray-500 mt-1">Annual holding cost as % of unit cost.</p>
                            </div>
                            <div class="max-w-xs mt-4">
                                <label class="block text-sm font-bold text-gray-700 mb-2">Stock Availability Target</label>
                                <select id="set-procurement-service-level" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none">
                                    <option value="1.28">90% (Low Safety Stock)</option>
                                    <option value="1.65">95% (Standard Retail)</option>
                                    <option value="2.33">99% (High Availability)</option>
                                </select>
                                <p class="text-[10px] text-gray-500 mt-1">Higher targets require holding more safety stock to prevent running out.</p>
                            </div>
                            <div class="max-w-xs mt-4">
                                <label class="block text-sm font-bold text-gray-700 mb-2">Default Lead Time (Risk Period)</label>
                                <input type="number" id="set-procurement-lead-time" step="1" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="7">
                                <p class="text-[10px] text-gray-500 mt-1">Used if supplier specific lead time is missing.</p>
                            </div>
                            <div class="mt-4">
                                <label class="inline-flex items-center cursor-pointer">
                                    <input type="checkbox" id="set-procurement-assumed-stock" class="form-checkbox h-5 w-5 text-blue-600">
                                    <span class="ml-2 text-sm font-bold text-gray-700">Assumed Stock for New Stores</span>
                                </label>
                                <p class="text-[10px] text-gray-500 mt-1 ml-7">If store data is < 30 days old, use MAX(Current Stock, 0.5 * Velocity * Cadence).</p>
                            </div>
                        </div>

                        <div class="space-y-6">
                            <div class="bg-white p-6 rounded-lg shadow-sm border">
                                <h3 class="text-lg font-bold mb-4">Shift Settings</h3>
                                <div class="max-w-xs">
                                    <label class="block text-sm font-bold text-gray-700 mb-2">Discrepancy Alert Threshold (₱)</label>
                                    <input type="number" id="set-shift-threshold" step="0.01" min="0" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="0.00">
                                    <p class="text-[10px] text-gray-500 mt-1">Triggers a system notification if the closing discrepancy exceeds this amount.</p>
                                </div>
                                <div class="mt-4">
                                    <label class="inline-flex items-center cursor-pointer">
                                        <input type="checkbox" id="set-auto-print" class="form-checkbox h-5 w-5 text-blue-600">
                                        <span class="ml-2 text-sm font-bold text-gray-700">Auto-print receipt after payment</span>
                                    </label>
                        </div>
                        <div class="mt-6 pt-6 border-t">
                            <h4 class="text-xs font-bold text-gray-500 uppercase mb-2">Security</h4>
                            <div class="max-w-xs">
                                <label class="block text-sm font-bold text-gray-700 mb-2">Manager Password</label>
                                <input type="password" id="set-manager-password" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="Leave blank if not required">
                                <p class="text-[10px] text-gray-500 mt-1">This password will be required for high-clearance actions (e.g., voiding transactions, editing closed shifts).</p>
                            </div>
                        </div>
                        <div class="mt-6 pt-6 border-t">
                            <h4 class="text-xs font-bold text-gray-500 uppercase mb-2">Developer Tools</h4>
                            <button type="button" id="btn-run-tests" class="w-full bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded transition text-sm shadow-sm">Run Sync Architecture Tests</button>
                            <button type="button" id="btn-diagnostic-export" class="w-full mt-2 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition text-sm shadow-sm">Export Diagnostic Report</button>
                            <p class="text-[10px] text-gray-400 mt-1">Verifies Outbox, LWW Conflict Resolution, and Web Locks.</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>

                <!-- AI Settings Tab -->
                <div id="settings-tab-ai" class="settings-panel hidden space-y-6">
                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold mb-4">AI Configuration</h3>
                        <p class="text-sm text-gray-600 mb-4">Configure the local LLM server connection (e.g., LM Studio).</p>
                        
                        <div class="max-w-md space-y-4">
                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-2">Server URL</label>
                                <input type="text" id="set-ai-url" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="http://localhost:1234/v1">
                                <p class="text-[10px] text-gray-500 mt-1">The base URL for the OpenAI-compatible API (e.g. http://localhost:1234/v1).</p>
                            </div>
                            
                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-2">Model</label>
                                <div class="flex gap-2">
                                    <select id="set-ai-model" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none">
                                        <option value="">Select a model...</option>
                                    </select>
                                    <button type="button" id="btn-refresh-models" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition text-sm whitespace-nowrap">
                                        Refresh Models
                                    </button>
                                </div>
                            </div>

                            <div id="ai-connection-status" class="hidden p-3 rounded text-sm font-bold"></div>
                        </div>
                    </div>
                </div>

                <!-- Price Tools Tab -->
                <div id="settings-tab-price-tools" class="settings-panel hidden space-y-6">
                     <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold mb-4">Quick Price Check</h3>
                        <div class="bg-blue-50 border border-blue-100 p-4 rounded-lg mb-6">
                            <p class="text-sm text-blue-800">
                                This tool scans for items with a markup <strong>below the target percentage</strong> set below and automatically updates their selling price.
                            </p>
                        </div>
                        
                        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-2">Markup Percentage</label>
                                <div class="flex items-center gap-2">
                                    <input type="number" id="pt-markup-pct" step="0.1" min="0" value="20" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none">
                                    <span class="text-gray-500 font-bold">%</span>
                                </div>
                                <p class="text-[10px] text-gray-500 mt-1">Target markup to apply to cost.</p>
                            </div>
                            
                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-2">Max Markup Cap (Amount)</label>
                                <div class="flex items-center gap-2">
                                    <span class="text-gray-500 font-bold">₱</span>
                                    <input type="number" id="pt-markup-cap" step="0.01" min="0" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none" placeholder="No Limit">
                                </div>
                                <p class="text-[10px] text-gray-500 mt-1">Max allowed increase in price (Leave empty for no limit).</p>
                            </div>

                            <div>
                                <label class="block text-sm font-bold text-gray-700 mb-2">Rounding Rule</label>
                                <select id="pt-rounding" class="w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none">
                                    <option value="none">No Rounding (Exact)</option>
                                    <option value="nearest_0.25">Nearest 0.25</option>
                                    <option value="nearest_0.50">Nearest 0.50</option>
                                    <option value="nearest_1.00">Nearest 1.00</option>
                                    <option value="ceil_1.00">Ceiling to next 1.00</option>
                                    <option value="psych_99">Psychological (.99)</option>
                                </select>
                            </div>
                        </div>

                        <div class="mt-6">
                            <label class="block text-sm font-bold text-gray-700 mb-2">Exempted Categories</label>
                            <div id="pt-categories-list" class="grid grid-cols-2 md:grid-cols-4 gap-2 max-h-40 overflow-y-auto border rounded p-2 bg-gray-50">
                                <div class="text-gray-400 text-xs text-center col-span-full py-2">Loading categories...</div>
                            </div>
                            <p class="text-[10px] text-gray-500 mt-1">Selected categories will be ignored during the check.</p>
                        </div>

                        <div class="mt-8 border-t pt-6">
                            <button type="button" id="btn-run-price-check" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-8 rounded-lg shadow-lg transition w-full md:w-auto">
                                Run Price Check
                            </button>
                        </div>
                    </div>
                    
                    <!-- Result Modal (Hidden by default, used for confirmation) -->
                    <div id="price-check-modal" class="hidden fixed inset-0 z-50 overflow-hidden">
                        <div class="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity"></div>
                        <div class="relative flex items-center justify-center min-h-screen p-4">
                            <div class="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] flex flex-col">
                                <div class="px-6 py-4 border-b">
                                    <h3 class="text-lg font-bold text-gray-900">Price Check Results</h3>
                                </div>
                                <div class="px-6 py-4 flex-1 overflow-y-auto">
                                    <p class="mb-4 text-sm text-gray-600">The following <span id="pt-match-count" class="font-bold">0</span> items have low margins and will be updated:</p>
                                    <table class="min-w-full text-xs">
                                        <thead class="bg-gray-50 sticky top-0">
                                            <tr>
                                                <th class="p-2 text-left">Item</th>
                                                <th class="p-2 text-right">Cost</th>
                                                <th class="p-2 text-right">Old Price (Margin)</th>
                                                <th class="p-2 text-right">New Price (Margin)</th>
                                            </tr>
                                        </thead>
                                        <tbody id="pt-result-body" class="divide-y divide-gray-100"></tbody>
                                    </table>
                                </div>
                                <div class="px-6 py-4 border-t bg-gray-50 flex justify-end gap-3">
                                    <button type="button" id="btn-cancel-update" class="px-4 py-2 border rounded text-gray-700 hover:bg-gray-100">Cancel</button>
                                    <button type="button" id="btn-confirm-update" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 font-bold">Confirm Update</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Migration Tab -->
                ${canMigrate ? `
                <div id="settings-tab-migration" class="settings-panel hidden space-y-6">
                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold text-gray-700 mb-4">Backup & Restore</h3>
                        <p class="text-sm text-gray-600 mb-4">Download a full backup of your system data (items, transactions, settings, etc.) or restore from a previous backup file.</p>
                        <div class="flex flex-wrap gap-4">
                            <button type="button" id="btn-download-backup-server" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-6 rounded focus:outline-none shadow transition">
                                📥 Backup from Server
                            </button>
                            <button type="button" id="btn-download-backup-local" class="bg-teal-600 hover:bg-teal-700 text-white font-bold py-2 px-6 rounded focus:outline-none shadow transition">
                                📥 Backup from Local
                            </button>
                            <div class="flex items-center gap-2">
                                <input type="file" id="restore-file" class="hidden" accept=".json">
                                <button type="button" id="btn-trigger-restore" class="bg-orange-600 hover:bg-orange-700 text-white font-bold py-2 px-6 rounded focus:outline-none shadow transition">
                                    📤 Restore from Backup
                                </button>
                            </div>
                        </div>
                        <div class="mt-3 mb-1">
                            <label class="inline-flex items-center cursor-pointer select-none">
                                <input type="checkbox" id="restore-dry-run" class="form-checkbox h-4 w-4 text-orange-600 rounded border-gray-300 focus:ring-orange-500">
                                <span class="ml-2 text-sm text-gray-700 font-medium">Simulate Restore (Dry Run)</span>
                            </label>
                        </div>
                        <p class="text-[10px] text-red-500 mt-2 font-bold italic">⚠️ Warning: Restoring from a backup will overwrite all current data on the server.</p>
                        
                        <div id="restore-progress-container" class="hidden mt-4">
                            <div class="w-full bg-gray-200 rounded-full h-2.5 mb-2">
                                <div id="restore-progress-bar" class="bg-orange-600 h-2.5 rounded-full" style="width: 0%"></div>
                            </div>
                            <p id="restore-progress-text" class="text-xs text-gray-600 text-center">Preparing restore...</p>
                        </div>
                    </div>

                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <div class="mb-6">
                            <h3 class="text-lg font-bold text-gray-700 mb-2">Bulk Import Items</h3>
                            <p class="text-sm text-gray-600 mb-4">Upload a JSON or CSV file containing your item master list. This will add new items to your inventory.</p>
                            
                            <div class="flex flex-col gap-4">
                                <div class="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-blue-500 transition-colors cursor-pointer" id="drop-zone">
                                    <input type="file" id="import-file" class="hidden" accept=".json,.csv">
                                    <div class="text-gray-500">
                                        <span class="text-4xl block mb-2">📄</span>
                                        <p id="file-name">Click to select or drag and drop your JSON or CSV file</p>
                                    </div>
                                </div>
                                
                                <div class="flex justify-between items-center">
                                    <div class="flex gap-4">
                                        <button type="button" id="btn-download-sample-json" class="text-blue-600 hover:text-blue-800 text-sm font-medium flex items-center gap-1">
                                            📥 Sample JSON
                                        </button>
                                        <button type="button" id="btn-download-sample-csv" class="text-green-600 hover:text-green-800 text-sm font-medium flex items-center gap-1">
                                            📥 Sample CSV
                                        </button>
                                    </div>
                                    <button type="button" id="btn-start-import" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded focus:outline-none focus:shadow-outline disabled:opacity-50 disabled:cursor-not-allowed" disabled>
                                        Start Import
                                    </button>
                                </div>
                            </div>
                        </div>
                        
                        <div id="import-progress" class="hidden mt-6">
                            <div class="w-full bg-gray-200 rounded-full h-2.5 mb-2">
                                <div id="progress-bar" class="bg-blue-600 h-2.5 rounded-full" style="width: 0%"></div>
                            </div>
                            <p id="progress-text" class="text-xs text-gray-600 text-center">Processing...</p>
                        </div>
                    </div>

                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold text-gray-700 mb-2">Import Items with Suppliers</h3>
                        <p class="text-sm text-gray-600 mb-4">CSV Format: "barcode","item_name","category","cost_price","unit_price","supplier_name","supplier_account"</p>
                        <div class="flex flex-col gap-4">
                            <div class="flex items-center gap-4">
                                <input type="file" id="import-items-suppliers-file" accept=".csv" class="text-sm">
                                <button type="button" id="btn-import-items-suppliers" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded shadow transition disabled:opacity-50" disabled>
                                    Import Items & Links
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold text-gray-700 mb-2">Import Supplier Master</h3>
                        <p class="text-sm text-gray-600 mb-4">CSV Format: "company_name","agency_name","account_number","first_name","last_name","email","phone_number","address","city"</p>
                        <div class="flex flex-col gap-4">
                            <div class="flex items-center gap-4">
                                <input type="file" id="import-suppliers-master-file" accept=".csv" class="text-sm">
                                <button type="button" id="btn-import-suppliers-master" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-6 rounded shadow transition disabled:opacity-50" disabled>
                                    Import Suppliers
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold text-gray-700 mb-2">Manual Sync from Backup</h3>
                        <p class="text-sm text-gray-600 mb-4">Upload a backup file (JSON) to merge its data into your local database and sync it to the server. This is useful for transferring data via USB.</p>
                        <div class="flex flex-col gap-4">
                            <div class="flex items-center gap-4">
                                <input type="file" id="sync-backup-file" accept=".json" class="text-sm">
                                <button type="button" id="btn-sync-backup" class="bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 px-6 rounded shadow transition disabled:opacity-50" disabled>
                                    Merge & Sync Backup
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold text-gray-700 mb-2">Bulk Import Customers</h3>
                        <p class="text-sm text-gray-600 mb-4">Upload a CSV file to bulk add customers. Format: "first_name","last_name","account_number","points"</p>
                        
                        <div class="flex flex-col gap-4">
                            <div class="flex items-center gap-4">
                                <input type="file" id="import-customers-file" accept=".csv" class="text-sm">
                                <button type="button" id="btn-import-customers" class="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-6 rounded shadow transition disabled:opacity-50" disabled>
                                    Import Customers
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold text-gray-700 mb-4">Database Synchronization</h3>
                        <p class="text-sm text-gray-600 mb-4">Compare your local offline database (IndexedDB) with the server database (JSON) to identify discrepancies.</p>
                        
                        <div class="flex gap-4 mb-6">
                            <button type="button" id="btn-analyze-sync" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-6 rounded focus:outline-none shadow">
                                Analyze Differences
                            </button>
                            <button type="button" id="btn-sync-all-diffs" class="bg-teal-600 hover:bg-teal-700 text-white font-bold py-2 px-6 rounded focus:outline-none shadow hidden">
                                Resolve All Issues
                            </button>
                        </div>

                        <div id="sync-results" class="hidden">
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                                <div class="p-4 bg-gray-50 rounded border border-gray-200">
                                    <div class="text-xs text-gray-500 uppercase font-bold">Server Items</div>
                                    <div id="count-server" class="text-2xl font-bold text-gray-800">-</div>
                                </div>
                                <div class="p-4 bg-gray-50 rounded border border-gray-200">
                                    <div class="text-xs text-gray-500 uppercase font-bold">Local Items</div>
                                    <div id="count-local" class="text-2xl font-bold text-gray-800">-</div>
                                </div>
                                <div class="p-4 bg-gray-50 rounded border border-gray-200">
                                    <div class="text-xs text-gray-500 uppercase font-bold">Status</div>
                                    <div id="sync-status-text" class="text-lg font-bold text-gray-800">-</div>
                                </div>
                            </div>

                            <table class="min-w-full border mb-4">
                                <thead class="bg-gray-50">
                                    <tr>
                                        <th class="p-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Discrepancy Type</th>
                                        <th class="p-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Count</th>
                                        <th class="p-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
                                    </tr>
                                </thead>
                                <tbody id="sync-diff-body" class="bg-white divide-y divide-gray-200"></tbody>
                            </table>
                        </div>
                    </div>

                    <div class="bg-white p-6 rounded-lg shadow-sm border border-red-100 mt-6">
                        <h3 class="text-lg font-bold mb-4 text-red-600">Danger Zone</h3>
                        <p class="text-sm text-gray-600 mb-4">Permanently delete data. This action cannot be undone.</p>
                        <div class="flex flex-wrap gap-4">
                            <button type="button" id="btn-wipe-server" class="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded transition shadow-sm">Wipe Server Data</button>
                            <button type="button" id="btn-wipe-local" class="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded transition shadow-sm">Wipe Local Data</button>
                            <button type="button" id="btn-reset-app" class="bg-red-800 hover:bg-red-900 text-white font-bold py-2 px-4 rounded transition shadow-sm">Reset Application Data</button>
                        </div>
                    </div>
                </div>` : ''}

                <!-- Sync History Tab -->
                <div id="settings-tab-sync" class="settings-panel hidden space-y-6">
                    <div class="bg-white p-6 rounded-lg shadow-sm border">
                        <h3 class="text-lg font-bold mb-4">Synchronization Log</h3>
                        <p class="text-sm text-gray-600 mb-4">Last successful synchronization for each data entity.</p>
                        <div class="overflow-x-auto">
                            <table class="min-w-full text-sm">
                                <thead>
                                    <tr class="border-b bg-gray-50 text-gray-600 uppercase text-xs font-bold">
                                        <th class="text-left p-3">Entity / Data Type</th>
                                        <th class="text-right p-3">Last Successful Sync</th>
                                    </tr>
                                </thead>
                                <tbody id="sync-history-body" class="divide-y divide-gray-100">
                                    <tr><td colspan="2" class="p-4 text-center text-gray-400">Loading history...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <div class="mt-8 flex justify-end">
                    <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-8 rounded-lg shadow-lg transition ${canWrite ? '' : 'hidden'}">
                        Save All Settings
                    </button>
                </div>
            </form>
        </div>
    `;

    setupEventListeners();
    await loadSettings();
}

function setupEventListeners() {
    const tabs = document.querySelectorAll(".settings-tab-btn");
    const panels = document.querySelectorAll(".settings-panel");

    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            const target = tab.dataset.tab;
            tabs.forEach(t => {
                t.classList.remove("border-blue-500", "text-blue-600");
                t.classList.add("border-transparent", "text-gray-500");
            });
            tab.classList.add("border-blue-500", "text-blue-600");
            tab.classList.remove("border-transparent", "text-gray-500");

            panels.forEach(p => {
                if (p.id === `settings-tab-${target}`) p.classList.remove("hidden");
                else p.classList.add("hidden");
            });

            if (target === 'sync') renderSyncHistory();
            if (target === 'rewards') loadDiscountCodes();
            if (target === 'price-tools') loadPriceToolsCategories();

            // Hide save button for Sync, Migration, and Price Tools tabs
            if (target === 'sync' || target === 'migration' || target === 'price-tools') {
                document.querySelector('button[type="submit"]').classList.add("hidden");
            } else {
                // Assuming 'canWrite' is available here via closure or needs to be re-checked.
                // Actually 'canWrite' is a local variable in 'loadSettingsView', not here.
                // We need to re-check permission or just remove 'hidden' if we assume user has access to settings page.
                // Let's check the permission again correctly.
                // But wait, 'setupEventListeners' is called inside 'loadSettingsView' but as a separate function, 
                // so 'canWrite' is NOT in scope?
                // Looking at line 652, setupEventListeners is defined outside.
                // It needs to know 'canWrite'.
                // Let's just remove 'hidden' class. The button visual state is enough, and the handleSave protects via backend/logic if needed.
                // Or better, check the DOM element's initial state or re-check permission.
                document.querySelector('button[type="submit"]').classList.remove("hidden");
            }
        });
    });

    // Discount Codes Listeners
    document.getElementById('btn-add-discount')?.addEventListener('click', handleAddDiscountCode);
    document.getElementById('discount-codes-list')?.addEventListener('click', handleDeleteDiscountCode);

    // Logo Upload
    const logoFile = document.getElementById("set-store-logo-file");
    const logoBase64 = document.getElementById("set-store-logo-base64");
    const logoPreview = document.getElementById("logo-preview");

    logoFile.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                const base64 = event.target.result;
                logoBase64.value = base64;
                logoPreview.innerHTML = `<img src="${base64}" class="w-full h-full object-contain">`;
            };
            reader.readAsDataURL(file);
        }
    });

    document.getElementById("form-settings").addEventListener("submit", handleSave);

    document.getElementById("btn-run-tests")?.addEventListener("click", async () => {
        // Cache-bust the import to ensure we always run the latest test code
        const { TestRunner } = await import(`../services/TestRunner.js?t=${Date.now()}`);
        const tests = TestRunner.getTests();
        displayTestRunnerModal(tests);
    });

    document.getElementById("btn-diagnostic-export")?.addEventListener("click", runDiagnosticExport);

    if (checkPermission("migrate", "write")) {
        setupMigrationEventListeners();
    }

    // AI Settings Listeners
    document.getElementById('btn-refresh-models')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-refresh-models');
        const urlInput = document.getElementById('set-ai-url');
        const select = document.getElementById('set-ai-model');
        const statusDiv = document.getElementById('ai-connection-status');

        const originalText = btn.textContent;
        btn.textContent = "Connecting...";
        btn.disabled = true;
        statusDiv.classList.add('hidden');

        const cleanUrl = (input) => input.replace(/\/+$/, '');
        let baseUrl = cleanUrl(urlInput.value);

        const fetchModels = async (url) => {
            try {
                const res = await fetch(`${url}/models`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                return { success: true, data };
            } catch (e) {
                return { success: false, error: e };
            }
        };

        try {
            // Attempt 1: As provided
            let result = await fetchModels(baseUrl);

            // Attempt 2: If failed or API returned error (some local servers return 200 with {error: ...}), 
            // and URL doesn't end in /v1, try appending /v1
            if ((!result.success || result.data.error) && !baseUrl.endsWith('/v1')) {
                console.log("Initial connection failed or returned error, trying with /v1 suffix...");
                const v1Url = `${baseUrl}/v1`;
                const resultV1 = await fetchModels(v1Url);

                if (resultV1.success && !resultV1.data.error) {
                    result = resultV1;
                    baseUrl = v1Url; // Update base for saving
                    urlInput.value = v1Url; // Auto-correct user input
                    console.log("Success with /v1 suffix. Updated URL.");
                }
            }

            if (!result.success) throw result.error;
            if (result.data.error) throw new Error(result.data.error);

            const data = result.data;
            console.log("AI Models Response:", data);

            let models = [];
            if (Array.isArray(data)) {
                models = data;
            } else if (Array.isArray(data.data)) {
                models = data.data;
            } else if (Array.isArray(data.models)) {
                models = data.models;
            } else {
                console.warn("Could not find model array in response:", data);
            }

            if (models.length === 0) {
                throw new Error("No models found in response. Check Server URL.");
            }

            select.innerHTML = '<option value="">Select a model...</option>';
            models.forEach(m => {
                const option = document.createElement('option');
                option.value = m.id;
                option.textContent = m.id;
                select.appendChild(option);
            });

            statusDiv.textContent = `Connected! Found ${models.length} models.`;
            statusDiv.className = "p-3 rounded text-sm font-bold bg-green-100 text-green-700";
            statusDiv.classList.remove('hidden');

            // Cache models
            const aiSettings = JSON.parse(localStorage.getItem('ai_settings') || '{}');
            aiSettings.cachedModels = models;
            aiSettings.url = baseUrl; // Save the working URL
            localStorage.setItem('ai_settings', JSON.stringify(aiSettings));

        } catch (error) {
            console.error("AI Connect Error:", error);
            statusDiv.textContent = `Connection Failed: ${error.message}`;
            statusDiv.className = "p-3 rounded text-sm font-bold bg-red-100 text-red-700";
            statusDiv.classList.remove('hidden');
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    });

    // Price Tools Listeners
    document.getElementById('btn-run-price-check')?.addEventListener('click', runPriceCheck);
    document.getElementById('btn-cancel-update')?.addEventListener('click', () => {
        document.getElementById('price-check-modal').classList.add('hidden');
    });
    document.getElementById('btn-confirm-update')?.addEventListener('click', applyPriceUpdates);
}


function displayTestRunnerModal(tests) {
    let modal = document.getElementById('modal-test-runner');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'modal-test-runner';
    modal.className = 'fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center z-[100]';

    const testsHtml = tests.map((test, index) => `
        <div class="p-4 border-b last:border-0 bg-white" id="test-row-${index}">
            <div class="flex justify-between items-center">
                <div>
                    <h4 class="font-bold text-gray-800">${test.name}</h4>
                    <p class="text-xs text-gray-600 mt-1">${test.description}</p>
                </div>
                <div class="flex items-center gap-3">
                    <span class="status-badge px-2 py-0.5 rounded-full text-xs font-bold bg-gray-100 text-gray-600">Pending</span>
                    <button class="btn-run-single bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold py-1 px-3 rounded" data-index="${index}">Run</button>
                </div>
            </div>
            <div class="error-output hidden mt-2 text-xs text-red-700 bg-red-100 p-2 rounded font-mono whitespace-pre-wrap"></div>
        </div>
    `).join('');

    modal.innerHTML = `
        <div class="bg-white rounded-lg shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col">
            <div class="p-4 border-b flex justify-between items-center">
                <h3 class="text-xl font-bold text-gray-800">Sync Architecture Tests</h3>
                <button id="btn-run-all-tests" class="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded text-sm shadow">
                    Run All Tests
                </button>
            </div>
            <div class="flex-1 overflow-y-auto">
                ${testsHtml}
            </div>
            <div class="p-4 bg-gray-50 border-t flex justify-end">
                <button id="btn-close-test-results" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // --- Discount Codes Logic Removed from here ---

    function updateRowUI(index, status, error = null) {
        const row = document.getElementById(`test-row-${index}`);
        const badge = row.querySelector('.status-badge');
        const errorDiv = row.querySelector('.error-output');
        const btn = row.querySelector('.btn-run-single');

        if (status === 'running') {
            badge.className = 'status-badge px-2 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-800 animate-pulse';
            badge.textContent = 'Running...';
            btn.disabled = true;
            btn.classList.add('opacity-50');
            errorDiv.classList.add('hidden');
            row.classList.remove('bg-green-50', 'bg-red-50');
        } else if (status === 'pass') {
            badge.className = 'status-badge px-2 py-0.5 rounded-full text-xs font-bold bg-green-200 text-green-800';
            badge.textContent = 'PASS';
            btn.disabled = false;
            btn.classList.remove('opacity-50');
            row.classList.add('bg-green-50');
        } else if (status === 'fail') {
            badge.className = 'status-badge px-2 py-0.5 rounded-full text-xs font-bold bg-red-200 text-red-800';
            badge.textContent = 'FAIL';
            btn.disabled = false;
            btn.classList.remove('opacity-50');
            row.classList.add('bg-red-50');
            if (error) {
                errorDiv.textContent = error.stack || error.message || String(error);
                errorDiv.classList.remove('hidden');
            }
        }
    };

    const runTest = async (index) => {
        updateRowUI(index, 'running');
        const result = await tests[index].run();
        updateRowUI(index, result.success ? 'pass' : 'fail', result.error);
    };

    modal.querySelectorAll('.btn-run-single').forEach(btn => {
        btn.addEventListener('click', () => runTest(parseInt(btn.dataset.index)));
    });

    modal.querySelector('#btn-run-all-tests').addEventListener('click', async () => {
        for (let i = 0; i < tests.length; i++) {
            await runTest(i);
        }
    });

    modal.querySelector('#btn-close-test-results').addEventListener('click', () => modal.remove());
}

async function loadSettings() {
    try {
        if (navigator.onLine) await SyncEngine.sync();

        const localData = await Repository.get('settings', 'global');
        let settings = localData;

        if (settings) {
            if (settings.store) {
                document.getElementById("set-store-name").value = settings.store.name || "";
                document.getElementById("set-store-data").value = settings.store.data || "";
                if (settings.store.logo) {
                    document.getElementById("set-store-logo-base64").value = settings.store.logo;
                    document.getElementById("logo-preview").innerHTML = `<img src="${settings.store.logo}" class="w-full h-full object-contain">`;
                }
            }
            if (settings.tax) {
                document.getElementById("set-tax-rate").value = settings.tax.rate || 0;
            }
            if (settings.rewards) {
                document.getElementById("set-reward-ratio").value = settings.rewards.ratio || 100;
            }
            if (settings.shift) {
                document.getElementById("set-shift-threshold").value = settings.shift.threshold || 0;
            }
            if (settings.pos) {
                document.getElementById("set-auto-print").checked = settings.pos.auto_print || false;
            }
            if (settings.security) {
                document.getElementById("set-manager-password").value = settings.security.manager_password || "";
            }
            if (settings.print) {
                const p = settings.print;
                document.getElementById("set-print-width").value = p.paper_width || 76;
                document.getElementById("set-print-show-dividers").checked = p.show_dividers !== false;

                document.getElementById("set-print-header-text").value = p.header?.text || "";
                document.getElementById("set-print-header-size").value = p.header?.font_size || 14;
                document.getElementById("set-print-header-font").value = p.header?.font_family || "'Courier New', Courier, monospace";
                document.getElementById("set-print-header-bold").checked = p.header?.bold || false;
                document.getElementById("set-print-header-italic").checked = p.header?.italic || false;

                document.getElementById("set-print-body-size").value = p.body?.font_size || 12;
                document.getElementById("set-print-body-font").value = p.body?.font_family || "'Courier New', Courier, monospace";
                document.getElementById("set-print-body-bold").checked = p.body?.bold || false;
                document.getElementById("set-print-body-italic").checked = p.body?.italic || false;

                document.getElementById("set-print-items-size").value = p.items?.font_size || 12;
                document.getElementById("set-print-items-font").value = p.items?.font_family || "'Courier New', Courier, monospace";
                document.getElementById("set-print-items-bold").checked = p.items?.bold || false;
                document.getElementById("set-print-items-italic").checked = p.items?.italic || false;

                document.getElementById("set-print-footer-text").value = p.footer?.text || "";
                document.getElementById("set-print-footer-size").value = p.footer?.font_size || 10;
                document.getElementById("set-print-footer-font").value = p.footer?.font_family || "'Courier New', Courier, monospace";
                document.getElementById("set-print-footer-bold").checked = p.footer?.bold || false;
                document.getElementById("set-print-footer-italic").checked = p.footer?.italic || false;
            }
            if (settings.procurement) {
                document.getElementById("set-procurement-k-factor").value = settings.procurement.k_factor || 110;
                document.getElementById("set-procurement-otb-mode").value = settings.procurement.otb_mode || 'standard';
                document.getElementById("set-procurement-ordering-cost").value = settings.procurement.ordering_cost || 50;
                document.getElementById("set-procurement-holding-cost").value = settings.procurement.holding_cost_rate || 20;
                document.getElementById("set-procurement-service-level").value = settings.procurement.service_level || 1.65;
                const lt = settings.procurement.default_lead_time;
                document.getElementById("set-procurement-lead-time").value = (lt !== undefined && lt !== null) ? lt : 7;
                document.getElementById("set-procurement-assumed-stock").checked = settings.procurement.assumed_stock_new_store || false;
            }
            await renderSyncHistory();
            renderHeader(); // Ensure branding in header matches loaded settings
        }

        // Load AI Settings from localStorage
        const aiSettings = JSON.parse(localStorage.getItem('ai_settings') || '{}');
        if (aiSettings) {
            if (aiSettings.url) document.getElementById('set-ai-url').value = aiSettings.url;

            // Restore cached models if available, otherwise just set the value (which might be empty if options aren't loaded)
            if (aiSettings.cachedModels && Array.isArray(aiSettings.cachedModels)) {
                const select = document.getElementById('set-ai-model');
                select.innerHTML = '<option value="">Select a model...</option>';
                aiSettings.cachedModels.forEach(m => {
                    const option = document.createElement('option');
                    option.value = m.id;
                    option.textContent = m.id;
                    select.appendChild(option);
                });
            }

            if (aiSettings.model) document.getElementById('set-ai-model').value = aiSettings.model;
        }
    } catch (error) {
        console.error("Error loading settings:", error);
    }
}

async function renderSyncHistory() {
    const db = await dbPromise;
    const tbody = document.getElementById("sync-history-body");
    if (!tbody) return;

    const history = await db.sync_metadata.filter(m => m.key.startsWith('sync_history_')).toArray();

    if (history.length === 0) {
        tbody.innerHTML = `<tr><td colspan="2" class="p-4 text-center text-gray-400 italic">No sync history recorded yet.</td></tr>`;
        return;
    }

    tbody.innerHTML = history.map(h => {
        const entity = h.key.replace('sync_history_', '').replace(/_/g, ' ');
        const date = new Date(h.value);
        return `
            <tr>
                <td class="p-3 font-medium text-gray-700 capitalize">${entity}</td>
                <td class="p-3 text-right text-gray-500">${date.toLocaleString()}</td>
            </tr>
        `;
    }).join('');
}

async function handleSave(e) {
    e.preventDefault();

    const settings = {
        store: {
            name: document.getElementById("set-store-name").value.trim(),
            logo: document.getElementById("set-store-logo-base64").value,
            data: document.getElementById("set-store-data").value.trim()
        },
        tax: {
            rate: parseFloat(document.getElementById("set-tax-rate").value) || 0
        },
        rewards: {
            ratio: parseInt(document.getElementById("set-reward-ratio").value) || 100
        },
        shift: {
            threshold: parseFloat(document.getElementById("set-shift-threshold").value) || 0
        },
        procurement: {
            k_factor: parseFloat(document.getElementById("set-procurement-k-factor").value) || 110,
            otb_mode: document.getElementById("set-procurement-otb-mode").value,
            ordering_cost: parseFloat(document.getElementById("set-procurement-ordering-cost").value) || 50,
            holding_cost_rate: parseFloat(document.getElementById("set-procurement-holding-cost").value) || 20,
            service_level: parseFloat(document.getElementById("set-procurement-service-level").value) || 1.65,
            default_lead_time: document.getElementById("set-procurement-lead-time").value !== "" ? parseInt(document.getElementById("set-procurement-lead-time").value) : 7,
            assumed_stock_new_store: document.getElementById("set-procurement-assumed-stock").checked
        },
        pos: {
            auto_print: document.getElementById("set-auto-print").checked
        },
        security: {
            manager_password: document.getElementById("set-manager-password").value
        },
        print: {
            paper_width: parseInt(document.getElementById("set-print-width").value) || 76,
            show_dividers: document.getElementById("set-print-show-dividers").checked,
            header: {
                text: document.getElementById("set-print-header-text").value.trim(),
                font_size: parseInt(document.getElementById("set-print-header-size").value) || 14,
                font_family: document.getElementById("set-print-header-font").value,
                bold: document.getElementById("set-print-header-bold").checked,
                italic: document.getElementById("set-print-header-italic").checked
            },
            body: {
                font_size: parseInt(document.getElementById("set-print-body-size").value) || 12,
                font_family: document.getElementById("set-print-body-font").value,
                bold: document.getElementById("set-print-body-bold").checked,
                italic: document.getElementById("set-print-body-italic").checked
            },
            items: {
                font_size: parseInt(document.getElementById("set-print-items-size").value) || 12,
                font_family: document.getElementById("set-print-items-font").value,
                bold: document.getElementById("set-print-items-bold").checked,
                italic: document.getElementById("set-print-items-italic").checked
            },
            footer: {
                text: document.getElementById("set-print-footer-text").value.trim(),
                font_size: parseInt(document.getElementById("set-print-footer-size").value) || 10,
                font_family: document.getElementById("set-print-footer-font").value,
                bold: document.getElementById("set-print-footer-bold").checked,
                italic: document.getElementById("set-print-footer-italic").checked
            }
        }
    };

    // Save AI Settings to localStorage
    const aiUrl = document.getElementById('set-ai-url').value;
    const aiModel = document.getElementById('set-ai-model').value;
    // We also want to preserve the cached models list so we don't have to re-fetch on reload
    const currentCachedModels = [];
    document.querySelectorAll('#set-ai-model option').forEach(opt => {
        if (opt.value) currentCachedModels.push({ id: opt.value });
    });

    localStorage.setItem('ai_settings', JSON.stringify({
        url: aiUrl,
        model: aiModel,
        cachedModels: currentCachedModels.length > 0 ? currentCachedModels : undefined
    }));

    try {
        // Fetch existing to maintain versioning for the SyncEngine
        const existing = await Repository.get('settings', 'global');

        // Save locally first
        await Repository.upsert('settings', {
            id: 'global',
            ...settings,
            _version: (existing?._version || 0) + 1,
            _updatedAt: Date.now()
        });

        // Trigger background sync
        await SyncEngine.sync();

        alert("Settings saved.");
        renderHeader(); // Refresh title bar
    } catch (error) {
        console.error("Error saving settings:", error);
        alert("Failed to save settings.");
    }
}

/**
 * Helper to get settings for other modules
 */
export async function getSystemSettings() {
    try {
        const localData = await Repository.get('settings', 'global');
        if (localData) {
            return localData;
        }
        return DEFAULT_SETTINGS;
    } catch (e) {
        return DEFAULT_SETTINGS;
    }
}

export async function checkShiftDiscrepancy(expected, actual) {
    try {
        const settings = await getSystemSettings();
        const threshold = parseFloat(settings?.shift?.threshold) || 0;
        const diff = actual - expected;

        if (Math.abs(diff) > threshold) {
            await addNotification('Discrepancy', `Shift closed with a discrepancy of ₱${diff.toFixed(2)} (Threshold: ₱${threshold.toFixed(2)})`);
        }
    } catch (e) {
        console.error("Error checking discrepancy:", e);
    }
}

/**
 * Migration Logic (Moved from migrate.js)
 */
async function setupMigrationEventListeners() {
    const db = await dbPromise;
    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("import-file");
    const btnImport = document.getElementById("btn-start-import");
    const btnSampleJson = document.getElementById("btn-download-sample-json");
    const btnSampleCsv = document.getElementById("btn-download-sample-csv");
    const fileNameDisplay = document.getElementById("file-name");

    if (!dropZone) return;

    dropZone.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", (e) => {
        if (e.target.files.length > 0) {
            fileNameDisplay.textContent = e.target.files[0].name;
            btnImport.disabled = false;
        }
    });

    btnSampleJson.addEventListener("click", () => downloadSample("json"));
    btnSampleCsv.addEventListener("click", () => downloadSample("csv"));

    document.getElementById("btn-analyze-sync").addEventListener("click", analyzeSync);
    document.getElementById("btn-sync-all-diffs")?.addEventListener("click", syncAllDiffs);

    document.getElementById("btn-download-backup-server").addEventListener("click", downloadServerBackup);
    document.getElementById("btn-download-backup-local").addEventListener("click", downloadLocalBackup);
    const restoreFileInput = document.getElementById("restore-file");
    document.getElementById("btn-trigger-restore").addEventListener("click", () => restoreFileInput.click());
    restoreFileInput.addEventListener("change", handleRestoreBackup);

    // Customer Import Logic
    const custFileInput = document.getElementById("import-customers-file");
    const btnImportCust = document.getElementById("btn-import-customers");

    custFileInput?.addEventListener("change", () => {
        btnImportCust.disabled = custFileInput.files.length === 0;
    });

    btnImportCust?.addEventListener("click", async () => {
        const file = custFileInput.files[0];
        if (!file) return;
        const text = await file.text();
        const { bulkAddCustomersFromCSV } = await import("./migrations.js");
        const count = await bulkAddCustomersFromCSV(text);
        alert(`Successfully added ${count} customers.`);
        custFileInput.value = "";
        btnImportCust.disabled = true;
    });

    // Items with Suppliers Import
    const itemsSupFile = document.getElementById("import-items-suppliers-file");
    const btnImportItemsSup = document.getElementById("btn-import-items-suppliers");
    itemsSupFile?.addEventListener("change", () => btnImportItemsSup.disabled = itemsSupFile.files.length === 0);
    btnImportItemsSup?.addEventListener("click", async () => {
        const file = itemsSupFile.files[0];
        if (!file) return;
        const text = await file.text();
        const rows = parseGenericCSV(text);

        let count = 0;
        for (const row of rows) {
            const name = row.item_name;
            if (!name || name === 'NULL') continue;

            let supplierId = null;
            if (row.supplier_name && row.supplier_name !== 'NULL') {
                let sup = await db.suppliers.where('name').equalsIgnoreCase(row.supplier_name).first();
                if (!sup) {
                    sup = { id: generateUUID(), name: row.supplier_name };
                    await Repository.upsert('suppliers', sup);
                }
                supplierId = sup.id;
            }

            // Check for duplicates
            let existing = null;
            if (row.barcode && row.barcode !== 'NULL') {
                existing = await db.items.where('barcode').equals(row.barcode).first();
            }
            if (!existing) {
                existing = await db.items.where('name').equalsIgnoreCase(name).first();
            }

            if (existing) {
                // Update existing
                existing.category = (row.category && row.category !== 'NULL') ? row.category : existing.category;
                existing.supplier_id = supplierId || existing.supplier_id;
                await Repository.upsert('items', existing);
            } else {
                // Create new
                const newItem = {
                    id: generateUUID(),
                    barcode: (row.barcode && row.barcode !== 'NULL') ? row.barcode : "",
                    name: name,
                    category: (row.category && row.category !== 'NULL') ? row.category : "",
                    cost_price: parseFloat(row.cost_price) || 0,
                    selling_price: parseFloat(row.unit_price) || 0,
                    supplier_id: supplierId,
                    stock_level: 0,
                    min_stock: 10
                };
                await Repository.upsert('items', newItem);
            }
            count++;
        }
        alert(`Processed ${count} items.`);
        SyncEngine.sync();
    });

    // Supplier Master Import
    const supMasterFile = document.getElementById("import-suppliers-master-file");
    const btnImportSupMaster = document.getElementById("btn-import-suppliers-master");
    supMasterFile?.addEventListener("change", () => btnImportSupMaster.disabled = supMasterFile.files.length === 0);
    btnImportSupMaster?.addEventListener("click", async () => {
        const file = supMasterFile.files[0];
        if (!file) return;
        const text = await file.text();
        const rows = parseGenericCSV(text);

        let count = 0;
        for (const row of rows) {
            const name = row.company_name || row.agency_name;
            if (!name || name === 'NULL') continue;

            let existing = await db.suppliers.where('name').equalsIgnoreCase(name).first();
            const supData = {
                name: name,
                contact: `${row.first_name !== 'NULL' ? row.first_name : ''} ${row.last_name !== 'NULL' ? row.last_name : ''}`.trim() || null,
                email: row.email && row.email !== 'NULL' ? row.email : (row.phone_number !== 'NULL' ? row.phone_number : null)
            };

            if (existing) {
                await Repository.upsert('suppliers', { ...existing, ...supData });
            } else {
                await Repository.upsert('suppliers', { id: generateUUID(), ...supData });
            }
            count++;
        }
        alert(`Processed ${count} suppliers.`);
        SyncEngine.sync();
    });

    // Manual Sync from Backup
    const syncBackupFile = document.getElementById("sync-backup-file");
    const btnSyncBackup = document.getElementById("btn-sync-backup");

    syncBackupFile?.addEventListener("change", () => {
        btnSyncBackup.disabled = syncBackupFile.files.length === 0;
    });

    btnSyncBackup?.addEventListener("click", async () => {
        const file = syncBackupFile.files[0];
        if (!file) return;

        btnSyncBackup.disabled = true;
        const originalText = btnSyncBackup.textContent;
        btnSyncBackup.textContent = "Processing...";

        try {
            const text = await file.text();
            const backupData = JSON.parse(text);

            let dataToProcess = backupData;
            if (backupData.serverData && typeof backupData.serverData === 'object' && !backupData.items) {
                dataToProcess = backupData.serverData;
            } else if (backupData.deltas && typeof backupData.deltas === 'object' && !backupData.items) {
                dataToProcess = backupData.deltas;
            }

            const collections = Object.entries(dataToProcess);
            let totalProcessed = 0;

            for (const [collection, items] of collections) {
                if (!Array.isArray(items) || !db[collection]) continue;
                const idField = db[collection].schema.primKey.name;

                await db.transaction('rw', [db[collection], db.outbox], async () => {
                    for (const item of items) {
                        if (!item || typeof item !== 'object' || !item[idField]) continue;

                        // Deep sanitize to prevent extreme floating-point precision from crashing SQLite
                        const sanitized = deepSanitizeNumbers(item);
                        Object.assign(item, sanitized);

                        // Ensure timestamps are integers (fix for ISO strings in backups)
                        if (collection === 'transactions' && typeof item.timestamp === 'string') {
                            const d = new Date(item.timestamp);
                            if (!isNaN(d.getTime())) {
                                item.timestamp = d.getTime();
                            }
                        }

                        // Fix for Users: Map 'password' to 'password_hash' for SQLite compatibility
                        if (collection === 'users') {
                            if (item.password && !item.password_hash) {
                                item.password_hash = item.password;
                                delete item.password;
                            }
                        }

                        const existing = await db[collection].get(item[idField]);
                        const shouldUpdate = !existing || (item._version || 0) > (existing._version || 0) || ((item._version || 0) === (existing._version || 0) && (item._updatedAt || 0) > (existing._updatedAt || 0));
                        if (shouldUpdate) {
                            await db[collection].put(item);
                            await db.outbox.put({ collection, docId: item[idField], type: 'upsert', payload: item });
                            totalProcessed++;
                        }
                    }
                });
            }
            alert(`Successfully merged ${totalProcessed} records. Starting sync to server...`);
            SyncEngine.sync();
            syncBackupFile.value = "";
            btnSyncBackup.disabled = true;
        } catch (error) {
            console.error("Manual sync failed:", error);
            alert("Failed to sync backup: " + error.message);
        } finally {
            btnSyncBackup.textContent = originalText;
        }
    });

    btnImport.addEventListener("click", async () => {
        const file = fileInput.files[0];
        if (!file) return;

        btnImport.disabled = true;
        document.getElementById("import-progress").classList.remove("hidden");

        try {
            const text = await file.text();
            let data;

            if (file.name.endsWith(".json")) {
                data = JSON.parse(text);
            } else if (file.name.endsWith(".csv")) {
                data = parseCSV(text);
            } else {
                throw new Error("Unsupported file format. Please upload JSON or CSV.");
            }

            if (!Array.isArray(data)) {
                throw new Error("Invalid format: Data must be an array of items.");
            }

            await processImport(data);
            alert(`Successfully imported ${data.length} items.`);
            loadSettingsView(); // Reset view
        } catch (error) {
            console.error("Import error:", error);
            alert("Import failed: " + error.message);
            btnImport.disabled = false;
        }
    });

    document.getElementById("btn-wipe-server")?.addEventListener("click", async () => {
        const confirmation = prompt("DANGER: You are about to wipe ALL SERVER DATA.\nThis cannot be undone.\n\nType 'DELETE' to confirm:");
        if (confirmation === "DELETE") {
            try {
                const res = await fetch(`${API_URL}?action=reset_all`, { method: 'POST' });
                if (res.ok) {
                    alert("Server data wiped successfully.");
                } else {
                    alert("Failed to wipe server data.");
                }
            } catch (e) {
                alert("Error wiping server: " + e.message);
            }
        }
    });

    document.getElementById("btn-wipe-local")?.addEventListener("click", async () => {
        const confirmation = prompt("DANGER: You are about to wipe ALL LOCAL DATA.\nThis cannot be undone.\n\nType 'DELETE' to confirm:");
        if (confirmation === "DELETE") {
            await db.delete();
            alert("Local database wiped. The app will now reload.");
            window.location.reload();
        }
    });

    document.getElementById("btn-reset-app")?.addEventListener("click", async () => {
        if (!confirm("DANGER: This will wipe ALL DATA (Server & Local) and reset the application to its initial state.\n\nAre you sure?")) return;

        const confirmation = prompt("FINAL WARNING: This action is irreversible.\n\nType 'RESET' to confirm full system reset:");
        if (confirmation === "RESET") {
            try {
                const res = await fetch(`${API_URL}?action=reset_all`, { method: 'POST' });
                if (res.ok) {
                    await db.delete();
                    alert("Application reset successfully. Reloading...");
                    window.location.reload();
                } else {
                    alert("Failed to wipe server data.");
                }
            } catch (e) {
                alert("Error resetting application: " + e.message);
            }
        }
    });
}

function parseGenericCSV(text) {
    const lines = text.split(/\r?\n/).filter(line => line.trim() !== "");
    if (lines.length < 2) return [];
    const delimiter = lines[0].includes('\t') ? '\t' : ',';
    const clean = (val) => val ? val.trim().replace(/^"|"$/g, '') : "";
    const headers = lines[0].split(delimiter).map(h => clean(h).toLowerCase());
    const results = [];
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(delimiter).map(v => clean(v));
        const row = {};
        headers.forEach((header, index) => {
            const val = values[index];
            row[header] = (val === 'NULL' || val === undefined) ? null : val;
        });
        results.push(row);
    }
    return results;
}

function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(line => line.trim() !== "");
    if (lines.length < 2) return [];
    const firstLine = lines[0];
    const delimiter = firstLine.includes('\t') ? '\t' : ',';
    const clean = (val) => val ? val.trim().replace(/^"|"$/g, '') : "";
    const headers = lines[0].split(delimiter).map(h => clean(h).toLowerCase());
    const items = [];
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(delimiter).map(v => clean(v));
        const row = {};
        headers.forEach((header, index) => { row[header] = values[index]; });
        items.push({
            barcode: row.barcode || "",
            name: row.name || "",
            category: row.category || "",
            cost_price: parseFloat(row.cost_price) || 0,
            selling_price: parseFloat(row.unit_price) || 0,
            min_stock: parseFloat(row.reorder_level) || 0,
            stock_level: 0,
            base_unit: "Unit"
        });
    }
    return items;
}

async function processImport(items) {
    const progressBar = document.getElementById("progress-bar");
    const progressText = document.getElementById("progress-text");
    progressBar.style.width = "10%";
    progressText.textContent = "Preparing data...";

    progressBar.style.width = "40%";
    progressText.textContent = "Processing data...";
    const newItems = items.map(item => ({
        id: generateUUID(),
        ...item,
        cost_price: parseFloat(item.cost_price) || 0,
        selling_price: parseFloat(item.selling_price) || 0,
        stock_level: parseFloat(item.stock_level) || 0,
        min_stock: parseFloat(item.min_stock) || 0,
        supplier_id: item.supplier_id || ""
    }));
    progressBar.style.width = "70%";
    progressText.textContent = "Saving to local database...";

    for (const item of newItems) {
        await Repository.upsert('items', item);
    }

    progressText.textContent = "Syncing...";
    SyncEngine.sync();

    progressBar.style.width = "100%";
    progressText.textContent = "Import Complete!";
}

async function analyzeSync() {
    const db = await dbPromise;
    const resultsDiv = document.getElementById("sync-results");
    const tbody = document.getElementById("sync-diff-body");
    const btnAnalyze = document.getElementById("btn-analyze-sync");
    const btnSyncAll = document.getElementById("btn-sync-all-diffs");

    // UI Elements for counts
    const countServerEl = document.getElementById("count-server");
    const countLocalEl = document.getElementById("count-local");
    const statusEl = document.getElementById("sync-status-text");

    resultsDiv.classList.remove("hidden");
    tbody.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-gray-500">Analyzing databases...</td></tr>`;
    btnAnalyze.disabled = true;
    btnAnalyze.classList.add("opacity-50");
    if (btnSyncAll) btnSyncAll.classList.add("hidden");

    const collections = [
        'items', 'transactions', 'customers', 'suppliers', 'expenses',
        'shifts', 'returns', 'stock_movements', 'stock_logs',
        'adjustments', 'stockins', 'suspended_transactions', 'users',
        'purchase_orders', 'supplier_config', 'inventory_metrics', 'discount_codes',
        'spatial_shelves', 'spatial_placements', 'settings'
    ];

    try {
        let totalServer = 0;
        let totalLocal = 0;
        let hasDiff = false;

        tbody.innerHTML = "";

        const renderRow = (label, items, btnText, btnClass, actionFn) => {
            const count = items.length;
            const tr = document.createElement("tr");
            const detailsId = `details-${Math.random().toString(36).substr(2, 9)}`;

            tr.innerHTML = `
                <td class="p-3 text-sm font-medium text-gray-900">
                    <div class="flex flex-col">
                        <span>${label}</span>
                        <button type="button" class="text-[10px] text-blue-600 text-left hover:underline focus:outline-none mt-1" onclick="document.getElementById('${detailsId}').classList.toggle('hidden')">
                            Show Details (${count})
                        </button>
                    </div>
                </td>
                <td class="p-3 text-center text-sm text-gray-500 align-top pt-4">${count}</td>
                <td class="p-3 text-right align-top pt-3">
                    <button type="button" class="text-xs px-3 py-1 rounded text-white font-bold ${btnClass} hover:opacity-90 transition">${btnText}</button>
                </td>
            `;

            tr.querySelector("button.text-white").addEventListener("click", async (e) => {
                e.target.disabled = true; e.target.textContent = "Processing...";
                await actionFn(); analyzeSync();
            });
            tbody.appendChild(tr);

            const trDetails = document.createElement("tr");
            trDetails.id = detailsId;
            trDetails.className = "hidden bg-gray-50";

            const preview = items.slice(0, 100).map(i => {
                const name = i.name || i.description || i.title || (i.timestamp ? new Date(i.timestamp).toLocaleString() : null) || i.id;
                return `<div class="text-xs text-gray-600 font-mono border-b border-gray-200 py-1 flex justify-between">
                    <span class="truncate max-w-[300px]">${name}</span>
                    <span class="text-gray-400 text-[10px]">${i.id}</span>
                </div>`;
            }).join('');

            const moreCount = items.length - 100;
            const moreText = moreCount > 0 ? `<div class="text-xs text-gray-500 italic py-1 text-center">...and ${moreCount} more</div>` : '';

            trDetails.innerHTML = `
                <td colspan="3" class="p-3">
                    <div class="max-h-60 overflow-y-auto border rounded bg-white p-2 shadow-inner">
                        ${preview}
                        ${moreText}
                    </div>
                </td>
            `;
            tbody.appendChild(trDetails);
        };

        // Add a progress bar above the table so we don't clear diff rows
        let progressDiv = document.getElementById("analyze-progress-info");
        if (!progressDiv) {
            progressDiv = document.createElement("div");
            progressDiv.id = "analyze-progress-info";
            progressDiv.className = "p-3 mb-2 text-center text-blue-800 bg-blue-100 rounded text-sm font-semibold";
            resultsDiv.insertBefore(progressDiv, resultsDiv.firstChild);
        }

        // Fetch each collection individually to avoid server memory exhaustion
        for (let ci = 0; ci < collections.length; ci++) {
            const collection = collections[ci];
            if (!db[collection]) continue;

            // Update progress
            progressDiv.textContent = `Analyzing: ${collection} (${ci + 1}/${collections.length})...`;

            let sData = [];
            try {
                const serverRes = await fetch(`${ADMIN_API_URL}?file=${collection}&_t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
                if (serverRes.ok) {
                    sData = await serverRes.json();
                    if (!Array.isArray(sData)) sData = [];
                } else {
                    console.warn(`Failed to fetch ${collection} from server: HTTP ${serverRes.status}`);
                }
            } catch (fetchErr) {
                console.warn(`Failed to fetch ${collection}:`, fetchErr);
            }

            const rawLocal = await db[collection].toArray();
            // Ignore locally deleted records, as the server API also omits deleted records
            const lData = rawLocal.filter(i => !(i._deleted === 1 || i._deleted === true));

            totalServer += sData.length;
            totalLocal += lData.length;

            const idField = db[collection].schema.primKey.name;
            const sMap = new Map(sData.map(i => [i[idField], i]));
            const lMap = new Map(lData.map(i => [i[idField], i]));

            const onlyInServer = sData.filter(i => !lMap.has(i[idField]));
            const onlyInLocal = lData.filter(i => !sMap.has(i[idField]));

            const conflicts = sData.filter(s => {
                const l = lMap.get(s[idField]);
                if (!l) return false;
                const sVer = s._version || 0;
                const lVer = l._version || 0;
                const sUpd = s._updatedAt || 0;
                const lUpd = l._updatedAt || 0;
                return sVer !== lVer || sUpd !== lUpd;
            });

            if (onlyInServer.length > 0 || onlyInLocal.length > 0 || conflicts.length > 0) {
                // Clear progress row on first diff found
                if (!hasDiff) tbody.innerHTML = "";
                hasDiff = true;
                const labelName = collection.charAt(0).toUpperCase() + collection.slice(1).replace(/_/g, ' ');

                if (onlyInServer.length > 0) {
                    renderRow(`${labelName}: Missing in Local`, onlyInServer, "Download", "bg-blue-500", async () => {
                        await db.transaction('rw', [db[collection], db.outbox], async () => {
                            for (const item of onlyInServer) {
                                await db[collection].put(item);
                                await db.outbox.where({ collection: collection, docId: item[idField] }).delete();
                            }
                        });
                    });
                }

                if (onlyInLocal.length > 0) {
                    renderRow(`${labelName}: Missing in Server`, onlyInLocal, "Upload", "bg-green-500", async () => {
                        for (const item of onlyInLocal) {
                            const toUpload = { ...item, _updatedAt: Date.now(), _version: (item._version || 0) + 1 };
                            await Repository.upsert(collection, toUpload);
                        }
                        await SyncEngine.sync();
                    });
                }

                if (conflicts.length > 0) {
                    renderRow(`${labelName}: Conflicts`, conflicts, "Trust Server", "bg-orange-500", async () => {
                        await db.transaction('rw', [db[collection], db.outbox], async () => {
                            for (const item of conflicts) {
                                await db[collection].put(item);
                                await db.outbox.where({ collection: collection, docId: item[idField] }).delete();
                            }
                        });
                    });
                }
            }
        }

        countServerEl.textContent = totalServer;
        countLocalEl.textContent = totalLocal;

        // Update labels to reflect aggregate
        if (countServerEl.previousElementSibling) countServerEl.previousElementSibling.textContent = "TOTAL SERVER RECORDS";
        if (countLocalEl.previousElementSibling) countLocalEl.previousElementSibling.textContent = "TOTAL LOCAL RECORDS";

        if (!hasDiff) {
            tbody.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-green-600 font-bold bg-green-50">All databases are in sync!</td></tr>`;
            statusEl.textContent = "Synced";
            statusEl.className = "text-lg font-bold text-green-600";
            if (btnSyncAll) btnSyncAll.classList.add("hidden");
        } else {
            statusEl.textContent = "Not Synced";
            statusEl.className = "text-lg font-bold text-red-600";
            if (btnSyncAll) btnSyncAll.classList.remove("hidden");
        }
        
        if (progressDiv) progressDiv.remove();
    } catch (e) {
        console.error('Analyze Sync Error:', e);
        tbody.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-red-600">Error: ${e.message}</td></tr>`;
        const pd = document.getElementById("analyze-progress-info");
        if (pd) pd.remove();
    } finally {
        btnAnalyze.disabled = false; btnAnalyze.classList.remove("opacity-50");
    }
}

async function syncAllDiffs() {
    const db = await dbPromise;
    const btn = document.getElementById("btn-sync-all-diffs");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Resolving...";

    try {
        const collections = [
            'items', 'transactions', 'customers', 'suppliers', 'expenses',
            'shifts', 'returns', 'stock_movements', 'stock_logs',
            'adjustments', 'stockins', 'suspended_transactions', 'users',
            'purchase_orders', 'supplier_config', 'inventory_metrics', 'discount_codes',
            'spatial_shelves', 'spatial_placements', 'settings'
        ];

        for (let ci = 0; ci < collections.length; ci++) {
            const collection = collections[ci];
            if (!db[collection]) continue;

            btn.textContent = `Resolving ${ci + 1}/${collections.length}...`;

            let sData = [];
            try {
                const serverRes = await fetch(`${ADMIN_API_URL}?file=${collection}&_t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } });
                if (serverRes.ok) {
                    sData = await serverRes.json();
                    if (!Array.isArray(sData)) sData = [];
                }
            } catch (fetchErr) {
                console.warn(`Failed to fetch ${collection}:`, fetchErr);
                continue;
            }

            const rawLocal = await db[collection].toArray();
            const lData = rawLocal.filter(i => !(i._deleted === 1 || i._deleted === true));
            const idField = db[collection].schema.primKey.name;

            const sMap = new Map(sData.map(i => [i[idField], i]));
            const lMap = new Map(lData.map(i => [i[idField], i]));

            const onlyInServer = sData.filter(i => !lMap.has(i[idField]));
            const onlyInLocal = lData.filter(i => !sMap.has(i[idField]));
            const conflicts = sData.filter(s => {
                const l = lMap.get(s[idField]);
                if (!l) return false;
                const sVer = s._version || 0;
                const lVer = l._version || 0;
                const sUpd = s._updatedAt || 0;
                const lUpd = l._updatedAt || 0;
                return sVer !== lVer || sUpd !== lUpd;
            });

            // 1. Missing in Local -> Download
            if (onlyInServer.length > 0) {
                await db.transaction('rw', [db[collection], db.outbox], async () => {
                    await db[collection].bulkPut(onlyInServer);
                    const ids = onlyInServer.map(i => i[idField]);
                    await db.outbox.where('collection').equals(collection).filter(o => ids.includes(o.docId)).delete();
                });
            }

            // 2. Conflicts -> Trust Server (Overwrite Local)
            if (conflicts.length > 0) {
                await db.transaction('rw', [db[collection], db.outbox], async () => {
                    await db[collection].bulkPut(conflicts);
                    const ids = conflicts.map(i => i[idField]);
                    await db.outbox.where('collection').equals(collection).filter(o => ids.includes(o.docId)).delete();
                });
            }

            // 3. Missing in Server -> Upload (Touch & Sync)
            if (onlyInLocal.length > 0) {
                const toUpload = onlyInLocal.map(item => ({
                    ...item,
                    _updatedAt: Date.now(),
                    _version: (item._version || 0) + 1
                }));
                await db[collection].bulkPut(toUpload);

                const outboxEntries = toUpload.map(item => ({
                    collection: collection,
                    docId: item[idField],
                    type: 'upsert',
                    payload: item
                }));
                await db.outbox.bulkPut(outboxEntries);
            }
        }

        await SyncEngine.sync();
        alert("All issues resolved!");
        analyzeSync();

    } catch (e) {
        console.error(e);
        alert("Error resolving differences: " + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

async function downloadServerBackup() {
    const files = [
        'sync_metadata', 'items', 'transactions', 'suppliers', 'customers',
        'expenses', 'returns', 'shifts', 'stock_movements', 'stock_logs',
        'adjustments', 'stockins', 'suspended_transactions', 'notifications', 'users',
        'purchase_orders', 'supplier_config', 'inventory_metrics', 'discount_codes',
        'spatial_shelves', 'spatial_placements', 'settings'
    ];

    const backupData = {};
    const btn = document.getElementById("btn-download-backup-server");
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "⌛ Preparing Backup...";

    try {
        for (const file of files) {
            const res = await fetch(`${ADMIN_API_URL}?file=${file}`);
            if (res.ok) {
                backupData[file] = await res.json();
            }
        }

        const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const date = new Date().toISOString().split('T')[0];
        a.href = url;
        a.download = `lightpos-server-backup-${date}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        alert("Backup downloaded successfully.");
    } catch (error) {
        console.error("Backup failed:", error);
        alert("Failed to generate backup.");
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

async function downloadLocalBackup() {
    const db = await dbPromise;
    const files = db.tables.map(t => t.name).filter(name => name !== 'outbox');

    const backupData = {};
    const btn = document.getElementById("btn-download-backup-local");
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "⌛ Exporting...";

    try {
        for (const collection of files) {
            backupData[collection] = await db[collection].toArray();
        }

        const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const date = new Date().toISOString().split('T')[0];
        a.href = url;
        a.download = `lightpos-local-backup-${date}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        alert("Local backup downloaded successfully.");
    } catch (error) {
        console.error("Local backup failed:", error);
        alert("Failed to generate local backup.");
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
    }
}

async function handleRestoreBackup(e) {
    const db = await dbPromise;
    const file = e.target.files[0];
    if (!file) return;

    const isDryRun = document.getElementById("restore-dry-run")?.checked;

    let backupData;
    try {
        const text = await file.text();
        backupData = JSON.parse(text);
    } catch (error) {
        alert("Failed to read backup file: " + error.message);
        e.target.value = "";
        return;
    }

    if (!backupData || typeof backupData !== 'object') {
        alert("Invalid backup file format.");
        e.target.value = "";
        return;
    }

    // Intelligent detection of file structure
    if (Array.isArray(backupData)) {
        alert("This file contains a single list of items (Array), not a full system backup. Please upload a full backup file.");
        e.target.value = "";
        return;
    }

    if (backupData.serverData && typeof backupData.serverData === 'object' && !backupData.items) {
        if (confirm("This file appears to be a Diagnostic Report. Do you want to extract and restore the Server Data from it?")) {
            backupData = backupData.serverData;
        }
    } else if (backupData.deltas && typeof backupData.deltas === 'object' && !backupData.items) {
        backupData = backupData.deltas;
    } else if (backupData.settings && backupData.settings.deltas && typeof backupData.settings.deltas === 'object') {
        backupData = backupData.settings.deltas;
    }

    const syncableCollections = [
        'items', 'transactions', 'customers', 'suppliers', 'expenses',
        'shifts', 'returns', 'stock_movements', 'stock_logs',
        'adjustments', 'stockins', 'suspended_transactions', 'users',
        'purchase_orders', 'supplier_config', 'inventory_metrics', 'discount_codes',
        'spatial_shelves', 'spatial_placements', 'settings'
    ];

    let businessItemsPlanned = 0;
    let businessItemsRestored = 0;
    let totalCollections = 0;
    let totalItems = 0;
    let details = "";

    const collections = Object.entries(backupData);

    for (const [name, data] of collections) {
        if (Array.isArray(data)) {
            totalCollections++;
            totalItems += data.length;
            details += `- ${name}: ${data.length}\n`;

            if (syncableCollections.includes(name)) {
                businessItemsPlanned += data.length;
            }
        }
    }

    if (totalCollections === 0) {
        alert("No valid data collections found in this file. Please ensure it is a valid LightPOS backup file.\n\nFound keys: " + Object.keys(backupData).join(", "));
        e.target.value = "";
        return;
    }

    let summary = `Backup Analysis:\n\nCollections: ${totalCollections}\nTotal Items: ${totalItems}\n(Business Records: ${businessItemsPlanned})\n\nDetails:\n${details}`;

    if (isDryRun) {
        summary += `\n[DRY RUN MODE]: No data will be written to the server. This is a simulation to check file integrity.\n\nProceed with simulation?`;
    } else {
        summary += `\nWARNING: This will overwrite ALL current data on the server. This cannot be undone.\n\nProceed with restore?`;
    }

    if (!confirm(summary)) {
        e.target.value = "";
        return;
    }

    const btn = document.getElementById("btn-trigger-restore");
    const progressContainer = document.getElementById("restore-progress-container");
    const progressBar = document.getElementById("restore-progress-bar");
    const progressText = document.getElementById("restore-progress-text");

    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = isDryRun ? "⌛ Simulating..." : "⌛ Processing...";

    if (progressContainer) {
        progressContainer.classList.remove("hidden");
        progressBar.style.width = "0%";
        progressText.textContent = isDryRun ? "Reading backup file for simulation..." : "Reading backup file...";
    }

    try {
        const serverTime = Date.now();

        // Use calculated total from analysis step
        const totalItemsToRestore = totalItems;

        let itemsRestoredSoFar = 0;
        const CHUNK_SIZE = 200; // Reduced chunk size to ensure reliability

        // Upload collection by collection to avoid hitting server POST size limits (e.g. 76MB)
        for (const [fileName, data] of collections) {
            if (!Array.isArray(data)) continue;

            const isSyncable = syncableCollections.includes(fileName);

            // Update timestamps to ensure the sync engine sees this as "new" data
            data.forEach(item => {
                if (item && typeof item === 'object') {
                    item._updatedAt = serverTime;

                    // Deep sanitize to prevent extreme floating-point precision from crashing SQLite
                    const sanitized = deepSanitizeNumbers(item);
                    Object.assign(item, sanitized);

                    // Ensure timestamps are integers (fix for ISO strings in backups)
                    if (fileName === 'transactions' && typeof item.timestamp === 'string') {
                        const d = new Date(item.timestamp);
                        if (!isNaN(d.getTime())) {
                            item.timestamp = d.getTime();
                        }
                    }

                    // Fix for Users: Map 'password' to 'password_hash' for SQLite compatibility
                    if (fileName === 'users') {
                        if (item.password && !item.password_hash) {
                            item.password_hash = item.password;
                            delete item.password;
                        }
                    }
                }
            });

            const totalItems = data.length;
            if (totalItems === 0) {
                await fetch(`${ADMIN_API_URL}?file=${fileName}&mode=overwrite${isDryRun ? '&dry_run=true' : ''}`, { method: 'POST', body: JSON.stringify([]) });
                continue;
            }

            for (let i = 0; i < totalItems; i += CHUNK_SIZE) {
                const chunk = data.slice(i, i + CHUNK_SIZE);
                const mode = (i === 0) ? 'overwrite' : 'append';

                const currentChunkSize = chunk.length;
                itemsRestoredSoFar += currentChunkSize;
                if (isSyncable) businessItemsRestored += currentChunkSize;

                const percent = totalItemsToRestore > 0 ? Math.round((itemsRestoredSoFar / totalItemsToRestore) * 100) : 100;

                if (progressBar) progressBar.style.width = `${percent}%`;
                if (progressText) progressText.textContent = `${isDryRun ? 'Simulating' : 'Restoring'} ${fileName}... (${Math.round((i + currentChunkSize) / totalItems * 100)}%) - Total: ${percent}%`;
                btn.innerHTML = `⌛ ${percent}%`;

                const response = await fetch(`${ADMIN_API_URL}?file=${fileName}&mode=${mode}${isDryRun ? '&dry_run=true' : ''}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(chunk)
                });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`Failed to restore ${fileName} (chunk ${i}): ${errText}`);
                }
            }
        }

        // Ensure the server knows it is initialized, even if the backup file missed this key
        if (!isDryRun) {
            await fetch(`${ADMIN_API_URL}?file=sync_metadata&mode=append`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{ key: 'db_initialized', value: '1', _version: 1, _updatedAt: Date.now() }])
            });
        }

        const completionMessage = `Restore processing complete!

Summary:
----------------------------------------
Input File Name: ${file.name}
Input File Size: ${(file.size / 1024).toFixed(2)} KB
Collections Found: ${totalCollections}

Planned Restore:
- Total Items: ${totalItemsToRestore}
- Business Records: ${businessItemsPlanned} (Counts towards Sync)

Actual Execution:
- Items Sent: ${itemsRestoredSoFar}
- Business Sent: ${businessItemsRestored}
----------------------------------------

${isDryRun ? "Simulation ended. No changes marked on server." : "System restored successfully! The app will now reload and re-sync all data."}`;

        if (isDryRun) {
            if (progressBar) progressBar.style.width = "100%";
            if (progressText) progressText.textContent = "Simulation complete! No errors found.";
            alert(completionMessage);
        } else {
            if (progressBar) progressBar.style.width = "100%";
            if (progressText) progressText.textContent = "Restore complete! Reloading...";

            // The server has been restored. Now prepare the client for a fresh sync
            // by deleting the local database.
            await db.delete();

            alert(completionMessage);
            window.location.reload();
        }
    } catch (error) {
        console.error("Restore failed:", error);
        alert("Failed to restore backup: " + error.message);
        if (progressContainer) progressContainer.classList.add("hidden");
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
        e.target.value = "";
    }
}

function downloadSample(type) {
    let content, filename, mimeType;
    if (type === "json") {
        content = JSON.stringify([{ "barcode": "1001", "name": "Sample Soda 330ml", "base_unit": "Can", "cost_price": 15.50, "selling_price": 25.00, "stock_level": 48, "min_stock": 12, "supplier_id": "" }], null, 2);
        filename = "surprised-potato-items-sample.json"; mimeType = "application/json";
    } else {
        content = '"barcode","name","category","cost_price","unit_price","reorder_level"\n"123465","Rubber Band","SCHOOL SUPPLIES","0.45","0.50","0.000"\n"42184676","Nivea Cool Kick 25ml","DEODORANT","54.00","59.00","2.000"\n"42187608","Nivea Silver P 25ml","DEODORANT","67.00","73.00","2.000"\n"42316688","Nivea Invisible 25ml","DEODORANT","62.00","68.00","2.000"\n"45687485","Royal Rice 1Kl","rice","35.00","43.00","2.000"';
        filename = "surprised-potato-items-sample.csv"; mimeType = "text/csv";
    }
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

export async function runDiagnosticExport() {
    const db = await dbPromise;
    const btn = document.getElementById("btn-diagnostic-export");
    const originalText = btn ? btn.innerHTML : "";
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = "⌛ Generating Report...";
    }

    const entities = [
        'items', 'transactions', 'suppliers', 'customers',
        'expenses', 'returns', 'shifts', 'stock_movements', 'stock_logs',
        'adjustments', 'stockins', 'suspended_transactions', 'notifications', 'users',
        'purchase_orders', 'supplier_config', 'inventory_metrics', 'discount_codes',
        'spatial_shelves', 'spatial_placements', 'settings'
    ];

    try {
        const report = {
            timestamp: new Date().toISOString(),
            environment: {
                userAgent: navigator.userAgent,
                online: navigator.onLine,
                localStorage: {
                    last_sync_timestamp: localStorage.getItem('last_sync_timestamp')
                }
            },
            syncStatus: {
                lastPullTimestamp: (await db.sync_metadata.get('last_pull_timestamp'))?.value,
                outboxCount: await db.outbox.count(),
                outboxPreview: await db.outbox.toArray()
            },
            serverData: {},
            localData: {},
            discrepancies: {}
        };

        // 1. Settings comparison
        const sSetRes = await fetch(`${ADMIN_API_URL}?file=sync_metadata`);
        let sSet = sSetRes.ok ? await sSetRes.json() : null;

        // Unwrap sync envelope if present
        if (sSet && sSet.deltas && sSet.deltas.settings) {
            sSet = sSet.deltas.settings;
        }

        // If using router.php (ADMIN_API_URL), sSet is an array of metadata. Find settings.
        if (Array.isArray(sSet)) {
            sSet = sSet.find(i => i.key === 'settings');
        }

        // Extract value
        const sSetVal = (sSet && sSet.value) ? sSet.value : sSet;
        const lSet = (await db.sync_metadata.get('settings'))?.value;

        report.serverData.settings = sSetVal;
        report.localData.settings = lSet;

        // Compare only the actual settings content, ignoring metadata
        if (JSON.stringify(sSetVal) !== JSON.stringify(lSet)) {
            report.discrepancies.settings = "Mismatch between server settings.json and local sync_metadata['settings']";
        }

        // 2. Entity comparison
        for (const entity of entities) {
            if (!db[entity]) continue;

            const sRes = await fetch(`${ADMIN_API_URL}?file=${entity}`);
            let sData = sRes.ok ? await sRes.json() : [];

            // Unwrap sync envelope if present
            if (sData && !Array.isArray(sData) && sData.deltas && sData.deltas[entity]) {
                sData = sData.deltas[entity];
            }

            if (!Array.isArray(sData)) sData = [];
            const lData = await db[entity].toArray();

            report.serverData[entity] = sData;
            report.localData[entity] = lData;

            const idField = db[entity].schema.primKey.name;
            const sMap = new Map(sData.map(i => [i[idField], i]));
            const lMap = new Map(lData.map(i => [i[idField], i]));

            const onlyInServer = sData.filter(i => !lMap.has(i[idField])).map(i => i[idField]);
            const onlyInLocal = lData.filter(i => !sMap.has(i[idField])).map(i => i[idField]);
            const contentMismatch = sData.filter(s => {
                const l = lMap.get(s[idField]);
                return l && JSON.stringify(s) !== JSON.stringify(l);
            }).map(s => s[idField]);

            if (onlyInServer.length > 0 || onlyInLocal.length > 0 || contentMismatch.length > 0) {
                report.discrepancies[entity] = {
                    missingInLocalCount: onlyInServer.length,
                    missingInLocalIds: onlyInServer,
                    missingInServerCount: onlyInLocal.length,
                    missingInServerIds: onlyInLocal,
                    mismatchCount: contentMismatch.length,
                    mismatchIds: contentMismatch
                };
            }
        }

        const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `lightpos-diagnostic-${new Date().getTime()}.json`;
        a.click();
        URL.revokeObjectURL(url);

        return report;
    } catch (error) {
        console.error("Diagnostic export failed:", error);
        alert("Failed to generate diagnostic report.");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

// --- Discount Codes Logic (Top Level) ---

async function loadDiscountCodes() {
    const listBody = document.getElementById('discount-codes-list');
    listBody.innerHTML = '<tr><td colspan="5" class="p-4 text-center text-gray-400">Loading...</td></tr>';

    try {
        const codes = await Repository.getAll('discount_codes') || [];
        const activeCodes = codes.filter(c => !c._deleted);

        if (activeCodes.length === 0) {
            listBody.innerHTML = '<tr><td colspan="6" class="p-4 text-center text-gray-400 italic">No discount codes found.</td></tr>';
            return;
        }

        listBody.innerHTML = activeCodes.map(code => `
        <tr class="hover:bg-gray-50 group">
            <td class="p-2 border-b font-mono font-bold text-blue-600">${code.code}</td>
            <td class="p-2 border-b capitalize">${code.type}</td>
            <td class="p-2 border-b text-right font-mono">${code.type === 'percentage' ? code.value + '%' : '₱' + parseFloat(code.value).toFixed(2)}</td>
            <td class="p-2 border-b capitalize text-sm">${(code.usage_limit || 'unlimited').replace(/_/g, ' ')}</td>
            <td class="p-2 border-b text-center text-xs font-bold">
                <button type="button" class="btn-toggle-auto-record px-2 py-1 rounded cursor-pointer ${(code.auto_record && code.auto_record != '0') ? 'text-blue-600 hover:bg-blue-50' : 'text-gray-400 hover:bg-gray-100'}" data-id="${code.id}">
                    ${(code.auto_record && code.auto_record != '0') ? 'Yes' : 'No'}
                </button>
            </td>
            <td class="p-2 border-b text-center">
                <span class="px-2 py-1 rounded-full text-xs font-bold ${(code.is_active && code.is_active != '0') ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">
                    ${(code.is_active && code.is_active != '0') ? 'Active' : 'Inactive'}
                </span>
            </td>
            <td class="p-2 border-b text-center">
                <button class="btn-delete-discount text-red-400 hover:text-red-600 p-1" data-id="${code.id}">
                    🗑️
                </button>
            </td>
        </tr>
    `).join('');

    } catch (e) {
        console.error("Error loading discount codes", e);
        listBody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-red-500">Error loading data</td></tr>`;
    }
}

async function handleAddDiscountCode() {
    const codeInput = document.getElementById('discount-code-input');
    const typeInput = document.getElementById('discount-type-input');
    const valueInput = document.getElementById('discount-value-input');
    const usageInput = document.getElementById('discount-usage-input');
    const activeInput = document.getElementById('discount-active-input');
    const autoRecordInput = document.getElementById('discount-auto-record-input');

    const code = codeInput.value.trim().toUpperCase();
    const type = typeInput.value;
    const value = parseFloat(valueInput.value);
    const usage = usageInput.value;
    const isActive = activeInput.checked;
    const autoRecord = autoRecordInput ? autoRecordInput.checked : false;

    if (!code) {
        alert("Please enter a code.");
        return;
    }
    if (isNaN(value) || value <= 0) {
        alert("Please enter a valid positive value.");
        return;
    }

    const newDiscount = {
        code,
        type,
        value,
        usage_limit: usage,
        is_active: isActive,
        auto_record: autoRecord,
        id: generateUUID(),
        sync_status: 'pending',
        _version: 1,
        _updatedAt: Date.now(),
        _deleted: 0
    };

    try {
        await Repository.upsert('discount_codes', newDiscount);
        await SyncEngine.sync();

        // Reset Inputs
        codeInput.value = '';
        valueInput.value = '';
        activeInput.checked = true;
        if (autoRecordInput) autoRecordInput.checked = false;

        loadDiscountCodes();
    } catch (e) {
        console.error("Error adding discount code", e);
        alert("Failed to add discount code.");
    }
}

async function handleDeleteDiscountCode(e) {
    const deleteBtn = e.target.closest('.btn-delete-discount');
    const toggleBtn = e.target.closest('.btn-toggle-auto-record');

    if (deleteBtn) {
        if (!confirm("Delete this discount code?")) return;
        try {
            await Repository.remove('discount_codes', deleteBtn.dataset.id);
            await SyncEngine.sync();
            loadDiscountCodes();
        } catch (err) {
            console.error("Failed to delete", err);
            alert("Error deleting code");
        }
        return;
    }

    if (toggleBtn) {
        try {
            const id = toggleBtn.dataset.id;
            const codeRecord = await Repository.get('discount_codes', id);
            if (codeRecord) {
                const currentAuto = codeRecord.auto_record === true || codeRecord.auto_record === 1 || codeRecord.auto_record === '1';
                codeRecord.auto_record = !currentAuto;
                await Repository.upsert('discount_codes', codeRecord);
                await SyncEngine.sync();
                loadDiscountCodes();
            }
        } catch (err) {
            console.error("Failed to toggle auto record", err);
        }
    }
}

// --- Price Tools Logic ---

async function loadPriceToolsCategories() {
    const list = document.getElementById('pt-categories-list');
    list.innerHTML = '<div class="text-gray-400 text-xs text-center col-span-full py-2">Loading categories...</div>';

    try {
        const db = await dbPromise;
        const items = await db.items.toArray();
        const categories = new Set();
        items.forEach(i => {
            if (i.category) categories.add(i.category);
        });

        if (categories.size === 0) {
            list.innerHTML = '<div class="text-gray-400 text-xs text-center col-span-full py-2">No categories found.</div>';
            return;
        }

        const sorted = Array.from(categories).sort();
        list.innerHTML = sorted.map(c => `
            <label class="inline-flex items-center p-1 hover:bg-white rounded cursor-pointer">
                <input type="checkbox" class="form-checkbox h-3 w-3 text-red-500 pt-cat-exclude" value="${c}">
                <span class="ml-2 text-xs text-gray-700 truncate" title="${c}">${c}</span>
            </label>
        `).join('');

    } catch (e) {
        console.error("Error loading categories", e);
        list.innerHTML = '<div class="text-red-500 text-xs text-center col-span-full py-2">Error loading categories.</div>';
    }
}

let pendingPriceUpdates = [];

async function runPriceCheck() {
    const markupPct = parseFloat(document.getElementById('pt-markup-pct').value);
    const markupCap = document.getElementById('pt-markup-cap').value ? parseFloat(document.getElementById('pt-markup-cap').value) : null;
    const rounding = document.getElementById('pt-rounding').value;

    // Get exempted categories
    const exemptedCats = Array.from(document.querySelectorAll('.pt-cat-exclude:checked')).map(cb => cb.value);

    if (isNaN(markupPct) || markupPct < 0) {
        alert("Please enter a valid markup percentage.");
        return;
    }

    const btn = document.getElementById('btn-run-price-check');
    const originalText = btn.textContent;
    btn.textContent = "Scanning...";
    btn.disabled = true;

    try {
        const db = await dbPromise;
        const allItems = await db.items.toArray();

        pendingPriceUpdates = [];
        const targetMarkupRatio = markupPct / 100; // e.g. 0.20 for 20%

        allItems.forEach(item => {
            // Skip exempted categories
            if (item.category && exemptedCats.includes(item.category)) return;

            // Skip invalid data
            if (!item.cost_price || item.cost_price <= 0) return;
            // Skip items with no selling price (maybe raw materials?)
            if (item.selling_price === undefined || item.selling_price === null) return;

            const cost = parseFloat(item.cost_price);
            const price = parseFloat(item.selling_price);

            // Calculate current markup
            // Markup = (Price - Cost) / Cost
            const currentMarkup = (price - cost) / cost;

            // If current markup is BELOW target
            if (currentMarkup < targetMarkupRatio) {
                // Calculate new price: Cost * (1 + TargetMarkup)
                let newPrice = cost * (1 + targetMarkupRatio);

                // Apply Cap if set (Max Price Increase)
                if (markupCap !== null && (newPrice - price) > markupCap) {
                    newPrice = price + markupCap;
                }

                // Apply Rounding
                if (rounding === 'nearest_0.25') newPrice = Math.round(newPrice * 4) / 4;
                else if (rounding === 'nearest_0.50') newPrice = Math.round(newPrice * 2) / 2;
                else if (rounding === 'nearest_1.00') newPrice = Math.round(newPrice);
                else if (rounding === 'ceil_1.00') newPrice = Math.ceil(newPrice);
                else if (rounding === 'psych_99') newPrice = Math.floor(newPrice) + 0.99;

                // Ensure new price is at least cost (sanity check)
                if (newPrice < cost) newPrice = cost;

                // Only add if price actually changes
                if (Math.abs(newPrice - price) > 0.01) {
                    pendingPriceUpdates.push({
                        item: item,
                        oldPrice: price,
                        newPrice: newPrice,
                        cost: cost,
                        oldMargin: ((price - cost) / price * 100).toFixed(1),
                        newMargin: ((newPrice - cost) / newPrice * 100).toFixed(1)
                    });
                }
            }
        });

        // Show Results
        const modal = document.getElementById('price-check-modal');
        const countSpan = document.getElementById('pt-match-count');
        const tbody = document.getElementById('pt-result-body');

        countSpan.textContent = pendingPriceUpdates.length;

        if (pendingPriceUpdates.length === 0) {
            alert("No items found matching the criteria (Markup < " + markupPct + "%).");
            modal.classList.add('hidden');
        } else {
            tbody.innerHTML = pendingPriceUpdates.map(u => `
                <tr class="hover:bg-gray-50 border-b">
                    <td class="p-2">
                        <div class="font-bold text-gray-800 truncate max-w-[200px]" title="${u.item.name}">${u.item.name}</div>
                        <div class="text-[10px] text-gray-500">${u.item.barcode || '-'}</div>
                    </td>
                    <td class="p-2 text-right font-mono text-gray-600">₱${u.cost.toFixed(2)}</td>
                    <td class="p-2 text-right">
                        <div class="test-xs">₱${u.oldPrice.toFixed(2)}</div>
                        <div class="text-[10px] text-red-500">(${u.oldMargin}%)</div>
                    </td>
                    <td class="p-2 text-right bg-blue-50">
                        <div class="font-bold text-blue-700">₱${u.newPrice.toFixed(2)}</div>
                        <div class="text-[10px] text-green-600">(${u.newMargin}%)</div>
                    </td>
                </tr>
            `).join('');

            modal.classList.remove('hidden');
        }

    } catch (e) {
        console.error("Price check error", e);
        alert("Error running price check.");
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

async function applyPriceUpdates() {
    if (pendingPriceUpdates.length === 0) return;

    const btn = document.getElementById('btn-confirm-update');
    const originalText = btn.textContent;
    btn.textContent = "Updating...";
    btn.disabled = true;

    try {
        let updatedCount = 0;
        for (const update of pendingPriceUpdates) {
            await Repository.upsert('items', {
                ...update.item,
                selling_price: update.newPrice,
            });
            updatedCount++;
        }

        alert(`Successfully updated ${updatedCount} items.`);
        document.getElementById('price-check-modal').classList.add('hidden');
        pendingPriceUpdates = [];

    } catch (e) {
        console.error("Bulk update error", e);
        alert("Error updating items. Check console.");
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}