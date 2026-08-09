import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";

const testDataDir = mkdtempSync(join(tmpdir(), "careeros-job-workspace-"));
const testObjectStorageDir = join(dirname(testDataDir), `${basename(testDataDir)}-object-storage`);
const testPendingRestorePath = join(dirname(testDataDir), `.${basename(testDataDir)}-restore-pending.json`);
process.env.CAREEROS_DATA_DIR = testDataDir;
process.env.CAREEROS_OBJECT_STORAGE_DIR = testObjectStorageDir;
process.env.CAREEROS_SKIP_LISTEN = "1";
process.env.CAREEROS_DISABLE_KEYCHAIN = "1";
process.env.OPENAI_API_KEY = "";
process.env.CAREEROS_BACKUP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

let app: Awaited<typeof import("./server.js")>["app"];
let closeDb: Awaited<typeof import("./db.js")>["closeDb"];
let jobId = "";

async function waitForCapture(id: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: "GET", url: `/api/capture-queue/${id}` });
    const item = response.json();
    if (!["Queued", "Extracting"].includes(item.state)) return item;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Capture ${id} did not finish in time.`);
}

beforeAll(async () => {
  ({ app } = await import("./server.js"));
  ({ closeDb } = await import("./db.js"));
});

afterAll(async () => {
  await app.close();
  closeDb();
  if (existsSync(testPendingRestorePath)) unlinkSync(testPendingRestorePath);
  rmSync(testDataDir, { recursive: true, force: true });
  rmSync(testObjectStorageDir, { recursive: true, force: true });
});

afterEach(() => vi.unstubAllGlobals());

describe("job detail workspace API", () => {
  it("creates a local workspace actor and persists attributed comments with audit history", async () => {
    const session = await app.inject({ method: "GET", url: "/api/auth/session" });
    expect(session.statusCode).toBe(200);
    expect(session.json().members).toEqual([expect.objectContaining({ email: "local@careeros.invalid", role: "owner" })]);
    const created = await app.inject({ method: "POST", url: "/api/workspace/comments", payload: { entityType: "JobPosting", entityId: "comment-fixture-job", targetPath: "document:fixture", body: "Please tighten the opening sentence." } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ body: "Please tighten the opening sentence.", authorName: "Local owner" });
    const listed = await app.inject({ method: "GET", url: "/api/workspace/comments?entityType=JobPosting&entityId=comment-fixture-job" });
    expect(listed.json()).toEqual([expect.objectContaining({ id: created.json().id, targetPath: "document:fixture" })]);
    const audit = await app.inject({ method: "GET", url: "/api/workspace/audit?limit=10" });
    expect(audit.json()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "comment.created", entityId: "comment-fixture-job" })]));
  });

  it("starts with approved finance sources and supports hide, restore, and issue reporting", async () => {
    const initial = await app.inject({ method: "GET", url: "/api/discovery" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().sources.length).toBeGreaterThanOrEqual(7);
    const sourceId = initial.json().sources[0].id as string;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ jobs: [{
      id: "api-feedback-role", title: "Markets Graduate", absolute_url: "https://jobs.example/markets-graduate?job=42",
      location: { name: "London" }, created_at: "2026-08-08T09:00:00Z", content: "Join the markets team.",
    }] }), { status: 200, headers: { "content-type": "application/json" } })));
    const run = await app.inject({ method: "POST", url: "/api/discovery/runs", payload: { sourceId } });
    expect(run.statusCode).toBe(200);
    const posting = (await app.inject({ method: "GET", url: "/api/discovery" })).json().postings
      .find((item: { externalId: string }) => item.externalId === "api-feedback-role");
    expect(posting).toBeTruthy();
    expect(posting).toMatchObject({ roleFamily: "Trading", firmType: "Market maker / proprietary trading", workMode: "Not stated", sponsorship: "Not stated" });
    const searched = await app.inject({ method: "GET", url: "/api/discovery?q=Markets%20Graduate&roleFamily=Trading&tracked=unsaved&limit=1" });
    expect(searched.statusCode).toBe(200);
    expect(searched.json()).toMatchObject({ postingTotal: 1, openPostingTotal: expect.any(Number), nextCursor: null });
    expect(searched.json().postings[0].id).toBe(posting.id);
    const invalid = await app.inject({ method: "GET", url: "/api/discovery?side=not-a-side" });
    expect(invalid.statusCode).toBe(400);

    const hidden = await app.inject({ method: "PATCH", url: `/api/discovery/postings/${posting.id}/hidden`, payload: { hidden: true } });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().hiddenAt).toBeTruthy();
    const reported = await app.inject({ method: "POST", url: `/api/discovery/postings/${posting.id}/issues`, payload: { reason: "The programme is classified incorrectly." } });
    expect(reported.statusCode).toBe(201);
    const restored = await app.inject({ method: "PATCH", url: `/api/discovery/postings/${posting.id}/hidden`, payload: { hidden: false } });
    expect(restored.json().hiddenAt).toBeNull();
  });

  it("keeps a discovered posting linked through review and prevents repeated tracker saves", async () => {
    const discovery = (await app.inject({ method: "GET", url: "/api/discovery" })).json();
    const posting = discovery.postings.find((item: { externalId: string }) => item.externalId === "api-feedback-role");
    expect(posting).toBeTruthy();
    const prepared = await app.inject({ method: "POST", url: `/api/discovery/postings/${posting.id}/save` });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().discoveryPostingId).toBe(posting.id);
    const committed = await app.inject({
      method: "POST",
      url: `/api/imports/${prepared.json().importRun.id}/commit`,
      payload: { draft: prepared.json().draft },
    });
    expect(committed.statusCode).toBe(201);
    const refreshed = (await app.inject({ method: "GET", url: "/api/discovery" })).json().postings.find((item: { id: string }) => item.id === posting.id);
    expect(refreshed.savedJobPostingId).toBe(committed.json().id);
    const repeated = await app.inject({ method: "POST", url: `/api/discovery/postings/${posting.id}/save` });
    expect(repeated.statusCode).toBe(409);
  });

  it("rejects malformed API keys without storing them", async () => {
    const response = await app.inject({ method: "PUT", url: "/api/settings/openai-key", payload: { apiKey: "not-a-key" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("OpenAI API key");
  });

  it("creates and edits a posting while retaining confirmed field evidence", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { title: "Graduate Design Engineer", companyName: "Example Labs" },
    });
    expect(created.statusCode).toBe(201);
    jobId = created.json().id;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}`,
      payload: {
        companySnapshot: "Builds physical and digital products.",
        workMode: "Hybrid",
        postingDate: "2026-08-01",
        requiredRequirements: ["Engineering degree", "CAD experience"],
        preferredRequirements: ["Python"],
      },
    });
    expect(updated.statusCode).toBe(200);

    const detail = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    const body = detail.json();
    expect(body.workMode).toBe("Hybrid");
    expect(body.requiredRequirements).toEqual(["Engineering degree", "CAD experience"]);
    expect(body.company.snapshot).toContain("physical and digital");
    expect(body.evidence.some((item: { fieldPath: string; userConfirmed: boolean }) => item.fieldPath === "workMode" && item.userConfirmed)).toBe(true);
    const audit = await app.inject({ method: "GET", url: "/api/workspace/audit?limit=50" });
    expect(audit.json()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "api.patch", entityId: jobId })]));
  });

  it("adds a task and preserves completion history", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/tasks`,
      payload: { title: "Prepare portfolio examples", taskType: "preparation", priority: "High", dueDate: "2026-08-10" },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().id;

    const completed = await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, payload: { completed: true, expectedRevision: created.json().revision } });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().completed).toBe(true);
    const stale = await app.inject({ method: "PATCH", url: `/api/tasks/${taskId}`, payload: { completed: false, expectedRevision: created.json().revision } });
    expect(stale.statusCode).toBe(409);

    const detail = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    expect(detail.json().tasks[0]).toMatchObject({ title: "Prepare portfolio examples", completed: true, priority: "High" });
  });

  it("keeps employer and researched compensation structurally distinct", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/salary-estimates`,
      payload: { estimateType: "researched", minAmount: 38_000, maxAmount: 45_000, currency: "GBP", sourceName: "Public salary survey" },
    });
    expect(created.statusCode).toBe(201);

    const detail = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    expect(detail.json().salaries[0]).toMatchObject({ estimateType: "researched", minAmount: 38_000, maxAmount: 45_000, currency: "GBP", evidence: [] });
  });

  it("commits reviewed salary research with its source evidence", async () => {
    const proposal = {
      jobPostingId: jobId,
      inferredRoleTitle: "Graduate Design Engineer",
      inferredLevel: "Graduate",
      estimate: {
        estimateType: "ai_assisted",
        minAmount: 40_000,
        maxAmount: 48_000,
        baseMinAmount: 40_000,
        baseMaxAmount: 48_000,
        totalCompMinAmount: 43_000,
        totalCompMaxAmount: 55_000,
        currency: "GBP",
        paymentPeriod: "annual",
        sourceName: "CareerOS salary research (2 sources)",
        sourceUrl: "https://example.com/salary-one",
        confidence: 0.68,
        researchNotes: "Comparable graduate engineering roles in the same region.",
      },
      evidence: [
        {
          sourceName: "Example salary survey",
          sourceUrl: "https://example.com/salary-one",
          sourceDate: "2026-08-05",
          roleTitle: "Graduate Design Engineer",
          location: "London",
          seniority: "Graduate",
          compensationScope: "base",
          minAmount: 40_000,
          maxAmount: 48_000,
          currency: "GBP",
          paymentPeriod: "annual",
          excerpt: "Reported base salary range for graduate design engineers.",
          confidence: 0.75,
        },
        {
          sourceName: "Example total compensation survey",
          sourceUrl: "https://example.org/total-comp",
          sourceDate: "2026-08-04",
          roleTitle: "Graduate Product Engineer",
          location: "London",
          seniority: "Entry level",
          compensationScope: "total",
          minAmount: 43_000,
          maxAmount: 55_000,
          currency: "GBP",
          paymentPeriod: "annual",
          excerpt: "Reported total compensation including variable pay.",
          confidence: 0.62,
        },
      ],
      confidence: 0.68,
      rationale: "Two public comparables support a directional estimate.",
      warnings: ["The employer did not publish compensation for this posting."],
      provider: "openai",
      model: "test-model",
      researchedAt: "2026-08-05T10:00:00.000Z",
      durationMs: 12_400,
    };

    const committed = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/salary-research/commit`,
      payload: proposal,
    });
    expect(committed.statusCode).toBe(201);
    expect(committed.json()).toMatchObject({
      estimateType: "ai_assisted",
      baseMinAmount: 40_000,
      baseMaxAmount: 48_000,
      totalCompMinAmount: 43_000,
      totalCompMaxAmount: 55_000,
      confidence: 0.68,
    });
    expect(committed.json().evidence).toHaveLength(2);

    const detail = await app.inject({ method: "GET", url: `/api/jobs/${jobId}` });
    const saved = detail.json().salaries.find((item: { estimateType: string }) => item.estimateType === "ai_assisted");
    expect(saved.evidence.map((item: { sourceName: string }) => item.sourceName)).toEqual([
      "Example salary survey",
      "Example total compensation survey",
    ]);

    const tracker = await app.inject({ method: "GET", url: "/api/jobs" });
    expect(tracker.json().jobs[0]).toMatchObject({
      salaryEstimateType: "ai_assisted",
      salaryMinAmount: 40_000,
      salaryMaxAmount: 48_000,
      salaryCurrency: "GBP",
      salaryScope: "base",
      salaryConfidence: 0.68,
    });
  });

  it("refuses a source check when no public source link exists", async () => {
    const checked = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/recheck` });
    expect(checked.statusCode).toBe(400);
    expect(checked.json().error).toContain("source or Apply Now link");
  });

  it("refuses a profile import commit after the shared profile changes", async () => {
    const profile = (await app.inject({ method: "GET", url: "/api/profile" })).json();
    const imported = await app.inject({ method: "POST", url: "/api/profile/imports", payload: { sourceType: "pasted_text", documentType: "cv", text: "Zain Ahmad\nExperience\nBuilt a tested product prototype." } });
    expect(imported.statusCode).toBe(200);
    const changed = await app.inject({ method: "PUT", url: "/api/profile", payload: { ...profile, summary: "Changed in another session.", expectedRevision: profile.revision } });
    expect(changed.statusCode).toBe(200);
    const committed = await app.inject({ method: "POST", url: "/api/profile/imports/commit", payload: {
      sourceDocumentId: imported.json().sourceDocumentId,
      profilePatch: imported.json().profilePatch,
      sections: imported.json().sections,
    } });
    expect(committed.statusCode).toBe(409);
  });

  it("builds a CV workspace and preserves a job-specific document version", async () => {
    const imported = await app.inject({
      method: "POST",
      url: "/api/profile/imports",
      payload: {
        sourceType: "file",
        documentType: "cv",
        title: "Design engineering CV",
        fileName: "design-engineering-cv.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from([
          "Zain Ahmad",
          "Design Engineer",
          "Experience",
          "Built and tested physical prototypes with cross-functional engineering teams.",
          "Education",
          "MEng Design Engineering, Imperial College London.",
        ].join("\n")).toString("base64"),
      },
    });
    expect(imported.statusCode).toBe(200);
    const importBody = imported.json();
    expect(importBody.document.id).toBeTruthy();
    expect(importBody.sections.length).toBeGreaterThan(0);

    const committed = await app.inject({
      method: "POST",
      url: "/api/profile/imports/commit",
      payload: {
        documentId: importBody.document.id,
        sourceDocumentId: importBody.sourceDocumentId,
        profilePatch: importBody.profilePatch,
        sections: importBody.sections,
      },
    });
    expect(committed.statusCode).toBe(200);

    const preview = await app.inject({ method: "GET", url: `/api/profile/documents/${importBody.document.id}/preview` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ document: { title: "Design engineering CV" } });
    expect(preview.json().extractedText).toContain("Imperial College London");

    const originalFile = await app.inject({ method: "GET", url: `/api/profile/documents/${importBody.document.id}/file` });
    expect(originalFile.statusCode).toBe(200);
    expect(originalFile.headers["content-type"]).toContain("text/plain");
    expect(originalFile.body).toContain("Zain Ahmad");

    const application = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/applications`, payload: { priority: "High" } });
    expect(application.statusCode).toBe(201);

    const workspace = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/application-studio` });
    expect(workspace.statusCode).toBe(200);
    const studio = workspace.json();
    expect(studio.documents).toHaveLength(1);
    expect(studio.documents[0]).toMatchObject({ usable: true, qualityWarning: null });
    expect(studio.documents[0].baseContent.sections.length).toBeGreaterThan(0);

    const content = {
      ...studio.documents[0].baseContent,
      intro: "Design engineer focused on product development across physical and digital systems.",
      inlineFormatting: [{ field: "intro", start: 0, end: 15, bold: true, italic: false }],
    };
    const draft = await app.inject({
      method: "PUT",
      url: `/api/jobs/${jobId}/document-drafts`,
      payload: { documentId: importBody.document.id, content },
    });
    expect(draft.statusCode).toBe(200);

    const reopenedDraft = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/application-studio` });
    expect(reopenedDraft.json().documents[0]).toMatchObject({
      draftContent: {
        intro: "Design engineer focused on product development across physical and digital systems.",
        inlineFormatting: [{ field: "intro", start: 0, end: 15, bold: true, italic: false }],
      },
    });

    const saved = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/document-versions`,
      payload: {
        documentId: importBody.document.id,
        parentVersionId: null,
        expectedDraftRevision: draft.json().revision,
        checkpointName: "Amazon application baseline",
        content,
        acceptedChangeIds: [],
        changeSummary: "Tailored headline and selected relevant evidence.",
        provider: "manual",
        model: "",
      },
    });
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      documentId: importBody.document.id,
      jobPostingId: jobId,
      version: 1,
      checkpointName: "Amazon application baseline",
      content: {
        intro: "Design engineer focused on product development across physical and digital systems.",
        inlineFormatting: [{ field: "intro", start: 0, end: 15, bold: true, italic: false }],
      },
      proposalChanges: [],
      proposalDecisions: {},
    });

    const reloaded = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/application-studio` });
    expect(reloaded.json().documents[0].versions[0].id).toBe(saved.json().id);
    expect(reloaded.json().documents[0].draftContent.intro).toBe(content.intro);

    const newerDraft = await app.inject({
      method: "PUT",
      url: `/api/jobs/${jobId}/document-drafts`,
      payload: { documentId: importBody.document.id, content: { ...content, intro: "Newer collaborator edit." }, expectedRevision: draft.json().revision },
    });
    expect(newerDraft.statusCode).toBe(200);
    const staleSnapshot = await app.inject({
      method: "POST",
      url: `/api/jobs/${jobId}/document-versions`,
      payload: { documentId: importBody.document.id, expectedDraftRevision: draft.json().revision, content, checkpointName: "Stale tab" },
    });
    expect(staleSnapshot.statusCode).toBe(409);
    const afterConflict = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/application-studio` });
    expect(afterConflict.json().documents[0].draftContent.intro).toBe("Newer collaborator edit.");

    const careerStudio = await app.inject({ method: "GET", url: "/api/career-studio" });
    expect(careerStudio.statusCode).toBe(200);
    expect(careerStudio.json().roles[0]).toMatchObject({
      jobPostingId: jobId,
      companyName: "Example Labs",
      versionCount: 1,
      baseDocumentTitle: "Design engineering CV",
      latestVersion: { id: saved.json().id },
    });
    expect(careerStudio.json().documents[0]).toMatchObject({ versionCount: 1, roleCount: 1 });

    const exported = await app.inject({ method: "GET", url: "/api/export" });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().data.application_materials).toEqual([]);
    expect(exported.json().manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: importBody.document.relativePath, sha256: importBody.document.checksum }),
    ]));
    expect(exported.json().files[importBody.document.relativePath]).toBeTruthy();

    if (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")) {
      const pageSectionIds = [content.sections.map((section: { id: string }) => section.id)];
      const concurrent = await Promise.all([
        app.inject({ method: "POST", url: `/api/document-versions/${saved.json().id}/pdf`, payload: { pageSectionIds, markAsSubmitted: false, applicationId: null } }),
        app.inject({ method: "POST", url: `/api/document-versions/${saved.json().id}/pdf`, payload: { pageSectionIds, markAsSubmitted: false, applicationId: null } }),
      ]);
      expect(concurrent.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const submitted = await app.inject({ method: "POST", url: `/api/document-versions/${saved.json().id}/pdf`, payload: { pageSectionIds, markAsSubmitted: true, applicationId: application.json().applicationId } });
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json().submittedAt).toBeTruthy();
      const afterSubmission = await app.inject({ method: "GET", url: "/api/export" });
      expect(afterSubmission.statusCode).toBe(200);
      expect(afterSubmission.json().data.application_materials).toEqual([
        expect.objectContaining({ application_id: application.json().applicationId, document_version_id: saved.json().id, material_type: "cv" }),
      ]);
      expect(afterSubmission.json().manifest.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: submitted.json().relativePath, sha256: submitted.json().checksum }),
      ]));

      const missingFileVersion = await app.inject({
        method: "POST", url: `/api/jobs/${jobId}/document-versions`,
        payload: { documentId: importBody.document.id, expectedDraftRevision: newerDraft.json().revision, content: { ...content, intro: "Missing file regression." }, checkpointName: "Missing file regression" },
      });
      expect(missingFileVersion.statusCode).toBe(201);
      expect((await app.inject({ method: "POST", url: `/api/document-versions/${missingFileVersion.json().id}/pdf`, payload: { pageSectionIds, markAsSubmitted: false, applicationId: null } })).statusCode).toBe(200);
      const missingPath = join(testObjectStorageDir, "workspaces", "00000000-0000-4000-8000-000000000001", "documents", importBody.document.id, "versions", `${missingFileVersion.json().id}.pdf`);
      const originalMissingFileBytes = readFileSync(missingPath);
      writeFileSync(missingPath, "corrupted immutable PDF");
      const corruptSubmit = await app.inject({ method: "POST", url: `/api/document-versions/${missingFileVersion.json().id}/pdf`, payload: { pageSectionIds, markAsSubmitted: true, applicationId: application.json().applicationId } });
      expect(corruptSubmit.statusCode).toBe(409);
      expect(corruptSubmit.json().error).toContain("checksum verification");
      unlinkSync(missingPath);
      const missingSubmit = await app.inject({ method: "POST", url: `/api/document-versions/${missingFileVersion.json().id}/pdf`, payload: { pageSectionIds, markAsSubmitted: true, applicationId: application.json().applicationId } });
      expect(missingSubmit.statusCode).toBe(409);
      expect(missingSubmit.json().error).toContain("recorded PDF file is missing");
      writeFileSync(missingPath, originalMissingFileBytes);

      const unrelatedJob = await app.inject({ method: "POST", url: "/api/jobs", payload: { title: "Unrelated role", companyName: "Other Company" } });
      const unrelatedApplication = await app.inject({ method: "POST", url: `/api/jobs/${unrelatedJob.json().id}/applications`, payload: { priority: "Low" } });
      const rollbackVersion = await app.inject({
        method: "POST", url: `/api/jobs/${jobId}/document-versions`,
        payload: { documentId: importBody.document.id, expectedDraftRevision: newerDraft.json().revision, content: { ...content, intro: "Transaction rollback regression." }, checkpointName: "Rollback regression" },
      });
      const rejectedLink = await app.inject({ method: "POST", url: `/api/document-versions/${rollbackVersion.json().id}/pdf`, payload: { pageSectionIds, markAsSubmitted: true, applicationId: unrelatedApplication.json().applicationId } });
      expect(rejectedLink.statusCode).toBe(409);
      const afterRejectedLink = await app.inject({ method: "GET", url: `/api/jobs/${jobId}/application-studio` });
      const rolledBack = afterRejectedLink.json().documents[0].versions.find((item: { id: string }) => item.id === rollbackVersion.json().id);
      expect(rolledBack).toMatchObject({ relativePath: "", checksum: rollbackVersion.json().checksum, submittedAt: null });
      expect(existsSync(join(testObjectStorageDir, "workspaces", "00000000-0000-4000-8000-000000000001", "documents", importBody.document.id, "versions", `${rollbackVersion.json().id}.pdf`))).toBe(false);
      const correctLink = await app.inject({ method: "POST", url: `/api/document-versions/${rollbackVersion.json().id}/pdf`, payload: { pageSectionIds, markAsSubmitted: true, applicationId: application.json().applicationId } });
      expect(correctLink.statusCode).toBe(200);
      expect(correctLink.json().submittedAt).toBeTruthy();
    }
  }, 60_000);

  it("requires an explicit duplicate decision and atomically links the capture to an existing posting", async () => {
    const sourceUrl = "https://apply.example/jobs/duplicate-42";
    const existing = await app.inject({ method: "POST", url: "/api/jobs", payload: { title: "Quant Trading Graduate", companyName: "Example Capital", sourceUrl, applyUrl: sourceUrl } });
    expect(existing.statusCode).toBe(201);
    const queued = await app.inject({ method: "POST", url: "/api/capture-queue", payload: { items: [{ sourceType: "pasted_text", text: "Quant Trading Graduate\nCompany: Example Capital\nLocation: London", applyUrl: sourceUrl }] } });
    expect(queued.statusCode).toBe(202);
    const item = await waitForCapture(queued.json()[0].id);
    expect(item).toMatchObject({ state: "Duplicate", applyUrl: sourceUrl });

    const rejected = await app.inject({ method: "POST", url: `/api/capture-queue/${item.id}/commit`, payload: { draft: item.draft } });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toContain("Duplicate decision required");

    const linked = await app.inject({ method: "POST", url: `/api/capture-queue/${item.id}/commit`, payload: { draft: item.draft, duplicateAction: "link_existing", existingJobPostingId: existing.json().id } });
    expect(linked.statusCode).toBe(201);
    expect(linked.json().id).toBe(existing.json().id);
    expect((await app.inject({ method: "GET", url: `/api/capture-queue/${item.id}` })).json().state).toBe("Saved");
  });

  it("approves a valid reviewed batch in one transaction", async () => {
    const queued = await app.inject({ method: "POST", url: "/api/capture-queue", payload: { items: [
      { sourceType: "pasted_text", text: "Capture Batch Analyst A\nCompany: Batch Alpha\nLocation: London" },
      { sourceType: "pasted_text", text: "Capture Batch Analyst B\nCompany: Batch Beta\nLocation: Singapore" },
    ] } });
    const ids = queued.json().map((item: { id: string }) => item.id) as string[];
    const ready = await Promise.all(ids.map((id) => waitForCapture(id)));
    expect(ready.map((item) => item.state)).toEqual(["Needs Review", "Needs Review"]);
    const rolledBack = await app.inject({ method: "POST", url: "/api/capture-queue/commit-batch", payload: { items: [{ id: ids[0] }, { id: "00000000-0000-4000-8000-000000000000" }] } });
    expect(rolledBack.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: `/api/capture-queue/${ids[0]}` })).json().state).toBe("Needs Review");
    const committed = await app.inject({ method: "POST", url: "/api/capture-queue/commit-batch", payload: { items: ids.map((id) => ({ id })) } });
    expect(committed.statusCode).toBe(201);
    expect(committed.json()).toHaveLength(2);
    for (const id of ids) expect((await app.inject({ method: "GET", url: `/api/capture-queue/${id}` })).json().state).toBe("Saved");
  });

  it("persists a recoverable composer draft and removes it only after queueing", async () => {
    const id = crypto.randomUUID();
    const value = "Recoverable Quant Role\nCompany: Durable Capital\nLocation: London";
    const saved = await app.inject({ method: "PUT", url: `/api/capture-drafts/${id}`, payload: { sourceType: "pasted_text", value } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ id, sourceType: "pasted_text", value });
    expect((await app.inject({ method: "GET", url: "/api/capture-drafts" })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id, value })]));

    const queued = await app.inject({ method: "POST", url: `/api/capture-drafts/${id}/enqueue` });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/capture-drafts" })).json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
  });

  it("rejects stale capture draft updates and deletes instead of silently overwriting collaborator work", async () => {
    const id = crypto.randomUUID();
    const created = await app.inject({ method: "PUT", url: `/api/capture-drafts/${id}`, payload: { sourceType: "pasted_text", value: "First shared draft" } });
    expect(created.statusCode).toBe(200);
    expect(created.json().revision).toBe(1);

    const updated = await app.inject({ method: "PUT", url: `/api/capture-drafts/${id}`, payload: {
      sourceType: "pasted_text", value: "Dad's newer shared draft", expectedRevision: 1,
    } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().revision).toBe(2);

    const stale = await app.inject({ method: "PUT", url: `/api/capture-drafts/${id}`, payload: {
      sourceType: "pasted_text", value: "Stale local overwrite", expectedRevision: 1,
    } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatch(/another session/i);
    expect((await app.inject({ method: "GET", url: "/api/capture-drafts" })).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id, value: "Dad's newer shared draft", revision: 2 }),
    ]));

    const staleDelete = await app.inject({ method: "DELETE", url: `/api/capture-drafts/${id}?expectedRevision=1` });
    expect(staleDelete.statusCode).toBe(409);
    const deleted = await app.inject({ method: "DELETE", url: `/api/capture-drafts/${id}?expectedRevision=2` });
    expect(deleted.statusCode).toBe(200);
  });

  it("identifies a commit-time duplicate, opens only that conflict, and rolls back the whole batch", async () => {
    const queued = await app.inject({ method: "POST", url: "/api/capture-queue", payload: { items: [
      { sourceType: "pasted_text", text: "Late Duplicate Analyst\nCompany: Late Capital\nLocation: London" },
      { sourceType: "pasted_text", text: "Unaffected Batch Analyst\nCompany: Other Capital\nLocation: London" },
    ] } });
    const ids = queued.json().map((item: { id: string }) => item.id) as string[];
    const ready = await Promise.all(ids.map((id) => waitForCapture(id)));
    expect(ready.map((item) => item.state)).toEqual(["Needs Review", "Needs Review"]);
    await app.inject({ method: "POST", url: "/api/jobs", payload: { title: "Late Duplicate Analyst", companyName: "Late Capital", location: "London" } });

    const conflict = await app.inject({ method: "POST", url: "/api/capture-queue/commit-batch", payload: { items: ids.map((id) => ({ id })) } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ conflicts: [{ id: ids[0], duplicates: [expect.objectContaining({ companyName: "Late Capital" })] }] });
    expect((await app.inject({ method: "GET", url: `/api/capture-queue/${ids[0]}` })).json().state).toBe("Duplicate");
    expect((await app.inject({ method: "GET", url: `/api/capture-queue/${ids[1]}` })).json().state).toBe("Needs Review");
  });

  it("exposes queue cancellation through the API", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const queued = await app.inject({ method: "POST", url: "/api/capture-queue", payload: { items: [{ sourceType: "url", url: "https://example.com/slow-cancellation-role" }] } });
    const target = queued.json()[0].id as string;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const state = (await app.inject({ method: "GET", url: `/api/capture-queue/${target}` })).json().state;
      if (state === "Extracting") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cancelled = await app.inject({ method: "POST", url: `/api/capture-queue/${target}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: target, state: "Blocked", progressMessage: "Cancelled" });
  });

  it("marks the later of two concurrently queued copies as a duplicate", async () => {
    const text = "Concurrent Capture Trader\nCompany: Concurrency Capital\nLocation: London";
    const queued = await app.inject({ method: "POST", url: "/api/capture-queue", payload: { items: [
      { sourceType: "pasted_text", text },
      { sourceType: "pasted_text", text },
    ] } });
    const results = await Promise.all(queued.json().map((item: { id: string }) => waitForCapture(item.id)));
    expect(results.map((item) => item.state).sort()).toEqual(["Duplicate", "Needs Review"]);
    expect(results.find((item) => item.state === "Duplicate").duplicates[0]).toMatchObject({ queued: true });
  });

  it("detects punctuation-only title differences between concurrently queued captures", async () => {
    const queued = await app.inject({ method: "POST", url: "/api/capture-queue", payload: { items: [
      { sourceType: "pasted_text", text: "Quantitative Trading - Graduate\nCompany: Needle Capital\nLocation: London" },
      { sourceType: "pasted_text", text: "Quantitative Trading: Graduate\nCompany: Needle Capital\nLocation: London" },
    ] } });
    const results = await Promise.all(queued.json().map((item: { id: string }) => waitForCapture(item.id)));
    expect(results.map((item) => item.state).sort()).toEqual(["Duplicate", "Needs Review"]);
    expect(results.find((item) => item.state === "Duplicate").duplicates[0]).toMatchObject({ queued: true });
  });

  it("detects existing postings through tracking parameters and minor title punctuation", async () => {
    const existing = await app.inject({ method: "POST", url: "/api/jobs", payload: {
      title: "Quantitative Trading - Graduate",
      companyName: "Needle Capital",
      location: "London",
      sourceUrl: "https://jobs.example/roles/42?department=trading&utm_source=linkedin",
    } });
    expect(existing.statusCode).toBe(201);

    const queued = await app.inject({ method: "POST", url: "/api/capture-queue", payload: { items: [{
      sourceType: "pasted_text",
      text: "Quantitative Trading: Graduate\nCompany: Needle Capital\nLocation: London\nApply now: https://jobs.example/roles/42?utm_campaign=summer&department=trading",
    }] } });
    const result = await waitForCapture(queued.json()[0].id);

    expect(result.state).toBe("Duplicate");
    expect(result.duplicates).toEqual(expect.arrayContaining([expect.objectContaining({ id: existing.json().id })]));
  });

  it("processes 100 mixed captures through the real API and SQLite queue with compact polling", async () => {
    const items = Array.from({ length: 100 }, (_, index) => index % 2 === 0
      ? { sourceType: "pasted_text", text: `Mixed Capture Role ${index}\nCompany: Mixed Company ${index}\nLocation: London` }
      : { sourceType: "url", url: `http://127.0.0.1/private-job-${index}` });
    const queued = await app.inject({ method: "POST", url: "/api/capture-queue", payload: { items } });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toHaveLength(100);
    const results = await Promise.all(queued.json().map((item: { id: string }) => waitForCapture(item.id, 30_000)));
    expect(results.filter((item) => item.state === "Needs Review")).toHaveLength(50);
    expect(results.filter((item) => item.state === "Blocked")).toHaveLength(50);

    const page = await app.inject({ method: "GET", url: "/api/capture-queue?limit=10" });
    expect(page.statusCode).toBe(200);
    expect(page.json().items).toHaveLength(10);
    expect(page.json().nextCursor).toEqual(expect.any(String));
    expect(page.json().nextCursor).not.toBe("");
    expect(page.json().items.every((item: { sourceText: unknown; draft: { description?: string } | null }) => item.sourceText === null && (!item.draft || item.draft.description === ""))).toBe(true);
  }, 40_000);

  it("reports queue, watcher, notification, and collaboration health without exposing secrets", async () => {
    const response = await app.inject({ method: "GET", url: "/api/system/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      capture: { active: expect.any(Number), needsReview: expect.any(Number), failed: expect.any(Number), blocked: expect.any(Number) },
      discovery: { enabledSources: expect.any(Number), unhealthySources: expect.any(Number) },
      notifications: { configured: expect.any(Boolean), pending: expect.any(Number), failed: expect.any(Number) },
      collaboration: { hosted: false, realtimeEnabled: false },
    });
    expect(JSON.stringify(response.json())).not.toMatch(/token|secret|apiKey/i);
  });

  it("preserves authenticated backup history and freezes all writers after restoring an older backup", async () => {
    const firstBackup = await app.inject({ method: "POST", url: "/api/backups/run" });
    expect(firstBackup.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondBackup = await app.inject({ method: "POST", url: "/api/backups/run" });
    expect(secondBackup.statusCode).toBe(200);
    const history = await app.inject({ method: "GET", url: "/api/backups" });
    expect(history.statusCode).toBe(200);
    expect(history.json().backups).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: firstBackup.json().path, checksum: firstBackup.json().checksum }),
      expect.objectContaining({ path: secondBackup.json().path, checksum: secondBackup.json().checksum }),
    ]));

    const oldest = history.json().backups.find((record: { path: string }) => record.path === firstBackup.json().path);
    const accepted = await app.inject({ method: "POST", url: `/api/backups/${oldest.id}/restore` });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ accepted: true, restartRequired: true });

    const pendingText = readFileSync(testPendingRestorePath, "utf8");
    expect(pendingText).not.toContain("databaseBase64");
    const pending = JSON.parse(pendingText) as { stagingDirectoryName: string; databaseSha256: string };
    expect(pending).toMatchObject({ stagingDirectoryName: expect.stringContaining(".restore-"), databaseSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const stagedDirectory = join(dirname(testDataDir), pending.stagingDirectoryName);
    const stagedDatabasePath = join(stagedDirectory, "careeros.sqlite");
    const staged = new Database(stagedDatabasePath, { readonly: true });
    try {
      const restoredHistory = staged.prepare("SELECT object_path AS path FROM backup_records ORDER BY created_at").all() as Array<{ path: string }>;
      expect(restoredHistory.map((record) => record.path)).toEqual(expect.arrayContaining([firstBackup.json().path, secondBackup.json().path]));
    } finally {
      staged.close();
    }

    const blockedWrite = await app.inject({ method: "POST", url: "/api/jobs", payload: { title: "Must not be lost", companyName: "After Restore" } });
    expect(blockedWrite.statusCode).toBe(503);
    expect(blockedWrite.json().error).toContain("read-only");
    expect((await app.inject({ method: "GET", url: "/api/jobs" })).statusCode).toBe(200);

    const duplicateRestore = await app.inject({ method: "POST", url: `/api/backups/${oldest.id}/restore` });
    expect(duplicateRestore.statusCode).toBe(409);
    unlinkSync(testPendingRestorePath);
    rmSync(stagedDirectory, { recursive: true, force: true });
  });
});
