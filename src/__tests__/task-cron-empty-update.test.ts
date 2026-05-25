import { describe, expect, test } from "bun:test";

// ── validateTaskInput 空 cron 更新路径验证 ──
// R36 修复：更新模式下 cron="" 不再静默通过

function validateCron(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "cron 表达式必须为 5 字段（分 时 日 月 周）";
  const validPattern = /^[\d*/?\-,LW#]+$/;
  for (const part of parts) {
    if (!validPattern.test(part)) return `cron 字段 "${part}" 包含非法字符`;
  }
  return null;
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
  if (data.cron !== undefined && data.cron.trim().length === 0) return "cron 表达式不能为空";
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

describe("validateTaskInput: empty cron on update", () => {
  // 空字符串 cron 在更新模式下被拒绝
  test("rejects empty string cron on update", () => {
    expect(validateTaskInput({ cron: "" }, true)).not.toBeNull();
  });

  // 纯空白 cron 在更新模式下被拒绝
  test("rejects whitespace-only cron on update", () => {
    expect(validateTaskInput({ cron: "   " }, true)).not.toBeNull();
  });

  // 有效的 cron 在更新模式下通过
  test("accepts valid cron on update", () => {
    expect(validateTaskInput({ cron: "*/5 * * * *" }, true)).toBeNull();
  });

  // cron 未提供（undefined）在更新模式下通过
  test("accepts undefined cron on update", () => {
    expect(validateTaskInput({}, true)).toBeNull();
  });

  // 空字符串 cron 在创建模式下也被拒绝
  test("rejects empty string cron on create", () => {
    expect(validateTaskInput({ name: "t", url: "http://x", cron: "" })).not.toBeNull();
  });
});
