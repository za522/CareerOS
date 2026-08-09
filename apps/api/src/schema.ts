import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
  revision: integer("revision").notNull().default(1),
};

export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  snapshot: text("snapshot").notNull().default(""),
  description: text("description").notNull().default(""),
  ...timestamps,
});

export const jobPostings = sqliteTable("job_postings", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull(),
  title: text("title").notNull(),
  requisitionId: text("requisition_id").notNull().default(""),
  location: text("location").notNull().default(""),
  country: text("country").notNull().default(""),
  region: text("region").notNull().default(""),
  workMode: text("work_mode").notNull().default(""),
  employmentType: text("employment_type").notNull().default(""),
  seniority: text("seniority").notNull().default(""),
  sector: text("sector").notNull().default(""),
  roleFamily: text("role_family").notNull().default(""),
  division: text("division").notNull().default(""),
  team: text("team").notNull().default(""),
  summary: text("summary").notNull().default(""),
  description: text("description").notNull().default(""),
  requiredRequirements: text("required_requirements").notNull().default("[]"),
  preferredRequirements: text("preferred_requirements").notNull().default("[]"),
  processSummary: text("process_summary").notNull().default(""),
  visaRequirements: text("visa_requirements").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  applyUrl: text("apply_url").notNull().default(""),
  referralSource: text("referral_source").notNull().default(""),
  recruiterContact: text("recruiter_contact").notNull().default(""),
  applicationDeadline: text("application_deadline").notNull().default(""),
  postingDate: text("posting_date").notNull().default(""),
  expiryDate: text("expiry_date").notNull().default(""),
  lastCheckedAt: text("last_checked_at").notNull().default(""),
  postingState: text("posting_state").notNull().default("Active"),
  notes: text("notes").notNull().default(""),
  ...timestamps,
});

export const applications = sqliteTable("applications", {
  id: text("id").primaryKey(),
  jobPostingId: text("job_posting_id").notNull(),
  currentStatus: text("current_status").notNull().default("Saved"),
  appliedAt: text("applied_at"),
  priority: text("priority").notNull().default("Medium"),
  nextAction: text("next_action"),
  followUpDate: text("follow_up_date"),
  notes: text("notes").notNull().default(""),
  ...timestamps,
});

export const applicationEvents = sqliteTable("application_events", {
  id: text("id").primaryKey(),
  applicationId: text("application_id").notNull(),
  type: text("type").notNull(),
  statusAfter: text("status_after").notNull(),
  occurredAt: text("occurred_at").notNull(),
  note: text("note").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

export const sourceDocuments = sqliteTable("source_documents", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  url: text("url"),
  rawText: text("raw_text").notNull().default(""),
  contentHash: text("content_hash").notNull().default(""),
  capturedAt: text("captured_at").notNull(),
  metadata: text("metadata").notNull().default("{}"),
});

export const importRuns = sqliteTable("import_runs", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url"),
  state: text("state").notNull(),
  sourceDocumentId: text("source_document_id"),
  discoveryPostingId: text("discovery_posting_id"),
  error: text("error"),
  ...timestamps,
});

export const aiRuns = sqliteTable("ai_runs", {
  id: text("id").primaryKey(),
  operation: text("operation").notNull(),
  contextId: text("context_id").notNull(),
  sourceType: text("source_type").notNull(),
  state: text("state").notNull(),
  provider: text("provider").notNull().default(""),
  model: text("model").notNull().default(""),
  durationMs: integer("duration_ms").notNull().default(0),
  totalDurationMs: integer("total_duration_ms").notNull().default(0),
  evidenceCount: integer("evidence_count").notNull().default(0),
  warning: text("warning").notNull().default(""),
  ...timestamps,
});

