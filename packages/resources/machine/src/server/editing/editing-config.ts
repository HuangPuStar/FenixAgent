/** Deployment projection for the replaceable editing service. */
export interface MachineEditingConfig {
  readonly publicUrl: string;
  readonly jwtSecret: string;
  readonly baseUrl: string;
}

function trustedHttpUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Office ${field}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid Office ${field}`);
  }
  return url.toString().replace(/\/$/, "");
}

/** Both Office variables are optional together; partial configuration fails before serving requests. */
export function parseMachineEditingConfig(input: Partial<MachineEditingConfig>): MachineEditingConfig | null {
  const publicUrl = input.publicUrl?.trim() ?? "";
  const jwtSecret = input.jwtSecret ?? "";
  if (!publicUrl && !jwtSecret) return null;
  if (!publicUrl || jwtSecret.trim().length < 32) {
    throw new Error("Office requires a document service URL and a random JWT secret of at least 32 characters");
  }
  return {
    publicUrl: trustedHttpUrl(publicUrl, "service URL"),
    jwtSecret,
    baseUrl: trustedHttpUrl(input.baseUrl ?? "", "callback base URL"),
  };
}
