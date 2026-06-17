# Chat 工具调用文本人性化改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 RCS chat 工具调用展示从英文工具名 + 标签式描述换成统一格式的中文叙述（"正在读 src/index.ts · 进行中"），状态词全局统一，保留工具上下文。

**Architecture:** 注册表模式，每个工具一个自包含 narrator 文件（提供 verb、icon、getDisplay、badge）。中央 `narrate()` 函数查注册表匹配工具，未命中走 fallback。i18n 走新 `toolNarrator` 命名空间，副标题模板用 `common.subtitle` + `common.subtitleRunning` 两个 key。仅改前端渲染层，不动 ACP 协议 / relay / Agent prompt。

**Tech Stack:** React 19, TypeScript, lucide-react, react-i18next, Bun test, Tailwind CSS v4

**Spec:** `docs/superpowers/specs/2026-06-16-chat-tool-call-humanized-text-design.md`

**Spec 实施时发现的微调**：
- `ToolCallData.status` 实际有 6 个值（`running | complete | error | waiting_for_confirmation | rejected | canceled`），spec 漏了 `rejected`。plan 里补上，在 `narrate()` 把 `rejected` 归一化为 `canceled`。
- 卡片颜色继续走现有 `getCardCategory + CARD_STYLES`，narrator 只负责 icon 和文案（避免一次性改太多）。
- 第一版**不实现** `inputSummary/outputSummary`（人话版输入输出摘要）、`streamingPreview`（流式输出预览），弹窗仍展示原始 JSON。

---

## File Structure

### 新增文件

```
web/components/chat/narrators/                    (新目录)
├── types.ts                     ToolNarrator / NarrationContext / NarrationResult 接口
├── helpers.ts                   extractFileName / extractLineRange / extractErrorMessage / formatElapsed / findFirstStringValue / truncate
├── index.ts                     注册表 + narrate() 中央入口
├── read.ts                      ┐
├── edit.ts                      │
├── write.ts                     │
├── bash.ts                      │
├── grep.ts                      │  12 个核心 narrator
├── glob.ts                      │  每个 ~30 行
├── web-fetch.ts                 │
├── web-search.ts                │
├── task.ts                      │
├── todo-write.ts                │
├── skill.ts                     │
├── question.ts                  ┘
└── fallback.ts                  兜底 narrator

web/src/i18n/locales/en/toolNarrator.json        新增 i18n（英文）
web/src/i18n/locales/zh/toolNarrator.json        新增 i18n（中文）

web/src/__tests__/
├── narrators-helpers.test.ts                    helpers 单测
├── narrators-i18n.test.ts                       i18n key 完整性测试
├── narrators-index.test.ts                      中央 narrate() 入口测试
└── narrators/
    ├── read.test.ts                             ┐
    ├── edit.test.ts                             │
    ├── bash.test.ts                             │
    ├── grep.test.ts                             │  12 个 narrator 单测
    ├── write.test.ts                            │  每个 3-5 case
    ├── glob.test.ts                             │
    ├── web-fetch.test.ts                        │
    ├── web-search.test.ts                       │
    ├── task.test.ts                             │
    ├── todo-write.test.ts                       │
    ├── skill.test.ts                            │
    ├── question.test.ts                         │
    └── fallback.test.ts                         ┘
```

### 修改文件

| 文件 | 修改内容 |
|---|---|
| `web/src/i18n/index.ts` | 注册 `NS.TOOL_NARRATOR` 命名空间 |
| `web/components/chat/ToolCallRow.tsx` | 调用 `narrate()` 替换现有逻辑（保留子 agent 嵌套、权限按钮） |
| `web/components/chat/ToolCallContent.tsx` | 删除现有每工具分支，改为接收 `NarrationResult` 渲染 |
| `web/components/chat/tool-call-utils.ts` | 保留 `simplifyToolName`（fallback 用）、`CARD_STYLES / getCardCategory`（卡片颜色）；删除其他不再使用的函数 |
| `web/src/acp/ChatInterface.tsx` | 在收到 tool_call 事件时记录 `toolCallStartedAt[toolCallId]`，complete/error 时计算 elapsed |

---

## Task 1: 创建 narrators/types.ts 接口定义

**Files:**
- Create: `web/components/chat/narrators/types.ts`

- [ ] **Step 1: 创建目录和 types.ts**

创建文件 `web/components/chat/narrators/types.ts`：

```ts
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import type { ToolCallData } from "@/src/lib/types";

/**
 * 工具调用的状态枚举。映射自 ACP 协议 ToolCallUpdate.status。
 * - running: 正在执行
 * - complete: 成功完成
 * - error: 失败
 * - waiting_for_confirmation: 等待用户授权
 * - rejected: 用户拒绝授权（归一化为 canceled 处理）
 * - canceled: 被取消
 *
 * 注意：ToolCallData.status 包含 rejected，但 narrator 统一把
 * rejected 当 canceled 处理（视觉上都是"已取消"）。
 */
export type ToolStatus =
  | "running"
  | "complete"
  | "error"
  | "waiting_for_confirmation"
  | "rejected"
  | "canceled";

/**
 * Narration 上下文。传递给每个 narrator 的方法。
 * - tool: 完整的工具调用数据
 * - status: 已归一化的状态（rejected 已映射为 canceled）
 * - elapsedMs: 前端计算的耗时（complete/error 状态下用于徽章）
 * - t: i18n 翻译函数（由 ToolCallRow 通过 useTranslation 拿到后传入）
 */
export interface NarrationContext {
  tool: ToolCallData;
  status: Exclude<ToolStatus, "rejected">;
  elapsedMs?: number;
  t: TFunction;
}

export type BadgeTone = "info" | "warn" | "error" | "success";

export interface NarrationBadge {
  tone: BadgeTone;
  text: string;
}

/**
 * 卡片展示用的双字段：title 是第一行（文件名/命令/URL），
 * object 是副标题里的"对象"部分（与 verb 拼成副标题）。
 */
export interface ToolDisplay {
  title: ReactNode;
  object: ReactNode;
}

/**
 * Narration 结果。中央 narrate() 返回，ToolCallRow 直接渲染。
 */
export interface NarrationResult {
  icon?: LucideIcon;
  title: ReactNode;
  subtitle: ReactNode;
  statusLabel: string;
  badge?: NarrationBadge;
  errorDetail?: string;
  detail: {
    rawInput?: unknown;
    rawOutput?: unknown;
  };
}

/**
 * 工具 narrator 接口。每个工具实现一份。
 *
 * 设计要点：
 * - match: 工具名匹配（已转小写），注册表按顺序匹配
 * - verb: 中文动词
 * - icon: 卡片图标
 * - getDisplay: 同时返回 title 和 object，narrator 完全自包含
 * - badge: 可选的计数徽章
 *
 * 副标题拼接完全在中央 narrate() 完成（用 common.subtitle / subtitleRunning 模板），
 * narrator 不参与文案拼接，保证格式一致。
 */
export interface ToolNarrator {
  match: (toolNameLower: string) => boolean;
  verb: string;
  icon: LucideIcon;
  getDisplay: (ctx: NarrationContext) => ToolDisplay;
  badge?: (ctx: NarrationContext) => NarrationBadge | undefined;
}
```

- [ ] **Step 2: 验证 TypeScript 编译通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit -p web/tsconfig.json 2>&1 | head -20`
Expected: 无 types.ts 相关错误（其他文件可能有错，忽略）

- [ ] **Step 3: Commit**

```bash
git add web/components/chat/narrators/types.ts
git commit -m "feat(chat): 添加 narrators/types.ts 接口定义"
```

---

## Task 2: helpers.ts（TDD）

**Files:**
- Create: `web/src/__tests__/narrators-helpers.test.ts`
- Create: `web/components/chat/narrators/helpers.ts`

- [ ] **Step 1: 写测试**

创建文件 `web/src/__tests__/narrators-helpers.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import {
  extractFileName,
  extractLineRange,
  extractErrorMessage,
  formatElapsed,
  truncate,
  findFirstStringValue,
} from "@/components/chat/narrators/helpers";

