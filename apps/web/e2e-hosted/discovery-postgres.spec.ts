import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const api = `http://127.0.0.1:${process.env.CAREEROS_HOSTED_E2E_API_PORT ?? "4410"}`;
const harness = `http://127.0.0.1:${process.env.CAREEROS_HOSTED_E2E_CONTROL_PORT ?? "4429"}`;
const authorization = { authorization: "Bearer owner" };

async function setMode(request: APIRequestContext, mode: "full" | "updated" | "partial" | "failed") {
  const response = await request.post(`${harness}/discovery-mode`, { data: { mode } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function workspace(request: APIRequestContext) {
  const response = await request.get(`${api}/api/discovery?limit=100`, { headers: authorization });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json() as Promise<{
    sources: Array<{ id: string; name: string; lastCheckedAt: string | null }>;
    postings: Array<{ id: string; sourceId: string; companyName: string; title: string; sourcePostedAt: string | null; sourceUpdatedAt: string | null; lastCheckedAt: string; availability: string; applyUrl: string }>;
    latestRuns: Array<{ sourceId: string; state: string; changedCount: number }>;
  }>;
}

async function checkSource(page: Page, sourceName: string) {
  const row = page.locator(".source-monitor-row").filter({ hasText: sourceName });
  await row.getByRole("button", { name: "Check" }).click();
  await expect(row.getByRole("button", { name: "Check" })).toBeEnabled({ timeout: 30_000 });
}

async function telegramCalls(request: APIRequestContext) {
  const response = await request.get(`${harness}/state`);
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json() as { telegramCalls: number }).telegramCalls;
}

test("hosted PostgreSQL Discover preserves dates, deduplicates, and survives partial and failed checks", async ({ page, request }, testInfo) => {
  const fixtureKey = `careeros-e2e-${testInfo.repeatEachIndex}-${testInfo.retry}-${Date.now()}`;
  const companyName = `CareerOS E2E Capital ${fixtureKey}`;
  const expectedApplyUrl = `https://job-boards.greenhouse.io/careeros-e2e-${fixtureKey}/jobs/1`;
  await page.route(`${api}/api/discovery/sources`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...body, externalKey: fixtureKey }) });
  });
  await page.context().route(expectedApplyUrl, async (route) => {
    const fixture = await request.get(`${harness}/job-application/1`);
    await route.fulfill({
      status: fixture.status(),
      contentType: fixture.headers()["content-type"],
      body: await fixture.body(),
    });
  });
  await page.goto("/discover?__e2eUser=owner");
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();

  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.getByLabel("Company").fill(companyName);
  await page.getByLabel("Public API URL").fill(`https://boards-api.greenhouse.io/v1/boards/careeros-e2e/jobs?content=true&e2e=${fixtureKey}`);
  await page.getByRole("button", { name: "Save source" }).click();
  await expect(page.locator(".source-monitor-row").filter({ hasText: companyName })).toBeVisible();

  await setMode(request, "full");
  await checkSource(page, companyName);
  const postingRow = page.getByRole("row").filter({ hasText: companyName }).filter({ hasText: "Graduate Quant Trader" });
  await expect(postingRow).toBeVisible();
  const directLink = postingRow.getByRole("link", { name: `Open Graduate Quant Trader at ${companyName}` });
  await expect(directLink).toHaveAttribute("href", expectedApplyUrl);
  const destinationPromise = page.waitForEvent("popup");
  await directLink.click();
  const destination = await destinationPromise;
  await expect(destination).toHaveURL(expectedApplyUrl);
  await expect(destination.getByRole("heading", { name: "Graduate Quant Trader application" })).toBeVisible();
  await expect(destination.getByTestId("application-fixture")).toHaveText("Deterministic hosted discovery destination");
  await destination.close();

  const first = await workspace(request);
  const source = first.sources.find((item) => item.name.includes(companyName))!;
  expect(source).toBeTruthy();
  const trader = first.postings.find((item) => item.sourceId === source.id && item.title === "Graduate Quant Trader")!;
  expect(trader).toMatchObject({
    sourcePostedAt: "2026-05-21T09:00:00.000Z",
    sourceUpdatedAt: "2026-07-28T14:30:00.000Z",
    availability: "Open",
  });
  expect(first.postings.filter((item) => item.sourceId === source.id && item.title === "Graduate Quant Trader")).toHaveLength(1);
  const firstCheckedAt = trader.lastCheckedAt;

  await setMode(request, "updated");
  await checkSource(page, companyName);
  const second = await workspace(request);
  const repeated = second.postings.find((item) => item.sourceId === source.id && item.title === "Graduate Quant Trader")!;
  expect(second.postings.filter((item) => item.sourceId === source.id && item.title === "Graduate Quant Trader")).toHaveLength(1);
  expect(repeated.sourcePostedAt).toBe("2026-05-21T09:00:00.000Z");
  expect(repeated.sourceUpdatedAt).toBe("2026-08-09T12:00:00.000Z");
  expect(repeated.lastCheckedAt >= firstCheckedAt).toBe(true);
  expect(second.latestRuns.find((run) => run.sourceId === source.id)).toMatchObject({ state: "Completed", changedCount: 0 });

  await setMode(request, "partial");
  await checkSource(page, companyName);
  await expect(page.getByRole("alert")).toContainText(/incomplete inventory/i);
  let afterUnsafeCheck = await workspace(request);
  expect(afterUnsafeCheck.latestRuns.find((run) => run.sourceId === source.id)?.state).toBe("Partial");
  expect(afterUnsafeCheck.postings.find((item) => item.sourceId === source.id && item.title === "Quant Engineering Intern")?.availability).toBe("Open");

  await setMode(request, "failed");
  await checkSource(page, companyName);
  await expect(page.getByRole("alert")).toContainText("HTTP 503");
  afterUnsafeCheck = await workspace(request);
  expect(afterUnsafeCheck.latestRuns.find((run) => run.sourceId === source.id)?.state).toBe("Failed");
  expect(afterUnsafeCheck.postings.filter((item) => item.sourceId === source.id).every((item) => item.availability === "Open")).toBe(true);
});

