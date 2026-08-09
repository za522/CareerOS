import { afterEach, describe, expect, it, vi } from "vitest";
import { jobDraftSchema, type CvDocumentContent, type JobDraft } from "@careeros/contracts";
import { createOpenAiProvider, enrichJobDraft, resolveCvRequestTargets } from "./index.js";

const evidenceA = "11111111-1111-4111-8111-111111111111";
const evidenceB = "22222222-2222-4222-8222-222222222222";

function baseCv(): CvDocumentContent {
  return {
    name: "Zain Ahmad",
    headline: "Design Engineer",
    intro: "",
    contact: { email: "old@example.com", phone: "", website: "https://old.example" },
    sections: [
      { id: "police-role", evidenceType: "experience", groupTitle: "Leadership & Activities", title: "Singapore Police Force", subtitle: "Operations Room Officer", content: "Led four-officer teams during operational incidents.", sourceEvidenceIds: [evidenceA] },
      { id: "police-award", evidenceType: "achievement", groupTitle: "Awards & Achievements", title: "Singapore Police Force Commander Awards", content: "Received three Commander Awards.", sourceEvidenceIds: [evidenceA] },
      { id: "sagecare", evidenceType: "experience", groupTitle: "Professional Experience", title: "SageCare", subtitle: "Web Design Intern", content: "Designed a small website.", sourceEvidenceIds: [evidenceB] },
    ],
  };
}

function modelResponse(value: unknown) {
  return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function intent(targetSectionIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    mode: "targeted",
    targetField: null,
    targetSectionField: null,
    targetSectionIds,
    excludedSectionIds: [],
    requestedValue: null,
    interpretation: "Resolved test scope.",
    ...overrides,
  };
}

function change(targetSectionId: string, proposedContent: string, evidenceIds = [evidenceB], overrides: Record<string, unknown> = {}) {
  return {
    changeKey: `${targetSectionId}-rewrite`,
    operation: "rewrite",
    targetField: null,
    targetSectionField: null,
    targetSectionId,
    proposedPosition: null,
    proposedEvidenceType: "experience",
    proposedTitle: targetSectionId === "sagecare" ? "SageCare" : "Singapore Police Force",
    proposedContent,
    rationale: "Evidence-backed rewrite.",
    evidenceIds,
    confidence: 0.95,
    ...overrides,
  };
}

function coverage(overrides: Record<string, "change" | "keep"> = {}) {
  return {
    interpretation: "Complete document-wide coverage.",
    coverage: ["headline", "intro", "police-role", "police-award", "sagecare"].map((targetKey) => ({
      targetKey,
      decision: overrides[targetKey] ?? "keep",
      rationale: overrides[targetKey] === "change" ? "Relevant to the requested role." : "No justified change.",
    })),
  };
}