describe("narrators/helpers", () => {
  describe("extractFileName", () => {
    test("从 file_path 提取文件名", () => {
      expect(extractFileName({ file_path: "/a/b/c.ts" })).toBe("c.ts");
    });

    test("兼容 path 字段", () => {
      expect(extractFileName({ path: "/x/y.ts" })).toBe("y.ts");
    });

    test("兼容 filePath 字段", () => {
      expect(extractFileName({ filePath: "/z.ts" })).toBe("z.ts");
    });

    test("无路径时返回兜底", () => {
      expect(extractFileName({})).toBe("<未知文件>");
      expect(extractFileName(undefined)).toBe("<未知文件>");
    });
  });

  describe("extractLineRange", () => {
    test("offset+limit 转成行号区间", () => {
      expect(extractLineRange({ offset: 100, limit: 50 })).toBe("100-149");
    });

    test("start_line+end_line 兼容", () => {
      expect(extractLineRange({ start_line: 10, end_line: 20 })).toBe("10-20");
    });

    test("无行号字段时返回空字符串", () => {
      expect(extractLineRange({ file_path: "/x.ts" })).toBe("");
    });
  });

  describe("extractErrorMessage", () => {
    test("ACP 标准错误（isError + content text）", () => {
      const raw = { isError: true, content: [{ type: "text", text: "File not found" }] };
      expect(extractErrorMessage(raw)).toBe("File not found");
    });

    test("error 字符串字段", () => {
      expect(extractErrorMessage({ error: "Boom" })).toBe("Boom");
    });

    test("error.message 对象", () => {
      expect(extractErrorMessage({ error: { message: "Oops" } })).toBe("Oops");
    });

    test("content 数组中最后一个 text", () => {
      const raw = { content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] };
      expect(extractErrorMessage(raw)).toBe("line2");
    });

    test("无可用信息时返回兜底", () => {
      expect(extractErrorMessage(null)).toBe("未知错误");
      expect(extractErrorMessage({})).toBe("未知错误");
    });

    test("超长错误信息截断到 120 字符", () => {
      const long = "x".repeat(200);
      const result = extractErrorMessage({ error: long });
      expect(result.length).toBe(121); // 120 + 省略号
      expect(result.endsWith("…")).toBe(true);
    });
  });

  describe("formatElapsed", () => {
    test("毫秒级", () => {
      expect(formatElapsed(500)).toBe("500ms");
    });

    test("秒级保留 1 位小数", () => {
      expect(formatElapsed(1500)).toBe("1.5s");
      expect(formatElapsed(12_000)).toBe("12.0s");
    });

    test("分钟级 m+s", () => {
      expect(formatElapsed(65_000)).toBe("1m5s");
      expect(formatElapsed(125_000)).toBe("2m5s");
    });
  });

  describe("truncate", () => {
    test("短字符串原样返回", () => {
      expect(truncate("hello", 10)).toBe("hello");
    });

    test("长字符串截断加省略号", () => {
      expect(truncate("hello world", 5)).toBe("hello…");
    });
  });

  describe("findFirstStringValue", () => {
    test("返回第一个字符串值", () => {
      expect(findFirstStringValue({ num: 1, str: "abc", other: "def" })).toBe("abc");
    });

    test("无非字符串值时返回 undefined", () => {
      expect(findFirstStringValue({ num: 1, bool: true })).toBeUndefined();
    });

    test("非对象返回 undefined", () => {
      expect(findFirstStringValue(null)).toBeUndefined();
      expect(findFirstStringValue("string")).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators-helpers.test.ts`
Expected: FAIL，错误信息提示 `Cannot find module '@/components/chat/narrators/helpers'`

- [ ] **Step 3: 实现 helpers.ts**

创建文件 `web/components/chat/narrators/helpers.ts`：

```ts
/**
 * Narrator 共享工具函数。
 *
 * 所有函数都是纯函数，无副作用，便于单测。
 * 设计原则：宽容处理 rawInput / rawOutput 的字段变体
 * （不同 Agent 命名习惯不同），失败时返回兜底值而非抛错。
 */

/**
 * 从多种可能的路径字段中提取文件名。
 * 兼容 Read/Edit/Write 工具的不同参数命名（file_path / path / filePath）。
 */
export function extractFileName(rawInput: unknown): string {
  const r = rawInput as Record<string, unknown> | undefined;
  const path = String(r?.file_path ?? r?.path ?? r?.filePath ?? "");
  if (!path) return "<未知文件>";
  return path.split("/").pop() || path;
}

/**
 * 从 Read 工具的 rawInput 提取行号区间。
 * 兼容两种命名：offset+limit（Claude Code 风格）和 start_line+end_line。
 * 返回 "120-180" 或 ""（无行号限制时）。
 */
export function extractLineRange(rawInput: unknown): string {
  const r = rawInput as Record<string, unknown> | undefined;
  const offset = Number(r?.offset);
  const limit = Number(r?.limit);
  if (offset && limit) return `${offset}-${offset + limit - 1}`;
  const start = Number(r?.start_line);
  const end = Number(r?.end_line);
  if (start && end) return `${start}-${end}`;
  return "";
}

/**
 * 从 rawOutput 提取错误信息。
 *
 * ACP 协议下 rawOutput 结构有几种变体，按优先级匹配：
 * 1. isError=true + content[].text（ACP 标准）
 * 2. error 字段（string 或 { message }）
 * 3. content 数组中最后一个 text（Bash 等工具的 stderr）
 * 4. 兜底"未知错误"
 */
export function extractErrorMessage(rawOutput: unknown): string {
  if (!rawOutput) return "未知错误";
  const o = rawOutput as Record<string, unknown>;

  if (o.isError && Array.isArray(o.content)) {
    const text = (o.content as Array<{ type: string; text?: string }>)
      .find((c) => c.type === "text")?.text;
    if (text) return truncate(String(text), 120);
  }

  if (typeof o.error === "string") return truncate(o.error, 120);
  if (o.error && typeof o.error === "object" && "message" in (o.error as object)) {
    return truncate(String((o.error as { message: unknown }).message), 120);
  }

  if (Array.isArray(o.content)) {
    const lastText = [...(o.content as Array<{ type: string; text?: unknown }>)]
      .reverse()
      .find((c) => c.type === "text")?.text;
    if (typeof lastText === "string") return truncate(lastText, 120);
  }

  return "未知错误";
}

/**
 * 格式化耗时。前端维护 toolCallStartedAt 时间戳，complete/error 时计算差值。
 * - <1s 显示 ms
 * - <1min 显示 s（保留 1 位小数）
 * - ≥1min 显示 m+s
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

/**
 * 截断字符串，超长加省略号。
 */
export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 从 rawInput 提取第一个字符串值。兜底 narrator 用作附加上下文。
 */
export function findFirstStringValue(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  for (const v of Object.values(rawInput as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
```

- [ ] **Step 4: 运行测试，验证通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators-helpers.test.ts`
Expected: PASS，所有测试通过

- [ ] **Step 5: Commit**

```bash
git add web/components/chat/narrators/helpers.ts web/src/__tests__/narrators-helpers.test.ts
git commit -m "feat(chat): 添加 narrators/helpers.ts 工具函数"
```

---

## Task 3: i18n 注册 + JSON 文件

**Files:**
- Create: `web/src/i18n/locales/en/toolNarrator.json`
- Create: `web/src/i18n/locales/zh/toolNarrator.json`
- Modify: `web/src/i18n/index.ts`

- [ ] **Step 1: 创建中文 JSON**

创建文件 `web/src/i18n/locales/zh/toolNarrator.json`：

```json
{
  "common": {
    "status": {
      "running": "进行中",
      "complete": "已完成",
      "error": "失败",
      "waiting_for_confirmation": "待确认",
      "canceled": "已取消"
    },
    "subtitle": "{{verb}} {{object}}",
    "subtitleRunning": "正在{{verb}} {{object}}",
    "lineRange": "第 {{range}} 行",
    "inPath": "在 {{path}}"
  },
  "edit": {
    "changes": "{{count}} 处"
  },
  "grep": {
    "results": "找到 {{count}} 个"
  },
  "glob": {
    "files": "{{count}} 个文件"
  },
  "webSearch": {
    "results": "找到 {{count}} 个"
  },
  "todo": {
    "items": "{{count}} 个待办"
  },
  "detail": {
    "showRawInput": "查看原始输入",
    "showRawOutput": "查看原始输出",
    "noOutput": "无输出"
  }
}
```

- [ ] **Step 2: 创建英文 JSON**

创建文件 `web/src/i18n/locales/en/toolNarrator.json`：

```json
{
  "common": {
    "status": {
      "running": "Running",
      "complete": "Done",
      "error": "Failed",
      "waiting_for_confirmation": "Pending",
      "canceled": "Canceled"
    },
    "subtitle": "{{verb}} {{object}}",
    "subtitleRunning": "Reading {{object}}…",
    "lineRange": "lines {{range}}",
    "inPath": "in {{path}}"
  },
  "edit": {
    "changes": "{{count}} change(s)"
  },
  "grep": {
    "results": "{{count}} match(es)"
  },
  "glob": {
    "files": "{{count}} file(s)"
  },
  "webSearch": {
    "results": "{{count}} result(s)"
  },
  "todo": {
    "items": "{{count}} todo(s)"
  },
  "detail": {
    "showRawInput": "Show raw input",
    "showRawOutput": "Show raw output",
    "noOutput": "No output"
  }
}
```

> **英文版说明**：英文 running 副标题用 `Reading {{object}}…` 而非 `{{verb}}ing`，因为 verb 是中文（"读"），无法直接加 ing。complete/error/canceled 复用中文模板（副标题会出现"读 src/index.ts"，跨语言不优雅但可接受）。未来按需给 ToolNarrator 加 verbEn 字段。

- [ ] **Step 3: 注册命名空间**

修改 `web/src/i18n/index.ts`：

第 25 行后添加导入：

```ts
import toolNarratorEN from "./locales/en/toolNarrator.json";
```

第 47 行后添加导入：

```ts
import toolNarratorZH from "./locales/zh/toolNarrator.json";
```

在 `NS` 对象（第 49-72 行）末尾 `AGENT_HOME: "agentHome",` 之后添加：

```ts
  AGENT_HOME: "agentHome",
  TOOL_NARRATOR: "toolNarrator",
} as const;
```

在 `en` resources 对象（第 81-104 行）末尾添加：

```ts
        [NS.AGENT_HOME]: agentHomeEN,
        [NS.TOOL_NARRATOR]: toolNarratorEN,
      },
```

在 `zh` resources 对象（第 105-128 行）末尾添加：

```ts
        [NS.AGENT_HOME]: agentHomeZH,
        [NS.TOOL_NARRATOR]: toolNarratorZH,
      },
```

在 `ns` 数组（第 132-153 行）末尾添加：

```ts
      NS.AGENT_HOME,
      NS.TOOL_NARRATOR,
    ],
```

- [ ] **Step 4: 验证编译**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit -p web/tsconfig.json 2>&1 | grep -i "i18n\|toolNarrator" | head -10`
Expected: 无输出（无相关错误）

- [ ] **Step 5: Commit**

```bash
git add web/src/i18n/locales/en/toolNarrator.json web/src/i18n/locales/zh/toolNarrator.json web/src/i18n/index.ts
git commit -m "feat(chat): 注册 toolNarrator i18n 命名空间"
```

---

## Task 4: i18n 完整性测试

**Files:**
- Create: `web/src/__tests__/narrators-i18n.test.ts`

- [ ] **Step 1: 写测试**

创建文件 `web/src/__tests__/narrators-i18n.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import en from "@/src/i18n/locales/en/toolNarrator.json";
import zh from "@/src/i18n/locales/zh/toolNarrator.json";

const REQUIRED_STATUS_KEYS = ["running", "complete", "error", "waiting_for_confirmation", "canceled"];

describe("toolNarrator i18n 完整性", () => {
  test("中文版包含所有 common.status.* key", () => {
    for (const key of REQUIRED_STATUS_KEYS) {
      expect(zh.common.status as Record<string, string>).toHaveProperty(key);
    }
  });

  test("英文版包含所有 common.status.* key", () => {
    for (const key of REQUIRED_STATUS_KEYS) {
      expect(en.common.status as Record<string, string>).toHaveProperty(key);
    }
  });

  test("中英文都有 common.subtitle 和 common.subtitleRunning", () => {
    expect(zh.common).toHaveProperty("subtitle");
    expect(zh.common).toHaveProperty("subtitleRunning");
    expect(en.common).toHaveProperty("subtitle");
    expect(en.common).toHaveProperty("subtitleRunning");
  });

  test("subtitle 模板包含 {{verb}} 和 {{object}} 占位符", () => {
    expect(zh.common.subtitle).toContain("{{verb}}");
    expect(zh.common.subtitle).toContain("{{object}}");
    expect(en.common.subtitle).toContain("{{verb}}");
    expect(en.common.subtitle).toContain("{{object}}");
  });

  test("subtitleRunning 模板包含 {{object}} 占位符", () => {
    expect(zh.common.subtitleRunning).toContain("{{object}}");
    expect(en.common.subtitleRunning).toContain("{{object}}");
  });

  test("工具特有徽章 key 双语同步", () => {
    const badgeScopes = ["edit", "grep", "glob", "webSearch", "todo"];
    for (const scope of badgeScopes) {
      expect(zh).toHaveProperty(scope);
      expect(en).toHaveProperty(scope);
    }
  });
});
```

- [ ] **Step 2: 运行测试，验证通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators-i18n.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/__tests__/narrators-i18n.test.ts
git commit -m "test(chat): 添加 toolNarrator i18n 完整性测试"
```

---

## Task 5: 中央 narrate() + fallback narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators-index.test.ts`
- Create: `web/components/chat/narrators/index.ts`
- Create: `web/components/chat/narrators/fallback.ts`

- [ ] **Step 1: 写测试**

创建文件 `web/src/__tests__/narrators-index.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { narrate } from "@/components/chat/narrators";
import type { ToolCallData } from "@/src/lib/types";
import zhToolNarrator from "@/src/i18n/locales/zh/toolNarrator.json";

// 初始化测试用 i18n 实例
i18n.use(initReactI18next).init({
  resources: { zh: { toolNarrator: zhToolNarrator } },
  lng: "zh",
  ns: ["toolNarrator"],
  defaultNS: "toolNarrator",
  interpolation: { escapeValue: false },
});

const t = i18n.getFixedT("zh", "toolNarrator");

function makeTool(overrides: Partial<ToolCallData> = {}): ToolCallData {
  return {
    id: "test-id",
    title: "UnknownTool",
    status: "complete",
    ...overrides,
  };
}

describe("narrate 中央入口", () => {
  test("未匹配工具走 fallback，verb 为'用'", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const result = narrate(tool, "complete", undefined, t);
    expect(result.subtitle).toContain("用");
  });

  test("complete 状态副标题用过去时模板", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const result = narrate(tool, "complete", undefined, t);
    expect(result.subtitle).not.toContain("正在");
  });

  test("running 状态副标题用进行时模板（含'正在'）", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const result = narrate(tool, "running", undefined, t);
    expect(result.subtitle).toContain("正在");
  });

  test("rejected 状态归一化为 canceled", () => {
    const tool = makeTool({ title: "SomeUnknownTool", status: "rejected" });
    const result = narrate(tool, "rejected", undefined, t);
    expect(result.statusLabel).toBe("已取消");
  });

  test("complete 状态有耗时徽章", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const result = narrate(tool, "complete", 1500, t);
    expect(result.badge?.text).toBe("1.5s");
  });

  test("running 状态无耗时徽章", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const result = narrate(tool, "running", 1500, t);
    expect(result.badge).toBeUndefined();
  });

  test("error 状态从 rawOutput 提取 errorDetail", () => {
    const tool = makeTool({
      title: "SomeUnknownTool",
      status: "error",
      rawOutput: { isError: true, content: [{ type: "text", text: "File not found" }] },
    });
    const result = narrate(tool, "error", undefined, t);
    expect(result.errorDetail).toBe("File not found");
    expect(result.statusLabel).toBe("失败");
  });

  test("detail 字段保留原始 rawInput 和 rawOutput", () => {
    const rawInput = { foo: "bar" };
    const rawOutput = { baz: "qux" };
    const tool = makeTool({ title: "SomeUnknownTool", rawInput, rawOutput });
    const result = narrate(tool, "complete", undefined, t);
    expect(result.detail.rawInput).toEqual(rawInput);
    expect(result.detail.rawOutput).toEqual(rawOutput);
  });

  test("所有状态都有 statusLabel", () => {
    const tool = makeTool({ title: "SomeUnknownTool" });
    const statuses = ["running", "complete", "error", "waiting_for_confirmation", "canceled"] as const;
    for (const status of statuses) {
      const result = narrate(tool, status, undefined, t);
      expect(typeof result.statusLabel).toBe("string");
      expect(result.statusLabel.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators-index.test.ts`
Expected: FAIL，错误信息提示 `Cannot find module '@/components/chat/narrators'`

- [ ] **Step 3: 实现 fallback.ts**

创建文件 `web/components/chat/narrators/fallback.ts`：

```ts
import { Wrench } from "lucide-react";
import type { ToolNarrator } from "./types";
import { findFirstStringValue, truncate } from "./helpers";
import { simplifyToolName } from "../tool-call-utils";

/**
 * 兜底 narrator。注册表最后位，match 永远返回 true。
 *
 * 用于未知工具或未在注册表中显式声明的工具。
 * "用"作为动词，比"调用"简洁、比"调"自然。
 */
export const fallbackNarrator: ToolNarrator = {
  match: () => true,
  verb: "用",
  icon: Wrench,
  getDisplay(ctx) {
    // 复用现有的 simplifyToolName（保留首字母大写等格式化逻辑）
    const name = simplifyToolName(ctx.tool.title);
    const firstStr = findFirstStringValue(ctx.tool.rawInput);
    const display = firstStr ? `${name} · ${truncate(firstStr, 40)}` : name;
    return { title: display, object: display };
  },
};
```

- [ ] **Step 4: 实现 index.ts 中央入口**

创建文件 `web/components/chat/narrators/index.ts`：

```ts
import type {
  NarrationBadge,
  NarrationContext,
  NarrationResult,
  ToolNarrator,
  ToolStatus,
} from "./types";
import { extractErrorMessage, formatElapsed } from "./helpers";
import { fallbackNarrator } from "./fallback";

/**
 * 注册表。顺序敏感：先匹配专用 narrator，未命中走兜底。
 *
 * 占位：后续 task 会逐步把专用 narrator（read/edit/bash/...）插入到
 * fallbackNarrator 之前。
 */
const narrators: ToolNarrator[] = [
  // 专用 narrator 在此插入（Task 6+）
  fallbackNarrator, // 必须最后
];

/**
 * 中央 narrate 入口。ToolCallRow 调用此函数拿到完整的 NarrationResult。
 *
 * 职责：
 * 1. 把 rejected 归一化为 canceled（视觉上一致）
 * 2. 查注册表匹配 narrator（未命中走 fallback）
 * 3. 用 common.subtitle / subtitleRunning 模板拼接副标题
 * 4. 用 common.status.<status> 拿状态词
 * 5. error 状态额外提取错误信息
 * 6. 拼装徽章：narrator 自定义徽章优先于耗时徽章
 */
export function narrate(
  tool: NarrationContext["tool"],
  status: ToolStatus,
  elapsedMs: number | undefined,
  t: NarrationContext["t"],
): NarrationResult {
  // rejected 归一化为 canceled
  const normalizedStatus: Exclude<ToolStatus, "rejected"> =
    status === "rejected" ? "canceled" : status;

  const ctx: NarrationContext = { tool, status: normalizedStatus, elapsedMs, t };
  const lower = tool.title.toLowerCase();
  const narrator = narrators.find((n) => n.match(lower)) ?? fallbackNarrator;

  const { title, object } = narrator.getDisplay(ctx);
  const verb = narrator.verb;

  // 副标题：running 进行时，其他过去时
  const subtitleKey = normalizedStatus === "running" ? "common.subtitleRunning" : "common.subtitle";
  const subtitle = t(subtitleKey, { verb, object });

  // 状态词：全局统一
  const statusLabel = t(`common.status.${normalizedStatus}`);

  // 错误细节：error 状态从 rawOutput 提取，单独显示在 title 下方
  const errorDetail = normalizedStatus === "error" ? extractErrorMessage(tool.rawOutput) : undefined;

  // 徽章优先级：narrator 自定义徽章 > 耗时徽章
  const narratorBadge = narrator.badge?.(ctx);
  const elapsedBadge: NarrationBadge | undefined =
    (normalizedStatus === "complete" || normalizedStatus === "error") && elapsedMs
      ? { tone: "info", text: formatElapsed(elapsedMs) }
      : undefined;
  const badge = narratorBadge ?? elapsedBadge;

  return {
    icon: narrator.icon,
    title,
    subtitle,
    statusLabel,
    badge,
    errorDetail,
    detail: {
      rawInput: tool.rawInput,
      rawOutput: tool.rawOutput,
    },
  };
}

export type { ToolNarrator, NarrationContext, NarrationResult, ToolStatus } from "./types";
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators-index.test.ts`
Expected: PASS，所有 9 个测试通过

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/index.ts web/components/chat/narrators/fallback.ts web/src/__tests__/narrators-index.test.ts
git commit -m "feat(chat): 添加 narrate 中央入口和 fallback narrator"
```

---

## Task 6: read narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators/read.test.ts`
- Create: `web/components/chat/narrators/read.ts`
- Modify: `web/components/chat/narrators/index.ts`

- [ ] **Step 1: 写测试**

创建文件 `web/src/__tests__/narrators/read.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { readNarrator } from "@/components/chat/narrators/read";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "common.lineRange") return `第 ${opts?.range} 行`;
  return key;
}) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown): NarrationContext {
  return {
    tool: { id: "t1", title: "Read", status: "complete", rawInput: rawInput as Record<string, unknown> } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("readNarrator", () => {
  test("匹配包含 'read' 的工具名", () => {
    expect(readNarrator.match("read")).toBe(true);
    expect(readNarrator.match("Read")).toBe(true); // 大小写
    expect(readNarrator.match("fileread")).toBe(true);
    expect(readNarrator.match("write")).toBe(false);
  });

  test("verb 是 '读'", () => {
    expect(readNarrator.verb).toBe("读");
  });

  test("提取文件名（file_path）", () => {
    const { title, object } = readNarrator.getDisplay(makeCtx({ file_path: "/a/b/c.ts" }));
    expect(title).toBe("c.ts");
    expect(object).toBe("c.ts");
  });

  test("offset+limit 转成行号区间", () => {
    const { title, object } = readNarrator.getDisplay(
      makeCtx({ file_path: "/a/b/c.ts", offset: 100, limit: 50 }),
    );
    expect(title).toBe("c.ts");
    expect(object).toBe("c.ts 第 100-149 行");
  });

  test("无 offset 时只显示文件名", () => {
    const { object } = readNarrator.getDisplay(makeCtx({ file_path: "/x.ts" }));
    expect(object).toBe("x.ts");
  });

  test("兼容 path 字段", () => {
    const { title } = readNarrator.getDisplay(makeCtx({ path: "/y/z.ts" }));
    expect(title).toBe("z.ts");
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators/read.test.ts`
Expected: FAIL，`Cannot find module '@/components/chat/narrators/read'`

- [ ] **Step 3: 实现 read.ts**

创建文件 `web/components/chat/narrators/read.ts`：

```ts
import { FileText } from "lucide-react";
import type { ToolNarrator } from "./types";
import { extractFileName, extractLineRange } from "./helpers";

/**
 * Read 工具 narrator。处理文件读取调用。
 *
 * 副标题样例：
 * - running: "正在读 config.ts 第 120-180 行"
 * - complete: "读 config.ts 第 120-180 行"（+ 耗时徽章）
 */
export const readNarrator: ToolNarrator = {
  match: (name) => name.includes("read"),
  verb: "读",
  icon: FileText,
  getDisplay(ctx) {
    const file = extractFileName(ctx.tool.rawInput);
    const range = extractLineRange(ctx.tool.rawInput);
    const object = range ? `${file} ${ctx.t("common.lineRange", { range })}` : file;
    return { title: file, object };
  },
};
```

- [ ] **Step 4: 注册到 index.ts**

修改 `web/components/chat/narrators/index.ts`：

在 `import { fallbackNarrator } from "./fallback";` 后添加：

```ts
import { readNarrator } from "./read";
```

把 `narrators` 数组改为：

```ts
const narrators: ToolNarrator[] = [
  readNarrator,
  // 其他专用 narrator 在此插入（Task 7+）
  fallbackNarrator, // 必须最后
];
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators/read.test.ts web/src/__tests__/narrators-index.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/read.ts web/components/chat/narrators/index.ts web/src/__tests__/narrators/read.test.ts
git commit -m "feat(chat): 添加 read narrator"
```

---

## Task 7: edit narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators/edit.test.ts`
- Create: `web/components/chat/narrators/edit.ts`
- Modify: `web/components/chat/narrators/index.ts`

- [ ] **Step 1: 写测试**

创建文件 `web/src/__tests__/narrators/edit.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { editNarrator } from "@/components/chat/narrators/edit";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "toolNarrator.edit.changes") return `${opts?.count} 处`;
  return key;
}) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown, content?: unknown): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Edit",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
      content: content as ToolCallData["content"],
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("editNarrator", () => {
  test("匹配 edit/str_replace/multiedit", () => {
    expect(editNarrator.match("edit")).toBe(true);
    expect(editNarrator.match("str_replace")).toBe(true);
    expect(editNarrator.match("multiedit")).toBe(true);
    expect(editNarrator.match("read")).toBe(false);
  });

  test("verb 是 '改'", () => {
    expect(editNarrator.verb).toBe("改");
  });

  test("提取文件名", () => {
    const { title } = editNarrator.getDisplay(makeCtx({ file_path: "/x/y.ts" }));
    expect(title).toBe("y.ts");
  });

  test("complete 状态有变更数徽章（content 含 diff）", () => {
    const content = [
      { type: "diff", content: "..." },
      { type: "diff", content: "..." },
    ];
    const ctx = makeCtx({ file_path: "/x.ts" }, content);
    const badge = editNarrator.badge?.(ctx);
    expect(badge?.tone).toBe("success");
    expect(badge?.text).toBe("2 处");
  });

  test("无 diff 时无徽章", () => {
    const ctx = makeCtx({ file_path: "/x.ts" }, []);
    expect(editNarrator.badge?.(ctx)).toBeUndefined();
  });

  test("非 complete 状态无徽章", () => {
    const ctx = makeCtx({ file_path: "/x.ts" }, [{ type: "diff", content: "..." }]);
    ctx.status = "running";
    expect(editNarrator.badge?.(ctx)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators/edit.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 edit.ts**

创建文件 `web/components/chat/narrators/edit.ts`：

```ts
import { FilePen } from "lucide-react";
import type { NarrationBadge, NarrationContext, ToolNarrator } from "./types";
import { extractFileName } from "./helpers";

/**
 * Edit / StrReplace / MultiEdit 工具 narrator。
 *
 * 复用现有 countDiffs（从 content 数组中数 type==='diff' 的条目）。
 * complete 状态下显示"N 处"徽章。
 */
export const editNarrator: ToolNarrator = {
  match: (name) => name.includes("edit") || name.includes("str_replace") || name.includes("multiedit"),
  verb: "改",
  icon: FilePen,
  getDisplay(ctx) {
    const file = extractFileName(ctx.tool.rawInput);
    return { title: file, object: file };
  },
  badge(ctx): NarrationBadge | undefined {
    if (ctx.status !== "complete") return undefined;
    const content = ctx.tool.content;
    if (!content || !Array.isArray(content)) return undefined;
    const count = content.filter((c) => c && typeof c === "object" && (c as { type: string }).type === "diff").length;
    if (count === 0) return undefined;
    return {
      tone: "success",
      text: ctx.t("toolNarrator.edit.changes", { count }),
    };
  },
};
```

- [ ] **Step 4: 注册到 index.ts**

修改 `web/components/chat/narrators/index.ts`，在 `import { readNarrator }` 后添加：

```ts
import { editNarrator } from "./edit";
```

在 `narrators` 数组中 `readNarrator` 后添加 `editNarrator`：

```ts
const narrators: ToolNarrator[] = [
  readNarrator,
  editNarrator,
  // 其他专用 narrator 在此插入
  fallbackNarrator,
];
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators/edit.test.ts web/src/__tests__/narrators-index.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/edit.ts web/components/chat/narrators/index.ts web/src/__tests__/narrators/edit.test.ts
git commit -m "feat(chat): 添加 edit narrator"
```

---

## Task 8: bash narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators/bash.test.ts`
- Create: `web/components/chat/narrators/bash.ts`
- Modify: `web/components/chat/narrators/index.ts`

- [ ] **Step 1: 写测试**

创建文件 `web/src/__tests__/narrators/bash.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { bashNarrator } from "@/components/chat/narrators/bash";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Bash",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("bashNarrator", () => {
  test("匹配 bash/shell/exec/command", () => {
    expect(bashNarrator.match("bash")).toBe(true);
    expect(bashNarrator.match("shell")).toBe(true);
    expect(bashNarrator.match("exec")).toBe(true);
    expect(bashNarrator.match("command")).toBe(true);
    expect(bashNarrator.match("read")).toBe(false);
  });

  test("verb 是 '跑'", () => {
    expect(bashNarrator.verb).toBe("跑");
  });

  test("title 加 $ 前缀", () => {
    const { title } = bashNarrator.getDisplay(makeCtx({ command: "npm install" }));
    expect(title).toBe("$ npm install");
  });

  test("object 不带 $ 前缀", () => {
    const { object } = bashNarrator.getDisplay(makeCtx({ command: "npm install" }));
    expect(object).toBe("npm install");
  });

  test("长命令截断到 120 字符", () => {
    const longCmd = "x".repeat(200);
    const { title, object } = bashNarrator.getDisplay(makeCtx({ command: longCmd }));
    expect((title as string).length).toBeLessThanOrEqual(123); // "$ " + 120 + …
    expect((object as string).length).toBeLessThanOrEqual(121);
  });

  test("无 command 字段时降级", () => {
    const { title, object } = bashNarrator.getDisplay(makeCtx({}));
    expect(title).toBe("$ ");
    expect(object).toBe("");
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators/bash.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 bash.ts**

创建文件 `web/components/chat/narrators/bash.ts`：

```ts
import { Terminal } from "lucide-react";
import type { ToolNarrator } from "./types";
import { truncate } from "./helpers";

/**
 * Bash / Shell / Exec / Command 工具 narrator。
 *
 * title 加 $ 前缀（视觉上提示这是命令）；
 * object 不带前缀（副标题里已经有动词"跑"了）。
 */
export const bashNarrator: ToolNarrator = {
  match: (name) =>
    name.includes("bash") || name.includes("shell") || name.includes("exec") || name === "command",
  verb: "跑",
  icon: Terminal,
  getDisplay(ctx) {
    const cmd = String(
      (ctx.tool.rawInput as Record<string, unknown> | undefined)?.command ?? "",
    );
    const truncated = truncate(cmd, 120);
    return {
      title: `$ ${truncated}`,
      object: truncated,
    };
  },
};
```

- [ ] **Step 4: 注册到 index.ts**

修改 `web/components/chat/narrators/index.ts`，添加导入和注册：

```ts
import { bashNarrator } from "./bash";
```

```ts
const narrators: ToolNarrator[] = [
  readNarrator,
  editNarrator,
  bashNarrator,
  // 其他专用 narrator 在此插入
  fallbackNarrator,
];
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators/bash.test.ts web/src/__tests__/narrators-index.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/bash.ts web/components/chat/narrators/index.ts web/src/__tests__/narrators/bash.test.ts
git commit -m "feat(chat): 添加 bash narrator"
```

---

## Task 9: grep narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators/grep.test.ts`
- Create: `web/components/chat/narrators/grep.ts`
- Modify: `web/components/chat/narrators/index.ts`

- [ ] **Step 1: 写测试**

创建文件 `web/src/__tests__/narrators/grep.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { grepNarrator } from "@/components/chat/narrators/grep";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "common.inPath") return `在 ${opts?.path}`;
  if (key === "toolNarrator.grep.results") return `找到 ${opts?.count} 个`;
  return key;
}) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown, rawOutput?: unknown, status: NarrationContext["status"] = "complete"): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Grep",
      status: status as ToolCallData["status"],
      rawInput: rawInput as Record<string, unknown>,
      rawOutput: rawOutput as Record<string, unknown> | undefined,
    } as ToolCallData,
    status,
    t: mockT,
  };
}

describe("grepNarrator", () => {
  test("匹配 grep/rg", () => {
    expect(grepNarrator.match("grep")).toBe(true);
    expect(grepNarrator.match("rg")).toBe(true);
    expect(grepNarrator.match("read")).toBe(false);
  });

  test("verb 是 '搜'", () => {
    expect(grepNarrator.verb).toBe("搜");
  });

  test("title 是带引号的 pattern", () => {
    const { title } = grepNarrator.getDisplay(makeCtx({ pattern: "useEffect" }));
    expect(title).toBe('"useEffect"');
  });

  test("有 path 时 object 加路径后缀", () => {
    const { object } = grepNarrator.getDisplay(makeCtx({ pattern: "useEffect", path: "/src" }));
    expect(object).toBe('"useEffect" 在 /src');
  });

  test("无 path 时 object 只有 pattern", () => {
    const { object } = grepNarrator.getDisplay(makeCtx({ pattern: "useEffect" }));
    expect(object).toBe('"useEffect"');
  });

  test("complete 状态从 count 字段提取结果数徽章", () => {
    const ctx = makeCtx({ pattern: "x" }, { count: 5 });
    expect(grepNarrator.badge?.(ctx)?.text).toBe("找到 5 个");
  });

  test("complete 状态从 content 文本提取结果数", () => {
    const ctx = makeCtx({ pattern: "x" }, { content: [{ type: "text", text: "3 matches found" }] });
    expect(grepNarrator.badge?.(ctx)?.text).toBe("找到 3 个");
  });

  test("running 状态无徽章", () => {
    const ctx = makeCtx({ pattern: "x" }, { count: 5 }, "running");
    expect(grepNarrator.badge?.(ctx)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators/grep.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 grep.ts**

创建文件 `web/components/chat/narrators/grep.ts`：

```ts
import { Search } from "lucide-react";
import type { NarrationBadge, NarrationContext, ToolNarrator } from "./types";
import { truncate } from "./helpers";

/**
 * Grep / Rg 工具 narrator。处理代码搜索。
 *
 * complete 状态下从 rawOutput 提取结果数量，作为自定义徽章
 * （优先于耗时徽章）。
 */
export const grepNarrator: ToolNarrator = {
  match: (name) => name.includes("grep") || name.includes("rg"),
  verb: "搜",
  icon: Search,
  getDisplay(ctx) {
    const raw = ctx.tool.rawInput as Record<string, unknown> | undefined;
    const pattern = String(raw?.pattern ?? "");
    const path = String(raw?.path ?? raw?.include ?? "");
    const quoted = `"${truncate(pattern, 40)}"`;
    const object = path ? `${quoted} ${ctx.t("common.inPath", { path: truncate(path, 30) })}` : quoted;
    return { title: quoted, object };
  },
  badge(ctx): NarrationBadge | undefined {
    if (ctx.status !== "complete") return undefined;
    const count = extractGrepResultCount(ctx.tool.rawOutput);
    if (!count) return undefined;
    return {
      tone: "success",
      text: ctx.t("toolNarrator.grep.results", { count }),
    };
  },
};

/** 从 Grep 的 rawOutput 提取结果数量。结构因 Agent 而异，常见模式：
 * - { count: N }
 * - { content: [{ type: "text", text: "N matches" }] }
 */
function extractGrepResultCount(rawOutput: unknown): number | undefined {
  if (!rawOutput || typeof rawOutput !== "object") return undefined;
  const o = rawOutput as Record<string, unknown>;
  if (typeof o.count === "number") return o.count;
  if (Array.isArray(o.content)) {
    for (const c of o.content as Array<{ type: string; text?: unknown }>) {
      if (c.type === "text" && typeof c.text === "string") {
        const m = c.text.match(/(\d+)\s*(?:matches|results|hits)/i);
        if (m) return Number(m[1]);
      }
    }
  }
  return undefined;
}
```

- [ ] **Step 4: 注册到 index.ts**

修改 `web/components/chat/narrators/index.ts`，添加：

```ts
import { grepNarrator } from "./grep";
```

```ts
const narrators: ToolNarrator[] = [
  readNarrator,
  editNarrator,
  bashNarrator,
  grepNarrator,
  // 其他专用 narrator 在此插入
  fallbackNarrator,
];
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators/grep.test.ts web/src/__tests__/narrators-index.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/grep.ts web/components/chat/narrators/index.ts web/src/__tests__/narrators/grep.test.ts
git commit -m "feat(chat): 添加 grep narrator"
```

---

## Task 10: write narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators/write.test.ts`
- Create: `web/components/chat/narrators/write.ts`
- Modify: `web/components/chat/narrators/index.ts`

- [ ] **Step 1: 写测试**

创建文件 `web/src/__tests__/narrators/write.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { writeNarrator } from "@/components/chat/narrators/write";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Write",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("writeNarrator", () => {
  test("匹配 write", () => {
    expect(writeNarrator.match("write")).toBe(true);
    expect(writeNarrator.match("file_write")).toBe(true);
    expect(writeNarrator.match("read")).toBe(false);
  });

  test("verb 是 '写'", () => {
    expect(writeNarrator.verb).toBe("写");
  });

  test("提取文件名", () => {
    const { title, object } = writeNarrator.getDisplay(makeCtx({ file_path: "/a/b/new.ts" }));
    expect(title).toBe("new.ts");
    expect(object).toBe("new.ts");
  });

  test("兼容 path 字段", () => {
    const { title } = writeNarrator.getDisplay(makeCtx({ path: "/x.ts" }));
    expect(title).toBe("x.ts");
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators/write.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 write.ts**

创建文件 `web/components/chat/narrators/write.ts`：

```ts
import { FilePlus } from "lucide-react";
import type { ToolNarrator } from "./types";
import { extractFileName } from "./helpers";

/**
 * Write 工具 narrator。处理文件创建/覆盖写入。
 */
export const writeNarrator: ToolNarrator = {
  match: (name) => name.includes("write"),
  verb: "写",
  icon: FilePlus,
  getDisplay(ctx) {
    const file = extractFileName(ctx.tool.rawInput);
    return { title: file, object: file };
  },
};
```

- [ ] **Step 4: 注册到 index.ts**

修改 `web/components/chat/narrators/index.ts`，添加：

```ts
import { writeNarrator } from "./write";
```

```ts
const narrators: ToolNarrator[] = [
  readNarrator,
  editNarrator,
  writeNarrator,
  bashNarrator,
  grepNarrator,
  fallbackNarrator,
];
```

> **顺序说明**：write 在 edit 之前注册，因为 `edit` 也包含 "e"，而 `write` 包含 "e" 但不包含 "edit"，所以 write.edit 不冲突；但 `multiedit` 包含 `edit` 必须命中 editNarrator，所以 edit 在 write 之后是安全的（因为 multiedit 不会先匹配到 write）。实际测试顺序：write → edit → 都用 includes，互不冲突。

- [ ] **Step 5: 运行测试，验证通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators/ web/src/__tests__/narrators-index.test.ts`
Expected: PASS（所有 narrator 测试通过）

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/write.ts web/components/chat/narrators/index.ts web/src/__tests__/narrators/write.test.ts
git commit -m "feat(chat): 添加 write narrator，完成核心 5 个工具"
```

---

## Task 11: 接入 ToolCallRow + ToolCallContent + ChatInterface

**Files:**
- Modify: `web/components/chat/ToolCallRow.tsx`
- Modify: `web/components/chat/ToolCallContent.tsx`
- Modify: `web/src/acp/ChatInterface.tsx`

> 这是改造工作量最大的 task。完成此 task 后，5 个核心工具的展示就完全切换到新 narrator 系统。剩余 7 个工具仍走 fallback（功能可用但文案不优化）。

- [ ] **Step 1: 改造 ChatInterface.tsx 记录 startedAt**

打开 `web/src/acp/ChatInterface.tsx`，搜索 `toolCallData` 或 `tool_call` 的状态更新逻辑。在工具调用首次出现时记录时间戳，complete/error 时计算 elapsed。

> **实施提示**：找到维护 toolCallData 的 useState 或 reducer。在收到 running 状态的工具调用时，在 tool 对象上加 `_startedAt: Date.now()`（或维护一个独立的 `Map<toolCallId, number>` ref）。当渲染 ToolCallRow 时传入 `elapsedMs = Date.now() - startedAt`（complete/error 状态下冻结）。

具体改造点：

1. 在 `ChatInterface` 组件内加一个 ref：

```ts
const toolCallStartedAtRef = useRef<Map<string, number>>(new Map());
```

2. 在处理 tool_call 事件的代码里（搜索 `case "tool_call"` 或类似），首次见到 `toolCallId` 时记录：

```ts
if (!toolCallStartedAtRef.current.has(update.toolCallId)) {
  toolCallStartedAtRef.current.set(update.toolCallId, Date.now());
}
```

3. 在渲染 `<ToolCallRow>` 处，计算 elapsedMs：

```ts
{entries.map((entry) => {
  if (entry.type !== "tool_call") return null;
  const tool = entry.toolCall;
  const startedAt = toolCallStartedAtRef.current.get(tool.id);
  const elapsedMs = startedAt && (tool.status === "complete" || tool.status === "error" || tool.status === "canceled")
    ? Date.now() - startedAt  // 注：实际应在状态变更瞬间冻结，这里简化为渲染时计算
    : undefined;
  return <ToolCallRow key={tool.id} tool={tool} elapsedMs={elapsedMs} />;
})}
```

> **简化说明**：第一版用渲染时计算 elapsed，会导致 complete 状态下 elapsed 持续增长。如需精确冻结，可在事件处理时记录 `finalElapsedMs`。spec 风险章节已提到这个权衡，第一版可接受。

4. 给 `ToolCallRow` 加 `elapsedMs?: number` props。

- [ ] **Step 2: 改造 ToolCallRow.tsx 调用 narrate()**

完整重写 `web/components/chat/ToolCallRow.tsx`。保留子 agent 嵌套面板、权限按钮、详情弹窗的现有结构，把内容渲染部分改为调用 `narrate()`。

完整文件内容：

```tsx
import { CodeXml, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolCallData } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";
import { ToolPermissionButtons } from "../ai-elements/permission-request";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { SubAgentPanel } from "./SubAgentPanel";
import { narrate } from "./narrators";
import { NS } from "../../src/i18n";
import {
  CARD_STYLES,
  formatOutput,
  getCardCategory,
  truncate,
} from "./tool-call-utils";

// =============================================================================
// 单张工具卡片 — 调用 narrate() 生成统一格式的人话文案
// =============================================================================

interface ToolCallRowProps {
  tool: ToolCallData;
  elapsedMs?: number;
  onPermissionRespond?: (requestId: string, optionId: string | null, optionKind: string | null) => void;
}

export function ToolCallRow({ tool, elapsedMs, onPermissionRespond }: ToolCallRowProps) {
  const { t: tComponents } = useTranslation("components");
  const { t: tNarrator } = useTranslation(NS.TOOL_NARRATOR);
  const [dialogOpen, setDialogOpen] = useState(false);

  // 调用 narrate 拿到统一的展示数据
  const result = narrate(tool, tool.status, elapsedMs, tNarrator);

  // 卡片颜色继续走现有逻辑（避免一次性改太多）
  const cardCategory = getCardCategory(tool.title, tool.rawInput);
  const style = CARD_STYLES[cardCategory];
  const Icon = result.icon ?? Loader2;

  const isRunning = tool.status === "running";
  const isError = tool.status === "error";
  const isPending = tool.status === "waiting_for_confirmation";
  const isCanceled = tool.status === "canceled" || tool.status === "rejected";
  const hasSubEntries = (tool.subEntries?.length ?? 0) > 0;

  const hasParams =
    (tool.rawInput && Object.keys(tool.rawInput).length > 0) ||
    (!isRunning && !isPending && (tool.rawOutput || tool.content));

  const openDialog = useCallback(() => {
    if (hasParams && !isPending) setDialogOpen(true);
  }, [hasParams, isPending]);

  return (
    <div>
      {/* 卡片主体 */}
      <div
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 rounded-lg",
          style.cardBg,
          isError && "ring-1 ring-inset ring-status-error/30",
          isCanceled && "opacity-50",
        )}
      >
        {/* 图标 */}
        <div
          className={cn(
            "h-10 w-10 rounded-xl flex items-center justify-center shrink-0",
            style.iconBg,
            isRunning && "animate-pulse",
          )}
        >
          {isRunning ? (
            <Loader2 className={cn("h-[18px] w-[18px] animate-spin", style.iconColor)} />
          ) : (
            <Icon className={cn("h-[18px] w-[18px]", style.iconColor)} />
          )}
        </div>

        {/* 工具内容 — 渲染 narrate 结果 */}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-text-primary truncate">{result.title}</div>
          <div className="text-[11px] text-text-dim mt-0.5 truncate flex items-center gap-1.5">
            <span className="truncate">{result.subtitle}</span>
            {result.badge && (
              <span
                className={cn(
                  "text-[10px] shrink-0",
                  result.badge.tone === "success" && "text-emerald-600 dark:text-emerald-400",
                  result.badge.tone === "error" && "text-status-error",
                  result.badge.tone === "warn" && "text-amber-600 dark:text-amber-400",
                  result.badge.tone === "info" && "text-text-dim",
                )}
              >
                {result.badge.text}
              </span>
            )}
          </div>
          {/* 错误细节单独一行 */}
          {result.errorDetail && (
            <div className="text-[10px] text-status-error/80 mt-0.5 truncate" title={result.errorDetail}>
              {result.errorDetail}
            </div>
          )}
        </div>

        {/* 右侧状态标签 */}
        <span
          className={cn(
            "text-[10px] font-medium shrink-0",
            isError && "text-status-error",
            isPending && "text-brand",
            isCanceled && "text-text-dim",
            !isError && !isPending && !isCanceled && "text-text-dim",
          )}
        >
          {result.statusLabel}
        </span>

        {/* 参数弹窗按钮 */}
        {hasParams && !isPending && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openDialog();
            }}
            className="h-6 w-6 rounded-md flex items-center justify-center shrink-0 text-text-dim hover:text-text-muted hover:bg-surface-2/80 transition-colors"
            title={tComponents("toolCallRow.viewParams")}
          >
            <CodeXml className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* 子 agent 嵌套面板（保留） */}
      {hasSubEntries && (
        <div className="max-h-64 overflow-y-auto mx-1 mt-1 mb-1 rounded-md border border-border/40 bg-surface-0/50">
          <div className="px-2 py-2">
            <SubAgentPanel entries={tool.subEntries!} />
          </div>
        </div>
      )}

      {/* 权限请求按钮（保留） */}
      {isPending && tool.permissionRequest && (
        <div className="px-4 pb-2.5 pt-1" onClick={(e) => e.stopPropagation()}>
          <ToolPermissionButtons
            requestId={tool.permissionRequest.requestId}
            options={tool.permissionRequest.options}
            onRespond={onPermissionRespond || (() => {})}
          />
        </div>
      )}

      {/* 参数弹窗（保留） */}
      {hasParams && (
        <ToolCallDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          tool={tool}
          style={style}
          icon={Icon}
          title={result.title}
          t={tComponents}
        />
      )}
    </div>
  );
}

// =============================================================================
// 参数弹窗 — 展示入参出参原始 JSON
// =============================================================================

interface ToolCallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tool: ToolCallData;
  style: { iconBg: string; iconColor: string };
  icon: React.ComponentType<{ className?: string }>;
  title: React.ReactNode;
  t: (key: string) => string;
}

function ToolCallDialog({ open, onOpenChange, tool, style, icon: Icon, title, t }: ToolCallDialogProps) {
  const isError = tool.status === "error";
  const isRunning = tool.status === "running";
  const hasOutput = !isRunning && (tool.rawOutput || tool.content);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle className="text-sm font-medium flex items-center gap-2.5">
            <div className={cn("h-7 w-7 rounded-lg flex items-center justify-center", style.iconBg)}>
              <Icon className={cn("h-3.5 w-3.5", style.iconColor)} />
            </div>
            <span className="truncate">{title}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="px-4 py-3 space-y-3 max-h-[60vh] overflow-y-auto">
          {tool.rawInput && Object.keys(tool.rawInput).length > 0 && (
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-widest text-text-dim mb-1.5">
                {t("toolCallGroup.input")}
              </div>
              <pre className="tool-call-detail-code text-[11px] bg-surface-2 rounded-md px-3 py-2.5 overflow-auto font-mono text-text-secondary leading-relaxed">
                {truncate(JSON.stringify(tool.rawInput, null, 2), 3000)}
              </pre>
            </div>
          )}
          {hasOutput && (
            <div>
              <div className="text-[9px] font-semibold uppercase tracking-widest text-text-dim mb-1.5">
                {t("toolCallGroup.output")}
              </div>
              <pre
                className={cn(
                  "tool-call-detail-code text-[11px] rounded-md px-3 py-2.5 overflow-auto font-mono leading-relaxed",
                  isError ? "bg-status-error/6 text-status-error" : "bg-surface-2 text-text-secondary",
                )}
              >
                {formatOutput(tool)}
              </pre>
            </div>
          )}
          {isRunning && !hasOutput && <p className="text-xs text-text-dim italic">工具正在执行中...</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

> **保留的功能**：子 agent 嵌套（SubAgentPanel）、权限请求按钮（ToolPermissionButtons）、详情弹窗（rawInput/rawOutput JSON 展示）、卡片颜色（CARD_STYLES）。
>
> **删除的功能**：ToolCardContent 的每工具分支（被 narrate 取代）、streamingPreview 流式预览（第一版不实现）、description 优先级展示（第一版不实现）。

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit -p web/tsconfig.json 2>&1 | head -30`
Expected: 无 ToolCallRow 相关错误

- [ ] **Step 4: 运行前端测试**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/`
Expected: PASS（如果有 ToolCallRow 相关测试失败，根据错误调整）

- [ ] **Step 5: 构建前端验证**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -20`
Expected: 构建成功

- [ ] **Step 6: 手动验证（可选但推荐）**

启动 dev server：`bun run dev:web`，打开 chat 界面，触发 Agent 工具调用（Read/Edit/Bash/Grep/Write），观察：
- 卡片显示中文叙述副标题（"正在读 config.ts · 进行中"）
- 完成后显示耗时徽章（"1.2s"）
- Edit 工具显示变更数徽章
- Grep 工具显示结果数徽章
- 失败时 title 下方显示错误细节

- [ ] **Step 7: Commit**

```bash
git add web/components/chat/ToolCallRow.tsx web/src/acp/ChatInterface.tsx
git commit -m "feat(chat): 接入 narrate() 系统，切换工具调用文案到人性化版本"
```

---

## Task 12: glob narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators/glob.test.ts`
- Create: `web/components/chat/narrators/glob.ts`
- Modify: `web/components/chat/narrators/index.ts`

- [ ] **Step 1: 写测试**

创建 `web/src/__tests__/narrators/glob.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { globNarrator } from "@/components/chat/narrators/glob";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "toolNarrator.glob.files") return `${opts?.count} 个文件`;
  return key;
}) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown, rawOutput?: unknown, status: NarrationContext["status"] = "complete"): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Glob",
      status: status as ToolCallData["status"],
      rawInput: rawInput as Record<string, unknown>,
      rawOutput: rawOutput as Record<string, unknown> | undefined,
    } as ToolCallData,
    status,
    t: mockT,
  };
}

describe("globNarrator", () => {
  test("匹配 glob/find/listfiles", () => {
    expect(globNarrator.match("glob")).toBe(true);
    expect(globNarrator.match("find")).toBe(true);
    expect(globNarrator.match("listfiles")).toBe(true);
    expect(globNarrator.match("list_files")).toBe(true);
  });

  test("verb 是 '找'", () => {
    expect(globNarrator.verb).toBe("找");
  });

  test("title 和 object 都是 pattern", () => {
    const { title, object } = globNarrator.getDisplay(makeCtx({ pattern: "**/*.ts" }));
    expect(title).toBe("**/*.ts");
    expect(object).toBe("**/*.ts");
  });

  test("complete 状态有文件数徽章", () => {
    const ctx = makeCtx({ pattern: "**/*.ts" }, { files: ["a.ts", "b.ts"] });
    expect(globNarrator.badge?.(ctx)?.text).toBe("2 个文件");
  });

  test("无文件时无徽章", () => {
    const ctx = makeCtx({ pattern: "**/*.ts" }, { files: [] });
    expect(globNarrator.badge?.(ctx)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `bun test web/src/__tests__/narrators/glob.test.ts`（在 repo 根目录运行）
Expected: FAIL

- [ ] **Step 3: 实现 glob.ts**

创建 `web/components/chat/narrators/glob.ts`：

```ts
import { FolderSearch } from "lucide-react";
import type { NarrationBadge, NarrationContext, ToolNarrator } from "./types";
import { truncate } from "./helpers";

/**
 * Glob / Find / ListFiles 工具 narrator。处理文件通配符匹配。
 */
export const globNarrator: ToolNarrator = {
  match: (name) => name.includes("glob") || name.includes("find") || name.includes("listfiles") || name.includes("list_files"),
  verb: "找",
  icon: FolderSearch,
  getDisplay(ctx) {
    const pattern = String(
      (ctx.tool.rawInput as Record<string, unknown> | undefined)?.pattern ?? "",
    );
    const display = truncate(pattern, 80);
    return { title: display, object: display };
  },
  badge(ctx): NarrationBadge | undefined {
    if (ctx.status !== "complete") return undefined;
    const raw = ctx.tool.rawOutput as Record<string, unknown> | undefined;
    const files = raw?.files;
    if (!Array.isArray(files)) return undefined;
    return {
      tone: "success",
      text: ctx.t("toolNarrator.glob.files", { count: files.length }),
    };
  },
};
```

- [ ] **Step 4: 注册到 index.ts**

修改 `web/components/chat/narrators/index.ts`：

```ts
import { globNarrator } from "./glob";
```

```ts
const narrators: ToolNarrator[] = [
  readNarrator,
  editNarrator,
  writeNarrator,
  bashNarrator,
  grepNarrator,
  globNarrator,
  fallbackNarrator,
];
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `bun test web/src/__tests__/narrators/glob.test.ts web/src/__tests__/narrators-index.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/glob.ts web/components/chat/narrators/index.ts web/src/__tests__/narrators/glob.test.ts
git commit -m "feat(chat): 添加 glob narrator"
```

---

## Task 13: web-fetch narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators/web-fetch.test.ts`
- Create: `web/components/chat/narrators/web-fetch.ts`
- Modify: `web/components/chat/narrators/index.ts`

- [ ] **Step 1: 写测试**

创建 `web/src/__tests__/narrators/web-fetch.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { webFetchNarrator } from "@/components/chat/narrators/web-fetch";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "WebFetch",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("webFetchNarrator", () => {
  test("匹配 fetch/webfetch/curl", () => {
    expect(webFetchNarrator.match("fetch")).toBe(true);
    expect(webFetchNarrator.match("webfetch")).toBe(true);
    expect(webFetchNarrator.match("curl")).toBe(true);
    expect(webFetchNarrator.match("read")).toBe(false);
  });

  test("verb 是 '抓'", () => {
    expect(webFetchNarrator.verb).toBe("抓");
  });

  test("URL 作为 title 和 object", () => {
    const { title, object } = webFetchNarrator.getDisplay(makeCtx({ url: "https://example.com/page" }));
    expect(title).toBe("https://example.com/page");
    expect(object).toBe("https://example.com/page");
  });

  test("长 URL 截断到 80 字符", () => {
    const longUrl = `https://example.com/${"x".repeat(100)}`;
    const { title } = webFetchNarrator.getDisplay(makeCtx({ url: longUrl }));
    expect((title as string).length).toBe(81); // 80 + 省略号
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `bun test web/src/__tests__/narrators/web-fetch.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 web-fetch.ts**

创建 `web/components/chat/narrators/web-fetch.ts`：

```ts
import { Globe } from "lucide-react";
import type { ToolNarrator } from "./types";
import { truncate } from "./helpers";

/**
 * WebFetch / Fetch / Curl 工具 narrator。
 */
export const webFetchNarrator: ToolNarrator = {
  match: (name) => name.includes("fetch") || name.includes("curl"),
  verb: "抓",
  icon: Globe,
  getDisplay(ctx) {
    const url = String(
      (ctx.tool.rawInput as Record<string, unknown> | undefined)?.url ?? "",
    );
    const display = truncate(url, 80);
    return { title: display, object: display };
  },
};
```

> **注意**：match 用 `includes("fetch")` 而非 `includes("webfetch")`，因为某些 Agent 用 `Fetch` 简称。但要确保 WebSearch 不命中此 narrator（WebSearch match 用 `includes("search")`，不含 `fetch`，安全）。

- [ ] **Step 4: 注册到 index.ts**

修改 `web/components/chat/narrators/index.ts`：

```ts
import { webFetchNarrator } from "./web-fetch";
```

```ts
const narrators: ToolNarrator[] = [
  readNarrator,
  editNarrator,
  writeNarrator,
  bashNarrator,
  grepNarrator,
  globNarrator,
  webFetchNarrator,
  fallbackNarrator,
];
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `bun test web/src/__tests__/narrators/web-fetch.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/web-fetch.ts web/components/chat/narrators/index.ts web/src/__tests__/narrators/web-fetch.test.ts
git commit -m "feat(chat): 添加 web-fetch narrator"
```

---

## Task 14: web-search narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators/web-search.test.ts`
- Create: `web/components/chat/narrators/web-search.ts`
- Modify: `web/components/chat/narrators/index.ts`

- [ ] **Step 1: 写测试**

创建 `web/src/__tests__/narrators/web-search.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { webSearchNarrator } from "@/components/chat/narrators/web-search";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "toolNarrator.webSearch.results") return `找到 ${opts?.count} 个`;
  return key;
}) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown, rawOutput?: unknown, status: NarrationContext["status"] = "complete"): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "WebSearch",
      status: status as ToolCallData["status"],
      rawInput: rawInput as Record<string, unknown>,
      rawOutput: rawOutput as Record<string, unknown> | undefined,
    } as ToolCallData,
    status,
    t: mockT,
  };
}

describe("webSearchNarrator", () => {
  test("匹配 search/websearch", () => {
    expect(webSearchNarrator.match("search")).toBe(true);
    expect(webSearchNarrator.match("websearch")).toBe(true);
    expect(webSearchNarrator.match("web_search")).toBe(true);
    expect(webSearchNarrator.match("grep")).toBe(false);
  });

  test("verb 是 '搜'", () => {
    expect(webSearchNarrator.verb).toBe("搜");
  });

  test("query 加引号作为 title", () => {
    const { title } = webSearchNarrator.getDisplay(makeCtx({ query: "claude code" }));
    expect(title).toBe('"claude code"');
  });

  test("兼容 search 字段", () => {
    const { title } = webSearchNarrator.getDisplay(makeCtx({ search: "hello" }));
    expect(title).toBe('"hello"');
  });

  test("complete 状态有结果数徽章", () => {
    const ctx = makeCtx({ query: "x" }, { count: 8 });
    expect(webSearchNarrator.badge?.(ctx)?.text).toBe("找到 8 个");
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `bun test web/src/__tests__/narrators/web-search.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 web-search.ts**

创建 `web/components/chat/narrators/web-search.ts`：

```ts
import { Search } from "lucide-react";
import type { NarrationBadge, NarrationContext, ToolNarrator } from "./types";
import { truncate } from "./helpers";

/**
 * WebSearch 工具 narrator。
 *
 * 必须在 webFetchNarrator 之后注册：虽然 webSearch 和 webFetch 的 match
 * 不冲突（search vs fetch），但保持" specialised before generic" 的注册顺序。
 */
export const webSearchNarrator: ToolNarrator = {
  match: (name) => name.includes("search"),
  verb: "搜",
  icon: Search,
  getDisplay(ctx) {
    const raw = ctx.tool.rawInput as Record<string, unknown> | undefined;
    const query = String(raw?.query ?? raw?.search ?? "");
    const quoted = `"${truncate(query, 40)}"`;
    return { title: quoted, object: quoted };
  },
  badge(ctx): NarrationBadge | undefined {
    if (ctx.status !== "complete") return undefined;
    const raw = ctx.tool.rawOutput as Record<string, unknown> | undefined;
    if (typeof raw?.count === "number") {
      return {
        tone: "success",
        text: ctx.t("toolNarrator.webSearch.results", { count: raw.count }),
      };
    }
    return undefined;
  },
};
```

- [ ] **Step 4: 注册到 index.ts**

修改 `web/components/chat/narrators/index.ts`：

```ts
import { webSearchNarrator } from "./web-search";
```

```ts
const narrators: ToolNarrator[] = [
  readNarrator,
  editNarrator,
  writeNarrator,
  bashNarrator,
  grepNarrator,
  globNarrator,
  webFetchNarrator,
  webSearchNarrator,
  fallbackNarrator,
];
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `bun test web/src/__tests__/narrators/web-search.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/web-search.ts web/components/chat/narrators/index.ts web/src/__tests__/narrators/web-search.test.ts
git commit -m "feat(chat): 添加 web-search narrator"
```

---

## Task 15: task narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators/task.test.ts`
- Create: `web/components/chat/narrators/task.ts`
- Modify: `web/components/chat/narrators/index.ts`

- [ ] **Step 1: 写测试**

创建 `web/src/__tests__/narrators/task.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { taskNarrator } from "@/components/chat/narrators/task";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown, description?: string): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Task",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
      description,
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("taskNarrator", () => {
  test("匹配 task/agent/subagent", () => {
    expect(taskNarrator.match("task")).toBe(true);
    expect(taskNarrator.match("agent")).toBe(true);
    expect(taskNarrator.match("subagent")).toBe(true);
    expect(taskNarrator.match("sub_agent")).toBe(true);
    expect(taskNarrator.match("read")).toBe(false);
  });

  test("verb 是 '派'", () => {
    expect(taskNarrator.verb).toBe("派");
  });

  test("优先使用 description 字段", () => {
    const { title } = taskNarrator.getDisplay(makeCtx({}, "重构认证模块"));
    expect(title).toBe("重构认证模块");
  });

  test("无 description 时从 rawInput 取", () => {
    const { title } = taskNarrator.getDisplay(makeCtx({ description: "完成某个任务" }));
    expect(title).toBe("完成某个任务");
  });

  test("description 过长截断到 40 字符", () => {
    const long = "x".repeat(50);
    const { title } = taskNarrator.getDisplay(makeCtx({}, long));
    expect((title as string).length).toBe(41); // 40 + 省略号
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `bun test web/src/__tests__/narrators/task.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 task.ts**

创建 `web/components/chat/narrators/task.ts`：

```ts
import { Workflow } from "lucide-react";
import type { ToolNarrator } from "./types";
import { truncate } from "./helpers";

/**
 * Task / Agent / SubAgent 工具 narrator。处理子任务派发。
 *
 * 优先用 tool.description（Agent 提供）作为展示文本，
 * 其次从 rawInput.description 取，最后兜底"子任务"。
 */
export const taskNarrator: ToolNarrator = {
  match: (name) => name.includes("task") || name.includes("agent") || name.includes("subagent"),
  verb: "派",
  icon: Workflow,
  getDisplay(ctx) {
    const desc =
      ctx.tool.description ??
      String((ctx.tool.rawInput as Record<string, unknown> | undefined)?.description ?? "") ??
      "子任务";
    const display = truncate(desc, 40);
    return { title: display, object: display };
  },
};
```

- [ ] **Step 4: 注册到 index.ts**

修改 `web/components/chat/narrators/index.ts`：

```ts
import { taskNarrator } from "./task";
```

```ts
const narrators: ToolNarrator[] = [
  readNarrator,
  editNarrator,
  writeNarrator,
  bashNarrator,
  grepNarrator,
  globNarrator,
  webFetchNarrator,
  webSearchNarrator,
  taskNarrator,
  fallbackNarrator,
];
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `bun test web/src/__tests__/narrators/task.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/task.ts web/components/chat/narrators/index.ts web/src/__tests__/narrators/task.test.ts
git commit -m "feat(chat): 添加 task narrator"
```

---

## Task 16: todo-write narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators/todo-write.test.ts`
- Create: `web/components/chat/narrators/todo-write.ts`
- Modify: `web/components/chat/narrators/index.ts`

- [ ] **Step 1: 写测试**

创建 `web/src/__tests__/narrators/todo-write.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { todoWriteNarrator } from "@/components/chat/narrators/todo-write";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "toolNarrator.todo.items") return `${opts?.count} 个待办`;
  return key;
}) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "TodoWrite",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("todoWriteNarrator", () => {
  test("匹配 todo", () => {
    expect(todoWriteNarrator.match("todowrite")).toBe(true);
    expect(todoWriteNarrator.match("todo_write")).toBe(true);
    expect(todoWriteNarrator.match("todo")).toBe(true);
    expect(todoWriteNarrator.match("read")).toBe(false);
  });

  test("verb 是 '列'", () => {
    expect(todoWriteNarrator.verb).toBe("列");
  });

  test("todos 数组长度作为待办数", () => {
    const { title } = todoWriteNarrator.getDisplay(makeCtx({ todos: [{}, {}, {}] }));
    expect(title).toBe("3 个待办");
  });

  test("兼容 tasks 字段", () => {
    const { title } = todoWriteNarrator.getDisplay(makeCtx({ tasks: [{}, {}] }));
    expect(title).toBe("2 个待办");
  });

  test("无待办时兜底", () => {
    const { title } = todoWriteNarrator.getDisplay(makeCtx({}));
    expect(title).toBe("0 个待办");
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `bun test web/src/__tests__/narrators/todo-write.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 todo-write.ts**

创建 `web/components/chat/narrators/todo-write.ts`：

```ts
import { ListTodo } from "lucide-react";
import type { ToolNarrator } from "./types";

/**
 * TodoWrite 工具 narrator。处理待办列表更新。
 */
export const todoWriteNarrator: ToolNarrator = {
  match: (name) => name.includes("todo"),
  verb: "列",
  icon: ListTodo,
  getDisplay(ctx) {
    const raw = ctx.tool.rawInput as Record<string, unknown> | undefined;
    const list = raw?.todos ?? raw?.tasks;
    const count = Array.isArray(list) ? list.length : 0;
    const text = ctx.t("toolNarrator.todo.items", { count });
    return { title: text, object: text };
  },
};
```

- [ ] **Step 4: 注册到 index.ts**

修改 `web/components/chat/narrators/index.ts`：

```ts
import { todoWriteNarrator } from "./todo-write";
```

```ts
const narrators: ToolNarrator[] = [
  readNarrator,
  editNarrator,
  writeNarrator,
  bashNarrator,
  grepNarrator,
  globNarrator,
  webFetchNarrator,
  webSearchNarrator,
  taskNarrator,
  todoWriteNarrator,
  fallbackNarrator,
];
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `bun test web/src/__tests__/narrators/todo-write.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/todo-write.ts web/components/chat/narrators/index.ts web/src/__tests__/narrators/todo-write.test.ts
git commit -m "feat(chat): 添加 todo-write narrator"
```

---

## Task 17: skill narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators/skill.test.ts`
- Create: `web/components/chat/narrators/skill.ts`
- Modify: `web/components/chat/narrators/index.ts`

- [ ] **Step 1: 写测试**

创建 `web/src/__tests__/narrators/skill.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { skillNarrator } from "@/components/chat/narrators/skill";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(title: string, description?: string): NarrationContext {
  return {
    tool: {
      id: "t1",
      title,
      status: "complete",
      description,
    } as ToolCallData,
    status: "complete",
    t: mockT,
  };
}

describe("skillNarrator", () => {
  test("匹配 loaded skill / skill", () => {
    expect(skillNarrator.match("loaded skill")).toBe(true);
    expect(skillNarrator.match("skill")).toBe(true);
    expect(skillNarrator.match("loadedskill")).toBe(true);
    expect(skillNarrator.match("read")).toBe(false);
  });

  test("verb 是 '载'", () => {
    expect(skillNarrator.verb).toBe("载");
  });

  test("title 包含 loaded skill 时直接用 description", () => {
    const { title } = skillNarrator.getDisplay("Loaded Skill: commit", "Git 提交助手");
    expect(title).toBe("Git 提交助手");
  });

  test("无 description 时从 title 提取 skill 名", () => {
    const { title } = skillNarrator.getDisplay("Loaded Skill: commit");
    expect(title).toBe("commit");
  });

  test("title 只是 'skill' 时兜底", () => {
    const { title } = skillNarrator.getDisplay("skill");
    expect(title).toBe("skill");
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `bun test web/src/__tests__/narrators/skill.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 skill.ts**

创建 `web/components/chat/narrators/skill.ts`：

```ts
import { Sparkles } from "lucide-react";
import type { ToolNarrator } from "./types";

/**
 * Loaded Skill 工具 narrator。处理技能加载通知。
 *
 * 现有 title 格式："Loaded Skill: <name>"。
 * 优先用 description（Agent 提供的技能描述），否则从 title 提取 skill 名。
 */
export const skillNarrator: ToolNarrator = {
  match: (name) => name.includes("skill"),
  verb: "载",
  icon: Sparkles,
  getDisplay(ctx) {
    if (ctx.tool.description) {
      return { title: ctx.tool.description, object: ctx.tool.description };
    }
    // 从 "Loaded Skill: xxx" 提取 xxx
    const match = ctx.tool.title.match(/skill:\s*(.+)/i);
    const name = match ? match[1].trim() : ctx.tool.title;
    return { title: name, object: name };
  },
};
```

- [ ] **Step 4: 注册到 index.ts**

修改 `web/components/chat/narrators/index.ts`：

```ts
import { skillNarrator } from "./skill";
```

```ts
const narrators: ToolNarrator[] = [
  readNarrator,
  editNarrator,
  writeNarrator,
  bashNarrator,
  grepNarrator,
  globNarrator,
  webFetchNarrator,
  webSearchNarrator,
  taskNarrator,
  todoWriteNarrator,
  skillNarrator,
  fallbackNarrator,
];
```

- [ ] **Step 5: 运行测试，验证通过**

Run: `bun test web/src/__tests__/narrators/skill.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/skill.ts web/components/chat/narrators/index.ts web/src/__tests__/narrators/skill.test.ts
git commit -m "feat(chat): 添加 skill narrator"
```

---

## Task 18: question narrator（TDD）

**Files:**
- Create: `web/src/__tests__/narrators/question.test.ts`
- Create: `web/components/chat/narrators/question.ts`
- Modify: `web/components/chat/narrators/index.ts`

- [ ] **Step 1: 写测试**

创建 `web/src/__tests__/narrators/question.test.ts`：

```ts
import { describe, test, expect } from "bun:test";
import { questionNarrator } from "@/components/chat/narrators/question";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

const mockT = ((key: string) => key) as unknown as NarrationContext["t"];

function makeCtx(rawInput: unknown, description?: string): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Question",
      status: "waiting_for_confirmation",
      rawInput: rawInput as Record<string, unknown>,
      description,
    } as ToolCallData,
    status: "waiting_for_confirmation",
    t: mockT,
  };
}

describe("questionNarrator", () => {
  test("匹配 question/ask", () => {
    expect(questionNarrator.match("question")).toBe(true);
    expect(questionNarrator.match("ask")).toBe(true);
    expect(questionNarrator.match("read")).toBe(false);
  });

  test("verb 是 '问'", () => {
    expect(questionNarrator.verb).toBe("问");
  });

  test("从 description 提取问题文本", () => {
    const { title } = questionNarrator.getDisplay(makeCtx({}, "要不要继续？"));
    expect(title).toBe('"要不要继续？"');
  });

  test("从 rawInput.question 提取", () => {
    const { title } = questionNarrator.getDisplay(makeCtx({ question: "用什么方案？" }));
    expect(title).toBe('"用什么方案？"');
  });

  test("长问题截断到 40 字符", () => {
    const long = "x".repeat(50);
    const { title } = questionNarrator.getDisplay(makeCtx({}, long));
    expect((title as string).length).toBe(42); // 40 + 引号 + 省略号
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `bun test web/src/__tests__/narrators/question.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 question.ts**

创建 `web/components/chat/narrators/question.ts`：

```ts
import { HelpCircle } from "lucide-react";
import type { ToolNarrator } from "./types";
import { truncate } from "./helpers";

/**
 * Question / Ask 工具 narrator。处理 Agent 向用户提问。
 *
 * 主要状态是 waiting_for_confirmation（等用户回答）。
 */
export const questionNarrator: ToolNarrator = {
  match: (name) => name.includes("question") || name.includes("ask"),
  verb: "问",
  icon: HelpCircle,
  getDisplay(ctx) {
    const text =
      ctx.tool.description ??
      String((ctx.tool.rawInput as Record<string, unknown> | undefined)?.question ?? "");
    const quoted = `"${truncate(text, 40)}"`;
    return { title: quoted, object: quoted };
  },
};
```

- [ ] **Step 4: 注册到 index.ts**

修改 `web/components/chat/narrators/index.ts`，把注册表补全为最终版本：

```ts
import { readNarrator } from "./read";
import { editNarrator } from "./edit";
import { writeNarrator } from "./write";
import { bashNarrator } from "./bash";
import { grepNarrator } from "./grep";
import { globNarrator } from "./glob";
import { webFetchNarrator } from "./web-fetch";
import { webSearchNarrator } from "./web-search";
import { taskNarrator } from "./task";
import { todoWriteNarrator } from "./todo-write";
import { skillNarrator } from "./skill";
import { questionNarrator } from "./question";
import { fallbackNarrator } from "./fallback";

/**
 * 注册表。顺序敏感：先匹配专用 narrator，未命中走兜底。
 *
 * 顺序约束：
 * - edit 必须在 multiedit 之前（multiedit 含 edit，但也会命中 multiedit 自身规则）
 * - write 在 edit 之前（write 含 'e' 但不含 edit；multiedit 含 edit，必须命中 edit）
 * - webSearch 在 webFetch 之后（虽然 match 不冲突，但保持 specialised 先）
 * - fallback 必须最后（match 永远 true）
 */
const narrators: ToolNarrator[] = [
  readNarrator,
  writeNarrator,    // write 必须在 edit 之前
  editNarrator,
  bashNarrator,
  grepNarrator,
  globNarrator,
  webFetchNarrator,
  webSearchNarrator,
  taskNarrator,
  todoWriteNarrator,
  skillNarrator,
  questionNarrator,
  fallbackNarrator, // 必须最后
];
```

- [ ] **Step 5: 运行所有 narrator 测试**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/narrators/ web/src/__tests__/narrators-index.test.ts web/src/__tests__/narrators-helpers.test.ts web/src/__tests__/narrators-i18n.test.ts`
Expected: PASS，所有 14 个 narrator 单测 + 入口测试 + helpers 测试 + i18n 测试通过

- [ ] **Step 6: Commit**

```bash
git add web/components/chat/narrators/question.ts web/components/chat/narrators/index.ts web/src/__tests__/narrators/question.test.ts
git commit -m "feat(chat): 添加 question narrator，完成全部 12 个核心 narrator"
```

---

## Task 19: 清理旧 i18n key 和 ToolCallContent 分支

**Files:**
- Modify: `web/components/chat/ToolCallContent.tsx`（删除或简化为 stub）
- Modify: `web/components/chat/tool-call-utils.ts`（保留必要导出）

- [ ] **Step 1: 检查 ToolCallContent 引用**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bunx grep -rn "ToolCardContent\|ToolCallContent" web/components web/src --include="*.tsx" --include="*.ts" | grep -v "narrators" | head -20`
Expected: 看到除了 ToolCallContent.tsx 自身外，还有哪些文件 import 它

- [ ] **Step 2: 删除 ToolCallContent.tsx 的内部分支**

如果 Step 1 显示 `ToolCardContent` 已经无人引用（Task 11 改造 ToolCallRow 时已替换），则可以删除整个 `ToolCallContent.tsx` 文件：

```bash
rm web/components/chat/ToolCallContent.tsx
```

如果还有其他地方引用，则把 `ToolCallContent.tsx` 简化为 stub（仅 re-export 必要内容）或保留但标注 deprecated。

- [ ] **Step 3: 清理 tool-call-utils.ts 的未使用导出**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bunx grep -rn "countDiffs\|extractFilePath\|extractFirstPath\|formatFileName\|inferToolTypeFromInput\|isHindsightTool\|STATUS_BAR" web/components web/src --include="*.tsx" --include="*.ts" | grep -v "tool-call-utils.ts" | head -20`
Expected: 列出所有未使用的导出

修改 `web/components/chat/tool-call-utils.ts`，删除无引用的函数（保留 `simplifyToolName`、`CARD_STYLES`、`getCardCategory`、`formatOutput`、`truncate`、`CardStyle`、`ToolCategory`）。

> **注意**：`countDiffs` 已被 edit narrator 内联实现（直接 `content.filter(...)`），可以删除。

- [ ] **Step 4: 检查旧 i18n key 引用**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bunx grep -rn "toolCallRow.failed\|toolCallRow.pendingConfirmation\|toolCallRow.viewParams\|toolCallContent.changes\|toolCallContent.results\|toolCallContent.files\|toolCallContent.taskRunning\|toolCallContent.agentCalling\|toolCallContent.todos\|toolCallContent.updateTodoList" web/components web/src --include="*.tsx" --include="*.ts" | head -30`
Expected: 列出所有旧 key 引用

对于仍被引用的 key（如 `toolCallRow.viewParams` 在 Task 11 的 ToolCallRow 改造里仍用到），保留在 `components.json`。
对于不再被引用的 key（如 `toolCallContent.changes`，已被 `toolNarrator.edit.changes` 取代），从 `web/src/i18n/locales/{en,zh}/components.json` 删除。

- [ ] **Step 5: 运行前端测试和编译**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/ && bunx tsc --noEmit -p web/tsconfig.json`
Expected: PASS，无 TypeScript 错误

- [ ] **Step 6: Commit**

```bash
git add -u web/components/chat/ web/src/i18n/
git commit -m "refactor(chat): 清理 ToolCallContent 分支和未使用的工具函数"
```

---

## Task 20: 最终验证

**Files:** 无（仅运行验证命令）

- [ ] **Step 1: 运行 precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: 全部通过（biome format、biome check import 排序、tsc、biome check）

如果有 lint 错误，precheck 的 `--write` 会自动修复格式和 import 排序。修复后再次运行确认通过。

- [ ] **Step 2: 构建前端**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web`
Expected: 构建成功，无 TypeScript 错误

- [ ] **Step 3: 运行所有相关测试**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/`
Expected: 全部 PASS

- [ ] **Step 4: 手动 E2E 验证**

启动 dev server：`bun run dev:web`，在 chat 界面触发 Agent 各种工具调用，验证：

| 工具 | 期望副标题（complete 状态） |
|---|---|
| Read | `读 config.ts 第 1-50 行` + `1.2s` 徽章 |
| Edit | `改 config.ts` + `3 处` 徽章 + `0.8s` 徽章 |
| Write | `写 new-file.ts` + `0.5s` 徽章 |
| Bash | `$ npm install` + `12.5s` 徽章 |
| Grep | `"useEffect" 在 src/` + `找到 8 个` 徽章 |
| Glob | `**/*.ts` + `15 个文件` 徽章 |
| WebFetch | `https://example.com/...` + `1.5s` 徽章 |
| WebSearch | `"claude code"` + `找到 8 个` 徽章 |
| Task | `重构认证模块` + `1m23s` 徽章 |
| TodoWrite | `5 个待办` |
| Loaded Skill | `Git 提交助手` |
| Question | `"要不要继续？"` + 待确认状态 |
| 未知工具 | `UnknownTool · some-param` + `0.3s` 徽章 |

错误状态：title 下方显示 errorDetail 小字。
取消/拒绝状态：opacity-50。

- [ ] **Step 5: 最终 commit（如有清理改动）**

```bash
git status
# 如有未提交改动：
git add -u
git commit -m "chore(chat): precheck 通过后的最终格式化"
```

- [ ] **Step 6: 验证完成**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && git log --oneline feature/chat-improve ^main | head -25`
Expected: 看到 20 个左右的 commits，每个对应一个 task

---

## 完成检查清单

实施完成后逐项验证：

- [ ] 14 个 narrator 文件全部创建（12 核心 + 1 fallback + 1 index）
- [ ] helpers.ts + types.ts 完整
- [ ] i18n toolNarrator.json 中英文双语完整
- [ ] NS.TOOL_NARRATOR 在 i18n/index.ts 注册
- [ ] ToolCallRow.tsx 调用 narrate() 替换原逻辑
- [ ] ChatInterface.tsx 记录 toolCallStartedAt
- [ ] 所有 narrator 单测通过
- [ ] narrate() 入口测试通过
- [ ] helpers 测试通过
- [ ] i18n 完整性测试通过
- [ ] precheck 通过
- [ ] build:web 成功
- [ ] 手动 E2E 验证 13 种工具展示正确
