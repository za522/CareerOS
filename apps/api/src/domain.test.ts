import { describe, expect, it } from "vitest";
import { assertSafePublicUrl, extractJobDraft } from "./importer.js";
import { statusFromEvent } from "@careeros/contracts";

describe("job import safety", () => {
  it("uses a clean role-like first line as the deterministic pasted-text title", () => {
    const draft = extractJobDraft("Capacity Role 98\nCompany: Capacity Company 98\nLocation: London\nRequirements: Python and markets.");
    expect(draft.title).toBe("Capacity Role 98");
    expect(draft.companyName).toBe("Capacity Company 98");
  });

  it("rejects private destinations", () => {
    expect(() => assertSafePublicUrl("http://127.0.0.1:4310/jobs")).toThrow();
    expect(() => assertSafePublicUrl("http://localhost/jobs")).toThrow();
  });

  it("extracts a reviewable deterministic draft", () => {
    const sourceUrl = "https://northstar.example/jobs/1";
    const draft = extractJobDraft("Job title: Design Engineer | Company: Northstar | Location: London | Requirements: CAD; prototyping; Python", sourceUrl);
    expect(draft.title).toContain("Design Engineer");
    expect(draft.companyName).toBe("Northstar");
    expect(draft.location).toBe("London");
    expect(draft.requiredRequirements.length).toBeGreaterThan(0);
    expect(draft.sourceUrl).toBe(sourceUrl);
    expect(draft.applyUrl).toBe(sourceUrl);
  });

  it("uses a job URL found inside pasted text as both source and Apply Now fallback", () => {
    const url = "https://job-boards.greenhouse.io/example/jobs/12345";
    const draft = extractJobDraft(`LinkedIn job page\nRole: Quant Analyst\nCompany: Example Capital\nApply here: ${url}`);
    expect(draft.sourceUrl).toBe(url);
    expect(draft.applyUrl).toBe(url);
  });

  it("prefers a labelled employer application link over an earlier LinkedIn source URL", () => {
    const linkedIn = "https://www.linkedin.com/jobs/view/12345";
    const employer = "https://job-boards.greenhouse.io/example/jobs/12345";
    const draft = extractJobDraft(`LinkedIn job page\n${linkedIn}\nRole: Quant Analyst\nCompany: Example Capital\nApply now: ${employer}`);
    expect(draft.sourceUrl).toBe(linkedIn);
    expect(draft.applyUrl).toBe(employer);
  });

  it.each([
    (url: string) => `[Apply now](${url})`,
    (url: string) => `Apply now: <${url}>`,
    (url: string) => `Apply now: ${url};`,
  ])("cleans common pasted Apply Now link formatting", (format) => {
    const linkedIn = "https://www.linkedin.com/jobs/view/12345";
    const employer = "https://jobs.example.com/apply/12345?source=careeros";
    const draft = extractJobDraft(`${linkedIn}\n${format(employer)}`);
    expect(draft.sourceUrl).toBe(linkedIn);
    expect(draft.applyUrl).toBe(employer);
  });

  it("keeps corporate job-board fields in their correct columns", () => {
    const draft = extractJobDraft(`
Share
2026 UBS SUPER Program - Singapore
Singapore

Business management, administration and support

Global Wealth Management

Job Reference #336802BR
City

Singapore

Application Deadline12-Aug-2026
Your role

Interested in working in finance, but not sure where to start?

Your expertise

We're looking for a candidate who:

• has graduated from a university/polytechnic in the past 18 months
• is able to join us by September 2026 and is a Singapore citizen

Your program

Your traineeship will last 12 months.

About us

UBS is a leading and truly global wealth manager.
`, "http://jobs.ubs.com/TGNewUI/Search/Home/HomeWithPreLoad?jobid=343994");
    expect(draft.title).toBe("2026 UBS SUPER Program - Singapore");
    expect(draft.companyName).toBe("UBS");
    expect(draft.location).toBe("Singapore");
    expect(draft.applicationDeadline).toBe("12-Aug-2026");
    expect(draft.requisitionId).toBe("336802BR");
    expect(draft.sector).toBe("Finance");
    expect(draft.roleFamily).toBe("Business management, administration and support");
    expect(draft.division).toBe("Global Wealth Management");
    expect(draft.requiredRequirements).toContain("is able to join us by September 2026 and is a Singapore citizen");
  });

  it("separates glued metadata and removes corporate page chrome", () => {
    const draft = extractJobDraft(`
Menu
Who we are
What you can do
Where we are
Early careers
Job search
Job search
Graduate Design Engineer (New Product Innovation)
Summary
Salary: CompetitiveJob Family: Design EngineeringLocation: United Kingdom - Malmesbury Office
About the role
As a Graduate Design Engineer in NPI, you will be part of a large team responsible for imagining what Dyson should create next.
This role is designed to develop the next generation of Dyson innovators through a structured rotational programme.
About you
Have, or be on track to achieve, a degree in Engineering, Product Design, Innovation, Design Engineering, Science or a related discipline.
Be naturally curious about technology, consumers, behaviour and what products could become next.
Aspire to build a long-term career within Dyson's NPI function.
Dyson is an equal opportunity employer.
Posted: 15 July 2026
Share this
Share on LinkedIn
View all jobs
Accessibility Statement
The James Dyson Award
Privacy Policy
Cookie Policy
© Dyson 2026
Back to top
`);

    expect(draft.title).toBe("Graduate Design Engineer (New Product Innovation)");
    expect(draft.companyName).toBe("Dyson");
    expect(draft.location).toBe("United Kingdom - Malmesbury Office");
    expect(draft.country).toBe("United Kingdom");
    expect(draft.roleFamily).toBe("Design Engineering");
    expect(draft.sector).toBe("Engineering");
    expect(draft.seniority).toBe("Graduate");
    expect(draft.employmentType).toBe("Graduate program");
    expect(draft.applicationDeadline).toBe("");
    expect(draft.postingDate).toBe("15 July 2026");
    expect(draft.summary).toBe("As a Graduate Design Engineer in NPI, you will be part of a large team responsible for imagining what Dyson should create next.");
    expect(draft.requiredRequirements).toContain("Have, or be on track to achieve, a degree in Engineering, Product Design, Innovation, Design Engineering, Science or a related discipline.");
    expect(draft.companySnapshot).toBe("");
    expect(draft.companyDescription).toBe("");
    expect(draft.description).not.toContain("Accessibility Statement");
    expect(draft.description).not.toContain("Privacy Policy");
  });
});

describe("application event projection", () => {
  it("maps lifecycle events to queryable status", () => {
    expect(statusFromEvent.application_submitted).toBe("Applied");
    expect(statusFromEvent.offer_received).toBe("Offer");
    expect(statusFromEvent.rejection_received).toBe("Rejected");
  });
});
