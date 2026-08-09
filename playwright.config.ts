import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: { authorization: "Bearer owner" },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "corepack pnpm --filter @careeros/api exec tsx ../../scripts/e2e-api.ts",
      url: "http://127.0.0.1:4310/health",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "corepack pnpm --filter @careeros/web exec vite --host 127.0.0.1 --port 5173",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
