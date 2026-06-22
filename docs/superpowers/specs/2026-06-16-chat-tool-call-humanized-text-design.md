# Chat 工具调用文本人性化改造设计

> 日期：2026-06-16
> 状态：设计已通过用户审查，待写实施计划
> 范围：仅前端渲染层（不动 Agent prompt / relay / ACP 协议 / UI 结构）

## 背景

### 现状

RCS 的 chat 工具调用展示链路：

- ACP Agent（Claude Code / OpenCode 等）通过 WebSocket 推送 `ToolCallUpdate` 事件
- Relay 透传事件，**不做文本加工**
- 前端 `ChatInterface` 维护 `ToolCallData`，`ToolCallRow` 渲染工具卡片
- `web/components/chat/ToolCallContent.tsx` 当前用 if-else 分支为每个工具生成"标题 + 副标题"
- 副标题主要是**英文工具名**（`Read` / `Edit` / `Bash` / `Grep` …），状态文案部分走 i18n
- 部分文案（状态、计数）已走 i18n，但工具名本身硬编码英文，未走 i18n

### 痛点

1. **中英混杂读起来割裂**：中文界面里穿插英文工具名
2. **像机器日志不像人话**：标签式摘要（`Read / src/index.ts`），不是自然语言叙述
3. **看不到 Agent 的意图和进度**：堆叠的工具名不能传达 Agent 现在在干什么、走到哪一步

### 目标

- 把工具调用文本换成统一格式的中文描述
- 状态词全局统一（进行中 / 已完成 / 失败 / 待确认 / 已取消）
- 副标题保留工具上下文（每工具有自己的动词 + 对象）
- 改造可扩展：未来加新工具只需写一个 narrator 文件

### 非目标

- ❌ 不改 AgentConfig system prompt（不让 Agent 主动叙事，纯前端加工）
- ❌ 不改 UI 结构（不合并工具调用为时间线叙事、不隐藏低价值调用）
- ❌ 不改 ACP 协议 / relay / WebSocket 透传逻辑
- ❌ 不引入风格切换配置（YAGNI，单一风格走天下）

---

## 设计决策

### 决策 1：改造着力点 = 仅前端渲染

用户痛点靠"前端基于现有数据生成更好的中文描述"就能解决，不需要 Agent 配合。

**否决方案**：
- **前端 + Agent prompt 双管齐下**：ACP 协议下 Agent 不受 RCS 控制，prompt 调整效果不可控
- **文本 + UI 结构重构**：超出"文本人性化"范围，工作量大且与当前需求正交

### 决策 2：风格调性 = 统一状态词 + 工具上下文保留

经过多轮风格对比（平实描述 / 生动叙事 / 专业详细 / 状态词全部统一），最终选择"状态词全部统一"。

**风格规则**：
- 副标题**去拟人化**（不用"我读 / 我改 / 我跑"第一人称主语）
- 副标题用统一模板：`running = "正在{{verb}} {{object}}"`，其他状态 `"{{verb}} {{object}}"`
- **状态词全局统一**：`进行中 / 已完成 / 失败 / 待确认 / 已取消`
- 每个工具有自己的动词（读 / 改 / 跑 / 搜 / 写 / 找 / 抓 / 派 / 列 / 载 / 问 / 用），保留工具上下文

**否决方案**：
- "生动叙事"（"我读了一下 X" / "看完了"）：拟人化太重，不够专业
- "每工具一个失败词"（"读挂了 / 改挂了 / 跑挂了"）：戏谑过度，且状态词散乱违背"统一"诉求

### 决策 3：实现路径 = 注册表模式

**否决方案**：
- **扁平化硬编码（方案 A）**：13+ 工具 × 5 状态规模下，if-else 分支会变成乱麻
- **声明式元数据 + 自动生成（方案 C）**：不同工具的对象提取差异大（行号 vs 命令 vs 待办列表），强行抽象会扭曲

**注册表模式优势**：每个工具自包含，新增工具只加一个文件；项目已有 `ModelIcon` 注册表先例。

---

## 整体架构

