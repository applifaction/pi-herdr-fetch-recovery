import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_PROBE_URL = "https://connectivitycheck.gstatic.com/generate_204";

function httpUrl(value: string | undefined, providerTarget: boolean): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    // Never reuse credentials embedded in a provider URL. Explicit health URLs
    // may intentionally include a query, but provider targets should not.
    url.username = "";
    url.password = "";
    url.hash = "";
    if (providerTarget) url.search = "";
    return url.href;
  } catch {
    return undefined;
  }
}

export function redactProbeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "unresolved";
  }
}

/** Prefer an explicit health URL, then the current provider endpoint, then a generic 204 endpoint. */
export function resolveProbeUrl(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): string {
  const configured = httpUrl(process.env.PI_FETCH_RECOVERY_URL, false);
  if (configured) return configured;

  const model = ctx.model as ({ provider?: string; baseUrl?: string } | undefined);
  const provider = model?.provider ? ctx.modelRegistry.getProvider(model.provider) : undefined;
  const providerUrl = httpUrl(model?.baseUrl ?? provider?.baseUrl, true);
  return providerUrl ?? DEFAULT_PROBE_URL;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * A non-redirecting response below 500 proves that the route is reachable.
 * Proxy-auth, timeout, early-data, rate-limit, redirect, and 5xx responses do
 * not trigger a new agent cycle.
 */
export async function probeConnectivity(
  url: string,
  signal: AbortSignal,
  options: { timeoutMs?: number; fetchFn?: FetchLike } = {},
): Promise<boolean> {
  if (signal.aborted) return false;

  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error("Connectivity probe timed out")), options.timeoutMs ?? 3_000);
  timeout.unref?.();

  try {
    const response = await (options.fetchFn ?? globalThis.fetch)(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { Range: "bytes=0-0", "Cache-Control": "no-cache" },
      signal: controller.signal,
    });
    void response.body?.cancel().catch(() => {});
    const rejectedReachabilityStatuses = new Set([407, 408, 425, 429]);
    return response.status >= 200
      && response.status < 500
      && (response.status < 300 || response.status >= 400)
      && !rejectedReachabilityStatuses.has(response.status);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
