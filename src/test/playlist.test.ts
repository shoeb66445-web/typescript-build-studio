import { describe, expect, it } from "vitest";

import { buildChannelMap, rewritePlaylist } from "@/lib/playlist";

const playlist = [
  "#EXTM3U",
  '#EXTINF:-1 tvg-id="dash.one" tvg-logo="https://img.test/dash.png" group-title="News",Dash One',
  "#KODIPROP:inputstream=inputstream.adaptive",
  "#KODIPROP:inputstream.adaptive.manifest_type=mpd",
  "#KODIPROP:inputstream.adaptive.license_key=kid-a:key-a,kid-b:key-b",
  "https://media.test/dash.mpd",
  '#EXTINF:-1 tvg-name="HLS Two" tvg-language="en" group-title="Sports",HLS Two',
  "#KODIPROP:inputstream.adaptive.manifest_type=hls",
  "https://media.test/live.m3u8",
].join("\n");

describe("playlist conversion", () => {
  it("parses DASH and HLS metadata with all DASH key pairs", () => {
    const channels = buildChannelMap(playlist);

    expect(Object.keys(channels)).toEqual(["dashone", "hlstwo"]);
    expect(channels.dashone?.manifestType).toBe("mpd");
    expect(channels.dashone?.clearkey).toBe("kid-a:key-a,kid-b:key-b");
    expect(channels.hlstwo?.manifestType).toBe("hls");
    expect(channels.hlstwo?.lang).toBe("en");
  });

  it("keeps DASH keys but omits DRM settings for HLS in the rewritten output", () => {
    const output = rewritePlaylist(buildChannelMap(playlist), "https://relay.test");

    expect(output).toContain("inputstream.adaptive.license_key=kid-a:key-a,kid-b:key-b");
    expect(output).toContain("https://relay.test/stream?id=dashone");
    expect(output).toContain("https://relay.test/stream?id=hlstwo");

    const hlsSection = output.split("HLS Two")[1] ?? "";
    expect(hlsSection).not.toContain("license_type");
    expect(hlsSection).not.toContain("license_key");
  });
});