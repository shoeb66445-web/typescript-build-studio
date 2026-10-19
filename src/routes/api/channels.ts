import { createFileRoute } from "@tanstack/react-router";
import { buildChannelMap, type ChannelMap } from "../../lib/playlist";

// ─────────────────────────────────────────────────────────────
// CONFIG
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
// ROUTE — GET /api/channels  (debug/audit endpoint)
// Lists every resolved channel with slug, format, key presence.
// ─────────────────────────────────────────────────────────────
export const Route = createFileRoute("/api/channels")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        let channels: ChannelMap;
        try {
          channels = await getChannels();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return new Response(JSON.stringify({ error: msg }), {
            status: 502,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }

        const payload = Object.entries(channels).map(([slug, ch]) => ({
          slug,
          name: ch.name,
          group: ch.group,
          manifestType: ch.manifestType,
          hasKeys: !!ch.clearkey,
          keyCount: ch.clearkey ? ch.clearkey.split(",").length : 0,
          url: ch.url,
        }));

        return new Response(JSON.stringify(payload, null, 2), {
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
          },
        });
      },
    },
  },
});
