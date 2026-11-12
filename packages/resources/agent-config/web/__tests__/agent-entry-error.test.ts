import { expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import { createInstance } from "i18next";
import en from "../i18n/locales/en/agents.json";
import zh from "../i18n/locales/zh/agents.json";
import { agentEntryError } from "../lib/error-message";

const i18n = createInstance();
await i18n.init({ lng: "zh", initAsync: false, resources: { zh: { agents: zh }, en: { agents: en } } });

// 用户额度和平台总量需要分别说明，且给出释放实例与提高额度两种处理方式。
test("explains concurrency limits with actionable advice", () => {
  const t = i18n.getFixedT("zh", "agents");
  for (const [code, reason] of [
    ["USER_AGENT_CONCURRENCY_LIMIT_REACHED", "当前用户"],
    ["AGENT_CONCURRENCY_LIMIT_REACHED", "平台"],
  ]) {
    const notice = agentEntryError(new ApiError("Request could not be completed", code), t);
    expect(notice.title).toContain(reason);
    expect(notice.description).toContain("停止暂时不用的实例");
    expect(notice.description).toContain("联系管理员");
    expect(notice.title).not.toContain("Request could not be completed");
  }
});
// 普通错误包括其他 429 限流仍显示真实服务端原因，不误导用户调整实例额度。
test("preserves unrelated server errors without concurrency advice", () => {
  const notice = agentEntryError(
    new ApiError("Provider quota exceeded", "RATE_LIMITED"),
    i18n.getFixedT("en", "agents"),
  );
  expect(notice.title).toBe("Failed to enter agent: Provider quota exceeded");
  expect(notice.description).toBeUndefined();
});
// 英文界面同样解释额度并提供可执行建议。
test("localizes the concurrency notice in English", () => {
  const notice = agentEntryError(
    new ApiError("limit", "USER_AGENT_CONCURRENCY_LIMIT_REACHED"),
    i18n.getFixedT("en", "agents"),
  );
  expect(notice.title).toContain("your active instances");
  expect(notice.description).toContain("administrator");
});
