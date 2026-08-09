import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const execFileAsync = promisify(execFile);
const api = "http://127.0.0.1:4310";

async function json<T>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

async function seedStudio(request: APIRequestContext) {
  const job = await json<{ id: string }>(await request.post(`${api}/api/jobs`, { data: {
    title: "Quantitative Trading Analyst", companyName: "Meridian Capital", location: "London",
    requiredRequirements: ["Python", "Probability", "Market microstructure"],
    sourceUrl: "https://example.com/roles/quant", applyUrl: "https://example.com/roles/quant/apply",
  } }));
  await json(await request.post(`${api}/api/jobs/${job.id}/applications`, { data: { priority: "High" } }));
  const sourceText = [
    "Zain Ahmad", "Design Engineer", "zain@example.com | +44 7444 222 841 | https://zain.example",
    "Education", "Imperial College London", "MEng Design Engineering | 2022-2026 | London",
    "First-class design engineering work spanning software, statistics and product development.",
    "Professional Experience", "SageCare", "Web Design Intern | 2024 | London",
    "- Built an accessible web product using TypeScript.", "- Analysed user behaviour and improved navigation.",
    "Skills", "Programming: Python, TypeScript, SQL", "Interests: markets, product design, tennis",
  ].join("\n");
  const imported = await json<any>(await request.post(`${api}/api/profile/imports`, { data: {
    sourceType: "file", documentType: "cv", title: "Quant source CV", fileName: "quant-source.txt",
    mimeType: "text/plain", dataBase64: Buffer.from(sourceText).toString("base64"),
  } }));
  await json(await request.post(`${api}/api/profile/imports/commit`, { data: {
    documentId: imported.document.id, sourceDocumentId: imported.sourceDocumentId,
    profilePatch: imported.profilePatch, sections: imported.sections,
  } }));
  return job.id;
}

async function studioWorkspace(request: APIRequestContext, jobId: string) {
  return (await request.get(`${api}/api/jobs/${jobId}/application-studio`)).json() as Promise<any>;
}

async function waitForPersistedDraft(request: APIRequestContext, jobId: string) {
  await expect.poll(async () => Boolean((await studioWorkspace(request, jobId)).documents[0].draftContent)).toBe(true);
  return studioWorkspace(request, jobId);
}

async function seedDraft(request: APIRequestContext, jobId: string) {
  const workspace = await studioWorkspace(request, jobId);
  const document = workspace.documents[0];
  await json(await request.put(`${api}/api/jobs/${jobId}/document-drafts`, { data: {
    documentId: document.document.id,
    content: document.baseContent,
    proposalState: { turns: [], activeTurnId: null },
    expectedRevision: null,
  } }));
}

async function mockTailoring(page: Page, jobId: string, buildChanges: (baseContent: any) => any[]) {
  await page.route(`**/api/jobs/${jobId}/cv-tailoring`, async (route) => {
    const input = route.request().postDataJSON() as { documentId: string; baseContent: any };
    const changes = buildChanges(input.baseContent);
    const tailoredContent = changes.reduce((content, change) => {
      if (change.targetSectionField && change.targetSectionId) {
        return { ...content, sections: content.sections.map((section: any) => section.id === change.targetSectionId ? { ...section, [change.targetSectionField]: change.proposedContent } : section) };
      }
      if (change.targetField === "intro") return { ...content, intro: change.proposedContent };
      return content;
    }, structuredClone(input.baseContent));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      jobPostingId: jobId,
      documentId: input.documentId,
      baseVersionId: null,
      // Deliberately differs from the request. The editor must retain its exact
      // local snapshot until the user explicitly accepts an individual change.
      baseContent: { ...input.baseContent, name: "Normalised API copy", headline: "" },
      tailoredContent,
      changes,
      matches: [],
      gaps: [],
      summary: "Review these bounded changes.",
      provider: "e2e",
      model: "deterministic-fixture",
      generatedAt: new Date().toISOString(),
      durationMs: 15,
    }) });
  });
}

function proposalChange(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    changeKey: crypto.randomUUID(),
    operation: "rewrite",
    targetField: null,
    targetSectionField: null,
    targetSectionId: null,
    proposedPosition: null,
    originalTitle: "",
    originalContent: "",
    proposedEvidenceType: "experience",
    proposedTitle: "",
    proposedContent: "",
    rationale: "Requested change only.",
    evidenceIds: [],
    confidence: 0.99,
    ...overrides,
  };
}

function expectLocalVisualFidelity(preview: PNG, rendered: PNG, artifactPath: string) {
  const diff = new PNG({ width: preview.width, height: preview.height });
  // Chrome screenshots and Poppler rasterise identical vector text with
  // different hinting. Ignore those edge-tone differences while retaining the
  // strict changed-area and per-band guards below for real layout drift.
  const mismatched = pixelmatch(preview.data, rendered.data, diff.data, preview.width, preview.height, { threshold: 0.4, includeAA: false });
  writeFileSync(artifactPath, PNG.sync.write(diff));
  if (process.env.CAREEROS_KEEP_FIDELITY_ARTIFACTS === "1") {
    const artifactDirectory = join(process.cwd(), "test-artifacts", "pdf-fidelity");
    mkdirSync(artifactDirectory, { recursive: true });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    writeFileSync(join(artifactDirectory, `${suffix}-editor.png`), PNG.sync.write(preview));
    writeFileSync(join(artifactDirectory, `${suffix}-pdf.png`), PNG.sync.write(rendered));
    writeFileSync(join(artifactDirectory, `${suffix}-diff.png`), PNG.sync.write(diff));
  }
  expect(mismatched / (preview.width * preview.height)).toBeLessThan(0.055);

  const bandHeight = Math.max(48, Math.floor(preview.height / 14));
  for (let top = 0; top < preview.height; top += bandHeight) {
    const bottom = Math.min(preview.height, top + bandHeight);
    let bandMismatch = 0;
    for (let y = top; y < bottom; y += 1) for (let x = 0; x < preview.width; x += 1) {
      const offset = (y * preview.width + x) * 4;
      const pixelDiff = Math.max(
        Math.abs(preview.data[offset] - rendered.data[offset]),
        Math.abs(preview.data[offset + 1] - rendered.data[offset + 1]),
        Math.abs(preview.data[offset + 2] - rendered.data[offset + 2]),
      );
      if (pixelDiff > 64) bandMismatch += 1;
    }
    expect(bandMismatch / (preview.width * (bottom - top))).toBeLessThan(0.24);
  }
}

