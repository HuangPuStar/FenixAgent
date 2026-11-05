import { expect, test } from "bun:test";
import { redactLogValue } from "../logging/redact";

// 秘密跨越日志截断边界时必须先完整遮蔽，不能因截断而泄漏大部分前缀。
test("redacts deployment secrets before string and error truncation", () => {
  const secret = "abcdefghijklmnopqrstuvwxyz012345";
  for (const value of [
    new Error("x".repeat(2017) + secret),
    { message: "x".repeat(2017) + secret },
    { value: "x".repeat(2017) + secret },
  ]) {
    const text = JSON.stringify(redactLogValue(value, [secret]));
    expect(text).not.toContain(secret.slice(0, 24));
    expect(text).toContain("[REDACTED]");
  }
});
// 已知部署密钥的 URL 编码形式同样不得写入日志。
test("redacts encoded deployment secrets", () => {
  const secret = "example/secret+value";
  expect(JSON.stringify(redactLogValue({ path: encodeURIComponent(secret) }, [secret]))).not.toContain(
    encodeURIComponent(secret),
  );
});
// 重建错误诊断不能重新暴露数据库驱动附带的 SQL、参数或敏感正文。
test("preserves shared database error and credential redaction", () => {
  const error = Object.assign(new Error("INSERT INTO table VALUES(database-secret)"), {
    query: "INSERT",
    params: ["database-secret"],
  });
  const text = JSON.stringify(
    redactLogValue({ error, api_key: "key-secret", environment: { CUSTOM: "env-secret" } }, []),
  );
  for (const secret of ["database-secret", "key-secret", "env-secret"]) expect(text).not.toContain(secret);
  expect(text).toContain("Database operation failed");
});
