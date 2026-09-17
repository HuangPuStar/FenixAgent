import { gcm } from "@noble/ciphers/aes.js";

let cachedKey: string | null = null;
let keyPromise: Promise<string> | null = null;

async function fetchEncryptionKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  if (keyPromise) return keyPromise;

  keyPromise = fetch("/api/auth/encryption-key")
    .then(async (res) => {
      const data = await res.json();
      if (!data.key) throw new Error("Encryption key not available");
      cachedKey = data.key as string;
      return cachedKey;
    })
    .finally(() => {
      keyPromise = null;
    });

  return keyPromise;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 使用 AES-256-GCM 加密密码，返回 AESGCM:iv.ciphertext+tag 格式。
 *  使用 @noble/ciphers 替代 crypto.subtle，兼容 HTTP 环境。 */
export async function encryptPassword(password: string): Promise<string> {
  const keyBase64 = await fetchEncryptionKey();
  const keyBytes = base64ToUint8(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(password);

  // gcm() 输出 = ciphertext + 16-byte auth tag，与 Node.js decipher.setAuthTag 格式一致
  const cipher = gcm(keyBytes, iv);
  const encrypted = cipher.encrypt(plaintext);

  return `AESGCM:${uint8ToBase64(iv)}.${uint8ToBase64(encrypted)}`;
}
