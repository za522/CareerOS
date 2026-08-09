import { describe, expect, it, vi } from "vitest";
import {
  NotificationDispatcher,
  createDeduplicationKey,
  createTelegramProvider,
  formatTelegramMessage,
  type DeliveryRequest,
  type FetchLike,
  type NotificationProvider,
} from "./notifications.js";

function request(overrides: Partial<DeliveryRequest> = {}): DeliveryRequest {
  return {
    notificationId: "notification-1",
    channel: "telegram",
    recipientId: "chat-123",
    deduplicationKey: "application:deadline:123",
    content: { title: "Deadline reminder", body: "Apply before Friday." },
    ...overrides,
  };
}

function telegramResponse(status = 200, payload: unknown = { ok: true, result: { message_id: 42 } }) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("notification delivery", () => {
  it("records successful Telegram delivery", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(telegramResponse());
    const dispatcher = new NotificationDispatcher({
      providers: [createTelegramProvider({ botToken: "secret-token", fetch })],
    });

    const record = await dispatcher.deliver(request());

    expect(record.state).toMatchObject({ status: "delivered", attempts: 1, providerMessageId: "42" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("captures a Telegram API error without exposing its response or token", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(
      telegramResponse(401, { ok: false, description: "secret-token is invalid" }),
    );
    const dispatcher = new NotificationDispatcher({
      providers: [createTelegramProvider({ botToken: "secret-token", fetch })],
      maxAttempts: 1,
    });

    const record = await dispatcher.deliver(request());

    expect(record.state).toMatchObject({ status: "failed", attempts: 1, lastError: "Telegram delivery failed with HTTP 401." });
    expect(JSON.stringify(record)).not.toContain("secret-token");
  });

  it("classifies 429 as retryable and respects Telegram Retry-After", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(new Response(JSON.stringify({ ok: false }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "90" },
    }));
    const dispatcher = new NotificationDispatcher({
      providers: [createTelegramProvider({ botToken: "secret-token", fetch })],
      now: () => new Date("2026-08-08T10:00:00.000Z"),
    });

    expect((await dispatcher.deliver(request())).state).toEqual({
      status: "retry_scheduled",
      attempts: 1,
      nextAttemptAt: new Date("2026-08-08T10:01:30.000Z"),
      lastError: "Telegram delivery failed with HTTP 429.",
    });
  });

  it("respects Telegram's JSON retry_after parameter when no header is present", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(telegramResponse(429, { ok: false, parameters: { retry_after: 45 } }));
    const dispatcher = new NotificationDispatcher({
      providers: [createTelegramProvider({ botToken: "secret-token", fetch })],
      now: () => new Date("2026-08-08T10:00:00.000Z"),
    });

    expect((await dispatcher.deliver(request())).state).toMatchObject({
      status: "retry_scheduled",
      nextAttemptAt: new Date("2026-08-08T10:00:45.000Z"),
    });
  });

  it("marks a network failure ambiguous so it is never retried automatically", async () => {
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new Error("request included secret-token"));
    const dispatcher = new NotificationDispatcher({
      providers: [createTelegramProvider({ botToken: "secret-token", fetch })],
      retryDelayMs: 1_000,
      now: () => new Date("2026-08-08T10:00:00.000Z"),
    });

    const record = await dispatcher.deliver(request());

    expect(record.state).toEqual({ status: "ambiguous", attempts: 1, lastError: "Telegram delivery outcome is unknown after a connection failure." });
  });

  it("retries due deliveries and advances the attempt state", async () => {
    let now = new Date("2026-08-08T10:00:00.000Z");
    const provider: NotificationProvider = {
      channel: "telegram",
      deliver: vi.fn()
        .mockRejectedValueOnce(new Error("Temporary outage"))
        .mockResolvedValueOnce({ providerMessageId: "84" }),
    };
    const dispatcher = new NotificationDispatcher({
      providers: [provider],
      retryDelayMs: 1_000,
      now: () => now,
    });

    expect((await dispatcher.deliver(request())).state.status).toBe("retry_scheduled");
    now = new Date("2026-08-08T10:00:01.000Z");
    const [retried] = await dispatcher.retryDue();

    expect(retried.state).toMatchObject({ status: "delivered", attempts: 2, providerMessageId: "84" });
    expect(provider.deliver).toHaveBeenCalledTimes(2);
  });

  it("suppresses duplicate successful deliveries", async () => {
    const provider: NotificationProvider = {
      channel: "telegram",
      deliver: vi.fn().mockResolvedValue({}),
    };
    const dispatcher = new NotificationDispatcher({ providers: [provider] });
    const original = request();

    const first = await dispatcher.deliver(original);
    const duplicate = await dispatcher.deliver({ ...original, notificationId: "notification-2" });

    expect(duplicate).toBe(first);
    expect(provider.deliver).toHaveBeenCalledOnce();
    expect(createDeduplicationKey({ event: "Deadline", recipientId: "USER-1", subjectId: "JOB-1", channel: "telegram" }))
      .toBe(createDeduplicationKey({ event: " deadline ", recipientId: "user-1", subjectId: "job-1", channel: "telegram" }));
  });

  it("includes an escaped direct link in Telegram content", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(telegramResponse());
    const provider = createTelegramProvider({ botToken: "secret-token", fetch });

    await provider.deliver(request({
      content: {
        title: "Interview <confirmed>",
        body: "Review R&D notes",
        directLink: "https://careeros.example/applications/123?view=timeline&from=alert",
        directLinkLabel: "Open & review",
      },
    }));

    const init = fetch.mock.calls[0]?.[1];
    const payload = JSON.parse(String(init?.body)) as { text: string; parse_mode: string };
    expect(payload.parse_mode).toBe("HTML");
    expect(payload.text).toContain("<b>Interview &lt;confirmed&gt;</b>");
    expect(payload.text).toContain("Review R&amp;D notes");
    expect(payload.text).toContain('<a href="https://careeros.example/applications/123?view=timeline&amp;from=alert">Open &amp; review</a>');
    expect(formatTelegramMessage({ title: "<alert>".repeat(1_000), body: "&".repeat(5_000) }).length).toBeLessThanOrEqual(4_096);
  });

  it("never truncates inside an escaped Telegram HTML entity", () => {
    const message = formatTelegramMessage({
      title: "Long alert",
      body: `${"safe ".repeat(805)}\"quoted content\"`,
    });

    expect(message.length).toBeLessThanOrEqual(4_096);
    expect(message).not.toMatch(/&(?:a|am|amp|l|lt|g|gt|q|qu|quo|quot)…/);
    expect((message.match(/&/g) ?? []).length).toBe((message.match(/;/g) ?? []).length);
  });

  it("never truncates inside an astral Unicode character", () => {
    const message = formatTelegramMessage({ title: "Unicode alert", body: "💼".repeat(3_000) });

    expect(message.length).toBeLessThanOrEqual(4_096);
    expect([...message].at(-2)).toBe("💼");
    expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(message).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
