import 'dotenv/config';
import fs from "fs";
import { spawn } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ================================================================
// 🚀 BlueJax Daily Social Media Pipeline
// ================================================================
// Single entry point that orchestrates the entire daily social stack:
//   1. Generate content (Gemini → calendar JSON) for all brands
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
// ⚠️  Secret loaded from environment — never hardcode API keys
const TELEGRAM_KEY = process.env.TELEGRAM_KEY || process.env.TELEGRAM_NOTIFY_KEY || '';

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
        log(`  ▶ Running: node ${scriptPath} ${args.join(' ')}`);
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

    log("🚀 BlueJax Daily Social Media Pipeline");
    log(`   Mode: ${dryRun ? 'DRY RUN' : contentOnly ? 'CONTENT ONLY' : growthOnly ? 'GROWTH ONLY' : 'FULL PIPELINE'}`);
    await telegram("Starting: Daily Social Pipeline", `🚀 Pipeline starting (${dryRun ? 'dry run' : 'full'} mode)`);

    const results = { activityGen: null, contentGen: null, personalGen: null, scheduler: null, growth: null };
    const errors = [];

    // ─── Phase -1: Refresh GHL Token ─────────────────────────
    log("\n═══ 🔑 Phase -1: GHL Token Refresh ═══");
    try {
        const tokenResult = await runScript(`${BASE}/ghl_token_updater.mjs`);
        if (tokenResult.code === 0) {
            log("  ✅ GHL token refreshed");
            // Reload .env into current process
            const envContent = fs.readFileSync(`${BASE}/.env`, 'utf8');
            for (const line of envContent.split('\n')) {
                const m = line.match(/^([^#=]+)=(.+)$/);
                if (m) process.env[m[1].trim()] = m[2].trim();
            }
        } else {
            log("  ⚠️ Token refresh failed (will attempt with existing token)");
        }
    } catch (e) {
        log(`  ⚠️ Token refresh error: ${e.message}`);
    }

    // ─── Phase 0: Activity → Personal Brand Content ──────────
    if (!growthOnly) {
        log("\n═══ 🧠 Phase 0: Activity Content (Brain Scanner) ═══");
        try {
            log("  🔍 Scanning agent activity for personal brand...");
            results.activityGen = await runScript(`${BASE}/activity_content_gen.mjs`);
            if (results.activityGen.code !== 0) errors.push("Activity content gen failed");
        } catch (e) {
            errors.push(`Activity gen error: ${e.message}`);
            log(`  ❌ ${e.message}`);
        }
    }

    // ─── Idempotency Guard: Skip content gen if already ran today ────────
    if (!growthOnly) {
        log("\n═══ 🛡️  Idempotency Check: Has pipeline run today? ═══");
        try {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const NOTION_API_KEY = process.env.NOTION_CMS_API_KEY || process.env.NOTION_API_KEY;
            const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
            if (NOTION_API_KEY && NOTION_DATABASE_ID) {
                const idemRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${NOTION_API_KEY}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filter: { property: 'Created', date: { on_or_after: todayStart.toISOString() } },
                        page_size: 1
                    })
                });
                if (idemRes.ok) {
                    const idemData = await idemRes.json();
                    if (idemData.results.length > 0) {
                        log(`  ⚠️  Idempotency: Content already generated today (${idemData.results.length}+ entries found). Skipping content generation phases.`);
                        await telegram('Pipeline: Idempotency Guard', '⚠️ Content already generated today — skipping generation phases.');
                        // Jump straight to scheduling + growth
                        Object.assign(results, { activityGen: { code: 0 }, contentGen: { code: 0 }, personalGen: { code: 0 } });
                        // Fall through to Phase 2 (scheduler) by not setting growthOnly but skipping the blocks below
                        // We use a flag to signal the guard fired
                        results._idempotencySkipped = true;
                    } else {
                        log('  ✅ No entries found today — proceeding with content generation.');
                    }
                }
            }
        } catch (idemErr) {
            log(`  ⚠️  Idempotency check error (non-fatal, proceeding): ${idemErr.message}`);
        }
    }

    // ─── Phase 1: Generate Content ────────────────────────────
    if (!growthOnly && !results._idempotencySkipped) {
        log("\n═══ 📝 Phase 1: Content Generation ═══");

        try {
            log("  🎨 BlueJax brand content...");
            results.contentGen = await runScript(`${BASE}/content_generator.mjs`, ["1"]);
            if (results.contentGen.code !== 0) errors.push("BlueJax content gen failed");
        } catch (e) {
            errors.push(`Content gen error: ${e.message}`);
            log(`  ❌ ${e.message}`);
        }

        try {
            log("  👤 Personal brand content...");
            results.personalGen = await runScript(`${BASE}/personal_content_gen.mjs`, ["1"]);
            if (results.personalGen.code !== 0) errors.push("Personal content gen failed");
        } catch (e) {
            errors.push(`Personal gen error: ${e.message}`);
            log(`  ❌ ${e.message}`);
        }
    } // end !growthOnly && !_idempotencySkipped

    // ─── Phase 1.3: Generate Images for Posts ────────────────
    if (!growthOnly && !dryRun) {
        log("\n═══ 🎨 Phase 1.3: Image Generation (Nano Banana) ═══");
        try {
            results.imageGen = await runScript(`${BASE}/personal_image_gen.mjs`);
            if (results.imageGen.code !== 0) errors.push("Image generation failed");
        } catch (e) {
            errors.push(`Image gen error: ${e.message}`);
            log(`  ❌ ${e.message}`);
        }
    }

    // ─── Phase 1.5: Auto-Promote Generated Posts to "ready" ──
    if (!growthOnly && !dryRun) {
        log("\n═══ ✅ Phase 1.5: Auto-Promote Posts to Ready ═══");
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
            log(`  ✅ Promoted ${promoted} post(s) to "ready" state`);
        } catch (e) {
            errors.push(`Auto-promote error: ${e.message}`);
            log(`  ❌ ${e.message}`);
        }
    }

    // ─── Phase 2: Schedule Posts via GHL (All Brands) ─────────
    if (!growthOnly) {
        log("\n═══ 📤 Phase 2: Post Scheduling — All Brands (GHL) ═══");

        try {
            const schedulerArgs = dryRun ? ["--dry-run"] : [];
            results.scheduler = await runScript(`${BASE}/content_scheduler.mjs`, schedulerArgs);
            if (results.scheduler.code !== 0) errors.push("GHL scheduling failed");
        } catch (e) {
            errors.push(`Scheduler error: ${e.message}`);
            log(`  ❌ ${e.message}`);
        }
    }

    // ─── Phase 3: Growth Actions (BrowserOS) ──────────────────
    if (!contentOnly) {
        log("\n═══ 🌐 Phase 3: Social Growth (BrowserOS) ═══");

        if (dryRun) {
            log("  ⏭️ Dry run — skipping growth actions");
        } else {
            try {
                results.growth = await runScript(`${BASE}/agent.mjs`);
                if (results.growth.code !== 0) errors.push("Growth agent failed");
            } catch (e) {
                errors.push(`Growth error: ${e.message}`);
                log(`  ❌ ${e.message}`);
            }
        }
    }

    // ─── Phase 4: Social Engagement ──────────────────────────
    if (!contentOnly) {
        log("\n═══ 🤖 Phase 4: Social Engagement ═══");
        try {
            log("  🔍 Monitoring comments, auto-replying, sending DMs...");
            const engageArgs = dryRun ? ["--dry-run"] : [];
            results.engagement = await runScript(`${BASE}/social_engagement.mjs`, engageArgs);
            if (results.engagement.code !== 0) errors.push("Engagement automation failed");
        } catch (e) {
            errors.push(`Engagement error: ${e.message}`);
            log(`  ❌ ${e.message}`);
        }
    }

    // ─── Summary ─────────────────────────────────────────────
    log(`\n${"═".repeat(55)}`);
    log(`📊 PIPELINE COMPLETE — ${new Date().toLocaleDateString()}`);
    log(`${"═".repeat(55)}`);
    if (results.activityGen) log(`  🧠 Activity gen: exit ${results.activityGen.code}`);
    if (results.contentGen) log(`  📝 Content gen: exit ${results.contentGen.code}`);
    if (results.personalGen) log(`  👤 Personal gen: exit ${results.personalGen.code}`);
    if (results.scheduler) log(`  📤 Scheduler: exit ${results.scheduler.code}`);
    if (results.growth) log(`  🌐 Growth: exit ${results.growth.code}`);
    if (errors.length > 0) {
        log(`\n  ⚠️ Errors (${errors.length}):`);
        errors.forEach(e => log(`    • ${e}`));
    }

    // Save pipeline log
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    fs.writeFileSync(`${LOG_DIR}/pipeline_${ts}.json`, JSON.stringify({ results, errors, timestamp: new Date().toISOString() }, null, 2), "utf8");

    // Telegram summary
    const summaryParts = [];
    if (results.activityGen?.code === 0) summaryParts.push("🧠 Activity ✅");
    if (results.contentGen?.code === 0) summaryParts.push("📝 Content ✅");
    if (results.personalGen?.code === 0) summaryParts.push("👤 Personal ✅");
    if (results.scheduler?.code === 0) summaryParts.push("📤 GHL (all brands) ✅");
    if (results.growth?.code === 0) summaryParts.push("🌐 Growth ✅");
    if (errors.length > 0) summaryParts.push(`⚠️ ${errors.length} error(s)`);

    await telegram(
        errors.length > 0 ? "Done: Pipeline (with errors)" : "Done: Daily Pipeline",
        `📊 Pipeline Complete\n${summaryParts.join('\n')}\n${errors.length > 0 ? '\nErrors:\n' + errors.map(e => `• ${e}`).join('\n') : ''}`
    );

    log("\n✅ Pipeline finished.");
}

main().catch(e => {
    console.error("💥 FATAL:", e.message);
    telegram("Error: Pipeline Crashed", `💥 ${e.message}`);
});
