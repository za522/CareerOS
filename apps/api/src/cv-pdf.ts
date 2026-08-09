import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { CvDocumentContent, CvDocumentSection, CvInlineFormatMark } from "@careeros/contracts";

const execFileAsync = promisify(execFile);

async function popplerTool(name: "pdfinfo" | "pdftoppm" | "pdftotext") {
  const configuredDirectory = process.env.CAREEROS_POPPLER_BIN?.trim();
  if (configuredDirectory && existsSync(join(configuredDirectory, name))) return join(configuredDirectory, name);
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", [name], { timeout: 2_000 });
    const executable = stdout.trim();
    if (executable) return executable;
  } catch {
    // The bundled Codex runtime exposes pdfinfo through a wrapper but not every sibling tool.
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/which", ["pdfinfo"], { timeout: 2_000 });
    const pdfInfoPath = stdout.trim();
    const bundled = resolve(dirname(pdfInfoPath), "../../native/poppler/poppler/bin", name);
    if (existsSync(bundled)) return bundled;
  } catch {
    // Normal installations keep all Poppler tools on PATH and use the name directly.
  }
  return name;
}

const fontStacks: Record<string, string> = {
  manrope: "Arial, Helvetica, sans-serif",
  inter: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
  cambria: "'Times New Roman', Times, serif",
};

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function linkifyEscaped(value: string) {
  return value.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi, (match) => {
    const trailing = match.match(/[),.;!?]+$/)?.[0] ?? "";
    const link = trailing ? match.slice(0, -trailing.length) : match;
    const href = link.toLowerCase().startsWith("www.") ? `https://${link}` : link;
    return `<a href="${escapeHtml(href)}">${link}</a>${trailing}`;
  });
}

function inlineHtml(value: string, field: string, marks: CvInlineFormatMark[], autoLink = true) {
  const relevant = marks.filter((mark) => mark.field === field && mark.start >= 0 && mark.end > mark.start && mark.start < value.length);
  const boundaries = [...new Set([0, value.length, ...relevant.flatMap((mark) => [Math.min(mark.start, value.length), Math.min(mark.end, value.length)])])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const escaped = escapeHtml(value.slice(start, end));
    let segment = (autoLink ? linkifyEscaped(escaped) : escaped).replaceAll("\n", "<br>");
    const active = relevant.filter((mark) => mark.start <= start && mark.end >= end);
    if (active.some((mark) => mark.bold)) segment = `<strong>${segment}</strong>`;
    if (active.some((mark) => mark.italic)) segment = `<em>${segment}</em>`;
    return segment;
  }).join("");
}

function groupTitle(section: CvDocumentSection) {
  if (section.groupTitle?.trim()) return section.groupTitle.trim();
  if (section.evidenceType === "education") return "Education";
  if (section.evidenceType === "experience") return "Professional Experience";
  if (section.evidenceType === "project") return "Projects";
  if (section.evidenceType === "achievement") return "Awards & Achievements";
  if (section.evidenceType === "skill") return "Skills";
  return "Additional Information";
}

function compactSection(section: CvDocumentSection) {
  return section.evidenceType === "skill" || /^(technical skills?|skills?|interests?|languages?|additional information)$/i.test(section.title.trim());
}

function renderSection(section: CvDocumentSection, marks: CvInlineFormatMark[], showHeading: boolean, continued: boolean, defaultHeadingSpacing: number) {
  const id = escapeHtml(section.id);
  const group = escapeHtml(groupTitle(section));
  const headingSpacing = Math.max(0, Math.min(24, section.spacingBefore ?? defaultHeadingSpacing));
  if (compactSection(section)) {
    return `<section class="record compact" data-section-id="${id}"><div><strong>${inlineHtml(section.title, `section:${section.id}:title`, marks)}:</strong><span>${inlineHtml(section.content, `section:${section.id}:content`, marks)}</span></div></section>`;
  }
  return `${showHeading ? `<h2 style="margin-top:${headingSpacing}px">${group}${continued ? " <small>continued</small>" : ""}</h2>` : ""}<section class="record" data-section-id="${id}"><div class="entry-heading"><strong>${inlineHtml(section.title, `section:${section.id}:title`, marks)}</strong><strong class="date">${inlineHtml(section.date ?? "", `section:${section.id}:date`, marks)}</strong></div><div class="entry-meta"><em>${inlineHtml(section.subtitle ?? "", `section:${section.id}:subtitle`, marks)}</em><em class="location">${inlineHtml(section.location ?? "", `section:${section.id}:location`, marks)}</em></div><div class="entry-body">${inlineHtml(section.content, `section:${section.id}:content`, marks)}</div></section>`;
}

export function validatePdfPageSections(content: CvDocumentContent, pageSectionIds: string[][]) {
  const expected = content.sections.map((section) => section.id);
  const supplied = pageSectionIds.flat();
  if (new Set(supplied).size !== supplied.length) throw new Error("A CV entry appears on more than one PDF page.");
  if (supplied.length !== expected.length || expected.some((id) => !supplied.includes(id))) throw new Error("The PDF page layout does not contain every CV entry exactly once.");
}

