import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchWithRetry, NotionAPIError } from './notion_retry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(BASE, '.env');

const env = {};
try {
    fs.readFileSync(ENV_PATH, 'utf8').replace(/\r/g, '').split('\n').forEach(line => {
        const m = line.match(/^([^=]+)=(.*)$/);
        if (m) env[m[1].trim()] = m[2].trim().replace(/^"|"$/g, '');
    });
} catch (e) {
    console.error('Failed to read .env:', e.message);
}

export const NOTION_API_KEY = env.NOTION_CMS_API_KEY || env.NOTION_API_KEY;
export const DATABASE_ID = env.NOTION_DATABASE_ID;

export const NOTION_HEADERS = {
    'Authorization': `Bearer ${NOTION_API_KEY}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
};

// Re-export so callers can use typed errors without a second import
export { NotionAPIError };

/**
 * Check if a job already exists in Notion by Job ID (Idempotency check)
 */
export async function getJobById(jobId) {
    const res = await fetchWithRetry(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {
            method: 'POST',
            headers: NOTION_HEADERS,
            body: JSON.stringify({
                filter: { property: 'Job ID', rich_text: { equals: jobId } }
            })
        }
    );

    const data = await res.json();
    return data.results.length > 0 ? data.results[0] : null;
}

/**
 * Claim a job atomically by immediately moving it to a transient state
 * (PUBLISHING or REVIEWING) so no other worker can see it as available.
 *
 * The query layer in each worker MUST filter for the pre-claim state
 * AND verify that Lease Expiration is absent or already expired.
 *
 * @param {string} pageId         Notion page ID of the job
 * @param {string} transitState   The transient state to set (e.g. 'PUBLISHING')
 * @param {string} workerId       Unique ID of the claiming worker process
 * @param {number} leaseMinutes   How long to hold the lease (default 15 min)
 */
export async function claimJob(pageId, transitState, workerId, leaseMinutes = 15) {
    const expiration = new Date();
    expiration.setMinutes(expiration.getMinutes() + leaseMinutes);

    const payload = {
        properties: {
            // ── CRITICAL: Set the transient state FIRST so other workers stop seeing this job ──
            'Pipeline': { select: { name: transitState } },
            'Worker ID': { rich_text: [{ text: { content: workerId } }] },
            'Lease Expiration': { date: { start: expiration.toISOString() } }
        }
    };

    const res = await fetchWithRetry(
        `https://api.notion.com/v1/pages/${pageId}`,
        { method: 'PATCH', headers: NOTION_HEADERS, body: JSON.stringify(payload) }
    );

    return await res.json();
}

/**
 * Update the state of a job and clear the worker lease.
 */
export async function updateJobState(pageId, newState, extraProps = {}) {
    const payload = {
        properties: {
            'Pipeline': { select: { name: newState } },
            'Worker ID': { rich_text: [] },       // Clear worker
            'Lease Expiration': { date: null },    // Clear lease
            ...extraProps
        }
    };

    const res = await fetchWithRetry(
        `https://api.notion.com/v1/pages/${pageId}`,
        { method: 'PATCH', headers: NOTION_HEADERS, body: JSON.stringify(payload) }
    );

    return await res.json();
}

/**
 * Increment the Retry Count field on a job record.
 * Returns the new count.
 */
export async function incrementRetryCount(pageId, currentCount = 0) {
    const newCount = currentCount + 1;
    const res = await fetchWithRetry(
        `https://api.notion.com/v1/pages/${pageId}`,
        {
            method: 'PATCH',
            headers: NOTION_HEADERS,
            body: JSON.stringify({
                properties: { 'Retry Count': { number: newCount } }
            })
        }
    );
    await res.json(); // consume body
    return newCount;
}

/**
 * Move a job to the Dead Letter Queue (DLQ_FAILED) and record the failure reason.
 * This is a terminal state — the job will NOT be retried automatically.
 */
export async function moveToDLQ(pageId, reason) {
    console.error(`[DLQ] Moving job ${pageId} to DLQ_FAILED. Reason: ${reason}`);
    const payload = {
        properties: {
            'Pipeline': { select: { name: 'DLQ_FAILED' } },
            'Worker ID': { rich_text: [] },
            'Lease Expiration': { date: null },
            'DLQ Reason': { rich_text: [{ text: { content: String(reason).substring(0, 2000) } }] }
        }
    };

    const res = await fetchWithRetry(
        `https://api.notion.com/v1/pages/${pageId}`,
        { method: 'PATCH', headers: NOTION_HEADERS, body: JSON.stringify(payload) }
    );
    return await res.json();
}
