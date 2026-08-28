import { createHash, timingSafeEqual } from "node:crypto";

const TOKEN_VERSION = "osn1";

export interface GeneratedNodeToken {
  value: string;
  hash: string;
  prefix: string;
}

/** Creates a scoped token whose server id is recoverable without storing plaintext metadata. */
export function createNodeRegistrationToken(serverId: string): GeneratedNodeToken {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(serverId)) throw new Error("invalid server id");
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const value = `${TOKEN_VERSION}.${encode(serverId)}.${Buffer.from(secretBytes).toString("base64url")}`;
  return { value, hash: hashNodeRegistrationToken(value), prefix: value.slice(0, 12) };
}

export function parseNodeRegistrationToken(value: string): { serverId: string } | undefined {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !parts[1] || !parts[2]) return;
  try {
    const serverId = new TextDecoder().decode(Buffer.from(parts[1], "base64url"));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(serverId) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return;
    return { serverId };
  } catch {
    return;
  }
}

export function hashNodeRegistrationToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function verifyNodeRegistrationToken(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashNodeRegistrationToken(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
