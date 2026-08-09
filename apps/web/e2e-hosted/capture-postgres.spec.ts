import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const api = "http://127.0.0.1:4410";
const harness = "http://127.0.0.1:4429";
const authorization = { authorization: "Bearer owner" };

type QueueItem = {
  id: string;
  sourceUrl: string;
  state: "Queued" | "Extracting" | "Needs Review" | "Duplicate" | "Blocked" | "Failed" | "Saved";
  attemptCount: number;
  draft: { title: string; companyName: string } | null;
  enrichment: { mode: string; evidenceCount: number } | null;
};

async function queue(request: APIRequestContext) {
  const response = await request.get(`${api}/api/capture-queue?limit=100`, { headers: authorization });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<{ items: QueueItem[]; summary: { total: number; active: number; counts: Record<string, number> } }>;
}

async function waitForSettled(request: APIRequestContext, minimum: number) {
  const deadline = Date.now() + 90_000;
  let latest = await queue(request);
  while (Date.now() < deadline) {
    if (latest.summary.total >= minimum && latest.summary.active === 0) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await queue(request);
  }
  const active = latest.items.filter((item) => ["Queued", "Extracting"].includes(item.state));
  throw new Error(`Capture queue did not settle: ${JSON.stringify({ summary: latest.summary, active })}`);
}

async function addTextCapture(page: Page, text: string) {
  const composer = page.locator(".capture-composer textarea");
  await composer.fill(text);
  await composer.press("Meta+Enter");
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
}

