import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

async function main() {
  const originalParentPid = process.ppid;
  const parentWatch = setInterval(() => {
    if (process.ppid === 1 || process.ppid !== originalParentPid) process.kill(process.pid, "SIGTERM");
  }, 500);
  parentWatch.unref();
  let telegramCalls = 0;
  let aiCalls = 0;
  const telegramBodies: unknown[] = [];
  const mockProvider = createServer((request, response) => {
    if (request.url === "/jobs") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jobs: [{
        id: "mock-telegram-role", title: "MockQuant Trading Graduate", absolute_url: "https://jobs.example/mock-telegram-role?apply=1",
        location: { name: "London" }, created_at: "2026-08-09T08:00:00Z", content: "MockQuant trading role used only by the safe browser test.",
      }] }));
      return;
    }
    if (request.url === "/mock/state") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ telegramCalls, telegramBodies, aiCalls }));
      return;
    }
    if (request.url === "/mock/reset" && request.method === "POST") {
      telegramCalls = 0;
      telegramBodies.length = 0;
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.url?.endsWith("/sendMessage") && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        telegramCalls += 1;
        try { telegramBodies.push(JSON.parse(body)); } catch { telegramBodies.push(body); }
        setTimeout(() => {
          response.setHeader("content-type", "application/json");
          if (telegramCalls === 1) {
            response.statusCode = 401;
            response.end(JSON.stringify({ ok: false }));
          } else {
            response.end(JSON.stringify({ ok: true, result: { message_id: 10_000 + telegramCalls } }));
          }
        }, 250);
      });
      return;
    }
    if (request.url === "/responses" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        aiCalls += 1;
        const parsed = JSON.parse(body) as { input?: Array<{ role?: string; content?: string }>; text?: { format?: { name?: string } } };
        const payload = JSON.parse(parsed.input?.find((item) => item.role === "user")?.content ?? "{}") as {
          trustedResolvedTargets?: Array<{ key: string; label: string; targetField: string | null; targetSectionField: string | null; targetSectionId: string | null; currentContent: string; evidenceIds: string[] }>;
          protectedSectionIds?: string[];
        };
        const targets = payload.trustedResolvedTargets ?? [];
        const result = parsed.text?.format?.name === "careeros_cv_coverage_plan"
          ? { coverage: [], interpretation: "No broad planning is used by this focused fixture." }
          : {
            intent: {
              mode: "targeted", targetField: targets[0]?.targetField ?? null, targetSectionField: targets[0]?.targetSectionField ?? null,
              targetSectionIds: targets.flatMap((target) => target.targetSectionId ? [target.targetSectionId] : []), excludedSectionIds: payload.protectedSectionIds ?? [], requestedValue: null,
              interpretation: "Apply the exact resolved target supplied by CareerOS.",
            },
            changes: targets.map((target) => ({
              changeKey: `e2e-${target.key}`.slice(0, 80), operation: target.currentContent ? "rewrite" : "add", targetField: target.targetField,
              targetSectionField: target.targetSectionField, targetSectionId: target.targetSectionId, proposedPosition: null,
              proposedEvidenceType: "experience", proposedTitle: target.label,
              proposedContent: target.currentContent.includes("\n") ? target.currentContent.split("\n").reverse().join("\n") : `- ${target.currentContent}`,
              rationale: "Reorders only supplied factual evidence for the role.", evidenceIds: target.evidenceIds, confidence: 0.97,
            })),
            matches: [], gaps: [], summary: "Provider-bound proposal ready for review.",
          };
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify(result) }] }] }));
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => mockProvider.once("error", reject).listen(4329, "127.0.0.1", resolve));
  process.env.CAREEROS_DATA_DIR = join(tmpdir(), "careeros-e2e-data");
  process.env.PORT = "4310";
  process.env.NODE_ENV = "test";
  process.env.CAREEROS_E2E_AUTH = "1";
  process.env.CAREEROS_HOSTED = "1";
  process.env.CAREEROS_DATA_PROVIDER = "sqlite";
  process.env.CAREEROS_SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64");
  process.env.SUPABASE_URL = "https://careeros-e2e.invalid";
  process.env.SUPABASE_ANON_KEY = "careeros-e2e-public-anon-key";
  process.env.CAREEROS_OWNER_EMAIL = "owner@example.com";
  process.env.CAREEROS_REALTIME_ENABLED = "0";
  process.env.CAREEROS_DISABLE_DISCOVERY_SCHEDULER = "1";
  process.env.CAREEROS_RATE_LIMIT_MAX = "20000";
  process.env.TELEGRAM_BOT_TOKEN = "e2e-safe-token";
  process.env.TELEGRAM_CHAT_ID = "e2e-safe-chat";
  process.env.CAREEROS_TELEGRAM_API_BASE_URL = "http://127.0.0.1:4329";
  process.env.CAREEROS_E2E_DISCOVERY_BASE_URL = "http://127.0.0.1:4329";
  process.env.OPENAI_API_KEY = "sk-careeros-e2e-provider-key";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:4329";
  process.env.CAREEROS_AI_MODEL = "e2e-provider-model";
  rmSync(process.env.CAREEROS_DATA_DIR, { recursive: true, force: true });
  const { migrate, sqlite } = await import("../apps/api/src/db.js");
  migrate();

  const now = new Date().toISOString();
  const sourceId = "e2e-discovery-source";
  const failedSourceId = "e2e-discovery-failed-source";
  sqlite.prepare(`INSERT INTO discovery_sources
    (id,name,kind,company_name,source_url,external_key,enabled,check_interval_minutes,last_checked_at,last_successful_at,last_error,successful_inventory_count,created_at,updated_at,revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
    sourceId, "Healthy source", "greenhouse", "Example Capital", "https://boards-api.greenhouse.io/v1/boards/example/jobs?content=true", "example", 1, 180, now, now, "", 120, now, now,
  );
  sqlite.prepare(`INSERT INTO discovery_sources
    (id,name,kind,company_name,source_url,external_key,enabled,check_interval_minutes,last_checked_at,last_error,successful_inventory_count,created_at,updated_at,revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
    failedSourceId, "Broken source", "greenhouse", "Broken Capital", "https://boards-api.greenhouse.io/v1/boards/broken/jobs?content=true", "broken", 0, 180, now, "Source returned HTTP 503.", 0, now, now,
  );

  const insertPosting = sqlite.prepare(`INSERT INTO discovered_postings
    (id,source_id,external_id,canonical_url,apply_url,company_name,title,location,programme,sector,firm_type,role_family,work_mode,sponsorship,side,description,source_posted_at,deadline_at,first_seen_at,last_seen_at,last_checked_at,availability,missing_count,content_hash,saved_job_posting_id,created_at,updated_at,revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
  const insertAlias = sqlite.prepare(`INSERT INTO discovery_posting_aliases
    (source_id,external_id,discovered_posting_id,first_seen_at,last_seen_at,last_checked_at,availability,missing_count,content_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  sqlite.transaction(() => {
    for (let index = 0; index < 120; index += 1) {
      const id = `e2e-posting-${index.toString().padStart(3, "0")}`;
      const externalId = `e2e-external-${index}`;
      const detectedAt = new Date(Date.now() - index * 1_000).toISOString();
      const isNeedle = index === 115;
      const isPlacement = index === 114;
      const title = isNeedle ? "Quantitative Research Intern" : isPlacement ? "Software Engineering Industrial Placement" : `Trading Analyst ${index}`;
      const roleFamily = isNeedle ? "Quantitative research" : isPlacement ? "Engineering" : "Trading";
      const contentHash = `e2e-hash-${index}`;
      insertPosting.run(
        id, sourceId, externalId, `https://jobs.example/${index}`, `https://jobs.example/${index}?apply=1`, isNeedle ? "Needle Capital" : isPlacement ? "E2E Capital" : "Example Capital",
        title, index % 2 ? "London" : "Singapore", isNeedle ? "Internship" : isPlacement ? "Placement" : "Graduate", isPlacement ? "Technology" : "Financial services", "Hedge fund", roleFamily,
        "Hybrid", isNeedle ? "Yes" : "Not stated", "buy_side", isPlacement ? "Deterministic full-stack technology placement fixture." : "Public finance role.", now, null, detectedAt, now, now, "Open", 0, contentHash, null, detectedAt, now,
      );
      insertAlias.run(sourceId, externalId, id, detectedAt, now, now, "Open", 0, contentHash, detectedAt);
    }
  })();
  sqlite.prepare("INSERT INTO discovery_runs (id,source_id,state,started_at,completed_at,duration_ms,found_count,new_count,changed_count,missing_count,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("e2e-run-good", sourceId, "Completed", now, now, 120, 120, 0, 0, 0, "");
  sqlite.prepare("INSERT INTO discovery_runs (id,source_id,state,started_at,completed_at,duration_ms,found_count,new_count,changed_count,missing_count,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("e2e-run-failed", failedSourceId, "Failed", now, now, 90, 0, 0, 0, 0, "Source returned HTTP 503.");
  sqlite.prepare(`INSERT INTO discovery_sources
    (id,name,kind,company_name,source_url,external_key,enabled,check_interval_minutes,last_error,successful_inventory_count,created_at,updated_at,revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
    "e2e-telegram-source", "MockQuant alerts", "greenhouse", "MockQuant", "http://127.0.0.1:4329/jobs", "mockquant", 1, 180, "", 0, now, now,
  );

  const insertAlert = sqlite.prepare(`INSERT INTO alert_events
    (id,rule_id,discovered_posting_id,event_type,title,body,direct_url,deduplication_key,read_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insertDelivery = sqlite.prepare(`INSERT INTO notification_deliveries
    (id,alert_event_id,provider,state,attempt_count,last_error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  sqlite.transaction(() => {
    for (let index = 0; index < 30; index += 1) {
      const createdAt = new Date(Date.now() - (index + 1) * 60_000).toISOString();
      const alertId = `e2e-history-alert-${index}`;
      const deliveryId = `e2e-history-delivery-${index}`;
      const ambiguous = index === 0;
      insertAlert.run(alertId, null, null, "test", ambiguous ? "Possibly delivered alert" : `Delivery history ${index + 1}`, "Browser history fixture", "https://jobs.example/history", `e2e-history-${index}`, null, createdAt);
      insertDelivery.run(deliveryId, alertId, "telegram", ambiguous ? "Ambiguous" : "Delivered", 1, ambiguous ? "Telegram may already have accepted this message." : "", createdAt, createdAt);
    }
  })();

  await import("../apps/api/src/server.js");
}

void main();
