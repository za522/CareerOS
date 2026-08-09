import { z } from "zod";

export const applicationStatuses = [
  "Saved",
  "Reviewing",
  "Ready to Apply",
  "Applied",
  "Assessment",
  "Interview",
  "Final Round",
  "Offer",
  "Accepted",
  "Rejected",
  "Withdrawn",
  "Archived",
] as const;

export const applicationEventTypes = [
  "posting_saved",
  "application_started",
  "application_submitted",
  "recruiter_response",
  "online_assessment_received",
  "assessment_completed",
  "interview_scheduled",
  "interview_completed",
  "next_round_received",
  "final_round_reached",
  "offer_received",
  "offer_accepted",
  "offer_declined",
  "rejection_received",
  "application_withdrawn",
  "follow_up_sent",
] as const;

export const importRunStates = [
  "Created",
  "Fetching",
  "Extracting",
  "Needs Review",
  "Committed",
  "Blocked",
  "Failed",
] as const;

export const sourceTypes = ["url", "pasted_text", "manual", "spreadsheet"] as const;

export const captureQueueStates = ["Queued", "Extracting", "Needs Review", "Duplicate", "Blocked", "Failed", "Saved"] as const;

export const captureQueueInputSchema = z.object({
  sourceType: z.enum(["url", "pasted_text"]),
  url: z.string().url().max(2_000).optional(),
  text: z.string().max(100_000).optional(),
  applyUrl: z.string().url().max(2_000).optional(),
}).refine((input) => input.sourceType === "url" ? Boolean(input.url) : Boolean(input.text?.trim()), {
  message: "Provide a public URL or pasted job text.",
});

export const captureQueueBatchSchema = z.object({
  items: z.array(captureQueueInputSchema).min(1).max(100),
});

export const captureDraftSaveSchema = z.object({
  sourceType: z.enum(["url", "pasted_text"]),
  value: z.string().max(100_000),
  expectedRevision: z.number().int().positive().optional(),
});

export const discoverySourceKinds = ["greenhouse", "lever", "optiver", "public_page"] as const;
export const discoveryAvailabilityStates = ["Open", "Removed", "Expired", "Blocked", "Unknown"] as const;

export const discoverySourceCreateSchema = z.object({
  name: z.string().trim().min(1).max(180),
  kind: z.enum(discoverySourceKinds),
  companyName: z.string().trim().min(1).max(180),
  sourceUrl: z.string().url().max(2_000),
  externalKey: z.string().trim().max(300).default(""),
  enabled: z.boolean().default(true),
  checkIntervalMinutes: z.number().int().min(15).max(10_080).default(180),
});

export const alertRuleCreateSchema = z.object({
  name: z.string().trim().min(1).max(180),
  enabled: z.boolean().default(true),
  companies: z.array(z.string().trim().min(1).max(180)).max(100).default([]),
  side: z.enum(["buy_side", "sell_side", "either"]).default("either"),
  roleFamilies: z.array(z.string().trim().min(1).max(180)).max(100).default([]),
  programmes: z.array(z.string().trim().min(1).max(180)).max(100).default([]),
  locations: z.array(z.string().trim().min(1).max(180)).max(100).default([]),
  keywords: z.array(z.string().trim().min(1).max(180)).max(100).default([]),
  newWithinHours: z.number().int().min(1).max(720).default(24),
  telegramEnabled: z.boolean().default(true),
});

export const discoveryQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  q: z.string().trim().max(200).optional(),
  side: z.enum(["buy_side", "sell_side", "unknown"]).optional(),
  programme: z.string().trim().max(100).optional(),
  careerTrack: z.string().trim().max(120).optional(),
  location: z.string().trim().max(180).optional(),
  sector: z.string().trim().max(120).optional(),
  firmType: z.string().trim().max(120).optional(),
  roleFamily: z.string().trim().max(120).optional(),
  workMode: z.string().trim().max(80).optional(),
  sponsorship: z.string().trim().max(80).optional(),
  tracked: z.enum(["saved", "unsaved"]).optional(),
  freshWithinHours: z.coerce.number().int().min(1).max(720).optional(),
  deadlineSoon: z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).optional(),
  showHidden: z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]).optional(),
});

export const alertRuleUpdateSchema = alertRuleCreateSchema.partial().extend({
  expectedRevision: z.number().int().positive().optional(),
});

export const telegramSettingsUpdateSchema = z.object({
  botToken: z.string().trim().min(20).max(500),
  chatId: z.string().trim().min(1).max(120),
});

export const discoveryIssueCreateSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
});

export const importInputSchema = z.object({
  sourceType: z.enum(sourceTypes),
  url: z.string().url().optional(),
  text: z.string().max(100_000).optional(),
  applyUrl: z.string().url().optional(),
});

export const jobDraftSchema = z.object({
  title: z.string().min(1),
  companyName: z.string().min(1),
  companySnapshot: z.string().default(""),
  companyDescription: z.string().default(""),
  location: z.string().default(""),
  country: z.string().default(""),
  region: z.string().default(""),
  workMode: z.string().default(""),
  employmentType: z.string().default(""),
  seniority: z.string().default(""),
  sector: z.string().default(""),
  roleFamily: z.string().default(""),
  division: z.string().default(""),
  team: z.string().default(""),
  summary: z.string().default(""),
  description: z.string().default(""),
  requiredRequirements: z.array(z.string()).default([]),
  preferredRequirements: z.array(z.string()).default([]),
  processSummary: z.string().default(""),
  visaRequirements: z.string().default(""),
  requisitionId: z.string().default(""),
  sourceUrl: z.string().default(""),
  applyUrl: z.string().default(""),
  referralSource: z.string().default(""),
  recruiterContact: z.string().default(""),
  applicationDeadline: z.string().default(""),
  postingDate: z.string().default(""),
  expiryDate: z.string().default(""),
  lastCheckedAt: z.string().default(""),
  postingState: z.string().default("Active"),
});