function providerInput(instructions: string, content = baseCv()) {
  return {
    jobPostingId: crypto.randomUUID(),
    documentId: crypto.randomUUID(),
    baseVersionId: null,
    job: {} as JobDraft,
    baseContent: content,
    profileEvidence: [
      { id: evidenceA, evidenceType: "experience", title: "Police service", content: "Led four-officer teams during operational incidents and received three Commander Awards." },
      { id: evidenceB, evidenceType: "experience", title: "SageCare", content: "Designed a small website." },
    ],
    instructions,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("deterministic job evidence", () => {
  it("retains field-level provenance when no AI provider is configured", async () => {
    const text="Graduate Software Engineer at Example Capital in London. Requirements: Python and data structures.";
    const draft=jobDraftSchema.parse({title:"Graduate Software Engineer",companyName:"Example Capital",location:"London",requiredRequirements:["Python","data structures"]});
    const result=await enrichJobDraft({provider:{name:"none",model:"none",configured:false,enrichJob:vi.fn()},deterministicDraft:draft,text});
    expect(result.mode).toBe("deterministic");
    expect(result.evidence.map(item=>item.fieldPath)).toEqual(expect.arrayContaining(["title","companyName","location","requiredRequirements"]));
    expect(result.evidence.every(item=>text.includes(item.excerpt))).toBe(true);
    expect(result.evidence.every(item=>item.confidence>=0.55)).toBe(true);
  });
});

describe("CV request resolution regressions", () => {
  it("resolves an exact Police Force role without also selecting its similarly named award", () => {
    expect(resolveCvRequestTargets("Rewrite only the Singapore Police Force role", baseCv()).targets.map((target) => target.key)).toEqual(["police-role"]);
  });

  it("resolves the exact longer overlapping award title without selecting the role", () => {
    expect(resolveCvRequestTargets("Rewrite only the Singapore Police Force Commander Awards", baseCv()).targets.map((target) => target.key)).toEqual(["police-award"]);
  });

  it("resolves a singular variation of an overlapping award title", () => {
    expect(resolveCvRequestTargets("Rewrite only the Singapore Police Force Commander Award", baseCv()).targets.map((target) => target.key)).toEqual(["police-award"]);
  });

  it("retains dedicated fields and named entries in one multi-target request", () => {
    expect(resolveCvRequestTargets("Rewrite my introduction and the SageCare experience", baseCv()).targets.map((target) => target.key)).toEqual(["intro", "sagecare"]);
    expect(resolveCvRequestTargets("Change my portfolio website to https://zain.dev and rewrite SageCare", baseCv()).targets.map((target) => target.key)).toEqual(["contact.website", "sagecare"]);
  });

  it("matches concise names when stored entry titles include a country suffix", () => {
    const content = baseCv();
    content.sections = [
      { ...content.sections[2]!, title: "SageCare UK" },
      { ...content.sections[0]!, id: "krislite", title: "Krislite, Singapore" },
    ];
    expect(resolveCvRequestTargets("Rewrite SageCare and Krislite", content).targets.map((target) => target.key)).toEqual(["sagecare", "krislite"]);
  });

  it("resolves generic all-except rewrites as a deterministic set difference", () => {
    const resolution = resolveCvRequestTargets("Make every entry more concise except SageCare", baseCv());
    expect(resolution.mode).toBe("narrow");
    expect(resolution.targets.map((target) => target.key)).toEqual(["police-role", "police-award"]);
  });

  it.each([
    "Make every entry more concise but leave SageCare unchanged.",
    "Rewrite all entries, but keep SageCare as it is.",
    "Rewrite every entry and do not change SageCare.",
    "Rewrite all entries without changing SageCare.",
    "Rewrite everything, leaving SageCare unchanged.",
    "Rewrite everything while keeping SageCare as it is.",
    "Rewrite everything without altering SageCare.",
    "Rewrite every entry other than SageCare.",
    "Rewrite all entries save SageCare.",
    "Rewrite every entry, with SageCare left untouched.",
    "Rewrite everything, don't alter SageCare.",
    "Improve everything for Amazon but leave SageCare alone.",
    "Improve everything for Amazon but leave SageCare as-is.",
    "Improve everything for Amazon but don't touch SageCare.",
    "Improve everything for Amazon but do not edit SageCare.",
    "Improve everything for Amazon without editing SageCare.",
    "Rewrite all entries; SageCare must remain unchanged.",
  ])("protects natural-language exclusions: %s", (instruction) => {
    const resolution = resolveCvRequestTargets(instruction, baseCv());
    expect(resolution.mode).toBe("narrow");
    expect(resolution.targets.map((target) => target.key)).toEqual(["police-role", "police-award"]);
  });
});

describe("CV evidence safety regressions", () => {
  it("rejects invented claims even when the model cites a real evidence ID", async () => {
    const output = {
      intent: intent(["sagecare"]),
      changes: [change("sagecare", "Led an AWS migration that saved GBP 2 million and managed 20 engineers.")],
      matches: [], gaps: [], summary: "Rewrite ready.",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse(output));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(providerInput("Rewrite the SageCare experience"))).rejects.toThrow(/unsupported factual claims|not supported by the cited CV evidence/);
  });

  it("rejects an invented action appended to an otherwise supported sentence", async () => {
    const output = {
      intent: intent(["sagecare"]),
      changes: [change("sagecare", "Designed a small website and led software engineers through a cloud migration.")],
      matches: [], gaps: [], summary: "Rewrite ready.",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse(output));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(providerInput("Rewrite the SageCare experience"))).rejects.toThrow(/not supported by the cited CV evidence/);
  });

  it("rejects a new relationship assembled from facts supported only in separate sentences", async () => {
    const content = baseCv();
    content.sections[2] = { ...content.sections[2]!, content: "Designed a small website. Led a team." };
    const input = providerInput("Rewrite the SageCare experience", content);
    input.profileEvidence[1] = { ...input.profileEvidence[1]!, content: "Designed a small website. Led a team." };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse({
      intent: intent(["sagecare"]),
      changes: [change("sagecare", "Led a website team.")],
      matches: [], gaps: [], summary: "Rewrite ready.",
    }));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(input)).rejects.toThrow(/factual relationship/);
  });

  it("rejects a new relationship assembled from comma-separated facts", async () => {
    const content = baseCv();
    content.sections[2] = { ...content.sections[2]!, content: "Designed a small website, led a team." };
    const input = providerInput("Rewrite the SageCare experience", content);
    input.profileEvidence[1] = { ...input.profileEvidence[1]!, content: "Designed a small website, led a team." };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse({
      intent: intent(["sagecare"]),
      changes: [change("sagecare", "Led a website team.")],
      matches: [], gaps: [], summary: "Rewrite ready.",
    }));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(input)).rejects.toThrow(/factual relationship/);
  });

  it.each(["Designed a small website & led a team.", "Designed a small website / led a team."])("rejects a new relationship assembled across a CV separator: %s", async (source) => {
    const content = baseCv();
    content.sections[2] = { ...content.sections[2]!, content: source };
    const input = providerInput("Rewrite the SageCare experience", content);
    input.profileEvidence[1] = { ...input.profileEvidence[1]!, content: source };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse({
      intent: intent(["sagecare"]),
      changes: [change("sagecare", "Led a website team.")],
      matches: [], gaps: [], summary: "Rewrite ready.",
    }));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(input)).rejects.toThrow(/factual relationship/);
  });

  it.each(["oversaw", "coordinated", "directing", "transforming"])("rejects an invented %s cloud claim appended to supported content", async (verb) => {
    const output = {
      intent: intent(["sagecare"]),
      changes: [change("sagecare", `Designed a small website and ${verb} software engineers through a cloud migration.`)],
      matches: [], gaps: [], summary: "Rewrite ready.",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse(output));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(providerInput("Rewrite the SageCare experience"))).rejects.toThrow(/not supported by the cited CV evidence/);
  });

  it.each([
    "Designed a small website supporting migration.",
    "Designed a small website for cloud migration.",
    "Designed a small website used in migration.",
    "Designed a small website as part of migration.",
    "Designed a small website (migration support).",
  ])("rejects a short invented claim hidden in supported wording: %s", async (proposedContent) => {
    const output = { intent: intent(["sagecare"]), changes: [change("sagecare", proposedContent)], matches: [], gaps: [], summary: "Rewrite ready." };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse(output));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(providerInput("Rewrite the SageCare experience"))).rejects.toThrow(/not supported by the cited CV evidence/);
  });

  it("rejects evidence that belongs to a different CV entry", async () => {
    const output = {
      intent: intent(["sagecare"]),
      changes: [change("sagecare", "Led four-officer teams during operational incidents.", [evidenceA])],
      matches: [], gaps: [], summary: "Rewrite ready.",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse(output));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(providerInput("Rewrite the SageCare experience"))).rejects.toThrow(/does not belong to SageCare/);
  });

  it("accepts a conservative rewrite supported by evidence owned by the target", async () => {
    const output = {
      intent: intent(["sagecare"]),
      changes: [change("sagecare", "Designed and delivered a small website for SageCare.")],
      matches: [], gaps: [], summary: "Rewrite ready.",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse(output));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    const result = await provider.adaptCv!(providerInput("Rewrite the SageCare experience"));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].evidenceIds).toEqual([evidenceB]);
  });

  it("rejects a new relationship assembled from coordinated clauses", async () => {
    const content = baseCv();
    content.sections[2] = { ...content.sections[2]!, content: "Designed a website and led a team." };
    const input = providerInput("Rewrite the SageCare experience", content);
    input.profileEvidence[1] = { ...input.profileEvidence[1]!, content: "Designed a website and led a team." };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse({
      intent: intent(["sagecare"]),
      changes: [change("sagecare", "Led a website team.")],
      matches: [], gaps: [], summary: "Rewrite ready.",
    }));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(input)).rejects.toThrow(/factual relationship/);
  });
});

