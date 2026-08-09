import { describe, expect, it } from "vitest";
import { createPkceOnlyStorage } from "./auth";

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
