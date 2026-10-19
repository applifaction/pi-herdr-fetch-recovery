import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  FETCH_FAILED_LABEL,
  FETCH_RECOVERY_TOKEN,
  MetadataPublisher,
  WAITING_FOR_INTERNET_LABEL,
} from "../metadata.ts";

async function server(t, respond) {
  const directory = await mkdtemp(join(tmpdir(), "fetch-recovery-meta-"));
  const path = join(directory, "api.sock");
  const requests = [];
  const sockets = new Set();
  const instance = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      requests.push(request);
      respond(socket, request, requests.length);
    });
  });
  await new Promise((resolve) => instance.listen(path, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => instance.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { path, requests };
}

const acknowledge = (socket, request) => socket.end(
  `${JSON.stringify({ id: request.id, result: { type: "pane_metadata_reported" } })}\n`,
);

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), "expected condition within deadline");
}

test("publishes and clears a leased display-only Herdr token with fragmented acknowledgements", async (t) => {
  assert.equal(FETCH_FAILED_LABEL, WAITING_FOR_INTERNET_LABEL);
  const fixture = await server(t, (socket, request) => {
    socket.write(JSON.stringify({ id: request.id, result: {} }));
    setTimeout(() => socket.end("\n"), 5);
  });
  const publisher = new MetadataPublisher(fixture.path, "test:p1", { refreshMs: 10_000 });
  await publisher.set(true);
  const request = fixture.requests[0];
  assert.equal(request.method, "pane.report_metadata");
  assert.equal(request.params.source, "pi:fetch-recovery");
  assert.equal(request.params.agent, "pi");
  assert.equal(request.params.applies_to_source, "herdr:pi");
  assert.ok(request.params.ttl_ms > 0);
  assert.deepEqual(request.params.tokens, {
    [FETCH_RECOVERY_TOKEN]: "⏳ Waiting for Internet",
  });
  assert.equal(request.params.state, undefined);
  assert.equal(request.params.state_labels, undefined);
  assert.equal(publisher.status, "acknowledged");
  await publisher.close();
  assert.deepEqual(fixture.requests.at(-1).params.tokens, { [FETCH_RECOVERY_TOKEN]: null });
});

test("retries rejected updates and later refresh recovers", async (t) => {
  let reject = true;
  const fixture = await server(t, (socket, request) => reject
    ? socket.end(`${JSON.stringify({ id: request.id, error: { code: "busy" } })}\n`)
    : acknowledge(socket, request));
  const publisher = new MetadataPublisher(fixture.path, "test:p1", { refreshMs: 30, timeoutMs: 25 });
  t.after(() => publisher.close());
  await publisher.set(true);
  assert.equal(publisher.status, "failed");
  reject = false;
  await waitFor(() => publisher.status === "acknowledged");
  assert.equal(
    fixture.requests.at(-1).params.tokens[FETCH_RECOVERY_TOKEN],
    WAITING_FOR_INTERNET_LABEL,
  );
});

test("failed clears remain retryable instead of being cached as success", async (t) => {
  let rejectClear = true;
  const fixture = await server(t, (socket, request) =>
    request.params.tokens[FETCH_RECOVERY_TOKEN] === null && rejectClear
      ? socket.end(`${JSON.stringify({ id: request.id, error: { code: "busy" } })}\n`)
      : acknowledge(socket, request));
  const publisher = new MetadataPublisher(fixture.path, "test:p1", { refreshMs: 30, timeoutMs: 25 });
  t.after(() => publisher.close());
  await publisher.set(true);
  await publisher.set(false);
  assert.equal(publisher.status, "failed");
  rejectClear = false;
  await waitFor(() => publisher.status === "acknowledged");
  assert.equal(fixture.requests.at(-1).params.tokens[FETCH_RECOVERY_TOKEN], null);
});

test("mismatched IDs and hung sockets are bounded failures", async (t) => {
  for (const outcome of ["mismatch", "hang"]) {
    await t.test(outcome, async (t) => {
      const fixture = await server(t, (socket) => {
        if (outcome === "mismatch") socket.end('{"id":"other","result":{}}\n');
      });
      const publisher = new MetadataPublisher(fixture.path, "test:p1", { refreshMs: 10_000, timeoutMs: 20 });
      await publisher.set(true);
      assert.equal(publisher.status, "failed");
      await publisher.close();
    });
  }
});

test("rapid transitions preserve the newest state and shutdown leaves a clear", async (t) => {
  const fixture = await server(t, (socket, request) => setTimeout(() => acknowledge(socket, request), 5));
  const publisher = new MetadataPublisher(fixture.path, "test:p1", { refreshMs: 10_000 });
  await Promise.all([publisher.set(true), publisher.set(false), publisher.set(true)]);
  assert.equal(
    fixture.requests.at(-1).params.tokens[FETCH_RECOVERY_TOKEN],
    WAITING_FOR_INTERNET_LABEL,
  );
  await publisher.close();
  assert.equal(fixture.requests.at(-1).params.tokens[FETCH_RECOVERY_TOKEN], null);
  const sequences = fixture.requests.map((request) => request.params.seq);
  assert.ok(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]));
});
