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

/** 使用 AES-256-GCM 加密密码，返回 AESGCM:iv.data 格式 */
export async function encryptPassword(password: string): Promise<string> {
  const keyBase64 = await fetchEncryptionKey();
  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(password);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return `AESGCM:${uint8ToBase64(iv)}.${uint8ToBase64(new Uint8Array(encrypted))}`;
}
