import { describe, expect, it } from "vitest";
import {
  matchAlertRules,
  normalizeRole,
  parseAshbyResponse,
  parseGreenhouseResponse,
  parseLeverResponse,
  reconcileDiscoveryRun,
  runSource,
  type RoleObservation,
  type SourceRole,
  type SourceRunResult,
} from "./discovery.js";

const context = { sourceId: "acme-greenhouse", provider: "greenhouse", organization: "Acme" } as const;
const role = (overrides: Partial<SourceRole> = {}): SourceRole => ({
  externalId: "job-1",
  title: "Product Designer",
  location: "Singapore",
  team: "Design",
  employmentType: "Full-time",
  sourceUrl: "https://boards.example/acme/jobs/1?ref=feed",
  postedAt: "2026-07-01T08:00:00Z",
  ...overrides,
});

function success(roles: SourceRole[]): Array<SourceRunResult & { organization: string }> {
  return [{ sourceId: context.sourceId, provider: context.provider, organization: context.organization, ok: true, roles }];
}

function run(previous: RoleObservation[], roles: SourceRole[], observedAt: string, removalThreshold = 3) {
  return reconcileDiscoveryRun({ previous, sources: success(roles), observedAt, removalThreshold });
}

describe("public provider parsers", () => {
  it("parses Greenhouse fields without depending on networking", () => {
    const roles = parseGreenhouseResponse({ jobs: [{
      id: 42,
      title: "Staff Engineer",
      absolute_url: "https://boards.greenhouse.io/acme/jobs/42",
      location: { name: "Remote" },
      departments: [{ name: "Platform" }],
      first_published: "2026-05-21T09:00:00Z",
      created_at: "2026-06-01T10:00:00Z",
      updated_at: "2026-07-28T14:30:00Z",
      content: "<p>Build reliable systems. Applications close 12 August 2026.</p>",
    }] });

    expect(roles[0]).toMatchObject({
      externalId: "42", title: "Staff Engineer", location: "Remote", team: "Platform",
      postedAt: "2026-05-21T09:00:00.000Z",
      updatedAt: "2026-07-28T14:30:00.000Z",
      deadlineAt: "2026-08-12T00:00:00.000Z",
    });
  });

  it("does not substitute a Greenhouse update timestamp for a missing publication timestamp", () => {
    const [role] = parseGreenhouseResponse({ jobs: [{
      id: 43, title: "Quant Researcher", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/43",
      first_published: "not-a-date", created_at: "2026-04-01T08:00:00Z", updated_at: "2026-08-01T08:00:00Z",
    }] });
    expect(role).toMatchObject({ postedAt: "2026-04-01T08:00:00.000Z", updatedAt: "2026-08-01T08:00:00.000Z" });
    const [withoutCreated] = parseGreenhouseResponse({ jobs: [{
      id: 44, title: "Trader", absolute_url: "https://job-boards.greenhouse.io/acme/jobs/44", updated_at: "2026-08-02T08:00:00Z",
    }] });
    expect(withoutCreated.postedAt).toBeNull();
    expect(withoutCreated.updatedAt).toBe("2026-08-02T08:00:00.000Z");
  });

  it("parses Lever fields and millisecond posting dates", () => {
    const roles = parseLeverResponse([{
      id: "lever-7",
      text: "Design Engineer",
      hostedUrl: "https://jobs.lever.co/acme/lever-7",
      applyUrl: "https://jobs.lever.co/acme/lever-7/apply",
      createdAt: Date.parse("2026-06-05T09:30:00Z"),
      categories: { location: "London", team: "Hardware", commitment: "Permanent" },
      descriptionPlain: "Make physical products.",
    }]);

    expect(roles[0]).toMatchObject({
      externalId: "lever-7", title: "Design Engineer", location: "London",
      team: "Hardware", employmentType: "Permanent", postedAt: "2026-06-05T09:30:00.000Z",
    });
  });

  it("parses listed Ashby jobs and their direct application links", () => {
    const roles = parseAshbyResponse({ jobs: [{
      id: "ashby-1", title: "Quantitative Analyst Intern", location: "London", department: "Research",
      employmentType: "FullTime", publishedAt: "2026-08-08T09:30:00Z", isListed: true,
      jobUrl: "https://jobs.ashbyhq.com/example/ashby-1", applyUrl: "https://jobs.ashbyhq.com/example/ashby-1/application",
      descriptionPlain: "Recent graduates may apply.",
    }, {
      id: "hidden", title: "Hidden role", isListed: false, jobUrl: "https://jobs.ashbyhq.com/example/hidden",
    }] });
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ externalId: "ashby-1", title: "Quantitative Analyst Intern", location: "London", team: "Research", postedAt: "2026-08-08T09:30:00.000Z" });
  });

  it("rejects malformed or non-HTTP provider links before persistence", () => {
    expect(() => parseGreenhouseResponse({ jobs: [{ id: "unsafe", title: "Role", absolute_url: "javascript:alert(1)" }] }))
      .toThrow(/public HTTP or HTTPS URL/);
    expect(() => parseLeverResponse([{ id: "unsafe", text: "Role", hostedUrl: "https://jobs.lever.co/acme/unsafe", applyUrl: "file:///tmp/job" }]))
      .toThrow(/public HTTP or HTTPS URL/);
  });

  it("parses common deadline wording without normalising impossible or ambiguous dates", () => {
    const parse = (content: string) => parseGreenhouseResponse({ jobs: [{ id: content, title: "Role", absolute_url: "https://jobs.example/role", content }] })[0].deadlineAt;
    expect(parse("Applications close August 12, 2026.")).toBe("2026-08-12T00:00:00.000Z");
    expect(parse("Applications will close on 12 August 2026.")).toBe("2026-08-12T00:00:00.000Z");
    expect(parse("Closing date: 12 August 2026.")).toBe("2026-08-12T00:00:00.000Z");
    expect(parse("Apply by 31/02/2026.")).toBeNull();
  });

  it("keeps source adapters provider-neutral and captures failures", async () => {
    const result = await runSource({
      sourceId: "custom-1",
      provider: "custom",
      organization: "Acme",
      fetch: async () => { throw new Error("rate limited"); },
      parse: () => [],
    });
    expect(result).toEqual({ sourceId: "custom-1", provider: "custom", ok: false, error: "rate limited" });
  });
});

