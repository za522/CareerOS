import { createHash } from "node:crypto";

const telegramMessageLimit = 4_096;
const defaultMaxAttempts = 3;
const defaultRetryDelayMs = 30_000;

export type NotificationChannel = "in_app" | "telegram";

export type NotificationContent = {
  title: string;
  body: string;
  directLink?: string;
  directLinkLabel?: string;
};

export type DeliveryRequest = {
  notificationId: string;
  channel: NotificationChannel;
  recipientId: string;
  deduplicationKey: string;
  content: NotificationContent;
};

export type ProviderDelivery = {
  providerMessageId?: string;
};

export type TelegramFailureKind = "ambiguous" | "retryable" | "permanent";

export class TelegramDeliveryError extends Error {
  constructor(
    message: string,
    readonly kind: TelegramFailureKind,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TelegramDeliveryError";
  }
}

export interface NotificationProvider {
  readonly channel: NotificationChannel;
  deliver(request: DeliveryRequest): Promise<ProviderDelivery>;
}

export type DeliveryState =
  | { status: "pending"; attempts: number }
  | { status: "delivered"; attempts: number; deliveredAt: Date; providerMessageId?: string }
  | { status: "retry_scheduled"; attempts: number; nextAttemptAt: Date; lastError: string }
  | { status: "ambiguous"; attempts: number; lastError: string }
  | { status: "failed"; attempts: number; lastError: string };

export type DeliveryRecord = {
  request: DeliveryRequest;
  state: DeliveryState;
};

export type InAppNotification = {
  notificationId: string;
  recipientId: string;
  content: NotificationContent;
  createdAt: Date;
};

export type InAppNotificationSink = (notification: InAppNotification) => Promise<void>;

export function createDeduplicationKey(parts: {
  event: string;
  recipientId: string;
  subjectId: string;
  channel: NotificationChannel;
}): string {
  const canonical = [parts.event, parts.recipientId, parts.subjectId, parts.channel]
    .map((part) => part.trim().toLowerCase())
    .join("\u001f");
  return createHash("sha256").update(canonical).digest("hex");
}

export function createInAppProvider(options: {
  save: InAppNotificationSink;
  now?: () => Date;
}): NotificationProvider {
  return {
    channel: "in_app",
    async deliver(request) {
      await options.save({
        notificationId: request.notificationId,
        recipientId: request.recipientId,
        content: request.content,
        createdAt: (options.now ?? (() => new Date()))(),
      });
      return {};
    },
  };
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createTelegramProvider(options: {
  botToken: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  apiBaseUrl?: string;
}): NotificationProvider {
  if (!options.botToken.trim()) throw new Error("A Telegram bot token is required.");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/$/, "");
  const endpoint = `${apiBaseUrl}/bot${options.botToken}/sendMessage`;

  return {
    channel: "telegram",
    async deliver(request) {
      let response: Response;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: request.recipientId,
            text: formatTelegramMessage(request.content),
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        });
      } catch {
        // The request may have reached Telegram before the connection failed. Retrying
        // automatically could therefore send the same alert twice.
        throw new TelegramDeliveryError("Telegram delivery outcome is unknown after a connection failure.", "ambiguous");
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const retryAfterMs = response.status === 429 ? await telegramRetryAfterMs(response) : undefined;
        const kind: TelegramFailureKind = [400, 401, 403].includes(response.status) ? "permanent" : "retryable";
        throw new TelegramDeliveryError(`Telegram delivery failed with HTTP ${response.status}.`, kind, retryAfterMs);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new TelegramDeliveryError("Telegram accepted the request but returned an unreadable response.", "ambiguous");
      }
      if (!isTelegramSuccess(payload)) {
        throw new TelegramDeliveryError("Telegram delivery was rejected by the provider.", "permanent");
      }
      return { providerMessageId: String(payload.result.message_id) };
    },
  };
}

