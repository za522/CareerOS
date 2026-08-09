import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { createPkceOnlyStorage, exchangeOAuthCallback } from "./auth";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("hosted PKCE browser storage", () => {
  it("persists redirect verifiers while refusing access and refresh sessions", () => {
    const backing = memoryStorage();
    const storage = createPkceOnlyStorage(backing);
    storage.setItem("sb-project-auth-token", JSON.stringify({ access_token: "access", refresh_token: "refresh" }));
    storage.setItem("sb-project-auth-token-flow-login-code-verifier", "verifier-value");
    storage.setItem("sb-project-auth-token-flows-code-verifier", "[\"login\"]");

    expect(storage.getItem("sb-project-auth-token")).toBeNull();
    expect(backing.values.has("sb-project-auth-token")).toBe(false);
    expect(storage.getItem("sb-project-auth-token-flow-login-code-verifier")).toBe("verifier-value");
    expect(storage.getItem("sb-project-auth-token-flows-code-verifier")).toBe("[\"login\"]");
  });

  it("removes only verifier records", () => {
    const backing = memoryStorage();
    backing.values.set("unrelated", "keep");
    backing.values.set("sb-project-code-verifier", "remove");
    const storage = createPkceOnlyStorage(backing);
    storage.removeItem("unrelated");
    storage.removeItem("sb-project-code-verifier");
    expect(backing.values.get("unrelated")).toBe("keep");
    expect(backing.values.has("sb-project-code-verifier")).toBe(false);
  });
});

describe("hosted OAuth callback", () => {
  it("explicitly exchanges the one-time code before removing it from the address bar", async () => {
    const session = { access_token: "access", refresh_token: "refresh-token-value" } as Session;
    const exchangeCodeForSession = vi.fn().mockResolvedValue({ data: { session }, error: null });
    const replaceUrl = vi.fn();
    const authClient = { auth: { exchangeCodeForSession } } as unknown as SupabaseClient;

    await expect(exchangeOAuthCallback(
      authClient,
      "https://careeros.example/?view=tracker&code=one-time-code",
      replaceUrl,
    )).resolves.toBe(session);

    expect(exchangeCodeForSession).toHaveBeenCalledWith("one-time-code");
    expect(replaceUrl).toHaveBeenCalledWith("/?view=tracker");
  });

  it("surfaces provider errors and removes sensitive callback parameters", async () => {
    const replaceUrl = vi.fn();
    const authClient = { auth: { exchangeCodeForSession: vi.fn() } } as unknown as SupabaseClient;

    await expect(exchangeOAuthCallback(
      authClient,
      "https://careeros.example/?error=access_denied&error_description=Access+denied",
      replaceUrl,
    )).rejects.toThrow("Access denied");

    expect(replaceUrl).toHaveBeenCalledWith("/");
    expect(authClient.auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });
});
