import { describe, expect, it } from "vitest";
import { cvDocumentContentSchema } from "./index";

const content = {
  name: "Zain Ahmad",
  headline: "Design Engineer",
  contact: { email: "zain@example.com", phone: "", website: "" },
  sections: [{ id: "role-1", evidenceType: "experience", title: "SageCare", content: "Designed a website.", sourceEvidenceIds: [] }],
};

describe("CV inline formatting contracts", () => {
  it("accepts bounded marks for real document fields", () => {
    expect(cvDocumentContentSchema.safeParse({ ...content, inlineFormatting: [
      { field: "name", start: 0, end: 4, bold: true },
      { field: "section:role-1:content", start: 0, end: 8, italic: true },
    ] }).success).toBe(true);
  });

  it("rejects unknown fields and ranges beyond their text", () => {
    const parsed = cvDocumentContentSchema.safeParse({ ...content, inlineFormatting: [
      { field: "section:missing:content", start: 0, end: 2, bold: true },
      { field: "section:role-1:content", start: 0, end: 200, italic: true },
    ] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "Formatted text must reference an existing CV field.",
      "Formatted text range exceeds the referenced CV field.",
    ]));
  });
});
