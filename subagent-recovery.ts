import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { probeConnectivity, resolveProbeUrl } from "./connectivity.ts";
import {
  classifyRecoverableFailure,
  type RecoverableFailureKind,
} from "./network-error.ts";
import { ConnectivityWatcher } from "./recovery-watcher.ts";

const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const FOREGROUND_COMPLETE_EVENT = "subagent:foreground-complete";
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

type RecoveryTarget = {
  runId: string;
  index: number;
  sessionPath: string;
};

type PendingRecoveryTarget = RecoveryTarget & {
  failureKind: RecoverableFailureKind;
};

type CompletionRow = {
  index?: unknown;
  taskIndex?: unknown;
  sessionPath?: unknown;
  sessionFile?: unknown;
  stopped?: unknown;
  state?: unknown;
  status?: unknown;
};

type CompletionPayload = CompletionRow & {
  runId?: unknown;
  results?: unknown;
};

type EventBus = ExtensionAPI["events"];

type CoordinatorOptions = {
  pollMs: number;
  probeTimeoutMs: number;
  providerRetryMs: number;
  maxContinuations: number;
  onStateChange: (
    waiting: boolean,
    paused: boolean,
    kind: RecoverableFailureKind | undefined,
  ) => void;
  onNotice: (message: string, level: "info" | "warning") => void;
};

function rowsFromCompletion(payload: CompletionPayload): RecoveryTarget[] {
  if (typeof payload.runId !== "string" || !payload.runId) return [];
  const rows = Array.isArray(payload.results) ? payload.results as CompletionRow[] : [payload];
  return rows.flatMap((row, position) => {
    if (row.stopped === true || row.state === "stopped" || row.status === "stopped") return [];
    const sessionPath = typeof row.sessionPath === "string"
      ? row.sessionPath
      : typeof row.sessionFile === "string"
        ? row.sessionFile
        : undefined;
    const candidateIndex = row.index ?? row.taskIndex ?? position;
    if (!sessionPath || !Number.isInteger(candidateIndex)) return [];
    return [{ runId: payload.runId!, index: candidateIndex as number, sessionPath }];
  });
}

