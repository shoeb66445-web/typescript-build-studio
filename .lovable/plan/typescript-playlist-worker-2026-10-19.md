# TypeScript playlist worker

## Plan
- Convert the uploaded Cloudflare playlist worker into a standalone, strongly typed TypeScript entrypoint while preserving its routes, CORS behavior, caching, HLS manifest proxy, and DASH redirects.
- Replace the blank home screen with a small playlist workbench that uses the same parser and rewriter to preview pasted M3U content.
- Add focused tests for MPD/HLS parsing, playlist rewriting, and basic request handling; record the standalone worker boundary in `AGENTS.md`.

## Technical details
- Keep the worker separate from TanStack page routing so it remains deployable as a Worker entrypoint.
- Preserve the uploaded source URL and endpoint behavior; do not introduce credentials or a database.
