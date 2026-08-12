export type ChatErrorCode = "guardrail_denied" | "internal_error";

export interface ChatError {
  code: ChatErrorCode;
  message: string;
  explanation?: string;
  guard?: string;
  classification?: string;
}

const FALLBACK_MESSAGE = "Unable to generate a plan. Please try again later!";

/**
 * AI SDK's HttpChatTransport throws `new Error(await response.text())` for any
 * non-2xx response, so error.message is the raw response body. /api/chat returns
 * JSON for both guardrail denials (400) and internal errors (500), but a crash
 * before the route handler (e.g. Elasticsearch down at request parse time) gives
 * a Next HTML error page — anything unparseable degrades to a generic failure.
 */
export function parseChatError(
  error: Error | undefined
): ChatError | undefined {
  if (!error) {
    return undefined;
  }

  try {
    const body = JSON.parse(error.message);
    if (body && typeof body === "object" && typeof body.message === "string") {
      return {
        code:
          body.code === "guardrail_denied" ? "guardrail_denied" : "internal_error",
        message: body.message,
        explanation:
          typeof body.explanation === "string" ? body.explanation : undefined,
        guard: typeof body.guard === "string" ? body.guard : undefined,
        classification:
          typeof body.classification === "string"
            ? body.classification
            : undefined,
      };
    }
  } catch {
    // Not JSON (e.g. a Next HTML error page) — fall through to the generic failure.
    return { code: "internal_error", message: FALLBACK_MESSAGE };
  }

  return { code: "internal_error", message: FALLBACK_MESSAGE };
}
