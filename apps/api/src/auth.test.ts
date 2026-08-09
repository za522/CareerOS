import { describe, expect, it, vi } from "vitest";
import {
  AuthError,
  authenticateSupabaseJwt,
  can,
  createLocalDevelopmentActor,
  hashInviteToken,
  requireUsableInvitation,
  requireWorkspacePermission,
  verifyInviteToken,
  type AuthenticatedActor,
  type SupabaseJwtJwksVerifier,
  type WorkspaceInvitation,
  type WorkspaceMembership,
  type WorkspaceRole,
} from "./auth.js";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.signature";
const actor: AuthenticatedActor = { id: "user-1", email: "person@example.com", provider: "supabase" };

function membership(workspaceId: string, role: WorkspaceRole, actorId = actor.id): WorkspaceMembership {
  return { workspaceId, actorId, role };
}

function invitation(overrides: Partial<WorkspaceInvitation> = {}): WorkspaceInvitation {
  return {
    id: "invite-1",
    workspaceId: "workspace-1",
    email: "person@example.com",
    role: "editor",
    tokenHash: hashInviteToken("high-entropy-invite-token"),
    invitedByActorId: "owner-1",
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
    expiresAt: new Date("2026-08-09T12:00:00.000Z"),
    ...overrides,
  };
}

function expectAuthError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("Expected an AuthError");
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(code);
  }
}

describe("workspace authorization", () => {
  it("denies an authenticated but uninvited actor", () => {
    expectAuthError(
      () => requireWorkspacePermission(actor, "workspace-1", "workspace:read", []),
      "WORKSPACE_ACCESS_DENIED",
    );
  });

  it.each([
    ["owner", "workspace:read", true],
    ["owner", "workspace:edit", true],
    ["owner", "members:invite", true],
    ["owner", "members:manage", true],
    ["owner", "workspace:delete", true],
    ["editor", "workspace:read", true],
    ["editor", "workspace:edit", true],
    ["editor", "members:invite", false],
    ["editor", "members:manage", false],
    ["editor", "workspace:delete", false],
    ["viewer", "workspace:read", true],
    ["viewer", "workspace:edit", false],
    ["viewer", "members:invite", false],
    ["viewer", "members:manage", false],
    ["viewer", "workspace:delete", false],
  ] as const)("grants %s permission for %s: %s", (role, action, allowed) => {
    expect(can(role, action)).toBe(allowed);
  });

  it("returns the matching membership when permission is granted", () => {
    const result = requireWorkspacePermission(actor, "workspace-1", "workspace:edit", [
      membership("workspace-1", "editor"),
    ]);
    expect(result.role).toBe("editor");
  });

  it("does not let membership in one workspace authorize another", () => {
    expectAuthError(
      () => requireWorkspacePermission(actor, "workspace-2", "workspace:read", [membership("workspace-1", "owner")]),
      "WORKSPACE_ACCESS_DENIED",
    );
  });

  it("does not let another actor's membership authorize the requester", () => {
    expectAuthError(
      () =>
        requireWorkspacePermission(actor, "workspace-1", "workspace:read", [
          membership("workspace-1", "owner", "user-2"),
        ]),
      "WORKSPACE_ACCESS_DENIED",
    );
  });
});

