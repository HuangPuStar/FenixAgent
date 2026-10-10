// web/__tests__/workflow-publish-model.test.ts
// 「发布日志」弹窗的纯函数层用例：上游字段 → 视图模型、状态键表与时间格式化。
//
// 控制台发布入口已撤除（发布动作在上游侧完成，列表页只读发布状态），错误码 → 文案键的映射随动作一并移除；
// 这里只钉**读路径**：上游字段原样搬运、键表不漂移、无效时间不产出 `Invalid Date`。

import { describe, expect, test } from "bun:test";
import {
  formatPublishTime,
  PUBLISH_ACTION_RESULT_KEYS,
  PUBLISH_CHANNEL_STATUS_KEYS,
  PUBLISH_RECORD_STATUS_KEYS,
  toPublishRecordRow,
} from "../pages/list/workflow-publish-model";

describe("发布记录的视图模型", () => {
  // 版本号缺失时键退化为序号：React key 撞车会让记录列表渲染错位（比少一行更难发现）。
  test("无版本号时键退化为序号，渠道名缺失时用渠道 ID 兜底", () => {
    const row = toPublishRecordRow(
      {
        version: null,
        status: "in_progress",
        channels: [{ connectorId: "1024", connectorName: null, status: "in_progress" }],
        packFailedResources: [],
      },
      3,
    );
    expect(row.key).toBe("record-3");
    expect(row.channels[0]).toEqual({ key: "1024", name: "1024", status: "in_progress" });
  });

  // 上游真实字段原样搬运：版本号、渠道结果、打包失败明细一个不少，也不多造（记录级状态由上游字段派生）。
  test("搬运版本、渠道与打包失败明细", () => {
    const row = toPublishRecordRow(
      {
        version: "v0.0.2",
        status: "done",
        channels: [{ connectorId: "1024", connectorName: "API", status: "success" }],
        packFailedResources: ["某个工作流"],
      },
      0,
    );
    expect(row).toEqual({
      key: "v0.0.2",
      version: "v0.0.2",
      status: "done",
      channels: [{ key: "1024", name: "API", status: "success" }],
      packFailedResources: ["某个工作流"],
    });
  });

  // 三个键表必须能查到字典（键是有限枚举，可被包内 i18n 用例逐个查；这里钉住键名不漂移）。
  test("状态与动作结果的键表覆盖全部取值", () => {
    expect(Object.keys(PUBLISH_RECORD_STATUS_KEYS).sort()).toEqual(["done", "in_progress", "pack_failed"]);
    expect(Object.keys(PUBLISH_CHANNEL_STATUS_KEYS).sort()).toEqual([
      "auditing",
      "disabled",
      "failed",
      "in_progress",
      "success",
      "unknown",
    ]);
    expect(PUBLISH_ACTION_RESULT_KEYS.ok).toBe("log.action_result_ok");
  });

  // 时间按传入 locale 格式化；无效串与 null 都返回 null（调用方显示「上游未提供」而不是 Invalid Date）。
  test("时间格式化跟随 locale 且对无效输入返回 null", () => {
    const iso = "2026-10-09T02:00:00.000Z";
    expect(formatPublishTime(null, "zh-CN")).toBeNull();
    expect(formatPublishTime("not-a-time", "zh-CN")).toBeNull();
    expect(formatPublishTime(iso, "zh-CN")).not.toBeNull();
  });
});
