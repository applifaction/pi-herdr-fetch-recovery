import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FETCH_FAILED_LABEL,
  FETCH_RECOVERY_TOKEN,
  MetadataPublisher,
} from "../metadata.ts";

const enabled = process.env.HERDR_INTEGRATION === "1";

async function waitFor(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate() && Date.now() < deadline) await delay(25);
  assert.ok(await predicate(), "condition did not become true before timeout");
}

function rpc(socketPath, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `smoke:${method}`;
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timeout = setTimeout(() => finish(new Error(`RPC timeout: ${method}`)), 4_000);
    const finish = (error, result) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    socket.on("error", finish);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (data) => {
      buffer += data;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== id) return finish(new Error("Unexpected RPC response id"));
        if (response.error) return finish(new Error(JSON.stringify(response.error)));
        finish(undefined, response.result);
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function stopProcess(process) {
  if (!process || process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => process.once("exit", resolve)),
    delay(2_000).then(() => process.kill("SIGKILL")),
  ]);
}

test("real Herdr server accepts, clears, and expires the leased token", { skip: !enabled }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fetch-recovery-herdr-"));
  const runtime = join(root, "runtime");
  const socketPath = join(root, "api.sock");
  const clientSocketPath = join(root, "client.sock");
  const configPath = join(root, "config.toml");
  const logPath = join(root, "server.log");
  await mkdir(runtime, { recursive: true });
  await chmod(runtime, 0o700);
  await writeFile(configPath, `onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n`);

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")));
  Object.assign(env, {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_RUNTIME_DIR: runtime,
    HERDR_SOCKET_PATH: socketPath,
    HERDR_CLIENT_SOCKET_PATH: clientSocketPath,
    HERDR_CONFIG_PATH: configPath,
  });

  const server = spawn("herdr", ["server"], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr.on("data", (data) => { stderr += data; });
  t.after(async () => {
    try { await rpc(socketPath, "server.stop"); } catch {}
    await stopProcess(server);
    await rm(root, { recursive: true, force: true });
  });

  await waitFor(async () => {
    try { await rpc(socketPath, "ping"); return true; } catch { return false; }
  });
  assert.equal(server.exitCode, null, stderr || await readFile(logPath, "utf8").catch(() => ""));

  const workspace = await rpc(socketPath, "workspace.create", { cwd: root, label: "fixtures", focus: true });
  const tab = await rpc(socketPath, "tab.create", {
    workspace_id: workspace.workspace.workspace_id,
    label: "FETCH-RECOVERY",
    cwd: root,
    focus: false,
  });
  const paneId = tab.root_pane.pane_id;
  await rpc(socketPath, "pane.report_agent", {
    pane_id: paneId,
    source: "herdr:pi",
    agent: "pi",
    state: "idle",
  });

  const publisher = new MetadataPublisher(socketPath, paneId, {
    ttlMs: 300,
    refreshMs: 50,
    timeoutMs: 500,
  });
  await publisher.set(true);
  let pane = (await rpc(socketPath, "pane.get", { pane_id: paneId })).pane;
  assert.equal(pane.tokens[FETCH_RECOVERY_TOKEN], FETCH_FAILED_LABEL);
  await delay(350); // Renewal keeps the shorter test lease alive.
  pane = (await rpc(socketPath, "pane.get", { pane_id: paneId })).pane;
  assert.equal(pane.tokens[FETCH_RECOVERY_TOKEN], FETCH_FAILED_LABEL);
  await publisher.close();
  pane = (await rpc(socketPath, "pane.get", { pane_id: paneId })).pane;
  assert.equal(FETCH_RECOVERY_TOKEN in (pane.tokens ?? {}), false);

  const metadataUrl = pathToFileURL(join(fileURLToPath(new URL("..", import.meta.url)), "metadata.ts")).href;
  const script = `
    import { MetadataPublisher } from ${JSON.stringify(metadataUrl)};
    const publisher = new MetadataPublisher(${JSON.stringify(socketPath)}, ${JSON.stringify(paneId)},
      { ttlMs: 150, refreshMs: 10000, timeoutMs: 500 });
    await publisher.set(true);
    if (publisher.status !== "acknowledged") process.exit(2);
  `;
  const crashPublisher = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const crashError = [];
  crashPublisher.stderr.on("data", (data) => crashError.push(data));
  const code = await new Promise((resolve) => crashPublisher.once("exit", resolve));
  assert.equal(code, 0, Buffer.concat(crashError).toString());
  pane = (await rpc(socketPath, "pane.get", { pane_id: paneId })).pane;
  assert.equal(pane.tokens[FETCH_RECOVERY_TOKEN], FETCH_FAILED_LABEL);
  await delay(300);
  pane = (await rpc(socketPath, "pane.get", { pane_id: paneId })).pane;
  assert.equal(FETCH_RECOVERY_TOKEN in (pane.tokens ?? {}), false);
});
