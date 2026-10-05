import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectivityWatcher } from "../recovery-watcher.ts";

test("keeps probing and recovers exactly once", async () => {
  const answers = [false, false, true];
  let recovered = 0;
  let sleeps = 0;
  const watcher = new ConnectivityWatcher({
    delayMs: 1,
    probe: async () => answers.shift() ?? true,
    sleep: async () => { sleeps++; },
    onRecovered: () => { recovered++; },
  });

  watcher.start();
  await watcher.settled();
  assert.equal(watcher.attempts, 3);
  assert.equal(sleeps, 3); // One initial delay, then one after each failed probe.
  assert.equal(recovered, 1);
  assert.equal(watcher.state, "idle");
});

test("rejected recovery callbacks are contained and reported", async () => {
  const errors = [];
  const watcher = new ConnectivityWatcher({
    delayMs: 1,
    sleep: async () => {},
    probe: async () => true,
    onRecovered: async () => { throw new Error("boom"); },
    onError: (error) => errors.push(error),
  });

  watcher.start();
  await watcher.settled();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /boom/);
  assert.equal(watcher.state, "idle");
});

test("cancellation aborts a pending sleep and suppresses recovery", async () => {
  let recovered = 0;
  let release;
  const sleeping = new Promise((resolve) => { release = resolve; });
  const watcher = new ConnectivityWatcher({
    probe: async () => false,
    sleep: async (_ms, signal) => {
      await Promise.race([
        sleeping,
        new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
      ]);
    },
    onRecovered: () => { recovered++; },
  });

  watcher.start();
  await new Promise((resolve) => setImmediate(resolve));
  watcher.cancel();
  release();
  await watcher.settled();
  assert.equal(recovered, 0);
  assert.equal(watcher.state, "idle");
});
