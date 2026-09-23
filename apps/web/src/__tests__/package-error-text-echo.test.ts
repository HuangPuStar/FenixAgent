// 跨包回归守卫：`toast.*` 的实参里不得回显服务端原始 message。
//
// 为什么需要它：`request()` 的失败信封（`{ code, message }`）经 `unwrap()` 变成 `ApiError.message`
// ——那是后端的原始措辞（表名、SQL 片段、内部路径都可能出现）。§9.3 要求「API / domain 错误按稳定
// error code 映射到 message key，未知错误使用安全通用文案，不展示 raw message」，于是各包在
// v3.0.15 / v3.0.16 两批把三种形态统一改成「只上屏本包字典文案」：直接取 `err.message` 当 toast 正文、
// 把它插进文案的 `{{message}}` 槽位、以及用模板字符串把两者拼起来。**没有门禁的规则会被下一批
// 新页面重新写回来**，这类回显又恰好是「看起来信息更多」的写法，code review 最容易放过。
//
// 判据是**括号配对后的整段实参**而不是单行 grep：跨行调用与模板字符串形态的单行 grep 都抓不到
// （旧快照按单行统计出 102 处，实际是 106 个调用点，差的正是这两种形态）。`toast.*` 之外的回显面
// （页面级 `EmptyState` 的说明、`{{error}}` 插值槽位）不在本文件口径内，见 §5.9 的偏离清单。
//
// 唯一豁免的是**服务端为展示而设计的字段**，不是错误信封：探测结果 `{ reachable, message }`、
// 厂商 Key 校验结果 `{ success, message }`、dry-run 的 `issues[].message`、以及本地组合出来的
// `ClusterActionFeedback.message`。它们要么由服务端自带中文兜底、要么描述的是用户自己刚提交的内容，
// 去掉就等于把仅有的诊断信息删掉；逐条写在下面的 `ALLOWED_RAW_MESSAGE_CALLS` 里，并**同时钉住处数**
// ——豁免清单是会被 review 的契约，不是垃圾桶：多一处、少一处都算不一致。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

/** 豁免清单：相对路径 → { 处数, 理由 }。处数变了就说明有调用点被新增或改写，必须回到这里说明。 */
const ALLOWED_RAW_MESSAGE_CALLS: Record<string, { count: number; reason: string }> = {
  "packages/resources/knowledge/web/src/pages/agent-panel/components/EmbeddingModelManager.tsx": {
    count: 1,
    reason: "厂商 Key 校验结果 `{ success, message }` 是服务端为展示设计的字段（连接诊断），不是错误信封",
  },
  "packages/resources/mcp/web/pages/agent-panel/pages/agent-mcp-dialog.tsx": {
    count: 2,
    reason: "`testUrl` 探测结果 `{ reachable, protocol, message }` 同上：服务端自带「非 MCP 协议 / 连接失败」兜底",
  },
  "packages/resources/sandbox/web/src/pages/admin/use-sandbox-dashboard.ts": {
    count: 2,
    reason: "`ClusterActionFeedback.message` 是本地用 `t()` 拼出的文案（formatHealthCheckResult），不是服务端原文",
  },
  "packages/resources/workflow/web/pages/workflow/WorkflowEditor.tsx": {
    count: 1,
    reason: "dry-run 的 `issues[].message` 是成功响应里的逐节点校验诊断（标题已由 t() 承载，另有稳定 code）",
  },
  "packages/resources/workflow/web/pages/workflow/hooks/useWorkflowPersistence.ts": {
    count: 2,
    reason: "YAML 导入失败来自本地 `yamlToFlow`（js-yaml 的 YAMLException），描述用户自己那份文本，含行列号",
  },
};

/** 递归收集 .ts/.tsx（跳过测试、字典目录、构建产物）。 */
function collectSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "__tests__" || entry === "dist") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...collectSources(path));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) files.push(path);
  }
  return files;
}