export const captureDuplicateActionSchema = z.enum(["create_anyway", "link_existing"]);
export const captureCommitSchema = z.object({
  draft: jobDraftSchema,
  duplicateAction: captureDuplicateActionSchema.optional(),
  existingJobPostingId: z.string().uuid().optional(),
});
export const captureBatchCommitSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    draft: jobDraftSchema.optional(),
    duplicateAction: captureDuplicateActionSchema.optional(),
    existingJobPostingId: z.string().uuid().optional(),
  })).min(1).max(100),
});

export const eventSchema = z.object({
  type: z.enum(applicationEventTypes),
  occurredAt: z.string().datetime().optional(),
  note: z.string().max(5_000).default(""),
});

export const jobUpdateSchema = jobDraftSchema.partial().extend({
  companyId: z.string().uuid().optional(),
  notes: z.string().max(10_000).optional(),
  expectedRevision: z.number().int().positive().optional(),
});

export const applicationCreateSchema = z.object({
  jobPostingId: z.string().uuid(),
  priority: z.enum(["Low", "Medium", "High"]).default("Medium"),
  notes: z.string().max(10_000).default(""),
});

export const taskTypes = ["follow_up", "deadline", "research", "preparation", "application"] as const;

export const taskCreateSchema = z.object({
  title: z.string().min(1).max(180),
  taskType: z.enum(taskTypes).default("follow_up"),
  priority: z.enum(["Low", "Medium", "High"]).default("Medium"),
  dueDate: z.string().nullable().optional(),
  notes: z.string().max(5_000).default(""),
});

export const taskUpdateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  completed: z.boolean().optional(),
  title: z.string().min(1).max(180).optional(),
  priority: z.enum(["Low", "Medium", "High"]).optional(),
  dueDate: z.string().nullable().optional(),
  notes: z.string().max(5_000).optional(),
});

export const salaryEstimateTypes = ["employer", "researched", "ai_assisted", "manual"] as const;

export const salaryEstimateCreateSchema = z.object({
  estimateType: z.enum(salaryEstimateTypes).default("manual"),
  minAmount: z.number().nonnegative().nullable().optional(),
  maxAmount: z.number().nonnegative().nullable().optional(),
  baseMinAmount: z.number().nonnegative().nullable().optional(),
  baseMaxAmount: z.number().nonnegative().nullable().optional(),
  totalCompMinAmount: z.number().nonnegative().nullable().optional(),
  totalCompMaxAmount: z.number().nonnegative().nullable().optional(),
  currency: z.string().trim().min(1).max(8).default("GBP"),
  paymentPeriod: z.enum(["annual", "monthly", "weekly", "daily", "hourly"]).default("annual"),
  baseSalary: z.number().nonnegative().nullable().optional(),
  bonus: z.number().nonnegative().nullable().optional(),
  equity: z.string().max(1_000).default(""),
  otherCompensation: z.string().max(1_000).default(""),
  country: z.string().max(120).default(""),
  region: z.string().max(160).default(""),
  seniorityAssumptions: z.string().max(1_000).default(""),
  sourceName: z.string().max(180).default(""),
  sourceUrl: z.string().max(2_000).default(""),
  evidenceExcerpt: z.string().max(3_000).default(""),
  sourceDate: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0),
  annualisedEquivalent: z.number().nonnegative().nullable().optional(),
  normalisedCurrency: z.string().max(8).default(""),
  exchangeRateDate: z.string().default(""),
  researchNotes: z.string().max(5_000).default(""),
});

export const salaryResearchEvidenceSchema = z.object({
  sourceName: z.string().min(1).max(180),
  sourceUrl: z.string().url().max(2_000),
  sourceDate: z.string().max(80).default(""),
  roleTitle: z.string().max(180).default(""),
  location: z.string().max(180).default(""),
  seniority: z.string().max(120).default(""),
  compensationScope: z.enum(["base", "total", "mixed", "unknown"]).default("unknown"),
  minAmount: z.number().nonnegative().nullable(),
  maxAmount: z.number().nonnegative().nullable(),
  currency: z.string().trim().min(1).max(8),
  paymentPeriod: z.enum(["annual", "monthly", "weekly", "daily", "hourly"]),
  excerpt: z.string().min(1).max(1_200),
  confidence: z.number().min(0).max(1),
});

export const salaryResearchProposalSchema = z.object({
  jobPostingId: z.string().uuid(),
  inferredRoleTitle: z.string().max(180).default(""),
  inferredLevel: z.string().max(120).default(""),
  estimate: salaryEstimateCreateSchema.extend({ estimateType: z.literal("ai_assisted") }),
  evidence: z.array(salaryResearchEvidenceSchema).min(1).max(20),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2_500),
  warnings: z.array(z.string().max(500)).max(10).default([]),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  researchedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
});

export const profileSectionTypes = [
  "education",
  "experience",
  "project",
  "skill",
  "achievement",
  "preference",
  "other",
] as const;

