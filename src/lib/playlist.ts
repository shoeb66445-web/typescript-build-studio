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

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function buildChannelMap(raw: string): ChannelMap {
  const lines = raw.split(/\r?\n/);
  const channels: ChannelMap = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line || line === "#EXTM3U") {
      index += 1;
      continue;
    }

    if (!line.startsWith("#EXTINF:")) {
      index += 1;
      continue;
    }

    const getAttribute = (key: string) => {
      const match = line.match(new RegExp(`${key}="([^"]*)"`, "i"));
      return match?.[1] ?? "";
    };
    const displayMatch = line.match(/,([^,\r\n]+)$/);
    const name = getAttribute("tvg-name") || displayMatch?.[1]?.trim() || "";
    const slug = name ? slugify(name) : "";
    const tvgId = getAttribute("tvg-id");
    const logo = getAttribute("tvg-logo");
    const group = getAttribute("group-title");
    const lang = getAttribute("tvg-language");
    const display = displayMatch?.[1]?.trim() || name;

    let manifestType: ManifestType = "mpd";
    const clearkeys: string[] = [];
    let next = index + 1;

    while (next < lines.length) {
      const propertyLine = lines[next]?.trim() ?? "";
      if (!propertyLine.startsWith("#KODIPROP:") && !propertyLine.startsWith("#EXTVLCOPT:")) {
        break;
      }

      if (propertyLine.startsWith("#KODIPROP:")) {
        const manifestMatch = propertyLine.match(
          /inputstream\.adaptive\.manifest_type=(\S+)/i,
        );
        if (manifestMatch?.[1]) manifestType = manifestMatch[1].toLowerCase().trim();

        const licenseMatch = propertyLine.match(
          /inputstream\.adaptive\.license_key=([^\s#]+)/i,
        );
        if (licenseMatch?.[1] && !licenseMatch[1].startsWith("http")) {
          for (const pair of licenseMatch[1].split(",")) {
            const value = pair.trim();
            if (value.includes(":")) clearkeys.push(value);
          }
        }
      }
      next += 1;
    }

    const rawUrl = lines[next]?.trim() ?? "";
    if (slug && rawUrl.startsWith("http")) {
      channels[slug] = {
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

    index = next + 1;
  }

  return channels;
}

export function rewritePlaylist(channels: ChannelMap, workerBase: string): string {
  const output = ['#EXTM3U url-tvg="" refresh="300"'];

  for (const [slug, channel] of Object.entries(channels)) {
    const langAttribute = channel.lang ? ` tvg-language="${channel.lang}"` : "";
    output.push(
      `#EXTINF:-1 tvg-id="${channel.tvgId}" tvg-logo="${channel.logo}" ` +
        `group-title="${channel.group}"${langAttribute},${channel.display}`,
    );
    output.push("#KODIPROP:inputstream=inputstream.adaptive");
    output.push(`#KODIPROP:inputstream.adaptive.manifest_type=${channel.manifestType}`);

    if (channel.manifestType === "mpd") {
      output.push("#KODIPROP:inputstream.adaptive.license_type=clearkey");
      if (channel.clearkey) {
        output.push(`#KODIPROP:inputstream.adaptive.license_key=${channel.clearkey}`);
      }
    }

    output.push(`${workerBase}/stream?id=${encodeURIComponent(slug)}`);
  }

  return output.join("\n");
}