export const fieldEvidence = sqliteTable("field_evidence", {
  id: text("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  fieldPath: text("field_path").notNull(),
  sourceDocumentId: text("source_document_id"),
  excerpt: text("excerpt").notNull().default(""),
  method: text("method").notNull(),
  suggestedValue: text("suggested_value").notNull().default(""),
  confidence: real("confidence").notNull().default(0),
  userConfirmed: integer("user_confirmed", { mode: "boolean" }).notNull().default(false),
  capturedAt: text("captured_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  taskType: text("task_type").notNull().default("follow_up"),
  priority: text("priority").notNull().default("Medium"),
  dueDate: text("due_date"),
  completedAt: text("completed_at"),
  notes: text("notes").notNull().default(""),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  ...timestamps,
});

export const salaryEstimates = sqliteTable("salary_estimates", {
  id: text("id").primaryKey(),
  jobPostingId: text("job_posting_id").notNull(),
  estimateType: text("estimate_type").notNull().default("manual"),
  minAmount: real("min_amount"),
  maxAmount: real("max_amount"),
  baseMinAmount: real("base_min_amount"),
  baseMaxAmount: real("base_max_amount"),
  totalCompMinAmount: real("total_comp_min_amount"),
  totalCompMaxAmount: real("total_comp_max_amount"),
  currency: text("currency").notNull().default(""),
  paymentPeriod: text("payment_period").notNull().default("annual"),
  baseSalary: real("base_salary"),
  bonus: real("bonus"),
  equity: text("equity").notNull().default(""),
  otherCompensation: text("other_compensation").notNull().default(""),
  country: text("country").notNull().default(""),
  region: text("region").notNull().default(""),
  seniorityAssumptions: text("seniority_assumptions").notNull().default(""),
  sourceName: text("source_name").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  evidenceExcerpt: text("evidence_excerpt").notNull().default(""),
  sourceDate: text("source_date").notNull().default(""),
  confidence: real("confidence").notNull().default(0),
  annualisedEquivalent: real("annualised_equivalent"),
  normalisedCurrency: text("normalised_currency").notNull().default(""),
  exchangeRateDate: text("exchange_rate_date").notNull().default(""),
  researchNotes: text("research_notes").notNull().default(""),
  ...timestamps,
});

export const salaryResearchEvidence = sqliteTable("salary_research_evidence", {
  id: text("id").primaryKey(),
  salaryEstimateId: text("salary_estimate_id").notNull(),
  sourceName: text("source_name").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceDate: text("source_date").notNull().default(""),
  roleTitle: text("role_title").notNull().default(""),
  location: text("location").notNull().default(""),
  seniority: text("seniority").notNull().default(""),
  compensationScope: text("compensation_scope").notNull().default("unknown"),
  minAmount: real("min_amount"),
  maxAmount: real("max_amount"),
  currency: text("currency").notNull(),
  paymentPeriod: text("payment_period").notNull().default("annual"),
  excerpt: text("excerpt").notNull(),
  confidence: real("confidence").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  headline: text("headline").notNull().default(""),
  summary: text("summary").notNull().default(""),
  ...timestamps,
});

export const profileEvidence = sqliteTable("profile_evidence", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull(),
  evidenceType: text("evidence_type").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull().default(""),
  ...timestamps,
});

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  documentType: text("document_type").notNull(),
  title: text("title").notNull(),
  relativePath: text("relative_path").notNull().default(""),
  checksum: text("checksum").notNull().default(""),
  mimeType: text("mime_type").notNull().default(""),
  sizeBytes: integer("size_bytes").notNull().default(0),
  ...timestamps,
});

export const documentVersions = sqliteTable("document_versions", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  jobPostingId: text("job_posting_id"),
  parentVersionId: text("parent_version_id"),
  version: integer("version").notNull(),
  relativePath: text("relative_path").notNull().default(""),
  checksum: text("checksum").notNull().default(""),
  checkpointName: text("checkpoint_name").notNull().default(""),
  submittedAt: text("submitted_at"),
  contentJson: text("content_json").notNull().default("{}"),
  plainText: text("plain_text").notNull().default(""),
  acceptedChangeIds: text("accepted_change_ids").notNull().default("[]"),
  proposalChanges: text("proposal_changes").notNull().default("[]"),
  proposalDecisions: text("proposal_decisions").notNull().default("{}"),
  changeSummary: text("change_summary").notNull().default(""),
  provider: text("provider").notNull().default("manual"),
  model: text("model").notNull().default(""),
  ...timestamps,
});

export const documentDrafts = sqliteTable("document_drafts", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  jobPostingId: text("job_posting_id").notNull(),
  contentJson: text("content_json").notNull().default("{}"),
  proposalStateJson: text("proposal_state_json").notNull().default('{"turns":[],"activeTurnId":null}'),
  ...timestamps,
});

export const applicationMaterials = sqliteTable("application_materials", {
  id: text("id").primaryKey(),
  applicationId: text("application_id").notNull(),
  documentId: text("document_id"),
  documentVersionId: text("document_version_id"),
  materialType: text("material_type").notNull(),
  title: text("title").notNull(),
  notes: text("notes").notNull().default(""),
  ...timestamps,
});

export const captureQueueItems = sqliteTable("capture_queue_items", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url").notNull().default(""),
  applyUrl: text("apply_url").notNull().default(""),
  rawText: text("raw_text").notNull().default(""),
  state: text("state").notNull().default("Queued"),
  progress: integer("progress").notNull().default(0),
  progressMessage: text("progress_message"),
  attemptCount: integer("attempt_count").notNull().default(0),
  importRunId: text("import_run_id"),
  draftJson: text("draft_json"),
  duplicatesJson: text("duplicates_json").notNull().default("[]"),
  enrichmentJson: text("enrichment_json"),
  error: text("error"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  ...timestamps,
});

export const captureDrafts = sqliteTable("capture_drafts", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  value: text("value").notNull().default(""),
  error: text("error"),
  ...timestamps,
});

