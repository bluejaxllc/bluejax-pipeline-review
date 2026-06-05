import 'dotenv/config';
import fs from "fs";
import { spawn } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ================================================================
// ðŸš€ BlueJax Daily Social Media Pipeline
// ================================================================
// Single entry point that orchestrates the entire daily social stack:
//   1. Generate content (Gemini â†’ calendar JSON) for all brands
//   2. Schedule posts via GHL API (all brands, pipeline-stage-gated)
//   3. Run growth actions via BrowserOS (connects/follows)
//
// Usage:
//   node daily_pipeline.mjs              Full pipeline
//   node daily_pipeline.mjs --dry-run    Skip growth actions
//   node daily_pipeline.mjs --content    Content gen only
//   node daily_pipeline.mjs --growth     Growth actions only
// ================================================================

const BASE = `C:/Users/edgar/OneDrive/Desktop/BlueJax`;
const LOG_DIR = `${BASE}/logs`;
const TELEGRAM_URL = "https://telegram-bridge-production-d0cb.up.railway.app/api/notify";
const TELEGRAM_KEY = process.env.TELEGRAM_KEY; // sanitized for public review;

function now() { return new Date().toISOString().replace('T', ' ').substring(0, 19); }
function log(msg) { console.log(`[${now()}] ${msg}`); }

