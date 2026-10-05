import net from "node:net";
import { performance } from "node:perf_hooks";

export const FETCH_RECOVERY_TOKEN = "pica_fetch_recovery";
export const FETCH_FAILED_LABEL = "× Fetch failed";

const SOURCE = "pi:fetch-recovery";
const TTL_MS = 45_000;
let lastSequence = 0;

function nextSequence(): number {
  lastSequence = Math.max(
    lastSequence + 1,
    Math.floor((performance.timeOrigin + performance.now()) * 1_000),
  );
  return lastSequence;
}

/** A leased Herdr display token; it never changes the native agent lifecycle. */
export class MetadataPublisher {
  private readonly endpoint: string;
  private readonly paneId: string;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly timer: ReturnType<typeof setInterval>;
  private desired = false;
  private acknowledged: boolean | undefined;
  private pending: { state: boolean; seq: number } | undefined;
  private draining: Promise<void> | undefined;
  private closed = false;

  status: "pending" | "acknowledged" | "failed" = "pending";

  constructor(
    socketPath: string,
    paneId: string,
    options: { refreshMs?: number; timeoutMs?: number; ttlMs?: number } = {},
  ) {
    this.endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
    this.paneId = paneId;
    this.timeoutMs = options.timeoutMs ?? 500;
    this.ttlMs = options.ttlMs ?? TTL_MS;
    this.timer = setInterval(() => {
      if (this.desired || this.acknowledged !== this.desired) void this.queue(this.desired);
    }, options.refreshMs ?? 15_000);
    this.timer.unref?.();
  }

  set(state: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.desired === state && this.acknowledged === state && !this.draining) {
      return Promise.resolve();
    }
    return this.queue(state);
  }

  async close(): Promise<void> {
    if (this.closed) return this.draining;
    this.closed = true;
    clearInterval(this.timer);
    await this.queue(false);
  }

  private queue(state: boolean): Promise<void> {
    this.desired = state;
    this.pending = { state, seq: nextSequence() };
    this.status = "pending";
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = undefined;
      });
    }
    return this.draining;
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const next = this.pending;
      this.pending = undefined;
      const request = {
        id: `${SOURCE}:${next.seq}`,
        method: "pane.report_metadata",
        params: {
          pane_id: this.paneId,
          source: SOURCE,
          agent: "pi",
          applies_to_source: "herdr:pi",
          seq: next.seq,
          ttl_ms: this.ttlMs,
          tokens: { [FETCH_RECOVERY_TOKEN]: next.state ? FETCH_FAILED_LABEL : null },
        },
      };
      const delivered = (await this.send(request)) || (await this.send(request));
      this.acknowledged = delivered ? next.state : undefined;
      this.status = delivered ? "acknowledged" : "failed";
    }
  }

  private send(request: { id: string }): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      let buffer = "";
      const socket = net.createConnection(this.endpoint);
      const timeout = setTimeout(() => finish(false), this.timeoutMs);

      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        socket.destroy();
        resolve(ok);
      };

      socket.on("error", () => finish(false));
      socket.on("end", () => finish(false));
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (data) => {
        buffer += data.toString();
        if (buffer.length > 65_536) return finish(false);
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const reply = JSON.parse(buffer.slice(0, newline));
          finish(reply.id === request.id && !reply.error && reply.result !== undefined);
        } catch {
          finish(false);
        }
      });
    });
  }
}
