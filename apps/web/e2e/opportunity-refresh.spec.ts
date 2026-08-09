import { expect, test } from "@playwright/test";

test("hosted background refresh keeps the opportunity table stable", async ({ page, request }) => {
  const created = await request.post("http://127.0.0.1:4310/api/jobs", { data: {
    title: "Stable Refresh Analyst",
    companyName: "Refresh Capital",
    location: "London",
    sector: "Financial services",
  } });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto("/");
  const row = page.getByRole("button", { name: /Open Stable Refresh Analyst at Refresh Capital/ });
  await expect(row).toBeVisible();

  let releaseRefresh!: () => void;
  let markIntercepted!: () => void;
  const intercepted = new Promise<void>((resolve) => { markIntercepted = resolve; });
  const release = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  await page.route("**/api/jobs?**", async (route) => {
    markIntercepted();
    await release;
    await route.continue();
  });

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await intercepted;

  await expect(row).toBeVisible();
  await expect(page.getByText("Loading your pipeline...")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/opportunities");

  releaseRefresh();
  await expect(row).toBeVisible();
});