async function telegramRetryAfterMs(response: Response) {
  const header = response.headers.get("retry-after")?.trim() ?? "";
  const seconds = Number(header);
  if (header && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  if (header) {
    const timestamp = new Date(header).getTime();
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  }
  try {
    const payload = await response.clone().json() as { parameters?: { retry_after?: unknown } };
    const apiSeconds = Number(payload.parameters?.retry_after);
    if (Number.isFinite(apiSeconds) && apiSeconds >= 0) return Math.ceil(apiSeconds * 1_000);
  } catch {
    // A missing or malformed body falls back to a conservative minute.
  }
  return 60_000;
}

export function formatTelegramMessage(content: NotificationContent): string {
  const escapedTitle = truncateEscapedHtml(escapeTelegramHtml(content.title.trim()), 512);
  const title = `<b>${escapedTitle}</b>`;
  const body = escapeTelegramHtml(content.body.trim());
  const link = safeHttpUrl(content.directLink);
  const escapedLink = link ? escapeTelegramHtml(link) : undefined;
  const label = truncateEscapedHtml(
    escapeTelegramHtml(content.directLinkLabel?.trim() || "Open in CareerOS"),
    128,
  );
  const suffix = escapedLink && escapedLink.length <= 2_048 ? `\n\n<a href="${escapedLink}">${label}</a>` : "";
  const availableBodyLength = Math.max(0, telegramMessageLimit - title.length - suffix.length - 2);
  return `${title}\n\n${truncateEscapedHtml(body, availableBodyLength)}${suffix}`;
}

export class NotificationDispatcher {
  readonly #providers: Map<NotificationChannel, NotificationProvider>;
  readonly #records = new Map<string, DeliveryRecord>();
  readonly #inFlight = new Map<string, Promise<DeliveryRecord>>();
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #now: () => Date;

  constructor(options: {
    providers: NotificationProvider[];
    maxAttempts?: number;
    retryDelayMs?: number;
    now?: () => Date;
  }) {
    this.#providers = new Map(options.providers.map((provider) => [provider.channel, provider]));
    this.#maxAttempts = positiveInteger(options.maxAttempts ?? defaultMaxAttempts, "maxAttempts");
    this.#retryDelayMs = Math.max(0, options.retryDelayMs ?? defaultRetryDelayMs);
    this.#now = options.now ?? (() => new Date());
  }

  deliver(request: DeliveryRequest): Promise<DeliveryRecord> {
    validateRequest(request);
    const existing = this.#records.get(request.deduplicationKey);
    if (existing?.state.status === "delivered" || existing?.state.status === "failed" || existing?.state.status === "ambiguous") {
      return Promise.resolve(existing);
    }
    const active = this.#inFlight.get(request.deduplicationKey);
    if (active) return active;

    const work = this.#attempt(request).finally(() => this.#inFlight.delete(request.deduplicationKey));
    this.#inFlight.set(request.deduplicationKey, work);
    return work;
  }

  get(deduplicationKey: string): DeliveryRecord | undefined {
    return this.#records.get(deduplicationKey);
  }

  async retryDue(): Promise<DeliveryRecord[]> {
    const now = this.#now().getTime();
    const due = [...this.#records.values()].filter(
      (record) => record.state.status === "retry_scheduled" && record.state.nextAttemptAt.getTime() <= now,
    );
    return Promise.all(due.map((record) => this.deliver(record.request)));
  }

  async #attempt(request: DeliveryRequest): Promise<DeliveryRecord> {
    const provider = this.#providers.get(request.channel);
    if (!provider) throw new Error(`No notification provider is configured for ${request.channel}.`);
    const previousAttempts = this.#records.get(request.deduplicationKey)?.state.attempts ?? 0;
    const attempts = previousAttempts + 1;
    this.#records.set(request.deduplicationKey, { request, state: { status: "pending", attempts } });

    try {
      const delivered = await provider.deliver(request);
      const record: DeliveryRecord = {
        request,
        state: {
          status: "delivered",
          attempts,
          deliveredAt: this.#now(),
          ...(delivered.providerMessageId ? { providerMessageId: delivered.providerMessageId } : {}),
        },
      };
      this.#records.set(request.deduplicationKey, record);
      return record;
    } catch (error) {
      const lastError = safeErrorMessage(error);
      const state: DeliveryState = error instanceof TelegramDeliveryError && error.kind === "ambiguous"
        ? { status: "ambiguous", attempts, lastError }
        : error instanceof TelegramDeliveryError && error.kind === "permanent"
          ? { status: "failed", attempts, lastError }
          : attempts < this.#maxAttempts
            ? { status: "retry_scheduled", attempts, nextAttemptAt: new Date(this.#now().getTime() + (error instanceof TelegramDeliveryError ? error.retryAfterMs ?? this.#retryDelayMs : this.#retryDelayMs)), lastError }
            : { status: "failed", attempts, lastError };
      const record = { request, state };
      this.#records.set(request.deduplicationKey, record);
      return record;
    }
  }
}

function validateRequest(request: DeliveryRequest) {
  if (!request.notificationId.trim()) throw new Error("notificationId is required.");
  if (!request.recipientId.trim()) throw new Error("recipientId is required.");
  if (!request.deduplicationKey.trim()) throw new Error("deduplicationKey is required.");
  if (!request.content.title.trim()) throw new Error("Notification title is required.");
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 300) : "Notification delivery failed.";
}

function safeHttpUrl(value?: string) {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function escapeTelegramHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncateEscapedHtml(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return "";
  let result = value.slice(0, maxLength - 1);
  const entityStart = result.lastIndexOf("&");
  const entityEnd = result.lastIndexOf(";");
  if (entityStart > entityEnd) result = result.slice(0, entityStart);
  const finalCodeUnit = result.charCodeAt(result.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) result = result.slice(0, -1);
  return `${result}…`;
}

function isTelegramSuccess(value: unknown): value is { ok: true; result: { message_id: number } } {
  if (!value || typeof value !== "object") return false;
  const payload = value as { ok?: unknown; result?: { message_id?: unknown } };
  return payload.ok === true && typeof payload.result?.message_id === "number";
}
