import { expect, test, type APIRequestContext } from "@playwright/test";

const api = "http://127.0.0.1:4310";
const web = "http://127.0.0.1:5173";

async function json<T>(response: Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<T>;
}

async function seedSharedStudio(request: APIRequestContext) {
  const job = await json<{ id: string }>(await request.post(`${api}/api/jobs`, { data: {
    title: "Shared Markets Analyst",
    companyName: "Collaboration Capital",
    location: "London",
    requiredRequirements: ["Markets", "Python"],
  } }));
  await json(await request.post(`${api}/api/jobs/${job.id}/applications`, { data: { priority: "High" } }));
  const sourceText = [
    "Zain Ahmad", "Design Engineer", "zain@example.com",
    "Education", "Imperial College London", "MEng Design Engineering | 2022-2026 | London",
    "Professional Experience", "Krislite", "Design Engineer Intern | 2025 | Singapore", "- Built a fibre-optic product system.",
    "Skills", "Programming: Python, TypeScript",
  ].join("\n");
  const imported = await json<any>(await request.post(`${api}/api/profile/imports`, { data: {
    sourceType: "file", documentType: "cv", title: "Shared source CV", fileName: "shared-source.txt",
    mimeType: "text/plain", dataBase64: Buffer.from(sourceText).toString("base64"),
  } }));
  await json(await request.post(`${api}/api/profile/imports/commit`, { data: {
    documentId: imported.document.id,
    sourceDocumentId: imported.sourceDocumentId,
    profilePatch: imported.profilePatch,
    sections: imported.sections,
  } }));
  return job.id;
}

test("invited collaborators share edits and CV comments while uninvited users are denied", async ({ browser, page, request }) => {
  const jobId = await seedSharedStudio(request);
  await page.goto("/");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByLabel("Email").fill("editor@example.com");
  await page.getByRole("button", { name: "Create private link" }).click();
  const inviteUrl = await page.getByLabel("Private invitation link").inputValue();

  const editorContext = await browser.newContext({
    baseURL: web,
    extraHTTPHeaders: { authorization: "Bearer editor" },
    viewport: { width: 1280, height: 900 },
  });
  const editor = await editorContext.newPage();
  const editorInvite = inviteUrl.replace("/#invite=", "/?__e2eUser=editor#invite=");
  await editor.goto(editorInvite);
  await expect(editor.getByRole("button", { name: new RegExp(`Open Shared Markets Analyst at Collaboration Capital`) })).toBeVisible();
  const editorDraftId = crypto.randomUUID();
  const editorDraft = await editorContext.request.put(`${api}/api/capture-drafts/${editorDraftId}`, { data: {
    sourceType: "pasted_text", value: "Editor-owned unsent capture",
  } });
  expect(editorDraft.ok(), await editorDraft.text()).toBeTruthy();
  const editorDraftRevision = (await editorDraft.json() as { revision: number }).revision;
  const editorDiscard = await editorContext.request.delete(`${api}/api/capture-drafts/${editorDraftId}?expectedRevision=${editorDraftRevision}`);
  expect(editorDiscard.ok(), await editorDiscard.text()).toBeTruthy();
  await editor.getByRole("button", { name: new RegExp(`Open Shared Markets Analyst at Collaboration Capital`) }).click();
  await editor.getByRole("button", { name: "Edit details" }).click();
  await editor.getByLabel("Personal notes").fill("Dad reviewed this role with Zain.");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor.getByRole("button", { name: "Edit details" })).toBeVisible();
  await editor.getByRole("button", { name: "Edit details" }).click();
  await expect(editor.getByLabel("Personal notes")).toHaveValue("Dad reviewed this role with Zain.");

  await editor.goto(`/career-studio/jobs/${jobId}/cv?__e2eUser=editor`);
  await expect(editor.getByLabel("Comment on this CV")).toBeVisible();
  await editor.getByLabel("Comment on this CV").fill("Tighten the opening and keep the markets evidence.");
  await editor.getByRole("button", { name: "Send comment" }).click();
  await expect(editor.getByText("Tighten the opening and keep the markets evidence.")).toBeVisible();

  await page.goto(`/career-studio/jobs/${jobId}/cv?__e2eUser=owner`);
  await expect(page.getByText("Tighten the opening and keep the markets evidence.")).toBeVisible({ timeout: 8_000 });

  await page.goto("/?__e2eUser=owner");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page.getByLabel("Email").fill("viewer@example.com");
  await page.getByLabel("Invitation access").selectOption("viewer");
  await page.getByRole("button", { name: "Create private link" }).click();
  const viewerInviteUrl = await page.getByLabel("Private invitation link").inputValue();
  await page.getByRole("button", { name: "Close sharing" }).click();

  const viewerContext = await browser.newContext({
    baseURL: web,
    extraHTTPHeaders: { authorization: "Bearer viewer" },
    viewport: { width: 1280, height: 900 },
  });
  const viewer = await viewerContext.newPage();
  await viewer.goto(viewerInviteUrl.replace("/#invite=", "/?__e2eUser=viewer#invite="));
  await expect(viewer.getByText(/View-only workspace/)).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Add opportunity" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Capture inbox" })).toHaveCount(0);
  await viewer.getByRole("button", { name: new RegExp(`Open Shared Markets Analyst at Collaboration Capital`) }).click();
  await expect(viewer.getByRole("button", { name: "Edit details" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Start application" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Research salary" })).toHaveCount(0);
  await viewer.goto(`/discover?__e2eUser=viewer`);
  await expect(viewer.getByRole("button", { name: "Check now" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Source" })).toHaveCount(0);
  await viewer.goto(`/career-studio?__e2eUser=viewer`);
  await expect(viewer.getByRole("button", { name: "Import source CV" })).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: "Add source" })).toHaveCount(0);
  await viewer.goto(`/career-studio/jobs/${jobId}/cv?__e2eUser=viewer`);
  await expect(viewer.getByText(/View only\. Ask the workspace owner/)).toBeVisible();
  await expect(viewer.getByLabel("Ask AI to propose CV changes")).not.toBeVisible();
  await expect(viewer.getByRole("button", { name: "Export PDF" })).toHaveCount(0);
  await expect(viewer.getByLabel("Comment on this CV")).toHaveCount(0);
  const deniedMutation = await viewerContext.request.post(`${api}/api/jobs`, { data: { title: "Forbidden viewer role", companyName: "No Access" } });
  expect(deniedMutation.status()).toBe(403);

  const uninvitedContext = await browser.newContext({
    baseURL: web,
    extraHTTPHeaders: { authorization: "Bearer uninvited" },
  });
  const uninvited = await uninvitedContext.newPage();
  await uninvited.goto("/?__e2eUser=uninvited");
  await expect(uninvited.getByRole("heading", { name: "Invitation required" })).toBeVisible();
  await expect(uninvited.getByText("does not have access")).toBeVisible();

  await uninvitedContext.close();
  await viewerContext.close();
  await editorContext.close();
});