test("visual fidelity guard rejects a substantially wrong local page region", () => {
  const preview = new PNG({ width: 700, height: 990 });
  preview.data.fill(255);
  const rendered = PNG.sync.read(PNG.sync.write(preview));
  for (let y = 400; y < 500; y += 1) for (let x = 0; x < rendered.width; x += 1) {
    const offset = (y * rendered.width + x) * 4;
    rendered.data[offset] = 0;
    rendered.data[offset + 1] = 0;
    rendered.data[offset + 2] = 0;
  }
  const directory = mkdtempSync(join(tmpdir(), "careeros-visual-guard-"));
  try {
    expect(() => expectLocalVisualFidelity(preview, rendered, join(directory, "diff.png"))).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("visual fidelity guard rejects realistic repeated text displacement", () => {
  const preview = new PNG({ width: 700, height: 990 });
  preview.data.fill(255);
  for (let line = 0; line < 20; line += 1) for (let y = 90 + line * 34; y < 96 + line * 34; y += 1) for (let x = 70; x < 630; x += 1) {
    const offset = (y * preview.width + x) * 4;
    preview.data[offset] = preview.data[offset + 1] = preview.data[offset + 2] = 28;
  }
  const rendered = new PNG({ width: preview.width, height: preview.height });
  rendered.data.fill(255);
  for (let y = 6; y < rendered.height; y += 1) {
    rendered.data.set(preview.data.subarray((y - 6) * preview.width * 4, (y - 5) * preview.width * 4), y * preview.width * 4);
  }
  const directory = mkdtempSync(join(tmpdir(), "careeros-visual-shift-"));
  try {
    expect(() => expectLocalVisualFidelity(preview, rendered, join(directory, "diff.png"))).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function selectWord(locator: Locator, word: string) {
  await locator.evaluate((element, selectedWord) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const start = node.textContent?.indexOf(selectedWord) ?? -1;
      if (start >= 0) {
        (element as HTMLElement).focus();
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + selectedWord.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      node = walker.nextNode();
    }
    throw new Error(`Could not select ${selectedWord}`);
  }, word);
}

test("autosaves an edit, supports undo, and browser Back returns to Career Studio", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  const name = page.getByRole("textbox", { name: "CV name", exact: true });
  await expect(name).toHaveText("Zain Ahmad");
  await name.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("Zain A. Ahmad");
  await page.keyboard.press("Meta+Z");
  await expect(name).toHaveText("Zain Ahmad");
  await page.keyboard.press("Meta+Shift+Z");
  await expect(name).toHaveText("Zain A. Ahmad");
  await expect(page.getByText(/All edits saved/i)).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Career Studio" })).toBeVisible();
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  await expect(page.getByRole("textbox", { name: "CV name", exact: true })).toHaveText("Zain A. Ahmad");
});

test("autosaves deleting the final CV section and preserves the empty draft after reopening", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  const workspace = await studioWorkspace(request, jobId);
  const document = workspace.documents[0];
  await json(await request.put(`${api}/api/jobs/${jobId}/document-drafts`, { data: {
    documentId: document.document.id,
    content: { ...document.baseContent, sections: document.baseContent.sections.slice(0, 1) },
    proposalState: { turns: [], activeTurnId: null },
    expectedRevision: null,
  } }));

  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  await expect(page.getByTitle("Remove entry")).toHaveCount(1);
  await page.getByTitle("Remove entry").click();
  await expect(page.getByText(/All edits saved/i)).toBeVisible();
  await expect.poll(async () => {
    const next = await studioWorkspace(request, jobId);
    return next.documents.find((item: any) => item.document.id === document.document.id)?.draftContent?.sections.length;
  }).toBe(0);

  await page.reload();
  await expect(page.getByTitle("Remove entry")).toHaveCount(0);
  await expect(page.getByText("Add section", { exact: true })).toBeVisible();
});

test("flushes the current CV draft before switching imported documents", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  const imported = await json<any>(await request.post(`${api}/api/profile/imports`, { data: {
    sourceType: "file", documentType: "cv", title: "Second source CV", fileName: "second-source.txt",
    mimeType: "text/plain", dataBase64: Buffer.from("Zain Ahmad\nEngineering\nEducation\nImperial College London\nSecond document evidence.").toString("base64"),
  } }));
  await json(await request.post(`${api}/api/profile/imports/commit`, { data: {
    documentId: imported.document.id, sourceDocumentId: imported.sourceDocumentId,
    profilePatch: imported.profilePatch, sections: imported.sections,
  } }));

  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  const selector = page.getByLabel("Base CV");
  await expect(selector.locator(`option[value="${imported.document.id}"]`)).toHaveCount(1);
  const firstDocumentId = await selector.inputValue();
  const secondDocumentId = imported.document.id;
  expect(secondDocumentId).not.toBe(firstDocumentId);
  const name = page.getByRole("textbox", { name: "CV name", exact: true });
  await name.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("Pending Switch Name");
  await selector.selectOption(secondDocumentId);
  await expect(selector).toHaveValue(secondDocumentId);
  await selector.selectOption(firstDocumentId);
  await expect(selector).toHaveValue(firstDocumentId);
  await expect(page.getByRole("textbox", { name: "CV name", exact: true })).toHaveText("Pending Switch Name");
  await expect.poll(async () => {
    const persisted = await studioWorkspace(request, jobId);
    return persisted.documents.find((item: any) => item.document.id === firstDocumentId)?.draftContent?.name;
  }).toBe("Pending Switch Name");
});

test("coalesces rapid rich-text input into a bounded autosave request", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  let draftWrites = 0;
  page.on("request", (outgoing) => {
    if (outgoing.method() === "PUT" && /\/api\/jobs\/[^/]+\/document-drafts$/.test(new URL(outgoing.url()).pathname)) draftWrites += 1;
  });
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  const intro = page.getByRole("textbox", { name: "CV introduction" });
  await intro.click();
  await page.keyboard.type("A concise introduction typed rapidly for a hosted connection.");
  await expect(page.getByText(/All edits saved/i)).toBeVisible();
  expect(draftWrites).toBeLessThanOrEqual(2);
});

test("does not report saved while a newer edit waits behind an older save", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  await expect(page.getByText(/All edits saved/i)).toBeVisible();

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let writes = 0;
  await page.route(/\/api\/jobs\/[^/]+\/document-drafts$/, async (route) => {
    writes += 1;
    if (writes === 1) await firstGate;
    await route.continue();
  });

  const intro = page.getByRole("textbox", { name: "CV introduction" });
  await intro.fill("First edit");
  await expect.poll(() => writes).toBe(1);
  await intro.fill("First edit followed by a newer edit");
  const firstResponse = page.waitForResponse((response) => response.request().method() === "PUT" && /\/api\/jobs\/[^/]+\/document-drafts$/.test(new URL(response.url()).pathname));
  releaseFirst();
  await firstResponse;
  await expect(page.locator(".studio-draft-state")).toHaveText(/Saving/i);
  await expect(page.getByText(/All edits saved/i)).toBeVisible();
  await expect.poll(async () => (await studioWorkspace(request, jobId)).documents[0].draftContent.intro).toBe("First edit followed by a newer edit");
});

