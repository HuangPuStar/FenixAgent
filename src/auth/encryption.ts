import { randomBytes, createDecipheriv } from "node:crypto";

/** AES-256-GCM 密钥，启动时随机生成 */
const AES_KEY = randomBytes(32);
const ALGORITHM = "aes-256-gcm";
const TAG_LENGTH = 16;
const PREFIX = "AESGCM:";

/** 返回 base64 编码的 AES 密钥供前端加密使用 */
export function getEncryptionKey(): string {
  return AES_KEY.toString("base64");
}

/** 解密 AES-256-GCM 密文，格式 AESGCM:ivBase64.dataBase64 */
export function decryptPassword(encrypted: string): string {
  if (!encrypted.startsWith(PREFIX)) return encrypted;
  const payload = encrypted.slice(PREFIX.length);
  const dot = payload.indexOf(".");
  if (dot === -1) throw new Error("Invalid encrypted password format");

  const iv = Buffer.from(payload.slice(0, dot), "base64");
  const data = Buffer.from(payload.slice(dot + 1), "base64");
  const tag = data.subarray(data.length - TAG_LENGTH);
  const ciphertext = data.subarray(0, data.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, AES_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}
