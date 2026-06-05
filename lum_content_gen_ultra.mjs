import { createGeminiBrowser, generateWithRefinement } from './gemini_browser.mjs';
import { EDITORIAL_CALENDAR } from './editorial_calendar.mjs';

// ================================================================
// â˜• Lu'm Coffee Content Generator (n8n Webhook Sync)
// ================================================================

const BRAND_VOICE = `
You are the social media content creator for Lu'm Coffee.

ABOUT LU'M COFFEE:
- We sell natural, organic coffee straight from the mountains of Chiapas, Mexico.
- Target Audience: B2B Coffee Shop Owners and B2C everyday coffee lovers.
- Brand Voice: Humorous and authoritative, but also a little bit elegant. We know coffee better than anyone, we source it perfectly, and we have a sleek, premium vibe, but we aren't afraid to make a joke.
- Key CTA: "Buy your coffee", steering people to purchase our organic beans directly.
- Language: 100% SPANISH.
`;

const PLATFORMS = [
    { id: "instagram", name: "Instagram", style: "Elegant but witty. EN ESPAÃ‘OL. 150-300 chars, emojis, 10-15 hashtags.", time: "10:00" },
    { id: "facebook", name: "Facebook", style: "Conversational, B2C focused. EN ESPAÃ‘OL. 200-400 chars. 2-3 hashtags.", time: "12:00" },
    { id: "linkedin", name: "LinkedIn", style: "B2B focused for coffee shop owners. Authoritative. EN ESPAÃ‘OL. 300-600 chars.", time: "08:00" }
];

const WEBHOOK_URL = 'http://localhost:5678/webhook/lum-coffee-notion-sync';

async function pushToN8n(post) {
    try {
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(post)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`    ðŸ“¡ Successfully pushed to n8n webhook`);
    } catch (e) {
        console.log(`    âš ï¸ Failed to push to n8n: ${e.message}`);
    }
}

async function main() {
    console.log("â˜• Lu'm Coffee Content Generator (Browser CDP â€” Gemini 3.1 Pro)");
    
    // Hardcoded Quotas based on onboarding wizard
    const totalPosts = 60;
    const targetVideos = 4;
    const targetImages = 56;
    
    const quotas = { remainingVideos: targetVideos, remainingImages: targetImages };
    console.log(`\nAllocation: ${targetVideos} Videos, ${targetImages} Images.`);

    const gem = await createGeminiBrowser();
    
    try {
        let postCount = 0;
        let dayCounter = 1;
        
        // Loop until we hit 60 posts
        while (postCount < totalPosts) {
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + dayCounter);
            const dateStr = targetDate.toISOString().split("T")[0];
            const dayName = targetDate.toLocaleDateString("en-US", { weekday: "long" });

            const editorialIdx = ((dayCounter - 1) % EDITORIAL_CALENDAR.length);
            const editorial = EDITORIAL_CALENDAR[editorialIdx];

            for (const platform of PLATFORMS) {
                if (postCount >= totalPosts) break;

                let mediaType = 'image';
                if (quotas.remainingVideos > 0 && quotas.remainingImages > 0) {
                    mediaType = (quotas.remainingVideos >= quotas.remainingImages) ? 'video' : 'image';
                } else if (quotas.remainingVideos > 0) {
                    mediaType = 'video';
                } else if (quotas.remainingImages > 0) {
                    mediaType = 'image';
                }

                if (mediaType === 'video') quotas.remainingVideos--;
                else quotas.remainingImages--;

                let formatInstructions = mediaType === 'video' 
                    ? `Generate a 15-second SHORT-FORM VIDEO SCRIPT.\nInclude:\n[HOOK]\n[VISUAL]\n[AUDIO]\n[CAPTION]`
                    : `Generate an IMAGE/BROCHURE POST CONCEPT.\nInclude:\n[VISUAL]\n[CAPTION]`;

                const prompt = `${BRAND_VOICE}\n\nTODAY'S EDITORIAL BRIEF:\n- Date: ${dayName}, ${dateStr}\n- Topic: ${editorial.title}\n- Angle: ${editorial.angle}\n- Platform: ${platform.name}\n- Style: ${platform.style}\n- Media Type: ${mediaType.toUpperCase()}\n\n${formatInstructions}\nReturn ONLY the raw post content.`;

                console.log(`\nGenerating Post ${postCount + 1}/${totalPosts} (${platform.name} - ${mediaType.toUpperCase()})...`);
                
                let success = false;
                let content = null;
                while (!success) {
                    try {
                        if (!content) {
                            content = await generateWithRefinement(gem, prompt, { critique: true });
                        }
                        const post = {
                            id: `lum_${dateStr}_${platform.id}`,
                            date: dateStr,
                            platform: platform.id,
                            platformName: platform.name,
                            mediaType: mediaType,
                            content: content,
                            scheduledTime: `${dateStr}T${platform.time}:00`,
                            status: "draft",
                            brand: "lum_coffee"
                        };

                        const res = await fetch(WEBHOOK_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(post)
                        });
                        if (!res.ok) throw new Error(`Webhook returned HTTP ${res.status}`);
                        
                        console.log(`    ðŸ“¡ Successfully pushed to n8n webhook`);
                        postCount++;
                        console.log(`    âœ… Content generated and routed.`);
                        success = true;
                    } catch (e) {
                        console.log(`    âŒ Attempt failed: ${e.message}. Retrying in 10s...`);
                        await new Promise(r => setTimeout(r, 10000));
                    }
                }
            }
            dayCounter++;
        }
        console.log(`\nðŸŽ‰ Campaign generation finished! 60 posts sent to n8n.`);
    } finally {
        if (gem && typeof gem.close === 'function') await gem.close();
    }
}

main().catch(e => console.error("ERROR:", e.message));

