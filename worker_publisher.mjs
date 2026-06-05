import { getJobById, claimJob, updateJobState, NOTION_HEADERS, DATABASE_ID } from './notion_helper.mjs';
import { logEvent } from './event_logger.mjs';

const WORKER_ID = `publisher-worker-${process.pid}`;

async function fetchApprovedJobs() {
    const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({
            filter: { property: 'Pipeline', select: { equals: 'APPROVED' } }
        })
    });

    if (!res.ok) throw new Error(`Failed to query jobs: ${await res.text()}`);
    const data = await res.json();
    return data.results;
}

// Extract full page text
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

async function publishToSocialMedia(jobId, platform, mediaUrl, content) {
    console.log(`[Publisher API] ðŸš€ Initiating push for job ${jobId} to ${platform}`);
    // MOCK: In production, hook up Facebook/Instagram Playwright CDP scripts here
    return new Promise((resolve) => {
        setTimeout(() => {
            console.log(`[Publisher API] âœ… Successfully posted to ${platform}!`);
            resolve(true);
        }, 2000);
    });
}

async function main() {
    console.log(`[Worker: Publisher] Starting... ID: ${WORKER_ID}`);
    const jobs = await fetchApprovedJobs();
    console.log(`Found ${jobs.length} APPROVED jobs ready for publishing.`);

    if (jobs.length === 0) return;

    for (const job of jobs) {
        const jobIdStr = job.properties['Job ID']?.rich_text[0]?.plain_text || job.id;
        try {
            console.log(`\nðŸ”’ Claiming job ${jobIdStr} for Publishing...`);
            // Claim job for 10 minutes to prevent duplicate publishing
            await claimJob(job.id, 'APPROVED', WORKER_ID, 10); 
            
            const postContent = await fetchPageBody(job.id);
            const platform = job.properties['Platform']?.select?.name || "Unknown";
            const mediaUrl = job.properties['Media URL']?.url || null;

            await publishToSocialMedia(jobIdStr, platform, mediaUrl, postContent);

            // Transition to PUBLISHED
            // Note: If 'Published' is not in schema, update_notion_schema must include it. 
            // Our schema has 'Published' (capital P). We use that.
            await updateJobState(job.id, 'Published');
            logEvent(jobIdStr, 'APPROVED', 'Published', WORKER_ID, `Published to ${platform}`);
            console.log(`âœ… Job ${jobIdStr} published. State -> Published.`);

        } catch (err) {
            console.error(`âŒ Job ${jobIdStr} failed to publish: ${err.message}`);
            // Push to Dead Letter Queue (FAILED) since publishing should not infinitely retry automatically if API auth fails
            await updateJobState(job.id, 'FAILED');
            logEvent(jobIdStr, 'APPROVED', 'FAILED', WORKER_ID, `Publish Error: ${err.message}`);
        }
    }
}

main().catch(err => console.error(`Worker Fatal: ${err.message}`));

