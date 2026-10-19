import { createFileRoute } from "@tanstack/react-router";
import { buildChannelMap, type ChannelMap } from "../../lib/playlist";

// ─────────────────────────────────────────────────────────────
// CONFIG — same upstream as /api/playlist
// ─────────────────────────────────────────────────────────────
const SOURCE_M3U = "https://premiumplugx.top/jiostb/mjelo.php?view=raw";
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Origin, Accept-Encoding",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range",
};

const CACHE_TTL = 5 * 60 * 1000;
const STALE_TTL = 60 * 1000;

let channelCache: ChannelMap | null = null;
let cacheTimestamp = 0;
let revalidating = false;

async function fetchAndCache(): Promise<void> {
  const res = await fetch(SOURCE_M3U, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; IPTV-Worker/2.0)" },
  });
  if (!res.ok) throw new Error(`Upstream M3U fetch failed: ${res.status} ${res.statusText}`);
  channelCache = buildChannelMap(await res.text());
  cacheTimestamp = Date.now();
}

async function getChannels(): Promise<ChannelMap> {
  const age = Date.now() - cacheTimestamp;
  if (channelCache && age < CACHE_TTL) return channelCache;
  if (channelCache && age < CACHE_TTL + STALE_TTL && !revalidating) {
    revalidating = true;
    fetchAndCache().finally(() => { revalidating = false; });
    return channelCache;
  }
  await fetchAndCache();
  return channelCache!;
}

// ─────────────────────────────────────────────────────────────
// STREAM PROXY — manifest-aware (mirrors worker.js /stream?id=)
//
//   HLS manifests (.m3u8, no Range header):
//     Fetched and returned directly with CORS headers injected.
//
//   Everything else (MPD, segments, Range requests):
//     302 redirect to CDN.
// ─────────────────────────────────────────────────────────────
export const Route = createFileRoute("/api/stream")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const id = url.searchParams.get("id");

        if (!id) {
          return new Response("Missing id", { status: 400, headers: CORS_HEADERS });
        }

        let channels: ChannelMap;
        try {
          channels = await getChannels();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new Response(`Upstream error: ${msg}`, { status: 502, headers: CORS_HEADERS });
        }

        const ch = channels[decodeURIComponent(id)];
        if (!ch) {
          return new Response(`Channel not found: ${id}`, { status: 404, headers: CORS_HEADERS });
        }

        const { url: streamUrl, manifestType } = ch;
        const isRange = !!request.headers.get("Range");

        // HLS manifest proxy — fixes CORS for browser players
        if (manifestType === "hls" && streamUrl.includes(".m3u8") && !isRange) {
          try {
            const upRes = await fetch(streamUrl, {
              headers: {
                "User-Agent": request.headers.get("User-Agent") || "IPTV-Worker/2.0",
                "Accept-Encoding": request.headers.get("Accept-Encoding") || "identity",
                "Referer": new URL(streamUrl).origin + "/",
              },
            });

            if (!upRes.ok) throw new Error(`Manifest ${upRes.status}`);

            return new Response(await upRes.text(), {
              status: 200,
              headers: {
                ...CORS_HEADERS,
                "Content-Type": "application/vnd.apple.mpegurl",
                "Cache-Control": "no-cache",
              },
            });
          } catch {
            // Manifest proxy failed — fall through to redirect
          }
        }

        // MPD, segments, fallback — 302 with CORS
        return new Response(null, {
          status: 302,
          headers: {
            ...CORS_HEADERS,
            Location: streamUrl,
            "Cache-Control": "no-cache",
          },
        });
      },
    },
  },
});
