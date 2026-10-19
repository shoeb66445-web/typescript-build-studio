// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type ManifestType = "mpd" | "hls" | (string & {});

export interface Channel {
  url: string;
  manifestType: ManifestType;
  clearkey: string;
  tvgId: string;
  logo: string;
  group: string;
  lang: string;
  display: string;
  name: string;
}

export type ChannelMap = Record<string, Channel>;

// ─────────────────────────────────────────────────────────────
// SLUG — lowercase + alnum only
// ─────────────────────────────────────────────────────────────

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ─────────────────────────────────────────────────────────────
// CHANNEL MAP — dual-format aware parser
//
//   Each channel entry captures:
//     • manifest_type  : "mpd" | "hls"  (from KODIPROP)
//     • clearkeys      : "kid1:key1,kid2:key2,..."  (MPD entries carry these;
//                        HLS entries may carry them too but they're dropped
//                        in the rewritten playlist since .m3u8 needs no DRM)
//     • url            : raw CDN stream URL
//     • tvgId / logo / group / lang / display  : metadata pass-through
//
//   Parser rules:
//     • Reads ALL KODIPROP lines between #EXTINF and the stream URL
//     • Collects manifest_type from inputstream.adaptive.manifest_type
//     • Collects ALL clearkey pairs — multi-KODIPROP and comma-separated
//       pairs on a single line are both handled
//     • Skips inputstream=inputstream.adaptive (informational only)
//     • Skips license_type (we always know it's clearkey)
//     • Duplicate slugs → last-write wins
// ─────────────────────────────────────────────────────────────

export function buildChannelMap(raw: string): ChannelMap {
  const lines = raw.split(/\r?\n/);
  const map: ChannelMap = {};
  let i = 0;

  while (i < lines.length) {
    const line = (lines[i] ?? "").trim();

    if (!line || line === "#EXTM3U") {
      i++;
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      // ── Metadata extraction ─────────────────────────────────
      const attr = (key: string): string => {
        const m = line.match(new RegExp(`${key}="([^"]*)"`, "i"));
        return m ? m[1] : "";
      };
      const displayMatch = line.match(/,([^,\r\n]+)$/);

      const name = attr("tvg-name") || (displayMatch ? displayMatch[1].trim() : "");
      const slug = name ? slugify(name) : null;
      const tvgId = attr("tvg-id");
      const logo = attr("tvg-logo");
      const group = attr("group-title");
      const lang = attr("tvg-language");
      const display = displayMatch ? displayMatch[1].trim() : name;

      // ── KODIPROP scan ───────────────────────────────────────
      let manifestType: ManifestType = "mpd"; // safe default — JioTV is mostly DASH
      const clearkeys: string[] = [];
      let j = i + 1;

      while (j < lines.length) {
        const kl = (lines[j] ?? "").trim();
        if (!kl.startsWith("#KODIPROP:") && !kl.startsWith("#EXTVLCOPT:")) break;

        if (kl.startsWith("#KODIPROP:")) {
          // manifest_type detection
          const mtMatch = kl.match(/inputstream\.adaptive\.manifest_type=(\S+)/i);
          if (mtMatch) manifestType = mtMatch[1].toLowerCase().trim();

          // clearkey collection — comma-separated KID:KEY pairs
          const lkMatch = kl.match(/inputstream\.adaptive\.license_key=([^\s#]+)/i);
          if (lkMatch && !lkMatch[1].startsWith("http")) {
            lkMatch[1].split(",").forEach((pair) => {
              const p = pair.trim();
              if (p.includes(":")) clearkeys.push(p);
            });
          }
        }

        j++;
      }

      const rawUrl = lines[j] ? lines[j].trim() : "";

      if (slug && rawUrl.startsWith("http")) {
        map[slug] = {
          url: rawUrl,
          manifestType,
          clearkey: clearkeys.join(","),
          tvgId,
          logo,
          group,
          lang,
          display,
          name,
        };
      }

      i = j + 1;
      continue;
    }

    i++;
  }

  return map;
}

// ─────────────────────────────────────────────────────────────
// PLAYLIST REWRITER — format-conditional output
//
//   MPD channels:
//     • inputstream.adaptive.manifest_type=mpd
//     • inputstream.adaptive.license_type=clearkey
//     • inputstream.adaptive.license_key=<kid:key,...>   ← preserved
//     • stream URL → /stream?id=<slug>  (302 proxy)
//
//   HLS channels (.m3u8):
//     • inputstream.adaptive.manifest_type=hls
//     • NO license_type, NO license_key                  ← stripped
//     • stream URL → /stream?id=<slug>  (302 proxy)
//
//   Both types:
//     • inputstream=inputstream.adaptive  preserved (Kodi needs it)
//     • All metadata attributes passed through verbatim
// ─────────────────────────────────────────────────────────────

export function rewritePlaylist(channels: ChannelMap, workerBase: string): string {
  const out: string[] = ['#EXTM3U url-tvg="" refresh="300"'];

  for (const [slug, ch] of Object.entries(channels)) {
    const langAttr = ch.lang ? ` tvg-language="${ch.lang}"` : "";

    out.push(
      `#EXTINF:-1 tvg-id="${ch.tvgId}" tvg-logo="${ch.logo}" ` +
        `group-title="${ch.group}"${langAttr},${ch.display}`,
    );

    out.push("#KODIPROP:inputstream=inputstream.adaptive");
    out.push(`#KODIPROP:inputstream.adaptive.manifest_type=${ch.manifestType}`);

    if (ch.manifestType === "mpd") {
      // DASH — clearkey DRM required, write all KID:KEY pairs
      out.push("#KODIPROP:inputstream.adaptive.license_type=clearkey");
      if (ch.clearkey) {
        out.push(`#KODIPROP:inputstream.adaptive.license_key=${ch.clearkey}`);
      }
    }
    // HLS — no DRM lines at all. Clean pass-through.

    out.push(`${workerBase}/stream?id=${encodeURIComponent(slug)}`);
  }

  return out.join("\n");
}