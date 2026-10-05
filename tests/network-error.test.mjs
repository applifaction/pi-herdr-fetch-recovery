import assert from "node:assert/strict";
import { test } from "node:test";
import { isNetworkTransportFailure } from "../network-error.ts";

const assistant = (errorMessage, extra = {}) => ({
  role: "assistant",
  stopReason: "error",
  errorMessage,
  ...extra,
});

test("recognizes the real fetch failure and terminal provider diagnostics", () => {
  assert.equal(isNetworkTransportFailure(assistant("fetch failed")), true);
  assert.equal(isNetworkTransportFailure(assistant("other", {
    diagnostics: [{ type: "provider_transport_failure", error: { message: "WebSocket error" } }],
  })), true);
  assert.equal(isNetworkTransportFailure(assistant("fetch failed", {
    diagnostics: [{
      type: "provider_transport_failure",
      error: { message: "WebSocket error" },
      details: { fallbackTransport: "sse", eventsEmitted: false },
    }],
  })), true);
});

test("recognizes narrow socket and DNS failures", () => {
  for (const message of [
    "TypeError: Failed to fetch",
    "NetworkError when attempting to fetch resource",
    "WebSocket error",
    "socket hang up",
    "connect ECONNREFUSED 127.0.0.1",
    "getaddrinfo EAI_AGAIN api.example.com",
  ]) {
    assert.equal(isNetworkTransportFailure(assistant(message)), true, message);
  }
});

test("does not auto-continue auth, quota, context, abort, or successful responses", () => {
  for (const message of [
    assistant("401 Unauthorized"),
    assistant("Network error: 401 Unauthorized"),
    assistant("401 Unauthorized", {
      diagnostics: [{
        type: "provider_transport_failure",
        error: { message: "WebSocket error" },
        details: { fallbackTransport: "sse", eventsEmitted: false },
      }],
    }),
    assistant("429 rate limit exceeded"),
    assistant("Network error: 503 Service Unavailable"),
    assistant("insufficient_quota"),
    assistant("input exceeds the context window"),
    { role: "assistant", stopReason: "aborted", errorMessage: "fetch failed" },
    { role: "assistant", stopReason: "stop", errorMessage: "fetch failed" },
    { role: "toolResult", isError: true, errorMessage: "fetch failed" },
  ]) {
    assert.equal(isNetworkTransportFailure(message), false);
  }
});
