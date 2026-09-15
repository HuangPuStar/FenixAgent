interface TrustedOriginsInput {
  trustedOrigins?: string;
  betterAuthUrl?: string;
  rcsBaseUrl?: string;
}

function normalizeOrigin(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    return url.origin;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/** Builds Better Auth trusted origins from explicit config and public service URLs. */
export function buildTrustedOrigins(input: TrustedOriginsInput = {}): string[] {
  const origins = [
    "http://localhost:5173",
    input.betterAuthUrl,
    input.rcsBaseUrl,
    ...(input.trustedOrigins ?? "").split(","),
  ];

  return Array.from(new Set(origins.map(normalizeOrigin).filter((origin): origin is string => Boolean(origin))));
}
