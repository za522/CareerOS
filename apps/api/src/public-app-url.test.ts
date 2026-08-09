import { describe, expect, it, vi } from "vitest";
import { preflightPublicAppUrl } from "./public-app-url.js";
import type { UrlCaptureDependencies } from "./importer.js";

function response(status: number, headers: Record<string, string> = {}, body = "<html><body>CareerOS</body></html>") {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: [new TextEncoder().encode(body)],
    destroy: vi.fn(),
  };
}

const publicLookup: NonNullable<UrlCaptureDependencies["lookup"]> = async () => [{ address: "93.184.216.34", family: 4 }];

describe("public CareerOS URL preflight", () => {
  it("confirms a reachable public HTML page", async () => {
    const request = vi.fn(async () => response(200, { "content-type": "text/html" }));
    await expect(preflightPublicAppUrl("https://careeros.example/app", { lookup: publicLookup, request }))
      .resolves.toEqual({ url: "https://careeros.example/app", reachable: true });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects private and locally resolved destinations before making a request", async () => {
    const request = vi.fn(async () => response(200, { "content-type": "text/html" }));
    await expect(preflightPublicAppUrl("http://127.0.0.1:5173", { lookup: publicLookup, request })).rejects.toThrow(/reached safely/i);
    await expect(preflightPublicAppUrl("https://careeros.example", {
      lookup: async () => [{ address: "10.0.0.4", family: 4 }], request,
    })).rejects.toThrow(/private|reserved/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("revalidates every redirect and rejects a redirect into a private network", async () => {
    const request = vi.fn(async () => response(302, { location: "http://169.254.169.254/latest/meta-data" }));
    await expect(preflightPublicAppUrl("https://careeros.example", { lookup: publicLookup, request })).rejects.toThrow(/private|reserved/i);
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects unreachable, oversized and non-page responses", async () => {
    await expect(preflightPublicAppUrl("https://careeros.example", {
      lookup: publicLookup,
      request: async () => response(503, { "content-type": "text/html" }),
    })).rejects.toThrow(/HTTP 503/i);
    await expect(preflightPublicAppUrl("https://careeros.example", {
      lookup: publicLookup,
      request: async () => response(200, { "content-type": "application/octet-stream" }),
    })).rejects.toThrow(/not a readable HTML or text page/i);
    await expect(preflightPublicAppUrl("https://careeros.example", {
      lookup: publicLookup,
      request: async () => response(200, { "content-type": "text/html", "content-length": "2000001" }),
    })).rejects.toThrow(/too large/i);
  });
});
