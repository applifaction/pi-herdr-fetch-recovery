import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PROBE_URL,
  probeConnectivity,
  resolveProbeUrl,
} from "../connectivity.ts";

function context({ model, provider } = {}) {
  return {
    model,
    modelRegistry: { getProvider: () => provider },
  };
}

test("probe URL prefers explicit config, then provider origin, then fallback", () => {
  const previous = process.env.PI_FETCH_RECOVERY_URL;
  try {
    process.env.PI_FETCH_RECOVERY_URL = "https://health.example.test/ping";
    assert.equal(resolveProbeUrl(context()), "https://health.example.test/ping");
    delete process.env.PI_FETCH_RECOVERY_URL;
    assert.equal(resolveProbeUrl(context({
      model: { provider: "example" },
      provider: { baseUrl: "https://api.example.test/v1/responses?secret=drop" },
    })), "https://api.example.test/v1/responses");
    assert.equal(resolveProbeUrl(context()), DEFAULT_PROBE_URL);
  } finally {
    if (previous === undefined) delete process.env.PI_FETCH_RECOVERY_URL;
    else process.env.PI_FETCH_RECOVERY_URL = previous;
  }
});

test("2xx and ordinary 4xx prove reachability while redirects, transient 4xx, and 5xx stay offline", async () => {
  for (const [status, expected] of [
    [204, true], [302, false], [401, true], [404, true], [407, false], [408, false], [429, false], [503, false],
  ]) {
    const controller = new AbortController();
    const result = await probeConnectivity("https://example.test/", controller.signal, {
      fetchFn: async () => new Response(null, { status }),
    });
    assert.equal(result, expected, String(status));
  }

  const result = await probeConnectivity("https://example.test/", new AbortController().signal, {
    fetchFn: async () => { throw new TypeError("fetch failed"); },
  });
  assert.equal(result, false);
});

test("aborted probes do not fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  assert.equal(await probeConnectivity("https://example.test/", controller.signal, {
    fetchFn: async () => { called = true; return new Response(null, { status: 204 }); },
  }), false);
  assert.equal(called, false);
});