### 数据流

```
ACP 协议 ToolCallUpdate
       ↓
ChatInterface.tsx (现有，不动)
   - 收到事件、维护 ToolCallData
   - 前端记录 toolCallStartedAt[toolCallId] = Date.now()
       ↓
ToolCallGroup.tsx (现有，不动)
       ↓
ToolCallRow.tsx (改造)
   - useTranslation(NS.TOOL_NARRATOR) 拿到 t
   - const result = narrate(tool, status, elapsedMs, t)
   - 渲染 result.icon / title / subtitle / statusLabel / badge / errorDetail
   - 点击详情 → 渲染 result.detail.inputSummary / outputSummary / rawInput / rawOutput
       ↑
       │ 调用
       │
narrators/index.ts (新)
   - narrate()：按注册表匹配工具，未命中走 fallback
   - narrators/<tool>.ts 每个工具自包含一个 ToolNarrator
```

### 文件结构

```
web/components/chat/
├── narrators/                       ★ 新增目录
│   ├── index.ts                     注册表 + narrate() 中央入口
│   ├── types.ts                     ToolNarrator / NarrationContext / NarrationResult 接口
│   ├── helpers.ts                   通用提取/格式化工具函数
│   ├── read.ts                      ┐
│   ├── edit.ts                      │
│   ├── write.ts                     │
│   ├── bash.ts                      │
│   ├── grep.ts                      │  每个工具一个 narrator
│   ├── glob.ts                      │  自包含：match + verb + getDisplay + badge
│   ├── web-fetch.ts                 │
│   ├── web-search.ts                │
│   ├── task.ts                      │
│   ├── todo-write.ts                │
│   ├── skill.ts                     │
│   ├── question.ts                  ┘
│   └── fallback.ts                  未识别工具兜底（match 永远返回 true，注册表最后位）
├── ToolCallRow.tsx                  ★ 改造：调用 narrate()
├── ToolCallContent.tsx              ★ 改造：删除现有分支，改为纯渲染 narrate 结果
└── tool-call-utils.ts               保留 simplifyToolName（fallback narrator 用）

web/src/i18n/locales/{en,zh}/
└── toolNarrator.json                ★ 新增（common 模板 + 工具特有徽章文案）

web/src/i18n/index.ts                ★ 改造：注册 NS.TOOL_NARRATOR 命名空间
```

---

## 核心接口

### narrators/types.ts

