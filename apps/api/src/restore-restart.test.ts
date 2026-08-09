import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const apiDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];
const children = new Set<ChildProcess>();

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startApi(dataDirectory: string, port: number, extraEnvironment: NodeJS.ProcessEnv = {}) {
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: apiDirectory,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      CAREEROS_DATA_DIR: dataDirectory,
      CAREEROS_BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
      CAREEROS_DISABLE_DISCOVERY_SCHEDULER: "1",
      CAREEROS_DISABLE_KEYCHAIN: "1",
      OPENAI_API_KEY: "",
      NODE_ENV: "test",
      ...extraEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`CareerOS exited during restart test.\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return { child, output: () => output };
    } catch { /* Startup is still in progress. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  throw new Error(`CareerOS did not become healthy during restart test.\n${output}`);
}

async function stopApi(child: ChildProcess) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5_000)),
  ]);
  children.delete(child);
}

async function json(port: number, path: string, init: RequestInit = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: init.body ? { "content-type": "application/json", ...init.headers } : init.headers,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`);
  return body;
}

afterAll(async () => {
  await Promise.all([...children].map(stopApi));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("encrypted restore across a genuine API restart", () => {
  it("retains backup objects and history outside the swapped data directory and ignores unrelated corrupt history", async () => {
    const root = mkdtempSync(join(tmpdir(), "careeros-real-restart-"));
    roots.push(root);
    const dataDirectory = join(root, "data");
    const objectDirectory = join(root, "data-object-storage");
    const markerPath = join(root, ".data-restore-pending.json");
    const port = await availablePort();

    let running = await startApi(dataDirectory, port);
    const first = await json(port, "/api/backups/run", { method: "POST" });
    const created = await json(port, "/api/jobs", { method: "POST", body: JSON.stringify({ title: "Restored Quant Role", companyName: "Durable Capital" }) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await json(port, "/api/backups/run", { method: "POST" });
    const history = await json(port, "/api/backups");
    const firstRecord = history.backups.find((entry: { path: string }) => entry.path === first.path);
    const secondRecord = history.backups.find((entry: { path: string }) => entry.path === second.path);
    expect(firstRecord).toBeTruthy();
    expect(secondRecord).toBeTruthy();

    await json(port, `/api/backups/${firstRecord.id}/restore`, { method: "POST" });
    const markerText = readFileSync(markerPath, "utf8");
    expect(markerText).not.toContain("databaseBase64");
    expect(markerText).not.toContain("structuredData");
    expect(JSON.parse(markerText)).toMatchObject({ version: 1, stagingDirectoryName: expect.stringContaining(".restore-") });
    await stopApi(running.child);

    running = await startApi(dataDirectory, port);
    expect((await json(port, "/api/jobs")).jobs.some((job: { id: string }) => job.id === created.id)).toBe(false);
    const restoredHistory = await json(port, "/api/backups");
    expect(restoredHistory.backups.map((entry: { path: string }) => entry.path)).toEqual(expect.arrayContaining([first.path, second.path]));
    const firstObject = join(objectDirectory, "workspaces", "00000000-0000-4000-8000-000000000001", first.path);
    const secondObject = join(objectDirectory, "workspaces", "00000000-0000-4000-8000-000000000001", second.path);
    expect(readFileSync(firstObject).byteLength).toBeGreaterThan(0);
    expect(readFileSync(secondObject).byteLength).toBeGreaterThan(0);

    writeFileSync(firstObject, "deliberately corrupt historical backup");
    await json(port, `/api/backups/${secondRecord.id}/restore`, { method: "POST" });
    await stopApi(running.child);

    running = await startApi(dataDirectory, port);
    expect((await json(port, "/api/jobs")).jobs.some((job: { id: string }) => job.id === created.id)).toBe(true);
    expect((await json(port, "/api/backups")).backups.map((entry: { path: string }) => entry.path)).toEqual(expect.arrayContaining([first.path, second.path]));
    await stopApi(running.child);
  }, 150_000);

  it("blocks hosted authenticated GET-side writes after a restore seals the process", async () => {
    const root = mkdtempSync(join(tmpdir(), "careeros-hosted-gate-"));
    roots.push(root);
    const dataDirectory = join(root, "data");
    const port = await availablePort();
    const running = await startApi(dataDirectory, port, {
      CAREEROS_E2E_AUTH: "1",
      CAREEROS_OWNER_EMAIL: "owner@example.com",
      SUPABASE_URL: "https://careeros-test.supabase.co",
      SUPABASE_ANON_KEY: "test-anon-key",
    });
    const authorization = { authorization: "Bearer owner" };
    try {
      expect(await json(port, "/api/auth/session", { headers: authorization })).toMatchObject({ workspace: { role: "owner" } });
      const backup = await json(port, "/api/backups/run", { method: "POST", headers: authorization });
      const history = await json(port, "/api/backups", { headers: authorization });
      const record = history.backups.find((entry: { path: string }) => entry.path === backup.path);
      await json(port, `/api/backups/${record.id}/restore`, { method: "POST", headers: authorization });

      const blocked = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers: authorization });
      expect(blocked.status).toBe(503);
      await expect(blocked.json()).resolves.toMatchObject({ error: expect.stringContaining("read-only") });
      expect((await fetch(`http://127.0.0.1:${port}/api/auth/config`)).status).toBe(200);
    } finally {
      await stopApi(running.child);
    }
  }, 60_000);
});
