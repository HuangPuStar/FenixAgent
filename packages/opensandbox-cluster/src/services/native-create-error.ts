/** Classify a completed rejection without treating transport failures as proof of absence. */
export async function nativeCreateError(response: Pick<Response, "status" | "json">, secrets: string[] = []) {
  let code = "";
  let message = `native create HTTP ${response.status}`;
  try {
    const value = (await response.json()) as {
      detail?: { code?: unknown; message?: unknown };
      error?: { code?: unknown; message?: unknown };
      code?: unknown;
      message?: unknown;
    } | null;
    const detail = value?.detail ?? value?.error ?? value;
    if (typeof detail?.code === "string") code = detail.code;
    if (typeof detail?.message === "string") message = detail.message;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const dockerRejected = dockerCreateRejected(code, message);
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, "[redacted]");
  // Node errors can include authenticated registry URLs or credential-bearing command arguments.
  message = Array.from(message.replace(/https?:\/\/\S+/g, "[node URL]"), (character) =>
    character.charCodeAt(0) < 32 ? " " : character,
  )
    .join("")
    .slice(0, 500);
  return {
    message,
    rejected:
      (response.status >= 400 && response.status < 500 && ![408, 499].includes(response.status)) ||
      code === "DOCKER::SANDBOX_IMAGE_PULL_FAILED" ||
      dockerRejected,
  };
}

/** A Docker create rejection precedes container creation; start/transport failures may leave one running. */
function dockerCreateRejected(code: string, message: string): boolean {
  if (code !== "DOCKER::SANDBOX_START_FAILED") return false;
  // OpenSandbox wraps Docker API validation failures in HTTP 500 with this shared start-failure code.
  const rejection = message.match(
    /^Failed to create or start container: (4\d{2}) Client Error for (?:https?|http\+docker|http\+unix):\/\/[^/\s]+\/(?:v\d+(?:\.\d+)?\/)?containers\/create(?:\?[^\s]*)?: /,
  );
  return rejection !== null && !["408", "499"].includes(rejection[1]!);
}