async function telegram(title, message) {
    try {
        await fetch(TELEGRAM_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TELEGRAM_KEY}` },
            body: JSON.stringify({ title, message, source: "Social CMS" })
        });
    } catch { /* silent */ }
}

function runScript(scriptPath, args = []) {
    return new Promise((resolve, reject) => {
        log(`  â–¶ Running: node ${scriptPath} ${args.join(' ')}`);
        const child = spawn("node", [scriptPath, ...args], {
            cwd: BASE,
            env: { ...process.env },
            stdio: "pipe"
        });

        let output = "";
        child.stdout.on("data", (d) => {
            const text = d.toString();
            output += text;
            process.stdout.write(text);
        });
        child.stderr.on("data", (d) => {
            output += d.toString();
            process.stderr.write(d);
        });
        child.on("close", (code) => {
            resolve({ code, output });
        });
        child.on("error", (e) => {
            reject(e);
        });
    });
}

import http from "http";

async function isBrowserOSRunning() {
    return new Promise((resolve) => {
        const req = http.get("http://127.0.0.1:9200/mcp", { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
            resolve(res.statusCode === 200);
            res.resume();
        });
        req.on("error", () => resolve(false));
        req.setTimeout(2000, () => {
            req.destroy();
            resolve(false);
        });
    });
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const contentOnly = args.includes("--content");
    const growthOnly = args.includes("--growth");

    log("ðŸš€ BlueJax Daily Social Media Pipeline");
    log(`   Mode: ${dryRun ? 'DRY RUN' : contentOnly ? 'CONTENT ONLY' : growthOnly ? 'GROWTH ONLY' : 'FULL PIPELINE'}`);
    await telegram("Starting: Daily Social Pipeline", `ðŸš€ Pipeline starting (${dryRun ? 'dry run' : 'full'} mode)`);

    const results = { activityGen: null, contentGen: null, personalGen: null, scheduler: null, growth: null };
    const errors = [];

    // â”€â”€â”€ Phase -1: Refresh GHL Token â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log("\nâ•â•â• ðŸ”‘ Phase -1: GHL Token Refresh â•â•â•");
    try {
        const tokenResult = await runScript(`${BASE}/ghl_token_updater.mjs`);
        if (tokenResult.code === 0) {
            log("  âœ… GHL token refreshed");
            // Reload .env into current process
            const envContent = fs.readFileSync(`${BASE}/.env`, 'utf8');
            for (const line of envContent.split('\n')) {
                const m = line.match(/^([^#=]+)=(.+)$/);
                if (m) process.env[m[1].trim()] = m[2].trim();
            }
        } else {
            log("  âš ï¸ Token refresh failed (will attempt with existing token)");
        }
    } catch (e) {
        log(`  âš ï¸ Token refresh error: ${e.message}`);
    }

    // â”€â”€â”€ Phase 0: Activity â†’ Personal Brand Content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!growthOnly) {
        log("\nâ•â•â• ðŸ§  Phase 0: Activity Content (Brain Scanner) â•â•â•");
        try {
            log("  ðŸ” Scanning agent activity for personal brand...");
            results.activityGen = await runScript(`${BASE}/activity_content_gen.mjs`);
            if (results.activityGen.code !== 0) errors.push("Activity content gen failed");
        } catch (e) {
            errors.push(`Activity gen error: ${e.message}`);
            log(`  âŒ ${e.message}`);
        }
    }

    // â”€â”€â”€ Phase 1: Generate Content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!growthOnly) {
        log("\nâ•â•â• ðŸ“ Phase 1: Content Generation â•â•â•");

        try {
            log("  ðŸŽ¨ BlueJax brand content...");
            results.contentGen = await runScript(`${BASE}/content_generator.mjs`, ["1"]);
            if (results.contentGen.code !== 0) errors.push("BlueJax content gen failed");
        } catch (e) {
            errors.push(`Content gen error: ${e.message}`);
            log(`  âŒ ${e.message}`);
        }

        try {
            log("  ðŸ‘¤ Personal brand content...");
            results.personalGen = await runScript(`${BASE}/personal_content_gen.mjs`, ["1"]);
            if (results.personalGen.code !== 0) errors.push("Personal content gen failed");
        } catch (e) {
            errors.push(`Personal gen error: ${e.message}`);
            log(`  âŒ ${e.message}`);
        }
    }

    // â”€â”€â”€ Phase 1.3: Generate Images for Posts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!growthOnly && !dryRun) {
        log("\nâ•â•â• ðŸŽ¨ Phase 1.3: Image Generation (Nano Banana) â•â•â•");
        try {
            results.imageGen = await runScript(`${BASE}/personal_image_gen.mjs`);
            if (results.imageGen.code !== 0) errors.push("Image generation failed");
        } catch (e) {
            errors.push(`Image gen error: ${e.message}`);
            log(`  âŒ ${e.message}`);
        }
    }

    // â”€â”€â”€ Phase 1.5: Auto-Promote Generated Posts to "ready" â”€â”€
    if (!growthOnly && !dryRun) {
        log("\nâ•â•â• âœ… Phase 1.5: Auto-Promote Posts to Ready â•â•â•");
        try {
            const pipelineStatePath = `${BASE}/pipeline_state.json`;
            let pipelineState = {};
            if (fs.existsSync(pipelineStatePath)) {
                pipelineState = JSON.parse(fs.readFileSync(pipelineStatePath, "utf8"));
            }

            // Auto-promote personal calendar posts
            const calendars = [
                { name: "personal", path: `${BASE}/personal_calendar.json` },
                { name: "bluejax",  path: `${BASE}/content_calendar.json` },
            ];

            let promoted = 0;
            for (const cal of calendars) {
                if (!fs.existsSync(cal.path)) continue;
                const data = JSON.parse(fs.readFileSync(cal.path, "utf8"));
                for (const post of (data.posts || [])) {
                    if (post.status === "draft" && post.via === "ghl" && !pipelineState[post.id]) {
                        pipelineState[post.id] = "ready";
                        promoted++;
                    }
                }
            }

            fs.writeFileSync(pipelineStatePath, JSON.stringify(pipelineState, null, 2), "utf8");
            log(`  âœ… Promoted ${promoted} post(s) to "ready" state`);
        } catch (e) {
            errors.push(`Auto-promote error: ${e.message}`);
            log(`  âŒ ${e.message}`);
        }
    }

    // â”€â”€â”€ Phase 2: Schedule Posts via GHL (All Brands) â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!growthOnly) {
        log("\nâ•â•â• ðŸ“¤ Phase 2: Post Scheduling â€” All Brands (GHL) â•â•â•");

        try {
            const schedulerArgs = dryRun ? ["--dry-run"] : [];
            results.scheduler = await runScript(`${BASE}/content_scheduler.mjs`, schedulerArgs);
            if (results.scheduler.code !== 0) errors.push("GHL scheduling failed");
        } catch (e) {
            errors.push(`Scheduler error: ${e.message}`);
            log(`  âŒ ${e.message}`);
        }
    }

    // â”€â”€â”€ Phase 3: Growth Actions (BrowserOS) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!contentOnly) {
        log("\nâ•â•â• ðŸŒ Phase 3: Social Growth (BrowserOS) â•â•â•");

        if (dryRun) {
            log("  â­ï¸ Dry run â€” skipping growth actions");
        } else {
            try {
                results.growth = await runScript(`${BASE}/agent.mjs`);
                if (results.growth.code !== 0) errors.push("Growth agent failed");
            } catch (e) {
                errors.push(`Growth error: ${e.message}`);
                log(`  âŒ ${e.message}`);
            }
        }
    }

    // â”€â”€â”€ Phase 4: Social Engagement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!contentOnly) {
        log("\nâ•â•â• ðŸ¤– Phase 4: Social Engagement â•â•â•");
        try {
            log("  ðŸ” Monitoring comments, auto-replying, sending DMs...");
            const engageArgs = dryRun ? ["--dry-run"] : [];
            results.engagement = await runScript(`${BASE}/social_engagement.mjs`, engageArgs);
            if (results.engagement.code !== 0) errors.push("Engagement automation failed");
        } catch (e) {
            errors.push(`Engagement error: ${e.message}`);
            log(`  âŒ ${e.message}`);
        }
    }

    // â”€â”€â”€ Summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log(`\n${"â•".repeat(55)}`);
    log(`ðŸ“Š PIPELINE COMPLETE â€” ${new Date().toLocaleDateString()}`);
    log(`${"â•".repeat(55)}`);
    if (results.activityGen) log(`  ðŸ§  Activity gen: exit ${results.activityGen.code}`);
    if (results.contentGen) log(`  ðŸ“ Content gen: exit ${results.contentGen.code}`);
    if (results.personalGen) log(`  ðŸ‘¤ Personal gen: exit ${results.personalGen.code}`);
    if (results.scheduler) log(`  ðŸ“¤ Scheduler: exit ${results.scheduler.code}`);
    if (results.growth) log(`  ðŸŒ Growth: exit ${results.growth.code}`);
    if (errors.length > 0) {
        log(`\n  âš ï¸ Errors (${errors.length}):`);
        errors.forEach(e => log(`    â€¢ ${e}`));
    }

    // Save pipeline log
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    fs.writeFileSync(`${LOG_DIR}/pipeline_${ts}.json`, JSON.stringify({ results, errors, timestamp: new Date().toISOString() }, null, 2), "utf8");

    // Telegram summary
    const summaryParts = [];
    if (results.activityGen?.code === 0) summaryParts.push("ðŸ§  Activity âœ…");
    if (results.contentGen?.code === 0) summaryParts.push("ðŸ“ Content âœ…");
    if (results.personalGen?.code === 0) summaryParts.push("ðŸ‘¤ Personal âœ…");
    if (results.scheduler?.code === 0) summaryParts.push("ðŸ“¤ GHL (all brands) âœ…");
    if (results.growth?.code === 0) summaryParts.push("ðŸŒ Growth âœ…");
    if (errors.length > 0) summaryParts.push(`âš ï¸ ${errors.length} error(s)`);

    await telegram(
        errors.length > 0 ? "Done: Pipeline (with errors)" : "Done: Daily Pipeline",
        `ðŸ“Š Pipeline Complete\n${summaryParts.join('\n')}\n${errors.length > 0 ? '\nErrors:\n' + errors.map(e => `â€¢ ${e}`).join('\n') : ''}`
    );

    log("\nâœ… Pipeline finished.");
}

main().catch(e => {
    console.error("ðŸ’¥ FATAL:", e.message);
    telegram("Error: Pipeline Crashed", `ðŸ’¥ ${e.message}`);
});

