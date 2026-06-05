import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { bosCall } from './bos_client.mjs';
import { claimJob, updateJobState, NOTION_HEADERS, DATABASE_ID } from './notion_helper.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(__dirname, '..', '..');
const MEDIA_DIR = path.join(BASE, 'agent_sandbox', 'general', 'media', 'creative', 'notion');

const WORKER_ID = `media-worker-${process.pid}`;
const MAX_ATTEMPTS = 5;

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPendingMediaJobs() {
    const now = new Date().toISOString();
    
    // Query jobs that are MEDIA_PENDING AND (Lease is Empty OR Lease has expired)
    const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({
            filter: {
                and: [
                    { property: 'Pipeline', select: { equals: 'MEDIA_PENDING' } },
                    {
                        or: [
                            { property: 'Lease Expiration', date: { is_empty: true } },
                            { property: 'Lease Expiration', date: { before: now } }
                        ]
                    }
                ]
            }
        })
    });

    if (!res.ok) throw new Error(`Failed to query jobs: ${await res.text()}`);
    const data = await res.json();
    return data.results;
}

// ... [Skipping the 200 lines of BOS generation logic for brevity in this MVP implementation] ...
// Assume `generateMediaBrowserOS` and `uploadToCatbox` are imported/implemented here.
// For this Phase 2 worker refactor, we will mock the generation to prove the state machine works.

async function main() {
    console.log(`[Worker: Media] Starting... ID: ${WORKER_ID}`);
    fs.mkdirSync(MEDIA_DIR, { recursive: true });

    // Health check BOS
    try {
        bosCall('list_pages'); 
    } catch {
        console.error('âŒ BrowserOS MCP Error: Is the BOS server running?');
        process.exit(1);
    }

    const jobs = await fetchPendingMediaJobs();
    console.log(`Found ${jobs.length} pending jobs.`);

    for (const job of jobs) {
        const jobIdStr = job.properties['Job ID']?.rich_text[0]?.plain_text || job.id;
        let attempts = job.properties['Attempts']?.number || 0;

        if (attempts >= MAX_ATTEMPTS) {
            console.log(`âš ï¸ Job ${jobIdStr} exceeded max attempts (${MAX_ATTEMPTS}). Marking FAILED.`);
            await updateJobState(job.id, 'FAILED');
            continue;
        }

        try {
            console.log(`\nðŸ”’ Claiming job ${jobIdStr}...`);
            await claimJob(job.id, 'MEDIA_GENERATING', WORKER_ID, 10);
            
            // Increment attempts
            await fetch(`https://api.notion.com/v1/pages/${job.id}`, {
                method: 'PATCH',
                headers: NOTION_HEADERS,
                body: JSON.stringify({ properties: { "Attempts": { number: attempts + 1 } } })
            });

            console.log(`â³ Processing media for ${jobIdStr} (Attempt ${attempts + 1})...`);
            
            // MOCK: Simulate media generation taking 3 seconds
            await wait(3000);
            const mockMediaUrl = "https://files.catbox.moe/mock_image.png";

            // Update Notion with media and set to APPROVAL_PENDING
            await fetch(`https://api.notion.com/v1/pages/${job.id}`, {
                method: 'PATCH',
                headers: NOTION_HEADERS,
                body: JSON.stringify({
                    cover: { type: 'external', external: { url: mockMediaUrl } },
                    properties: {
                        'Media URL': { url: mockMediaUrl }
                    }
                })
            });

            await updateJobState(job.id, 'APPROVAL_PENDING');
            console.log(`âœ… Job ${jobIdStr} complete. State -> APPROVAL_PENDING.`);

        } catch (err) {
            console.error(`âŒ Job ${jobIdStr} failed: ${err.message}`);
            // Let the lease expire naturally so another worker can retry, or mark RETRY_PENDING
            await updateJobState(job.id, 'RETRY_PENDING');
        }
    }

    console.log('[Worker: Media] Finished queue.');
}

main().catch(err => console.error(`Worker Fatal: ${err.message}`));

