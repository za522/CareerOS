import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CvDocumentContent } from "@careeros/contracts";
import { renderCvPdf, renderCvPdfHtml, validatePdfPageSections } from "./cv-pdf.js";

const content: CvDocumentContent = {
  name: "Zain Ahmad",
  headline: "Design engineer",
  intro: "Product-minded engineer with finance and software experience.",
  contact: { email: "zain@example.com", phone: "+44 7444 222 841", website: "https://zain.example/portfolio" },
  style: { fontFamily: "manrope", fontSize: 10.5, sectionSpacing: 10, entrySpacing: 3, headerSpacing: 4, lineHeight: 1.3, nameAlignment: "center" },
  inlineFormatting: [{ field: "section:education:content", start: 0, end: 8, bold: true, italic: false }],
  sections: [
    { id: "education", evidenceType: "education", groupTitle: "Education", title: "Imperial College London", subtitle: "MEng Design Engineering", date: "March 2011-May 2020", location: "London, United Kingdom", content: "Graduated with first-class honours. Portfolio: https://zain.example/project", sourceEvidenceIds: [] },
    { id: "skills", evidenceType: "skill", groupTitle: "Skills", title: "Programming", subtitle: "", date: "", location: "", content: "Python, TypeScript, SQL", sourceEvidenceIds: [] },
  ],
};

describe("CV PDF rendering", () => {
  it("renders exact page assignments, working links, emphasis and flexible date columns", () => {
    const html = renderCvPdfHtml({ ...content, sections: [{ ...content.sections[0], spacingBefore: 7 }, content.sections[1]] }, [["education"], ["skills"]]);
    expect(html.match(/class="page"/g)).toHaveLength(2);
    expect(html).toContain('href="mailto:zain@example.com"');
    expect(html).toContain('href="https://zain.example/portfolio"');
    expect(html).toContain('href="https://zain.example/project"');
    expect(html).toContain("grid-template-columns: minmax(0, 1fr) max-content");
    expect(html).toContain("March 2011-May 2020");
    expect(html).toContain("<strong>Graduate</strong>");
    expect(html).toContain('<h2 style="margin-top:7px">Education</h2>');
  });

  it("labels a group continued only when that group began on an earlier page", () => {
    const experience = { ...content.sections[0], id: "experience", evidenceType: "experience" as const, groupTitle: "Professional Experience", title: "SageCare" };
    const secondExperience = { ...experience, id: "experience-2", title: "Krislite" };
    const newGroupOnPageTwo = renderCvPdfHtml({ ...content, sections: [content.sections[0], experience] }, [["education"], ["experience"]]);
    expect(newGroupOnPageTwo).toContain(">Professional Experience</h2>");
    expect(newGroupOnPageTwo).not.toContain("Professional Experience <small>continued</small>");

    const continuedGroup = renderCvPdfHtml({ ...content, sections: [experience, secondExperience] }, [["experience"], ["experience-2"]]);
    expect(continuedGroup).toContain("Professional Experience <small>continued</small>");
  });

  it("keeps all four editor font choices, centered identity, and compact CV rows in the PDF", () => {
    const expectedFonts = {
      manrope: "Arial, Helvetica, sans-serif",
      inter: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      georgia: "Georgia, 'Times New Roman', serif",
      cambria: "'Times New Roman', Times, serif",
    } as const;
    for (const [fontFamily, stack] of Object.entries(expectedFonts)) {
      const html = renderCvPdfHtml({ ...content, style: { ...content.style!, fontFamily: fontFamily as keyof typeof expectedFonts } }, [["education", "skills"]]);
      expect(html).toContain(`font-family: ${stack}`);
      expect(html).toContain("header { min-height: 66px; padding-bottom: 4px; text-align: center; }");
    }

    const compactContent: CvDocumentContent = {
      ...content,
      sections: [
        { ...content.sections[1], id: "skills", title: "Skills", evidenceType: "skill" },
        { ...content.sections[1], id: "languages", title: "Languages", evidenceType: "other" },
        { ...content.sections[1], id: "interests", title: "Interests", evidenceType: "other" },
      ],
    };
    const compactHtml = renderCvPdfHtml(compactContent, [["skills", "languages", "interests"]]);
    expect(compactHtml.match(/class="record compact"/g)).toHaveLength(3);
    expect(compactHtml).not.toContain("<h2");
    expect(compactHtml).not.toMatch(/<a[^>]*><a/);
  });

  it("rejects missing, repeated and unknown page assignments before creating a PDF", () => {
    expect(() => validatePdfPageSections(content, [["education"]])).toThrow(/every CV entry/);
    expect(() => validatePdfPageSections(content, [["education", "education"]])).toThrow(/more than one PDF page/);
    expect(() => validatePdfPageSections(content, [["education", "unknown"]])).toThrow(/every CV entry/);
  });

  it("escapes imported content instead of executing it in the renderer", () => {
    const hostile = { ...content, intro: '<script>location="https://evil.invalid"</script>' };
    const html = renderCvPdfHtml(hostile, [["education", "skills"]]);
    expect(html).not.toContain("<script>location");
    expect(html).toContain("&lt;script&gt;");
  });

  it.runIf(existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))("creates a real two-page PDF with the local Chrome renderer", async () => {
    const artifactDirectory = process.env.CAREEROS_PDF_ARTIFACT_DIR?.trim();
    const directory = artifactDirectory || mkdtempSync(join(tmpdir(), "careeros-cv-pdf-"));
    if (artifactDirectory) rmSync(directory, { recursive: true, force: true });
    if (artifactDirectory) mkdirSync(directory, { recursive: true });
    const htmlPath = join(directory, "cv.html");
    const pdfPath = join(directory, "cv.pdf");
    try {
      writeFileSync(htmlPath, renderCvPdfHtml(content, [["education"], ["skills"]]), "utf8");
      const bytes = await renderCvPdf(htmlPath, pdfPath, { expectedPageCount: 2, expectedTextFragments: [content.name, ...content.sections.map((section) => section.title)], expectedLinks: ["mailto:zain@example.com", "https://zain.example/portfolio", "https://zain.example/project"] });
      expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(readFileSync(pdfPath).length).toBeGreaterThan(5_000);
    } finally {
      if (!artifactDirectory) rmSync(directory, { recursive: true, force: true });
    }
  }, 45_000);

  it.runIf(existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))("rejects an A4 page that clips later CV lines", async () => {
    const directory = mkdtempSync(join(tmpdir(), "careeros-cv-overflow-"));
    const htmlPath = join(directory, "overflow.html");
    const pdfPath = join(directory, "overflow.pdf");
    const lines = Array.from({ length: 45 }, (_, index) => `Evidence line ${index + 1}: delivered a measurable design engineering outcome across product strategy, technical implementation, stakeholder communication, and launch validation.`);
    const overflowing: CvDocumentContent = {
      ...content,
      sections: [{ ...content.sections[0], content: lines.join("\n") }],
    };
    try {
      writeFileSync(htmlPath, renderCvPdfHtml(overflowing, [["education"]]), "utf8");
      await expect(renderCvPdf(htmlPath, pdfPath, { expectedPageCount: 1, expectedTextFragments: [overflowing.name, ...lines] })).rejects.toThrow(/outside an A4 page boundary/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 45_000);
});
