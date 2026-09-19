/**
 * 将输入归一化为中国大陆 11 位手机号。
 * 支持 `+86`、`86`、空格和短横线等常见输入形式。
 */
export function normalizeChineseMainlandPhoneNumber(input: string): string {
  const trimmed = input.trim();
  const sanitized = trimmed.replace(/[\s-()]/g, "");
  let normalized = sanitized;

  if (normalized.startsWith("+86")) {
    normalized = normalized.slice(3);
  } else if (normalized.startsWith("86") && normalized.length === 13) {
    normalized = normalized.slice(2);
  }

  if (!/^1[3-9]\d{9}$/.test(normalized)) {
    throw new Error("手机号格式不正确");
  }

  return normalized;
}

/** 根据归一化手机号生成兼容 better-auth 的临时邮箱。 */
export function buildPhoneTempEmail(phoneNumber: string): string {
  return `${phoneNumber}@fenix.com`;
}

/** 基于输入值判断当前成员标识是否看起来像邮箱。 */
export function isEmailIdentifier(value: string): boolean {
  return value.includes("@");
}
