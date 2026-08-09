export type DiscoveryProvider = "greenhouse" | "lever" | "ashby" | (string & {});

export type SourceAdapter<TResponse = unknown> = {
  sourceId: string;
  provider: DiscoveryProvider;
  organization: string;
  fetch: () => Promise<TResponse>;
  parse: (response: TResponse, context: SourceContext) => SourceRole[];
};

export type SourceContext = {
  sourceId: string;
  provider: DiscoveryProvider;
  organization: string;
};

export type SourceRole = {
  externalId: string;
  title: string;
  location?: string;
  team?: string;
  employmentType?: string;
  description?: string;
  sourceUrl: string;
  applyUrl?: string;
  postedAt?: string | null;
  updatedAt?: string | null;
  deadlineAt?: string | null;
};

export type NormalizedRole = {
  sourceId: string;
  provider: DiscoveryProvider;
  externalId: string;
  organization: string;
  title: string;
  location: string;
  team: string;
  employmentType: string;
  description: string;
  sourceUrl: string;
  applyUrl: string;
  postedAt: string | null;
  deadlineAt: string | null;
  sourceKey: string;
  identityKey: string;
};

export type ObservationStatus = "open" | "missing" | "closed";

export type RoleObservation = NormalizedRole & {
  status: ObservationStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  missingRuns: number;
  closedAt: string | null;
};

export type SourceRunResult =
  | { sourceId: string; provider: DiscoveryProvider; ok: true; roles: SourceRole[] }
  | { sourceId: string; provider: DiscoveryProvider; ok: false; error: string };

export type SourceRunSummary = {
  sourceId: string;
  provider: DiscoveryProvider;
  status: "succeeded" | "failed";
  received: number;
  unique: number;
  error: string | null;
};

export type DiscoveryRunSummary = {
  startedAt: string;
  finishedAt: string;
  sources: SourceRunSummary[];
  sourceSucceeded: number;
  sourceFailed: number;
  received: number;
  unique: number;
  created: number;
  updated: number;
  unchanged: number;
  restored: number;
  markedMissing: number;
  closed: number;
};

export type DiscoveryRun = {
  observations: RoleObservation[];
  summary: DiscoveryRunSummary;
};

export type AlertRule = {
  id: string;
  enabled?: boolean;
  organizations?: string[];
  titleIncludes?: string[];
  titleExcludes?: string[];
  locations?: string[];
  teams?: string[];
  employmentTypes?: string[];
  remoteOnly?: boolean;
};