export const profileSectionInputSchema = z.object({
  id: z.string().uuid().optional(),
  evidenceType: z.enum(profileSectionTypes).default("other"),
  title: z.string().min(1).max(160),
  content: z.string().max(5_000).default(""),
});

export const profileUpdateSchema = z.object({
  name: z.string().max(160).default(""),
  headline: z.string().max(220).default(""),
  summary: z.string().max(2_500).default(""),
  sections: z.array(profileSectionInputSchema).max(80).default([]),
  expectedRevision: z.number().int().positive().optional(),
});

export const profileDocumentTypes = ["cv", "portfolio", "cover_letter", "application_answer", "other"] as const;

export const profileDocumentImportInputSchema = z.object({
  sourceType: z.enum(["file", "pasted_text"]),
  documentType: z.enum(profileDocumentTypes).default("cv"),
  title: z.string().max(180).default(""),
  fileName: z.string().max(240).optional(),
  mimeType: z.string().max(160).default("text/plain"),
  dataBase64: z.string().max(14_000_000).optional(),
  text: z.string().max(180_000).optional(),
}).refine((input) => input.sourceType === "file" ? Boolean(input.fileName && input.dataBase64) : Boolean(input.text?.trim()), {
  message: "Provide a file or pasted profile text.",
});

export const profileImportProfilePatchSchema = z.object({
  name: z.string().max(160).default(""),
  headline: z.string().max(220).default(""),
  summary: z.string().max(2_500).default(""),
});

export const profileImportSectionSchema = profileSectionInputSchema.omit({ id: true }).extend({
  sourceExcerpt: z.string().max(1_200).default(""),
  confidence: z.number().min(0).max(1).default(0.5),
});

export const profileDocumentImportCommitSchema = z.object({
  documentId: z.string().uuid().optional(),
  sourceDocumentId: z.string().uuid().optional(),
  expectedRevision: z.number().int().positive().optional(),
  profilePatch: profileImportProfilePatchSchema.default({}),
  sections: z.array(profileImportSectionSchema).max(80).default([]),
});

export const cvDocumentSectionSchema = z.object({
  id: z.string().min(1).max(120),
  evidenceType: z.enum(profileSectionTypes).default("other"),
  groupTitle: z.string().max(180).optional(),
  title: z.string().min(1).max(180),
  subtitle: z.string().max(220).optional(),
  date: z.string().max(100).optional(),
  location: z.string().max(180).optional(),
  spacingBefore: z.number().min(0).max(24).optional(),
  content: z.string().max(5_000),
  sourceEvidenceIds: z.array(z.string().uuid()).max(20).default([]),
});

export const cvInlineFormatMarkSchema = z.object({
  field: z.string().min(1).max(260),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
}).refine((mark) => mark.end > mark.start, "Formatted text range must not be empty.");

export const cvDocumentContentSchema = z.object({
  name: z.string().max(160).default(""),
  headline: z.string().max(220).default(""),
  intro: z.string().max(1_200).optional(),
  contact: z.object({
    email: z.string().max(180).default(""),
    phone: z.string().max(100).default(""),
    website: z.string().max(300).default(""),
  }).optional(),
  style: z.object({
    fontFamily: z.enum(["manrope", "inter", "georgia", "cambria"]).default("manrope"),
    fontSize: z.number().min(9).max(12).default(10.5),
    sectionSpacing: z.number().min(0).max(24).default(12),
    entrySpacing: z.number().min(0).max(16).default(3),
    headerSpacing: z.number().min(0).max(16).default(4),
    lineHeight: z.number().min(1.1).max(1.8).default(1.38),
    nameAlignment: z.enum(["left", "center"]).default("center"),
  }).optional(),
  inlineFormatting: z.array(cvInlineFormatMarkSchema).max(2_000).optional(),
  sections: z.array(cvDocumentSectionSchema).max(40).default([]),
}).superRefine((content, context) => {
  const fields = new Map<string, string>([
    ["name", content.name],
    ["headline", content.headline],
    ["intro", content.intro ?? ""],
    ["contact.email", content.contact?.email ?? ""],
    ["contact.phone", content.contact?.phone ?? ""],
    ["contact.website", content.contact?.website ?? ""],
  ]);
  for (const section of content.sections) {
    fields.set(`section:${section.id}:title`, section.title);
    fields.set(`section:${section.id}:subtitle`, section.subtitle ?? "");
    fields.set(`section:${section.id}:date`, section.date ?? "");
    fields.set(`section:${section.id}:location`, section.location ?? "");
    fields.set(`section:${section.id}:content`, section.content);
  }
  for (const [index, mark] of (content.inlineFormatting ?? []).entries()) {
    const value = fields.get(mark.field);
    if (value === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["inlineFormatting", index, "field"], message: "Formatted text must reference an existing CV field." });
    } else if (mark.end > value.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["inlineFormatting", index, "end"], message: "Formatted text range exceeds the referenced CV field." });
    }
  }
});

export const cvTailoringRequestSchema = z.object({
  documentId: z.string().uuid(),
  instructions: z.string().max(2_000).default(""),
  baseContent: cvDocumentContentSchema.optional(),
});

export const cvTargetFields = ["name", "headline", "intro", "contact.email", "contact.phone", "contact.website"] as const;
export const cvSectionTargetFields = ["title", "subtitle", "date", "location", "content"] as const;