```ts
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import type { ToolCallData } from "@/src/lib/types";

/**
 * 工具调用的状态枚举。映射自 ACP 协议 ToolCallUpdate.status。
 */
export type ToolStatus =
  | "running"
  | "complete"
  | "error"
  | "waiting_for_confirmation"
  | "canceled";

/**
 * Narration 上下文。传递给每个 narrator 的方法。
 * - tool: 完整的工具调用数据（含 title / rawInput / rawOutput）
 * - status: 当前状态
 * - elapsedMs: 前端计算的耗时（complete/error 状态下用于徽章）
 * - t: i18n 翻译函数（由 ToolCallRow 通过 useTranslation 拿到后传入，
 *      避免每个 narrator 都用 hook）
 */
export interface NarrationContext {
  tool: ToolCallData;
  status: ToolStatus;
  elapsedMs?: number;
  t: TFunction;
}

export type BadgeTone = "info" | "warn" | "error" | "success";

export interface NarrationBadge {
  tone: BadgeTone;
  text: string;
}

/**
 * 卡片展示用的双字段：title 是第一行（文件名/命令/URL/工具名），
 * object 是副标题里的"对象"部分（与 verb 拼成副标题）。
 * 分开是因为少数工具的 title 和 object 不完全一致：
 * - bash: title = "$ cmd"，object = "cmd"
 * - grep: title = '"pattern"'，object = '"pattern" 在 src/'（带路径）
 */
export interface ToolDisplay {
  title: ReactNode;
  object: ReactNode;
}

/**
 * Narration 结果。中央 narrate() 返回，ToolCallRow 直接渲染。
 * - icon: 卡片左侧图标
 * - title: 卡片第一行
 * - subtitle: 卡片第二行（"正在读 src/index.ts" / "读 src/index.ts"）
 * - statusLabel: 状态标签（"进行中" / "已完成" / "失败" / "待确认" / "已取消"）
 * - badge: 计数徽章（"3 处" / "5 个结果" / "1.2s"）
 * - errorDetail: 错误状态下 title 下方的错误细节
 * - detail: 点击右侧图标弹的 Dialog 内容（inputSummary 人话 + rawInput 原始 JSON 折叠）
 */
export interface NarrationResult {
  icon?: LucideIcon;
  title: ReactNode;
  subtitle: ReactNode;
  statusLabel: string;
  badge?: NarrationBadge;
  errorDetail?: string;
  detail: {
    inputSummary?: ReactNode;
    outputSummary?: ReactNode;
    rawInput?: unknown;
    rawOutput?: unknown;
  };
}

/**
 * 工具 narrator 接口。每个工具实现一份。
 *
 * 设计要点：
 * - match: 工具名匹配（大小写不敏感），注册表按顺序匹配，第一个命中的生效
 * - verb: 中文动词，决定副标题里的动作描述
 * - icon: 卡片图标
 * - getDisplay: 同时返回 title 和 object，让 narrator 完全自包含
 * - badge: 可选的计数徽章（如 Grep 的"找到 N 个"）
 *
 * 副标题拼接完全在中央 narrate() 完成（用 common.subtitle.<status> 模板），
 * narrator 不参与文案拼接，保证所有工具的副标题格式一致。
 */
export interface ToolNarrator {
  match: (toolNameLower: string) => boolean;
  verb: string;
  icon: LucideIcon;
  getDisplay: (ctx: NarrationContext) => ToolDisplay;
  badge?: (ctx: NarrationContext) => NarrationBadge | undefined;
}
```

### narrators/index.ts 中央入口

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

/**
 * 注册表。顺序敏感：先匹配专用 narrator，未命中走兜底。
 * 兜底 narrator 的 match 永远返回 true，必须放最后。
 */
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
  questionNarrator,
  fallbackNarrator, // 必须最后
];

/**
 * 中央 narrate 入口。ToolCallRow 调用此函数拿到完整的 NarrationResult。
 *
 * 职责：
 * 1. 查注册表匹配 narrator（未命中走 fallback）
 * 2. 拿到 narrator 的 verb + getDisplay(ctx) → { title, object }
 * 3. 用 common.subtitle.<status> 模板拼接副标题（保证所有工具格式一致）
 * 4. 用 common.status.<status> 拿状态词
 * 5. error 状态额外提取错误信息，单独展示在 title 下方
 * 6. 拼装徽章：narrator 自定义徽章优先于耗时徽章
 */
export function narrate(
  tool: NarrationContext["tool"],
  status: ToolStatus,
  elapsedMs: number | undefined,
  t: NarrationContext["t"],
): NarrationResult {
  const ctx: NarrationContext = { tool, status, elapsedMs, t };
  const lower = tool.title.toLowerCase();
  const narrator = narrators.find((n) => n.match(lower)) ?? fallbackNarrator;

  const { title, object } = narrator.getDisplay(ctx);
  const verb = narrator.verb;

  // 副标题：用 common 模板拼接，保证所有工具格式一致。
  // 拆成 2 个 key（而非每状态一个）是因为 running 是进行时（带"正在"前缀），
  // 其他状态都是过去时（动词 + 对象），用同一模板即可。
  const subtitleKey = status === "running" ? "common.subtitleRunning" : "common.subtitle";
  const subtitle = t(subtitleKey, { verb, object });

  // 状态词：全局统一
  const statusLabel = t(`common.status.${status}`);

  // 错误细节：error 状态从 rawOutput 提取，单独显示在 title 下方
  const errorDetail = status === "error" ? extractErrorMessage(tool.rawOutput) : undefined;

  // 徽章优先级：narrator 自定义徽章 > 耗时徽章
  // 例如 Grep 的"找到 N 个"比耗时优先；其他工具默认附耗时
  const narratorBadge = narrator.badge?.(ctx);
  const elapsedBadge:
    | NarrationBadge
    | undefined =
    (status === "complete" || status === "error") && elapsedMs
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
      // inputSummary/outputSummary 走 narrator 提供的精简版（如适用），
      // 否则 ToolCallRow 的 Dialog 自动 fallback 到 rawInput/rawOutput 的折叠 JSON
      rawInput: tool.rawInput,
      rawOutput: tool.rawOutput,
    },
  };
}
```

### narrators/helpers.ts

```ts
import type { ToolCallData } from "@/src/lib/types";

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
 * 兼容两种命名：offset+limit（Claude Code 风格）和 start_line+end_line（其他 Agent）。
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
 * 截断字符串，超长加省略号。用于命令、URL、错误信息等的展示。
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