describe("deterministic dedicated-field updates", () => {
  const cases: Array<{ label: string; instruction: string; field: string; expected: string; operation: "add" | "rewrite" }> = [
    { label: "name", instruction: "Change my name to Zain A. Ahmad", field: "name", expected: "Zain A. Ahmad", operation: "rewrite" },
    { label: "headline", instruction: "Set my headline to Product and Design Engineer", field: "headline", expected: "Product and Design Engineer", operation: "rewrite" },
    { label: "introduction", instruction: "Change my introduction to Design engineer focused on reliable products.", field: "intro", expected: "Design engineer focused on reliable products.", operation: "add" },
    { label: "email", instruction: "Update my email to zain@portfolio.dev", field: "contact.email", expected: "zain@portfolio.dev", operation: "rewrite" },
    { label: "phone", instruction: "Set my phone number to +44 7444 222 841", field: "contact.phone", expected: "+44 7444 222 841", operation: "add" },
    { label: "website", instruction: "Make https://zain.dev/work my portfolio website", field: "contact.website", expected: "https://zain.dev/work", operation: "rewrite" },
  ];

  for (const testCase of cases) {
    it(`preserves the exact requested ${testCase.label} and required operation without calling the model`, async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
      const result = await provider.adaptCv!(providerInput(testCase.instruction));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toMatchObject({ targetField: testCase.field, proposedContent: testCase.expected, operation: testCase.operation });
    });
  }

  it.each([
    ["Change my introduction: Product engineer focused on reliable systems. Do not change anything else.", "intro", "Product engineer focused on reliable systems."],
    ["Set my headline to Product Engineer, and leave every other field unchanged.", "headline", "Product Engineer"],
    ["Change my introduction to: Product engineer. Keep everything else unchanged.", "intro", "Product engineer."],
    ["Please use Product Engineer as my headline", "headline", "Product Engineer"],
  ])("removes instruction constraints from literal values", async (instruction, field, expected) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    const result = await provider.adaptCv!(providerInput(instruction));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ targetField: field, proposedContent: expected });
  });

  it("updates multiple exact personal fields without calling the model", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    const result = await provider.adaptCv!(providerInput("Change my name to Zain A. Ahmad and set my phone number to +44 7000 123456"));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.changes).toHaveLength(2);
    expect(result.changes.map((item) => [item.targetField, item.proposedContent])).toEqual([
      ["contact.phone", "+44 7000 123456"],
      ["name", "Zain A. Ahmad"],
    ]);
  });

  it("combines an exact user-supplied website with an evidence-backed entry rewrite", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse({
      intent: intent(["sagecare"]),
      changes: [change("sagecare", "Designed small website.")],
      matches: [], gaps: [], summary: "Two requested changes ready.",
    }));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    const result = await provider.adaptCv!(providerInput("Change my portfolio website to https://zain.dev and rewrite SageCare"));
    expect(result.changes).toHaveLength(2);
    expect(result.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetField: "contact.website", proposedContent: "https://zain.dev", provenance: expect.objectContaining({ kind: "user_instruction" }) }),
      expect.objectContaining({ targetSectionId: "sagecare", proposedContent: "Designed small website." }),
    ]));
  });

  it.each([
    "Change my name to Zain A. Ahmad and my phone number to +44 7000 123456",
    "Change my name to Zain A. Ahmad, phone number to +44 7000 123456",
  ])("updates shorthand multi-field instructions deterministically: %s", async (instruction) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    const result = await provider.adaptCv!(providerInput(instruction));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.changes.map((item) => [item.targetField, item.proposedContent])).toEqual([
      ["contact.phone", "+44 7000 123456"],
      ["name", "Zain A. Ahmad"],
    ]);
  });

  it.each([
    "My phone number should be +44 7000 123456 and my name should be Zain A. Ahmad",
    "Use +44 7000 123456 as my phone number and Zain A. Ahmad as my name",
    "Name: Zain A. Ahmad; phone: +44 7000 123456",
    "Change phone number to +44 7000 123456; name to Zain A. Ahmad",
  ])("parses common multi-field clause forms deterministically: %s", async (instruction) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    const result = await provider.adaptCv!(providerInput(instruction));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.changes.map((item) => [item.targetField, item.proposedContent])).toEqual([
      ["contact.phone", "+44 7000 123456"],
      ["name", "Zain A. Ahmad"],
    ]);
  });

  it.each([
    "Use Product Engineer for my headline",
    "Change my headline to Product Engineer; keep all other fields as-is",
  ])("parses common headline clause forms without trailing constraints: %s", async (instruction) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    const result = await provider.adaptCv!(providerInput(instruction));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ targetField: "headline", proposedContent: "Product Engineer" });
  });

  it("rejects a model that uses remove for an exact requested entry-field value", async () => {
    const output = {
      intent: intent(["sagecare"], { targetSectionField: "location", requestedValue: "London" }),
      changes: [change("sagecare", "London", [evidenceB], { operation: "remove", targetSectionField: "location", proposedTitle: "SageCare location" })],
      matches: [], gaps: [], summary: "Location ready.",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse(output));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(providerInput("Change the SageCare location to London"))).rejects.toThrow(/exact requested value and operation/);
  });

  it("preserves different exact values for different named entry fields", async () => {
    const content = baseCv();
    content.sections.push({ id: "krislite", evidenceType: "experience", groupTitle: "Professional Experience", title: "Krislite", subtitle: "Design Engineer Intern", content: "Designed a lighting system.", sourceEvidenceIds: [evidenceB] });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse({
      intent: intent(["sagecare", "krislite"], { targetSectionField: "location", requestedValue: null }),
      changes: [
        change("sagecare", "London", [evidenceB], { targetSectionField: "location", proposedTitle: "SageCare location" }),
        change("krislite", "Singapore", [evidenceB], { targetSectionField: "location", proposedTitle: "Krislite location" }),
      ],
      matches: [], gaps: [], summary: "Locations ready.",
    }));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    const result = await provider.adaptCv!(providerInput("Set SageCare location to London and Krislite location to Singapore", content));
    expect(result.changes.map((item) => [item.targetSectionId, item.proposedContent])).toEqual([
      ["sagecare", "London"],
      ["krislite", "Singapore"],
    ]);
  });
});