export const cvChangeProposalSchema = z.object({
  id: z.string().uuid(),
  changeKey: z.string().min(1).max(80),
  operation: z.enum(["rewrite", "add", "remove", "reorder"]),
  targetField: z.enum(cvTargetFields).nullable().optional(),
  targetSectionField: z.enum(cvSectionTargetFields).nullable().optional(),
  targetSectionId: z.string().max(120).nullable(),
  proposedPosition: z.number().int().nonnegative().nullable(),
  originalTitle: z.string().max(180),
  originalContent: z.string().max(5_000),
  proposedEvidenceType: z.enum(profileSectionTypes),
  proposedTitle: z.string().max(180),
  proposedContent: z.string().max(5_000),
  rationale: z.string().min(1).max(1_000),
  evidenceIds: z.array(z.string().uuid()).max(20),
  provenance: z.object({
    kind: z.enum(["user_instruction"]),
    excerpt: z.string().trim().min(1).max(2_000),
  }).optional(),
  confidence: z.number().min(0).max(1),
});

export const cvMatchItemSchema = z.object({
  requirement: z.string().min(1).max(1_000),
  evidenceIds: z.array(z.string().uuid()).max(20),
  note: z.string().max(1_000),
  confidence: z.number().min(0).max(1),
});

export const cvTailoringProposalSchema = z.object({
  jobPostingId: z.string().uuid(),
  documentId: z.string().uuid(),
  baseVersionId: z.string().uuid().nullable(),
  baseContent: cvDocumentContentSchema,
  tailoredContent: cvDocumentContentSchema,
  changes: z.array(cvChangeProposalSchema).max(40),
  matches: z.array(cvMatchItemSchema).max(40),
  gaps: z.array(z.string().max(1_000)).max(30),
  summary: z.string().max(2_000),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  generatedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
});

export const cvProposalTurnSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string().trim().min(1).max(4_000),
  proposal: cvTailoringProposalSchema,
  decisions: z.record(z.string().uuid(), z.enum(["accepted", "rejected", "conflict"])),
});

export const cvProposalStateSchema = z.object({
  turns: z.array(cvProposalTurnSchema).max(30).default([]),
  activeTurnId: z.string().uuid().nullable().default(null),
});

export const documentVersionCreateSchema = z.object({
  documentId: z.string().uuid(),
  parentVersionId: z.string().uuid().nullable().default(null),
  expectedDraftRevision: z.number().int().positive().nullable().default(null),
  checkpointName: z.string().trim().min(1).max(120),
  content: cvDocumentContentSchema,
  acceptedChangeIds: z.array(z.string().uuid()).max(40).default([]),
  proposalChanges: z.array(cvChangeProposalSchema).max(40).default([]),
  proposalDecisions: z.record(z.string().uuid(), z.enum(["accepted", "rejected", "conflict"])).default({}),
  changeSummary: z.string().max(2_000).default(""),
  provider: z.string().max(80).default("manual"),
  model: z.string().max(120).default(""),
});

export const documentVersionPdfExportSchema = z.object({
  pageSectionIds: z.array(z.array(z.string().min(1).max(120)).min(1).max(80)).min(1).max(10),
  markAsSubmitted: z.boolean().default(false),
  applicationId: z.string().uuid().nullable().optional(),
}).superRefine((value, context) => {
  if (value.markAsSubmitted && !value.applicationId) context.addIssue({ code: "custom", path: ["applicationId"], message: "Choose the application that received this PDF." });
});

export const cvDraftSaveSchema = z.object({
  documentId: z.string().uuid(),
  content: cvDocumentContentSchema,
  proposalState: cvProposalStateSchema.default({ turns: [], activeTurnId: null }),
  expectedRevision: z.number().int().positive().nullable().default(null),
});

export const openAiKeySaveSchema = z.object({
  apiKey: z.string().trim().min(20, "Enter a complete OpenAI API key.").max(500).refine((value) => value.startsWith("sk-"), "Enter an OpenAI API key beginning with sk-."),
});

