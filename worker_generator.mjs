import { createGeminiSpoofer, generateWithRefinement } from './gemini_api_spoofer.mjs';
import { EDITORIAL_CALENDAR } from './editorial_calendar.mjs';
import { pushToNotion } from './publish_to_notion.mjs';
import { getJobById } from './notion_helper.mjs';

const PILLAR_LABELS = {
    ai_automation: "ðŸ¤– IA & AutomatizaciÃ³n",
    multi_niche_tech: "ðŸ¢ Soluciones Multi-Nicho",
    custom_apps: "ðŸ“± Apps a Medida",
    social_proof: "ðŸ“¸ Social Proof",
    cta: "âš¡ CTA & ConsultorÃ­a"
};

const BRAND_VOICE = `Eres el equipo creador de contenido de redes sociales corporativo para BlueJax... (voz sarcÃ¡stica y autoritaria).`;

function getEditorialDay(dayNumber) {
    const idx = ((dayNumber - 1) % EDITORIAL_CALENDAR.length);
    return EDITORIAL_CALENDAR[idx];
}

async function main() {
    const args = process.argv.slice(2);
    const brandArg = args.find(a => a.startsWith('--brand='))?.split('=')[1] || 'bluejax';
    const daysAhead = parseInt(args.find(a => !a.startsWith('--'))) || 1;

    console.log(`[Worker: Generator] Starting draft generation for ${daysAhead} days (${brandArg})`);

    const gem = await createGeminiSpoofer(null);

    try {
        for (let d = 1; d <= daysAhead; d++) {
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + d);
            const dateStr = targetDate.toISOString().split("T")[0];
            const dayName = targetDate.toLocaleDateString("en-US", { weekday: "long" });
            const jobId = `${brandArg}_${dateStr}_omnichannel`;

            // 1. Idempotency Check
            const existingJob = await getJobById(jobId);
            if (existingJob) {
                console.log(`â­ï¸ [${jobId}] Already exists in Notion. Skipping.`);
                continue;
            }

            console.log(`\nâ³ [${jobId}] Generating Draft...`);
            
            const editorial = getEditorialDay(d);
            const pillarLabel = PILLAR_LABELS[editorial.pillar] || editorial.pillar;
            
            // Temporary media randomizer (until Media Worker takes over)
            const mediaType = Math.random() > 0.5 ? 'video' : 'image';

            let formatInstructions = mediaType === 'video' 
                ? `Generate a TEXT-ONLY 15-second SHORT-FORM VIDEO SCRIPT concept. Include [HOOK], [GRAPHIC], [AUDIO], and [CAPTION].`
                : `Generate a TEXT-ONLY GRAPHIC POST CONCEPT. Include [GRAPHIC] and [CAPTION].`;

            const prompt = `${BRAND_VOICE}
TODAY'S EDITORIAL BRIEF:
- Date: ${dayName}, ${dateStr}
- Content Pillar: ${pillarLabel}
- Topic Title: ${editorial.title}
- Creative Angle: ${editorial.angle}
- Platform: Omnichannel (FB/IG/LI)
- Media Type: ${mediaType.toUpperCase()}
${formatInstructions}
Return ONLY the raw post content.`;

            // 2. Generate Draft
            const content = await generateWithRefinement(gem, prompt, { critique: false }); // Fast pass, reviewer does critique
            
            const post = {
                id: jobId,
                date: dateStr,
                platform: "omnichannel",
                pillar: pillarLabel,
                topic: editorial.title,
                mediaType: mediaType,
                content: content,
                status: "DRAFT_CREATED", // Explicit State
                brand_id: brandArg
            };

            // 3. Push to Queue
            await pushToNotion(post);
            console.log(`âœ… [${jobId}] Draft Created -> Pushed to CONTENT_REVIEW_PENDING queue.`);
        }
    } finally {
        await gem.close();
    }
}

main().catch(err => console.error(`Worker Failed: ${err.message}`));

