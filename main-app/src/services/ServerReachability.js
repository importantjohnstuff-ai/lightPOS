/**
 * Server Reachability Utility
 * 
 * Replaces navigator.onLine checks which only detect WAN/internet connectivity,
 * not LAN server reachability. This is critical for offline-first POS systems
 * that operate on local networks without internet access.
 */

let _isServerReachable = null; // null = unknown, true/false = cached result
let _lastCheckTime = 0;
const CHECK_INTERVAL_MS = 15000; // Don't ping more often than every 15s
const PING_TIMEOUT_MS = 3000;    // Timeout for server ping

/**
 * Check if the API server is reachable by performing a lightweight fetch.
 * Results are cached for CHECK_INTERVAL_MS to avoid excessive network requests.
 * 
 * @param {boolean} forceCheck - Bypass the cache and check immediately
 * @returns {Promise<boolean>} - true if server is reachable
 */
export async function isServerReachable(forceCheck = false) {
    const now = Date.now();

    // Return cached result if still fresh
    if (!forceCheck && _isServerReachable !== null && (now - _lastCheckTime) < CHECK_INTERVAL_MS) {
        return _isServerReachable;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

        const response = await fetch('api/router.php', {
            method: 'GET',
            signal: controller.signal,
            cache: 'no-store'
        });

        clearTimeout(timeoutId);

        _isServerReachable = response.ok;
        _lastCheckTime = now;
        
        // Dispatch connectivity event for UI updates
        window.dispatchEvent(new CustomEvent('server-connectivity-change', { 
            detail: { reachable: true } 
        }));

        return true;
    } catch (e) {
        _isServerReachable = false;
        _lastCheckTime = now;
        
        window.dispatchEvent(new CustomEvent('server-connectivity-change', { 
            detail: { reachable: false } 
        }));

        return false;
    }
}

/**
 * Get the last known server reachability state without making a network request.
 * Returns null if no check has been performed yet.
 * 
 * @returns {boolean|null}
 */
export function getLastKnownReachability() {
    return _isServerReachable;
}

/**
 * Reset the cached state (useful after IP/network changes)
 */
export function resetReachabilityCache() {
    _isServerReachable = null;
    _lastCheckTime = 0;
}

// Re-check server reachability when browser network state changes
// (these events fire on network interface changes, which is a good trigger
// to re-validate actual server reachability)
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
        resetReachabilityCache();
        isServerReachable(true); // Force re-check
    });
    window.addEventListener('offline', () => {
        _isServerReachable = false;
        window.dispatchEvent(new CustomEvent('server-connectivity-change', { 
            detail: { reachable: false } 
        }));
    });
}
