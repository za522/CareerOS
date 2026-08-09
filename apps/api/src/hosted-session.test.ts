import { describe, expect, it, vi } from "vitest";
import { HostedSessionService, decodeSessionKey, openRefreshToken, sealRefreshToken } from "./hosted-session.js";

const keyValue = Buffer.alloc(32, 9).toString("base64");

describe("hosted browser sessions", () => {
  it("fails before transmitting credentials when hosted identity configuration is incomplete or insecure", () => {
    expect(() => new HostedSessionService({ env: {
      CAREEROS_HOSTED: "1", CAREEROS_SESSION_ENCRYPTION_KEY: keyValue, SUPABASE_URL: "http://example.test", SUPABASE_ANON_KEY: "anon-key",
    } })).toThrow(/HTTPS SUPABASE_URL/);
    expect(() => new HostedSessionService({ env: {
      CAREEROS_HOSTED: "1", CAREEROS_SESSION_ENCRYPTION_KEY: keyValue, SUPABASE_URL: "https://example.supabase.co",
    } })).toThrow(/SUPABASE_URL and SUPABASE_ANON_KEY/);
  });

  it("encrypts refresh tokens with authenticated encryption", () => {
    const key = decodeSessionKey(keyValue);
    const sealed = sealRefreshToken("refresh-token-value", key);
    expect(sealed).not.toContain("refresh-token-value");
    expect(openRefreshToken(sealed, key)).toBe("refresh-token-value");
    const tampered = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;
    expect(() => openRefreshToken(tampered, key)).toThrow();
  });

  it("rotates through Supabase and emits a secure HttpOnly cookie", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: "access-token-value", refresh_token: "rotated-refresh-token-value", token_type: "bearer",
      expires_in: 3600, user: { id: "user-1", email: "owner@example.com" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new HostedSessionService({ env: {
      NODE_ENV: "production", CAREEROS_HOSTED: "1", CAREEROS_SESSION_ENCRYPTION_KEY: keyValue,
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon-key",
    }, fetch: fetchMock as typeof fetch });
    const session = await service.rotate("short-token");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.supabase.co/auth/v1/token?grant_type=refresh_token",
      expect.objectContaining({ body: JSON.stringify({ refresh_token: "short-token" }) }),
    );
    expect(session.access_token).toBe("access-token-value");
    expect(service.publicSession(session)).not.toHaveProperty("refresh_token");
    const cookie = service.cookie(session, true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("rotated-refresh-token-value");
    const encrypted = cookie.match(/^careeros_session=([^;]+)/)?.[1] ?? "";
    expect(service.refreshTokenFromCookie(encrypted)).toBe("rotated-refresh-token-value");
  });

  it("distinguishes an expired identity session from a temporary provider failure", async () => {
    const env = {
      CAREEROS_HOSTED: "1", CAREEROS_SESSION_ENCRYPTION_KEY: keyValue,
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon-key",
    };
    const expired = new HostedSessionService({ env, fetch: vi.fn(async () => new Response("{}", { status: 400 })) as typeof fetch });
    const unavailable = new HostedSessionService({ env, fetch: vi.fn(async () => new Response("{}", { status: 503 })) as typeof fetch });

    await expect(expired.rotate("expired-token")).rejects.toMatchObject({ statusCode: 401 });
    await expect(unavailable.rotate("valid-token")).rejects.toMatchObject({ statusCode: 503 });
  });
});
