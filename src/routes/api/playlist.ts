import { createFileRoute } from "@tanstack/react-router";
import { buildChannelMap, rewritePlaylist, type ChannelMap } from "../../lib/playlist";

// ─────────────────────────────────────────────────────────────
// CONFIG — mirrors worker.js constants
// ─────────────────────────────────────────────────────────────
const SOURCE_M3U = "https://premiumplugx.top/jiostb/mjelo.php?view=raw";
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Origin, Accept-Encoding",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range",
};

// ─────────────────────────────────────────────────────────────
// IN-MEMORY CACHE — stale-while-revalidate
//   Fresh  (age < CACHE_TTL)             → return immediately
//   Stale  (age < CACHE_TTL + STALE_TTL) → return stale, revalidate in bg
//   Dead   (age ≥ CACHE_TTL + STALE_TTL) → block on fresh fetch
// ─────────────────────────────────────────────────────────────
const CACHE_TTL = 5 * 60 * 1000; // 5 min primary
const STALE_TTL = 60 * 1000; // 1 min grace window

let channelCache: ChannelMap | null = null;
let cacheTimestamp = 0;
let revalidating = false;

async function fetchAndCache(): Promise<void> {
  const res = await fetch(SOURCE_M3U, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; IPTV-Worker/2.0)" },
  });

  if (!res.ok) {
    throw new Error(`Upstream M3U fetch failed: ${res.status} ${res.statusText}`);
  }

  channelCache = buildChannelMap(await res.text());
  cacheTimestamp = Date.now();
}

async function getChannels(): Promise<ChannelMap> {
  const age = Date.now() - cacheTimestamp;

  if (channelCache && age < CACHE_TTL) return channelCache;

  if (channelCache && age < CACHE_TTL + STALE_TTL && !revalidating) {
    revalidating = true;
    fetchAndCache().finally(() => {
      revalidating = false;
    });
    return channelCache;
  }

  await fetchAndCache();
  return channelCache!;
}

// ─────────────────────────────────────────────────────────────
// ROUTE — GET /api/playlist
// ─────────────────────────────────────────────────────────────
export const Route = createFileRoute("/api/playlist")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // CORS preflight
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        let channels: ChannelMap;
        try {
          channels = await getChannels();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new Response(`Upstream error: ${msg}`, {
            status: 502,
            headers: CORS_HEADERS,
          });
        }

        // Build the worker base URL from the request
        const url = new URL(request.url);
        const workerBase = `${url.protocol}//${url.host}/api`;

        const playlist = rewritePlaylist(channels, workerBase);

        return new Response(playlist, {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/x-mpegurl",
            "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
          },
        });
      },
    },
  },
});
