import { NOTION_HEADERS, DATABASE_ID } from './notion_helper.mjs';

async function checkDeadLetterQueue() {
    console.log(`[DLQ Monitor] Checking for failed jobs...`);

    const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: NOTION_HEADERS,
        body: JSON.stringify({
            filter: { property: 'Pipeline', select: { equals: 'FAILED' } }
        })
    });

    if (!res.ok) throw new Error(`Failed to query jobs: ${await res.text()}`);
    const data = await res.json();
    const jobs = data.results;

    if (jobs.length === 0) {
        console.log(`âœ… Dead Letter Queue is empty. No failed jobs.`);
        return;
    }

    console.log(`ðŸš¨ ALERT: Found ${jobs.length} failed jobs in the Dead Letter Queue!`);
    console.log(`========================================================`);
    
    for (const job of jobs) {
        const jobIdStr = job.properties['Job ID']?.rich_text[0]?.plain_text || job.id;
        const brandId = job.properties['Client Brand']?.relation?.[0]?.id || "Unknown Brand";
        const platform = job.properties['Platform']?.select?.name || "Unknown Platform";
        
        console.log(`- Job ID: ${jobIdStr}`);
        console.log(`  Brand: ${brandId}`);
        console.log(`  Platform: ${platform}`);
        console.log(`  URL: ${job.url}`);
        console.log(`--------------------------------------------------------`);
    }

    console.log(`\nPlease review these jobs in Notion. Change their status to RETRY_PENDING to re-queue them.`);
}

checkDeadLetterQueue().catch(err => console.error(`[DLQ Monitor] Fatal error: ${err.message}`));