test("rejecting every proposal preserves byte-equivalent CV content and persists the decision", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  const beforeWorkspace = await waitForPersistedDraft(request, jobId);
  const beforeContent = beforeWorkspace.documents[0].draftContent;
  await mockTailoring(page, jobId, (baseContent) => [proposalChange({
    targetField: "intro",
    originalTitle: "Introduction",
    originalContent: baseContent.intro ?? "",
    proposedTitle: "Introduction",
    proposedContent: "A proposed introduction that must remain pending until accepted.",
  })]);

  await page.getByLabel("Ask AI to propose CV changes").fill("Propose a new introduction");
  await page.getByLabel("Ask AI to propose CV changes").press("Enter");
  await expect(page.getByText("1 reviewable change ready in 0.0s.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "CV name", exact: true })).toHaveText("Zain Ahmad");
  await page.getByRole("button", { name: "Reject all" }).click();
  await expect.poll(async () => Object.values((await studioWorkspace(request, jobId)).documents[0].draftProposalState.turns[0]?.decisions ?? {})).toEqual(["rejected"]);

  const afterWorkspace = await studioWorkspace(request, jobId);
  expect(JSON.stringify(afterWorkspace.documents[0].draftContent)).toBe(JSON.stringify(beforeContent));
  expect(Object.values(afterWorkspace.documents[0].draftProposalState.turns[0].decisions)).toEqual(["rejected"]);

  await page.reload();
  await expect(page.getByText("Review these bounded changes.")).toBeVisible();
  await expect(page.locator(".studio-change")).toHaveClass(/change-rejected/);
  await expect(page.getByRole("textbox", { name: "CV name", exact: true })).toHaveText("Zain Ahmad");
});

test("older unresolved proposal turns remain actionable and protect newer manual state", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  let call = 0;
  await mockTailoring(page, jobId, (baseContent) => {
    call += 1;
    return [proposalChange({
      changeKey: `intro-${call}`,
      targetField: "intro",
      originalTitle: "Introduction",
      originalContent: baseContent.intro ?? "",
      proposedTitle: "Introduction",
      proposedContent: call === 1 ? "First proposed introduction." : "Second proposed introduction.",
    })];
  });
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  const prompt = page.getByLabel("Ask AI to propose CV changes");
  await prompt.fill("Write the first introduction");
  await prompt.press("Enter");
  await expect(page.locator(".studio-change")).toContainText("First proposed introduction.");
  await prompt.fill("Write a different introduction");
  await prompt.press("Enter");
  await expect(page.locator(".studio-change")).toContainText("Second proposed introduction.");

  await page.getByRole("button", { name: /2 requests/ }).click();
  await page.locator(".studio-chat-turn-open").first().click();
  await expect(page.getByRole("button", { name: "Accept all" })).toBeVisible();
  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(page.getByRole("textbox", { name: "CV introduction" })).toHaveText("First proposed introduction.");

  await page.locator(".studio-chat-turn-open").nth(1).click();
  await page.getByRole("button", { name: "Accept all" }).click();
  await expect(page.locator(".studio-change .change-conflict")).toContainText("Manual edit preserved");
  await expect.poll(async () => (await studioWorkspace(request, jobId)).documents[0].draftContent.intro).toBe("First proposed introduction.");
});

test("restores an immutable snapshot into the active draft after saving a recovery point", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  const initial = await studioWorkspace(request, jobId);
  const document = initial.documents[0];
  await json(await request.post(`${api}/api/jobs/${jobId}/document-versions`, { data: {
    documentId: document.document.id,
    parentVersionId: null,
    expectedDraftRevision: document.draftRevision,
    checkpointName: "Known good CV",
    content: document.draftContent,
    acceptedChangeIds: [], proposalChanges: [], proposalDecisions: {},
    changeSummary: "Known good recovery fixture", provider: "manual", model: "",
  } }));
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  const name = page.getByRole("textbox", { name: "CV name", exact: true });
  await name.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("Temporary Edited Name");
  await expect(page.getByText(/All edits saved/i)).toBeVisible();
  await page.getByRole("button", { name: /Known good CV/ }).click();
  await page.getByRole("button", { name: "Restore as draft" }).click();
  await expect(name).toHaveText("Zain Ahmad");
  await expect.poll(async () => (await studioWorkspace(request, jobId)).documents[0].draftContent.name).toBe("Zain Ahmad");
  const restored = await studioWorkspace(request, jobId);
  expect(restored.documents[0].draftProposalState.turns).toHaveLength(0);
  expect(restored.documents[0].versions).toEqual(expect.arrayContaining([
    expect.objectContaining({ checkpointName: expect.stringContaining("Before restoring"), proposalChanges: expect.any(Array) }),
  ]));
});

test("Command-Z after accepting a proposal restores both content and proposal history", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  await mockTailoring(page, jobId, (baseContent) => [proposalChange({
    targetField: "intro",
    originalTitle: "Introduction",
    originalContent: baseContent.intro ?? "",
    proposedTitle: "Introduction",
    proposedContent: "Accepted proposal copy.",
  })]);

  await page.getByLabel("Ask AI to propose CV changes").fill("Tighten the introduction");
  await page.getByLabel("Ask AI to propose CV changes").press("Enter");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "CV introduction" })).toHaveText("Accepted proposal copy.");
  await page.getByRole("textbox", { name: "CV introduction" }).click();
  await page.keyboard.press("Meta+Z");

  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  await expect.poll(async () => (await studioWorkspace(request, jobId)).documents[0].draftProposalState.turns[0]?.decisions ?? {}).toEqual({});
  await expect.poll(async () => (await studioWorkspace(request, jobId)).documents[0].draftContent.intro).not.toBe("Accepted proposal copy.");
});

test("proposal decisions preserve manual edits made after generation and expose a manual conflict", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  await mockTailoring(page, jobId, (baseContent) => [proposalChange({
    targetField: "intro",
    originalTitle: "Introduction",
    originalContent: baseContent.intro ?? "",
    proposedTitle: "Introduction",
    proposedContent: "AI introduction that must not replace later manual work.",
  })]);

  await page.getByLabel("Ask AI to propose CV changes").fill("Rewrite the introduction");
  await page.getByLabel("Ask AI to propose CV changes").press("Enter");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const intro = page.getByRole("textbox", { name: "CV introduction" });
  await intro.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("Manual introduction written after proposal generation.");
  await page.locator(".studio-change").getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Accept", exact: true }).click();

  await expect(page.locator(".studio-change")).toHaveClass(/change-conflict/);
  await page.locator(".studio-change").scrollIntoViewIfNeeded();
  await expect(page.locator(".studio-change .change-conflict")).toContainText("Manual edit preserved");
  await expect.poll(async () => (await studioWorkspace(request, jobId)).documents[0].draftContent.intro).toBe("Manual introduction written after proposal generation.");
  await expect.poll(async () => Object.values((await studioWorkspace(request, jobId)).documents[0].draftProposalState.turns[0].decisions)).toEqual(["conflict"]);
});

