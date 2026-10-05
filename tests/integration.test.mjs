import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import installFetchRecovery from "../index.ts";

const fetchFailure = {
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: "fetch failed",
};
const success = { role: "assistant", content: [], stopReason: "stop" };
const entry = (message) => ({ type: "message", message });

async function waitFor(predicate, message = "expected condition") {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

async function harness(t, { mode = "tui", branch = [], idle = true, probeUrl } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fetch-recovery-integration-"));
  const socketPath = join(directory, "api.sock");
  const reports = [];
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      reports.push(request);
      socket.end(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const envNames = [
    "HERDR_ENV",
    "HERDR_SOCKET_PATH",
    "HERDR_PANE_ID",
    "PI_FETCH_RECOVERY_URL",
    "PI_FETCH_RECOVERY_POLL_MS",
    "PI_FETCH_RECOVERY_PROBE_TIMEOUT_MS",
    "PI_FETCH_RECOVERY_MAX_CONTINUES",
  ];
  const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PANE_ID: "test:p1",
    PI_FETCH_RECOVERY_POLL_MS: "10",
    PI_FETCH_RECOVERY_PROBE_TIMEOUT_MS: "20",
    PI_FETCH_RECOVERY_MAX_CONTINUES: "3",
  });
  if (probeUrl) process.env.PI_FETCH_RECOVERY_URL = probeUrl;
  else delete process.env.PI_FETCH_RECOVERY_URL;

  let online = false;
  const fetchedUrls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchedUrls.push(String(url));
    if (!online) throw new TypeError("fetch failed");
    return new Response(null, { status: 204 });
  };

  const handlers = new Map();
  const busHandlers = new Map();
  const commands = new Map();
  const notifications = [];
  const statuses = new Map();
  const sent = [];
  let pending = false;
  let currentBranch = branch;
  let currentProviderUrl = "https://provider.example.test/v1";
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    model: { provider: "fixture", id: "fixture-model" },
    modelRegistry: { getProvider: () => ({ baseUrl: currentProviderUrl }) },
    sessionManager: { getBranch: () => currentBranch },
    ui: {
      theme: { fg: (_name, text) => text },
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (key, value) => {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
    },
  };
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    sendUserMessage(message) { sent.push(message); },
    events: {
      on(name, handler) {
        busHandlers.set(name, [...(busHandlers.get(name) ?? []), handler]);
        return () => busHandlers.set(name, (busHandlers.get(name) ?? []).filter((item) => item !== handler));
      },
      emit(name, data) {
        for (const handler of busHandlers.get(name) ?? []) handler(data);
      },
    },
  };
  installFetchRecovery(pi);

  const emit = async (type, fields = {}) => {
    for (const handler of handlers.get(type) ?? []) await handler({ type, ...fields }, ctx);
  };

  t.after(async () => {
    await emit("session_shutdown", { reason: "quit" });
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  return {
    ctx,
    commands,
    emit,
    emitBus(name, data) { pi.events.emit(name, data); },
    onBus(name, handler) { return pi.events.on(name, handler); },
    fetchedUrls,
    notifications,
    reports,
    sent,
    statuses,
    setBranch(value) { currentBranch = value; },
    setIdle(value) { idle = value; },
    setOnline(value) { online = value; },
    setPending(value) { pending = value; },
    setProviderUrl(value) { currentProviderUrl = value; },
    async writeChildSession(name, message) {
      const sessionPath = join(directory, `${name}.jsonl`);
      await writeFile(sessionPath, [
        { type: "session", version: 3, id: `session-${name}`, timestamp: new Date().toISOString(), cwd: directory },
        { type: "message", id: "user0001", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "task" } },
        { type: "message", id: "assistant1", parentId: "user0001", timestamp: new Date().toISOString(), message },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");
      return sessionPath;
    },
    async start() {
      await emit("session_start", { reason: "startup" });
      await delay(20);
    },
    async token() {
      await delay(20);
      return reports.filter((request) => request.method === "pane.report_metadata")
        .at(-1)?.params.tokens?.pica_fetch_recovery;
    },
  };
}

async function settleFetchFailure(h, attempts = 4) {
  h.setIdle(false);
  await h.emit("agent_start");
  for (let attempt = 0; attempt < attempts; attempt++) {
    await h.emit("message_end", { message: fetchFailure });
  }
  await h.emit("agent_end", { messages: Array(attempts).fill(fetchFailure) });
  h.setIdle(true);
  await h.emit("agent_settled");
}

test("waits only after settlement, publishes Herdr error, then sends one continue", async (t) => {
  const h = await harness(t);
  await h.start();
  h.setIdle(false);
  await h.emit("agent_start");
  for (let attempt = 0; attempt < 4; attempt++) {
    await h.emit("message_end", { message: fetchFailure });
    await h.emit("agent_end", { messages: [fetchFailure] });
  }
  assert.deepEqual(h.sent, []);
  assert.equal(await h.token(), null);

  h.setIdle(true);
  await h.emit("agent_settled");
  assert.equal(await h.token(), "× Fetch failed");
  assert.match(h.statuses.get("fetch-recovery"), /waiting for internet/);

  h.setOnline(true);
  await waitFor(() => h.sent.length === 1, "continue was not submitted");
  assert.deepEqual(h.sent, ["continue"]);
  assert.equal(await h.token(), "× Fetch failed", "error remains until Pi accepts the prompt");
  await h.emit("session_before_compact", { reason: "threshold", signal: new AbortController().signal });
  assert.equal(await h.token(), "× Fetch failed", "automatic compaction preserves the pending handoff");

  await h.emit("agent_settled");
  await delay(30);
  assert.deepEqual(h.sent, ["continue"], "same settled generation must not send twice");
  await h.emit("before_agent_start", { prompt: "continue" });
  assert.equal(await h.token(), null);
  assert.equal(h.statuses.has("fetch-recovery"), false);
});

test("manual input cancels the watcher and wins over automatic continuation", async (t) => {
  const h = await harness(t);
  await h.start();
  await settleFetchFailure(h);
  assert.equal(await h.token(), "× Fetch failed");
  await h.emit("input", { source: "interactive", text: "I will handle this" });
  h.setOnline(true);
  await delay(40);
  assert.deepEqual(h.sent, []);
  assert.equal(await h.token(), null);
});

test("manual compaction cancels a pending recovery handoff", async (t) => {
  const h = await harness(t);
  await h.start();
  await settleFetchFailure(h);
  assert.equal(await h.token(), "× Fetch failed");
  await h.emit("session_before_compact", { reason: "manual", signal: new AbortController().signal });
  h.setOnline(true);
  await delay(40);
  assert.deepEqual(h.sent, []);
  assert.equal(await h.token(), null);
});

test("automatic compaction does not erase a transport failure before settlement", async (t) => {
  const h = await harness(t);
  await h.start();
  h.setIdle(false);
  await h.emit("agent_start");
  await h.emit("message_end", { message: fetchFailure });
  await h.emit("session_before_compact", { reason: "threshold", signal: new AbortController().signal });
  h.setIdle(true);
  await h.emit("agent_settled");
  assert.equal(await h.token(), "× Fetch failed");
});

test("successful and unrelated failures never arm recovery", async (t) => {
  const staleFallbackDiagnostic = {
    type: "provider_transport_failure",
    error: { message: "WebSocket error" },
    details: { fallbackTransport: "sse", eventsEmitted: false },
  };
  for (const message of [
    success,
    { ...fetchFailure, errorMessage: "401 Unauthorized" },
    { ...fetchFailure, errorMessage: "401 Unauthorized", diagnostics: [staleFallbackDiagnostic] },
  ]) {
    await t.test(message.errorMessage ?? "success", async (t) => {
      const h = await harness(t);
      await h.start();
      h.setIdle(false);
      await h.emit("agent_start");
      await h.emit("message_end", { message });
      h.setIdle(true);
      await h.emit("agent_settled");
      h.setOnline(true);
      await delay(30);
      assert.deepEqual(h.sent, []);
      assert.equal(await h.token(), null);
    });
  }
});

test("reload restores a terminal fetch failure and pending work suppresses continue", async (t) => {
  const h = await harness(t, { branch: [entry(fetchFailure)] });
  h.setPending(true);
  await h.start();
  assert.equal(await h.token(), null);
  h.setPending(false);
  await h.emit("session_tree");
  assert.equal(await h.token(), "× Fetch failed");
  h.setPending(true);
  h.setOnline(true);
  await delay(40);
  assert.deepEqual(h.sent, []);
  assert.equal(await h.token(), null);
});

test("uses the current provider endpoint when the model changes before failure", async (t) => {
  const h = await harness(t);
  await h.start();
  h.setProviderUrl("https://new-provider.example.test/api");
  await h.emit("model_select", { source: "set", model: h.ctx.model });
  await settleFetchFailure(h);
  await waitFor(() => h.fetchedUrls.length > 0, "provider probe did not run");
  assert.equal(h.fetchedUrls.at(-1), "https://new-provider.example.test/api");
});

test("caps generation-spanning automatic continuations during a persistent API failure", async (t) => {
  const h = await harness(t);
  await h.start();
  h.setOnline(true); // Health endpoint is reachable while the simulated model request keeps failing.

  for (let cycle = 0; cycle < 4; cycle++) {
    if (cycle > 0) await h.emit("before_agent_start", { prompt: "continue" });
    await settleFetchFailure(h);
    if (cycle < 3) await waitFor(() => h.sent.length === cycle + 1, `missing continuation ${cycle + 1}`);
  }

  await delay(100);
  assert.deepEqual(h.sent, ["continue", "continue", "continue"]);
  assert.equal(await h.token(), "× Fetch failed");
  assert.match(h.statuses.get("fetch-recovery"), /automatic recovery paused/);
});

test("parent revives a failed pi-subagents child through acknowledged RPC", async (t) => {
  const h = await harness(t);
  await h.start();
  const sessionPath = await h.writeChildSession("failed-child", fetchFailure);
  const resumeRequests = [];
  h.onBus("subagents:rpc:v1:request", (request) => {
    resumeRequests.push(request);
    queueMicrotask(() => h.emitBus(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: { runId: "revived-run" },
    }));
  });

  h.emitBus("subagent:async-complete", {
    runId: "failed-run",
    results: [{ index: 0, status: "failed", success: false, sessionPath }],
  });
  await waitFor(() => h.reports.some(
    (request) => request.params?.tokens?.pica_fetch_recovery === "× Fetch failed"));
  assert.equal(await h.token(), "× Fetch failed");
  assert.equal(resumeRequests.length, 0);

  h.setOnline(true);
  await waitFor(() => resumeRequests.length === 1, "subagent resume RPC was not sent");
  assert.equal(resumeRequests[0].method, "resume");
  assert.deepEqual(resumeRequests[0].params, {
    id: "failed-run",
    index: 0,
    message: "continue",
  });
  await waitFor(() => h.reports.at(-1)?.params?.tokens?.pica_fetch_recovery === null);
});

test("foreground pi-subagents completion uses run and task index for revival", async (t) => {
  const h = await harness(t);
  await h.start();
  const sessionFile = await h.writeChildSession("foreground-child", fetchFailure);
  const requests = [];
  h.onBus("subagents:rpc:v1:request", (request) => {
    requests.push(request);
    queueMicrotask(() => h.emitBus(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: {},
    }));
  });
  h.emitBus("subagent:foreground-complete", {
    runId: "foreground-run",
    taskIndex: 2,
    state: "failed",
    sessionFile,
  });
  await waitFor(() => h.reports.some(
    (request) => request.params?.tokens?.pica_fetch_recovery === "× Fetch failed"));
  h.setOnline(true);
  await waitFor(() => requests.length === 1);
  assert.deepEqual(requests[0].params, {
    id: "foreground-run",
    index: 2,
    message: "continue",
  });
});

test("headless modes neither watch nor publish to the parent Herdr pane", async (t) => {
  for (const mode of ["rpc", "json", "print"]) {
    await t.test(mode, async (t) => {
      const h = await harness(t, { mode, branch: [entry(fetchFailure)] });
      await h.start();
      await settleFetchFailure(h);
      h.setOnline(true);
      await delay(30);
      assert.deepEqual(h.sent, []);
      assert.equal(h.reports.length, 0);
    });
  }
});

test("status command reports the live watcher without a model call", async (t) => {
  const h = await harness(t);
  await h.start();
  await settleFetchFailure(h);
  assert.equal(await h.token(), "× Fetch failed");
  await h.commands.get("fetch-recovery-status").handler("", h.ctx);
  assert.match(h.notifications.at(-1).message, /v0\.1\.0 loaded; active: true; waiting: true/);
  assert.match(h.notifications.at(-1).message, /Herdr: acknowledged/);
  assert.match(h.notifications.at(-1).message, /provider\.example\.test\/v1/);
});
