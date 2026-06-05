import { getJobById, claimJob, updateJobState, NOTION_HEADERS, DATABASE_ID } from './notion_helper.mjs';
import { ReviewerFactory } from './reviewer_factory.mjs';
import { logEvent } from './event_logger.mjs';

const WORKER_ID = `reviewer-worker-${process.pid}`;
const PROVIDER = process.env.REVIEWER_PROVIDER || 'gemini'; // Default to gemini

async function fetchPendingReviewJobs() {
    const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({
            filter: { property: 'Pipeline', select: { equals: 'CONTENT_REVIEW_PENDING' } }
        })
    });

    if (!res.ok) throw new Error(`Failed to query jobs: ${await res.text()}`);
    const data = await res.json();
    return data.results;
}

// Extract full page text for review
async function fetchPageBody(pageId) {
    try {
        const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, { headers: NOTION_HEADERS });
        if (!res.ok) return '';
        const data = await res.json();
        let body = '';
        for (const block of (data.results || [])) {
            const richText = block[block.type]?.rich_text || [];
            body += richText.map(t => t.plain_text).join('') + '\n';
        }
        return body.trim();
    } catch { return ''; }
}

async function main() {
    console.log(`[Worker: Reviewer] Starting... ID: ${WORKER_ID} | Provider: ${PROVIDER}`);
    const jobs = await fetchPendingReviewJobs();
    console.log(`Found ${jobs.length} pending reviews.`);

    if (jobs.length === 0) return;

    const reviewer = ReviewerFactory.create(PROVIDER);

    for (const job of jobs) {
        const jobIdStr = job.properties['Job ID']?.rich_text[0]?.plain_text || job.id;
        try {
            console.log(`\nðŸ”’ Claiming job ${jobIdStr} for Review...`);
            await claimJob(job.id, 'CONTENT_REVIEW_PENDING', WORKER_ID, 10); 
            
            const postContent = await fetchPageBody(job.id);
            const brandId = job.properties['Client Brand']?.relation?.[0]?.id || "Unknown Brand";
            
            console.log(`â³ Executing ${PROVIDER} Review...`);
            
            const reviewResult = await reviewer.review({
                id: jobIdStr,
                brand_id: brandId,
                content: postContent,
                mediaType: job.properties['Media Type']?.select?.name || "text"
            });

            // Update Notion with the review metadata
            const feedbackText = (reviewResult.issues || []).join('\n');
            const patchPayload = {
                properties: {
                    "Review Score": { number: reviewResult.score || 0 },
                    "Review Feedback": { rich_text: [{ text: { content: feedbackText.substring(0, 2000) } }] },
                    "Suggested Rewrite": { rich_text: [{ text: { content: (reviewResult.suggested_rewrite || "").substring(0, 2000) } }] }
                }
            };
            
            await fetch(`https://api.notion.com/v1/pages/${job.id}`, {
                method: 'PATCH',
                headers: NOTION_HEADERS,
                body: JSON.stringify(patchPayload)
            });

            if (reviewResult.human_action_required) {
                console.log(`â¸ï¸ Job ${jobIdStr} requires human action. Leaving in REVIEW_PENDING.`);
                // We don't advance the state if the human provider just logged the request
                await updateJobState(job.id, 'CONTENT_REVIEW_PENDING');
                continue;
            }

            if (reviewResult.score < 7) {
                console.log(`âš ï¸ Job ${jobIdStr} scored ${reviewResult.score}/10. State -> REWRITE_REQUIRED.`);
                await updateJobState(job.id, 'REWRITE_REQUIRED');
                logEvent(jobIdStr, 'CONTENT_REVIEW_PENDING', 'REWRITE_REQUIRED', WORKER_ID, `Score: ${reviewResult.score}`);
            } else {
                console.log(`âœ… Job ${jobIdStr} scored ${reviewResult.score}/10. State -> MEDIA_PENDING.`);
                await updateJobState(job.id, 'MEDIA_PENDING');
                logEvent(jobIdStr, 'CONTENT_REVIEW_PENDING', 'MEDIA_PENDING', WORKER_ID, `Score: ${reviewResult.score}`);
            }

        } catch (err) {
            console.error(`âŒ Job ${jobIdStr} failed review: ${err.message}`);
            await updateJobState(job.id, 'RETRY_PENDING');
            logEvent(jobIdStr, 'CONTENT_REVIEW_PENDING', 'RETRY_PENDING', WORKER_ID, err.message);
        }
    }

    if (reviewer.cleanup) {
        await reviewer.cleanup();
    }
}

main().catch(err => console.error(`Worker Fatal: ${err.message}`));