/** 包内前端源码只认 `packages/<pkg>/web/**` 与 `packages/<group>/<pkg>/web/**`（后端 `src/**` 不算）。 */
function collectPackageWebSources(): string[] {
  const root = join(REPO_ROOT, "packages");
  return collectSources(root).filter((file) => {
    const rel = relative(REPO_ROOT, file);
    return /^packages\/[^/]+\/web\//.test(rel) || /^packages\/[^/]+\/[^/]+\/web\//.test(rel);
  });
}

interface ToastCall {
  file: string;
  line: number;
  args: string;
}

/** 取出每个 `toast.error(` 的整段实参：逐字符扫，跳过字符串 / 模板串 / 注释，按括号配对收口。 */
function extractToastCalls(source: string): { index: number; args: string }[] {
  const calls: { index: number; args: string }[] = [];
  const matcher = /\btoast\s*\.\s*(?:error|success|info|warning|message|loading)\s*\(/g;
  for (const match of source.matchAll(matcher)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let i = start;
    let quote: string | null = null;
    let template = false;
    let lineComment = false;
    let blockComment = false;
    for (; i < source.length; i++) {
      const char = source[i];
      const next = source[i + 1];
      if (lineComment) {
        if (char === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (char === "*" && next === "/") {
          blockComment = false;
          i++;
        }
        continue;
      }
      if (quote) {
        if (char === "\\") i++;
        else if (char === quote) quote = null;
        continue;
      }
      if (template) {
        if (char === "\\") i++;
        else if (char === "`") template = false;
        continue;
      }
      if (char === "/" && next === "/") {
        lineComment = true;
        i++;
        continue;
      }
      if (char === "/" && next === "*") {
        blockComment = true;
        i++;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "`") {
        template = true;
        continue;
      }
      if (char === "(") depth++;
      else if (char === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push({ index: match.index ?? 0, args: source.slice(start, i) });
  }
  return calls;
}

const sources = [...collectSources(join(REPO_ROOT, "apps/web/src")), ...collectPackageWebSources()];

const allCalls: ToastCall[] = [];
const echoing: ToastCall[] = [];
for (const file of sources) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("toast.")) continue;
  for (const call of extractToastCalls(source)) {
    const line = source.slice(0, call.index).split("\n").length;
    const rel = relative(REPO_ROOT, file);
    allCalls.push({ file: rel, line, args: call.args });
    // `.message` 是原始文本的取用点；`{{message}}` 只是槽位名，不在此列（槽位有没有被删由各包字典测试管）
    if (/\b\w+\.message\b/.test(call.args)) echoing.push({ file: rel, line, args: call.args });
  }
}

describe("toast 实参不得回显服务端原始 message", () => {
  // 扫描器自检：口径覆盖到全部页面文件（否则「零命中」可能只是扫描器早退）。
  test("扫描有效性自检：宿主与包内 web 源码都被扫到", () => {
    expect(sources.length).toBeGreaterThan(400);
    expect(allCalls.length).toBeGreaterThan(250);
  });

  // 除豁免清单外，任何 `toast.*` 的实参里都不该出现 `.message`（§9.3）
  test("宿主与各包 web 源码中的 toast 调用一律不回显 err.message", () => {
    const violations = echoing.filter((call) => !(call.file in ALLOWED_RAW_MESSAGE_CALLS));
    expect(violations.map((call) => `${call.file}:${call.line} ${call.args.slice(0, 80).trim()}`)).toEqual([]);
  });

  // 豁免清单是契约：处数必须与实测一致，多一处少一处都要回到这里改理由
  test("豁免清单的处数与实测一致（新增或消失都必须更新理由）", () => {
    const actual = new Map<string, number>();
    for (const call of echoing) actual.set(call.file, (actual.get(call.file) ?? 0) + 1);
    const declared = Object.fromEntries(Object.entries(ALLOWED_RAW_MESSAGE_CALLS).map(([k, v]) => [k, v.count]));
    expect(Object.fromEntries([...actual.entries()].sort())).toEqual(
      Object.fromEntries(Object.entries(declared).sort()),
    );
  });
});