export function renderCvPdfHtml(content: CvDocumentContent, pageSectionIds: string[][]) {
  validatePdfPageSections(content, pageSectionIds);
  const marks = content.inlineFormatting ?? [];
  const byId = new Map(content.sections.map((section) => [section.id, section]));
  const style = {
    fontFamily: fontStacks[content.style?.fontFamily ?? "manrope"] ?? fontStacks.manrope,
    fontSize: content.style?.fontSize ?? 10.5,
    sectionSpacing: content.style?.sectionSpacing ?? 12,
    entrySpacing: content.style?.entrySpacing ?? 3,
    headerSpacing: content.style?.headerSpacing ?? 4,
    lineHeight: content.style?.lineHeight ?? 1.38,
  };
  const groupsSeenOnEarlierPages = new Set<string>();
  const pages = pageSectionIds.map((ids, pageIndex) => {
    let previousGroup = "";
    const sections = ids.map((id) => byId.get(id)!).map((section) => {
      const group = groupTitle(section);
      const showHeading = group !== previousGroup && !compactSection(section);
      const continued = showHeading && groupsSeenOnEarlierPages.has(group);
      const rendered = renderSection(section, marks, showHeading, continued, style.sectionSpacing);
      previousGroup = group;
      return rendered;
    }).join("");
    for (const id of ids) groupsSeenOnEarlierPages.add(groupTitle(byId.get(id)!));
    const header = pageIndex === 0
      ? `<header><h1>${inlineHtml(content.name, "name", marks)}</h1><nav>${content.contact?.email ? `<a href="mailto:${escapeHtml(content.contact.email)}">${inlineHtml(content.contact.email, "contact.email", marks, false)}</a>` : ""}${content.contact?.phone ? `<a href="tel:${escapeHtml(content.contact.phone.replace(/\s+/g, ""))}">${inlineHtml(content.contact.phone, "contact.phone", marks, false)}</a>` : ""}${content.contact?.website ? `<a href="${escapeHtml(/^https?:\/\//i.test(content.contact.website) ? content.contact.website : `https://${content.contact.website}`)}">${inlineHtml(content.contact.website, "contact.website", marks, false)}</a>` : ""}</nav>${content.intro ? `<p>${inlineHtml(content.intro, "intro", marks)}</p>` : ""}</header>`
      : `<div class="continuation"><strong>${escapeHtml(content.name)}</strong><span>CV continued</span></div>`;
    return `<article class="page">${header}${sections}<footer>${pageIndex + 1} / ${pageSectionIds.length}</footer></article>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(content.name)} CV</title><style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; color: #17231f; background: white; font-family: ${style.fontFamily}; font-size: ${style.fontSize}pt; line-height: ${style.lineHeight}; }
    .page { position: relative; width: 210mm; height: 297mm; overflow: hidden; break-after: page; padding: 12.6mm 14.4mm 14.4mm; background: white; }
    .page:last-child { break-after: auto; }
    header { min-height: 66px; padding-bottom: ${style.headerSpacing}px; text-align: center; }
    h1 { margin: 0; font-size: 2em; font-weight: 800; line-height: 1.05; }
    nav { display: flex; justify-content: center; flex-wrap: wrap; gap: 3px 13px; margin-top: ${style.headerSpacing}px; font-size: .9em; }
    a { color: inherit; text-decoration: none; }
    header p { margin: ${style.headerSpacing}px 0 0; border-top: 1px solid #17231f; padding-top: ${style.headerSpacing}px; white-space: normal; }
    .continuation { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 5px; border-bottom: 1px solid #17231f; padding-bottom: 7px; }
    .continuation strong { font-size: 1.24em; font-weight: 800; }
    h2 { display: flex; align-items: center; gap: 8px; margin: ${style.sectionSpacing}px 0 0; border-bottom: 1px solid #17231f; padding: 0 0 3px; font-size: 1.08em; font-weight: 800; line-height: 1.08; text-transform: uppercase; }
    h2 small { color: #63726c; font-size: .72em; font-weight: 400; text-transform: uppercase; }
    .record { margin-top: ${style.entrySpacing}px; }
    .entry-heading, .entry-meta { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: center; gap: 8px; line-height: 1.08; }
    .entry-heading > strong:first-child, .compact strong { font-weight: 800; }
    .date, .location { max-width: 48mm; text-align: right; white-space: normal; overflow-wrap: anywhere; }
    .entry-meta { color: #46554f; font-size: .94em; font-weight: 600; }
    .entry-body { padding-top: 1px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .compact > div { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: baseline; gap: 7px; }
    footer { position: absolute; right: 10mm; bottom: 8mm; color: #63726c; font-size: 8pt; }
  </style></head><body>${pages}<script>document.querySelectorAll('.page').forEach((page) => { const style = getComputedStyle(page); const boundary = page.getBoundingClientRect().bottom - parseFloat(style.paddingBottom); const blocks = page.querySelectorAll('header, .continuation, h2, .record'); page.dataset.careerosOverflow = [...blocks].some((block) => block.getBoundingClientRect().bottom > boundary + 1) ? 'true' : 'false'; });</script></body></html>`;
}

function chromeExecutable() {
  const candidates = [process.env.CAREEROS_CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean) as string[];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("PDF export needs Google Chrome or Chromium. Set CAREEROS_CHROME_PATH to its executable.");
  return executable;
}

export async function verifyRenderedPdf(outputPath: string, expectedPageCount: number, expectedTextFragments: string[], expectedLinks: string[] = []) {
  const { stdout: info } = await execFileAsync(await popplerTool("pdfinfo"), [outputPath], { timeout: 10_000, maxBuffer: 1_000_000 });
  const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0);
  if (pages !== expectedPageCount) throw new Error(`PDF verification found ${pages} pages instead of ${expectedPageCount}.`);
  const size = info.match(/^Page size:\s+([\d.]+) x ([\d.]+) pts/m);
  if (!size || Math.abs(Number(size[1]) - 595) > 2 || Math.abs(Number(size[2]) - 842) > 2) throw new Error("PDF verification found a non-A4 page size.");
  const expected = expectedTextFragments.map(normalizeExtractedText).filter(Boolean);
  if (!expected.length) throw new Error("PDF verification requires expected CV content.");
  const { stdout: extracted } = await execFileAsync(await popplerTool("pdftotext"), ["-layout", outputPath, "-"], { timeout: 10_000, maxBuffer: 5_000_000 });
  const searchableText = normalizeExtractedText(extracted);
  const missing = expected.find((fragment) => !searchableText.includes(fragment));
  if (missing) {
    const label = missing.length > 90 ? `${missing.slice(0, 87)}...` : missing;
    throw new Error(`PDF verification found clipped or missing CV text: "${label}". Move the affected entry to another page or reduce its content before exporting.`);
  }
  if (expectedLinks.length) {
    const { stdout: urls } = await execFileAsync(await popplerTool("pdfinfo"), ["-url", outputPath], { timeout: 10_000, maxBuffer: 1_000_000 });
    const missingLink = expectedLinks.find((link) => !urls.includes(link));
    if (missingLink) throw new Error(`PDF verification found a missing or inactive link: "${missingLink}".`);
  }
  const previewPrefix = `${outputPath}.verify`;
  try {
    await execFileAsync(await popplerTool("pdftoppm"), ["-png", "-r", "72", outputPath, previewPrefix], { timeout: 20_000, maxBuffer: 1_000_000 });
    for (let page = 1; page <= expectedPageCount; page += 1) {
      const previewPath = `${previewPrefix}-${page}.png`;
      if (!existsSync(previewPath)) throw new Error(`PDF verification could not render page ${page}.`);
      const png = readFileSync(previewPath);
      if (png.length < 2_000 || png.subarray(1, 4).toString("ascii") !== "PNG") throw new Error(`PDF page ${page} rendered blank or invalid.`);
      if (png.readUInt32BE(16) < 590 || png.readUInt32BE(20) < 840) throw new Error(`PDF page ${page} did not render at full A4 dimensions.`);
    }
  } finally {
    for (let page = 1; page <= expectedPageCount + 1; page += 1) rmSync(`${previewPrefix}-${page}.png`, { force: true });
  }
}

function normalizeExtractedText(value: string) {
  return value.normalize("NFKC").replace(/[\u2010-\u2015]/g, "-").replace(/\s+/g, " ").trim();
}

export async function renderCvPdf(htmlPath: string, outputPath: string, verification?: { expectedPageCount: number; expectedTextFragments: string[]; expectedLinks?: string[] }) {
  const chrome = chromeExecutable();
  const pageUrl = pathToFileURL(htmlPath).href;
  const { stdout: measuredDom } = await execFileAsync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--virtual-time-budget=1000",
    "--dump-dom",
    pageUrl,
  ], { timeout: 20_000, maxBuffer: 5_000_000 });
  if (/data-careeros-overflow="true"/.test(measuredDom)) {
    throw new Error("PDF verification found content outside an A4 page boundary. Move the affected entry to another page or reduce its content before exporting.");
  }
  await execFileAsync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-pdf-header-footer",
    `--print-to-pdf=${outputPath}`,
    pageUrl,
  ], { timeout: 45_000, maxBuffer: 1_000_000 });
  if (!existsSync(outputPath)) throw new Error("Chrome did not create the requested PDF.");
  const bytes = readFileSync(outputPath);
  if (bytes.length < 1_000 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("The generated PDF failed its file-integrity check.");
  if (verification) await verifyRenderedPdf(outputPath, verification.expectedPageCount, verification.expectedTextFragments, verification.expectedLinks);
  return bytes;
}
