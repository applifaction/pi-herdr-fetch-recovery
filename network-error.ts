type Diagnostic = {
  type?: unknown;
  error?: { name?: unknown; message?: unknown };
  details?: {
    fallbackTransport?: unknown;
    eventsEmitted?: unknown;
  };
};

type AssistantLike = {
  role?: unknown;
  provider?: unknown;
  api?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  diagnostics?: unknown;
};

export type RecoverableFailureKind = "transport" | "provider";

const TRANSPORT_ERROR_PATTERNS = [
  /\bfetch failed\b/i,
  /\bfailed to fetch\b/i,
  /\bnetwork\s*error\b/i,
  /\bwebsocket error\b/i,
  /\bsocket hang up\b/i,
  /\bconnection (?:reset|refused)\b/i,
  /\btunnel[_ -]destination[_ -]denied\b/i,
  /\b(?:econnreset|econnrefused|enetunreach|ehostunreach|enotfound|eai_again)\b/i,
  /\bdns lookup failed\b/i,
  /\b(?:codex\s+)?sse response headers timed out after \d+ms\b/i,
  /\b(?:headers timeout error|und_err_headers_timeout)\b/i,
  /^(?:typeerror:\s*)?terminated$/im,
];

const RETRYABLE_CODEX_PROCESSING_ERROR = /^Codex error:\s*An error occurred while processing your request\.\s*You can retry your request, or contact us through our help center at help\.openai\.com if the error persists\.$/i;

const TERMINAL_NON_TRANSPORT_PATTERNS = [
  /\b[45]\d\d\b/,
  /\b(?:unauthorized|forbidden|authentication|invalid[_ -]?grant|api key)\b/i,
  /\b(?:rate limit|too many requests|quota|usage limit)\b/i,
  /\b(?:context window|input exceeds|prompt too long)\b/i,
  /\b(?:aborted|cancelled|canceled)\b/i,
];

/** Recognize provider transport failures without treating auth, quota, or model errors as offline. */
export function isNetworkTransportFailure(message: AssistantLike | undefined): boolean {
  if (!message || message.role !== "assistant" || message.stopReason !== "error") return false;

  const terminalError = typeof message.errorMessage === "string" ? message.errorMessage : "";
  // A previous WebSocket transport failure can remain attached after an SSE
  // fallback ends with a terminal auth/quota/request error. The final error wins.
  if (TERMINAL_NON_TRANSPORT_PATTERNS.some((pattern) => pattern.test(terminalError))) {
    return false;
  }

  const diagnostics = Array.isArray(message.diagnostics)
    ? message.diagnostics as Diagnostic[]
    : [];
  const relevantDiagnostics = diagnostics.filter((diagnostic) =>
    !(diagnostic.details?.fallbackTransport === "sse" && diagnostic.details?.eventsEmitted === false));
  if (relevantDiagnostics.some((diagnostic) => diagnostic?.type === "provider_transport_failure")) {
    return true;
  }

  const diagnosticText = relevantDiagnostics.flatMap((diagnostic) => [
    diagnostic?.error?.name,
    diagnostic?.error?.message,
  ]).filter((value): value is string => typeof value === "string");
  const text = [terminalError, ...diagnosticText].join("\n");

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Recognize Codex's explicit retry invitation only when the failed response is
 * empty. Partial text or tool calls make a fresh automatic continuation unsafe.
 */
export function isRetryableProviderFailure(message: AssistantLike | undefined): boolean {
  if (!message || message.role !== "assistant" || message.stopReason !== "error") return false;
  if (message.provider !== "openai-codex" || message.api !== "openai-codex-responses") return false;
  if (!Array.isArray(message.content) || message.content.length !== 0) return false;
  return typeof message.errorMessage === "string"
    && RETRYABLE_CODEX_PROCESSING_ERROR.test(message.errorMessage.trim());
}

export function classifyRecoverableFailure(
  message: AssistantLike | undefined,
): RecoverableFailureKind | undefined {
  if (isNetworkTransportFailure(message)) return "transport";
  if (isRetryableProviderFailure(message)) return "provider";
  return undefined;
}
