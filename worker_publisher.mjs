import {
    claimJob, updateJobState, incrementRetryCount, moveToDLQ,
    NOTION_HEADERS, DATABASE_ID, NotionAPIError
} from './notion_helper.mjs';
import { fetchWithRetry } from './notion_retry.mjs';
import { logEvent } from './event_logger.mjs';

const WORKER_ID = `publisher-worker-${process.pid}`;
const MAX_RETRIES = 5;

// ─── Queue Query ─────────────────────────────────────────────────────────────

/**
 * Fetch APPROVED jobs that are NOT already leased to another worker.
 * Only returns jobs where Lease Expiration is empty or in the past.
 */
async function fetchApprovedJobs() {
    const now = new Date().toISOString();
    const res = await fetchWithRetry(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {
            method: 'POST',
            headers: NOTION_HEADERS,
            body: JSON.stringify({
                filter: {
                    and: [
                        { property: 'Pipeline', select: { equals: 'APPROVED' } },
                        // Only pick up jobs with no active lease
                        {
                            or: [
                                { property: 'Lease Expiration', date: { is_empty: true } },
                                { property: 'Lease Expiration', date: { before: now } }
                            ]
                        }
                    ]
                }
            })
        }
    );
    const data = await res.json();
    return data.results;
}

// ─── Content Fetch ───────────────────────────────────────────────────────────

async function fetchPageBody(pageId) {
    try {
        const res = await fetchWithRetry(
            `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
            { headers: NOTION_HEADERS }
        );
        const data = await res.json();
        let body = '';
        for (const block of (data.results || [])) {
            const richText = block[block.type]?.rich_text || [];
            body += richText.map(t => t.plain_text).join('') + '\n';
        }
        return body.trim();
    } catch (err) {
        // Re-throw typed errors; swallow unknowns as empty body
        if (err instanceof NotionAPIError && err.fatal) throw err;
        console.warn(`[Publisher] Could not fetch body for ${pageId}: ${err.message}`);
        return '';
    }
}

// ─── Platform Publisher ──────────────────────────────────────────────────────

async function publishToSocialMedia(jobId, platform, mediaUrl, content) {
    console.log(`[Publisher API] 🚀 Initiating push for job ${jobId} to ${platform}`);
    // MOCK: In production, hook up Facebook/Instagram Playwright CDP scripts here.
    // Replace this block with a real API call wrapped in fetchWithRetry.
    return new Promise((resolve) => {
        setTimeout(() => {
            console.log(`[Publisher API] ✅ Successfully posted to ${platform}!`);
            // Return a platform post ID for idempotency tracking
            resolve({ postId: `mock-${Date.now()}` });
        }, 2000);
    });
}

// ─── Main Worker Loop ────────────────────────────────────────────────────────

async function main() {
    console.log(`[Worker: Publisher] Starting... ID: ${WORKER_ID}`);
    const jobs = await fetchApprovedJobs();
    console.log(`Found ${jobs.length} APPROVED jobs ready for publishing.`);

    if (jobs.length === 0) return;

    for (const job of jobs) {
        const jobIdStr = job.properties['Job ID']?.rich_text[0]?.plain_text || job.id;
        const retryCount = job.properties['Retry Count']?.number ?? 0;

        try {
            // ── STEP 1: Atomic claim → immediately set PUBLISHING transient state ──
            console.log(`\n🔒 Claiming job ${jobIdStr} → PUBLISHING...`);
            await claimJob(job.id, 'PUBLISHING', WORKER_ID, 15);

            // ── STEP 2: Idempotency check — skip if already published ──
            const existingPostId = job.properties['Published Post ID']?.rich_text?.[0]?.plain_text;
            if (existingPostId) {
                console.log(`⚠️  Job ${jobIdStr} already has Published Post ID (${existingPostId}). Skipping API call — marking Published.`);
                await updateJobState(job.id, 'Published');
                logEvent(jobIdStr, 'PUBLISHING', 'Published', WORKER_ID, `Idempotency skip — already posted (${existingPostId})`);
                continue;
            }

            // ── STEP 3: Fetch content and publish ──
            const postContent = await fetchPageBody(job.id);
            const platform = job.properties['Platform']?.select?.name || 'Unknown';
            const mediaUrl = job.properties['Media URL']?.url || null;

            const result = await publishToSocialMedia(jobIdStr, platform, mediaUrl, postContent);

            // ── STEP 4: Write Published Post ID FIRST (two-phase commit) ──
            // If this succeeds but the state update below fails, the idempotency
            // check on the next run will catch it and skip the duplicate API call.
            await updateJobState(job.id, 'Published', {
                'Published Post ID': { rich_text: [{ text: { content: String(result.postId) } }] }
            });

            logEvent(jobIdStr, 'PUBLISHING', 'Published', WORKER_ID, `Published to ${platform} — postId: ${result.postId}`);
            console.log(`✅ Job ${jobIdStr} published. State → Published.`);

        } catch (err) {
            const isFatal = err instanceof NotionAPIError && err.fatal;

            if (isFatal) {
                // Fatal errors (auth, schema) → DLQ immediately, do not increment retry
                console.error(`💀 Fatal error on job ${jobIdStr}: ${err.message}`);
                await moveToDLQ(job.id, `Fatal: ${err.message}`);
                logEvent(jobIdStr, 'PUBLISHING', 'DLQ_FAILED', WORKER_ID, `Fatal: ${err.message}`);
            } else {
                // Transient errors → increment retry counter
                const newCount = await incrementRetryCount(job.id, retryCount);
                console.error(`❌ Job ${jobIdStr} failed (attempt ${newCount}/${MAX_RETRIES}): ${err.message}`);

                if (newCount >= MAX_RETRIES) {
                    await moveToDLQ(job.id, `Exhausted ${MAX_RETRIES} retries. Last error: ${err.message}`);
                    logEvent(jobIdStr, 'PUBLISHING', 'DLQ_FAILED', WORKER_ID, `Retries exhausted: ${err.message}`);
                } else {
                    // Reset to APPROVED so the next worker poll can pick it up
                    await updateJobState(job.id, 'APPROVED');
                    logEvent(jobIdStr, 'PUBLISHING', 'APPROVED', WORKER_ID, `Retry ${newCount}/${MAX_RETRIES}: ${err.message}`);
                }
            }
        }
    }
}

main().catch(err => {
    console.error(`[Publisher] Fatal Worker Error: ${err.message}`);
    process.exit(1);
});
