import { describe, expect, it } from "vitest";

import worker from "../../worker/index";

const context = { waitUntil: () => undefined };

describe("playlist worker HTTP handling", () => {
  it("answers CORS preflight requests without contacting the upstream playlist", async () => {
    const response = await worker.fetch(
      new Request("https://relay.test/playlist.m3u", { method: "OPTIONS" }),
      {},
      context,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns a not found response for unknown paths", async () => {
    const response = await worker.fetch(new Request("https://relay.test/unknown"), {}, context);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});