/** Read only the active JSONL branch and classify its final assistant response. */
export async function sessionRecoverableFailureKind(
  sessionPath: string,
): Promise<RecoverableFailureKind | undefined> {
  let entries: Array<Record<string, unknown>>;
  try {
    entries = (await readFile(sessionPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return undefined;
  }

  const byId = new Map<string, Record<string, unknown>>();
  let leaf: Record<string, unknown> | undefined;
  for (const entry of entries) {
    if (typeof entry.id !== "string") continue;
    byId.set(entry.id, entry);
    leaf = entry;
  }
  for (let entry = leaf; entry; ) {
    if (entry.type === "message") {
      const message = entry.message as Parameters<typeof classifyRecoverableFailure>[0];
      if (message?.role === "assistant") return classifyRecoverableFailure(message);
    }
    entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined;
  }
  return undefined;
}

function requestResume(
  events: EventBus,
  target: RecoveryTarget,
  timeoutMs = 10_000,
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    let done = false;
    const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
    const finish = (result: { success: boolean; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(result);
    };
    const unsubscribe = events.on(replyEvent, (payload: unknown) => {
      const reply = payload as { success?: unknown; error?: { message?: unknown } };
      finish(reply?.success === true
        ? { success: true }
        : {
            success: false,
            error: typeof reply?.error?.message === "string" ? reply.error.message : "resume rejected",
          });
    });
    const timeout = setTimeout(() => finish({ success: false, error: "resume acknowledgement timed out" }), timeoutMs);
    timeout.unref?.();
    try {
      events.emit(RPC_REQUEST_EVENT, {
        version: 1,
        requestId,
        method: "resume",
        params: {
          id: target.runId,
          index: target.index,
          message: "continue",
        },
      });
    } catch (error) {
      finish({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** Parent-process bridge that revives failed pi-subagents through its acknowledged public RPC. */
export class SubagentRecoveryCoordinator {
  private readonly pi: Pick<ExtensionAPI, "events">;
  private readonly options: CoordinatorOptions;
  private readonly pending = new Map<string, PendingRecoveryTarget>();
  private readonly continuationCounts = new Map<string, number>();
  private readonly unsubscribers: Array<() => void> = [];
  private ctx: ExtensionContext | undefined;
  private watcher: ConnectivityWatcher | undefined;
  private paused = false;

  constructor(pi: Pick<ExtensionAPI, "events">, options: CoordinatorOptions) {
    this.pi = pi;
    this.options = options;
    const handler = (payload: unknown) => { void this.observeCompletion(payload as CompletionPayload); };
    this.unsubscribers.push(
      pi.events.on(ASYNC_COMPLETE_EVENT, handler),
      pi.events.on(FOREGROUND_COMPLETE_EVENT, handler),
    );
  }

  setContext(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  cancel(resetCounts = true): void {
    this.watcher?.cancel();
    this.watcher = undefined;
    this.pending.clear();
    if (resetCounts) this.continuationCounts.clear();
    this.paused = false;
    this.options.onStateChange(false, false, undefined);
  }

  close(): void {
    this.cancel();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.ctx = undefined;
  }

  private pendingFailureKind(): RecoverableFailureKind | undefined {
    for (const target of this.pending.values()) {
      if (target.failureKind === "transport") return "transport";
    }
    return this.pending.size > 0 ? "provider" : undefined;
  }

  private async observeCompletion(payload: CompletionPayload): Promise<void> {
    if (!this.ctx) return;
    const targets = rowsFromCompletion(payload);
    for (const target of targets) {
      const failureKind = await sessionRecoverableFailureKind(target.sessionPath);
      if (failureKind) {
        this.pending.set(target.sessionPath, { ...target, failureKind });
      } else {
        this.pending.delete(target.sessionPath);
        this.continuationCounts.delete(target.sessionPath);
      }
    }
    if (this.pending.size > 0) this.startWatcher();
    else this.options.onStateChange(false, false, undefined);
  }

  private startWatcher(): void {
    if (!this.ctx || this.watcher?.running) return;
    const eligible = [...this.pending.values()].filter(
      (target) => (this.continuationCounts.get(target.sessionPath) ?? 0) < this.options.maxContinuations,
    );
    if (eligible.length === 0) {
      this.paused = true;
      this.options.onStateChange(true, true, this.pendingFailureKind());
      this.options.onNotice(
        "Subagent fetch recovery reached its automatic continuation limit. Resume the child manually to retry.",
        "warning",
      );
      return;
    }

    this.paused = false;
    const failureKind = eligible.some((target) => target.failureKind === "transport")
      ? "transport"
      : "provider";
    this.options.onStateChange(true, false, failureKind);
    this.options.onNotice(
      failureKind === "provider"
        ? `${eligible.length} subagent session${eligible.length === 1 ? "" : "s"} stopped after retryable provider failures. Waiting before retry…`
        : `${eligible.length} subagent session${eligible.length === 1 ? "" : "s"} stopped after fetch failures. Waiting for internet connectivity…`,
      "warning",
    );
    const ctx = this.ctx;
    const maxCount = Math.max(...eligible.map(
      (target) => this.continuationCounts.get(target.sessionPath) ?? 0,
    ));
    const baseDelayMs = failureKind === "provider"
      ? this.options.providerRetryMs
      : this.options.pollMs;
    const maxDelayMs = failureKind === "provider" ? 300_000 : 60_000;
    const delayMs = Math.min(baseDelayMs * (2 ** Math.min(maxCount, 10)), maxDelayMs);
    this.watcher = new ConnectivityWatcher({
      delayMs,
      probe: failureKind === "provider"
        ? async () => true
        : (signal) => probeConnectivity(resolveProbeUrl(ctx), signal, {
            timeoutMs: this.options.probeTimeoutMs,
          }),
      onRecovered: async () => {
        const recoveries = await Promise.all(eligible.map(async (target) => ({
          target,
          result: await requestResume(this.pi.events, target),
        })));
        const failures: string[] = [];
        for (const { target, result } of recoveries) {
          if (result.success) {
            this.pending.delete(target.sessionPath);
            this.continuationCounts.set(
              target.sessionPath,
              (this.continuationCounts.get(target.sessionPath) ?? 0) + 1,
            );
          } else {
            failures.push(`${target.runId}:${target.index}: ${result.error}`);
          }
        }
        if (failures.length > 0) {
          this.paused = true;
          this.options.onStateChange(true, true, this.pendingFailureKind());
          this.options.onNotice(`Could not resume failed subagent: ${failures.join("; ")}`, "warning");
          return;
        }
        this.options.onStateChange(
          this.pending.size > 0,
          false,
          this.pending.size > 0 ? this.pendingFailureKind() : undefined,
        );
        this.options.onNotice(
          failureKind === "provider"
            ? `Provider retry cooldown elapsed. Resumed ${recoveries.length} subagent session${recoveries.length === 1 ? "" : "s"}.`
            : `Internet connectivity restored. Resumed ${recoveries.length} subagent session${recoveries.length === 1 ? "" : "s"}.`,
          "info",
        );
      },
      onError: (error) => {
        this.paused = true;
        this.options.onStateChange(true, true, this.pendingFailureKind());
        this.options.onNotice(
          `Subagent fetch recovery failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      },
    });
    this.watcher.start();
  }
}
