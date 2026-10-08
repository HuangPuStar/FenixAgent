// web/__tests__/workflow-v2-i18n.test.ts
// 守护 workflows 字典的完整性：en / zh 键集一致、插值占位符一致、web 面用到的键都能查到，以及**包外**消费点
// （宿主 route 用同一个命名空间取页面标题）用到的键也在字典内。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不报错，只有中英来回切换才暴露
// （前端规范 §9.3）。这里直接读 `i18n/locales/**` 的 JSON，不经过 i18next 单例，因此不受测试中
// `react-i18next` 模块替换影响。
//
// 两类键的覆盖口径：字面量 `t("…")` 由正则扫描；动态拼出的键（`t(canvasAnnouncementKey(state))`）
// 扫描看不到，改为直接调那个纯函数枚举它的返回值。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
} from "../pages/list/workflow-list-model";

const WEB_ROOT = resolve(import.meta.dir, "..");
const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/workflows.json"), "utf8")) as Record<
  string,
  unknown
>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/workflows.json"), "utf8")) as Record<
  string,
  unknown
>;

/**
 * 包外消费点：键的 owner 是本包字典，但 `t()` 的调用点在宿主 route 里。
 *
 * 2F 换包时旧包的 `page.*` 组没随迁到新包字典，调用点却还在（宿主 `workflow.tsx` 的页面标题），
 * 症状就是页头直接显示 `page.workflow_title` 字面量——包内静态扫描看不到这些调用点，只能显式列出。
 * 新增/移动宿主 route 时同步这份清单；文件不存在即失败（不静默跳过，否则守护会随重构一起消失）。
 */
const EXTERNAL_CONSUMER_FILES = ["apps/web/src/routes/agent/_panel/workflow.tsx"] as const;

const REPOSITORY_ROOT = resolve(WEB_ROOT, "../../../..");

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
    // 下限只防「字典被清空」这类事故；新增页面时同步上调（当前含导航项、画布宿主页与列表页三组键）。
    expect(enFlat.size).toBeGreaterThanOrEqual(60);
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
      publishedVersion: null,
      syncState: "active",
      updatedAt: "2026-09-29T00:00:00.000Z",
      ...overrides,
    });
    const dynamicKeys = [
      describeWorkflowStatus(item({ syncState: "pending_delete" })).labelKey,
      describeWorkflowStatus(item({ publishedVersion: "1.0.0" })).labelKey,
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
    ];
    const missing = dynamicKeys.filter((key) => !enFlat.has(key) || !zhFlat.has(key));
    expect(missing).toEqual([]);
  });

  // 包外消费点：宿主 route 用同一命名空间取页面标题，键仍归本包。缺键时页头会显示 `page.workflow_title`
  // 字面量（2F 换包时真实发生过：旧包的 `page.*` 组没随迁），而包内扫描看不到这些调用点。
  test("包外消费点的字面量键都在字典内", () => {
    const missing: string[] = [];
    for (const relativePath of EXTERNAL_CONSUMER_FILES) {
      const absolutePath = join(REPOSITORY_ROOT, relativePath);
      if (!existsSync(absolutePath)) {
        throw new Error(`包外消费点文件不存在：${relativePath}；若宿主 route 已移动，请更新本用例的清单`);
      }
      for (const match of readFileSync(absolutePath, "utf8").matchAll(/\bt\(\s*"([^"]+)"/g)) {
        if (!enFlat.has(match[1]) || !zhFlat.has(match[1])) missing.push(`${relativePath} → ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
