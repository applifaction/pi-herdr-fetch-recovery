export type ConnectivityWatcherOptions = {
  probe: (signal: AbortSignal) => Promise<boolean>;
  onRecovered: () => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
  delayMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** One cancellable, non-blocking connectivity loop per settled agent failure. */
export class ConnectivityWatcher {
  private readonly options: Required<Pick<ConnectivityWatcherOptions, "probe" | "onRecovered" | "sleep">>
    & Pick<ConnectivityWatcherOptions, "onError"> & { delayMs: number };
  private controller: AbortController | undefined;
  private task: Promise<void> | undefined;

  attempts = 0;
  state: "idle" | "probing" | "waiting" = "idle";

  constructor(options: ConnectivityWatcherOptions) {
    this.options = {
      probe: options.probe,
      onRecovered: options.onRecovered,
      onError: options.onError,
      sleep: options.sleep ?? abortableDelay,
      delayMs: options.delayMs ?? 5_000,
    };
  }

  get running(): boolean {
    return !!this.controller && !this.controller.signal.aborted;
  }

  start(): void {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    this.attempts = 0;
    this.task = this.run(controller)
      .catch(async (error) => {
        if (!controller.signal.aborted) await this.options.onError?.(error);
      })
      .finally(() => {
        if (this.controller === controller) {
          this.controller = undefined;
          this.task = undefined;
          this.state = "idle";
        }
      });
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.state = "idle";
  }

  async settled(): Promise<void> {
    await this.task;
  }

  private async run(controller: AbortController): Promise<void> {
    const { signal } = controller;
    // Never turn one just-finished retry cycle into an immediate prompt loop.
    this.state = "waiting";
    await this.options.sleep(this.options.delayMs, signal);
    while (!signal.aborted) {
      this.state = "probing";
      this.attempts++;
      let online = false;
      try {
        online = await this.options.probe(signal);
      } catch {
        online = false;
      }
      if (signal.aborted) return;
      if (online) {
        await this.options.onRecovered();
        return;
      }
      this.state = "waiting";
      await this.options.sleep(this.options.delayMs, signal);
    }
  }
}
