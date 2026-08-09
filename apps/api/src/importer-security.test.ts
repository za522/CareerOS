import { describe, expect, it, vi } from "vitest";
import { assertSafePublicUrl, capturePastedText, captureUrl, type UrlCaptureDependencies } from "./importer.js";

const encoder = new TextEncoder();

function response(status: number, body = "", headers: Record<string, string> = { "content-type": "text/plain" }) {
  const destroy = vi.fn();
  return {
    status,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    body: [encoder.encode(body)],
    destroy,
  };
}

function publicLookup(address = "93.184.216.34"): NonNullable<UrlCaptureDependencies["lookup"]> {
  return vi.fn(async () => [{ address, family: address.includes(":") ? 6 as const : 4 as const }]);
}

describe("public URL importer security", () => {
  it.each([
    "file:///etc/passwd",
    "ftp://example.com/jobs",
    "http://user:password@example.com/jobs",
    "http://localhost/jobs",
    "http://service.local/jobs",
    "http://service.internal/jobs",
    "http://127.0.0.1/jobs",
    "http://0.0.0.0/jobs",
    "http://10.0.0.1/jobs",
    "http://100.64.0.1/jobs",
    "http://169.254.169.254/latest/meta-data",
    "http://172.31.0.1/jobs",
    "http://192.168.1.1/jobs",
    "http://192.0.2.1/jobs",
    "http://198.51.100.1/jobs",
    "http://203.0.113.1/jobs",
    "http://224.0.0.1/jobs",
    "http://[::1]/jobs",
    "http://[fc00::1]/jobs",
    "http://[fe80::1]/jobs",
    "http://[2001:db8::1]/jobs",
    "http://[::ffff:127.0.0.1]/jobs",
  ])("rejects unsafe literal URL %s", (url) => {
    expect(() => assertSafePublicUrl(url)).toThrow();
  });

  it.each([
    ["10.1.2.3", 4],
    ["169.254.169.254", 4],
    ["::1", 6],
    ["fd00::1", 6],
    ["fe80::1234", 6],
    ["2001:db8::1234", 6],
    ["::ffff:192.168.1.4", 6],
  ] as const)("rejects a hostname resolving to %s", async (address, family) => {
    const request = vi.fn();
    await expect(captureUrl("https://jobs.example.com/role", {
      lookup: async () => [{ address, family }],
      request,
    })).rejects.toThrow(/private|reserved/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects the entire hostname when any DNS answer is unsafe", async () => {
    const request = vi.fn();
    await expect(captureUrl("https://jobs.example.com/role", {
      lookup: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
      request,
    })).rejects.toThrow(/private|reserved/i);
    expect(request).not.toHaveBeenCalled();
  });

  it("pins the request to the validated DNS address", async () => {
    const request = vi.fn(async (_url, address) => response(200, "Public job"));
    const captured = await captureUrl("https://jobs.example.com/role", {
      lookup: publicLookup("2606:2800:220:1:248:1893:25c8:1946"),
      request,
    });
    expect(captured.rawText).toBe("Public job");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toEqual({ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 });
  });

  it("resolves and validates every redirect hop before requesting it", async () => {
    const lookup = vi.fn(async (hostname: string) => hostname === "public.example.com"
      ? [{ address: "93.184.216.34", family: 4 as const }]
      : [{ address: "169.254.169.254", family: 4 as const }]);
    const request = vi.fn(async () => response(302, "", { location: "http://metadata.example.net/latest" }));

    await expect(captureUrl("https://public.example.com/jobs", { lookup, request })).rejects.toThrow(/private|reserved/i);
    expect(lookup).toHaveBeenCalledWith("public.example.com");
    expect(lookup).toHaveBeenCalledWith("metadata.example.net");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect directly to a private literal without resolving it", async () => {
    const lookup = publicLookup();
    const request = vi.fn(async () => response(302, "", { location: "http://127.0.0.1/admin" }));
    await expect(captureUrl("https://public.example.com/jobs", { lookup, request })).rejects.toThrow(/private|reserved/i);
    expect(request).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("caps redirect chains", async () => {
    const request = vi.fn(async (url: URL) => response(302, "", { location: `/hop-${Number(url.pathname.split("-")[1] ?? 0) + 1}` }));
    await expect(captureUrl("https://jobs.example.com/hop-0", { lookup: publicLookup(), request })).rejects.toThrow("redirected too many times");
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("rejects unsupported response content types before reading the body", async () => {
    const rejected = response(200, "%PDF", { "content-type": "application/pdf" });
    await expect(captureUrl("https://jobs.example.com/file", {
      lookup: publicLookup(),
      request: async () => rejected,
    })).rejects.toThrow(/not a readable HTML or text page/i);
    expect(rejected.destroy).toHaveBeenCalled();
  });

  it("caps bodies even when content-length is absent", async () => {
    const oversized = response(200, "", { "content-type": "text/plain" });
    oversized.body = [new Uint8Array(1_500_000), new Uint8Array(600_000)];
    await expect(captureUrl("https://jobs.example.com/large", {
      lookup: publicLookup(),
      request: async () => oversized,
    })).rejects.toThrow(/too large/i);
    expect(oversized.destroy).toHaveBeenCalled();
  });

  it("returns a readable timeout error without retrying an unsafe fallback", async () => {
    const timeout = new Error("aborted");
    timeout.name = "AbortError";
    await expect(captureUrl("https://jobs.example.com/slow", {
      lookup: publicLookup(),
      request: async () => { throw timeout; },
    })).rejects.toThrow(/too long to respond/i);
  });

  it("propagates an external cancellation to an in-flight URL request", async () => {
    const controller = new AbortController();
    const request = vi.fn(async (_url: URL, _address: unknown, signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
      });
      return response(200, "unreachable");
    });
    const capture = captureUrl("https://jobs.example.com/slow", { lookup: publicLookup(), request }, controller.signal);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(capture).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not alter pasted-text capture", () => {
    expect(capturePastedText("  Role: Analyst\nCompany: Example  ")).toEqual({
      url: null,
      sourceType: "pasted_text",
      rawText: "Role: Analyst\nCompany: Example",
      metadata: {},
    });
  });
});
