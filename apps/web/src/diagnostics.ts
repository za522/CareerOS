export const apiBaseUrl = import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? "" : "http://127.0.0.1:4310");
export const diagnosticEventName = "careeros:diagnostic";

export type ServiceState = "checking" | "online" | "offline";
export type AiState = "checking" | "ready" | "missing" | "unknown";

export type DiagnosticEntry = {
  id: string;
  timestamp: string;
  source: "API" | "Interface" | "System";
  operation: string;
  message: string;
  statusCode?: number;
  detail?: string;
};

export type SystemSnapshot = {
  backend: ServiceState;
  ai: AiState;
  provider: string;
  model: string;
  keySource: "environment" | "keychain" | "none";
  checkedAt: string;
};

type DiagnosticInput = Omit<DiagnosticEntry, "id" | "timestamp"> & { timestamp?: string };

export function reportDiagnostic(input: DiagnosticInput) {
  if (typeof window === "undefined") return;
  const entry: DiagnosticEntry = {
    ...input,
    id: crypto.randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  window.dispatchEvent(new CustomEvent<DiagnosticEntry>(diagnosticEventName, { detail: entry }));
}

export async function checkSystemStatus(): Promise<SystemSnapshot> {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4_000);

  try {
    const healthResponse = await fetch(`${apiBaseUrl}/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!healthResponse.ok) throw new Error(`Health check returned ${healthResponse.status}.`);

    const metaResponse = await fetch(`${apiBaseUrl}/api/meta`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!metaResponse.ok) {
      return { backend: "online", ai: "unknown", provider: "openai", model: "", keySource: "none", checkedAt };
    }

    const meta = await metaResponse.json() as {
      ai?: { configured?: boolean; provider?: string; model?: string; source?: "environment" | "keychain" | "none" };
    };
    return {
      backend: "online",
      ai: meta.ai?.configured ? "ready" : "missing",
      provider: meta.ai?.provider ?? "openai",
      model: meta.ai?.model ?? "",
      keySource: meta.ai?.source ?? "none",
      checkedAt,
    };
  } catch {
    return { backend: "offline", ai: "unknown", provider: "openai", model: "", keySource: "none", checkedAt };
  } finally {
    window.clearTimeout(timeout);
  }
}