test("hosted PostgreSQL capture queue remains usable, reviewable, durable, and conflict-safe", async ({ page, request }) => {
  await page.goto("/capture?__e2eUser=owner");
  await expect(page.getByRole("heading", { name: "Keep pasting. CareerOS will catch up." })).toBeVisible();

  await addTextCapture(page, [
    "Hosted Quant Analyst 0",
    "Company: Harness Capital 0",
    "Location: London",
    "Role summary: Analyse electronic markets and build reliable trading tools.",
    "Requirements: Python, probability, communication, and careful risk judgement.",
  ].join("\n"));

  await page.getByRole("tab", { name: "Public links" }).click();
  const blockedUrl = "http://127.0.0.1:9/private-job";
  const failedUrl = "https://career-os-hosted-e2e.invalid/job-that-does-not-resolve";
  await addTextCapture(page, [
    blockedUrl,
    failedUrl,
    ...Array.from({ length: 17 }, (_, index) => `https://cancel-${index}.career-os-hosted-e2e.invalid/job`),
  ].join("\n"));
  const composer = page.locator(".capture-composer textarea");
  await expect(composer).toBeEditable();
  await composer.fill("Composer remains usable while the hosted queue processes.");
  await expect(composer).toHaveValue("Composer remains usable while the hosted queue processes.");
  await composer.fill("");

  await page.getByRole("tab", { name: "LinkedIn text" }).click();
  await addTextCapture(page, [
    "Hosted Quant Analyst 1",
    "Company: Harness Capital 1",
    "Location: London",
    "Requirements: Python, probability, communication, and markets.",
  ].join("\n"));

  await expect.poll(async () => (await queue(request)).summary.total, { timeout: 15_000 }).toBe(21);
  const firstWave = await queue(request);
  for (const item of firstWave.items.filter((candidate) => candidate.sourceUrl.startsWith("https://cancel-"))) {
    await request.post(`${api}/api/capture-queue/${item.id}/cancel`, { headers: authorization });
  }

  const extraValid = await request.post(`${api}/api/capture-queue`, { headers: authorization, data: { items: [2].map((index) => ({
    sourceType: "pasted_text",
    text: `Hosted Quant Analyst ${index}\nCompany: Harness Capital ${index}\nLocation: London\nRequirements: Python, probability, and markets.`,
  })) } });
  expect(extraValid.status()).toBe(202);

  let current = await waitForSettled(request, 22);
  expect(current.summary.counts["Needs Review"]).toBe(3);
  expect(current.summary.counts.Blocked).toBeGreaterThanOrEqual(1);
  expect(current.summary.counts.Failed).toBeGreaterThanOrEqual(1);

  const reviewable = current.items.filter((item) => item.state === "Needs Review");
  expect(reviewable).toHaveLength(3);
  for (const item of reviewable) {
    expect(item.enrichment?.mode).toBe("deterministic");
    expect(item.enrichment?.evidenceCount).toBeGreaterThan(0);
  }

  const evidenceRow = page.locator(".capture-queue-row").filter({ hasText: "Hosted Quant Analyst 0" });
  await evidenceRow.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("heading", { name: "Review opportunity" })).toBeVisible();
  await page.getByText("Field evidence", { exact: true }).click();
  await expect(page.locator(".evidence-list")).toContainText("deterministic");
  await expect(page.locator(".evidence-list")).toContainText(/% confidence/);
  await page.getByRole("button", { name: "Close capture panel" }).click();

  const blocked = current.items.find((item) => item.state === "Blocked")!;
  const failed = current.items.find((item) => item.state === "Failed" && item.sourceUrl === failedUrl)!;
  expect(blocked).toBeTruthy();
  expect(failed).toBeTruthy();
  for (const item of [blocked, failed]) {
    const row = page.locator(".capture-queue-row").filter({ hasText: item.state }).filter({ hasText: item.sourceUrl });
    await row.getByRole("button", { name: "Retry" }).click();
  }
  current = await waitForSettled(request, 22);
  expect(current.items.find((item) => item.id === blocked.id)?.attemptCount).toBeGreaterThan(blocked.attemptCount);
  expect(current.items.find((item) => item.id === failed.id)?.attemptCount).toBeGreaterThan(failed.attemptCount);

  const conflictTitle = "Hosted Quant Analyst 1";
  const seed = await request.post(`${api}/api/jobs`, {
    headers: authorization,
    data: { title: conflictTitle, companyName: "Harness Capital 1", location: "London" },
  });
  expect(seed.ok(), await seed.text()).toBeTruthy();

  await page.getByRole("button", { name: /Save 3 ready/ }).click();
  await expect(page.getByRole("heading", { name: "Review opportunity" })).toBeVisible();
  await expect(page.getByLabel("Role or internship name")).toHaveValue(conflictTitle);
  await page.getByLabel("Create another opportunity").check();
  await page.getByRole("button", { name: "Save opportunity" }).click();
  await expect(page.getByRole("heading", { name: "Review opportunity" })).toBeHidden();

  await expect.poll(async () => (await queue(request)).summary.counts["Needs Review"], { timeout: 30_000 }).toBe(2);
  await page.getByRole("button", { name: "Capture inbox" }).click();
  await expect(page.getByRole("heading", { name: "Keep pasting. CareerOS will catch up." })).toBeVisible();
  await page.getByRole("button", { name: /Save 2 ready/ }).click();
  await expect.poll(async () => (await queue(request)).summary.counts.Saved, { timeout: 30_000 }).toBe(3);

  await page.getByRole("button", { name: /^Opportunities/ }).click();
  await expect(page.getByRole("button", { name: /Open Hosted Quant Analyst 0 at Harness Capital 0/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open Hosted Quant Analyst 2 at Harness Capital 2/ })).toBeVisible();

  const jobs = await request.get(`${api}/api/jobs`, { headers: authorization });
  expect(jobs.ok(), await jobs.text()).toBeTruthy();
  const persistedJobs = (await jobs.json() as { jobs: Array<{ title: string }> }).jobs;
  expect(persistedJobs.filter((job) => job.title.startsWith("Hosted Quant Analyst"))).toHaveLength(4);

  const databaseState = await request.get(`${harness}/state`);
  expect(databaseState.ok(), await databaseState.text()).toBeTruthy();
  const stored = await databaseState.json() as { jobs: number; evidence: number; saved: number };
  expect(stored).toMatchObject({ jobs: 4, saved: 3 });
  expect(stored.evidence).toBeGreaterThanOrEqual(3);

  const capacityItems = Array.from({ length: 100 }, (_, index) => index === 99 ? {
    sourceType: "url" as const,
    url: "http://127.0.0.1:9/capacity-blocked-job",
  } : {
    sourceType: "pasted_text" as const,
    text: `Capacity Role ${index}\nCompany: Capacity Company ${index}\nLocation: London\nRequirements: Python and markets.`,
  });
  const capacity = await request.post(`${api}/api/capture-queue`, { headers: authorization, data: { items: capacityItems } });
  expect(capacity.status()).toBe(202);
  const accepted = await capacity.json() as Array<{ id: string }>;
  expect(accepted).toHaveLength(100);
  const acceptedIds = new Set(accepted.map((item) => item.id));

  const restart = await request.post(`${harness}/restart-api`);
  expect(restart.ok(), await restart.text()).toBeTruthy();
  const settledAt = Date.now();
  const afterRestart = await waitForSettled(request, 122);
  const capacityRecords = afterRestart.items.filter((item) => acceptedIds.has(item.id));
  expect(capacityRecords).toHaveLength(100);
  expect(new Set(capacityRecords.map((item) => item.id)).size).toBe(100);
  expect(capacityRecords.filter((item) => item.state === "Needs Review")).toHaveLength(99);
  expect(capacityRecords.filter((item) => item.state === "Blocked")).toHaveLength(1);
  expect(capacityRecords.every((item) => !["Queued", "Extracting"].includes(item.state))).toBe(true);

  await page.goto("/capture?__e2eUser=owner");
  await expect(page.locator(".capture-queue-row")).toHaveCount(50);
  await page.getByRole("button", { name: "Load older captures" }).click();
  await expect(page.locator(".capture-queue-row")).toHaveCount(100);
  expect(Date.now() - settledAt).toBeLessThan(15_000);
  await expect(page.getByText("Capacity Role 98", { exact: true })).toBeVisible();
  await expect(page.getByText("http://127.0.0.1:9/capacity-blocked-job", { exact: true })).toBeVisible();
  const loadedComposer = page.locator(".capture-composer textarea");
  await expect(loadedComposer).toBeEditable();
  await loadedComposer.fill("Queue remains usable with one hundred settled captures.");
  await expect(loadedComposer).toHaveValue("Queue remains usable with one hundred settled captures.");
});