test("hosted alerts create one in-app event and one Telegram delivery with durable history", async ({ page, request }, testInfo) => {
  const fixtureKey = `careeros-alerts-${testInfo.repeatEachIndex}-${testInfo.retry}-${Date.now()}`;
  const companyName = `CareerOS Alert Capital ${fixtureKey}`;
  await request.post(`${harness}/telegram/reset`);

  const telegram = await request.put(`${api}/api/settings/telegram`, {
    headers: authorization,
    data: { botToken: "123456789:hosted-browser-test-token", chatId: "hosted-browser-chat" },
  });
  expect(telegram.ok(), await telegram.text()).toBeTruthy();
  const rule = await request.post(`${api}/api/alerts/rules`, {
    headers: authorization,
    data: {
      name: `Hosted quant ${fixtureKey}`, enabled: true, telegramEnabled: true,
      companies: [companyName], side: "either", roleFamilies: [], programmes: [], locations: [],
      keywords: ["probability"], newWithinHours: 24,
    },
  });
  expect(rule.ok(), await rule.text()).toBeTruthy();

  await page.route(`${api}/api/discovery/sources`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...body, externalKey: fixtureKey }) });
  });
  await page.goto("/discover?__e2eUser=owner");
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.getByLabel("Company").fill(companyName);
  await page.getByLabel("Public API URL").fill(`https://boards-api.greenhouse.io/v1/boards/careeros-e2e/jobs?content=true&e2e=${fixtureKey}`);
  await page.getByRole("button", { name: "Save source" }).click();
  await setMode(request, "full");
  await checkSource(page, companyName);

  const discoveredResponse = await request.get(`${api}/api/discovery?limit=100`, { headers: authorization });
  const discoveredBody = await discoveredResponse.json() as {
    postings: Array<{ companyName: string; title: string; description: string }>;
    alertRules: Array<{ name: string; companies: string[]; keywords: string[] }>;
    alerts: Array<{ title: string }>;
  };
  expect(discoveredBody.postings.find((item) => item.title === "Graduate Quant Trader")).toMatchObject({ companyName, description: expect.stringContaining("probability") });
  expect(discoveredBody.alertRules.find((item) => item.name === `Hosted quant ${fixtureKey}`)).toMatchObject({ companies: [companyName], keywords: ["probability"] });
  await expect.poll(async () => {
    const response = await request.get(`${api}/api/discovery?limit=100`, { headers: authorization });
    const body = await response.json() as { alerts: Array<{ title: string }> };
    return body.alerts.map((item) => item.title);
  }).toContain(`${companyName}: Graduate Quant Trader`);

  await page.getByRole("button", { name: "Alerts", exact: true }).click();
  const alert = page.locator(".alert-inbox").getByText(`${companyName}: Graduate Quant Trader`, { exact: true });
  await expect(alert).toBeVisible();
  const delivery = page.locator(".delivery-monitor-row").filter({ hasText: `${companyName}: Graduate Quant Trader` });
  await expect(delivery.locator(".delivery-state")).toHaveText("Delivered");
  await expect(delivery.getByRole("link", { name: `Open link for ${companyName}: Graduate Quant Trader` }))
    .toHaveAttribute("href", new RegExp(`${fixtureKey}/jobs/1$`));
  await expect.poll(() => telegramCalls(request)).toBe(1);

  await checkSource(page, companyName);
  await expect.poll(() => telegramCalls(request), { timeout: 3_000 }).toBe(1);
  await expect(page.locator(".delivery-monitor-row").filter({ hasText: `${companyName}: Graduate Quant Trader` })).toHaveCount(1);
});