export type ApplicationStatus = (typeof applicationStatuses)[number];
export type ApplicationEventType = (typeof applicationEventTypes)[number];
export type ImportRunState = (typeof importRunStates)[number];
export type ImportInput = z.infer<typeof importInputSchema>;
export type CaptureQueueState = (typeof captureQueueStates)[number];
export type CaptureQueueInput = z.infer<typeof captureQueueInputSchema>;
export type CaptureQueueBatchInput = z.infer<typeof captureQueueBatchSchema>;
export type CaptureDraftSaveInput = z.infer<typeof captureDraftSaveSchema>;
export type CaptureDuplicateAction = z.infer<typeof captureDuplicateActionSchema>;
export type CaptureCommitInput = z.infer<typeof captureCommitSchema>;
export type CaptureBatchCommitInput = z.infer<typeof captureBatchCommitSchema>;
export type DiscoverySourceKind = (typeof discoverySourceKinds)[number];
export type DiscoveryAvailability = (typeof discoveryAvailabilityStates)[number];
export type DiscoverySourceCreateInput = z.infer<typeof discoverySourceCreateSchema>;
export type AlertRuleCreateInput = z.infer<typeof alertRuleCreateSchema>;
export type AlertRuleUpdateInput = z.infer<typeof alertRuleUpdateSchema>;
export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;
export type DiscoveryIssueCreateInput = z.infer<typeof discoveryIssueCreateSchema>;
export type JobDraft = z.infer<typeof jobDraftSchema>;
export type ApplicationEventInput = z.infer<typeof eventSchema>;
export type TaskCreateInput = z.input<typeof taskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;
export type SalaryEstimateCreateInput = z.input<typeof salaryEstimateCreateSchema>;
export type SalaryResearchEvidence = z.infer<typeof salaryResearchEvidenceSchema>;
export type SalaryResearchProposal = z.infer<typeof salaryResearchProposalSchema>;
export type ProfileSectionType = (typeof profileSectionTypes)[number];
export type ProfileSectionInput = z.infer<typeof profileSectionInputSchema>;
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;
export type ProfileDocumentType = (typeof profileDocumentTypes)[number];
export type ProfileDocumentImportInput = z.infer<typeof profileDocumentImportInputSchema>;
export type ProfileImportProfilePatch = z.infer<typeof profileImportProfilePatchSchema>;
export type ProfileImportSection = z.infer<typeof profileImportSectionSchema>;
export type ProfileDocumentImportCommitInput = z.infer<typeof profileDocumentImportCommitSchema>;
export type CvDocumentSection = z.infer<typeof cvDocumentSectionSchema>;
export type CvInlineFormatMark = z.infer<typeof cvInlineFormatMarkSchema>;
export type CvDocumentContent = z.infer<typeof cvDocumentContentSchema>;
export type CvTargetField = (typeof cvTargetFields)[number];
export type CvSectionTargetField = (typeof cvSectionTargetFields)[number];
export type CvTailoringRequest = z.infer<typeof cvTailoringRequestSchema>;
export type CvChangeProposal = z.infer<typeof cvChangeProposalSchema>;
export type CvTailoringProposal = z.infer<typeof cvTailoringProposalSchema>;
export type CvProposalTurn = z.infer<typeof cvProposalTurnSchema>;
export type CvProposalState = z.infer<typeof cvProposalStateSchema>;
export type DocumentVersionCreateInput = z.infer<typeof documentVersionCreateSchema>;
export type DocumentVersionPdfExportInput = z.infer<typeof documentVersionPdfExportSchema>;
export type CvDraftSaveInput = z.infer<typeof cvDraftSaveSchema>;
export type OpenAiKeySaveInput = z.infer<typeof openAiKeySaveSchema>;

export type ImportReviewEvidence = {
  fieldPath: string;
  excerpt: string;
  confidence: number;
  method: "ai_generated" | "deterministic";
};

export type ImportEnrichment = {
  mode: "ai" | "deterministic";
  provider: string | null;
  model: string | null;
  warning: string | null;
  evidenceCount: number;
  aiRunId: string | null;
  durationMs: number;
  totalDurationMs: number;
};

export type AiRunRecord = {
  id: string;
  operation: "job_import" | "profile_import" | "salary_research" | "cv_tailoring";
  contextId: string;
  sourceType: string;
  state: "completed" | "fallback" | "skipped";
  provider: string;
  model: string;
  durationMs: number;
  totalDurationMs: number;
  evidenceCount: number;
  warning: string;
  createdAt: string;
};