export type AlertMatch = { ruleId: string; role: NormalizedRole };

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`${label} must be a string or number.`);
  const result = String(value).trim();
  if (!result) throw new Error(`${label} cannot be empty.`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function publicHttpUrl(value: unknown, label: string): string {
  const raw = requiredString(value, label);
  try {
    const url = new URL(raw);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label} must be a public HTTP or HTTPS URL.`);
  }
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return optionalString((value as JsonObject)[key]);
}

function isoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function deadlineFrom(value: unknown, description?: string): string | null {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const validDate = (year: number, month: number, day: number) => {
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    const date = new Date(Date.UTC(year, month, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day
      ? date.toISOString()
      : null;
  };
  const parseDeadline = (candidate: unknown) => {
    if (typeof candidate !== "string") return isoDate(candidate);
    const text = candidate.trim().replace(/[.,;:]$/, "");
    const named = text.match(/^(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[a-z]*[\s,/-]+(\d{2,4})$/i);
    if (named) return validDate(Number(named[3]) < 100 ? 2000 + Number(named[3]) : Number(named[3]), months.indexOf(named[2].slice(0, 3).toLowerCase()), Number(named[1]));
    const monthFirst = text.match(/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[a-z]*\s+(\d{1,2})[\s,/-]+(\d{2,4})$/i);
    if (monthFirst) return validDate(Number(monthFirst[3]) < 100 ? 2000 + Number(monthFirst[3]) : Number(monthFirst[3]), months.indexOf(monthFirst[1].slice(0, 3).toLowerCase()), Number(monthFirst[2]));
    const numeric = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
    if (numeric) return validDate(Number(numeric[3]) < 100 ? 2000 + Number(numeric[3]) : Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]));
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return validDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return /^\d{4}-\d{2}-\d{2}T/.test(text) ? isoDate(text) : null;
  };
  const explicit = parseDeadline(value);
  if (explicit) return explicit;
  const text = cleanText(description);
  const month = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const match = text.match(new RegExp(`(?:deadline|closing date|apply by|applications?(?: will)? close(?:s|d)?(?: on)?)\\s*[:\\-]?\\s*((?:\\d{1,2}\\s+${month}|${month}\\s+\\d{1,2})[\\s,/-]+\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4})`, "i"));
  return match ? parseDeadline(match[1]) : null;
}

/** Parse the public Greenhouse Job Board API response (`{ jobs: [...] }`). */
export function parseGreenhouseResponse(response: unknown): SourceRole[] {
  const root = object(response, "Greenhouse response");
  return array(root.jobs, "Greenhouse jobs").map((value, index) => {
    const job = object(value, `Greenhouse job ${index}`);
    const sourceUrl = publicHttpUrl(job.absolute_url, `Greenhouse job ${index} absolute_url`);
    return {
      externalId: requiredString(job.id, `Greenhouse job ${index} id`),
      title: requiredString(job.title, `Greenhouse job ${index} title`),
      location: nestedString(job.location, "name"),
      team: Array.isArray(job.departments)
        ? job.departments.map((department) => nestedString(department, "name")).filter((name): name is string => Boolean(name)).join(", ") || undefined
        : undefined,
      description: optionalString(job.content),
      sourceUrl,
      applyUrl: sourceUrl,
      postedAt: isoDate(job.first_published) ?? isoDate(job.created_at),
      updatedAt: isoDate(job.updated_at),
      deadlineAt: deadlineFrom(job.deadline ?? job.application_deadline ?? job.closes_at, optionalString(job.content)),
    };
  });
}

/** Parse the public Lever postings API response (`[...]`). */
export function parseLeverResponse(response: unknown): SourceRole[] {
  return array(response, "Lever response").map((value, index) => {
    const job = object(value, `Lever job ${index}`);
    const sourceUrl = publicHttpUrl(job.hostedUrl, `Lever job ${index} hostedUrl`);
    const applyUrl = optionalString(job.applyUrl);
    return {
      externalId: requiredString(job.id, `Lever job ${index} id`),
      title: requiredString(job.text, `Lever job ${index} text`),
      location: nestedString(job.categories, "location"),
      team: nestedString(job.categories, "team"),
      employmentType: nestedString(job.categories, "commitment"),
      description: optionalString(job.descriptionPlain),
      sourceUrl,
      applyUrl: applyUrl ? publicHttpUrl(applyUrl, `Lever job ${index} applyUrl`) : sourceUrl,
      postedAt: isoDate(job.createdAt),
      updatedAt: isoDate(job.updatedAt),
      deadlineAt: deadlineFrom(job.deadline ?? job.applicationDeadline ?? job.closesAt, optionalString(job.descriptionPlain)),
    };
  });
}

/** Parse Ashby's public job-board response (`{ jobs: [...] }`). */
export function parseAshbyResponse(response: unknown): SourceRole[] {
  const root = object(response, "Ashby response");
  return array(root.jobs, "Ashby jobs").flatMap((value, index) => {
    const job = object(value, `Ashby job ${index}`);
    if (job.isListed === false) return [];
    const sourceUrl = publicHttpUrl(job.jobUrl, `Ashby job ${index} jobUrl`);
    const applyUrl = optionalString(job.applyUrl);
    const secondaryLocations = Array.isArray(job.secondaryLocations)
      ? job.secondaryLocations.map((location) => typeof location === "string" ? location : nestedString(location, "location")).filter((location): location is string => Boolean(location))
      : [];
    return [{
      externalId: requiredString(job.id, `Ashby job ${index} id`),
      title: requiredString(job.title, `Ashby job ${index} title`),
      location: [optionalString(job.location), ...secondaryLocations].filter(Boolean).join("; ") || undefined,
      team: [optionalString(job.department), optionalString(job.team)].filter(Boolean).join(", ") || undefined,
      employmentType: optionalString(job.employmentType),
      description: optionalString(job.descriptionPlain),
      sourceUrl,
      applyUrl: applyUrl ? publicHttpUrl(applyUrl, `Ashby job ${index} applyUrl`) : sourceUrl,
      postedAt: isoDate(job.publishedAt),
      updatedAt: null,
      deadlineAt: deadlineFrom(job.deadlineAt, optionalString(job.descriptionPlain)),
    }];
  });
}

export async function runSource<T>(adapter: SourceAdapter<T>): Promise<SourceRunResult> {
  try {
    const response = await adapter.fetch();
    const roles = adapter.parse(response, {
      sourceId: adapter.sourceId,
      provider: adapter.provider,
      organization: adapter.organization,
    });
    return { sourceId: adapter.sourceId, provider: adapter.provider, ok: true, roles };
  } catch (error) {
    return {
      sourceId: adapter.sourceId,
      provider: adapter.provider,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function cleanText(value: string | undefined): string {
  return (value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function keyPart(value: string): string {
  return cleanText(value).normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Discovered role URLs must use HTTP or HTTPS.");
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch (error) {
    if (error instanceof Error && error.message === "Discovered role URLs must use HTTP or HTTPS.") throw error;
    throw new Error("A discovered role contains an invalid URL.");
  }
}

export function sourceDeduplicationKey(sourceId: string, externalId: string): string {
  return `${keyPart(sourceId)}:${keyPart(externalId)}`;
}

export function roleIdentityKey(role: Pick<NormalizedRole, "organization" | "title" | "location">): string {
  return [role.organization, role.title, role.location].map(keyPart).join("|");
}

export function normalizeRole(role: SourceRole, context: SourceContext): NormalizedRole {
  const organization = cleanText(context.organization);
  const title = cleanText(role.title);
  const location = cleanText(role.location);
  if (!organization || !title || !cleanText(role.externalId)) throw new Error("A discovered role requires an organization, title, and external id.");
  const normalized: NormalizedRole = {
    sourceId: cleanText(context.sourceId),
    provider: context.provider,
    externalId: cleanText(role.externalId),
    organization,
    title,
    location,
    team: cleanText(role.team),
    employmentType: cleanText(role.employmentType),
    description: cleanText(role.description),
    sourceUrl: canonicalUrl(role.sourceUrl),
    applyUrl: canonicalUrl(role.applyUrl ?? role.sourceUrl),
    postedAt: isoDate(role.postedAt),
    deadlineAt: deadlineFrom(role.deadlineAt, role.description),
    sourceKey: sourceDeduplicationKey(context.sourceId, role.externalId),
    identityKey: "",
  };
  normalized.identityKey = roleIdentityKey(normalized);
  return normalized;
}

export function deduplicateRoles(roles: NormalizedRole[]): NormalizedRole[] {
  const bySourceKey = new Map<string, NormalizedRole>();
  for (const role of roles) bySourceKey.set(role.sourceKey, role);
  return [...bySourceKey.values()];
}

function roleChanged(previous: RoleObservation, current: NormalizedRole): boolean {
  const keys: (keyof NormalizedRole)[] = [
    // Team and employment type are adapter hints that are not yet persisted on
    // discovered postings. Material-change alerts use the persisted content hash,
    // so comparing those transient fields here would report every live role as
    // changed on every subsequent run.
    "provider", "externalId", "organization", "title", "location",
    "description", "postedAt", "deadlineAt", "identityKey",
  ];
  return keys.some((key) => previous[key] !== current[key]);
}

export function observeRole(previous: RoleObservation | undefined, role: NormalizedRole, observedAt: string): RoleObservation {
  const timestamp = new Date(observedAt).toISOString();
  return {
    ...role,
    status: "open",
    firstSeenAt: previous?.firstSeenAt ?? timestamp,
    lastSeenAt: timestamp,
    missingRuns: 0,
    closedAt: null,
  };
}

export function missRole(previous: RoleObservation, removalThreshold: number, observedAt: string): RoleObservation {
  if (!Number.isInteger(removalThreshold) || removalThreshold < 2) throw new Error("Removal threshold must be an integer of at least 2.");
  if (previous.status === "closed") return previous;
  const missingRuns = previous.missingRuns + 1;
  const closed = missingRuns >= removalThreshold;
  return {
    ...previous,
    status: closed ? "closed" : "missing",
    missingRuns,
    closedAt: closed ? new Date(observedAt).toISOString() : null,
  };
}

export function reconcileDiscoveryRun(input: {
  previous: RoleObservation[];
  sources: Array<SourceRunResult & { organization: string }>;
  observedAt: string;
  startedAt?: string;
  removalThreshold?: number;
}): DiscoveryRun {
  const removalThreshold = input.removalThreshold ?? 3;
  if (!Number.isInteger(removalThreshold) || removalThreshold < 2) throw new Error("Removal threshold must be an integer of at least 2.");
  const previousByKey = new Map(input.previous.map((role) => [role.sourceKey, role]));
  const nextByKey = new Map(previousByKey);
  const summary: DiscoveryRunSummary = {
    startedAt: new Date(input.startedAt ?? input.observedAt).toISOString(),
    finishedAt: new Date(input.observedAt).toISOString(),
    sources: [], sourceSucceeded: 0, sourceFailed: 0, received: 0, unique: 0,
    created: 0, updated: 0, unchanged: 0, restored: 0, markedMissing: 0, closed: 0,
  };

  for (const source of input.sources) {
    if (!source.ok) {
      summary.sourceFailed += 1;
      summary.sources.push({ sourceId: source.sourceId, provider: source.provider, status: "failed", received: 0, unique: 0, error: source.error });
      continue;
    }
    const roles = deduplicateRoles(source.roles.map((role) => normalizeRole(role, source)));
    const seen = new Set(roles.map((role) => role.sourceKey));
    summary.sourceSucceeded += 1;
    summary.received += source.roles.length;
    summary.unique += roles.length;
    summary.sources.push({ sourceId: source.sourceId, provider: source.provider, status: "succeeded", received: source.roles.length, unique: roles.length, error: null });

    for (const role of roles) {
      const previous = previousByKey.get(role.sourceKey);
      nextByKey.set(role.sourceKey, observeRole(previous, role, input.observedAt));
      if (!previous) summary.created += 1;
      else if (previous.status !== "open") summary.restored += 1;
      else if (roleChanged(previous, role)) summary.updated += 1;
      else summary.unchanged += 1;
    }
    for (const previous of input.previous) {
      if (previous.sourceId !== source.sourceId || seen.has(previous.sourceKey) || previous.status === "closed") continue;
      const missed = missRole(previous, removalThreshold, input.observedAt);
      nextByKey.set(previous.sourceKey, missed);
      if (missed.status === "closed") summary.closed += 1;
      else summary.markedMissing += 1;
    }
  }

  return { observations: [...nextByKey.values()].sort((a, b) => a.sourceKey.localeCompare(b.sourceKey)), summary };
}

function includesAny(value: string, candidates: string[]): boolean {
  const haystack = keyPart(value);
  return candidates.some((candidate) => haystack.includes(keyPart(candidate)));
}

export function matchesAlertRule(role: NormalizedRole, rule: AlertRule): boolean {
  if (rule.enabled === false) return false;
  if (rule.organizations?.length && !includesAny(role.organization, rule.organizations)) return false;
  if (rule.titleIncludes?.length && !includesAny(role.title, rule.titleIncludes)) return false;
  if (rule.titleExcludes?.length && includesAny(role.title, rule.titleExcludes)) return false;
  if (rule.locations?.length && !includesAny(role.location, rule.locations)) return false;
  if (rule.teams?.length && !includesAny(role.team, rule.teams)) return false;
  if (rule.employmentTypes?.length && !includesAny(role.employmentType, rule.employmentTypes)) return false;
  if (rule.remoteOnly && !includesAny(role.location, ["remote", "distributed", "anywhere"])) return false;
  return true;
}

export function matchAlertRules(roles: NormalizedRole[], rules: AlertRule[]): AlertMatch[] {
  return roles.flatMap((role) => rules.filter((rule) => matchesAlertRule(role, rule)).map((rule) => ({ ruleId: rule.id, role })));
}
