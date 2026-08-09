import type { DiscoveryRunRecord } from "@careeros/contracts";
import type { NotificationProvider } from "./notifications.js";
import { TelegramDeliveryError } from "./notifications.js";
import type { WorkspaceContext } from "./postgres/contracts.js";
import {
  PostgresDiscoveryRepository,
  type HostedDiscoveryClaim,
  type HostedDeliveryClaim,
  type HostedRoleObservation,
} from "./postgres-discovery-repository.js";

export type HostedSourceFetcher = (claim: HostedDiscoveryClaim) => Promise<{
  observations: HostedRoleObservation[];
  inventoryComplete: boolean;
}>;

type TelegramDestination = { provider: NotificationProvider; recipientId: string };

export async function runWorkspaceTasksIsolated<T>(
  contexts: WorkspaceContext[],
  task: (context: WorkspaceContext) => Promise<T>,
  onError: (context: WorkspaceContext, error: unknown) => void = () => {},
) {
  const results: T[] = [];
  for (const context of contexts) {
    try { results.push(await task(context)); }
    catch (error) { onError(context, error); }
  }
  return results;
}

export class PostgresDiscoveryService {
  constructor(
    private readonly repository: PostgresDiscoveryRepository,
    private readonly options: { resolveTelegram?: (context: WorkspaceContext) => Promise<TelegramDestination | null> } = {},
  ) {}

  private async processClaims(context: WorkspaceContext, claims: HostedDiscoveryClaim[], fetchSource: HostedSourceFetcher, options: { concurrency?: number; leaseSeconds?: number; heartbeatSeconds?: number } = {}) {
    const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 300, 3_600));
    const heartbeatSeconds = Math.max(5, Math.min(options.heartbeatSeconds ?? Math.floor(leaseSeconds / 3), Math.max(5, leaseSeconds - 5)));
    const results: DiscoveryRunRecord[] = [];
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 12));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, claims.length) }, async () => {
      while (cursor < claims.length) {
        const claim = claims[cursor++];
        const startedAt = new Date();
        let leaseLost = false;
        const heartbeat = setInterval(() => {
          void this.repository.renewSourceClaim(context, claim, leaseSeconds).then((renewed) => { leaseLost ||= !renewed; }).catch(() => { leaseLost = true; });
        }, heartbeatSeconds * 1_000);
        try {
          const fetched = await fetchSource(claim);
          if (leaseLost) throw Object.assign(new Error("Discovery source lease was lost while fetching."), { leaseLost: true });
          results.push(await this.repository.completeSuccessfulRun(context, claim, fetched.observations, { inventoryComplete: fetched.inventoryComplete, startedAt }));
        } catch (error) {
          if (leaseLost || (typeof error === "object" && error && "leaseLost" in error)) continue;
          try { results.push(await this.repository.completeFailedRun(context, claim, error, startedAt)); }
          catch (recordError) {
            if (!/lease was lost|no longer active/i.test(recordError instanceof Error ? recordError.message : "")) throw recordError;
          }
        } finally {
          clearInterval(heartbeat);
        }
      }
    }));
    return results;
  }

  async runDue(context: WorkspaceContext, fetchSource: HostedSourceFetcher, options: { limit?: number; concurrency?: number; leaseSeconds?: number; heartbeatSeconds?: number } = {}) {
    const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 300, 3_600));
    return this.processClaims(context, await this.repository.claimDueSources(context, { limit: options.limit, leaseSeconds }), fetchSource, options);
  }

  async runSourceNow(context: WorkspaceContext, sourceId: string, fetchSource: HostedSourceFetcher, options: { leaseSeconds?: number; heartbeatSeconds?: number } = {}) {
    const leaseSeconds = Math.max(15, Math.min(options.leaseSeconds ?? 300, 3_600));
    const claim = await this.repository.claimSourceNow(context, sourceId, leaseSeconds);
    if (!claim) return [];
    return this.processClaims(context, [claim], fetchSource, { ...options, leaseSeconds, concurrency: 1 });
  }

  async dispatchTelegram(context: WorkspaceContext, options: { limit?: number; deliveryId?: string } = {}) {
    const destination = await this.options.resolveTelegram?.(context) ?? null;
    const claims = options.deliveryId
      ? [await this.repository.claimTelegramDelivery(context, options.deliveryId)].filter((claim): claim is HostedDeliveryClaim => claim !== null)
      : await this.repository.claimTelegramDeliveries(context, { limit: options.limit });
    const delivered: string[] = [];
    for (const claim of claims) {
      if (!destination) {
        await this.repository.failTelegramDelivery(context, claim, { kind: "configuration", message: "Telegram is not configured." });
        continue;
      }
      try {
        const result = await destination.provider.deliver({
          notificationId: claim.alertEventId,
          channel: "telegram",
          recipientId: destination.recipientId,
          deduplicationKey: claim.deduplicationKey,
          content: { title: claim.title, body: claim.body, directLink: claim.directUrl, directLinkLabel: "Open job" },
        });
        await this.repository.finishTelegramDelivery(context, claim, result.providerMessageId);
        delivered.push(claim.id);
      } catch (error) {
        const failure = error instanceof TelegramDeliveryError
          ? { kind: error.kind, message: error.message, retryAfterMs: error.retryAfterMs }
          : { kind: "ambiguous" as const, message: error instanceof Error ? error.message : "Telegram delivery failed." };
        await this.repository.failTelegramDelivery(context, claim, failure);
      }
    }
    return { claimed: claims.length, delivered };
  }
}
