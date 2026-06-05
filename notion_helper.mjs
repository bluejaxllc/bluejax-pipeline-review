import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

/**
 * Check if a job already exists in Notion by Job ID (Idempotency check)
 */
export async function getJobById(jobId) {
    const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({
            filter: {
                property: "Job ID",
                rich_text: {
                    equals: jobId
                }
            }
        })
    });

    if (!res.ok) {
        throw new Error(`Failed to query Notion: ${await res.text()}`);
    }

    const data = await res.json();
    return data.results.length > 0 ? data.results[0] : null;
}

/**
 * Claim a job by updating its state, assigning a worker ID, and setting a lease expiration
 */
export async function claimJob(pageId, newState, workerId, leaseMinutes = 15) {
    const expiration = new Date();
    expiration.setMinutes(expiration.getMinutes() + leaseMinutes);

    const payload = {
        properties: {
            "Pipeline": { select: { name: newState } },
            "Worker ID": { rich_text: [{ text: { content: workerId } }] },
            "Lease Expiration": { date: { start: expiration.toISOString() } }
        }
    };

    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: NOTION_HEADERS,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        throw new Error(`Failed to claim job: ${await res.text()}`);
    }

    return await res.json();
}

/**
 * Update the state of a job (e.g. marking it COMPLETE) and clear the lease
 */
export async function updateJobState(pageId, newState) {
    const payload = {
        properties: {
            "Pipeline": { select: { name: newState } },
            "Worker ID": { rich_text: [] }, // Clear worker
            "Lease Expiration": { date: null } // Clear lease
        }
    };

    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: NOTION_HEADERS,
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        throw new Error(`Failed to update job state: ${await res.text()}`);
    }

    return await res.json();
}

