import {
    claimJob, updateJobState, incrementRetryCount, moveToDLQ,
    NOTION_HEADERS, DATABASE_ID, NotionAPIError
} from './notion_helper.mjs';
import { fetchWithRetry } from './notion_retry.mjs';
import { ReviewerFactory } from './reviewer_factory.mjs';
import { logEvent } from './event_logger.mjs';

const WORKER_ID = `reviewer-worker-${process.pid}`;
const PROVIDER = process.env.REVIEWER_PROVIDER || 'gemini';
const MAX_RETRIES = 5;

// ─── Queue Query ─────────────────────────────────────────────────────────────

/**
 * Fetch CONTENT_REVIEW_PENDING jobs that are NOT already leased.
 */
async function fetchPendingReviewJobs() {
    const now = new Date().toISOString();
    const res = await fetchWithRetry(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {
            method: 'POST',
            headers: NOTION_HEADERS,
            body: JSON.stringify({
                filter: {
                    and: [
                        { property: 'Pipeline', select: { equals: 'CONTENT_REVIEW_PENDING' } },
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
    const res = await fetchWithRetry(
        `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
        { headers: NOTION_HEADERS }
    );
    // Re-throws on any error — callers handle it
    const data = await res.json();
    let body = '';
    for (const block of (data.results || [])) {
        const richText = block[block.type]?.rich_text || [];
        body += richText.map(t => t.plain_text).join('') + '\n';
    }
    return body.trim();
}

// ─── Main Worker Loop ────────────────────────────────────────────────────────

async function main() {
    console.log(`[Worker: Reviewer] Starting... ID: ${WORKER_ID} | Provider: ${PROVIDER}`);
    const jobs = await fetchPendingReviewJobs();
    console.log(`Found ${jobs.length} pending reviews.`);

    if (jobs.length === 0) return;

    const reviewer = ReviewerFactory.create(PROVIDER);

    for (const job of jobs) {
        const jobIdStr = job.properties['Job ID']?.rich_text[0]?.plain_text || job.id;
        const retryCount = job.properties['Retry Count']?.number ?? 0;

        try {
            // ── STEP 1: Atomic claim → REVIEWING transient state ──
            console.log(`\n🔒 Claiming job ${jobIdStr} → REVIEWING...`);
            await claimJob(job.id, 'REVIEWING', WORKER_ID, 15);

            // ── STEP 2: Fetch content — typed errors propagate ──
            const postContent = await fetchPageBody(job.id);
            const brandId = job.properties['Client Brand']?.relation?.[0]?.id || 'Unknown Brand';

            console.log(`⏳ Executing ${PROVIDER} Review for job ${jobIdStr}...`);
            const reviewResult = await reviewer.review({
                id: jobIdStr,
                brand_id: brandId,
                content: postContent,
                mediaType: job.properties['Media Type']?.select?.name || 'text'
            });

            // ── STEP 3: Write review metadata ──
            const feedbackText = (reviewResult.issues || []).join('\n');
            await fetchWithRetry(
                `https://api.notion.com/v1/pages/${job.id}`,
                {
                    method: 'PATCH',
                    headers: NOTION_HEADERS,
                    body: JSON.stringify({
                        properties: {
                            'Review Score': { number: reviewResult.score || 0 },
                            'Review Feedback': { rich_text: [{ text: { content: feedbackText.substring(0, 2000) } }] },
                            'Suggested Rewrite': { rich_text: [{ text: { content: (reviewResult.suggested_rewrite || '').substring(0, 2000) } }] }
                        }
                    })
                }
            );

            // ── STEP 4: Human-action gate ──
            if (reviewResult.human_action_required) {
                console.log(`⏸️  Job ${jobIdStr} requires human action — leaving in CONTENT_REVIEW_PENDING.`);
                await updateJobState(job.id, 'CONTENT_REVIEW_PENDING');
                continue;
            }

            // ── STEP 5: Route on score ──
            if (reviewResult.score < 7) {
                console.log(`⚠️  Job ${jobIdStr} scored ${reviewResult.score}/10 → REWRITE_REQUIRED.`);
                await updateJobState(job.id, 'REWRITE_REQUIRED');
                logEvent(jobIdStr, 'REVIEWING', 'REWRITE_REQUIRED', WORKER_ID, `Score: ${reviewResult.score}`);
            } else {
                console.log(`✅ Job ${jobIdStr} scored ${reviewResult.score}/10 → MEDIA_PENDING.`);
                await updateJobState(job.id, 'MEDIA_PENDING');
                logEvent(jobIdStr, 'REVIEWING', 'MEDIA_PENDING', WORKER_ID, `Score: ${reviewResult.score}`);
            }

        } catch (err) {
            const isFatal = err instanceof NotionAPIError && err.fatal;

            if (isFatal) {
                console.error(`💀 Fatal error on job ${jobIdStr}: ${err.message}`);
                await moveToDLQ(job.id, `Fatal: ${err.message}`);
                logEvent(jobIdStr, 'REVIEWING', 'DLQ_FAILED', WORKER_ID, `Fatal: ${err.message}`);
            } else {
                const newCount = await incrementRetryCount(job.id, retryCount);
                console.error(`❌ Job ${jobIdStr} failed review (attempt ${newCount}/${MAX_RETRIES}): ${err.message}`);

                if (newCount >= MAX_RETRIES) {
                    await moveToDLQ(job.id, `Exhausted ${MAX_RETRIES} retries. Last error: ${err.message}`);
                    logEvent(jobIdStr, 'REVIEWING', 'DLQ_FAILED', WORKER_ID, `Retries exhausted: ${err.message}`);
                } else {
                    await updateJobState(job.id, 'CONTENT_REVIEW_PENDING');
                    logEvent(jobIdStr, 'REVIEWING', 'CONTENT_REVIEW_PENDING', WORKER_ID, `Retry ${newCount}/${MAX_RETRIES}: ${err.message}`);
                }
            }
        }
    }

    if (reviewer.cleanup) {
        await reviewer.cleanup();
    }
}

main().catch(err => {
    console.error(`[Reviewer] Fatal Worker Error: ${err.message}`);
    process.exit(1);
});
