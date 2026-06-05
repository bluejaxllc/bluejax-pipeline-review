import { createGeminiSpoofer, generateWithRefinement } from './gemini_api_spoofer.mjs';
import { EDITORIAL_CALENDAR } from './editorial_calendar.mjs';
import { pushToNotion, fetchExistingDates } from './publish_to_notion.mjs';
import { uploadMediaToCDN } from './upload_media.mjs';
import fs from "fs";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import * as readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ================================================================
// ðŸŽ¨ BlueJax Content Generator
// ================================================================
// Uses Gemini Web UI (3.1 Pro via Ultra subscription) through BrowserOS MCP.
// Multi-pass refinement: generate â†’ critique â†’ polish. No API keys.
//
// Platforms: LinkedIn, Instagram, Facebook, X/Twitter, Google Business
// Content Pillars: Multi-Niche Tech, AI & Automation, Building in Public,
//                  Client Value, Industry Insights
// ================================================================

// Local JSON legacy removed. Notion is now the single source of truth.
// Model is whatever's active in your Gemini web UI (3.1 Pro recommended)

const BRAND_VOICE = `
Eres el equipo creador de contenido de redes sociales corporativo para BlueJax, una agencia Ã©lite de tecnologÃ­a basada en MÃ©xico.

ACERCA DE BLUE JAX:
- QuÃ© hacemos: AutomatizaciÃ³n impulsada por IA, desarrollo de software a medida (mÃ³viles y web, como Face2Face), infraestructura en la nube y optimizaciÃ³n de procesos para empresas de cualquier nicho.
- Nuestra filosofÃ­a: Menos Excel y trabajo manual; mÃ¡s software de verdad y agentes de IA trabajando 24/7.
- Tono: Somos una MARCA CORPORATIVA. Hablamos con autoridad tÃ©cnica indiscutible, demostrando experiencia superior. Sin embargo, nuestro estilo incluye un HUMOR SARCÃSTICO Y DIVERTIDO: nos burlamos sutilmente de los procesos lentos, la dependencia en hojas de cÃ¡lculo y la resistencia a modernizarse.
- El contenido debe estar 100% en ESPAÃ‘OL. NO utilices lenguaje motivacional barato ni jerga vacÃ­a.

DIRECTRICES CORPORATIVAS:
- Usa "BlueJax" (junto) en el texto.
- No hables como un individuo o "fundador", siempre proyecta la voz de una organizaciÃ³n/empresa inteligente y sarcÃ¡stica.
- Usa 2-3 emojis bien colocados.
- Integra la comedia. El sarcasmo sobre "trabajar manualmente en el 2026" es muy bienvenido.
- AÃ±ade valor real hablando sobre tecnologÃ­a real, dolores de cabeza de los clientes y cÃ³mo la IA/software lo soluciona.
`;

// Pillar label lookup (maps editorial_calendar pillar keys to display names)
const PILLAR_LABELS = {
    ai_automation: "ðŸ¤– IA & AutomatizaciÃ³n",
    multi_niche_tech: "ðŸ¢ Soluciones Multi-Nicho",
    custom_apps: "ðŸ“± Apps a Medida",
    social_proof: "ðŸ“¸ Social Proof",
    cta: "âš¡ CTA & ConsultorÃ­a"
};

const PLATFORMS = [
    {
        id: "omnichannel",
        name: "Omnichannel (FB/IG/LI)",
        style: "Formato conversacional y provocativo, perfecto para B2B. EN ESPAÃ‘OL. STRICT LENGTH LIMIT: Escribe MAXIMO 1 a 2 pÃ¡rrafos cortos en total. Si escribes 3 o mÃ¡s pÃ¡rrafos, has fallado la tarea. Usa 2-3 emojis. Termina con un gancho. 4-5 hashtags corporativos.",
        time: "09:00",
        via: "ghl"
    }
];

/**
 * Get the editorial calendar entry for a given day number (1-30).
 * If dayNumber > 30, wraps around and appends a variation note.
 */