export type JobRow = JobDraft & {
  id: string;
  companyId: string;
  visibleIndex: number;
  notes: string;
  applicationId: string | null;
  applicationStatus: ApplicationStatus | null;
  appliedAt: string | null;
  nextAction: string | null;
  salaryEstimateId: string | null;
  salaryEstimateType: z.output<typeof salaryEstimateCreateSchema>["estimateType"] | null;
  salaryMinAmount: number | null;
  salaryMaxAmount: number | null;
  salaryCurrency: string;
  salaryScope: "base" | "range" | "total" | null;
  salaryConfidence: number | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type ApplicationEvent = {
  id: string;
  applicationId: string;
  type: ApplicationEventType;
  statusAfter: ApplicationStatus;
  occurredAt: string;
  note: string;
  createdAt: string;
};

export type JobTask = z.infer<typeof taskCreateSchema> & {
  id: string;
  completed: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type SalaryEstimateRecord = z.infer<typeof salaryEstimateCreateSchema> & {
  id: string;
  jobPostingId: string;
  createdAt: string;
  updatedAt: string;
  evidence: SalaryResearchEvidence[];
};

export type JobEvidenceRecord = {
  id: string;
  fieldPath: string;
  excerpt: string;
  method: string;
  suggestedValue: string;
  confidence: number;
  userConfirmed: boolean;
  capturedAt: string;
};

export type SourceCheckResult = {
  ok: true;
  checkedAt: string;
  resolvedUrl: string;
  pageTitle: string;
};

export type JobDetail = JobRow & {
  company: {
    id: string;
    name: string;
    snapshot: string;
    description: string;
  };
  events: ApplicationEvent[];
  evidenceCount: number;
  tasks: JobTask[];
  salaries: SalaryEstimateRecord[];
  evidence: JobEvidenceRecord[];
};

export type ProfileSection = ProfileSectionInput & {
  id: string;
  profileId: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type ProfileRecord = {
  id: string;
  name: string;
  headline: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  sections: ProfileSection[];
};

export type ProfileDocumentRecord = {
  id: string;
  documentType: ProfileDocumentType;
  title: string;
  relativePath: string;
  checksum: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type DocumentVersionRecord = {
  id: string;
  documentId: string;
  jobPostingId: string | null;
  parentVersionId: string | null;
  version: number;
  relativePath: string;
  checksum: string;
  checkpointName: string;
  submittedAt: string | null;
  content: CvDocumentContent;
  plainText: string;
  acceptedChangeIds: string[];
  proposalChanges: CvChangeProposal[];
  proposalDecisions: Record<string, "accepted" | "rejected" | "conflict">;
  changeSummary: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type ApplicationStudioDocument = {
  document: ProfileDocumentRecord;
  sourceDocumentId: string | null;
  usable: boolean;
  qualityWarning: string | null;
  baseContent: CvDocumentContent;
  draftContent: CvDocumentContent | null;
  draftProposalState: CvProposalState;
  draftUpdatedAt: string | null;
  draftRevision: number | null;
  versions: DocumentVersionRecord[];
};

export type ApplicationStudioWorkspace = {
  job: JobDetail;
  profile: ProfileRecord;
  documents: ApplicationStudioDocument[];
};

export type CareerStudioRole = {
  jobPostingId: string;
  title: string;
  companyName: string;
  location: string;
  applicationStatus: string;
  latestVersion: DocumentVersionRecord | null;
  versionCount: number;
  baseDocumentId: string | null;
  baseDocumentTitle: string;
  draftUpdatedAt: string | null;
};

export type CareerStudioDocument = {
  document: ProfileDocumentRecord;
  versionCount: number;
  roleCount: number;
  latestUpdatedAt: string;
};

export type CareerStudioWorkspace = {
  profile: ProfileRecord;
  roles: CareerStudioRole[];
  documents: CareerStudioDocument[];
};

export type AiSettingsStatus = {
  configured: boolean;
  provider: string;
  model: string;
  source: "environment" | "keychain" | "none";
};

export type SystemServiceHealth = {
  capture: { active: number; needsReview: number; failed: number; blocked: number; lastError: string; lastErrorAt: string | null; lastSuccessfulAt: string | null };
  discovery: { enabledSources: number; unhealthySources: number; lastSuccessfulAt: string | null };
  notifications: { configured: boolean; pending: number; failed: number };
  collaboration: { hosted: boolean; realtimeEnabled: boolean };
  backups: { provider: "filesystem" | "supabase"; configured: boolean; running: boolean; lastSuccessfulAt: string | null; lastError: string };
};

export type ProfileDocumentPreview = {
  document: ProfileDocumentRecord;
  extractedText: string;
  extractionWarning: string | null;
};

export type ProfileDocumentImportResponse = {
  document: ProfileDocumentRecord | null;
  sourceDocumentId: string;
  extractedText: string;
  extractionWarning: string | null;
  enrichment: ImportEnrichment;
  profilePatch: ProfileImportProfilePatch;
  sections: ProfileImportSection[];
  profileRevision: number;
};

export type ImportDraftResponse = {
  importRun: {
    id: string;
    state: ImportRunState;
    sourceType: string;
    sourceUrl: string | null;
    error: string | null;
  };
  draft: JobDraft;
  duplicates: Array<{ id: string; title: string; companyName: string; sourceUrl: string; queued?: boolean }>;
  enrichment?: ImportEnrichment;
  fieldEvidence?: ImportReviewEvidence[];
  sourceText?: string;
  discoveryPostingId?: string;
};

export type CaptureQueueItem = {
  id: string;
  sourceType: "url" | "pasted_text";
  sourceUrl: string;
  applyUrl: string;
  textPreview: string;
  sourceText: string | null;
  state: CaptureQueueState;
  progress: number;
  progressMessage: string | null;
  attemptCount: number;
  importRunId: string | null;
  draft: JobDraft | null;
  duplicates: ImportDraftResponse["duplicates"];
  enrichment: ImportEnrichment | null;
  fieldEvidence: ImportReviewEvidence[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  revision: number;
};

export type CaptureQueueSummary = {
  total: number;
  active: number;
  counts: Record<CaptureQueueState, number>;
};

export type CaptureDraftRecord = CaptureDraftSaveInput & {
  id: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type CaptureBatchConflict = {
  id: string;
  error: string;
  duplicates: ImportDraftResponse["duplicates"];
};

export type DiscoverySourceRecord = DiscoverySourceCreateInput & {
  id: string;
  lastCheckedAt: string | null;
  lastSuccessfulAt: string | null;
  lastError: string;
  successfulInventoryCount: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type DiscoveryRunRecord = {
  id: string;
  sourceId: string;
  state: "Running" | "Completed" | "Partial" | "Failed";
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  foundCount: number;
  newCount: number;
  changedCount: number;
  missingCount: number;
  error: string;
};

export type DiscoveredPostingRecord = {
  id: string;
  sourceId: string;
  externalId: string;
  canonicalUrl: string;
  applyUrl: string;
  companyName: string;
  title: string;
  location: string;
  programme: string;
  sector: string;
  firmType: string;
  roleFamily: string;
  careerTrack: string;
  workMode: string;
  sponsorship: string;
  side: "buy_side" | "sell_side" | "unknown";
  description: string;
  sourcePostedAt: string | null;
  sourceUpdatedAt: string | null;
  deadlineAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCheckedAt: string;
  removedAt: string | null;
  availability: DiscoveryAvailability;
  missingCount: number;
  contentHash: string;
  savedJobPostingId: string | null;
  hiddenAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type AlertRuleRecord = AlertRuleCreateInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type AlertEventRecord = {
  id: string;
  ruleId: string | null;
  discoveredPostingId: string | null;
  eventType: "new_match" | "posting_changed" | "deadline_soon" | "test";
  title: string;
  body: string;
  directUrl: string;
  deduplicationKey: string;
  readAt: string | null;
  createdAt: string;
  deliveries: NotificationDeliveryRecord[];
};

export type NotificationDeliveryRecord = {
  id: string;
  alertEventId: string;
  provider: "telegram" | "in_app";
  state: "Pending" | "Sending" | "Delivered" | "Failed" | "Ambiguous" | "ConfigurationRequired";
  attemptCount: number;
  lastError: string;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
  attempts: NotificationDeliveryAttemptRecord[];
};

export type NotificationDeliveryAttemptRecord = {
  id: string;
  deliveryId: string;
  sequence: number;
  state: "Started" | "Delivered" | "Failed" | "Ambiguous" | "ConfigurationRequired";
  error: string;
  providerMessageId: string;
  retryAfterAt: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type NotificationDeliveryHistoryItem = NotificationDeliveryRecord & {
  alertTitle: string;
  directUrl: string;
  alertCreatedAt: string;
};

export type NotificationDeliveryHistoryPage = {
  items: NotificationDeliveryHistoryItem[];
  nextCursor: string | null;
};

export type TelegramSettingsStatus = {
  hosted: boolean;
  configured: boolean;
  chatIdHint: string;
  lastTestedAt: string | null;
  lastSuccessfulTestAt: string | null;
  lastError: string;
  updatedAt: string | null;
};

export type TelegramSettingsUpdateInput = z.infer<typeof telegramSettingsUpdateSchema>;

export type DiscoveryWorkspace = {
  postings: DiscoveredPostingRecord[];
  sources: DiscoverySourceRecord[];
  latestRuns: DiscoveryRunRecord[];
  alertRules: AlertRuleRecord[];
  alerts: AlertEventRecord[];
  postingTotal: number;
  openPostingTotal: number;
  nextCursor: string | null;
};

export type WorkspaceSessionRecord = {
  hosted: boolean;
  user: { id: string; memberId: string; email?: string; provider: "supabase" | "local-development" };
  workspace: { id: string; name: string; role: "owner" | "editor" | "viewer" };
  members: Array<{ id: string; email: string; displayName: string; avatarUrl: string; role: "owner" | "editor" | "viewer"; joinedAt: string }>;
};

export type WorkspaceInvitationRecord = {
  id: string;
  email: string;
  role: "editor" | "viewer";
  expiresAt: string;
  createdAt: string;
};

export type WorkspaceCommentRecord = {
  id: string;
  entityType: string;
  entityId: string;
  targetPath: string;
  body: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  authorId: string;
  authorEmail: string;
  authorName: string;
  authorAvatarUrl: string;
};

export type WorkspaceAuditEventRecord = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  actorEmail: string | null;
  actorName: string | null;
  createdAt: string;
};

export type CareerOSMeta = {
  sectors: string[];
  locations: string[];
  ai: { configured: boolean; provider: string; model: string };
};

export type CareerOSClient = {
  getMeta: () => Promise<CareerOSMeta>;
  getSystemHealth: () => Promise<SystemServiceHealth>;
  listJobs: (params?: Record<string, string>) => Promise<JobRow[]>;
  getJob: (id: string) => Promise<JobDetail>;
  getProfile: () => Promise<ProfileRecord>;
  updateProfile: (input: ProfileUpdateInput) => Promise<ProfileRecord>;
  createProfileDocumentImport: (input: ProfileDocumentImportInput) => Promise<ProfileDocumentImportResponse>;
  commitProfileDocumentImport: (input: ProfileDocumentImportCommitInput) => Promise<ProfileRecord>;
  getApplicationStudio: (jobPostingId: string) => Promise<ApplicationStudioWorkspace>;
  getCareerStudio: () => Promise<CareerStudioWorkspace>;
  getProfileDocumentPreview: (documentId: string) => Promise<ProfileDocumentPreview>;
  saveOpenAiKey: (input: OpenAiKeySaveInput) => Promise<AiSettingsStatus>;
  deleteOpenAiKey: () => Promise<AiSettingsStatus>;
  openTerminal: () => Promise<{ opened: true }>;
  saveCvDraft: (jobPostingId: string, input: CvDraftSaveInput) => Promise<{ updatedAt: string; revision: number }>;
  tailorCv: (jobPostingId: string, input: CvTailoringRequest) => Promise<CvTailoringProposal>;
  createDocumentVersion: (jobPostingId: string, input: DocumentVersionCreateInput) => Promise<DocumentVersionRecord>;
  exportDocumentVersionPdf: (versionId: string, input: DocumentVersionPdfExportInput) => Promise<DocumentVersionRecord>;
  createImport: (input: ImportInput) => Promise<ImportDraftResponse>;
  enqueueCaptures: (input: CaptureQueueBatchInput) => Promise<CaptureQueueItem[]>;
  listCaptureQueue: (params?: { limit?: number; cursor?: string; state?: CaptureQueueState }) => Promise<{ items: CaptureQueueItem[]; summary: CaptureQueueSummary; nextCursor: string | null }>;
  getCapture: (id: string) => Promise<CaptureQueueItem>;
  retryCapture: (id: string) => Promise<CaptureQueueItem>;
  cancelCapture: (id: string) => Promise<CaptureQueueItem>;
  listCaptureDrafts: () => Promise<CaptureDraftRecord[]>;
  saveCaptureDraft: (id: string, input: CaptureDraftSaveInput) => Promise<CaptureDraftRecord>;
  deleteCaptureDraft: (id: string, expectedRevision?: number) => Promise<void>;
  enqueueCaptureDraft: (id: string) => Promise<CaptureQueueItem[]>;
  commitCapture: (id: string, input: CaptureCommitInput) => Promise<JobRow>;
  commitCaptureBatch: (input: CaptureBatchCommitInput) => Promise<JobRow[]>;
  getDiscoveryWorkspace: (params?: Record<string, string>) => Promise<DiscoveryWorkspace>;
  runDiscovery: (sourceId?: string) => Promise<DiscoveryRunRecord[]>;
  saveDiscoveredPosting: (id: string) => Promise<ImportDraftResponse>;
  hideDiscoveredPosting: (id: string, hidden: boolean) => Promise<DiscoveredPostingRecord>;
  reportDiscoveredPosting: (id: string, input: DiscoveryIssueCreateInput) => Promise<{ id: string; createdAt: string }>;
  createDiscoverySource: (input: DiscoverySourceCreateInput) => Promise<DiscoverySourceRecord>;
  createAlertRule: (input: AlertRuleCreateInput) => Promise<AlertRuleRecord>;
  updateAlertRule: (id: string, input: AlertRuleUpdateInput) => Promise<AlertRuleRecord>;
  deleteAlertRule: (id: string, expectedRevision: number) => Promise<void>;
  markAlertRead: (id: string, read: boolean) => Promise<AlertEventRecord>;
  sendTestAlert: () => Promise<AlertEventRecord>;
  getTelegramSettings: () => Promise<TelegramSettingsStatus>;
  saveTelegramSettings: (input: TelegramSettingsUpdateInput) => Promise<TelegramSettingsStatus>;
  deleteTelegramSettings: () => Promise<TelegramSettingsStatus>;
  retryAlertDelivery: (deliveryId: string, confirmPossibleDuplicate?: boolean) => Promise<NotificationDeliveryHistoryItem>;
  listAlertDeliveries: (params?: { limit?: number; cursor?: string }) => Promise<NotificationDeliveryHistoryPage>;
  listAiRuns: (limit?: number) => Promise<AiRunRecord[]>;
  commitImport: (id: string, draft: JobDraft, duplicateDecision?: { action: "create_anyway" | "link_existing"; existingJobPostingId?: string }) => Promise<JobRow>;
  createApplication: (input: { jobPostingId: string; priority?: "Low" | "Medium" | "High"; notes?: string }) => Promise<JobDetail>;
  addEvent: (applicationId: string, input: ApplicationEventInput) => Promise<ApplicationEvent>;
  updateJob: (id: string, input: z.infer<typeof jobUpdateSchema>) => Promise<JobRow>;
  createTask: (jobPostingId: string, input: TaskCreateInput) => Promise<JobTask>;
  updateTask: (id: string, input: TaskUpdateInput) => Promise<JobTask>;
  createSalaryEstimate: (jobPostingId: string, input: SalaryEstimateCreateInput) => Promise<SalaryEstimateRecord>;
  researchSalary: (jobPostingId: string) => Promise<SalaryResearchProposal>;
  commitSalaryResearch: (jobPostingId: string, proposal: SalaryResearchProposal) => Promise<SalaryEstimateRecord>;
  recheckJobSource: (id: string) => Promise<SourceCheckResult>;
  exportBundle: () => Promise<unknown>;
  restoreBundle: (bundle: unknown) => Promise<{ accepted: true; restartRequired: boolean; message: string }>;
  getWorkspaceSession: () => Promise<WorkspaceSessionRecord>;
  createWorkspaceInvitation: (input: { email: string; role: "editor" | "viewer" }) => Promise<{ id: string; email: string; role: "editor" | "viewer"; token: string; expiresAt: string }>;
  listWorkspaceInvitations: () => Promise<WorkspaceInvitationRecord[]>;
  revokeWorkspaceInvitation: (id: string) => Promise<WorkspaceInvitationRecord[]>;
  updateWorkspaceMember: (userId: string, role: "editor" | "viewer") => Promise<WorkspaceSessionRecord["members"]>;
  removeWorkspaceMember: (userId: string) => Promise<WorkspaceSessionRecord["members"]>;
  listWorkspaceComments: (entityType: string, entityId: string) => Promise<WorkspaceCommentRecord[]>;
  createWorkspaceComment: (input: { entityType: string; entityId: string; targetPath: string; body: string }) => Promise<WorkspaceCommentRecord>;
  listWorkspaceAudit: (limit?: number) => Promise<WorkspaceAuditEventRecord[]>;
};

export const statusFromEvent: Record<ApplicationEventType, ApplicationStatus> = {
  posting_saved: "Saved",
  application_started: "Reviewing",
  application_submitted: "Applied",
  recruiter_response: "Interview",
  online_assessment_received: "Assessment",
  assessment_completed: "Assessment",
  interview_scheduled: "Interview",
  interview_completed: "Interview",
  next_round_received: "Final Round",
  final_round_reached: "Final Round",
  offer_received: "Offer",
  offer_accepted: "Accepted",
  offer_declined: "Rejected",
  rejection_received: "Rejected",
  application_withdrawn: "Withdrawn",
  follow_up_sent: "Applied",
};
