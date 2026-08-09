import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { JobDraft } from "@careeros/contracts";

const maxRedirects = 4;
const maxResponseBytes = 2_000_000;
const urlFetchTimeoutMs = 8_000;
const urlCaptureTimeoutMs = 12_000;
const maxDraftDescriptionChars = 20_000;

export type CapturedSource = {
  url: string | null;
  sourceType: string;
  rawText: string;
  metadata: Record<string, string>;
};

type ResolvedAddress = { address: string; family: 4 | 6 };

type CaptureResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  destroy(): void;
};

export type UrlCaptureDependencies = {
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
  request?: (url: URL, address: ResolvedAddress, signal: AbortSignal) => Promise<CaptureResponse>;
};

const defaultLookup: NonNullable<UrlCaptureDependencies["lookup"]> = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

function normaliseHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function ipv4Parts(address: string) {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isBlockedIpv4(address: string) {
  const parts = ipv4Parts(address);
  if (!parts) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function ipv6Groups(address: string) {
  if (isIP(address) !== 6 || address.includes("%")) return null;
  let value = address.toLowerCase();
  const ipv4Match = value.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Match) {
    const parts = ipv4Parts(ipv4Match[1]);
    if (!parts) return null;
    value = `${value.slice(0, -ipv4Match[1].length)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function isBlockedIpv6(address: string) {
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (groups.every((group) => group === 0) || (groups.slice(0, 7).every((group) => group === 0) && g7 === 1)) return true;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIpv4(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
  }
  return (g0 & 0xfe00) === 0xfc00
    || (g0 & 0xffc0) === 0xfe80
    || (g0 & 0xff00) === 0xff00
    || (g0 === 0x64 && g1 === 0xff9b && (g2 === 0 || g2 === 1))
    || (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0)
    || (g0 === 0x2001 && g1 === 0)
    || (g0 === 0x2001 && ((g1 & 0xfff0) === 0x10 || (g1 & 0xfff0) === 0x20))
    || (g0 === 0x2001 && g1 === 0x0db8)
    || g0 === 0x2002
    || (g0 & 0xe000) !== 0x2000;
}

function assertPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4 && !isBlockedIpv4(address)) return;
  if (family === 6 && !isBlockedIpv6(address)) return;
  throw new Error("Local, private, link-local and reserved destinations are not allowed.");
}

export function assertSafePublicUrl(input: string): URL {
  const parsed = new URL(input);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only public HTTP(S) URLs are supported.");
  if (parsed.username || parsed.password) throw new Error("URLs containing credentials are not supported.");
  const hostname = normaliseHostname(parsed.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) {
    throw new Error("Local and private destinations are not allowed.");
  }
  if (isIP(hostname)) assertPublicAddress(hostname);
  return parsed;
}

async function resolvePublicUrl(url: URL, lookup: NonNullable<UrlCaptureDependencies["lookup"]>) {
  const hostname = normaliseHostname(url.hostname);
  if (isIP(hostname)) {
    assertPublicAddress(hostname);
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }
  const addresses = await lookup(hostname);
  if (!addresses.length) throw new Error("The source hostname did not resolve to a public address.");
  for (const record of addresses) {
    if ((record.family !== 4 && record.family !== 6) || isIP(record.address) !== record.family) {
      throw new Error("The source hostname returned an invalid address.");
    }
    assertPublicAddress(record.address);
  }
  return addresses;
}

const defaultRequest: NonNullable<UrlCaptureDependencies["request"]> = (url, resolved, signal) => new Promise((resolve, reject) => {
  const transport = url.protocol === "https:" ? https : http;
  const request = transport.request(url, {
    method: "GET",
    headers: { "user-agent": "CareerOS/0.1 (local job tracker)", accept: "text/html,text/plain;q=0.9" },
    lookup: ((_hostname: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => {
      callback(null, resolved.address, resolved.family);
    }) as LookupFunction,
    signal,
  }, (response) => {
    resolve({
      status: response.statusCode ?? 0,
      headers: {
        get(name) {
          const value = response.headers[name.toLowerCase()];
          return Array.isArray(value) ? value.join(", ") : value ?? null;
        },
      },
      body: response,
      destroy: () => response.destroy(),
    });
  });
  request.once("error", reject);
  request.end();
});

async function readResponse(response: CaptureResponse) {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > maxResponseBytes) {
    response.destroy();
    throw new Error("The source page is too large to import.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxResponseBytes) {
      response.destroy();
      throw new Error("The source page is too large to import.");
    }
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function captureUrl(input: string, dependencies: UrlCaptureDependencies = {}, externalSignal?: AbortSignal): Promise<CapturedSource> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), urlCaptureTimeoutMs);
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  try {
    return await captureUrlInner(input, dependencies, signal);
  } catch (error) {
    if (externalSignal?.aborted) throw error;
    if (controller.signal.aborted) {
      throw new Error("This source took too long to import. Corporate job portals often block automated capture; paste the job description instead.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function captureUrlInner(input: string, dependencies: UrlCaptureDependencies, captureSignal: AbortSignal): Promise<CapturedSource> {
  const lookup = dependencies.lookup ?? defaultLookup;
  const request = dependencies.request ?? defaultRequest;
  let current = assertSafePublicUrl(input);
  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    try {
      const addresses = await abortable(resolvePublicUrl(current, lookup), captureSignal);
      const response = await request(current, addresses[0], AbortSignal.any([captureSignal, AbortSignal.timeout(urlFetchTimeoutMs)]));
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        response.destroy();
        if (!location) throw new Error("The source returned an incomplete redirect.");
        current = assertSafePublicUrl(new URL(location, current).toString());
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        response.destroy();
        throw new Error(`The source returned HTTP ${response.status}.`);
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const mimeType = contentType.split(";", 1)[0].trim();
      if (mimeType !== "text/html" && mimeType !== "text/plain") {
        response.destroy();
        throw new Error("This source is not a readable HTML or text page.");
      }
      const raw = await readResponse(response);
      const parsedHtml = mimeType === "text/html" ? await parseHtml(raw) : null;
      return {
        url: current.toString(),
        sourceType: "url",
        rawText: parsedHtml?.text ?? raw,
        metadata: { contentType, title: parsedHtml?.title ?? "" },
      };
    } catch (error) {
      if (captureSignal.aborted) throw error;
      if (isTimeoutError(error)) {
        throw new Error("This source took too long to respond. Paste the job description instead.");
      }
      throw error;
    }
  }
  throw new Error("The source redirected too many times.");
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || "code" in error && error.code === "ABORT_ERR");
}

async function parseHtml(html: string) {
  const { load } = await import("cheerio");
  const $ = load(html);
  $("script, style, noscript, svg, nav, footer").remove();
  return {
    text: $("body").text().replace(/\s+/g, " ").trim(),
    title: $("title").first().text().trim(),
  };
}

function firstMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function companyFromUrl(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").split(".")[0].replace(/[-_]/g, " ").replace(/\b\w/g, (value) => value.toUpperCase());
  } catch {
    return "Unknown company";
  }
}

function cleanLine(line: string) {
  return line
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\uFEFF/g, "")
    .trim();
}

function normalisedLines(rawText: string) {
  return rawText
    .replace(/\r/g, "")
    .replace(/\s+\|\s+/g, "\n")
    .replace(
      /([^\n])(?=(?:Salary|Job Family|Location|Application Deadline|Job Reference #|Posted)\s*:?\s*(?:[A-Z0-9]|\d))/gi,
      "$1\n",
    )
    .split("\n")
    .map(cleanLine)
    .filter(Boolean);
}

function lineAfter(lines: string[], label: RegExp) {
  const index = lines.findIndex((line) => label.test(line));
  if (index < 0) return "";
  return lines[index + 1] ?? "";
}

function lineBefore(lines: string[], label: RegExp) {
  const index = lines.findIndex((line) => label.test(line));
  if (index <= 0) return "";
  return lines[index - 1] ?? "";
}

function labelledValue(lines: string[], label: RegExp) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(label);
    if (!match) continue;
    const inlineValue = match[1]?.trim();
    if (inlineValue) return inlineValue;
    return lines[index + 1] ?? "";
  }
  return "";
}

function trimPageChrome(lines: string[]) {
  const footerIndex = lines.findIndex((line) => [
    /^Share this$/i,
    /^View all jobs$/i,
    /^Find us on:?$/i,
    /^Accessibility Statement$/i,
    /^Privacy Policy$/i,
  ].some((pattern) => pattern.test(line)));
  return footerIndex >= 0 ? lines.slice(0, footerIndex) : lines;
}

function sectionBetween(lines: string[], start: RegExp, stops: RegExp[]) {
  const startIndex = lines.findIndex((line) => start.test(line));
  if (startIndex < 0) return "";
  const collected: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (stops.some((stop) => stop.test(line))) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}

function bulletItems(section: string) {
  const lines = section.split("\n").map((line) => line.trim()).filter(Boolean);
  const bulletLines = lines.filter((line) => /^[•\u2022\-*]\s+/.test(line));
  return (bulletLines.length ? bulletLines : lines)
    .map((line) => line.replace(/^[•\u2022\-*]\s*/, "").trim())
    .filter((line) => line.length > 8)
    .slice(0, 12);
}

function firstParagraph(section: string, maxChars = 520) {
  const paragraph = section
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 20) ?? "";
  return paragraph.slice(0, maxChars);
}

function cleanCapturedUrl(value = "") {
  return value.trim().replace(/^</, "").replace(/[>\])},.;]+$/, "");
}

function firstUrl(rawText: string) {
  return cleanCapturedUrl(rawText.match(/https?:\/\/\S+/)?.[0]);
}

function labelledApplyUrl(rawText: string) {
  const label = "(?:apply\\s*(?:now|here|link|url)?|application\\s*(?:link|url)|direct\\s*(?:apply|application))";
  const markdown = rawText.match(new RegExp(`\\[${label}\\]\\(\\s*(https?:\\/\\/[^\\s)]+)\\s*\\)`, "i"))?.[1];
  const plain = rawText.match(new RegExp(`${label}\\s*[:\\-]?\\s*<?(https?:\\/\\/\\S+)`, "i"))?.[1];
  return cleanCapturedUrl(markdown || plain);
}

function inferCompanyName(lines: string[], sourceUrl: string) {
  if (lines.some((line) => /\bUBS\b/i.test(line))) return "UBS";
  for (const line of lines) {
    const equalOpportunity = line.match(/^(.{2,80}?)\s+is an equal opportunity employer\b/i);
    if (equalOpportunity?.[1]) return equalOpportunity[1].trim();
    const copyright = line.match(/^©\s*(.{2,80}?)\s+\d{4}\b/i);
    if (copyright?.[1]) return copyright[1].trim();
    const careersAccount = line.match(/^(.{2,60}?)\s+careers on\s+/i);
    if (careersAccount?.[1]) return careersAccount[1].trim();
  }
  return sourceUrl ? companyFromUrl(sourceUrl) : "";
}

function countryFromLocation(location: string) {
  const countries = [
    "United Kingdom",
    "Singapore",
    "United States",
    "Australia",
    "Canada",
    "Germany",
    "France",
    "Switzerland",
    "Hong Kong",
  ];
  return countries.find((country) => location.toLowerCase().includes(country.toLowerCase())) ?? "";
}

function extractStructuredDraft(rawText: string, sourceUrl = "", applyUrl = ""): Partial<JobDraft> {
  const allLines = normalisedLines(rawText);
  const lines = trimPageChrome(allLines);
  const text = lines.join("\n");
  const shareTitle = lineAfter(lines, /^Share$/i);
  const title = shareTitle
    || lineBefore(lines, /^Summary$/i)
    || labelledValue(lines, /^(?:Job title|Position|Role)\s*[:\-]\s*(.+)$/i)
    || lines.find((line) => /(?:program|intern|analyst|engineer|graduate|trainee)/i.test(line) && line.length <= 120)
    || "";
  const city = labelledValue(lines, /^City\s*:?\s*(.*)$/i);
  const titleIndex = title ? lines.indexOf(title) : -1;
  const location = labelledValue(lines, /^Location\s*:\s*(.+)$/i)
    || city
    || (shareTitle && titleIndex >= 0 ? lines[titleIndex + 1] ?? "" : "");
  const roleFamily = labelledValue(lines, /^Job Family\s*:\s*(.+)$/i)
    || (shareTitle && titleIndex >= 0 ? lines[titleIndex + 2] ?? "" : "");
  const division = shareTitle && titleIndex >= 0 ? lines[titleIndex + 3] ?? "" : "";
  const roleSection = sectionBetween(
    lines,
    /^(?:About the role|Your role|The role|Role overview|Job description)$/i,
    [
      /^About you$/i,
      /^Your team$/i,
      /^Your expertise$/i,
      /^Your program$/i,
      /^Requirements$/i,
      /^Qualifications$/i,
      /^Application process$/i,
      /^Hiring process$/i,
      /^About us$/i,
      /^Join us$/i,
      /^Posted\s*:/i,
      /^.+ is an equal opportunity employer\b/i,
    ],
  );
  const teamSection = sectionBetween(
    lines,
    /^Your team$/i,
    [/^Your expertise$/i, /^Your program$/i, /^About us$/i, /^Join us$/i, /^Posted\s*:/i],
  );
  const expertiseSection = sectionBetween(
    lines,
    /^(?:About you|Your expertise|Requirements|Qualifications|What you(?:'|’)ll need|Who you are)$/i,
    [
      /^Your program$/i,
      /^Application process$/i,
      /^Hiring process$/i,
      /^About us$/i,
      /^Join us$/i,
      /^Posted\s*:/i,
      /^.+ is an equal opportunity employer\b/i,
    ],
  );
  const programSection = sectionBetween(
    lines,
    /^(?:Your program|Application process|Hiring process|What happens next)$/i,
    [/^About us$/i, /^Join us$/i, /^Posted\s*:/i, /^.+ is an equal opportunity employer\b/i],
  );
  const aboutSection = sectionBetween(
    lines,
    /^(?:About us|About the company)$/i,
    [/^Join us$/i, /^Disclaimer/i, /^About BANK-now$/i, /^Posted\s*:/i],
  );
  const deadline = labelledValue(lines, /^Application Deadline\s*:?\s*(.*)$/i);
  const requisitionId = labelledValue(lines, /^Job Reference #\s*:?\s*(.*)$/i);
  const postingDate = labelledValue(lines, /^Posted\s*:?\s*(.*)$/i);
  const url = sourceUrl || firstUrl(rawText);
  const companyName = labelledValue(lines, /^(?:Company|Employer)\s*[:\-]\s*(.+)$/i)
    || inferCompanyName(allLines, url);
  const inlineRequirements = labelledValue(
    lines,
    /^(?:Requirements|Qualifications|What you(?:'|’)ll need)\s*[:\-]\s*(.+)$/i,
  );
  const requiredRequirements = bulletItems(expertiseSection || inlineRequirements.replace(/;\s*/g, "\n"));
  const visaRequirements = requiredRequirements.find((item) => /citizen|visa|work authori[sz]ation|national service/i.test(item)) ?? "";
  const isGraduate = /\bgraduate\b/i.test(title) || /\bgraduate programme\b/i.test(text);
  const sector = /\bfinance|bank|wealth|investment\b/i.test(text)
    ? "Finance"
    : /\bengineering|engineer|product design\b/i.test(`${title}\n${roleFamily}\n${roleSection}`)
      ? "Engineering"
      : "";

  return {
    title,
    companyName,
    location,
    country: countryFromLocation(location),
    sector,
    roleFamily,
    division,
    team: division || "",
    summary: firstParagraph(roleSection || text),
    companySnapshot: firstParagraph(aboutSection, 360),
    companyDescription: aboutSection.replace(/\s+/g, " ").trim(),
    requiredRequirements,
    processSummary: firstParagraph(programSection || teamSection, 700),
    visaRequirements,
    requisitionId,
    sourceUrl: url,
    applyUrl,
    applicationDeadline: deadline,
    postingDate,
    seniority: isGraduate ? "Graduate" : "",
    employmentType: /traineeship|graduate|university|polytechnic|program|programme/i.test(text) ? "Graduate program" : "",
  };
}

export function extractJobDraft(rawText: string, sourceUrl = "", applyUrl = ""): JobDraft {
  const structured = extractStructuredDraft(rawText, sourceUrl, applyUrl);
  const lines = trimPageChrome(normalisedLines(rawText));
  const text = lines.join("\n");
  const firstLineTitle = lines.find((line, index) => index < 4
    && line.length >= 3
    && line.length <= 140
    && /\b(?:role|job|intern|analyst|engineer|designer|developer|manager|trader|consultant|associate|graduate|placement|programme|program)\b/i.test(line)
    && !/^(?:menu|home|job search|skip to|company|employer|location|requirements?|qualifications?)\b/i.test(line)
    && !/^https?:\/\//i.test(line)) ?? "";
  const title = structured.title
    || labelledValue(lines, /^(?:Job title|Position|Role)\s*[:\-]\s*(.+)$/i)
    || firstLineTitle
    || "Untitled opportunity";
  const location = structured.location || labelledValue(lines, /^Location\s*:\s*(.+)$/i);
  const companyName = structured.companyName
    || labelledValue(lines, /^(?:Company|Employer)\s*[:\-]\s*(.+)$/i)
    || (sourceUrl ? companyFromUrl(sourceUrl) : "Unknown company");
  const summary = structured.summary || firstParagraph(text);
  const description = text.length > maxDraftDescriptionChars
    ? `${text.slice(0, maxDraftDescriptionChars)}\n\n[CareerOS truncated the review draft. The full source capture is stored separately.]`
    : text;
  const capturedApplyUrl = applyUrl || labelledApplyUrl(rawText) || structured.applyUrl || structured.sourceUrl || sourceUrl;
  return {
    title,
    companyName,
    companySnapshot: structured.companySnapshot ?? "",
    companyDescription: structured.companyDescription ?? "",
    location,
    country: structured.country || "",
    region: "",
    workMode: firstMatch(text, [/(remote|hybrid|on[- ]site)/i]),
    employmentType: structured.employmentType || firstMatch(text, [/(internship|graduate|full[- ]time|part[- ]time|contract)/i]),
    seniority: structured.seniority || "",
    sector: structured.sector || "",
    roleFamily: structured.roleFamily || "",
    division: structured.division || "",
    team: structured.team || "",
    summary,
    description,
    requiredRequirements: structured.requiredRequirements?.length ? structured.requiredRequirements : [],
    preferredRequirements: [],
    processSummary: structured.processSummary || "",
    visaRequirements: structured.visaRequirements || "",
    requisitionId: structured.requisitionId || "",
    sourceUrl: structured.sourceUrl || sourceUrl,
    applyUrl: capturedApplyUrl,
    referralSource: "",
    recruiterContact: "",
    applicationDeadline: structured.applicationDeadline || "",
    postingDate: structured.postingDate || "",
    expiryDate: "",
    lastCheckedAt: "",
    postingState: "Active",
  } as JobDraft;
}

export function capturePastedText(text: string, sourceType = "pasted_text"): CapturedSource {
  return { url: null, sourceType, rawText: text.trim(), metadata: {} };
}

export function sourceId() {
  return randomUUID();
}

export function contentHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