describe("invitations", () => {
  it("hashes deterministically and verifies only the original token", () => {
    const hash = hashInviteToken("high-entropy-invite-token");
    expect(hash).not.toContain("high-entropy-invite-token");
    expect(verifyInviteToken("high-entropy-invite-token", hash)).toBe(true);
    expect(verifyInviteToken("different-token", hash)).toBe(false);
  });

  it("safely rejects malformed stored hashes", () => {
    expect(verifyInviteToken("high-entropy-invite-token", "not-a-valid-hash")).toBe(false);
    expect(verifyInviteToken("high-entropy-invite-token", "")).toBe(false);
    expect(verifyInviteToken("", hashInviteToken("different-token"))).toBe(false);
  });

  it("accepts an active invitation with normalized email", () => {
    const result = requireUsableInvitation(invitation(), {
      token: "high-entropy-invite-token",
      email: "Person@Example.COM",
      workspaceId: "workspace-1",
      now: NOW,
    });
    expect(result.id).toBe("invite-1");
  });

  it.each([
    ["expired", { expiresAt: NOW }],
    ["revoked", { revokedAt: new Date("2026-08-08T11:00:00.000Z") }],
    ["accepted", { acceptedAt: new Date("2026-08-08T11:00:00.000Z") }],
  ])("rejects an %s invitation", (_label, overrides) => {
    expectAuthError(
      () =>
        requireUsableInvitation(invitation(overrides), {
          token: "high-entropy-invite-token",
          email: "person@example.com",
          workspaceId: "workspace-1",
          now: NOW,
        }),
      "INVITATION_INVALID",
    );
  });

  it.each([
    ["wrong token", { token: "wrong", email: "person@example.com", workspaceId: "workspace-1" }],
    ["wrong email", { token: "high-entropy-invite-token", email: "other@example.com", workspaceId: "workspace-1" }],
    ["empty email", { token: "high-entropy-invite-token", email: " ", workspaceId: "workspace-1" }],
    ["wrong workspace", { token: "high-entropy-invite-token", email: "person@example.com", workspaceId: "workspace-2" }],
  ])("uses the same denial for %s", (_label, input) => {
    expectAuthError(() => requireUsableInvitation(invitation(), { ...input, now: NOW }), "INVITATION_INVALID");
  });
});

describe("authentication", () => {
  it("creates a local actor only in development or test", () => {
    expect(createLocalDevelopmentActor({ id: "dev-1", email: "Dev@Example.com" }, "development")).toEqual({
      id: "dev-1",
      email: "dev@example.com",
      provider: "local-development",
    });
    expectAuthError(() => createLocalDevelopmentActor({}, "production"), "LOCAL_AUTH_DISABLED");
  });

  it("maps verifier-validated Supabase claims to a minimal actor", async () => {
    const verify = vi.fn(async () => ({
      sub: "user-1",
      email: "Person@Example.COM",
      exp: Math.floor(NOW.getTime() / 1000) + 60,
      role: "authenticated",
      sensitiveCustomClaim: "not copied",
    }));
    const result = await authenticateSupabaseJwt(`Bearer ${JWT}`, { verify }, { now: NOW });

    expect(verify).toHaveBeenCalledWith(JWT);
    expect(result).toEqual({ id: "user-1", email: "person@example.com", provider: "supabase" });
  });

  it.each([undefined, "", "Basic abc", "Bearer", "Bearer one.two", "Bearer one..three", "Bearer one.two.three extra"])(
    "rejects a malformed authorization value: %s",
    async (authorization) => {
      const verifier: SupabaseJwtJwksVerifier = { verify: vi.fn() };
      await expect(authenticateSupabaseJwt(authorization, verifier, { now: NOW })).rejects.toMatchObject({
        code: authorization ? "INVALID_AUTH_TOKEN" : "AUTHENTICATION_REQUIRED",
      });
      expect(verifier.verify).not.toHaveBeenCalled();
    },
  );

  it("converts verifier failures to a bounded authentication error", async () => {
    const verifier: SupabaseJwtJwksVerifier = {
      verify: vi.fn(async () => {
        throw new Error("JWKS lookup detail that must not escape");
      }),
    };
    await expect(authenticateSupabaseJwt(`Bearer ${JWT}`, verifier, { now: NOW })).rejects.toMatchObject({
      code: "INVALID_AUTH_TOKEN",
      message: "Authentication token is invalid",
    });
  });

  it("rejects expired, future, and malformed verifier claims", async () => {
    const cases: Array<{ claims: object; code: string }> = [
      { claims: { sub: "user-1", exp: Math.floor(NOW.getTime() / 1000) }, code: "AUTH_TOKEN_EXPIRED" },
      { claims: { sub: "user-1", nbf: Math.floor(NOW.getTime() / 1000) + 1 }, code: "INVALID_AUTH_TOKEN" },
      { claims: { sub: "" }, code: "INVALID_AUTH_TOKEN" },
      { claims: { sub: "user-1", email: 42 }, code: "INVALID_AUTH_TOKEN" },
    ];

    for (const testCase of cases) {
      const verifier = { verify: vi.fn(async () => testCase.claims as never) };
      await expect(authenticateSupabaseJwt(`Bearer ${JWT}`, verifier, { now: NOW })).rejects.toMatchObject({
        code: testCase.code,
      });
    }
  });
});
