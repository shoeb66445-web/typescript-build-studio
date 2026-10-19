// ─────────────────────────────────────────────────────────────
// worker/index.ts — Cloudflare Worker IPTV Proxy
// ─────────────────────────────────────────────────────────────

import {
  buildChannelMap,
  rewritePlaylist,
  type Channel,
  type ChannelMap,
} from "../src/lib/playlist";

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const SOURCE_M3U = "https://premiumplugx.top/jiostb/mjelo.php?view=raw";
const CACHE_TTL = 5 * 60 * 1000; // 5 min primary
const STALE_TTL = 60 * 1000; // 1 min grace window (stale-while-revalidate)

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Origin, Accept-Encoding",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range",
};

// ─────────────────────────────────────────────────────────────
// Cloudflare Worker types
// ─────────────────────────────────────────────────────────────

interface WorkerEnvironment {}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface CloudflareFetchInit extends RequestInit {
  cf?: { cacheTtl?: number };
}

// ─────────────────────────────────────────────────────────────
// IN-MEMORY CACHE — stale-while-revalidate
//   Fresh  (age < CACHE_TTL)             → return immediately
//   Stale  (age < CACHE_TTL + STALE_TTL) → return stale, revalidate in bg
//   Dead   (age ≥ CACHE_TTL + STALE_TTL) → block on fresh fetch
// ─────────────────────────────────────────────────────────────

interface CachedChannels {
  channels: ChannelMap | null;
  timestamp: number;
  revalidating: boolean;
}

const cache: CachedChannels = {
  channels: null,
  timestamp: 0,
  revalidating: false,
};

const edgeFetch = globalThis.fetch as (
  input: RequestInfo | URL,
  init?: CloudflareFetchInit,
) => Promise<Response>;

async function fetchAndCache(): Promise<ChannelMap> {
  const res = await edgeFetch(SOURCE_M3U, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; IPTV-Worker/2.0)" },
    cf: { cacheTtl: 0 },
  });

  if (!res.ok) {
    throw new Error(
      `Upstream M3U fetch failed: ${res.status} ${res.statusText}`,
    );
  }

  cache.channels = buildChannelMap(await res.text());
  cache.timestamp = Date.now();
  return cache.channels;
}

async function getChannels(ctx: WorkerExecutionContext): Promise<ChannelMap> {
  const age = Date.now() - cache.timestamp;

  if (cache.channels && age < CACHE_TTL) return cache.channels;

  if (cache.channels && age < CACHE_TTL + STALE_TTL && !cache.revalidating) {
    cache.revalidating = true;
    const job = fetchAndCache().finally(() => {
      cache.revalidating = false;
    });
    ctx.waitUntil(job.catch(() => undefined));
    return cache.channels;
  }

  return fetchAndCache();
}

// ─────────────────────────────────────────────────────────────
// STREAM PROXY — manifest-aware
//
//   HLS manifests (.m3u8, no Range header):
//     Fetched and returned directly with CORS headers injected.
//
//   Everything else (MPD, segments, Range requests):
//     302 redirect to CDN.
// ─────────────────────────────────────────────────────────────

async function proxyStream(
  request: Request,
  ch: Channel,
): Promise<Response> {
  const { url, manifestType } = ch;
  const isRange = Boolean(request.headers.get("Range"));

  if (manifestType === "hls" && url.includes(".m3u8") && !isRange) {
    try {
      const upRes = await edgeFetch(url, {
        headers: {
          "User-Agent":
            request.headers.get("User-Agent") || "IPTV-Worker/2.0",
          "Accept-Encoding":
            request.headers.get("Accept-Encoding") || "identity",
          Referer: new URL(url).origin + "/",
        },
        cf: { cacheTtl: 10 },
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
      Location: url,
      "Cache-Control": "no-cache",
    },
  });
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown upstream error";
}

// ─────────────────────────────────────────────────────────────
// REQUEST HANDLER
// ─────────────────────────────────────────────────────────────

async function handleRequest(
  request: Request,
  _env: WorkerEnvironment,
  ctx: WorkerExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const workerBase = `${url.protocol}//${url.host}`;
  const path = url.pathname;

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── /playlist.m3u  /playlist.m3u8  / ─────────────────────
  if (
    path === "/" ||
    path === "/playlist.m3u" ||
    path === "/playlist.m3u8"
  ) {
    let channels: ChannelMap;
    try {
      channels = await getChannels(ctx);
    } catch (e) {
      return new Response(`Upstream error: ${errorMessage(e)}`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }
    return new Response(rewritePlaylist(channels, workerBase), {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/x-mpegurl",
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
      },
    });
  }

  // ── /stream?id=<slug> ─────────────────────────────────────
  if (path === "/stream") {
    const id = url.searchParams.get("id");
    if (!id) {
      return new Response("Missing id", {
        status: 400,
        headers: CORS_HEADERS,
      });
    }

    let channels: ChannelMap;
    try {
      channels = await getChannels(ctx);
    } catch (e) {
      return new Response(`Upstream error: ${errorMessage(e)}`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }

    const ch = channels[decodeURIComponent(id)];
    if (!ch) {
      return new Response(`Channel not found: ${id}`, {
        status: 404,
        headers: CORS_HEADERS,
      });
    }

    return proxyStream(request, ch);
  }

  // ── /channels.json — debug/audit endpoint ────────────────
  if (path === "/channels.json") {
    let channels: ChannelMap;
    try {
      channels = await getChannels(ctx);
    } catch (e) {
      return new Response(JSON.stringify({ error: errorMessage(e) }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const payload = Object.entries(channels).map(([slug, ch]) => ({
      slug,
      name: ch.name,
      group: ch.group,
      manifestType: ch.manifestType,
      hasKeys: Boolean(ch.clearkey),
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
  }

  return new Response("Not found", { status: 404, headers: CORS_HEADERS });
}

// ─────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────

export { buildChannelMap, rewritePlaylist };

export default {
  fetch: handleRequest,
};