function getEditorialDay(dayNumber) {
    const idx = ((dayNumber - 1) % EDITORIAL_CALENDAR.length);
    return EDITORIAL_CALENDAR[idx];
}

export async function generateDayContent(targetDate, gem = null, existingDates = new Set(), quotas = null, dayNumber = 1, visualNotebookPath = null, brandContext = null, brandKey = "bluejax") {
    const ownSession = !gem;
    if (!gem) {
        gem = await createGeminiSpoofer(brandContext);
    }

    // Sample up to 2 images from visual notebook if available
    let imagePaths = [];
    if (visualNotebookPath && fs.existsSync(visualNotebookPath)) {
        try {
            const files = fs.readdirSync(visualNotebookPath)
                .filter(f => f.match(/\.(jpg|jpeg|png|webp)$/i))
                .map(f => join(visualNotebookPath, f));
            
            // shuffle array
            files.sort(() => 0.5 - Math.random());
            imagePaths = files.slice(0, 2);
            if (imagePaths.length > 0) {
                console.log(`ðŸ–¼ï¸ Selected visual context: ${imagePaths.map(p => p.split(/[\\/]/).pop()).join(', ')}`);
            }
        } catch (e) {
            console.log(`âš ï¸ Could not read visual notebook: ${e.message}`);
        }
    }

    const dateStr = targetDate.toISOString().split("T")[0];
    const dayName = targetDate.toLocaleDateString("en-US", { weekday: "long" });
    const editorial = getEditorialDay(dayNumber);
    const pillarLabel = PILLAR_LABELS[editorial.pillar] || editorial.pillar;
    const topic = editorial.title;

    console.log(`\nðŸ“… Day ${dayNumber}/30 â€” ${dayName}, ${dateStr}`);
    console.log(`ðŸ“Œ Pillar: ${pillarLabel}`);
    console.log(`ðŸ“ Topic: ${editorial.title}`);
    console.log(`ðŸŽ¯ Angle: ${editorial.angle.substring(0, 100)}...`);

    const posts = [];

    for (const platform of PLATFORMS) {
        console.log(`  ðŸŽ¨ ${platform.name}...`);

        // Media Type Logic: Explicit quota tracking
        let mediaType = 'image'; // default
        if (quotas) {
            if (quotas.remainingVideos > 0 && quotas.remainingImages > 0) {
                // Determine proportionality - if we have more videos to do, assign a video
                if (quotas.remainingVideos >= quotas.remainingImages) {
                    mediaType = 'video';
                } else {
                    mediaType = 'image';
                }
            } else if (quotas.remainingVideos > 0) {
                mediaType = 'video';
            } else if (quotas.remainingImages > 0) {
                mediaType = 'image';
            }

            // Decrement the selected quota
            if (mediaType === 'video') quotas.remainingVideos--;
            else quotas.remainingImages--;
        }
        
        let formatInstructions = "";
        if (mediaType === 'video') {
            formatInstructions = `Generate a TEXT-ONLY 15-second SHORT-FORM VIDEO SCRIPT concept. DO NOT generate real media.
Include:
[HOOK] - A viral hook (spoken or text-on-screen).
[GRAPHIC] - Brief text description of the graphic scene. MUST be cinematic, modern, abstract, or typography-heavy. ABSOLUTELY NO generic stock humans or people smiling at laptops.
[AUDIO] - What is being said or the music vibe.
[CAPTION] - The accompanying social media post text/caption.`;
        } else {
            formatInstructions = `Generate a TEXT-ONLY GRAPHIC POST CONCEPT. DO NOT attempt to use any media generation tools. I only want text.
Include:
[GRAPHIC] - Text description of the graphic. MUST be cinematic, modern, abstract, or typography-heavy. ABSOLUTELY NO generic stock humans or people smiling at laptops.
[CAPTION] - The accompanying social media post text/caption.`;
        }

        let visualContextInstruction = "";
        if (imagePaths.length > 0) {
            visualContextInstruction = "\nVISUAL CONTEXT (BRAND NOTEBOOK):\nI have attached images representing our brand's visual identity, latest assets, or aesthetic. USE THESE IMAGES to heavily inspire the [VISUAL] concept and the [CAPTION]. Your content MUST feel like it belongs seamlessly with these attached images.\n";
        }

        // Check for local brand JSON first
        let localBrandVoice = null;
        try {
            const localJsonPath = join(__dirname, `${brandKey}_brand.json`);
            if (fs.existsSync(localJsonPath)) {
                const localData = JSON.parse(fs.readFileSync(localJsonPath, 'utf8'));
                if (localData.instructions) {
                    localBrandVoice = localData.instructions;
                }
            }
        } catch(e) {
            console.log("Could not read local brand JSON", e.message);
        }

        // Use NotebookLM brand context if available, otherwise fall back to local JSON, then hardcoded BRAND_VOICE
        const effectiveBrandVoice = brandContext
            ? `You are a social media content creator. Use the following BRAND CONTEXT (extracted from the client's NotebookLM knowledge base) to guide your tone, services, and messaging:\n\n${brandContext}`
            : (localBrandVoice ? localBrandVoice : BRAND_VOICE);

        const prompt = `${effectiveBrandVoice}

TODAY'S EDITORIAL BRIEF:
- Date: ${dayName}, ${dateStr}
- Content Pillar: ${pillarLabel}
${brandKey !== 'bluejax' ? `\nCRITICAL INSTRUCTION: The Topic, Angle, and Hook below were originally drafted for a tech agency (BlueJax). You MUST ADAPT them entirely for your brand (${brandKey}). Keep the underlying psychological intent (e.g. social proof, overcoming objections, CTA) but change ALL specific examples, features, and names to match your brand's products and services.` : ''}

- Topic Title: ${editorial.title}
- Creative Angle: ${editorial.angle}
- Opening Hook: ${editorial.hook}

${visualContextInstruction}
- Platform: ${platform.name}
- Style: ${platform.style}
- Media Type: ${mediaType.toUpperCase()}

IMPORTANT: The hook is a STARTING POINT, not a rigid template. Adapt it to the platform's voice while keeping the core sarcasm and humor. Make the content UNIQUE and specific â€” avoid generic corporate language.
${visualContextInstruction}
${formatInstructions}
Return ONLY the raw post content (caption/script/visual concept), nothing else. No labels like "Here's your post:", just the raw content.`;

        let content = null;
        let attempt = 1;
        let prompt_to_send = prompt;

        while (!content) {
            try {
                content = await generateWithRefinement(gem, prompt_to_send, { critique: true, imagePaths });

                posts.push({
                    id: `${dateStr}_${platform.id}`,
                    date: dateStr,
                    day: dayName,
                    platform: platform.id,
                    platformName: platform.name,
                    pillar: pillarLabel,
                    topic: editorial.title,
                    editorialDay: dayNumber,
                    angle: editorial.angle,
                    mediaType: mediaType,
                    content: content,
                    scheduledTime: `${dateStr}T${platform.time}:00`,
                    status: "draft",
                    brand_id: brandKey,
                    via: platform.via,
                    ghlPostId: null,
                    createdAt: new Date().toISOString()
                });

                // Upload any available media to R2 (currently text generator skips this unless media is statically assigned)
                let mediaUrl = null;
                const newPost = posts[posts.length - 1];
                if (newPost.mediaPath) {
                    mediaUrl = await uploadMediaToCDN(newPost.mediaPath, 'bluejax_pipeline', 'cms');
                }
                
                // Native push to Notion mapping text, media, and status natively
                const pageId = await pushToNotion(newPost, mediaUrl);
                if (pageId) {
                    // Mark as synced locally
                    newPost.notionPageId = pageId;
                }

                console.log(`    âœ… ${content.substring(0, 80)}...`);
            } catch (e) {
                console.log(`    âŒ Attempt ${attempt} failed: ${e.message?.substring(0, 100)}`);
                
                if (imagePaths && imagePaths.length > 0) {
                    console.log(`    âš ï¸ Stripping visual context to bypass possible image safety blocks...`);
                    // Create a modified prompt without visualContextInstruction for the retry
                    const strippedPrompt = prompt.replace(visualContextInstruction, "");
                    prompt_to_send = strippedPrompt;
                    imagePaths = [];
                }
                
                console.log(`    â³ Retrying in 15 seconds (infinite fallback)...`);
                await new Promise(r => setTimeout(r, 15000));
                // NOTE: Do NOT navigate here â€” sendPrompt with newConversation:true
                // will handle creating a fresh page on the next attempt
                attempt++;
            }
        }

        // Small delay between prompts to be respectful to the browser session
        await new Promise(r => setTimeout(r, 2000));
    }

    if (ownSession) {
        try { await gem.close(); } catch {}
    }
    return posts;
}

// JSON calendar functions removed. Notion Kanban acts as the single datastore.

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

// â”€â”€â”€ CLI Entry Point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
    const args = process.argv.slice(2);
    const brandArg = args.find(a => a.startsWith('--brand='))?.split('=')[1] || 'bluejax';
    const numArgs = args.filter(a => !a.startsWith('--'));
    
    const daysAhead = parseInt(numArgs[0]) || 1;
    // Format: node script.js <days> <videos> <images> <visual_notebook_folder_name> <notebooklm_url>
    const visualFolder = numArgs[3] || null;
    const notebookUrl = numArgs[4] || null;

    let visualNotebookPath = null;
    if (visualFolder) {
        visualNotebookPath = join(__dirname, "..", "..", "calendar_assets", visualFolder, "visual_notebook");
    }

    console.log(`ðŸŽ¨ ${brandArg.toUpperCase()} Content Generator (Browser CDP â€” Gemini 3.1 Pro)`);
    
    // Explicit Quotas
    console.log("\n--- Media Quota Allocation ---");
    let targetVideos = parseInt(numArgs[1]) ?? 2;
    let targetImages = parseInt(numArgs[2]) ?? 33;
    
    // Auto-fallback because NaN comes through if undefined
    if (isNaN(targetVideos)) targetVideos = 2;
    if (isNaN(targetImages)) targetImages = 33;

    console.log(`Auto-selected Allocation: ${targetVideos} Videos, ${targetImages} Images.`);
    rl.close();

    const totalPostsNeeded = daysAhead * 5; // 5 platforms
    if (targetVideos + targetImages < totalPostsNeeded) {
        console.log(`\nâš ï¸ Note: You asked for ${targetVideos + targetImages} total media, but we are generating posts for ${daysAhead} days x 5 platforms = ${totalPostsNeeded} posts.`);
        console.log(`The remaining will default to images.`);
    }

    const quotas = { remainingVideos: targetVideos, remainingImages: targetImages };

    console.log(`\nGenerating content for next ${daysAhead} day(s)`);

    // NotebookLM context skipped when using Playwright fallback
    let brandContext = null;
    if (notebookUrl) {
        console.log(`\nðŸ“ (NotebookLM skipped in Playwright fallback mode)`);
    }

    const gem = await createGeminiSpoofer(brandContext);
    
    // Connect to Notion to fetch state instead of reading a local JSON file
    const existingDateList = await fetchExistingDates(brandArg);
    const existingDates = new Set(existingDateList);
    console.log(`ðŸ“¡ Retrieved ${existingDates.size} existing dates from Notion.`);

    try {
        for (let d = 1; d <= daysAhead; d++) {
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + d);
            const dateStr = targetDate.toISOString().split("T")[0];

            if (existingDates.has(dateStr)) {
                console.log(`â­ï¸ Content already exists in Notion for ${dateStr}, skipping`);
                continue;
            }

            await generateDayContent(targetDate, gem, existingDates, quotas, d, visualNotebookPath, brandContext, brandArg);
        }

        console.log(`\nðŸ“¡ Sync complete. Posts pushed directly to Notion Kanban.`);
    } finally {
        if (gem && typeof gem.close === 'function') await gem.close();
    }
}

// Run if called directly
if (process.argv[1]?.endsWith("content_generator.mjs")) {
    main().catch(e => console.error("ERROR:", e.message));
}

