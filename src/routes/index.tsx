import { createFileRoute } from "@tanstack/react-router";
import { Check, ClipboardCopy, Radio, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { buildChannelMap, rewritePlaylist } from "@/lib/playlist";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Playlist Relay — M3U editor" },
      {
        name: "description",
        content: "Parse M3U channels and preview a rewritten playlist for your stream relay.",
      },
      { property: "og:title", content: "Playlist Relay — M3U editor" },
      {
        property: "og:description",
        content: "Parse M3U channels and preview a rewritten playlist for your stream relay.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PlaylistWorkbench,
});

function PlaylistWorkbench() {
  const [source, setSource] = useState("");
  const [workerUrl, setWorkerUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const channels = useMemo(() => buildChannelMap(source), [source]);
  const output = useMemo(
    () => rewritePlaylist(channels, workerUrl.trim().replace(/\/$/, "")),
    [channels, workerUrl],
  );
  const channelList = Object.values(channels);
  const mpdCount = channelList.filter((channel) => channel.manifestType === "mpd").length;
  const hlsCount = channelList.filter((channel) => channel.manifestType === "hls").length;

  const copyPlaylist = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const clearPlaylist = () => {
    setSource("");
    setCopied(false);
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <a href="/" className="flex items-center gap-3 text-foreground no-underline">
            <span className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Radio className="size-5" aria-hidden="true" />
            </span>
            <span className="text-base font-semibold">Playlist Relay</span>
          </a>
          <span className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span className="size-2 rounded-full bg-status-online" />
            M3U WORKSPACE
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-5 pb-12 pt-10 sm:px-8 sm:pt-14">
        <section className="mb-10 flex flex-col justify-between gap-7 lg:flex-row lg:items-end">
          <div className="max-w-2xl">
            <p className="mb-3 text-xs font-semibold text-primary">STREAM TOOLKIT / 01</p>
            <h1 className="text-3xl font-semibold leading-tight sm:text-4xl">
              Shape your playlist.
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
              Parse channel metadata and preview a relay-ready M3U playlist.
            </p>
          </div>

          <label className="w-full max-w-md text-xs font-medium text-muted-foreground">
            WORKER ADDRESS
            <input
              aria-label="Worker address"
              className="mt-2 h-11 w-full rounded-md border border-input bg-input-surface px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setWorkerUrl(event.target.value)}
              placeholder="https://your-worker.workers.dev"
              spellCheck={false}
              type="url"
              value={workerUrl}
            />
          </label>
        </section>

        <section
          aria-label="Playlist summary"
          className="mb-6 flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-border py-4"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">{channelList.length}</span>
            <span className="text-xs text-muted-foreground">channels parsed</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-status-mpd" />
            <span>
              <strong className="font-semibold text-foreground">{mpdCount}</strong> DASH
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-status-hls" />
            <span>
              <strong className="font-semibold text-foreground">{hlsCount}</strong> HLS
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button
              aria-label="Clear playlist"
              className="size-9"
              disabled={!source}
              onClick={clearPlaylist}
              size="icon"
              title="Clear playlist"
              variant="ghost"
            >
              <RotateCcw aria-hidden="true" />
            </Button>
            <Button disabled={!channelList.length} onClick={copyPlaylist} size="sm">
              {copied ? <Check aria-hidden="true" /> : <ClipboardCopy aria-hidden="true" />}
              {copied ? "Copied" : "Copy playlist"}
            </Button>
          </div>
        </section>

        <section
          className="grid gap-5 lg:grid-cols-2"
          aria-label="Playlist editor and preview"
        >
          <div className="min-w-0">
            <div className="mb-3 flex items-center justify-between gap-3">
              <label htmlFor="playlist-source" className="text-sm font-medium">
                Source playlist
              </label>
              <span className="text-xs text-muted-foreground">M3U / M3U8</span>
            </div>
            <Textarea
              id="playlist-source"
              aria-label="Source playlist"
              autoCapitalize="off"
              autoComplete="off"
              className="min-h-[430px] resize-y rounded-md border-border bg-editor p-4 font-mono text-xs leading-6 text-foreground placeholder:text-muted-foreground focus-visible:ring-ring"
              onChange={(event) => setSource(event.target.value)}
              placeholder={'#EXTM3U\n#EXTINF:-1 tvg-id="channel.id" group-title="News",Channel name\n#KODIPROP:inputstream.adaptive.manifest_type=mpd\n#KODIPROP:inputstream.adaptive.license_key=kid:key\nhttps://example.com/channel.mpd'}
              spellCheck={false}
              value={source}
            />
          </div>

          <div className="min-w-0">
            <div className="mb-3 flex items-center justify-between gap-3">
              <label htmlFor="playlist-output" className="text-sm font-medium">
                Rewritten playlist
              </label>
              <span className="text-xs text-muted-foreground">LIVE PREVIEW</span>
            </div>
            <Textarea
              id="playlist-output"
              aria-label="Rewritten playlist"
              className="min-h-[430px] resize-y rounded-md border-border bg-editor p-4 font-mono text-xs leading-6 text-secondary-foreground placeholder:text-muted-foreground focus-visible:ring-ring"
              placeholder="Your rewritten playlist will appear here."
              readOnly
              value={channelList.length ? output : ""}
            />
          </div>
        </section>

        {channelList.length > 0 && (
          <section className="mt-8 border-t border-border pt-5" aria-label="Parsed channels">
            <h2 className="mb-4 text-xs font-semibold text-muted-foreground">
              CHANNELS IN PLAYLIST
            </h2>
            <ul className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
              {channelList.map((channel) => (
                <li
                  key={`${channel.name}-${channel.url}`}
                  className="flex min-w-0 items-center justify-between gap-4 border-b border-border py-3"
                >
                  <span className="truncate text-sm">{channel.display}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {channel.manifestType.toUpperCase()}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}