test("real provider-bound tailoring path interprets, validates, targets, and renders evidence without route interception", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  const seeded = await studioWorkspace(request, jobId);
  const target = seeded.documents[0].draftContent.sections.find((section: any) => section.evidenceType !== "skill") ?? seeded.documents[0].draftContent.sections[0];
  expect(target).toBeTruthy();
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  const editor = page.getByRole("textbox", { name: "Ask AI to propose CV changes" });
  await editor.fill(`Improve only the ${target.title} entry for this job`);
  await editor.press("Enter");
  await expect(page.getByText("Provider-bound proposal ready for review.")).toBeVisible();
  await expect(page.locator(".studio-change")).toHaveCount(1);
  await expect(page.locator(".studio-change")).toContainText(target.title);
  await expect(page.locator(".change-evidence span")).toHaveCount(1);
  const providerState = await (await request.get("http://127.0.0.1:4329/mock/state")).json() as { aiCalls: number };
  expect(providerState.aiCalls).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect.poll(async () => {
    const turn = (await studioWorkspace(request, jobId)).documents[0].draftProposalState.turns[0];
    return turn ? Object.values(turn.decisions) : [];
  }).toEqual(["accepted"]);
});

test("manual conflict flushes every final rich-text keystroke before proposal decisions", async ({ page, request }) => {
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const jobId = await seedStudio(request);
    await seedDraft(request, jobId);
    await page.goto(`/career-studio/jobs/${jobId}/cv`);
    await mockTailoring(page, jobId, (baseContent) => [proposalChange({ targetField: "intro", originalTitle: "Introduction", originalContent: baseContent.intro ?? "", proposedTitle: "Introduction", proposedContent: "AI text that must lose to the manual edit." })]);
    await page.getByLabel("Ask AI to propose CV changes").fill("Rewrite the introduction");
    await page.getByLabel("Ask AI to propose CV changes").press("Enter");
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    const value = `Manual final text ${iteration} with every keystroke preserved.`;
    const intro = page.getByRole("textbox", { name: "CV introduction" });
    await intro.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.type(value, { delay: iteration % 2 });
    await page.locator(".studio-change").getByRole("button", { name: "Undo" }).click();
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page.locator(".studio-change")).toHaveClass(/change-conflict/);
    await expect.poll(async () => (await studioWorkspace(request, jobId)).documents[0].draftContent.intro).toBe(value);
  }
});

test("whole-entry proposals cannot overwrite a manually edited untargeted field", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  const seeded = await studioWorkspace(request, jobId);
  const target = seeded.documents[0].draftContent.sections.find((item: any) => item.evidenceType !== "skill") ?? seeded.documents[0].draftContent.sections[0];
  expect(target).toBeTruthy();
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  await mockTailoring(page, jobId, () => [proposalChange({
      operation: "rewrite",
      targetSectionId: target.id,
      originalTitle: target.title,
      originalContent: target.content,
      proposedEvidenceType: target.evidenceType,
      proposedTitle: target.title,
      proposedContent: "- Tailored TypeScript delivery evidence.",
      evidenceIds: target.sourceEvidenceIds,
    })]);

  await page.getByLabel("Ask AI to propose CV changes").fill("Rewrite only the SageCare evidence");
  await page.getByLabel("Ask AI to propose CV changes").press("Enter");
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const location = page.getByRole("textbox", { name: `${target.title} location` });
  await location.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("Manchester, United Kingdom");
  await page.locator(".studio-change").getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Accept", exact: true }).click();

  await expect(page.locator(".studio-change .change-conflict")).toContainText("Manual edit preserved");
  await page.getByRole("button", { name: "Keep manual" }).click();
  await expect(location).toHaveText("Manchester, United Kingdom");
  await expect.poll(async () => (await studioWorkspace(request, jobId)).documents[0].draftContent.sections.find((item: any) => item.id === target.id)?.location).toBe("Manchester, United Kingdom");
});

test("reorder proposals move existing entries without replacing their manual content", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  const seeded = await studioWorkspace(request, jobId);
  const target = seeded.documents[0].draftContent.sections.find((item: any) => item.evidenceType !== "skill") ?? seeded.documents[0].draftContent.sections[0];
  expect(target).toBeTruthy();
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  await mockTailoring(page, jobId, () => [proposalChange({
      operation: "reorder",
      targetSectionId: target.id,
      proposedPosition: 0,
      originalTitle: target.title,
      originalContent: target.content,
      proposedEvidenceType: target.evidenceType,
      proposedTitle: target.title,
      proposedContent: target.content,
      evidenceIds: target.sourceEvidenceIds,
    })]);

  await page.getByLabel("Ask AI to propose CV changes").fill("Move SageCare to the top");
  await page.getByLabel("Ask AI to propose CV changes").press("Enter");
  const bullets = page.getByRole("textbox", { name: `${target.title} bullet points` });
  await bullets.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("- Manual evidence that must survive reordering.");
  await page.getByRole("button", { name: "Accept", exact: true }).click();

  await expect(page.locator(".studio-change")).toHaveClass(/change-accepted/);
  await expect(bullets).toHaveText("- Manual evidence that must survive reordering.");
  await expect.poll(async () => (await studioWorkspace(request, jobId)).documents[0].draftContent.sections.find((item: any) => item.id === target.id)?.content).toBe("- Manual evidence that must survive reordering.");
});

