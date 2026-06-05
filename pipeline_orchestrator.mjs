/**
 * Continuous Parallel Content Orchestrator
 *
 * Master script that spawns a single Gemini Playwright session,
 * and runs Text Generation and Media Generation in parallel loops.
 *
 * Hardening (v2):
 *  - try...finally in startMediaWorker guarantees browser handle cleanup
 *  - Fatal vs. transient error taxonomy: fatal errors terminate the process
 *    cleanly so the process monitor can restart from a known-good state
 */

import { createGeminiBrowser } from './gemini_browser.mjs';
import { generateDayContent } from './content_generator.mjs';
import { processMissingMedia } from './generate_missing_notion_media.mjs';
import { fetchExistingDates } from './publish_to_notion.mjs';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Signals to Worker 2 that Worker 1 has finished all days
let textWorkerDone = false;

// ─── Fatal error detector ─────────────────────────────────────────────────────
// Errors that indicate misconfiguration / missing env — no point retrying.
function isFatalError(err) {
    const msg = err?.message?.toLowerCase() || '';
    return (
        msg.includes('cannot find module') ||
        msg.includes('missing env') ||
        msg.includes('enoent') ||
        msg.includes('unauthorized') ||
        msg.includes('forbidden')
    );
}

// ─── Worker 1: Text Generation ───────────────────────────────────────────────

async function startTextWorker(gem, daysAhead, targetVideos, targetImages) {
    console.log('\n[Worker 1] 🚀 Text Generator started.');
    try {
        const existingDateList = await fetchExistingDates();
        const existingDates = new Set(existingDateList);

        for (let i = 0; i < daysAhead; i++) {
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + i + 1);

            console.log(`\n[Worker 1] 📝 Processing Day ${i + 1}/${daysAhead} - ${targetDate.toISOString().split('T')[0]}`);

            // Jitter to prevent exact simultaneous prompts
            await sleep(Math.random() * 2000);

            const quotas = { remainingVideos: targetVideos, remainingImages: targetImages };
            await generateDayContent(targetDate, gem, existingDates, quotas, i + 1, null, null);

            console.log(`[Worker 1] ✅ Completed Day ${i + 1}.`);
        }
    } catch (e) {
        if (isFatalError(e)) {
            console.error('[Worker 1] 💀 Fatal error — terminating process:', e.message);
            process.exit(1);
        }
        console.error('[Worker 1] ❌ Transient crash (will not retry automatically):', e.message);
    }
    console.log('[Worker 1] 🎉 Text Generation Complete.');
    textWorkerDone = true;
}

// ─── Worker 2: Media Generation ──────────────────────────────────────────────

async function startMediaWorker(gem) {
    console.log('\n[Worker 2] 🎨 Media Generator started.');
    let finalRun = false;

    while (true) {
        // ── try...finally guarantees resource cleanup on any exit path ──
        try {
            await sleep(Math.random() * 2000 + 5000); // jitter

            // processMissingMedia opens browser handles — finally ensures they close
            let mediaContext = null;
            try {
                mediaContext = gem.context;
                await processMissingMedia(mediaContext);
            } finally {
                // If processMissingMedia left any dangling page handles, close them.
                // (Defensive: the function should handle its own cleanup, but this
                //  catches cases where it throws mid-allocation.)
                if (mediaContext) {
                    try {
                        const pages = mediaContext.pages();
                        for (const page of pages) {
                            if (page.url() === 'about:blank') {
                                await page.close().catch(() => { });
                            }
                        }
                    } catch { /* best-effort cleanup */ }
                }
            }
        } catch (e) {
            if (isFatalError(e)) {
                console.error('[Worker 2] 💀 Fatal error — terminating process:', e.message);
                process.exit(1);
            }
            console.error('[Worker 2] ❌ Error during media processing (will retry):', e.message);
        }

        if (finalRun) {
            break; // Exit after the final sweep
        }

        if (textWorkerDone) {
            console.log('[Worker 2] Text Worker is done! Doing one final sweep for missing media...');
            finalRun = true;
            await sleep(5000);
            continue;
        }

        console.log('[Worker 2] ⏳ Waiting 25 seconds before next poll...');
        await sleep(25_000);
    }
    console.log('[Worker 2] 🎉 Media Generation Loop Ended.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const daysAhead = parseInt(args[0]) || 2;
    const targetVideos = parseInt(args[1]) || 2;
    const targetImages = parseInt(args[2]) || 33;

    console.log('\n=================================================');
    console.log('🚀 BLUEJAX CONTINUOUS ORCHESTRATOR');
    console.log('=================================================');
    console.log(`Config: ${daysAhead} days ahead | ${targetVideos} videos | ${targetImages} images`);

    console.log('\nBooting Gemini Engine...');
    const gem = await createGeminiBrowser();

    console.log('\nStarting Parallel Workers (Text + Media)...');
    await Promise.all([
        startTextWorker(gem, daysAhead, targetVideos, targetImages),
        startMediaWorker(gem)
    ]);

    console.log('\n=================================================');
    console.log('✅ ORCHESTRATOR PIPELINE COMPLETE');
    console.log('=================================================\n');

    await gem.close();
    process.exit(0);
}

main().catch(e => {
    console.error('💥 Fatal Pipeline Error:', e.message);
    process.exit(1);
});
