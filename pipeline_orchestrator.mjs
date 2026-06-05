/**
 * Continuous Parallel Content Orchestrator
 * 
 * Master script that spawns a single Gemini Playwright session,
 * and runs Text Generation and Media Generation in parallel loops.
 */

import { createGeminiBrowser } from './gemini_browser.mjs';
import { generateDayContent } from './content_generator.mjs';
import { processMissingMedia } from './generate_missing_notion_media.mjs';
import { fetchExistingDates } from './publish_to_notion.mjs';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Global flag to tell Worker 2 when Worker 1 is completely finished
let textWorkerDone = false;

async function startTextWorker(gem, daysAhead, targetVideos, targetImages) {
    console.log('\n[Worker 1] ðŸš€ Text Generator started.');
    try {
        const existingDateList = await fetchExistingDates();
        const existingDates = new Set(existingDateList);

        for (let i = 0; i < daysAhead; i++) {
            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + i + 1);
            
            console.log(`\n[Worker 1] ðŸ“ Processing Day ${i+1}/${daysAhead} - ${targetDate.toISOString().split('T')[0]}`);
            
            // Jitter to prevent exact simultaneous prompts
            await sleep(Math.random() * 2000);
            
            const quotas = { remainingVideos: targetVideos, remainingImages: targetImages };
            await generateDayContent(targetDate, gem, existingDates, quotas, i + 1, null, null);
            
            console.log(`[Worker 1] âœ… Completed Day ${i+1}.`);
        }
    } catch (e) {
        console.error('[Worker 1] âŒ Crashed:', e);
    }
    console.log('[Worker 1] ðŸŽ‰ Text Generation Complete.');
    textWorkerDone = true;
}

async function startMediaWorker(gem) {
    console.log('\n[Worker 2] ðŸŽ¨ Media Generator started.');
    // Run an infinite loop polling Notion for missing media every 30 seconds
    // until the text worker is fully done. We do one final loop after text is done to catch the last items.
    let finalRun = false;
    
    while (true) {
        try {
            await sleep(Math.random() * 2000 + 5000); // jitter
            await processMissingMedia(gem.context);
        } catch (e) {
            console.error('[Worker 2] âŒ Error during media processing:', e);
        }
        
        if (finalRun) {
            break; // Exit the loop if we just did the final sweep
        }
        
        if (textWorkerDone) {
            console.log('[Worker 2] Text Worker is done! Doing one final sweep for missing media...');
            finalRun = true;
            await sleep(5000);
            continue;
        }

        console.log('[Worker 2] â³ Waiting 25 seconds before next poll...');
        await sleep(25000);
    }
    console.log('[Worker 2] ðŸŽ‰ Media Generation Loop Ended.');
}

async function main() {
    const args = process.argv.slice(2);
    const daysAhead = parseInt(args[0]) || 2;
    const targetVideos = parseInt(args[1]) || 2;
    const targetImages = parseInt(args[2]) || 33;

    console.log(`\n=================================================`);
    console.log(`ðŸš€ BLUEJAX CONTINUOUS ORCHESTRATOR`);
    console.log(`=================================================`);
    console.log(`Config: ${daysAhead} days ahead`);

    // 1. Initialize Single Browser Instance
    console.log('\nBooting Gemini Engine...');
    const gem = await createGeminiBrowser();

    // 2. Start Parallel Workers
    console.log('\nStarting Parallel Workers (Text + Media)...');
    
    // We run both promises simultaneously
    await Promise.all([
        startTextWorker(gem, daysAhead, targetVideos, targetImages),
        startMediaWorker(gem)
    ]);

    console.log('\n=================================================');
    console.log('âœ… ORCHESTRATOR PIPELINE COMPLETE');
    console.log('=================================================\n');
    await gem.close();
    process.exit(0);
}

main().catch(e => {
    console.error('Fatal Pipeline Error:', e);
    process.exit(1);
});

