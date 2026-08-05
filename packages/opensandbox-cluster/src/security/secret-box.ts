import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/ciphers/utils.js";

const VERSION = "v1";
const NONCE_LENGTH = 12;

export function createSecretBox(key: Uint8Array) {
  if (key.length !== 32) throw new Error("secret box key must be 32 bytes");

  return {
    encryptApiKey(value: string): string {
      const nonce = randomBytes(NONCE_LENGTH);
      const ciphertext = gcm(key, nonce).encrypt(new TextEncoder().encode(value));
      return [VERSION, encode(nonce), encode(ciphertext)].join(".");
    },
    decryptApiKey(value: string): string {
      const [version, nonceText, ciphertextText] = value.split(".");
      if (version !== VERSION || !nonceText || !ciphertextText) throw new Error("invalid encrypted API key format");
      try {
        const plaintext = gcm(key, decode(nonceText)).decrypt(decode(ciphertextText));
        return new TextDecoder().decode(plaintext);
      } catch {
        throw new Error("unable to decrypt OpenSandbox API key");
      }
    },
  };
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export type SecretBox = ReturnType<typeof createSecretBox>;