export const discoverySources = sqliteTable("discovery_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  companyName: text("company_name").notNull(),
  sourceUrl: text("source_url").notNull(),
  externalKey: text("external_key").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  checkIntervalMinutes: integer("check_interval_minutes").notNull().default(180),
  lastCheckedAt: text("last_checked_at"),
  lastSuccessfulAt: text("last_successful_at"),
  lastError: text("last_error").notNull().default(""),
  successfulInventoryCount: integer("successful_inventory_count").notNull().default(0),
  leaseUntil: text("lease_until"),
  leaseToken: text("lease_token"),
  ...timestamps,
});

export const discoveryRuns = sqliteTable("discovery_runs", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  state: text("state").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  durationMs: integer("duration_ms").notNull().default(0),
  foundCount: integer("found_count").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  changedCount: integer("changed_count").notNull().default(0),
  missingCount: integer("missing_count").notNull().default(0),
  error: text("error").notNull().default(""),
});

export const discoveredPostings = sqliteTable("discovered_postings", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  externalId: text("external_id").notNull(),
  canonicalUrl: text("canonical_url").notNull(),
  applyUrl: text("apply_url").notNull(),
  companyName: text("company_name").notNull(),
  title: text("title").notNull(),
  location: text("location").notNull().default(""),
  programme: text("programme").notNull().default(""),
  sector: text("sector").notNull().default(""),
  firmType: text("firm_type").notNull().default(""),
  roleFamily: text("role_family").notNull().default(""),
  workMode: text("work_mode").notNull().default("Not stated"),
  sponsorship: text("sponsorship").notNull().default("Not stated"),
  side: text("side").notNull().default("unknown"),
  description: text("description").notNull().default(""),
  sourcePostedAt: text("source_posted_at"),
  deadlineAt: text("deadline_at"),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  lastCheckedAt: text("last_checked_at").notNull(),
  removedAt: text("removed_at"),
  availability: text("availability").notNull().default("Open"),
  missingCount: integer("missing_count").notNull().default(0),
  contentHash: text("content_hash").notNull().default(""),
  savedJobPostingId: text("saved_job_posting_id"),
  hiddenAt: text("hidden_at"),
  ...timestamps,
});

export const discoveryObservations = sqliteTable("discovery_observations", {
  id: text("id").primaryKey(),
  discoveredPostingId: text("discovered_posting_id").notNull(),
  discoveryRunId: text("discovery_run_id").notNull(),
  state: text("state").notNull(),
  contentHash: text("content_hash").notNull().default(""),
  note: text("note").notNull().default(""),
  observedAt: text("observed_at").notNull(),
});

export const discoveryPostingAliases = sqliteTable("discovery_posting_aliases", {
  sourceId: text("source_id").notNull(),
  externalId: text("external_id").notNull(),
  discoveredPostingId: text("discovered_posting_id").notNull(),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  lastCheckedAt: text("last_checked_at").notNull(),
  removedAt: text("removed_at"),
  availability: text("availability").notNull().default("Open"),
  missingCount: integer("missing_count").notNull().default(0),
  contentHash: text("content_hash").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

export const alertRules = sqliteTable("alert_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  criteriaJson: text("criteria_json").notNull().default("{}"),
  telegramEnabled: integer("telegram_enabled", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

export const alertEvents = sqliteTable("alert_events", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id"),
  discoveredPostingId: text("discovered_posting_id"),
  eventType: text("event_type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  directUrl: text("direct_url").notNull().default(""),
  deduplicationKey: text("deduplication_key").notNull(),
  readAt: text("read_at"),
  createdAt: text("created_at").notNull(),
});

export const notificationDeliveries = sqliteTable("notification_deliveries", {
  id: text("id").primaryKey(),
  alertEventId: text("alert_event_id").notNull(),
  provider: text("provider").notNull(),
  state: text("state").notNull().default("Pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  providerAttemptCount: integer("provider_attempt_count").notNull().default(0),
  lastError: text("last_error").notNull().default(""),
  providerMessageId: text("provider_message_id").notNull().default(""),
  nextAttemptAt: text("next_attempt_at"),
  claimToken: text("claim_token"),
  claimedUntil: text("claimed_until"),
  deliveredAt: text("delivered_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const notificationDeliveryAttempts = sqliteTable("notification_delivery_attempts", {
  id: text("id").primaryKey(),
  deliveryId: text("delivery_id").notNull(),
  sequence: integer("sequence").notNull(),
  state: text("state").notNull(),
  error: text("error").notNull().default(""),
  providerMessageId: text("provider_message_id").notNull().default(""),
  retryAfterAt: text("retry_after_at"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
});

export const searchIndex = sqliteTable("search_index", {
  entityId: text("entity_id").notNull(),
  entityType: text("entity_type").notNull(),
  content: text("content").notNull(),
});
