import { parseGreenhouseResponse, parseLeverResponse, type SourceRole } from "./discovery.js";
import { assertSafeDirectUrl, type HostedRoleObservation } from "./postgres-discovery-repository.js";
import type { HostedSourceFetcher } from "./postgres-discovery-service.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const approvedHosts = {
  greenhouse: "boards-api.greenhouse.io",
  lever: "api.lever.co",
} as const;

function approvedSourceUrl(value: string, kind: string) {
  const url = assertSafeDirectUrl(value);
  if (url.protocol !== "https:") throw new Error("Discovery providers must use HTTPS.");
  if (kind !== "greenhouse" && kind !== "lever") throw new Error(`The hosted ${kind} discovery adapter is not available.`);
  if (url.hostname.toLowerCase() !== approvedHosts[kind]) throw new Error(`${kind} discovery must use its approved public API host.`);
  if (kind === "greenhouse" && !/^\/v1\/boards\/[^/]+\/jobs\/?$/.test(url.pathname)) throw new Error("Greenhouse discovery must use a public board jobs endpoint.");
  if (kind === "lever" && !/^\/v0\/postings\/[^/]+\/?$/.test(url.pathname)) throw new Error("Lever discovery must use a public postings endpoint.");
  return url;
}

async function readJson(response: Response, maximumBytes: number) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("+json")) throw new Error("Discovery source returned unsupported non-JSON content.");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("Discovery source response exceeded the size limit.");
  if (!response.body) return response.json();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new Error("Discovery source response exceeded the size limit.");
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new Error("Discovery source returned malformed JSON.");
  }
}

function classifications(company: string, role: SourceRole) {
  const value = `${company} ${role.title} ${role.team ?? ""} ${role.description ?? ""}`.toLowerCase();
  const roleFamily = /quant|research scientist|researcher/.test(value) ? "Quantitative research"
    : /trader|trading|market maker/.test(value) ? "Trading"
      : /software|engineer|developer|technology|platform|data/.test(value) ? "Engineering"
        : /risk/.test(value) ? "Risk" : /finance|account|treasury/.test(value) ? "Finance" : "Business";
  const firmType = /market mak|proprietary trad/.test(value) ? "Market maker / proprietary trading"
    : /hedge fund/.test(value) ? "Hedge fund" : /asset management|investment management/.test(value) ? "Asset manager"
      : /investment bank|capital markets|sales and trading/.test(value) ? "Investment bank" : "Financial services";
  const side = /hedge fund|asset management|investment management|private equity|venture capital/.test(value) ? "buy_side" as const
    : /market mak|proprietary trad|investment bank|capital markets|sales and trading/.test(value) ? "sell_side" as const : "unknown" as const;
  const programme = /spring week|insight week/.test(value) ? "Spring week" : /off[- ]?cycle/.test(value) ? "Off-cycle"
    : /placement|year in industry/.test(value) ? "Placement" : /graduate|new grad|analyst programme/.test(value) ? "Graduate"
      : /intern|summer/.test(value) ? "Internship" : /entry[- ]level|junior|early career/.test(value) ? "Entry-level" : "";
  const workMode = /\bhybrid\b/.test(value) ? "Hybrid" : /\bremote\b|work from home/.test(value) ? "Remote"
    : /\bon[- ]?site\b|in[- ]office/.test(value) ? "On-site" : "Not stated";
  const sponsorship = /(?:no|not|without)\s+(?:visa\s+)?sponsor|unable to sponsor|must (?:already )?have (?:the )?right to work/.test(value) ? "No"
    : /visa sponsorship|sponsorship (?:is )?(?:available|provided)|will sponsor/.test(value) ? "Yes" : "Not stated";
  return { roleFamily, firmType, side, programme, workMode, sponsorship };
}

function hostedRole(company: string, role: SourceRole): HostedRoleObservation {
  const inferred = classifications(company, role);
  return {
    externalId: role.externalId,
    canonicalUrl: role.sourceUrl,
    applyUrl: role.applyUrl ?? role.sourceUrl,
    companyName: company,
    title: role.title,
    location: role.location ?? "",
    programme: inferred.programme,
    sector: inferred.roleFamily === "Engineering" ? "Technology" : "Financial services",
    firmType: inferred.firmType,
    roleFamily: inferred.roleFamily,
    workMode: inferred.workMode,
    sponsorship: inferred.sponsorship,
    side: inferred.side,
    description: role.description ?? "",
    sourcePostedAt: role.postedAt ?? null,
    sourceUpdatedAt: role.updatedAt ?? null,
    deadlineAt: role.deadlineAt ?? null,
  };
}

function inventoryIsComplete(response: Response, payload: unknown, returnedCount: number) {
  const link = response.headers.get("link") ?? "";
  if (/rel\s*=\s*["']?next/i.test(link)) return false;
  if ((response.headers.get("x-next-page") ?? "").trim()) return false;
  if (/^(true|1|yes)$/i.test(response.headers.get("x-has-more") ?? "")) return false;
  const headerTotal = Number(response.headers.get("x-total-count") ?? response.headers.get("x-total") ?? NaN);
  if (Number.isFinite(headerTotal) && headerTotal > returnedCount) return false;
  const contentRange = response.headers.get("content-range")?.match(/\/(\d+)$/);
  if (contentRange && Number(contentRange[1]) > returnedCount) return false;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const meta = record.meta && typeof record.meta === "object" ? record.meta as Record<string, unknown> : {};
    const declaredTotal = Number(meta.total ?? meta.total_count ?? record.total ?? NaN);
    if (Number.isFinite(declaredTotal) && declaredTotal > returnedCount) return false;
    if (meta.has_more === true || record.has_more === true || meta.next_page || record.next_page) return false;
  }
  return true;
}

export function createHostedAtsFetcher(options: {
  fetch?: FetchLike;
  timeoutMs?: number;
  maximumBytes?: number;
  maximumRedirects?: number;
} = {}): HostedSourceFetcher {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 15_000, 60_000));
  const maximumBytes = Math.max(1_024, Math.min(options.maximumBytes ?? 5_000_000, 20_000_000));
  const maximumRedirects = Math.max(0, Math.min(options.maximumRedirects ?? 3, 5));
  return async (claim) => {
    let url = approvedSourceUrl(claim.source.sourceUrl, claim.source.kind);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response | undefined;
      for (let redirects = 0; redirects <= maximumRedirects; redirects += 1) {
        response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: "application/json" } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        if (redirects === maximumRedirects) throw new Error("Discovery source exceeded the redirect limit.");
        const location = response.headers.get("location");
        if (!location) throw new Error("Discovery source returned a redirect without a destination.");
        url = approvedSourceUrl(new URL(location, url).toString(), claim.source.kind);
      }
      if (!response?.ok) throw new Error(`Discovery source returned HTTP ${response?.status ?? 0}.`);
      const payload = await readJson(response, maximumBytes);
      const roles = claim.source.kind === "greenhouse" ? parseGreenhouseResponse(payload) : parseLeverResponse(payload);
      return {
        observations: roles.map((role) => hostedRole(claim.source.companyName, role)),
        inventoryComplete: inventoryIsComplete(response, payload, roles.length),
      };
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Discovery source timed out.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
