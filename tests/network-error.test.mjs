import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRecoverableFailure,
  isNetworkTransportFailure,
  isRetryableProviderFailure,
} from "../network-error.ts";

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

test("recognizes narrow socket, DNS, and provider timeout failures", () => {
  for (const message of [
    "TypeError: Failed to fetch",
    "NetworkError when attempting to fetch resource",
    "WebSocket error",
    "socket hang up",
    "connect ECONNREFUSED 127.0.0.1",
    "getaddrinfo EAI_AGAIN api.example.com",
    "Codex SSE response headers timed out after 300000ms",
    "Retry failed after 3 attempts: Codex SSE response headers timed out after 300000ms",
    "terminated",
    "TypeError: terminated",
  ]) {
    assert.equal(isNetworkTransportFailure(assistant(message)), true, message);
  }
});

test("recognizes only empty retryable Codex processing failures as provider recovery", () => {
  const retryable = assistant(
    "Codex error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.",
    { provider: "openai-codex", api: "openai-codex-responses", content: [] },
  );
  assert.equal(isRetryableProviderFailure(retryable), true);
  assert.equal(classifyRecoverableFailure(retryable), "provider");
  assert.equal(isNetworkTransportFailure(retryable), false);

  assert.equal(isRetryableProviderFailure({
    ...retryable,
    content: [{ type: "text", text: "partial response" }],
  }), false, "partial responses are not safe to continue automatically");
  assert.equal(isRetryableProviderFailure({ ...retryable, provider: "other" }), false);
  assert.equal(isRetryableProviderFailure(assistant("Codex response failed", {
    provider: "openai-codex",
    api: "openai-codex-responses",
    content: [],
  })), false);
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
    assistant("Generation terminated due to content policy"),
    { role: "assistant", stopReason: "aborted", errorMessage: "fetch failed" },
    { role: "assistant", stopReason: "stop", errorMessage: "fetch failed" },
    { role: "toolResult", isError: true, errorMessage: "fetch failed" },
  ]) {
    assert.equal(isNetworkTransportFailure(message), false);
  }
});
