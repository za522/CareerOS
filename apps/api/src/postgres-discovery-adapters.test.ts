import { describe, expect, it, vi } from "vitest";
import type { HostedDiscoveryClaim } from "./postgres-discovery-repository.js";
import { createHostedAtsFetcher } from "./postgres-discovery-adapters.js";

function claim(kind: "greenhouse" | "lever" | "ashby", sourceUrl: string): HostedDiscoveryClaim {
  return {
    source: {
      id: "source-1", name: "Source", kind, companyName: "Example Capital", sourceUrl, externalKey: "example",
      enabled: true, checkIntervalMinutes: 180, lastCheckedAt: null, lastSuccessfulAt: null, lastError: "",
      successfulInventoryCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 1,
    },
    leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    runId: "run-1",
    startedAt: new Date().toISOString(),
  };
}

describe("hosted public ATS adapters", () => {
  it("fetches and maps a complete Greenhouse inventory", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ jobs: [{
      id: 42, title: "Graduate Quant Trader", absolute_url: "https://job-boards.greenhouse.io/example/jobs/42",
      location: { name: "London" }, first_published: "2026-05-21T09:00:00Z", created_at: "2026-05-20T10:00:00Z",
      updated_at: "2026-07-28T14:30:00Z", content: "Quant trading graduate role.",
    }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await createHostedAtsFetcher({ fetch })(claim("greenhouse", "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true"));
    expect(result.inventoryComplete).toBe(true);
    expect(result.observations[0]).toMatchObject({
      externalId: "42", companyName: "Example Capital", title: "Graduate Quant Trader", location: "London",
      roleFamily: "Quantitative research", sourcePostedAt: "2026-05-21T09:00:00.000Z", sourceUpdatedAt: "2026-07-28T14:30:00.000Z",
    });
  });

  it("fetches and maps a Lever inventory", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([{
      id: "lever-1", text: "Software Engineering Intern", hostedUrl: "https://jobs.lever.co/example/lever-1",
      applyUrl: "https://jobs.lever.co/example/lever-1/apply", categories: { location: "Singapore", team: "Technology" },
    }]), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await createHostedAtsFetcher({ fetch })(claim("lever", "https://api.lever.co/v0/postings/example?mode=json"));
    expect(result.observations[0]).toMatchObject({ externalId: "lever-1", programme: "Internship", roleFamily: "Engineering" });
  });

  it("fetches and classifies an Ashby early-career inventory", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ jobs: [{
      id: "ashby-1", title: "Investment Analyst", location: "London", department: "Investments",
      employmentType: "FullTime", publishedAt: "2026-08-08T09:30:00Z", isListed: true,
      jobUrl: "https://jobs.ashbyhq.com/example/ashby-1", applyUrl: "https://jobs.ashbyhq.com/example/ashby-1/application",
      descriptionPlain: "This role is open to recent graduates and offers visa sponsorship.",
    }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await createHostedAtsFetcher({ fetch })(claim("ashby", "https://api.ashbyhq.com/posting-api/job-board/example"));
    expect(result.observations[0]).toMatchObject({ externalId: "ashby-1", programme: "Entry-level", sponsorship: "Yes", location: "London" });
  });

  it("does not infer a senior programme from internship boilerplate", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ jobs: [{
      id: 42, title: "Senior DevOps Engineer", absolute_url: "https://job-boards.greenhouse.io/example/jobs/42",
      content: "We also run a summer internship programme.",
    }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await createHostedAtsFetcher({ fetch })(claim("greenhouse", "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true"));
    expect(result.observations[0]?.programme).toBe("");
  });

  it("marks provider-declared pagination and truncated totals as partial", async () => {
    const lever = await createHostedAtsFetcher({ fetch: async () => new Response(JSON.stringify([{
      id: "lever-1", text: "Trader", hostedUrl: "https://jobs.lever.co/example/lever-1", categories: {},
    }]), { headers: { "content-type": "application/json", link: "<https://api.lever.co/v0/postings/example?skip=1>; rel=next" } }) })(claim("lever", "https://api.lever.co/v0/postings/example"));
    expect(lever.inventoryComplete).toBe(false);
    const greenhouse = await createHostedAtsFetcher({ fetch: async () => new Response(JSON.stringify({
      jobs: [{ id: 1, title: "Trader", absolute_url: "https://job-boards.greenhouse.io/example/jobs/1", location: { name: "London" } }],
      meta: { total: 50 },
    }), { headers: { "content-type": "application/json" } }) })(claim("greenhouse", "https://boards-api.greenhouse.io/v1/boards/example/jobs"));
    expect(greenhouse.inventoryComplete).toBe(false);
  });

  it("rejects redirects away from the approved provider host", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    await expect(createHostedAtsFetcher({ fetch })(claim("greenhouse", "https://boards-api.greenhouse.io/v1/boards/example/jobs")))
      .rejects.toThrow(/Private-network/i);
  });

  it("rejects malformed, non-JSON, and oversized responses", async () => {
    const source = claim("lever", "https://api.lever.co/v0/postings/example");
    await expect(createHostedAtsFetcher({ fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }) })(source))
      .rejects.toThrow(/non-JSON/i);
    await expect(createHostedAtsFetcher({ maximumBytes: 1_024, fetch: async () => new Response("x".repeat(2_000), { headers: { "content-type": "application/json" } }) })(source))
      .rejects.toThrow(/size limit/i);
    await expect(createHostedAtsFetcher({ fetch: async () => new Response("not json", { headers: { "content-type": "application/json" } }) })(source))
      .rejects.toThrow(/malformed JSON/i);
  });
});
