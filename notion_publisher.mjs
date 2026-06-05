import path from "path";
import { fileURLToPath } from "url";
import * as dotenv from "dotenv";
import { getGHLToken, getConnectedAccounts, schedulePost } from "../../content_scheduler.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DATABASE_ID = process.env.NOTION_DATABASE_ID || "d9dfb107ab514ccfa6e7b6863ec0de2b"; 

const PLATFORM_MAP = {
    "LinkedIn": "linkedin",
    "Instagram": "instagram",
    "Facebook": "facebook",
    "X/Twitter": "twitter",
    "Google Business Profile": "google_business",
    "TikTok": "tiktok"
};

async function log(msg) {
    console.log(`[${new Date().toISOString()}] ðŸ“¡ ${msg}`);
}

async function runPublisher() {
    log(`Scanning Notion for Approved Posts...`);
    
    let response;
    try {
        const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${NOTION_API_KEY}`,
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                filter: {
                    property: "Status",
                    status: {
                        equals: "Approved"
                    }
                }
            })
        });
        
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`HTTP ${res.status}: ${errorText}`);
        }
        response = await res.json();
    } catch (err) {
        log(`âŒ Notion Fetch Failed: ${err.message}`);
        process.exit(1);
    }

    if (!response.results || response.results.length === 0) {
        log(`No Approved posts found. Yielding.`);
        process.exit(0);
    }

    log(`Found ${response.results.length} Approved posts! Preparing GHL connection...`);

    // Init GHL Token
    const token = getGHLToken();
    if (!token) {
        log("âŒ No active GHL token available. Ensure content_scheduler.mjs is authenticated.");
        process.exit(1);
    }

    // Map Accounts
    const accResp = await getConnectedAccounts(token);
    const accounts = accResp?.results?.accounts || accResp?.accounts || [];
    
    for (const page of response.results) {
        const props = page.properties;
        const platformRaw = props.Platform?.select?.name;
        const ghlPlatform = PLATFORM_MAP[platformRaw];
        
        const textBlocks = props.Topic?.title || [];
        const contentText = textBlocks.map(t => t.plain_text).join('');
        const mediaUrl = props["Media URL"]?.url || null;
        const dateStr = props.Date?.date?.start;

        log(`\n==== POST: ${page.id} ====`);
        log(`Platform: ${ghlPlatform || platformRaw}`);
        log(`Date: ${dateStr}`);
        
        if (!ghlPlatform) {
            log(`âš ï¸ Unknown platform for post. Skipping...`);
            continue;
        }

        let targetAccountId = null;
        for (const acc of accounts) {
            if (acc.platform?.toLowerCase() === ghlPlatform) {
                targetAccountId = acc.id;
                break;
            }
        }

        if (!targetAccountId) {
            log(`âŒ No GHL target account found for ${ghlPlatform}. Skipping...`);
            continue;
        }

        const postPayload = {
            id: `notion_${page.id}`,
            content: contentText,
            scheduledTime: dateStr,
            mediaUrls: mediaUrl ? [mediaUrl] : [],
            platform: ghlPlatform
        };

        log(`ðŸš€ Scheduling to GoHighLevel...`);
        const result = await schedulePost(token, postPayload, [targetAccountId]);
        
        if (result?.success || result?.postId || result?.id) {
            log(`âœ… Scheduled successfully! Updating Notion to "Scheduled"...`);
            await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
                method: "PATCH",
                headers: {
                    "Authorization": `Bearer ${NOTION_API_KEY}`,
                    "Notion-Version": "2022-06-28",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    properties: {
                        "Status": {
                            status: { name: "Scheduled" }
                        }
                    }
                })
            });
        } else {
            log(`âŒ GHL Schedule Failed: ${JSON.stringify(result)}`);
        }
    }
}

runPublisher().catch(e => {
    console.error(e);
    process.exit(1);
});

