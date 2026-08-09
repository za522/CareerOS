import { captureUrl, type UrlCaptureDependencies } from "./importer.js";

const appUrlPreflightTimeoutMs = 6_000;

export type PublicAppUrlPreflight = {
  url: string;
  reachable: true;
};

export async function preflightPublicAppUrl(
  input: string,
  dependencies: UrlCaptureDependencies = {},
): Promise<PublicAppUrlPreflight> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), appUrlPreflightTimeoutMs);
  try {
    const captured = await captureUrl(input, dependencies, controller.signal);
    if (!captured.url) throw new Error("The public CareerOS address did not return a usable page.");
    return { url: captured.url, reachable: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The address could not be reached.";
    throw new Error(`The public CareerOS address could not be reached safely. ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}