test("stale draft recovery compares, reloads, and retries without losing local work", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  await expect(page.getByText(/All edits saved/i)).toBeVisible();
  const before = await waitForPersistedDraft(request, jobId);
  const document = before.documents[0];
  await json(await request.put(`${api}/api/jobs/${jobId}/document-drafts`, { data: {
    documentId: document.document.id,
    content: { ...document.draftContent, intro: "Remote collaborator introduction." },
    proposalState: document.draftProposalState,
    expectedRevision: document.draftRevision,
  } }));

  const name = page.getByRole("textbox", { name: "CV name", exact: true });
  await name.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("Locally Preserved Name");
  await expect(page.getByText("Newer saved draft found", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Compare exact text" }).click();
  await expect(page.getByText("Your local copy").first()).toBeVisible();
  await expect(page.getByLabel("Newer saved draft found").getByText("Locally Preserved Name")).toBeVisible();
  await page.getByRole("button", { name: "Use latest saved" }).click();
  await expect(page.getByRole("textbox", { name: "CV introduction" })).toHaveText("Remote collaborator introduction.");
  await page.getByRole("button", { name: "Restore local and retry" }).click();

  await expect(page.getByRole("textbox", { name: "CV name", exact: true })).toHaveText("Locally Preserved Name");
  await expect.poll(async () => (await studioWorkspace(request, jobId)).documents[0].draftContent.name).toBe("Locally Preserved Name");
  await expect(page.getByText(/Local work saved/i)).toBeVisible();
});

test("collaboration refresh never replaces an active local CV edit", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  await waitForPersistedDraft(request, jobId);
  const name = page.getByRole("textbox", { name: "CV name", exact: true });
  await name.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("Local Edit During Refresh");
  await page.evaluate(() => window.dispatchEvent(new Event("careeros:remote-mutation")));
  await page.waitForTimeout(900);
  await expect(name).toHaveText("Local Edit During Refresh");
  await expect.poll(async () => (await studioWorkspace(request, jobId)).documents[0].draftContent.name).toBe("Local Edit During Refresh");
});

test("undoing one overlapping accepted change preserves the other and survives reopening", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  await waitForPersistedDraft(request, jobId);
  let originalLocation = "";
  await mockTailoring(page, jobId, (baseContent) => {
    const target = baseContent.sections.find((section: any) => section.evidenceType === "education") ?? baseContent.sections[0];
    originalLocation = target.location ?? "";
    return [
      proposalChange({
        changeKey: "overlap-location",
        targetSectionField: "location",
        targetSectionId: target.id,
        originalTitle: "Imported entry location",
        originalContent: target.location ?? "",
        proposedTitle: "Imported entry location",
        proposedContent: "Singapore",
      }),
      proposalChange({
        changeKey: "overlap-content",
        targetSectionField: "content",
        targetSectionId: target.id,
        originalTitle: "Imported entry bullet points",
        originalContent: target.content,
        proposedTitle: "Imported entry bullet points",
        proposedContent: "- Built an accessible TypeScript product.\n- Improved navigation using measured user behaviour.",
      }),
    ];
  });

  await page.getByLabel("Ask AI to propose CV changes").fill("Change the SageCare location and sharpen its bullet points");
  await page.getByLabel("Ask AI to propose CV changes").press("Enter");
  await expect(page.getByRole("button", { name: "Accept all" })).toBeVisible();
  await page.getByRole("button", { name: "Accept all" }).click();
  const locationChange = page.locator(".studio-change", { hasText: "Imported entry location" });
  await locationChange.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => Object.values((await studioWorkspace(request, jobId)).documents[0].draftProposalState.turns[0]?.decisions ?? {})).toEqual(["accepted"]);

  const workspace = await studioWorkspace(request, jobId);
  const document = workspace.documents[0];
  const changedEntry = document.draftContent.sections.find((section: any) => section.evidenceType === "education") ?? document.draftContent.sections[0];
  expect(changedEntry.location ?? "").toBe(originalLocation);
  expect(changedEntry.content).toContain("Improved navigation using measured user behaviour.");
  const decisions = document.draftProposalState.turns[0].decisions;
  expect(Object.values(decisions)).toEqual(["accepted"]);

  await page.reload();
  const reopenedLocationChange = page.locator(".studio-change", { hasText: "Imported entry location" });
  const reopenedContentChange = page.locator(".studio-change", { hasText: "Imported entry bullet points" });
  await expect(reopenedLocationChange.getByRole("button", { name: "Accept" })).toBeVisible();
  await expect(reopenedContentChange).toHaveClass(/change-accepted/);
});

test("Discover searches beyond page one, manages alerts, reports partial failures, and remains usable on mobile", async ({ page }) => {
  await page.goto("/discover");
  await expect(page.locator(".discover-table-row:not(.discover-table-head)")).toHaveCount(100);
  await page.getByRole("button", { name: "Load more roles" }).click();
  await expect(page.locator(".discover-table-row:not(.discover-table-head)")).toHaveCount(120);
  await page.getByPlaceholder("Search every discovered role...").fill("Needle Capital");
  await expect(page.locator(".discover-table-row:not(.discover-table-head)")).toHaveCount(1);
  await expect(page.getByText("Quantitative Research Intern", { exact: true })).toBeVisible();
  await page.getByLabel("Role family").selectOption("Quantitative research");
  await page.getByLabel("Career track").selectOption("Quantitative finance");
  await expect(page.getByText("1 matches")).toBeVisible();
  await expect(page.getByRole("link", { name: /Open Quantitative Research Intern/ })).toHaveAttribute("href", "https://jobs.example/115?apply=1");
  await page.getByRole("button", { name: "Alerts" }).click();
  await page.getByLabel("Name").fill("London quant alerts");
  await page.getByRole("button", { name: "Save alert" }).click();
  await expect(page.getByText("London quant alerts", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit London quant alerts" }).click();
  await page.getByLabel("Name").fill("Edited quant alerts");
  await page.getByLabel("Locations").fill("New York");
  await page.getByRole("button", { name: "Update alert" }).click();
  await expect(page.getByText("Edited quant alerts", { exact: true })).toBeVisible();
  await expect(page.locator(".alert-rule-row", { hasText: "Edited quant alerts" })).toContainText("New York");
  await expect(page.locator(".source-monitor-row", { hasText: "Broken source" })).toContainText("Needs attention");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("Discover uses the real Fastify and SQLite path and preserves loaded pages during refresh", async ({ page, request }) => {
  const apiResult = await request.get(`${api}/api/discovery?q=E2E%20Capital&careerTrack=Technology&programme=Placement`);
  expect(apiResult.ok(), await apiResult.text()).toBeTruthy();
  expect((await apiResult.json()).postings).toEqual([expect.objectContaining({
    companyName: "E2E Capital", programme: "Placement", careerTrack: "Technology",
  })]);

  await page.clock.install();
  await page.goto("/discover");
  await expect(page.locator(".discover-table-row:not(.discover-table-head)")).toHaveCount(100);
  await page.getByRole("button", { name: "Load more roles" }).click();
  await expect(page.locator(".discover-table-row:not(.discover-table-head)")).toHaveCount(120);

  await page.clock.fastForward(60_100);
  await expect(page.locator(".discover-table-row:not(.discover-table-head)")).toHaveCount(120);
  await expect(page.getByPlaceholder("Search every discovered role...")).toHaveValue("");

  await page.getByPlaceholder("Search every discovered role...").fill("E2E Capital");
  await page.getByLabel("Career track").selectOption("Technology");
  await page.getByLabel("Programme").selectOption("Placement");
  await expect(page.locator(".discover-table-row:not(.discover-table-head)")).toHaveCount(1);
  await expect(page.getByText("Software Engineering Industrial Placement", { exact: true })).toBeVisible();
  await expect(page.getByText("Engineering · Technology", { exact: true })).toBeVisible();
});

test("Opportunities remains readable as labelled cards without mobile overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/opportunities");
  await expect(page.getByRole("heading", { name: "Opportunities", exact: true })).toBeVisible();

  const firstRow = page.locator(".workspace-table .table-row:not(.table-head)").first();
  await expect(firstRow).toBeVisible();
  await expect(firstRow.locator('[data-label="Opportunity"]')).toBeVisible();
  await expect(firstRow.locator('[data-label="Salary"]')).toBeVisible();
  await expect(firstRow.locator('[data-label="Application"]')).toBeVisible();

  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    rowRight: document.querySelector(".workspace-table .table-row:not(.table-head)")?.getBoundingClientRect().right ?? 0,
  }));
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.rowRight).toBeLessThanOrEqual(geometry.viewport);
});

