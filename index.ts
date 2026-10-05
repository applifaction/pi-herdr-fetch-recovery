import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { probeConnectivity, redactProbeUrl, resolveProbeUrl } from "./connectivity.ts";
import { MetadataPublisher } from "./metadata.ts";
import { isNetworkTransportFailure } from "./network-error.ts";
import { ConnectivityWatcher } from "./recovery-watcher.ts";
import { SubagentRecoveryCoordinator } from "./subagent-recovery.ts";

const VERSION = "0.1.0";
const STATUS_KEY = "fetch-recovery";

type ContinuationState = "none" | "submitted" | "accepted";

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Wait for connectivity after Pi exhausts its own retries, then continue safely. */
export default function fetchRecovery(pi: ExtensionAPI): void {
  let active = false;
  let herdrActive = false;
  let networkFailure = false;
  let recoveryPaused = false;
  let subagentFailure = false;
  let subagentRecoveryPaused = false;
  let latestAssistant: MessageEndEvent["message"] | undefined;
  let publisher: MetadataPublisher | undefined;
  let watcher: ConnectivityWatcher | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let handledGeneration = -1;
  let automaticContinuations = 0;
  let continuationState: ContinuationState = "none";
  let probeUrl = "";
  let currentCtx: ExtensionContext | undefined;

  const pollMs = positiveInteger("PI_FETCH_RECOVERY_POLL_MS", 5_000);
  const probeTimeoutMs = positiveInteger("PI_FETCH_RECOVERY_PROBE_TIMEOUT_MS", 3_000);
  const maxAutomaticContinuations = positiveInteger("PI_FETCH_RECOVERY_MAX_CONTINUES", 3);

  function hasFailure(): boolean {
    return networkFailure || subagentFailure;
  }

  function hasPausedRecovery(): boolean {
    return recoveryPaused || subagentRecoveryPaused;
  }

  function setFailureStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!hasFailure()) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const icon = ctx.ui.theme.fg("error", "×");
    const label = hasPausedRecovery() ? " automatic recovery paused" : " waiting for internet";
    ctx.ui.setStatus(STATUS_KEY, icon + ctx.ui.theme.fg("dim", label));
  }

  function ensurePublisher(): MetadataPublisher | undefined {
    if (!herdrActive || publisher) return publisher;
    publisher = new MetadataPublisher(
      process.env.HERDR_SOCKET_PATH!,
      process.env.HERDR_PANE_ID!,
    );
    return publisher;
  }

  function refreshPresentation(ctx: ExtensionContext): void {
    setFailureStatus(ctx);
    if (herdrActive) void ensurePublisher()?.set(hasFailure());
  }

  function cancelWatcher(): void {
    watcher?.cancel();
    watcher = undefined;
  }

  function showFailure(ctx: ExtensionContext, paused: boolean): void {
    networkFailure = true;
    recoveryPaused = paused;
    refreshPresentation(ctx);
  }

  function clearFailure(ctx: ExtensionContext): void {
    cancelWatcher();
    networkFailure = false;
    recoveryPaused = false;
    refreshPresentation(ctx);
  }

  const subagentRecovery = new SubagentRecoveryCoordinator(pi, {
    pollMs,
    probeTimeoutMs,
    maxContinuations: maxAutomaticContinuations,
    onStateChange: (waiting, paused) => {
      subagentFailure = waiting;
      subagentRecoveryPaused = paused;
      if (currentCtx) refreshPresentation(currentCtx);
    },
    onNotice: (message, level) => {
      currentCtx?.ui.notify(message, level);
    },
  });

  function restoreLatestAssistant(ctx: ExtensionContext): void {
    latestAssistant = undefined;
    let assistantIndex = -1;
    let userIndex = -1;
    for (const [index, entry] of ctx.sessionManager.getBranch().entries()) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "assistant") {
        latestAssistant = entry.message;
        assistantIndex = index;
      } else if (entry.message.role === "user") {
        userIndex = index;
      }
    }
    // A newer user prompt already supersedes an older failed response.
    if (userIndex > assistantIndex) latestAssistant = undefined;
  }

  function confirmAutomaticContinuation(ctx: ExtensionContext): boolean {
    if (continuationState === "none") return false;
    continuationState = "accepted";
    clearFailure(ctx);
    ctx.ui.notify("Internet connectivity restored. Continuing automatically.", "info");
    return true;
  }

  function beginWatching(ctx: ExtensionContext): void {
    if (!active || watcher?.running || continuationState !== "none") return;
    probeUrl = resolveProbeUrl(ctx);
    const firstNotice = !networkFailure;
    const paused = automaticContinuations >= maxAutomaticContinuations;
    showFailure(ctx, paused);

    if (paused) {
      if (firstNotice) {
        ctx.ui.notify(
          `Fetch still fails after ${automaticContinuations} automatic continuations. `
            + "Automatic recovery is paused; submit a prompt manually to retry.",
          "warning",
        );
      }
      return;
    }

    if (firstNotice) {
      ctx.ui.notify("Fetch failed after Pi's automatic retries. Waiting for internet connectivity…", "warning");
    }

    const watchedGeneration = generation;
    const delayMs = Math.min(pollMs * (2 ** Math.min(automaticContinuations, 10)), 60_000);
    watcher = new ConnectivityWatcher({
      delayMs,
      probe: (signal) => probeConnectivity(probeUrl, signal, { timeoutMs: probeTimeoutMs }),
      onRecovered: () => {
        if (!active || generation !== watchedGeneration || continuationState !== "none") return;
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          clearFailure(ctx);
          return;
        }

        // Claim before submission so concurrent successful probes cannot duplicate the prompt.
        // Keep the visible error until before_agent_start confirms Pi accepted this prompt.
        continuationState = "submitted";
        automaticContinuations++;
        pi.sendUserMessage("continue");
      },
      onError: (error) => {
        if (continuationState === "submitted") {
          continuationState = "none";
          automaticContinuations = Math.max(0, automaticContinuations - 1);
        }
        ctx.ui.notify(
          `Automatic continuation could not be submitted: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      },
    });
    watcher.start();
  }

  function settleCurrentGeneration(ctx: ExtensionContext): void {
    if (!active || handledGeneration === generation) return;
    handledGeneration = generation;
    if (isNetworkTransportFailure(latestAssistant)) {
      beginWatching(ctx);
    } else if (latestAssistant) {
      automaticContinuations = 0;
      continuationState = "none";
      clearFailure(ctx);
    }
  }

  function restoreAndMaybeWatch(ctx: ExtensionContext): void {
    generation++;
    handledGeneration = -1;
    automaticContinuations = 0;
    continuationState = "none";
    cancelWatcher();
    restoreLatestAssistant(ctx);
    if (isNetworkTransportFailure(latestAssistant) && ctx.isIdle() && !ctx.hasPendingMessages()) {
      handledGeneration = generation;
      beginWatching(ctx);
    } else {
      clearFailure(ctx);
    }
  }

  pi.registerCommand("fetch-recovery-status", {
    description: "Show the automatic fetch-recovery watcher status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Fetch Recovery v${VERSION} loaded; active: ${active}; waiting: ${networkFailure}; `
          + `subagent waiting: ${subagentFailure}; watcher: ${watcher?.state ?? "idle"}; `
          + `probes: ${watcher?.attempts ?? 0}; continuations: ${automaticContinuations}/${maxAutomaticContinuations}; `
          + `handoff: ${continuationState}; Herdr: ${herdrActive ? publisher?.status ?? "pending" : "inactive"}; `
          + `target: ${probeUrl ? redactProbeUrl(probeUrl) : "unresolved"}`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // This parent-side instance owns interactive recovery and pi-subagents revival.
    active = ctx.mode === "tui";
    currentCtx = active ? ctx : undefined;
    herdrActive = active
      && process.env.HERDR_ENV === "1"
      && !!process.env.HERDR_SOCKET_PATH
      && !!process.env.HERDR_PANE_ID;
    probeUrl = active ? resolveProbeUrl(ctx) : "";
    if (herdrActive) ensurePublisher();
    if (!active) return;
    subagentRecovery.setContext(ctx);

    // Defer until other startup integrations have established their pane/session state.
    startupTimer = setTimeout(() => {
      startupTimer = undefined;
      restoreAndMaybeWatch(ctx);
    }, 0);
    startupTimer.unref?.();
  });

  pi.on("input", (event, ctx) => {
    if (!active || event.source === "extension") return;
    // Explicit human/RPC work always wins over automatic continuations.
    generation++;
    handledGeneration = -1;
    automaticContinuations = 0;
    continuationState = "none";
    latestAssistant = undefined;
    subagentRecovery.cancel();
    clearFailure(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!active || continuationState !== "submitted") return;
    if (event.prompt.trim().toLowerCase() === "continue") {
      confirmAutomaticContinuation(ctx);
    } else {
      // A different run won the race; treat it as manual work.
      automaticContinuations = 0;
      continuationState = "none";
      clearFailure(ctx);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!active) return;
    const automatic = continuationState !== "none";
    if (automatic && networkFailure) confirmAutomaticContinuation(ctx);
    if (!automatic) automaticContinuations = 0;
    continuationState = "none";
    generation++;
    handledGeneration = -1;
    latestAssistant = undefined;
    clearFailure(ctx);
  });

  pi.on("message_end", (event) => {
    if (active && event.message.role === "assistant") latestAssistant = event.message;
  });

  // agent_end is intentionally ignored: Pi may still auto-retry or auto-compact.
  pi.on("agent_settled", (_event, ctx) => {
    settleCurrentGeneration(ctx);
  });

  pi.on("session_before_compact", (event, ctx) => {
    // Automatic threshold/overflow compaction is part of Pi's own recovery and
    // must not erase the final assistant error before agent_settled. A manual
    // compaction is explicit user work and therefore wins over this watcher.
    if (!active || event.reason !== "manual") return;
    generation++;
    handledGeneration = -1;
    automaticContinuations = 0;
    continuationState = "none";
    latestAssistant = undefined;
    subagentRecovery.cancel();
    clearFailure(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    if (!active) return;
    probeUrl = resolveProbeUrl(ctx);
    if (networkFailure && continuationState === "none") {
      cancelWatcher();
      beginWatching(ctx);
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    if (active) restoreAndMaybeWatch(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    active = false;
    currentCtx = undefined;
    generation++;
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = undefined;
    cancelWatcher();
    subagentRecovery.close();
    networkFailure = false;
    recoveryPaused = false;
    subagentFailure = false;
    subagentRecoveryPaused = false;
    latestAssistant = undefined;
    automaticContinuations = 0;
    continuationState = "none";
    setFailureStatus(ctx);
    await publisher?.close();
    publisher = undefined;
    herdrActive = false;
    probeUrl = "";
  });
}
