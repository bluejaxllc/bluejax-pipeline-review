import { createGeminiSpoofer, generateWithRefinement } from './gemini_api_spoofer.mjs';

/**
 * Base Abstract Provider
 */
export class ReviewerProvider {
    async review(post) {
        throw new Error("Method 'review()' must be implemented.");
    }
}

/**
 * Human Reviewer Provider
 * Outputs the payload for the human to paste into ChatGPT.
 * In a fully automated system, this might push a message to Slack/Discord
 * and wait for a webhook response. Here, we'll just log it.
 */
export class HumanReviewerProvider extends ReviewerProvider {
    async review(post) {
        console.log(`\n================ HUMAN REVIEW REQUEST ================`);
        console.log(`Please paste this into ChatGPT for review:\n`);
        const payload = {
            post_id: post.id,
            brand: post.brand_id,
            content: post.content,
            media_type: post.mediaType,
            review_instructions: "Please critique this post. Return ONLY valid JSON with keys: score (0-10), brand_voice (0-10), hook_strength (0-10), clarity (0-10), engagement (0-10), issues (array of strings), suggested_rewrite (string)."
        };
        console.log(JSON.stringify(payload, null, 2));
        console.log(`========================================================\n`);

        return {
            score: 0,
            issues: ["Manual review required. Waiting for human input."],
            suggested_rewrite: "",
            human_action_required: true
        };
    }
}

/**
 * Gemini Automated Reviewer Provider
 * Uses our existing token spoofing architecture to act as an automated reviewer.
 */
export class GeminiReviewerProvider extends ReviewerProvider {
    constructor() {
        super();
        this.gem = null;
    }

    async review(post) {
        if (!this.gem) {
            this.gem = await createGeminiSpoofer(null);
        }

        const prompt = `You are a critical, senior social media manager.
Review the following post draft for the brand "${post.brand_id}".

POST CONTENT:
"""
${post.content}
"""

CRITIQUE INSTRUCTIONS:
Evaluate this post based on:
1. Hook Strength
2. Brand Voice
3. Clarity
4. Engagement

Return your critique as a raw JSON object. DO NOT include markdown formatting (\`\`\`json). Just the raw object:
{
  "score": <number 0-10>,
  "brand_voice": <number 0-10>,
  "hook_strength": <number 0-10>,
  "clarity": <number 0-10>,
  "engagement": <number 0-10>,
  "issues": ["<issue 1>", "<issue 2>"],
  "suggested_rewrite": "<improved content>"
}`;

        const rawResponse = await generateWithRefinement(this.gem, prompt, { critique: false });
        
        try {
            // Clean up any potential markdown if Gemini disobeys the instruction
            const cleanJsonStr = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            const result = JSON.parse(cleanJsonStr);
            return result;
        } catch (e) {
            console.error("Failed to parse Gemini review JSON:", rawResponse);
            return {
                score: 5,
                issues: ["JSON Parsing Failed. Reviewer returned invalid format."],
                suggested_rewrite: post.content
            };
        }
    }

    async cleanup() {
        if (this.gem) {
            await this.gem.close();
            this.gem = null;
        }
    }
}

/**
 * Factory for creating the desired Reviewer Provider
 */
export class ReviewerFactory {
    static create(providerName) {
        switch (providerName.toLowerCase()) {
            case 'human':
                return new HumanReviewerProvider();
            case 'gemini':
                return new GeminiReviewerProvider();
            default:
                throw new Error(`Unknown Reviewer Provider: ${providerName}`);
        }
    }
}