test("queues 20 rapid captures plus a blocked URL without losing the composer", async ({ page }) => {
  await page.goto("/capture");
  const composer = page.getByLabel("Paste one complete job page");
  for (let index = 1; index <= 20; index += 1) {
    await composer.fill(`Role: Quant Trading Analyst ${index}\nCompany: Finance Firm ${index}\nLocation: London\nRequirements: Python, probability, market microstructure`);
    await page.keyboard.press("Meta+Enter");
    await expect(composer).toHaveValue("");
  }
  await page.getByRole("tab", { name: "Public links" }).click();
  await page.getByLabel("Paste one or many public job links").fill("http://127.0.0.1/jobs/private");
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByLabel("Paste one or many public job links")).toHaveValue("");
  await page.getByRole("button", { name: /Opportunities/ }).click();
  await expect(page.getByRole("heading", { name: "Opportunities", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Capture inbox/ }).click();
  await expect(page.getByText("21 total")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Retry" }).first().click();
  const saveValid = page.getByRole("button", { name: /Save \d+ valid/ });
  await expect(saveValid).toBeVisible({ timeout: 20_000 });
  await saveValid.click();
  await expect(page.locator(".capture-state", { hasText: "Saved" }).first()).toBeVisible({ timeout: 15_000 });
});

test("recovers an unsent capture after navigation and refresh without browser storage", async ({ page }) => {
  await page.goto("/capture");
  const composer = page.getByLabel("Paste one complete job page");
  const source = "Recovered LinkedIn Role\nCompany: Recovery Capital\nLocation: London";
  await composer.fill(source);
  await page.waitForTimeout(450);
  await page.route(/\/api\/capture-drafts\/[^/]+\/enqueue$/, (route) => route.abort("failed"));
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText(/preserved and can be retried/i)).toBeVisible();
  await page.getByRole("button", { name: /Opportunities/ }).click();
  await page.getByRole("button", { name: /Capture inbox/ }).click();
  await expect(page.getByLabel("Paste one complete job page")).toHaveValue(source);
  await page.reload();
  await expect(page.getByLabel("Paste one complete job page")).toHaveValue(source);
});

test("keeps composer text when draft persistence fails even if draft listing succeeds", async ({ page }) => {
  await page.goto("/capture");
  const composer = page.getByLabel("Paste one complete job page");
  const source = "Failed draft persistence role\nCompany: Recovery Capital\nLocation: London";
  await composer.fill(source);
  await page.route(/\/api\/capture-drafts\/[^/]+$/, async (route) => {
    if (route.request().method() === "PUT") await route.abort("failed");
    else await route.continue();
  });
  await page.keyboard.press("Meta+Enter");
  await expect(page.getByText(/text remains in the composer so you can retry/i)).toBeVisible();
  await expect(composer).toHaveValue(source);
  const drafts = await page.request.get(`${api}/api/capture-drafts`);
  expect(drafts.ok(), await drafts.text()).toBeTruthy();
  await expect(composer).toHaveValue(source);
});

test("keeps loaded older capture pages through automatic polling", async ({ page, request }) => {
  const prefix = `Paging ${crypto.randomUUID().slice(0, 8)}`;
  const queued = await request.post(`${api}/api/capture-queue`, { data: { items: Array.from({ length: 60 }, (_, index) => ({
    sourceType: "pasted_text", text: `Quant Analyst ${prefix} ${index}\nCompany: Paging Capital ${index}\nLocation: London`,
  })) } });
  expect(queued.ok(), await queued.text()).toBeTruthy();
  await page.goto("/capture");
  await expect(page.getByRole("button", { name: "Load older captures" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Load older captures" }).click();
  await expect(page.locator(".capture-queue-row", { hasText: prefix })).toHaveCount(60, { timeout: 15_000 });
  await page.waitForTimeout(3_500);
  await expect(page.locator(".capture-queue-row", { hasText: prefix })).toHaveCount(60);
});

test("contains focus inside capture review and restores it on close", async ({ page, request }) => {
  const marker = `Focus Review Analyst ${crypto.randomUUID().slice(0, 8)}`;
  const queued = await json<Array<{ id: string }>>(await request.post(`${api}/api/capture-queue`, { data: { items: [{
    sourceType: "pasted_text", text: `${marker}\nCompany: Focus Capital\nLocation: London`,
  }] } }));
  await expect.poll(async () => {
    const response = await request.get(`${api}/api/capture-queue/${queued[0].id}`);
    return (await response.json()).state;
  }).toBe("Needs Review");
  await page.goto("/capture");
  const reviewButton = page.locator(".capture-queue-row", { hasText: marker }).getByRole("button", { name: "Review" });
  await reviewButton.focus();
  await reviewButton.click();
  await expect(page.getByRole("dialog", { name: "Review opportunity" })).toBeVisible();
  for (let index = 0; index < 45; index += 1) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".import-panel")))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Review opportunity" })).toBeHidden();
  await expect(reviewButton).toBeFocused();
});

