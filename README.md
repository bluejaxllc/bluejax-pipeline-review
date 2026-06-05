# BlueJax Content Pipeline â€” Public Review Mirror

This is a sanitized public mirror of the BlueJax multi-brand AI content generation pipeline,
shared for independent code review purposes.

## Files
- `pipeline_orchestrator.mjs` â€” Main orchestrator (schedules all workers)
- `daily_pipeline.mjs` â€” Daily run trigger
- `notion_helper.mjs` â€” Notion DB state management  
- `worker_generator.mjs` â€” Content generation worker
- `content_generator.mjs` â€” Core LLM content generator
- `lum_content_gen_ultra.mjs` â€” Lum Coffee brand generator
- `personal_content_gen.mjs` â€” Edgar personal brand generator
- `worker_media.mjs` â€” Image/video generation worker
- `worker_reviewer.mjs` â€” AI content review worker
- `reviewer_factory.mjs` â€” Review worker factory
- `worker_publisher.mjs` â€” Multi-platform publisher
- `notion_publisher.mjs` â€” Notion publish handler
- `dlq_monitor.mjs` â€” Dead letter queue recovery

> All secrets replaced with process.env references. Do not use this code in production without restoring env config.