---

## 12 个工具 narrator 详细设计

### 总览表

| 工具 | match 规则（lowercase） | verb | icon | title 来源 | object 来源 | 特殊徽章 |
|---|---|---|---|---|---|---|
| **Read** | `includes("read")` | 读 | `FileText` | 文件名 | 文件名 + 行号区间 | — |
| **Edit** | `includes("edit") \|\| includes("str_replace")` | 改 | `FilePen` | 文件名 | 文件名 | complete: `N 处` |
| **Write** | `includes("write")` | 写 | `FilePlus` | 文件名 | 文件名 | — |
| **Bash** | `includes("bash") \|\| includes("shell") \|\| includes("exec")` | 跑 | `Terminal` | `$ cmd` | `cmd` | — |
| **Grep** | `includes("grep") \|\| includes("rg")` | 搜 | `Search` | `"pattern"` | `"pattern" 在 path/` | complete: `找到 N 个` |
| **Glob** | `includes("glob") \|\| includes("find") \|\| includes("listfiles")` | 找 | `FolderSearch` | `pattern` | `pattern` | complete: `N 个文件` |
| **WebFetch** | `includes("fetch") \|\| includes("webfetch") \|\| includes("curl")` | 抓 | `Globe` | URL（截断 80） | URL（截断 80） | — |
| **WebSearch** | `includes("search") \|\| includes("websearch")` | 搜 | `Search` | `"query"` | `"query"` | complete: `找到 N 个` |
| **Task** | `includes("task") \|\| includes("agent") \|\| includes("subagent")` | 派 | `Workflow` | 任务描述（截断 40） | 任务描述（截断 40） | — |
| **TodoWrite** | `includes("todo")` | 列 | `ListTodo` | `N 个待办` | `N 个待办` | — |
| **Skill** | `includes("skill")` | 载 | `Sparkles` | 技能名 | 技能名 | — |
| **Question** | `includes("question") \|\| includes("ask")` | 问 | `HelpCircle` | `"question"`（截断 40） | `"question"`（截断 40） | — |
| **fallback** | `() => true` | 用 | `Wrench` | 工具名 + 第一个字符串值 | 同 title | — |

**注意**：WebSearch 在 match 顺序上必须排在 WebFetch 之后（因为 `webfetch` 也包含 `web`），实际注册表顺序见 `index.ts`。

### 完整 narrator 示例：read.ts

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
 * - error: "读 config.ts 第 120-180 行"（+ 错误细节在 title 下方）
 */
export const readNarrator: ToolNarrator = {
  match: (name) => name.includes("read"),
  verb: "读",
  icon: FileText,
  getDisplay(ctx) {
    const file = extractFileName(ctx.tool.rawInput);
    const range = extractLineRange(ctx.tool.rawInput);
    // 行号区间作为 object 的后缀，没有则只显示文件名
    const object = range ? `${file} ${ctx.t("common.lineRange", { range })}` : file;
    // title 只显示文件名（保持卡片简洁）
    return { title: file, object };
  },
};
```

### 完整 narrator 示例：bash.ts（title 与 object 不同）

```ts
import { Terminal } from "lucide-react";
import type { ToolNarrator } from "./types";
import { truncate } from "./helpers";

