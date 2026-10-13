// web/__tests__/workflow-v2-i18n.test.ts
// 守护 workflows 字典的完整性：en / zh 键集一致、插值占位符一致、web 面用到的键都能查到。
//
// 「包外消费点」这条守护已随页面标题与动作迁回包内页面（宿主 `/agent/workflow` 路由现在只是 `Suspense` 壳，
// 里没有 `t()` 调用点）而删除：机制在时它守的是「宿主 route 里的字面量键」——现在这类调用点不存在了，
// 留着只会是一条永远无法失败的用例。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不报错，只有中英来回切换才暴露
// （前端规范 §9.3）。这里直接读 `i18n/locales/**` 的 JSON，不经过 i18next 单例，因此不受测试中
// `react-i18next` 模块替换影响。
//
// 两类键的覆盖口径：字面量 `t("…")` 由正则扫描；动态拼出的键（`t(canvasAnnouncementKey(state))`）
// 扫描看不到，改为直接调那个纯函数枚举它的返回值。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ApiError } from "@fenix/web-runtime/api/request";
import type { WorkflowV2WorkflowItem } from "../api/workflows";
import { canvasAnnouncementKey } from "../pages/canvas/canvas-hosting-model";
import {
  deleteRefusalKey,
  describeWorkflowStatus,
  initializeErrorKey,
  LIST_I18N_SCOPE,
  UPDATED_AT_KEYS,
  WORKFLOW_STATUS_HINT_KEYS,
} from "../pages/list/workflow-list-model";
import {
  RUN_MODE_LABEL_KEYS,
  RUN_STATUS_LABEL_KEYS,
  runErrorKey,
  runModeKey,
  runStatusKey,
} from "../pages/list/workflow-run-log-model";

const WEB_ROOT = resolve(import.meta.dir, "..");
const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/workflows.json"), "utf8")) as Record<
  string,
  unknown
>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/workflows.json"), "utf8")) as Record<
  string,
  unknown
>;

/** 把嵌套字典摊平成点号路径：`canvas.state.timeout.title`；顶层键保持原样。 */
function flatten(source: Record<string, unknown>, prefix = ""): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of flatten(value as Record<string, unknown>, path))
        flat.set(nestedKey, nestedValue);
    } else {
      flat.set(path, String(value));
    }
  }
  return flat;
}

/** 递归收集 web 下的 .ts / .tsx 源码（排除测试与字典自身）。 */
function collectSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "__tests__" || entry === "locales") continue;
      files.push(...collectSources(path));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}

/** web 源码里出现的全部字面量 `t("key")`。 */
function collectLiteralKeys(): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const file of collectSources(WEB_ROOT)) {
    const relPath = relative(WEB_ROOT, file);
    for (const match of readFileSync(file, "utf8").matchAll(/\bt\(\s*"([^"]+)"/g)) {
      usage.set(match[1], [...(usage.get(match[1]) ?? []), relPath]);
    }
  }
  return usage;
}

const enFlat = flatten(EN);
const zhFlat = flatten(ZH);
const literalKeys = collectLiteralKeys();

