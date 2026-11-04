/** Selects the published HTTP contract without affecting independent protocol prefixes. */
export function classifyApiResponse(pathname: string): "v1" | "openai" | "other" {
  if (pathname === "/api/v1/chat/completions") return "openai";
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/") ? "v1" : "other";
}

/** Formats an already classified safe error; callers retain status and diagnostic logging. */
export function formatApiError(url: string, code: string, message: string, status: number) {
  switch (classifyApiResponse(new URL(url, "http://localhost").pathname)) {
    case "v1":
      return { success: false as const, error: { code: code === "unauthorized" ? "UNAUTHORIZED" : code, message } };
    case "openai":
      return {
        error: {
          message,
          type:
            status === 401
              ? "authentication_error"
              : status === 429
                ? "rate_limit_error"
                : status >= 500
                  ? "server_error"
                  : "invalid_request_error",
          param: null,
          code,
        },
      };
    default:
      return { error: { type: code, message } };
  }
}
