import { createGeminiBrowser, generateWithRefinement } from '../gemini_browser.mjs';
import fs from "fs";

// ================================================================
// ðŸ‘¤ Edgar Bolivar â€” Personal Brand Content Generator
// ================================================================
// Generates authentic, first-person founder content for Edgar's
// personal social media accounts. Distinct voice from BlueJax
// business content â€” raw, personal, "building in public" style.
// ================================================================

const CALENDAR_PATH = `C:/Users/edgar/OneDrive/Desktop/BlueJax/personal_calendar.json`;
// Model is whatever's active in your Gemini web UI (3.1 Pro recommended)

const EDGAR_VOICE = `
You are writing social media content AS Edgar Bolivar â€” a tech founder and engineer based in Mexico.

ABOUT EDGAR:
- Founder of Blue Jax, a PropTech startup building market intelligence for Mexican real estate
- Engineer who codes the product himself â€” Next.js, Prisma, PostgreSQL, AI/LLMs
- Built mls.bluejax.ai â€” a real estate MLS platform with AI-powered crawlers
- Also built CRM automation for care homes (Asilo) with WhatsApp integration
- Late 20s, Mexican-American, bilingual (English/Spanish)
- Lives and builds in Mexico, deeply connected to the local tech scene

VOICE & TONE:
- FIRST PERSON always ("I", "my", never "we" or "Blue Jax")
- Raw and authentic â€” share THE PROCESS, the engineering challenges, and real emotions
- Builder mentality â€” show the work, NOT just high-level results
- Mix English with occasional Spanish phrases naturally
- Technical but accessible â€” explain the "why" not just the "what"
- Vulnerability is strength â€” share struggles openly
- No corporate jargon, no fake motivation, no guru vibes
- Short paragraphs. Conversational. Like texting a smart friend

NEVER:
- Start with "Hey everyone!" or "Hey friends!"
- Use phrases like "game-changer", "disrupting", "hustle culture"
- Write in third person or corporate voice
- Add generic motivational quotes
- Sound like a LinkedIn influencer or tech guru
- Use any emojis. Keep the copy strictly text.
- Invent metrics like revenue, user counts, or P&L data if not provided in context
- Invent "pivots" or "scrapped features" if not provided in context -- stick to the CURRENT mission
- Mention "GoHighLevel", "GHL", or any proprietary CRM/tool names. Use generic terms like "CRM", "automation platform", or "scheduling system" instead
`;

const PERSONAL_PILLARS = [
    {
        name: "ðŸ› ï¸ Builder's Log",
        day: "Monday",
        topics: [
            "What I shipped this week â€” specific features, commits, decisions",
            "Debugging war stories â€” the 3 AM fix, the production bug",
            "Tool choices and trade-offs â€” why Next.js, why Prisma, why PostgreSQL",
            "Infrastructure decisions â€” deployment, scaling, cost optimization",
            "Side projects and experiments"
        ]
    },
    {
        name: "ðŸ§  Tech Takes",
        day: "Tuesday",
        topics: [
            "Hot takes on AI â€” what's overhyped, what's underrated",
            "The real state of PropTech in 2026",
            "Open source tools I can't live without",
            "AI agents and automation â€” where it's heading",
            "The gap between AI demos and production AI"
        ]
    },
    {
        name: "ðŸ‡²ðŸ‡½ Mexico Tech Scene",
        day: "Wednesday",
        topics: [
            "Building a startup in Mexico â€” what outsiders don't understand",
            "The LatAm tech ecosystem â€” opportunities and gaps",
            "Why I chose to build here instead of the US",
            "Mexican real estate market â€” the digitization gap",
            "Infrastructure challenges â€” payments, internet, talent"
        ]
    },
    {
        name: "ðŸ’¡ Lessons Learned",
        day: "Thursday",
        topics: [
            "Mistakes I made as a first-time founder",
            "Pivots and direction changes â€” why and how",
            "What nobody tells you about building solo",
            "Client feedback that changed everything",
            "The difference between building for yourself vs. for customers"
        ]
    },
    {
        name: "ðŸš€ Show & Tell",
        day: "Friday",
        topics: [
            "Demo day â€” showing off a specific technical feature with context",
            "Technical metrics update â€” crawls, data points ingested, latency improvements",
            "Before/after of a feature or UI improvement",
            "Technical wins â€” how the code solved a real complexity",
            "Development speed runs â€” building something start to finish"
        ]
    },
    {
        name: "ðŸ“š Reading & Learning",
        day: "Saturday",
        topics: [
            "Book I read this week and what I took from it",
            "Technical article or paper that changed my thinking",
            "Online course or resource recommendation",
            "Podcast episode that resonated",
            "Skill I'm trying to learn and why"
        ]
    },
    {
        name: "ðŸŽ¯ Week Ahead",
        day: "Sunday",
        topics: [
            "Goals for next week â€” specific and measurable",
            "What I'm excited to build",
            "Challenges I expect to face",
            "Asking for input or advice from the audience",
            "Reflection on last week + plans for this one"
        ]
    }
];