describe("workflows 字典完整性", () => {
  test("en / zh 键集完全一致", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    // 下限只防「字典被清空」这类事故；新增页面时同步上调（当前含导航项、画布宿主页、列表页、发布与日志五组键）。
    expect(enFlat.size).toBeGreaterThanOrEqual(100);
  });

  test("en / zh 同一键的插值占位符一致", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    const mismatched = [...enFlat.keys()].filter(
      (key) =>
        JSON.stringify(placeholders(enFlat.get(key) ?? "")) !== JSON.stringify(placeholders(zhFlat.get(key) ?? "")),
    );
    expect(mismatched).toEqual([]);
  });

  test("源码中的字面量 t() 键都在字典内", () => {
    const missing = [...literalKeys.keys()].filter((key) => !enFlat.has(key) && !zhFlat.has(key));
    expect(missing).toEqual([]);
    expect(literalKeys.size).toBeGreaterThanOrEqual(15);
  });

  // 运行日志的空态与模式/状态文案必须齐全：缺一条就会在界面上显示成 i18n 键本身（i18next 缺键只回显键，
  // 不报错），而这几条恰好是「列表里到底显示了什么」的解释来源。
  test("运行日志的空态与模式/状态文案齐全", () => {
    const required = [
      "run.empty_title",
      "run.empty_hint",
      ...Object.values(RUN_MODE_LABEL_KEYS),
      ...Object.values(RUN_STATUS_LABEL_KEYS),
    ];
    const missing = required.filter((key) => !enFlat.has(key) || !zhFlat.has(key));
    expect(missing).toEqual([]);
  });

  // 主从两栏的说明类文案同样是「界面为什么长这样」的解释来源，缺一条就只显示键名：左栏是什么、为什么这条
  // 记录点不开、平台记录为什么没有输入输出、详情读取失败是哪一块坏了。
  test("运行日志两栏的说明文案齐全", () => {
    const required = ["run.records_title", "run.detail_unavailable", "run.io_failed_title", "run.platform_no_io"];
    const missing = required.filter((key) => !enFlat.has(key) || !zhFlat.has(key));
    expect(missing).toEqual([]);
  });

  // 动态键（播报文案）扫描不到，直接枚举纯函数的返回值——它们同样必须能查到。
  test("状态播报的动态键都在字典内", () => {
    const announcementKeys = [
      canvasAnnouncementKey({ kind: "loading" }),
      canvasAnnouncementKey({ kind: "blocked", reason: "unbound" }),
      canvasAnnouncementKey({ kind: "frame", phase: "connecting", retryable: true }),
      canvasAnnouncementKey({ kind: "frame", phase: "interactive", retryable: true }),
      canvasAnnouncementKey({ kind: "frame", phase: "timeout", retryable: true }),
      canvasAnnouncementKey({ kind: "frame", phase: "session-expired", retryable: true }),
    ];
    const missing = announcementKeys.filter((key) => !enFlat.has(key));
    expect(missing).toEqual([]);
  });

  // 命名空间是 `workflows`，字典自身必须保持平铺：`workflows.` 形状的嵌套键会让键 owner 与字典 owner 分离。
  test("字典中不存在 workflows. 前缀的嵌套键", () => {
    expect([...enFlat.keys()].filter((key) => key.startsWith("workflows."))).toEqual([]);
  });

  // 列表页的动态键同样扫描不到，枚举来源分三处：
  // - 模型函数按状态 / 策略返回值；
  // - 共享 `Pagination` 按 `translationPrefix` 拼 `pagination_total`（前缀由模型导出，见 `LIST_I18N_SCOPE`）；
  // - 相对时间四档（键表由模型导出，表与字典同批演进）。
  test("列表页的动态键都在字典内", () => {
    const item = (overrides: Partial<WorkflowV2WorkflowItem>): WorkflowV2WorkflowItem => ({
      id: "wf-1",
      upstreamWorkflowId: "upstream-1",
      appId: "app-1",
      name: "示例",
      ownerUserId: "user-1",
      visibility: "private",
      publishState: "unpublished",
      publishedVersion: null,
      syncState: "active",
      updatedAt: "2026-09-29T00:00:00.000Z",
      ...overrides,
    });
    const dynamicKeys = [
      describeWorkflowStatus(item({ syncState: "pending_delete" })).labelKey,
      describeWorkflowStatus(item({ publishState: "published", publishedVersion: "v1.0.0" })).labelKey,
      describeWorkflowStatus(item({ publishState: "unknown" })).labelKey,
      describeWorkflowStatus(item({})).labelKey,
      deleteRefusalKey(1),
      deleteRefusalKey(2),
      deleteRefusalKey(null),
      // 初始化失败的文案由页面 `t(initializeErrorKey(error))` 取（动态键，扫描看不到）：按错误码的四个分支
      // 逐个枚举——只枚举已登记码还不够，兜底分支同样必须能查到。
      initializeErrorKey(new ApiError("", "UNAUTHENTICATED")),
      initializeErrorKey(new ApiError("", "PLATFORM_SESSION_UNAVAILABLE")),
      initializeErrorKey(new ApiError("", "UPSTREAM_UNAVAILABLE")),
      initializeErrorKey(new ApiError("", "INTERNAL_ERROR")),
      `${LIST_I18N_SCOPE}.pagination_total`,
      ...Object.values(UPDATED_AT_KEYS),
      ...Object.values(WORKFLOW_STATUS_HINT_KEYS),
      // 运行日志：失败文案同 `initializeErrorKey` 口径按错误码取（动态键，扫描看不到），逐分支枚举；
      // 状态文案同样由三元表达式取键（`runStatusKey`），含「未知」档与 null 兜底。
      runErrorKey(new ApiError("", "UNAUTHENTICATED")),
      runErrorKey(new ApiError("", "WORKFLOW_NOT_FOUND")),
      runErrorKey(new ApiError("", "ORG_APP_NOT_BOUND")),
      runErrorKey(new ApiError("", "PLATFORM_ACCOUNT_DEGRADED")),
      runErrorKey(new ApiError("", "PLATFORM_ACCOUNT_NOT_PROVISIONED")),
      runErrorKey(new ApiError("", "PLATFORM_SESSION_UNAVAILABLE")),
      runErrorKey(new ApiError("", "UPSTREAM_TIMEOUT")),
      runErrorKey(new ApiError("", "UPSTREAM_UNAVAILABLE")),
      runErrorKey(new Error("not an ApiError")),
      // 状态/模式两套键同样由三元表达式取键（`runStatusKey` / `runModeKey`），含「未知」档与 null 兜底。
      runStatusKey("running"),
      runStatusKey("succeeded"),
      runStatusKey("failed"),
      runStatusKey("canceled"),
      runStatusKey("interrupted"),
      runStatusKey(null),
      runModeKey("debug"),
      runModeKey("release"),
      runModeKey("node_debug"),
      runModeKey(null),
      ...Object.values(RUN_STATUS_LABEL_KEYS),
      ...Object.values(RUN_MODE_LABEL_KEYS),
    ];
    const missing = dynamicKeys.filter((key) => !enFlat.has(key) || !zhFlat.has(key));
    expect(missing).toEqual([]);
  });
});