describe("resolved plan validation", () => {
  it("uses a separate complete coverage plan and rejects execution outside its trusted change targets", async () => {
    const output = {
      intent: intent(["police-role"]),
      changes: [change("sagecare", "Designed and delivered a small website for SageCare.")],
      matches: [], gaps: [], summary: "Rewrite ready.",
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(modelResponse(coverage({ "police-role": "change" })))
      .mockResolvedValueOnce(modelResponse(output));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(providerInput("Tailor my whole CV for this role"))).rejects.toThrow(/outside the resolved CV scope/);
  });

  it("repairs missing planning coverage before executing only trusted change targets", async () => {
    const incomplete = coverage({ sagecare: "change" });
    incomplete.coverage = incomplete.coverage.filter((item) => item.targetKey !== "intro");
    const execution = {
      intent: intent(["sagecare"]),
      changes: [change("sagecare", "Designed and delivered a small website for SageCare.")],
      matches: [], gaps: [], summary: "Rewrite ready.",
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(modelResponse(incomplete))
      .mockResolvedValueOnce(modelResponse({ interpretation: "Missing target repaired.", coverage: [{ targetKey: "intro", decision: "keep", rationale: "No introduction requested." }] }))
      .mockResolvedValueOnce(modelResponse(execution));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    const result = await provider.adaptCv!(providerInput("Tailor my whole CV for this role"));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.changes.map((item) => item.targetSectionId)).toEqual(["sagecare"]);
  });

  it("fails closed when planning repair still omits an eligible target", async () => {
    const incomplete = coverage({ sagecare: "change" });
    incomplete.coverage = incomplete.coverage.filter((item) => item.targetKey !== "intro");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(modelResponse(incomplete))
      .mockResolvedValueOnce(modelResponse({ interpretation: "Bad repair.", coverage: [{ targetKey: "headline", decision: "keep", rationale: "Duplicate unrelated target." }] }));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(providerInput("Tailor my whole CV for this role"))).rejects.toThrow(/complete CV planning coverage/);
  });

  it("repairs a planned change target omitted by the execution model", async () => {
    const firstExecution = {
      intent: intent(["police-role", "sagecare"]),
      changes: [change("police-role", "Led operational incident teams of four officers.", [evidenceA])],
      matches: [], gaps: [], summary: "Partial first execution.",
    };
    const repairedExecution = {
      intent: intent(["sagecare"]),
      changes: [change("sagecare", "Designed and delivered a small website for SageCare.")],
      matches: [], gaps: [], summary: "Missing target repaired.",
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(modelResponse(coverage({ "police-role": "change", sagecare: "change" })))
      .mockResolvedValueOnce(modelResponse(firstExecution))
      .mockResolvedValueOnce(modelResponse(repairedExecution));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    const result = await provider.adaptCv!(providerInput("Tailor my whole CV for this role"));
    expect(result.changes.map((item) => item.targetSectionId)).toEqual(["police-role", "sagecare"]);
  });

  it("fails without returning a partial proposal when execution repair omits the target again", async () => {
    const partial = {
      intent: intent(["police-role", "sagecare"]),
      changes: [change("police-role", "Led operational incident teams of four officers.", [evidenceA])],
      matches: [], gaps: [], summary: "Partial execution.",
    };
    const emptyRepair = { intent: intent(["sagecare"]), changes: [], matches: [], gaps: [], summary: "No repair." };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(modelResponse(coverage({ "police-role": "change", sagecare: "change" })))
      .mockResolvedValueOnce(modelResponse(partial))
      .mockResolvedValueOnce(modelResponse(emptyRepair));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    await expect(provider.adaptCv!(providerInput("Tailor my whole CV for this role"))).rejects.toThrow(/No partial multi-entry change was applied/);
  });

  it("validates generic all-except scope and protects the excluded entry", async () => {
    const output = {
      intent: intent(["police-role", "police-award"], { excludedSectionIds: ["sagecare"] }),
      changes: [
        change("police-role", "Led operational incident teams of four officers.", [evidenceA]),
        change("police-award", "Earned three Commander Awards.", [evidenceA], { proposedEvidenceType: "achievement", proposedTitle: "Singapore Police Force Commander Awards" }),
      ],
      matches: [], gaps: [], summary: "Two concise rewrites.",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(modelResponse(output));
    const provider = createOpenAiProvider({ apiKey: "test", model: "test" });
    const result = await provider.adaptCv!(providerInput("Make every entry more concise except SageCare"));
    expect(result.changes.map((item) => item.targetSectionId)).toEqual(["police-role", "police-award"]);
    expect(result.tailoredContent.sections.find((item) => item.id === "sagecare")?.content).toBe("Designed a small website.");
  });
});
