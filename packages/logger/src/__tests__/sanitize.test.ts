import { expect, test } from "bun:test";
import { sanitizeLogText, sanitizeLogValue } from "../sanitize";

// 业务对象必须保留独立字段，同时阻断嵌套凭据与正文进入任何日志出口。
test("日志字段保真、递归脱敏与体积有界", () => {
  const safe = sanitizeLogValue({
    taskId: "task-1",
    attempt: 2,
    nested: { token: "forbidden-value", body: "forbidden-body", status: "ready" },
  });
  expect(safe).toEqual({
    taskId: "task-1",
    attempt: 2,
    nested: { token: "[REDACTED]", body: "[REDACTED]", status: "ready" },
  });
  expect(sanitizeLogText("x".repeat(9000), 8192)).toContain("[truncated:9000]");
});

// 驱动附带 SQL 和参数不能通过 Error 自定义属性泄漏。
test("错误保留类型与堆栈但不展开数据库负载", () => {
  const err = new Error("operation failed");
  expect(sanitizeLogValue(err)).toMatchObject({ type: "Error", message: "operation failed" });
  Object.assign(err, { query: "private-value", params: ["private-value"] });
  expect(JSON.stringify(sanitizeLogValue(err))).not.toContain("private-value");
});

// URL、认证头和连接串不能借自由文本绕过字段脱敏。
test("自由文本删除 query 和凭据", () => {
  const url = new URL("https://example.test/path");
  url.searchParams.set("token", "forbidden-value");
  expect(sanitizeLogText(url.toString())).toBe("https://example.test/path");
  expect(sanitizeLogText("Bearer forbidden-value")).not.toContain("forbidden-value");
});
