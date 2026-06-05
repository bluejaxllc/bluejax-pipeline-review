/**
 * notion_retry.mjs
 * ─────────────────────────────────────────────────────────────────
 * Shared resilience layer for all external API calls in the pipeline.
 *
 * Features:
 *  • AbortController timeout (default 30 s) on every request
 *  • Exponential backoff retry (default 5 attempts)
 *  • Distinguishes transient errors (429, 503 …) from fatal ones (400, 401, 403)
 *  • Typed NotionAPIError so callers can make smart decisions
 */

// ─── Error Types ────────────────────────────────────────────────────────────

export class NotionAPIError extends Error {
    constructor(message, { statusCode, body, fatal = false } = {}) {
        super(message);
        this.name = 'NotionAPIError';
        this.statusCode = statusCode;
        this.body = body;
        this.fatal = fatal; // true → caller should NOT retry; exit process
    }
}

// HTTP status codes that should NOT be retried (caller misconfiguration / auth)
const FATAL_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

// ─── Core fetch wrapper ──────────────────────────────────────────────────────

/**
 * fetchWithRetry
 * Wraps `fetch` with a timeout + exponential backoff retry loop.
 *
 * @param {string} url
 * @param {RequestInit} opts   Standard fetch options (method, headers, body …)
 * @param {number} maxRetries  Maximum number of attempts (default 5)
 * @param {number} timeoutMs   Per-request timeout in ms (default 30 000)
 * @returns {Promise<Response>} The successful Response object
 * @throws {NotionAPIError}    On fatal HTTP errors or exhausted retries
 */
export async function fetchWithRetry(url, opts = {}, maxRetries = 5, timeoutMs = 30_000) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const res = await fetch(url, { ...opts, signal: controller.signal });

            // ── Fatal status → throw immediately, no retry ──
            if (FATAL_STATUS_CODES.has(res.status)) {
                const body = await res.text();
                throw new NotionAPIError(
                    `Fatal HTTP ${res.status} from ${url}: ${body}`,
                    { statusCode: res.status, body, fatal: true }
                );
            }

            // ── Rate limit / server error → back off and retry ──
            if (!res.ok) {
                const body = await res.text();
                const delay = backoffMs(attempt);
                console.warn(
                    `[Retry] HTTP ${res.status} on attempt ${attempt}/${maxRetries}. ` +
                    `Retrying in ${delay}ms… (${url})`
                );
                lastError = new NotionAPIError(
                    `HTTP ${res.status}: ${body}`,
                    { statusCode: res.status, body, fatal: false }
                );
                await sleep(delay);
                continue;
            }

            return res; // ✅ success

        } catch (err) {
            // Re-throw fatal typed errors immediately
            if (err instanceof NotionAPIError && err.fatal) throw err;

            // AbortController timeout fired
            if (err.name === 'AbortError') {
                lastError = new NotionAPIError(
                    `Request timed out after ${timeoutMs}ms (${url})`,
                    { statusCode: 0, fatal: false }
                );
            } else if (err instanceof NotionAPIError) {
                lastError = err;
            } else {
                // Network-level errors (ECONNREFUSED, etc.)
                lastError = new NotionAPIError(
                    `Network error on attempt ${attempt}: ${err.message}`,
                    { statusCode: 0, fatal: false }
                );
            }

            if (attempt < maxRetries) {
                const delay = backoffMs(attempt);
                console.warn(
                    `[Retry] ${lastError.message} — retrying in ${delay}ms (${attempt}/${maxRetries})`
                );
                await sleep(delay);
            }
        } finally {
            clearTimeout(timer);
        }
    }

    // All attempts exhausted
    throw lastError ?? new NotionAPIError(`All ${maxRetries} attempts failed for ${url}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter: 1 s, 2 s, 4 s, 8 s, 16 s …
 * Capped at 30 s to avoid stalling workers too long.
 */
function backoffMs(attempt) {
    const base = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
    const jitter = Math.random() * 1000;
    return Math.round(base + jitter);
}
