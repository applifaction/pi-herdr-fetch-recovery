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
  stopReason?: unknown;
  errorMessage?: unknown;
  diagnostics?: unknown;
};

const TRANSPORT_ERROR_PATTERNS = [
  /\bfetch failed\b/i,
  /\bfailed to fetch\b/i,
  /\bnetwork\s*error\b/i,
  /\bwebsocket error\b/i,
  /\bsocket hang up\b/i,
  /\bconnection (?:reset|refused)\b/i,
  /\b(?:econnreset|econnrefused|enetunreach|ehostunreach|enotfound|eai_again)\b/i,
  /\bdns lookup failed\b/i,
  /\b(?:codex\s+)?sse response headers timed out after \d+ms\b/i,
  /\b(?:headers timeout error|und_err_headers_timeout)\b/i,
  /^(?:typeerror:\s*)?terminated$/im,
];

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
