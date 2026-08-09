import { defineConfig } from "@playwright/test";

const apiPort = Number(process.env.CAREEROS_HOSTED_E2E_API_PORT ?? 4_410);
const webPort = Number(process.env.CAREEROS_HOSTED_E2E_WEB_PORT ?? 5_273);

export default defineConfig({
  testDir: "./apps/web/e2e-hosted",
  timeout: 150_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    actionTimeout: 20_000,
    browserName: "chromium",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: { authorization: "Bearer owner" },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "corepack pnpm --filter @careeros/api exec tsx ../../scripts/hosted-e2e-stack.ts",
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 150_000,
    },
    {
      command: `VITE_API_URL=http://127.0.0.1:${apiPort} corepack pnpm --filter @careeros/web exec vite --host 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 90_000,
    },
  ],
});
