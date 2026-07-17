/**
 * pgcrypto 加密/解密 LiteLLM Key 的工具。
 * 第一期：明文存储（已有环境变量时用 pgp_sym_encrypt）。
 * 后续迁移：将 agent_litellm_key.litellm_key 列类型从 text 改为 bytea。
 */
const ENCRYPTION_KEY = process.env.RCS_SECRET_ENCRYPTION_KEY;

/** 加密存储（调用方在 SQL 中内联使用） */
export function getEncryptionKey(): string | null {
  return ENCRYPTION_KEY ?? null;
}

/** 构建 pgp_sym_encrypt SQL 表达式 */
export function pgpEncryptExpr(plaintext: string): string {
  if (!ENCRYPTION_KEY) return `'${plaintext.replace(/'/g, "''")}'`;
  return `pgp_sym_encrypt('${plaintext.replace(/'/g, "''")}', '${ENCRYPTION_KEY.replace(/'/g, "''")}')`;
}
