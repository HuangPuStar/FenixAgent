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
      code === "DOCKER::SANDBOX_IMAGE_PULL_FAILED",
  };
}
