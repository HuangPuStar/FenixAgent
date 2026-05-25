import { describe, expect, it } from "bun:test";

// 复制 task.ts 内部验证逻辑进行纯单元测试（private 函数无法直接 import）
// 覆盖 validateCron、normalizeTimezone、validateTaskInput 的边界场景

function validateCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "cron 表达式必须为 5 字段（分 时 日 月 周）";
  const validPattern = /^[\d*/?\-,LW#]+$/;
  for (const part of parts) {
    if (!validPattern.test(part)) return `cron 字段 "${part}" 包含非法字符`;
  }
  return null;
}

function normalizeTimezone(timezone: string | null | undefined): string | null {
  if (timezone === undefined || timezone === null) return null;
  const trimmed = timezone.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function validateTaskInput(
  data: { name?: string; url?: string; cron?: string; method?: string },
  isUpdate = false,
): string | null {
  if (data.name !== undefined) {
    if (data.name.trim().length === 0) return "任务名称不能为空";
    if (data.name.length > 128) return "任务名称不能超过 128 字符";
  }
  if (!isUpdate && !data.name) return "任务名称不能为空";
  if (data.url !== undefined && data.url.trim().length === 0) return "URL 不能为空";
  if (!isUpdate && !data.url) return "URL 不能为空";
  if (!isUpdate && (!data.cron || data.cron.trim().length === 0)) return "cron 表达式不能为空";
  if (data.cron) {
    const cronErr = validateCron(data.cron);
    if (cronErr) return cronErr;
  }
  if (data.method !== undefined) {
    if (typeof data.method !== "string" || data.method.trim().length === 0) return "HTTP 方法不能为空";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(data.method.toUpperCase())) {
      return "不支持的 HTTP 方法";
    }
  }
  return null;
}

// ── validateCron ──

describe("validateCron", () => {
  // 标准五字段
  it("接受标准的 5 字段 cron", () => {
    expect(validateCron("*/5 * * * *")).toBeNull();
    expect(validateCron("0 12 * * 1")).toBeNull();
    expect(validateCron("30 4 1 1 *")).toBeNull();
  });

  // 字段数不足或过多
  it("拒绝非 5 字段表达式", () => {
    expect(validateCron("* * *")).not.toBeNull();
    expect(validateCron("* * * * * *")).not.toBeNull();
    expect(validateCron("")).not.toBeNull();
  });

  // 包含字母等非法字符
  it("拒绝包含非法字符的字段", () => {
    expect(validateCron("abc * * * *")).not.toBeNull();
    expect(validateCron("0 0 * * SUN")).not.toBeNull();
  });

  // 合法特殊字符（* / ? - , L W #）
  it("接受合法 cron 特殊字符", () => {
    expect(validateCron("*/5 * * * *")).toBeNull();
    expect(validateCron("1-30 * * * *")).toBeNull();
    expect(validateCron("1,15 * * * *")).toBeNull();
  });

  // 带前后空格时自动 trim
  it("自动 trim 前后空白", () => {
    expect(validateCron("  */5 * * * *  ")).toBeNull();
  });
});

// ── normalizeTimezone ──

describe("normalizeTimezone", () => {
  it("null/undefined 返回 null", () => {
    expect(normalizeTimezone(null)).toBeNull();
    expect(normalizeTimezone(undefined)).toBeNull();
  });

  it("空字符串返回 null", () => {
    expect(normalizeTimezone("")).toBeNull();
  });

  it("纯空白字符串返回 null", () => {
    expect(normalizeTimezone("   ")).toBeNull();
  });

  it("保留有效时区字符串", () => {
    expect(normalizeTimezone("UTC")).toBe("UTC");
    expect(normalizeTimezone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(normalizeTimezone("America/New_York")).toBe("America/New_York");
  });

  it("trim 两侧空白", () => {
    expect(normalizeTimezone("  UTC  ")).toBe("UTC");
  });
});

// ── validateTaskInput ──

describe("validateTaskInput", () => {
  // 创建模式：name/url/cron 必填
  it("创建模式要求 name/url/cron 非空", () => {
    expect(validateTaskInput({})).not.toBeNull();
    expect(validateTaskInput({ name: "t" })).not.toBeNull();
    expect(validateTaskInput({ name: "t", url: "http://x" })).not.toBeNull();
  });

  it("创建模式接受完整输入", () => {
    expect(validateTaskInput({ name: "test", url: "http://x", cron: "* * * * *" })).toBeNull();
  });

  // 更新模式：允许部分字段
  it("更新模式允许部分字段为空", () => {
    expect(validateTaskInput({}, true)).toBeNull();
    expect(validateTaskInput({ name: "new" }, true)).toBeNull();
  });

  // 名称长度限制
  it("拒绝超过 128 字符的名称", () => {
    expect(validateTaskInput({ name: "a".repeat(129), url: "http://x", cron: "* * * * *" })).not.toBeNull();
  });

  it("接受 128 字符的名称", () => {
    expect(validateTaskInput({ name: "a".repeat(128), url: "http://x", cron: "* * * * *" })).toBeNull();
  });

  // 空白名称
  it("拒绝纯空白的名称", () => {
    expect(validateTaskInput({ name: "   ", url: "http://x", cron: "* * * * *" })).not.toBeNull();
  });

  // 空白 URL
  it("拒绝纯空白的 URL", () => {
    expect(validateTaskInput({ name: "t", url: "   ", cron: "* * * * *" })).not.toBeNull();
  });

  // HTTP 方法校验
  it("接受所有标准 HTTP 方法", () => {
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(validateTaskInput({ name: "t", url: "http://x", cron: "* * * * *", method: m })).toBeNull();
    }
  });

  it("接受小写 HTTP 方法（自动 upperCase）", () => {
    expect(validateTaskInput({ name: "t", url: "http://x", cron: "* * * * *", method: "get" })).toBeNull();
  });

  it("拒绝非法 HTTP 方法", () => {
    expect(validateTaskInput({ name: "t", url: "http://x", cron: "* * * * *", method: "INVALID" })).not.toBeNull();
  });

  // 空字符串 method 被拦截
  it("拒绝空字符串 method", () => {
    expect(validateTaskInput({ name: "t", url: "http://x", cron: "* * * * *", method: "" })).not.toBeNull();
  });

  // 纯空白 method 被拦截
  it("拒绝纯空白 method", () => {
    expect(validateTaskInput({ name: "t", url: "http://x", cron: "* * * * *", method: "  " })).not.toBeNull();
  });

  // 重构后的边界场景：更新模式下 name 未提供时不报 name 错误
  it("更新模式下 name 为 undefined 时不报 name 错误", () => {
    expect(validateTaskInput({ url: "http://x" }, true)).toBeNull();
  });

  // 更新模式下 url 为 undefined 时不报 url 错误
  it("更新模式下 url 为 undefined 时不报 url 错误", () => {
    expect(validateTaskInput({ name: "t" }, true)).toBeNull();
  });

  // 更新模式下 name 为空字符串时仍报错
  it("更新模式下 name 为空字符串时仍报错", () => {
    expect(validateTaskInput({ name: "" }, true)).not.toBeNull();
  });
});
