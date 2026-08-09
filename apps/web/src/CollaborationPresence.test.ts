import { describe, expect, it } from "vitest";
import { canonicalCursor, canonicalPresence } from "./CollaborationPresence";

const members = [{
  id: "member-1",
  email: "owner@example.com",
  displayName: "Zain Ahmad",
  avatarUrl: "",
  role: "owner" as const,
  joinedAt: "2026-08-09T00:00:00.000Z",
}];

describe("collaboration identity canonicalisation", () => {
  it("rejects unknown identities and ignores member-supplied labels", () => {
    expect(canonicalPresence({ userId: "attacker", name: "Zain Ahmad" }, members)).toBeNull();
    expect(canonicalPresence({ userId: "member-1", name: "Impostor", color: "red", path: "/jobs" }, members)).toMatchObject({
      userId: "member-1",
      name: "Zain Ahmad",
      path: "/jobs",
    });
  });

  it("bounds cursor positions and rejects malformed coordinates", () => {
    expect(canonicalCursor({ userId: "member-1", x: 7, y: -2 }, members)).toMatchObject({ x: 1, y: 0 });
    expect(canonicalCursor({ userId: "member-1", x: Number.NaN, y: 0 }, members)).toBeNull();
  });
});
