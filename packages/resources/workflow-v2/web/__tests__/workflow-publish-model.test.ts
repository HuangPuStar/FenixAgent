// web/__tests__/workflow-publish-model.test.ts
// 列表页发布动作与日志弹窗的纯函数层用例：错误码 → 文案键的映射必须**按码分流**（四类原因的下一步动作不同），
// 漂移判定必须区分「都没发布 / 一致 / 不一致」，时间格式化必须跟随 locale 且对无效输入返回 null。
//
// 为什么钉这些：映射表是发布失败时用户看到的唯一解释来源（`t()` 的参数就是这里的返回值），
// 漏一个码就会掉进通用文案——「草稿没跑过 test_run」与「上游崩了」在界面上长得一样，用户按提示做的动作就会错。

import { describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import {
  CONSOLE_PUBLISH_FORCE,
  formatPublishTime,
  publishErrorKey,
  resolvePublishDrift,
  toPublishRecordRow,
} from "../pages/list/workflow-publish-model";

describe("发布失败的错误码映射", () => {
  // 每一类失败都必须落到自己那条键上：映射错位比缺项更隐蔽（文案看起来「有话说」，动作却是错的）。
  test("按稳定错误码分流到不同文案键", () => {
    const cases: Array<[string, string]> = [
      ["UNAUTHENTICATED", "publish.failed_unauthorized"],
      ["UNAUTHORIZED", "publish.failed_unauthorized"],
      ["FORBIDDEN", "publish.failed_unauthorized"],
      ["WORKFLOW_NOT_FOUND", "publish.failed_not_found"],
      ["ORG_APP_NOT_BOUND", "publish.failed_unbound"],
      ["PLATFORM_ACCOUNT_DEGRADED", "publish.failed_degraded"],
      ["PLATFORM_SESSION_UNAVAILABLE", "publish.failed_session"],
      ["WORKFLOW_DRAFT_NOT_VERIFIED", "publish.failed_draft_not_verified"],
      ["WORKFLOW_VERSION_NOT_INCREMENTAL", "publish.failed_version_not_incremental"],
      ["WORKFLOW_VERSION_INVALID", "publish.failed_version_invalid"],
      ["WORKFLOW_VERSION_UNPARSEABLE", "publish.failed_version_invalid"],
      ["UPSTREAM_TIMEOUT", "publish.failed_timeout"],
      ["UPSTREAM_UNAVAILABLE", "publish.failed_upstream"],
      ["UPSTREAM_REJECTED", "publish.failed_upstream"],
    ];
    for (const [code, key] of cases) {
      expect(publishErrorKey(new ApiError("upstream said something", code))).toBe(key);
    }
  });

  // 不认识的失败（含请求层归一出的码与根本不是 ApiError 的异常）一律走通用文案：
  // 把未知失败翻译成一句看似精确的承诺，比说「发布失败，请重试」更糟。
  test("未知错误与非法入参回落通用文案", () => {
    expect(publishErrorKey(new ApiError("boom", "SERVER_ERROR"))).toBe("publish.failed");
    expect(publishErrorKey(new ApiError("boom", "NETWORK_ERROR"))).toBe("publish.failed");
    expect(publishErrorKey(new Error("boom"))).toBe("publish.failed");
    expect(publishErrorKey(null)).toBe("publish.failed");
  });

  // 控制台发布固定 `force`：与上游画布内发布按钮同口径，否则会出现「画布里点得动、控制台报草稿未验证」。
  test("控制台发布固定携带 force", () => {
    expect(CONSOLE_PUBLISH_FORCE).toBe(true);
  });
});

describe("本地版本与上游版本的漂移判定", () => {
  // 两侧都没版本是「都没发布」，不是漂移：把它算成漂移会让每个新 workflow 的弹窗都挂着一条警告。
  test("两侧都未发布时不算漂移", () => {
    expect(resolvePublishDrift(null, null)).toEqual({ kind: "unpublished" });
  });

  test("版本一致时给出匹配结论", () => {
    expect(resolvePublishDrift("v0.0.3", "v0.0.3")).toEqual({ kind: "match", version: "v0.0.3" });
  });

  // 画布内发布不写回本地版本（已知缺口）：本地落后、本地领先、单侧为空都必须落到漂移，界面据此提示先核对。
  test("任一侧缺失或不一致都判为漂移", () => {
    expect(resolvePublishDrift("v0.0.1", "v0.0.3")).toEqual({ kind: "drift", local: "v0.0.1", upstream: "v0.0.3" });
    expect(resolvePublishDrift(null, "v0.0.1")).toEqual({ kind: "drift", local: null, upstream: "v0.0.1" });
    expect(resolvePublishDrift("v0.0.1", null)).toEqual({ kind: "drift", local: "v0.0.1", upstream: null });
  });
});

describe("发布记录的视图模型", () => {
  // 记录名缺失时用当前 workflow 的名称兜底（上游只回了 id 的记录不该显示成空白行）。
  test("名称缺失时用兜底名，键优先用上游 workflow ID", () => {
    const row = toPublishRecordRow(
      { workflowId: "wf-9", name: null, publishedAt: null, ownerId: null },
      0,
      "客服问答流程",
    );
    expect(row).toEqual({ key: "wf-9", name: "客服问答流程", publishedAt: null, ownerId: null });
  });

  // 上游既没回 id 也没回时间时，键必须退化成序号：React key 撞车会让记录列表渲染错位（比少一行更难发现）。
  test("无上游 ID 时键退化为序号", () => {
    expect(toPublishRecordRow({ workflowId: null, name: "x", publishedAt: null, ownerId: null }, 3, "兜底").key).toBe(
      "record-3",
    );
  });

  // 时间按传入 locale 格式化；无效串与 null 都返回 null（调用方显示「上游未提供」而不是 Invalid Date）。
  test("时间格式化跟随 locale 且对无效输入返回 null", () => {
    const iso = "2026-10-09T02:00:00.000Z";
    expect(formatPublishTime(null, "zh-CN")).toBeNull();
    expect(formatPublishTime("not-a-time", "zh-CN")).toBeNull();
    expect(formatPublishTime(iso, "zh-CN")).toBe(new Date(iso).toLocaleString("zh-CN"));
    expect(formatPublishTime(iso, "en-US")).toBe(new Date(iso).toLocaleString("en-US"));
  });
});