describe("normalization and discovery observations", () => {
  it("preserves functional apply query parameters while removing tracking parameters", () => {
    const normalized = normalizeRole(role({
      sourceUrl: "https://jobs.example/apply?job=123&locale=en&utm_source=feed#details",
      applyUrl: "https://jobs.example/apply?job=123&locale=en&gclid=tracking",
    }), context);
    expect(normalized.sourceUrl).toBe("https://jobs.example/apply?job=123&locale=en");
    expect(normalized.applyUrl).toBe("https://jobs.example/apply?job=123&locale=en");
  });

  it("rejects non-web and malformed discovered role URLs", () => {
    expect(() => normalizeRole(role({ sourceUrl: "javascript:alert(1)", applyUrl: "javascript:alert(1)" }), context)).toThrow(/HTTP or HTTPS/);
    expect(() => normalizeRole(role({ sourceUrl: "not a URL", applyUrl: "not a URL" }), context)).toThrow(/invalid URL/);
  });
  it("deduplicates repeat results and preserves posted, first-seen, and last-seen semantics", () => {
    const first = run([], [role(), role({ title: " Product   Designer " })], "2026-08-01T00:00:00Z");
    expect(first.observations).toHaveLength(1);
    expect(first.summary).toMatchObject({ received: 2, unique: 1, created: 1 });
    expect(first.observations[0]).toMatchObject({
      postedAt: "2026-07-01T08:00:00.000Z",
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-08-01T00:00:00.000Z",
    });

    const second = run(first.observations, [role()], "2026-08-03T00:00:00Z");
    expect(second.summary.unchanged).toBe(1);
    expect(second.observations[0]).toMatchObject({
      postedAt: "2026-07-01T08:00:00.000Z",
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-08-03T00:00:00.000Z",
    });
  });

  it("does not report a repeat role as changed when transient adapter hints are not persisted", () => {
    const first = run([], [role()], "2026-08-01T00:00:00Z");
    const reconstructed = first.observations.map((item) => ({ ...item, team: "", employmentType: "" }));
    const second = run(reconstructed, [role()], "2026-08-01T01:00:00Z");
    expect(second.summary).toMatchObject({ updated: 0, unchanged: 1 });
  });

  it("does not mark or close roles when their source fails", () => {
    const first = run([], [role()], "2026-08-01T00:00:00Z");
    const failed = reconcileDiscoveryRun({
      previous: first.observations,
      observedAt: "2026-08-02T00:00:00Z",
      removalThreshold: 2,
      sources: [{ ...context, ok: false, error: "temporary upstream failure" }],
    });

    expect(failed.observations).toEqual(first.observations);
    expect(failed.summary).toMatchObject({ sourceFailed: 1, markedMissing: 0, closed: 0 });
  });

  it("requires consecutive successful removals to reach the close threshold", () => {
    const first = run([], [role()], "2026-08-01T00:00:00Z", 2);
    const missing = run(first.observations, [], "2026-08-02T00:00:00Z", 2);
    expect(missing.observations[0]).toMatchObject({ status: "missing", missingRuns: 1, closedAt: null });
    expect(missing.summary.markedMissing).toBe(1);

    const closed = run(missing.observations, [], "2026-08-03T00:00:00Z", 2);
    expect(closed.observations[0]).toMatchObject({
      status: "closed", missingRuns: 2, closedAt: "2026-08-03T00:00:00.000Z",
      lastSeenAt: "2026-08-01T00:00:00.000Z",
    });
    expect(closed.summary.closed).toBe(1);
  });

  it("restores a role while retaining its original first-seen and posted dates", () => {
    const first = run([], [role()], "2026-08-01T00:00:00Z", 2);
    const missing = run(first.observations, [], "2026-08-02T00:00:00Z", 2);
    const closed = run(missing.observations, [], "2026-08-03T00:00:00Z", 2);
    const restored = run(closed.observations, [role()], "2026-08-10T00:00:00Z", 2);

    expect(restored.summary.restored).toBe(1);
    expect(restored.observations[0]).toMatchObject({
      status: "open", missingRuns: 0, closedAt: null,
      postedAt: "2026-07-01T08:00:00.000Z",
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-08-10T00:00:00.000Z",
    });
  });
});

describe("alert matching", () => {
  it("matches all configured constraints and ignores disabled rules", () => {
    const normalized = normalizeRole(role({ location: "Remote - Singapore" }), context);
    const matches = matchAlertRules([normalized], [
      { id: "design-remote", organizations: ["acme"], titleIncludes: ["designer"], locations: ["singapore"], teams: ["design"], remoteOnly: true },
      { id: "exclude-senior", titleExcludes: ["product"] },
      { id: "disabled", enabled: false },
    ]);
    expect(matches.map((match) => match.ruleId)).toEqual(["design-remote"]);
  });
});