/**
 * Bash 工具 narrator。处理 shell 命令执行。
 *
 * title 加 $ 前缀（视觉上提示这是命令）；
 * object 不带前缀（副标题里已经有动词"跑"了）。
 */
export const bashNarrator: ToolNarrator = {
  match: (name) =>
    name.includes("bash") || name.includes("shell") || name.includes("exec"),
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

### 完整 narrator 示例：grep.ts（带自定义徽章）

```ts
import { Search } from "lucide-react";
import type { ToolNarrator } from "./types";
import { truncate } from "./helpers";

/**
 * Grep 工具 narrator。处理代码搜索。
 *
 * complete 状态下从 rawOutput 提取结果数量，作为自定义徽章
 * （优先于耗时徽章）。
 */
export const grepNarrator: ToolNarrator = {
  match: (name) => name.includes("grep") || name.includes("rg"),
  verb: "搜",
  icon: Search,
  getDisplay(ctx) {
    const pattern = String(
      (ctx.tool.rawInput as Record<string, unknown> | undefined)?.pattern ?? "",
    );
    const path = String(
      (ctx.tool.rawInput as Record<string, unknown> | undefined)?.path ?? "",
    );
    const quoted = `"${truncate(pattern, 40)}"`;
    // object 加路径后缀，区分 WebSearch（无路径）
    const object = path ? `${quoted} ${ctx.t("common.inPath", { path: truncate(path, 30) })}` : quoted;
    return { title: quoted, object };
  },
  badge(ctx) {
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

### 兜底 narrator：fallback.ts

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
    // 尝试从 rawInput 提取第一个字符串值作为附加上下文
    const firstStr = findFirstStringValue(ctx.tool.rawInput);
    const display = firstStr
      ? `${name} · ${truncate(firstStr, 40)}`
      : name;
    return { title: display, object: display };
  },
};
```

---

## i18n 设计

### toolNarrator 命名空间结构

key 数量约 30 个，分布：
- `common.status.*`：5 个状态词
- `common.subtitle`、`common.subtitleRunning`：2 个副标题模板（过去时 / 进行时）
- `common.lineRange`、`common.inPath`：2 个通用插值后缀
- `toolNarrator.<tool>.<field>`：每个有特殊徽章的工具 ~2 个 key

### 中文版 `web/src/i18n/locales/zh/toolNarrator.json`

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

### 英文版 `web/src/i18n/locales/en/toolNarrator.json`

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

**英文版特殊处理**：英文 `running` 副标题不用"verb + ing"（因为动词是中文"读"，无法直接加 ing），改为通用 `Reading {{object}}…`。complete/error 副标题复用中文模板（因为 verb 直接显示中文，跨语言不优雅，但实际使用时英文用户的卡片副标题会变成"读 src/index.ts"，可以接受；如果需要纯英文，实施阶段再加一个 `verbEn` 字段）。

> **实施提示**：英文版副标题的跨语言问题，建议实施阶段给 `ToolNarrator` 接口加一个可选 `verbEn?: string` 字段，i18n 模板用 `{{verbEn}}` 占位符。这样既保持中文版简洁，又让英文版自然。是否实现取决于实际英文用户量。

### 注册命名空间

`web/src/i18n/index.ts` 改造：

```ts
// 新增
export const NS = {
  // ...现有命名空间
  TOOL_NARRATOR: "toolNarrator",
} as const;

// 在 resources 中注册
resources = {
  en: { ..., toolNarrator: enToolNarrator },
  zh: { ..., toolNarrator: zhToolNarrator },
};
```

---

## 错误处理

### extractErrorMessage 实现见 helpers.ts

按优先级匹配 4 种 rawOutput 结构变体，提取错误信息，截断 120 字符。

### 错误展示位置

错误信息**不挤进副标题**，单独显示在 `title` 下方第二行（小号灰色字体）：

```
📖 src/index.ts                              · 失败
   读 src/index.ts
   File not found: ENOENT
```

副标题保持简洁（`读 src/index.ts · 失败`），错误细节作为补充信息。视觉层次：
- 第一行：`title`（文件名，加粗）
- 第二行：`subtitle`（动词 + 对象，常规色） + `statusLabel`（右对齐，失败时红色）
- 第三行（仅 error 状态）：`errorDetail`（小号灰色）

---

## 测试策略

按 CLAUDE.md 测试铁律：**禁止 `mock.module()`**、用 `stubXxx()` 函数、每个测试上方一行中文注释。

### 测试文件分布

```
web/src/__tests__/
├── narrators/
│   ├── helpers.test.ts              extractFileName/extractLineRange/extractErrorMessage/formatElapsed
│   ├── narrate.test.ts              中央入口：匹配、兜底、错误提取、徽章优先级、状态词
│   ├── read.test.ts                 readNarrator.getObject + 行号区间
│   ├── bash.test.ts                 bashNarrator.title 前缀 $、命令截断
│   ├── grep.test.ts                 grepNarrator.badge 计数提取
│   ├── edit.test.ts                 editNarrator.badge 变更数
│   ├── fallback.test.ts             fallback.getObject 字符串值提取
│   └── (其他工具 narrator 单测，每个 3-5 case)
└── i18n/
    └── tool-narrator-i18n.test.ts   en/zh JSON 都包含所有 common.status.* 和 common.subtitle.* key
```

### 测试示例

```ts
// narrators/helpers.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { resetAllStubs } from "@/src/__tests__/test-utils";
import { extractFileName, extractLineRange, extractErrorMessage, formatElapsed } from "@/components/chat/narrators/helpers";

describe("narrators/helpers", () => {
  beforeEach(() => resetAllStubs());

  test("从 file_path 提取文件名", () => {
    expect(extractFileName({ file_path: "/a/b/c.ts" })).toBe("c.ts");
  });

  test("兼容 path 和 filePath 字段", () => {
    expect(extractFileName({ path: "/x/y.ts" })).toBe("y.ts");
    expect(extractFileName({ filePath: "/z.ts" })).toBe("z.ts");
  });

  test("offset+limit 转成行号区间", () => {
    expect(extractLineRange({ offset: 100, limit: 50 })).toBe("100-149");
  });

  test("start_line+end_line 兼容", () => {
    expect(extractLineRange({ start_line: 10, end_line: 20 })).toBe("10-20");
  });

  test("ACP 标准错误提取", () => {
    const raw = { isError: true, content: [{ type: "text", text: "File not found" }] };
    expect(extractErrorMessage(raw)).toBe("File not found");
  });

  test("耗时 ms/s/m 格式化", () => {
    expect(formatElapsed(500)).toBe("500ms");
    expect(formatElapsed(1500)).toBe("1.5s");
    expect(formatElapsed(65_000)).toBe("1m5s");
  });
});
```

### 测试覆盖目标

- ✅ 12 个核心 narrator 各 1 个测试文件（每文件 3-5 个 case，重点测 `getDisplay` 和 `badge`）
- ✅ narrate 中央入口 1 个测试文件（覆盖匹配、兜底、错误提取、徽章优先级）
- ✅ helpers.ts 1 个测试文件（4 个函数全覆盖）
- ✅ i18n key 完整性测试（确保 en/zh JSON 同步）

### 不测试的部分

- `ToolCallRow.tsx` 的渲染（前端集成测试只覆盖关键流程，narrate() 的输出是纯数据，渲染层无逻辑）
- i18n 文案本身的语义（人工审查）

---

## 迁移计划

### 改造文件清单

| 文件 | 改造内容 |
|---|---|
| `web/components/chat/narrators/*` | **新增** 14 个文件（types / index / helpers + 12 narrator + fallback） |
| `web/components/chat/ToolCallRow.tsx` | 改造：调用 `narrate()` 拿结果，删除现有硬编码状态分支 |
| `web/components/chat/ToolCallContent.tsx` | 改造：删除现有每工具分支，改为纯渲染 `NarrationResult` 字段 |
| `web/components/chat/tool-call-utils.ts` | 保留 `simplifyToolName`（fallback narrator 用），删除其他不再使用的函数 |
| `web/src/i18n/locales/{en,zh}/toolNarrator.json` | **新增** |
| `web/src/i18n/index.ts` | 改造：注册 `NS.TOOL_NARRATOR` |
| `web/src/lib/types.ts` | 如需要，扩展 `ToolCallData` 增加 `startedAt?: number` 字段（用于耗时计算） |
| `web/src/acp/ChatInterface.tsx` | 改造：在收到 tool_call 事件时记录 `toolCallStartedAt[toolCallId]`，complete/error 时计算 elapsed |

### 现有 i18n key 处理

现有 i18n key（`components` 命名空间下的 `tool.status*` / `toolCallRow.*` / `toolCallContent.*`）**保留兼容**，不立即删除：

- `toolCallRow.failed` / `toolCallRow.pendingConfirmation`：新 narrator 不再使用，但保留 key 避免破坏其他可能的引用
- `toolCallContent.changes` / `toolCallContent.results` / `toolCallContent.files`：迁移到 `toolNarrator` 命名空间下的对应 key（`toolNarrator.edit.changes` 等），保留旧 key 直到确认无引用后删除
- `toolCallContent.taskRunning` / `toolCallContent.agentCalling` / `toolCallContent.todos` / `toolCallContent.updateTodoList`：同上，迁移到新命名空间

迁移完成后用 `grep` 确认无引用再删除旧 key。

### 实施顺序

1. **基础设施**：types.ts → helpers.ts → index.ts 中央入口（先写空壳，narrators 数组留空）
2. **i18n**：toolNarrator.json（en/zh）+ 注册命名空间
3. **核心 narrator**：read / edit / bash / grep / write（覆盖 80% 场景）
4. **接入 ToolCallRow.tsx**：替换现有硬编码逻辑，验证核心工具展示正确
5. **剩余 narrator**：glob / web-fetch / web-search / task / todo-write / skill / question / fallback
6. **测试**：narrators/__tests__/ 下逐个补单测
7. **清理**：删除 ToolCallContent.tsx 现有分支、迁移旧 i18n key
8. **验证**：`bun run precheck` + `bun run build:web`

---

## 风险与权衡

### 风险

1. **rawOutput 结构变体多**：不同 Agent（Claude Code / OpenCode / 自定义）的 rawOutput 结构可能不一致，`extractErrorMessage` 和 `extractGrepResultCount` 等提取函数可能漏掉某些变体。
   - **缓解**：兜底"未知错误"/undefined，UI 仍可用；后续根据真实数据迭代提取逻辑。

2. **耗时计算依赖前端时间戳**：`toolCallStartedAt` 存在 React state 还是 ref？页面刷新会丢失。
   - **缓解**：单次 chat session 内有效即可，刷新后 history 重新加载时不显示耗时是可接受的。

3. **英文版副标题跨语言**：中文 verb 直接出现在英文版副标题里（"读 src/index.ts"），英文用户看起来奇怪。
   - **缓解**：实施阶段给 `ToolNarrator` 加 `verbEn` 字段（见 i18n 设计章节的实施提示），按需启用。

4. **match 顺序敏感**：WebSearch 必须在 WebFetch 后注册（因为 `webfetch` 包含 `web`），容易踩坑。
   - **缓解**：在 `index.ts` 注册表上方加注释提醒，单测覆盖 match 优先级。

### 权衡

- **YAGNI**：不引入风格切换配置（用户/组织切换"叙事风格" vs "极简风格"）。如未来真有需求，注册表模式扩展一个 `style` 维度即可，不需要现在就抽象。
- **YAGNI**：不为每个 narrator 写 `inputSummary/outputSummary`（人话版输入输出摘要）。第一版用 rawInput/rawOutput 的折叠 JSON 即可，后续按用户反馈再加。
- **可观测性**：narrators/index.ts 中央入口加 `console.debug` 日志（开发模式），方便排查"为什么这个工具走到了 fallback"。