test("opens the exact late duplicate after an atomic batch save conflict", async ({ page, request }) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const duplicateTitle = `Late Duplicate Analyst ${suffix}`;
  const queued = await json<Array<{ id: string }>>(await request.post(`${api}/api/capture-queue`, { data: { items: [
    { sourceType: "pasted_text", text: `${duplicateTitle}\nCompany: Late Browser Capital\nLocation: London` },
    { sourceType: "pasted_text", text: `Unaffected Analyst ${suffix}\nCompany: Unaffected Browser Capital\nLocation: London` },
  ] } }));
  for (const item of queued) await expect.poll(async () => (await (await request.get(`${api}/api/capture-queue/${item.id}`)).json()).state).toBe("Needs Review");
  await json(await request.post(`${api}/api/jobs`, { data: { title: duplicateTitle, companyName: "Late Browser Capital", location: "London" } }));

  await page.goto("/capture");
  await page.getByRole("button", { name: /Save \d+ valid/ }).click();
  await expect(page.getByRole("dialog", { name: "Review opportunity" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Role or internship name" })).toHaveValue(duplicateTitle);
  await expect(page.getByText("Choose what to do with this possible duplicate")).toBeVisible();
  const unaffected = await request.get(`${api}/api/capture-queue/${queued[1].id}`);
  expect((await unaffected.json()).state).toBe("Needs Review");
});

test("persists one-word bold and italic formatting and preserves it in the visually matched PDF", async ({ page, request }) => {
  test.setTimeout(60_000);
  const jobId = await seedStudio(request);
  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  await expect(page.locator(".studio-document-page")).toHaveCount(1);
  await expect(page.getByText(/All edits saved/i)).toBeVisible();
  const selectedDocumentId = await page.getByLabel("Base CV").inputValue();
  const bullets = page.locator('[role="textbox"][contenteditable="true"]').filter({ hasText: "accessible web product" }).first();
  await selectWord(bullets, "accessible");
  await page.keyboard.press("Meta+B");
  await expect.poll(() => bullets.evaluate((element) => element.innerHTML)).toMatch(/<(?:strong|b)[^>]*>accessible<\/(?:strong|b)>|font-weight:\s*(?:bold|700)[^>]*>accessible/i);
  await selectWord(bullets, "TypeScript");
  await page.keyboard.press("Meta+I");
  await expect.poll(() => bullets.evaluate((element) => element.innerHTML)).toMatch(/<(?:em|i)[^>]*>TypeScript<\/(?:em|i)>|font-style:\s*italic[^>]*>TypeScript/i);
  await expect.poll(async () => {
    const persisted = await studioWorkspace(request, jobId);
    const selected = persisted.documents.find((item: any) => item.document.id === selectedDocumentId);
    if (!selected?.draftContent?.intro?.includes("accessible web product")) return [];
    return selected.draftContent.inlineFormatting
      .filter((mark: any) => mark.field === "intro")
      .map((mark: any) => ({ text: selected.draftContent.intro.slice(mark.start, mark.end), bold: mark.bold, italic: mark.italic }));
  }).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: "accessible", bold: true }),
    expect.objectContaining({ text: "TypeScript", italic: true }),
  ]));
  await expect(page.getByText(/All edits saved/i)).toBeVisible();
  await page.reload();
  const reopenedBullets = page.locator('[role="textbox"][contenteditable="true"]').filter({ hasText: "accessible web product" }).first();
  await expect.poll(() => reopenedBullets.evaluate((element) => element.innerHTML)).toMatch(/<(?:strong|b)>accessible<\/(?:strong|b)>/i);
  await expect.poll(() => reopenedBullets.evaluate((element) => element.innerHTML)).toMatch(/<(?:em|i)>TypeScript<\/(?:em|i)>/i);
  await page.addStyleTag({ content: `.studio-document-toolbar{visibility:hidden!important}.studio-document-page{border:0!important;box-shadow:none!important;background:#fff!important}.studio-entry-drag,.studio-entry-remove,.studio-group-drag,.studio-group-spacing-controls,.studio-page-number{display:none!important}` });
  const previewBytes = await page.locator(".studio-document-page").screenshot();

  const workspace = await (await request.get(`${api}/api/jobs/${jobId}/application-studio`)).json();
  const document = workspace.documents.find((item: any) => item.document.id === selectedDocumentId);
  const content = document.draftContent ?? document.baseContent;
  const saved = await json<any>(await request.post(`${api}/api/jobs/${jobId}/document-versions`, { data: {
    documentId: document.document.id, expectedDraftRevision: document.draftRevision,
    checkpointName: "Visual fidelity fixture", content, acceptedChangeIds: [], changeSummary: "Visual fidelity test",
    provider: "manual", model: "",
  } }));
  const exported = await request.post(`${api}/api/document-versions/${saved.id}/pdf`, { data: {
    pageSectionIds: [content.sections.map((section: { id: string }) => section.id)], markAsSubmitted: false, applicationId: null,
  } });
  expect(exported.ok(), await exported.text()).toBeTruthy();
  const pdf = await request.get(`${api}/api/document-versions/${saved.id}/pdf`);
  expect(pdf.ok()).toBeTruthy();

  const directory = mkdtempSync(join(tmpdir(), "careeros-visual-fidelity-"));
  try {
    const pdfPath = join(directory, "cv.pdf");
    const prefix = join(directory, "rendered");
    writeFileSync(pdfPath, Buffer.from(await pdf.body()));
    const preview = PNG.sync.read(previewBytes);
    await execFileAsync("pdftoppm", ["-png", "-f", "1", "-singlefile", "-scale-to-x", String(preview.width), "-scale-to-y", String(preview.height), pdfPath, prefix]);
    const rendered = PNG.sync.read(readFileSync(`${prefix}.png`));
    expectLocalVisualFidelity(preview, rendered, join(directory, "diff.png"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exports a realistic multipage CV through preflight and links the exact PDF to the application", async ({ page, request }) => {
  test.setTimeout(90_000);
  const jobId = await seedStudio(request);
  const workspace = await studioWorkspace(request, jobId);
  const document = workspace.documents[0];
  const base = document.baseContent;
  const sections = Array.from({ length: 16 }, (_, index) => ({
    id: `multipage-${index + 1}`,
    evidenceType: index < 2 ? "education" : index < 12 ? "experience" : index < 15 ? "project" : "skill",
    groupTitle: index < 2 ? "Education" : index < 12 ? "Professional Experience" : index < 15 ? "Projects" : "Skills",
    title: index === 15 ? "Technical skills" : `Evidence entry ${index + 1}`,
    subtitle: index === 15 ? "" : "Role, qualification, or project",
    date: index === 15 ? "" : `20${String(10 + index).padStart(2, "0")} - 20${String(11 + index).padStart(2, "0")}`,
    location: index === 15 ? "" : index % 3 === 0 ? "Singapore" : "London, United Kingdom",
    content: index === 15
      ? "Python, TypeScript, SQL, statistics, product design, prototyping"
      : "- Delivered a measurable technical outcome using evidence-backed analysis.\n- Worked across engineering, product, and stakeholder requirements.\n- Communicated decisions clearly and improved the final result.",
    sourceEvidenceIds: [],
    spacingBefore: index === 0 || index === 2 || index === 12 || index === 15 ? 7 : undefined,
  }));
  await json(await request.put(`${api}/api/jobs/${jobId}/document-drafts`, { data: {
    documentId: document.document.id,
    content: { ...base, style: { ...base.style, fontFamily: "inter", fontSize: 10, lineHeight: 1.2, sectionSpacing: 7, entrySpacing: 2, headerSpacing: 3, nameAlignment: "center" }, sections },
    proposalState: { turns: [], activeTurnId: null },
    expectedRevision: null,
  } }));

  await page.goto(`/career-studio/jobs/${jobId}/cv`);
  await expect(page.locator(".studio-document-page")).toHaveCount(2);
  await expect(page.getByText(/All edits saved/i)).toBeVisible();
  await page.addStyleTag({ content: `.studio-document-toolbar{visibility:hidden!important}.studio-document-page{border:0!important;box-shadow:none!important;background:#fff!important}.studio-entry-drag,.studio-entry-remove,.studio-group-drag,.studio-group-spacing-controls,.studio-page-number{display:none!important}` });
  const previews = await page.locator(".studio-document-page").all();
  const previewBytes = await Promise.all(previews.map((preview) => preview.screenshot()));

  await page.getByRole("button", { name: "Export PDF" }).click();
  await expect(page.getByRole("heading", { name: "Ready to export" })).toBeVisible();
  await page.getByLabel("Record this exact PDF as the CV submitted for this application").check();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export verified PDF" }).click();
  await downloadPromise;
  await expect(page.getByText(/PDF exported from immutable snapshot/i)).toBeVisible();

  const savedWorkspace = await studioWorkspace(request, jobId);
  const version = savedWorkspace.documents[0].versions[0];
  expect(version.relativePath).toBeTruthy();
  expect(version.submittedAt).toBeTruthy();
  const exportedBundle = await (await request.get(`${api}/api/export`)).json();
  expect(exportedBundle.data.application_materials).toEqual(expect.arrayContaining([
    expect.objectContaining({ application_id: savedWorkspace.job.applicationId, document_version_id: version.id, material_type: "cv" }),
  ]));

  const pdf = await request.get(`${api}/api/document-versions/${version.id}/pdf`);
  expect(pdf.ok()).toBeTruthy();
  const directory = mkdtempSync(join(tmpdir(), "careeros-multipage-fidelity-"));
  try {
    const pdfPath = join(directory, "cv.pdf");
    const prefix = join(directory, "rendered");
    writeFileSync(pdfPath, Buffer.from(await pdf.body()));
    const firstPreview = PNG.sync.read(previewBytes[0]);
    await execFileAsync("pdftoppm", ["-png", "-scale-to-x", String(firstPreview.width), "-scale-to-y", String(firstPreview.height), pdfPath, prefix]);
    for (let index = 0; index < previewBytes.length; index += 1) {
      const preview = PNG.sync.read(previewBytes[index]);
      const rendered = PNG.sync.read(readFileSync(`${prefix}-${index + 1}.png`));
      expectLocalVisualFidelity(preview, rendered, join(directory, `diff-${index + 1}.png`));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps Application Studio usable on a mobile viewport through explicit panes", async ({ page, request }) => {
  const jobId = await seedStudio(request);
  await seedDraft(request, jobId);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/career-studio/jobs/${jobId}/cv`);

  const tabs = page.getByRole("tablist", { name: "Application Studio areas" });
  await expect(tabs).toBeVisible();
  await expect(page.getByRole("tab", { name: "CV" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".studio-document-page").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  await page.getByRole("tab", { name: "AI changes" }).click();
  await expect(page.getByLabel("Ask AI to propose CV changes")).toBeVisible();
  await page.getByRole("tab", { name: "Job" }).click();
  await expect(page.getByRole("heading", { name: "Job context" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("exports a complete backup and stages only a valid restore without changing live data", async ({ page, request }) => {
  test.setTimeout(90_000);
  const pendingRestorePath = join(tmpdir(), ".careeros-e2e-data-restore-pending.json");
  const directory = mkdtempSync(join(tmpdir(), "careeros-portability-browser-"));
  rmSync(pendingRestorePath, { force: true });
  try {
    const jobId = await seedStudio(request);
    await seedDraft(request, jobId);
    const before = await (await request.get(`${api}/api/jobs`)).json() as { jobs: Array<{ id: string }> };
    const beforeIds = before.jobs.map((job) => job.id).sort();
    await page.goto("/");
    const exportButton = page.getByRole("button", { name: "Export backup", exact: true });
    const restoreButton = page.getByRole("button", { name: "Restore backup", exact: true });
    await expect(exportButton).toBeVisible();
    await expect(restoreButton).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await exportButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^careeros-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const validPath = join(directory, "valid-careeros-backup.json");
    await download.saveAs(validPath);
    const validBundle = JSON.parse(readFileSync(validPath, "utf8")) as any;
    expect(validBundle.manifest).toMatchObject({ bundleVersion: 1, schemaVersion: 4, applicationVersion: "0.1.0" });
    expect(validBundle.manifest.database.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(validBundle.structuredData.tables.some((table: { name: string }) => table.name === "document_drafts")).toBe(true);
    expect(validBundle.structuredData.tables.some((table: { name: string }) => table.name === "application_events")).toBe(true);
    const fileInput = page.locator('input[type="file"][accept*="json"]');
    await fileInput.setInputFiles({ name: "not-a-backup.json", mimeType: "application/json", buffer: Buffer.from("{ definitely not json") });
    await expect(page.getByText("That file is not a valid CareerOS JSON backup.")).toBeVisible();
    expect(existsSync(pendingRestorePath)).toBe(false);
    let current = await (await request.get(`${api}/api/jobs`)).json() as { jobs: Array<{ id: string }> };
    expect(current.jobs.map((job) => job.id).sort()).toEqual(beforeIds);
    const tamperedBundle = structuredClone(validBundle);
    tamperedBundle.databaseBase64 = Buffer.from("tampered database").toString("base64");
    page.once("dialog", (dialog) => void dialog.accept());
    await fileInput.setInputFiles({ name: "tampered-careeros-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(tamperedBundle)) });
    await expect(page.getByText(/Database snapshot checksum or size does not match its manifest/i)).toBeVisible();
    expect(existsSync(pendingRestorePath)).toBe(false);
    const afterRestoreResponse = await request.get(`${api}/api/jobs`);
    expect(afterRestoreResponse.ok(), await afterRestoreResponse.text()).toBeTruthy();
    current = await afterRestoreResponse.json() as { jobs: Array<{ id: string }> };
    expect(current.jobs.map((job) => job.id).sort()).toEqual(beforeIds);
    page.once("dialog", (dialog) => void dialog.accept());
    await fileInput.setInputFiles(validPath);
    await expect(page.locator(".alert-success")).toContainText("Backup verified. Restart CareerOS to apply it before the database opens.");
    expect(existsSync(pendingRestorePath)).toBe(true);
    const staged = JSON.parse(readFileSync(pendingRestorePath, "utf8"));
    expect(staged.databaseSha256).toBe(validBundle.manifest.database.sha256);
  } finally {
    rmSync(pendingRestorePath, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
