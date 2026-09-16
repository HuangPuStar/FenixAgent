import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const FORMAT_VERSION = "mgc1";

/**
 * 对模型网关 Virtual Key 做持久化加解密。
 *
 * 密钥由部署配置提供，不在此模块生成或保存；这样服务重启后仍能解密既有映射。
 */
export function createModelGatewayCredentialCipher(rawKey: string) {
  const key = Buffer.from(rawKey, "utf8");
  if (key.length !== 32) {
    throw new Error("credential encryption key must be exactly 32 bytes");
  }

  return {
    encrypt(value: string): string {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [FORMAT_VERSION, iv.toString("base64"), ciphertext.toString("base64"), tag.toString("base64")].join(".");
    },

    decrypt(value: string): string {
      const [version, ivText, ciphertextText, tagText] = value.split(".");
      if (version !== FORMAT_VERSION || !ivText || !ciphertextText || !tagText) {
        throw new Error("unable to decrypt model gateway credential");
      }
      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivText, "base64"));
        decipher.setAuthTag(Buffer.from(tagText, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64")), decipher.final()]).toString(
          "utf8",
        );
      } catch {
        throw new Error("unable to decrypt model gateway credential");
      }
    },
  };
}

export type ModelGatewayCredentialCipher = ReturnType<typeof createModelGatewayCredentialCipher>;