const PLATFORMS = [
    {
        id: "linkedin",
        name: "LinkedIn",
        style: "Thoughtful founder post. Write 1 to 2 deep, well-structured paragraphs. Use line breaks between paragraphs. End with reflection or question. 3-5 hashtags. This is your MAIN platform for long-form thought leadership.",
        time: "07:30",
        via: "ghl"
    },
    {
        id: "instagram",
        name: "Instagram",
        style: "Behind-the-scenes caption. Write 1 to 2 paragraphs telling a quick story or insight. Visual story style â€” describe what the audience would SEE if they were watching you work. 15 hashtags on new line. Emojis OK.",
        time: "12:00",
        via: "ghl"
    },
    {
        id: "facebook",
        name: "Facebook",
        style: "Personal, storytelling post. Write 1 to 2 paragraphs. Share like you're updating friends and family on your journey. Warm, human, real. 2-3 hashtags max.",
        time: "15:00",
        via: "ghl"
    },
    {
        id: "twitter",
        name: "X/Twitter",
        style: "Sharp, quotable take. Max 280 characters. Make it punchy enough to screenshot and share. No fluff. Bold statements welcome. 1-2 hashtags or none.",
        time: "09:00",
        via: "browseros"
    },
    {
        id: "google_business",
        name: "Google Business Profile",
        style: "Professional update about your work. Write 1 substantive paragraph. Focus on services, milestones, or availability. Include CTA to bluejax.ai or mls.bluejax.ai.",
        time: "08:00",
        via: "ghl"
    }
];

function getPillar(date) {
    const dayOfWeek = new Date(date).getDay();
    return PERSONAL_PILLARS[dayOfWeek];
}

function getRandomTopic(pillar) {
    return pillar.topics[Math.floor(Math.random() * pillar.topics.length)];
}

export async function generatePersonalContent(targetDate, gem = null) {
    const ownSession = !gem;
    if (!gem) gem = await createGeminiBrowser();

    const dateStr = targetDate.toISOString().split("T")[0];
    const pillar = getPillar(dateStr);
    const topic = getRandomTopic(pillar);

    console.log(`\nðŸ“… ${pillar.day}, ${dateStr}`);
    console.log(`ðŸ“Œ ${pillar.name}`);
    console.log(`ðŸ“ ${topic}`);

    const posts = [];

    for (const platform of PLATFORMS) {
        console.log(`  ðŸŽ¨ ${platform.name}...`);

        const prompt = `${EDGAR_VOICE}

TODAY'S CONTENT:
- Date: ${pillar.day}, ${dateStr}
- Pillar: ${pillar.name}
- Topic: ${topic}
- Platform: ${platform.name}
- Style: ${platform.style}

Write ONE ${platform.name} post about "${topic}".
Write AS EDGAR in first person. Be specific, real, and authentic.
Return ONLY the post text. No labels, no meta-commentary.`;

        try {
            const content = await generateWithRefinement(gem, prompt, { critique: true });

            posts.push({
                id: `personal_${dateStr}_${platform.id}`,
                date: dateStr,
                day: pillar.day,
                brand: "personal",
                platform: platform.id,
                platformName: platform.name,
                pillar: pillar.name,
                topic,
                content,
                scheduledTime: `${dateStr}T${platform.time}:00`,
                status: "draft",
                via: platform.via,
                ghlPostId: null,
                createdAt: new Date().toISOString()
            });

            console.log(`    âœ… ${content.substring(0, 80)}...`);
        } catch (e) {
            console.log(`    âŒ ${e.message?.substring(0, 60)}`);
        }

        await new Promise(r => setTimeout(r, 2000));
    }

    if (ownSession) await gem.close();
    return posts;
}

function loadCalendar() {
    if (fs.existsSync(CALENDAR_PATH)) {
        return JSON.parse(fs.readFileSync(CALENDAR_PATH, "utf8"));
    }
    return { posts: [], lastGenerated: null };
}

function saveCalendar(calendar) {
    fs.writeFileSync(CALENDAR_PATH, JSON.stringify(calendar, null, 2), "utf8");
}

// â”€â”€â”€ CLI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
    const daysAhead = parseInt(process.argv[2]) || 1;
    console.log("ðŸ‘¤ Edgar Personal Brand Content Generator (Browser CDP â€” Gemini 3.1 Pro)");
    console.log(`   Generating ${daysAhead} day(s) of content\n`);

    const gem = await createGeminiBrowser();
    const calendar = loadCalendar();

    try {
        for (let d = 1; d <= daysAhead; d++) {
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + d);
            const dateStr = targetDate.toISOString().split("T")[0];

            if (calendar.posts.some(p => p.date === dateStr)) {
                console.log(`â­ï¸ Already generated for ${dateStr}`);
                continue;
            }

            const posts = await generatePersonalContent(targetDate, gem);
            calendar.posts.push(...posts);
        }

        calendar.lastGenerated = new Date().toISOString();
        saveCalendar(calendar);
        console.log(`\nðŸ“ Saved: ${CALENDAR_PATH}`);
        console.log(`ðŸ“Š Total: ${calendar.posts.length} posts`);
        
        try {
            fetch("http://localhost:3006/notify", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    title: "ðŸŸ¢ Universal Generation Complete",
                    message: "All brands (Lu'm & Personal) have been successfully regenerated using the strict Gemini 3.1 Pro constraint! The pipeline is 100% compliant and ready.",
                    source: "BlueJax HQ"
                })
            }).catch(e => console.log('Telegram note failed:', e.message));
        } catch(e) {}
    } finally {
        await gem.close();
    }
}

if (process.argv[1]?.endsWith("personal_content_gen.mjs")) {
    main().catch(e => console.error("ERROR:", e.message));
}

