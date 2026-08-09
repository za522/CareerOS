import { expect, test, type APIRequestContext } from "@playwright/test";

const api = "http://127.0.0.1:4310";
const mock = "http://127.0.0.1:4329";

async function telegramCalls(request: APIRequestContext) {
  const response = await request.get(`${mock}/mock/state`);
  expect(response.ok()).toBeTruthy();
  return (await response.json() as { telegramCalls: number }).telegramCalls;
}

test("Telegram test, retry, direct link, prompt delivery, and dedup are visible end to end", async ({ page, request }) => {
  await request.post(`${mock}/mock/reset`);
  const rule = await request.post(`${api}/api/alerts/rules`, { data: {
    name: "MockQuant browser alert", enabled: true, telegramEnabled: true,
    companies: [], side: "either", roleFamilies: [], programmes: [], locations: [], keywords: ["mockquant"], newWithinHours: 720,
  } });
  expect(rule.ok(), await rule.text()).toBeTruthy();

  await page.goto("/");
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("button", { name: "Alerts", exact: true }).click();
  const testButton = page.getByRole("button", { name: "Test Telegram", exact: true });
  await testButton.click();
  await expect(page.getByRole("button", { name: "Testing...", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("HTTP 401");

  const testDelivery = page.locator(".delivery-monitor-row").filter({ hasText: "CareerOS test alert" });
  await expect(testDelivery.locator(".delivery-state")).toHaveText("Failed");
  await expect(testDelivery.getByRole("link", { name: "Open link for CareerOS test alert" })).toHaveAttribute("href", "https://optiver.com/join-us/jobs/");
  await testDelivery.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(testDelivery.locator(".delivery-state")).toHaveText("Delivered");
  await expect.poll(() => telegramCalls(request)).toBe(2);

  const source = page.locator(".source-monitor-row").filter({ hasText: "MockQuant alerts" });
  await source.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.locator(".alert-inbox").getByText("MockQuant: MockQuant Trading Graduate", { exact: true })).toBeVisible();
  await expect.poll(() => telegramCalls(request)).toBe(3);
  const jobDelivery = page.locator(".delivery-monitor-row").filter({ hasText: "MockQuant: MockQuant Trading Graduate" });
  await expect(jobDelivery.locator(".delivery-state")).toHaveText("Delivered");
  await expect(jobDelivery.getByRole("link", { name: "Open link for MockQuant: MockQuant Trading Graduate" })).toHaveAttribute("href", /mock-telegram-role/);

  await source.getByRole("button", { name: "Check", exact: true }).click();
  await expect.poll(() => telegramCalls(request), { timeout: 3_000 }).toBe(3);
  await expect(page.locator(".delivery-monitor-row").filter({ hasText: "MockQuant: MockQuant Trading Graduate" })).toHaveCount(1);

  const ambiguous = page.locator(".delivery-monitor-row").filter({ hasText: "Possibly delivered alert" });
  await expect(ambiguous.locator(".delivery-state")).toHaveText("Ambiguous");
  page.once("dialog", (dialog) => dialog.dismiss());
  await ambiguous.getByRole("button", { name: "Send again", exact: true }).click();
  await expect.poll(() => telegramCalls(request), { timeout: 3_000 }).toBe(3);
  page.once("dialog", (dialog) => dialog.accept());
  await ambiguous.getByRole("button", { name: "Send again", exact: true }).click();
  await expect(ambiguous.locator(".delivery-state")).toHaveText("Delivered");
  await expect.poll(() => telegramCalls(request)).toBe(4);

  const initialHistoryCount = await page.locator(".delivery-monitor-row").count();
  expect(initialHistoryCount).toBe(25);
  await page.getByRole("button", { name: "Load older deliveries", exact: true }).click();
  const expandedHistoryCount = await page.locator(".delivery-monitor-row").count();
  expect(expandedHistoryCount).toBeGreaterThan(25);
  await source.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.locator(".delivery-monitor-row")).toHaveCount(expandedHistoryCount);

  const discovered = await (await request.get(`${api}/api/discovery?q=MockQuant%20Trading%20Graduate`)).json() as {
    postings: Array<{ id: string; title: string }>;
  };
  const mockPosting = discovered.postings.find((posting) => posting.title === "MockQuant Trading Graduate");
  expect(mockPosting).toBeTruthy();
  const hidden = await request.patch(`${api}/api/discovery/postings/${mockPosting!.id}/hidden`, { data: { hidden: true } });
  expect(hidden.ok(), await hidden.text()).toBeTruthy();
});

test("Telegram setup distinguishes failed attempts from successful verification and surfaces invalid app URL failures", async ({ page }) => {
  const attemptedAt = "2026-08-09T10:00:00.000Z";
  const successfulAt = "2026-08-08T10:00:00.000Z";
  await page.route("**/api/settings/telegram", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ hosted: true, configured: true, chatIdHint: "••••1234", lastTestedAt: attemptedAt, lastSuccessfulTestAt: successfulAt, lastError: "CAREEROS_APP_URL is invalid.", updatedAt: attemptedAt }),
  }));
  await page.route("**/api/alerts/test", async (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Set a public CAREEROS_APP_URL before testing Telegram links." }),
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("button", { name: "Telegram", exact: true }).click();
  await expect(page.locator(".telegram-setup footer small")).toContainText("Last attempted");
  await expect(page.locator(".telegram-setup footer small")).toContainText("Last successful");
  await expect(page.locator(".telegram-setup footer small")).not.toContainText("Last verified");
  await page.getByRole("button", { name: "Test delivery", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("public CAREEROS_APP_URL");
});

test("Telegram success copy states that the direct link was reachable when tested", async ({ page }) => {
  await page.route("**/api/alerts/test", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "test-alert", title: "CareerOS test alert", deliveries: [] }),
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  await page.getByRole("button", { name: "Alerts", exact: true }).click();
  await page.getByRole("button", { name: "Test Telegram", exact: true }).click();
  const telegramStatus = page.getByText("The direct CareerOS link was reachable when tested.", { exact: false });
  await expect(telegramStatus).toBeVisible();
  await expect(telegramStatus).not.toContainText("verified direct link");
});
