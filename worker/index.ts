import { buildChannelMap, rewritePlaylist, type Channel, type ChannelMap } from "../src/lib/playlist";

const SOURCE_M3U = "https://premiumplugx.top/jiostb/mjelo.php?view=raw";
const CACHE_TTL = 5 * 60 * 1000;
const STALE_TTL = 60 * 1000;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Origin, Accept-Encoding",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range",
};

interface WorkerEnvironment {}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface CloudflareFetchInit extends RequestInit {
  cf?: { cacheTtl?: number };
}

interface CachedChannels {
  channels: ChannelMap | null;
  timestamp: number;
  revalidating: boolean;
}

const cache: CachedChannels = { channels: null, timestamp: 0, revalidating: false };
const edgeFetch = globalThis.fetch as (
  input: RequestInfo | URL,
  init?: CloudflareFetchInit,
) => Promise<Response>;

async function fetchAndCache(): Promise<ChannelMap> {
  const response = await edgeFetch(SOURCE_M3U, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; IPTV-Worker/2.0)" },
    cf: { cacheTtl: 0 },
  });

  if (!response.ok) {
    throw new Error(`Upstream M3U fetch failed: ${response.status} ${response.statusText}`);
  }

  const channels = buildChannelMap(await response.text());
  cache.channels = channels;
  cache.timestamp = Date.now();
  return channels;
}

async function getChannels(context: WorkerExecutionContext): Promise<ChannelMap> {
  const age = Date.now() - cache.timestamp;
  if (cache.channels && age < CACHE_TTL) return cache.channels;

  if (cache.channels && age < CACHE_TTL + STALE_TTL && !cache.revalidating) {
    cache.revalidating = true;
    const refresh = fetchAndCache().finally(() => {
      cache.revalidating = false;
    });
    context.waitUntil(refresh.catch(() => undefined));
    return cache.channels;
  }

  return fetchAndCache();
}

async function proxyStream(request: Request, channel: Channel): Promise<Response> {
  const isRangeRequest = Boolean(request.headers.get("Range"));

  if (channel.manifestType === "hls" && channel.url.includes(".m3u8") && !isRangeRequest) {
    try {
      const upstream = await edgeFetch(channel.url, {
        headers: {
          "User-Agent": request.headers.get("User-Agent") || "IPTV-Worker/2.0",
          "Accept-Encoding": request.headers.get("Accept-Encoding") || "identity",
          Referer: `${new URL(channel.url).origin}/`,
        },
        cf: { cacheTtl: 10 },
      });
      if (!upstream.ok) throw new Error(`Manifest ${upstream.status}`);

      return new Response(await upstream.text(), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache",
        },
      });
    } catch {
      // If manifest fetching fails, let the player request it from the CDN directly.
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      ...CORS_HEADERS,
      Location: channel.url,
      "Cache-Control": "no-cache",
    },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown upstream error";
}

async function handleRequest(
  request: Request,
  _environment: WorkerEnvironment,
  context: WorkerExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const workerBase = `${url.protocol}//${url.host}`;
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (path === "/" || path === "/playlist.m3u" || path === "/playlist.m3u8") {
    try {
      const channels = await getChannels(context);
      return new Response(rewritePlaylist(channels, workerBase), {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/x-mpegurl",
          "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        },
      });
    } catch (error) {
      return new Response(`Upstream error: ${errorMessage(error)}`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }
  }

  if (path === "/stream") {
    const id = url.searchParams.get("id");
    if (!id) return new Response("Missing id", { status: 400, headers: CORS_HEADERS });

    let channels: ChannelMap;
    try {
      channels = await getChannels(context);
    } catch (error) {
      return new Response(`Upstream error: ${errorMessage(error)}`, {
        status: 502,
        headers: CORS_HEADERS,
      });
    }

    const channel = channels[id];
    if (!channel) {
      return new Response(`Channel not found: ${id}`, { status: 404, headers: CORS_HEADERS });
    }
    return proxyStream(request, channel);
  }

  if (path === "/channels.json") {
    let channels: ChannelMap;
    try {
      channels = await getChannels(context);
    } catch (error) {
      return new Response(JSON.stringify({ error: errorMessage(error) }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const payload = Object.entries(channels).map(([slug, channel]) => ({
      slug,
      name: channel.name,
      group: channel.group,
      manifestType: channel.manifestType,
      hasKeys: Boolean(channel.clearkey),
      keyCount: channel.clearkey ? channel.clearkey.split(",").length : 0,
      url: channel.url,
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

const worker = { fetch: handleRequest };

export { buildChannelMap, rewritePlaylist };
export default worker;