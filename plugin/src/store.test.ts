import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RequestUrlParam } from "obsidian";
import { RemoteStore } from "./store";

const requestUrl = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async (orig) => ({ ...(await orig<object>()), requestUrl }));

beforeEach(() => {
  requestUrl.mockReset();
  requestUrl.mockResolvedValue({ status: 200, text: "run-1" });
});

const sent = (): RequestUrlParam => requestUrl.mock.calls[0]![0] as RequestUrlParam;

describe("getText", () => {
  it("leaves immutable keys cacheable", async () => {
    await new RemoteStore({ baseUrl: "https://s.example/" }).getText("manifests/42/run-1.json");

    expect(sent().url).toBe("https://s.example/manifests/42/run-1.json");
    expect(sent().headers).toBeUndefined();
  });

  it("goes past every cache when asked for a fresh read", async () => {
    // Garage serves `latest` with no Cache-Control, so without this a run
    // published since the last read stays invisible for hours.
    await new RemoteStore({ baseUrl: "https://s.example", bucket: "b" }).getText("manifests/42/latest", { fresh: true });

    expect(sent().url).toMatch(/^https:\/\/s\.example\/b\/manifests\/42\/latest\?t=\d+$/);
    expect(sent().headers).toEqual({ "Cache-Control": "no-cache" });
  });
});
