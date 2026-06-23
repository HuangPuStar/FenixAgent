# Workflow Editor UX 改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec `docs/superpowers/specs/2026-06-23-workflow-editor-ux-design.md`，覆盖 4 项 workflow 编辑器体验改造：outputs 全类型编辑 / custom 工具可发现性 / start 节点全局设置 / 一键发布按钮。

**Architecture:** 自底向上分 4 层施工：① workflow-engine 包 schema（outputs 提升到 BaseNodeDef）→ ② rcs 后端新增 custom-tools API 路由 → ③ 前端新组件（OutputsEditor / ParamsEditor）→ ④ 前端集成（NodeConfigCard / WorkflowMetaCard / nodes.tsx / WorkflowEditor / useWorkflowCanvas）+ 发布按钮 + i18n。每层独立测试 + 独立提交。

**Tech Stack:** TypeScript / Bun test / Elysia / React 19 / @xyflow/react / react-i18next / Tailwind CSS v4 / @lobehub/icons（不使用）

---

## 文件结构

**新建（5 个）**：

| 路径 | 责任 |
|------|------|
| `src/routes/web/workflow-custom-tools.ts` | GET 路由，返回 `getCustomToolsRegistry().list()` |
| `src/__tests__/routes/workflow-custom-tools.test.ts` | 后端 L3 测试 |
| `web/src/pages/workflow/components/OutputsEditor.tsx` | outputs 字段编辑器（key + pattern + type） |
| `web/src/pages/workflow/components/ParamsEditor.tsx` | params 字段编辑器（name + type + default + required） |
| `web/src/__tests__/workflow-params-outputs-flow.test.tsx` | 前端关键流程测试 |

**修改（13 个）**：

| 路径 | 改动 |
|------|------|
| `packages/workflow-engine/src/types/dag.ts` | `outputs` 从 CustomNodeDef 移到 BaseNodeDef |
| `packages/workflow-engine/src/parser/yaml-parser.ts` | `parseOutputs` 调用从 custom 分支提升到 `base` |
| `packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts` | 补 shell+outputs 测试 |
| `src/routes/web/index.ts` | 注册 workflow-custom-tools 路由 |
| `web/src/api/workflow-defs.ts` | 加 `customToolsApi.list()` + `CustomToolItem` 类型 |
| `web/src/pages/workflow/WorkflowEditor.tsx` | customTools state + palette 分区 + 发布按钮 + ConfirmDialog + props 透传 |
| `web/src/pages/workflow/hooks/useWorkflowCanvas.ts` | `addNode` 增加 tool 参数 + onDrop 适配 |
| `web/src/pages/workflow/components/NodeConfigCard.tsx` | 加 outputs 编辑 + custom tool datalist + isStartNode 渲染 WorkflowMetaCard |
| `web/src/pages/workflow/components/NodeConfigPopover.tsx` | 透传 meta/updateMeta/customTools props + header 标题 |
| `web/src/pages/workflow/components/WorkflowMetaCard.tsx` | JSON textarea 换为 ParamsEditor |
| `web/src/pages/workflow/nodes.tsx` | custom 节点主标题优先用 tool 名 |
| `web/src/i18n/locales/en/workflows.json` | 新增 i18n key |
| `web/src/i18n/locales/zh/workflows.json` | 新增 i18n key |

---

## Task 1: 把 outputs 字段从 CustomNodeDef 提升到 BaseNodeDef

**Files:**
- Modify: `packages/workflow-engine/src/types/dag.ts`
- Modify: `packages/workflow-engine/src/parser/yaml-parser.ts`
- Test: `packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts`

- [ ] **Step 1.1: 在 dag.ts 的 BaseNodeDef 加 outputs 字段**

打开 `packages/workflow-engine/src/types/dag.ts`，找到 `BaseNodeDef`（约第 21 行）。在 `env?` 字段后追加：

```typescript
/** 输出声明。所有节点类型都可声明，key 为字段名，下游通过 nodes.X.outputs.<key> 引用 */
outputs?: Record<string, {
  pattern: string;
  type: "file" | "file-list" | "dir";
}>;
```

- [ ] **Step 1.2: 从 CustomNodeDef 删除 outputs 字段**

在同一个文件 `dag.ts`，找到 `CustomNodeDef` 接口（约第 111 行）。删除其中的 `outputs` 字段声明（约第 142-148 行）：

```typescript
// 删除这一段：
/** 输出声明，key 对应 CustomNode.produces 的元素 */
outputs: Record<
  string,
  {
    pattern: string;
    type: "file" | "file-list" | "dir";
  }
>;
```

保留 `CustomNodeDef` 上方的注释，改为说明 outputs 现在继承自 BaseNodeDef：

```typescript
/**
 * Custom 节点的 outputs（继承自 BaseNodeDef）优先由 tool 注册时的 produces 驱动；
 * YAML 中声明的 outputs 可作为覆盖或补充。custom-executor 会校验 outputs key
 * 必须在 tool.produces 列表中（除非 produces 含 "*"）。
 */
```

- [ ] **Step 1.3: 在 yaml-parser.ts 把 parseOutputs 调用提升到 base**

打开 `packages/workflow-engine/src/parser/yaml-parser.ts`。找到 `const base = { ... }`（约第 130-137 行）。改为：

```typescript
const base = {
  id: n.id as string,
  type,
  depends_on: Array.isArray(n.depends_on) ? (n.depends_on as string[]) : undefined,
  condition: typeof n.condition === "string" ? n.condition : undefined,
  timeout: typeof n.timeout === "number" ? n.timeout : undefined,
  env: isRecord(n.env) ? (n.env as Record<string, string>) : undefined,
  outputs: parseOutputs(n.outputs),
};
```

- [ ] **Step 1.4: 删除 custom 分支中重复的 outputs 解析**

仍在 `yaml-parser.ts`，找到 `case "custom":` 分支（约第 271 行起）。该分支当前有一段：

```typescript
if (!n.outputs || !isRecord(n.outputs)) {
  throw new WorkflowError(
    `nodes[${index}] (${n.id}): custom node requires 'outputs' mapping`,
    WorkflowErrorCode.INVALID_YAML,
  );
}
```

保留这段强校验（custom 仍要求必须有 outputs）。但下游对 `n.outputs` 的引用要改为读 base.outputs，因为 base 已经解析过。

具体地，找到 custom 分支里读取 `n.outputs` 的循环（约第 292-308 行），把 `Object.keys(n.outputs as Record<string, unknown>)` 改为 `Object.keys(base.outputs ?? {})`。

最后，删除 custom 分支 return 语句中的 `outputs: parseOutputs(n.outputs),` 这一行（约第 335 行），因为 base 已经包含。

- [ ] **Step 1.5: 写失败测试 — shell 节点声明 outputs**

打开 `packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts`，在文件末尾追加：

```typescript
test("shell 节点声明 outputs 被解析到 ShellNodeDef.outputs", () => {
  const yamlStr = `
schema_version: "1"
name: test
nodes:
  - id: s1
    type: shell
    command: echo hi
    outputs:
      result:
        pattern: /tmp/out.txt
        type: file
`;
  const wf = parseWorkflow(yamlStr);
  const node = wf.nodes[0];
  expect(node.type).toBe("shell");
  // biome-ignore lint/suspicious/noExplicitAny: test-only access
  expect((node as any).outputs).toEqual({
    result: { pattern: "/tmp/out.txt", type: "file" },
  });
});
```

- [ ] **Step 1.6: 运行新测试，确认通过**

运行命令：

```bash
cd packages/workflow-engine && bun test src/__tests__/parser/yaml-parser.test.ts
```

预期：新测试 PASS，原有测试也都 PASS（因为 custom 节点 outputs 字段语义不变）。

如果原有测试失败，重点检查 Step 1.4 是否漏改了 `n.outputs` → `base.outputs`。

- [ ] **Step 1.7: 跑 workflow-engine 全部测试确认无回归**

```bash
cd packages/workflow-engine && bun test
```

预期：全部测试 PASS。如果 `custom-executor.test.ts` 或 `dag-scheduler.test.ts` 报错，说明 custom 分支的 outputs 改动有遗漏，回 Step 1.4 重检查。

- [ ] **Step 1.8: 提交**

```bash
git add packages/workflow-engine/src/types/dag.ts packages/workflow-engine/src/parser/yaml-parser.ts packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts
git commit -m "$(cat <<'EOF'
refactor(workflow-engine): outputs 字段从 CustomNodeDef 提升到 BaseNodeDef

所有节点类型（shell/python/agent/api/audit/workflow/loop/transform/custom）
现在都能声明 outputs。custom 类型保留必填校验，其他类型可选。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 2: 新增 GET /web/workflow-custom-tools 路由

**Files:**
- Modify: `src/test-utils/stubs/module-stubs.ts`（新增 customTools stub 注册表）
- Modify: `src/test-utils/setup-mocks.ts`（注册 customTools 模块 mock）
- Create: `src/routes/web/workflow-custom-tools.ts`
- Modify: `src/routes/web/index.ts`
- Test: `src/__tests__/routes/workflow-custom-tools.test.ts`

- [ ] **Step 2.1: 在 test-utils 注册 customTools stub**

> **为何先做这步**：CLAUDE.md 测试铁律禁止在测试文件里调 `mock.module()`，所有模块 mock 必须走 `src/test-utils/stubs/module-stubs.ts` 注册表 + `src/test-utils/setup-mocks.ts` preload。本 task 的路由测试需要 mock `getCustomToolsRegistry`，所以先把 stub 注册好，后面 Step 2.4 的测试文件才能用 `stubCustomTools(...)` 配置数据。

打开 `src/test-utils/stubs/module-stubs.ts`，在 `pgStorageAdapterRegistry` 后面追加新注册表：

```typescript
// ../services/workflow/custom-tools — CustomNode 工具注册表（getCustomToolsRegistry）
// 路由测试通过 stubCustomTools({ getCustomToolsRegistry: () => ... }) 配置可控返回值
export const customToolsRegistry = createStubRegistry("customTools", false);
```

在便捷函数区（`stubPgStorageAdapter` 后面）追加：

```typescript
export const stubCustomTools = customToolsRegistry.stub;
```

在 `resetModuleStubs()` 函数体末尾（`pgStorageAdapterRegistry.reset();` 后面）追加：

```typescript
customToolsRegistry.reset();
```

然后打开 `src/test-utils/setup-mocks.ts`：

1. 在顶部 import 大括号里追加 `customToolsRegistry`（按字母序插入）：

```typescript
import {
  coreBootstrapRegistry,
  customToolsRegistry,
  environmentServiceRegistry,
  getEnvironmentRepoStub,
  knowledgeBaseServiceRegistry,
  pgStorageAdapterRegistry,
  registryHeartbeatRegistry,
  registryRegistry,
} from "./stubs/module-stubs";
```

2. 在文件末尾追加 custom-tools 的 mock（用 createLazyMock 模式，与 pg-storage-adapter 风格一致；该模块只导出函数，不会触发 `getCustomToolsRegistry` 在 preload 阶段被调用）：

```typescript
// ── custom-tools ──
// 提供 getCustomToolsRegistry / initCustomToolsRegistry 的 stub 入口。
// 路由测试通过 stubCustomTools({ getCustomToolsRegistry: () => fakeRegistry }) 注入数据。

const CUSTOM_TOOLS_KEYS = ["getCustomToolsRegistry", "initCustomToolsRegistry"] as const;
mock.module("../services/workflow/custom-tools", () =>
  createLazyMock(CUSTOM_TOOLS_KEYS, (name) => customToolsRegistry.get(name) as AnyFn),
);
```

- [ ] **Step 2.2: 创建路由文件**

新建 `src/routes/web/workflow-custom-tools.ts`：

```typescript
/**
 * Custom Tools 查询路由。
 *
 * GET /web/workflow-custom-tools — 返回当前服务注册的所有 CustomNode 工具元数据。
 * 数据源：getCustomToolsRegistry().list()，全局共享，不按 organizationId 隔离
 * （tool 定义本身是全局的；按 org 隔离的是 WorkflowEngine 实例和 storage）。
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { getCustomToolsRegistry } from "../../services/workflow/custom-tools";

export const webWorkflowCustomTools = new Elysia({ name: "web-workflow-custom-tools" })
  .use(authGuardPlugin)
  .get(
    "/workflow-custom-tools",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    async ({ store }: any) => {
      // authGuardPlugin 保证登录；未登录走 401 拦截，不会到此处
      void store.authContext;
      const registry = getCustomToolsRegistry();
      const tools = registry.list();
      return { success: true, data: tools };
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Workflow"],
        summary: "列出已注册的自定义节点工具",
        description:
          "返回 WORKFLOW_TOOLS_DIR 下注册的所有 CustomNode 工具元数据（name/description/inputs/produces），供前端 palette 和节点配置下拉使用。",
      },
    },
  );
```

- [ ] **Step 2.3: 注册到 web 路由聚合**

打开 `src/routes/web/index.ts`。

在 import 区（约第 20-23 行的 workflow 相关 import 附近）加：

```typescript
import webWorkflowCustomTools from "./workflow-custom-tools";
```

在 `webApp` 链式 `.use()` 调用中（约第 43-44 行之间），加 `.use(webWorkflowCustomTools)`：

```typescript
.use(webWorkflowDefs)
.use(webWorkflowCustomTools)
.use(webWorkflowEngine)
```

- [ ] **Step 2.4: 写失败测试 — 路由基本行为**

新建 `src/__tests__/routes/workflow-custom-tools.test.ts`。

> **注意**：禁止在测试文件里调 `mock.module()`（CLAUDE.md 测试铁律）。模块 mock 已在 `setup-mocks.ts` preload 注册，本文件通过 `stubCustomTools(...)` 注入可控数据。

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, setTestAuth, setTestOrgContext } from "../../test-utils/setup-mocks";
import { stubCustomTools } from "../../test-utils/stubs/module-stubs";
// 路由通过 web app 聚合测试，参照 workflow-defs.test.ts 模式
import webApp from "../../routes/web/index";

describe("GET /web/workflow-custom-tools", () => {
  beforeEach(() => {
    resetAllStubs();
    setTestAuth({ userId: "u1" });
    setTestOrgContext({ organizationId: "org1" });
    // 注入 fake registry 数据；setup-mocks.ts 已 mock 模块，此处只配置返回值
    stubCustomTools({
      getCustomToolsRegistry: () => ({
        list: () => [
          {
            name: "trim_galore",
            description: "FastQC 质控",
            inputs: { r1: { type: "string" } },
            produces: ["trimmed_r1"],
          },
        ],
      }),
    });
  });

  test("已登录返回 registry.list() 数据", async () => {
    const r = await webApp.handle(new Request("http://x/web/workflow-custom-tools"));
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].name).toBe("trim_galore");
  });

  test("未登录返回 401", async () => {
    setTestAuth(null);
    const r = await webApp.handle(new Request("http://x/web/workflow-custom-tools"));
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2.5: 运行测试，确认通过**

```bash
bun test src/__tests__/routes/workflow-custom-tools.test.ts
```

预期：2 个测试 PASS。如果 401 测试失败，检查 `authGuardPlugin` 是否正确拦截未登录请求（可能需要在测试中清除 auth cookie）。如果"已登录"测试报 `customTools stub 'getCustomToolsRegistry' not configured`，确认 Step 2.1 已在 `setup-mocks.ts` 注册 mock。

- [ ] **Step 2.6: 提交**

```bash
git add src/test-utils/stubs/module-stubs.ts src/test-utils/setup-mocks.ts \
        src/routes/web/workflow-custom-tools.ts src/routes/web/index.ts \
        src/__tests__/routes/workflow-custom-tools.test.ts
git commit -m "$(cat <<'EOF'
feat(workflow): 新增 GET /web/workflow-custom-tools 路由

返回 CustomNodeRegistry.list() 的工具元数据，供前端 palette 列出
已注册工具和节点配置下拉选择。同时在 test-utils 注册 customTools
stub，使后续测试可走 stubCustomTools() 标准模式。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 3: 新增 OutputsEditor 组件

**Files:**
- Create: `web/src/pages/workflow/components/OutputsEditor.tsx`

仿 `InputsEditor.tsx`（`web/src/pages/workflow/components/InputsEditor.tsx`）模式，每行 3 列（key + pattern + type select）。

- [ ] **Step 3.1: 创建 OutputsEditor.tsx**

新建 `web/src/pages/workflow/components/OutputsEditor.tsx`：

```typescript
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type OutputType = "file" | "file-list" | "dir";

export interface OutputEntry {
  pattern: string;
  type: OutputType;
}

export function OutputsEditor({
  value,
  onChange,
  readOnly,
  keyPlaceholder,
  patternPlaceholder,
  addLabel,
}: {
  value: Record<string, OutputEntry> | undefined;
  onChange: (val: Record<string, OutputEntry> | undefined) => void;
  readOnly: boolean;
  keyPlaceholder: string;
  patternPlaceholder: string;
  addLabel: string;
}) {
  const { t } = useTranslation("workflows");
  const entries = Object.entries(value ?? {});
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRefs = useRef<(HTMLInputElement | null)[]>([]);

  const entriesLen = entries.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when entry count changes
  useEffect(() => {
    setConfirmDeleteKey(null);
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, [entriesLen]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const updateKey = (index: number, newKey: string) => {
    const updated: Record<string, OutputEntry> = {};
    entries.forEach(([k, v], i) => {
      if (i === index) updated[newKey] = v;
      else updated[k] = v;
    });
    onChange(updated);
  };

  const updateEntry = (index: number, patch: Partial<OutputEntry>) => {
    const updated = { ...value };
    const oldKey = entries[index][0];
    updated[oldKey] = { ...updated[oldKey], ...patch };
    onChange(updated);
  };

  const removeEntry = (index: number) => {
    const updated = { ...value };
    delete updated[entries[index][0]];
    onChange(Object.keys(updated).length === 0 ? undefined : updated);
  };

  const handleDeleteClick = (index: number) => {
    const entryKey = entries[index][0];
    if (confirmDeleteKey === entryKey) {
      removeEntry(index);
      setConfirmDeleteKey(null);
    } else {
      setConfirmDeleteKey(entryKey);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDeleteKey(null), 3000);
    }
  };

  const addEntry = () => {
    const updated = { ...(value ?? {}), "": { pattern: "", type: "file" as OutputType } };
    onChange(updated);
    requestAnimationFrame(() => {
      const lastIdx = Object.keys(updated).length - 1;
      keyRefs.current[lastIdx]?.focus();
    });
  };

  return (
    <div>
      {entries.map(([k, v], i) => {
        const isConfirming = confirmDeleteKey === k && k !== "";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: index needed to keep focus stable while editing key
          <div key={`${k}-${i}`} style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}>
            <input
              ref={(el) => {
                keyRefs.current[i] = el;
              }}
              value={k}
              onChange={(e) => updateKey(i, e.target.value)}
              placeholder={keyPlaceholder}
              readOnly={readOnly}
              style={{
                width: "28%",
                ...(k.trim() === "" ? { borderColor: "#fca5a5", background: "#fef2f2" } : {}),
              }}
            />
            <input
              value={v.pattern}
              onChange={(e) => updateEntry(i, { pattern: e.target.value })}
              placeholder={patternPlaceholder}
              readOnly={readOnly}
              style={{ flex: 1 }}
            />
            <select
              value={v.type}
              onChange={(e) => updateEntry(i, { type: e.target.value as OutputType })}
              disabled={readOnly}
              style={{ width: 84 }}
            >
              <option value="file">file</option>
              <option value="file-list">file-list</option>
              <option value="dir">dir</option>
            </select>
            {!readOnly && (
              <button
                type="button"
                onClick={() => handleDeleteClick(i)}
                title={isConfirming ? t("components:confirm") : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 24,
                  height: 24,
                  border: "none",
                  background: isConfirming ? "#fef2c7" : "none",
                  color: isConfirming ? "#ef4444" : "#9ca3af",
                  cursor: "pointer",
                  borderRadius: 4,
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <button
          type="button"
          onClick={addEntry}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            border: "none",
            background: "none",
            color: "#6b7280",
            cursor: "pointer",
            fontSize: 11,
            padding: 0,
          }}
        >
          <Plus size={12} /> {addLabel}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3.2: 验证文件 tsc 类型检查通过**

```bash
bun run precheck 2>&1 | tail -20
```

预期：tsc 阶段无错误。如果有错误，根据报错修正（通常是 import 路径或 type 注解）。

- [ ] **Step 3.3: 提交**

```bash
git add web/src/pages/workflow/components/OutputsEditor.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): 新增 OutputsEditor 组件

仿 InputsEditor 模式，每行编辑 outputs 字段的 key + pattern + type
（file/file-list/dir）。支持二次点击删除、空 key 红色警告。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 4: 新增 ParamsEditor 组件

**Files:**
- Create: `web/src/pages/workflow/components/ParamsEditor.tsx`

- [ ] **Step 4.1: 创建 ParamsEditor.tsx**

新建 `web/src/pages/workflow/components/ParamsEditor.tsx`：

```typescript
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type ParamType = "string" | "number" | "boolean" | "object";

export interface ParamEntry {
  type?: ParamType;
  default?: unknown;
  required?: boolean;
}

export function ParamsEditor({
  value,
  onChange,
  readOnly,
  namePlaceholder,
  defaultPlaceholder,
  addLabel,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: meta.params 来自用户定义 JSON
  value: Record<string, any> | undefined;
  onChange: (val: Record<string, ParamEntry> | undefined) => void;
  readOnly: boolean;
  namePlaceholder: string;
  defaultPlaceholder: string;
  addLabel: string;
}) {
  const { t } = useTranslation("workflows");
  const entries = Object.entries(value ?? {});
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRefs = useRef<(HTMLInputElement | null)[]>([]);
  // object 类型的 textarea 单独维护输入文本，JSON 解析失败时不写入
  const [objectDrafts, setObjectDrafts] = useState<Record<number, string>>({});

  const entriesLen = entries.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on length change
  useEffect(() => {
    setConfirmDeleteKey(null);
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, [entriesLen]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const updateKey = (index: number, newKey: string) => {
    const updated: Record<string, ParamEntry> = {};
    entries.forEach(([k, v], i) => {
      if (i === index) updated[newKey] = v as ParamEntry;
      else updated[k] = v as ParamEntry;
    });
    onChange(updated);
  };

  const updateEntry = (index: number, patch: Partial<ParamEntry>) => {
    const updated = { ...value };
    const oldKey = entries[index][0];
    updated[oldKey] = { ...(updated[oldKey] as ParamEntry), ...patch };
    onChange(updated);
  };

  // type 切换时清空 default，避免类型不匹配（如 number 切换到 object 留下数字）
  const changeType = (index: number, newType: ParamType) => {
    setObjectDrafts((d) => ({ ...d, [index]: "" }));
    updateEntry(index, { type: newType, default: undefined });
  };

  const updateDefault = (index: number, newDefault: unknown) => {
    updateEntry(index, { default: newDefault });
  };

  const handleObjectInput = (index: number, text: string) => {
    setObjectDrafts((d) => ({ ...d, [index]: text }));
    const trimmed = text.trim();
    if (!trimmed) {
      updateDefault(index, undefined);
      return;
    }
    try {
      updateDefault(index, JSON.parse(trimmed));
    } catch {
      // JSON 解析失败时仅保留 draft 文本，不写入 default
    }
  };

  const removeEntry = (index: number) => {
    const updated = { ...value };
    delete updated[entries[index][0]];
    onChange(Object.keys(updated).length === 0 ? undefined : updated);
  };

  const handleDeleteClick = (index: number) => {
    const entryKey = entries[index][0];
    if (confirmDeleteKey === entryKey) {
      removeEntry(index);
      setConfirmDeleteKey(null);
    } else {
      setConfirmDeleteKey(entryKey);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDeleteKey(null), 3000);
    }
  };

  const addEntry = () => {
    const updated = {
      ...(value ?? {}),
      "": { type: "string" as ParamType, default: undefined, required: false },
    };
    onChange(updated);
    requestAnimationFrame(() => {
      const lastIdx = Object.keys(updated).length - 1;
      keyRefs.current[lastIdx]?.focus();
    });
  };

  const renderDefaultControl = (index: number, entry: ParamEntry) => {
    const type = entry.type ?? "string";
    if (type === "boolean") {
      return (
        <input
          type="checkbox"
          checked={entry.default === true}
          onChange={(e) => updateDefault(index, e.target.checked)}
          disabled={readOnly}
        />
      );
    }
    if (type === "number") {
      return (
        <input
          type="number"
          value={entry.default != null ? String(entry.default) : ""}
          onChange={(e) => updateDefault(index, e.target.value ? Number(e.target.value) : undefined)}
          placeholder={defaultPlaceholder}
          readOnly={readOnly}
          style={{ flex: 1 }}
        />
      );
    }
    if (type === "object") {
      const draft = objectDrafts[index];
      const text = draft !== undefined ? draft : (entry.default != null ? JSON.stringify(entry.default) : "");
      // 提前判断 JSON 是否合法，避免内联复杂三元
      const isInvalid = (() => {
        if (draft === undefined || draft.trim() === "") return false;
        try {
          JSON.parse(draft);
          return false;
        } catch {
          return true;
        }
      })();
      const textareaStyle: React.CSSProperties = {
        flex: 1,
        ...(isInvalid ? { borderColor: "#fca5a5", background: "#fef2f2" } : {}),
      };
      return (
        <textarea
          value={text}
          onChange={(e) => handleObjectInput(index, e.target.value)}
          placeholder='{"key": "value"}'
          rows={2}
          readOnly={readOnly}
          style={textareaStyle}
        />
      );
    }
    // string
    return (
      <input
        type="text"
        value={entry.default != null ? String(entry.default) : ""}
        onChange={(e) => updateDefault(index, e.target.value || undefined)}
        placeholder={defaultPlaceholder}
        readOnly={readOnly}
        style={{ flex: 1 }}
      />
    );
  };

  return (
    <div>
      {entries.map(([k, v], i) => {
        const entry = v as ParamEntry;
        const isConfirming = confirmDeleteKey === k && k !== "";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: index needed to keep focus stable
          <div key={`${k}-${i}`} style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                ref={(el) => {
                  keyRefs.current[i] = el;
                }}
                value={k}
                onChange={(e) => updateKey(i, e.target.value)}
                placeholder={namePlaceholder}
                readOnly={readOnly}
                style={{
                  width: "28%",
                  ...(k.trim() === "" ? { borderColor: "#fca5a5", background: "#fef2f2" } : {}),
                }}
              />
              <select
                value={entry.type ?? "string"}
                onChange={(e) => changeType(i, e.target.value as ParamType)}
                disabled={readOnly}
                style={{ width: 84 }}
              >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="object">object</option>
              </select>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  fontSize: 10,
                  color: "#6b7280",
                  width: 64,
                }}
              >
                <input
                  type="checkbox"
                  checked={entry.required === true}
                  onChange={(e) => updateEntry(i, { required: e.target.checked })}
                  disabled={readOnly}
                />
                {t("editor.params_required_label")}
              </label>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleDeleteClick(i)}
                  title={isConfirming ? t("components:confirm") : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 24,
                    height: 24,
                    border: "none",
                    background: isConfirming ? "#fef2c7" : "none",
                    color: isConfirming ? "#ef4444" : "#9ca3af",
                    cursor: "pointer",
                    borderRadius: 4,
                    padding: 0,
                    flexShrink: 0,
                  }}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
            <div style={{ display: "flex", gap: 4, alignItems: "flex-start", marginTop: 2 }}>
              <span style={{ fontSize: 10, color: "#9ca3af", width: "28%", textAlign: "right" }}>
                {t("editor.params_default_label")}
              </span>
              <div style={{ flex: 1, display: "flex" }}>{renderDefaultControl(i, entry)}</div>
            </div>
          </div>
        );
      })}
      {!readOnly && (
        <button
          type="button"
          onClick={addEntry}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            border: "none",
            background: "none",
            color: "#6b7280",
            cursor: "pointer",
            fontSize: 11,
            padding: 0,
          }}
        >
          <Plus size={12} /> {addLabel}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4.2: 验证 tsc 通过**

```bash
bun run precheck 2>&1 | tail -30
```

预期：tsc 阶段无错误。

- [ ] **Step 4.3: 提交**

```bash
git add web/src/pages/workflow/components/ParamsEditor.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): 新增 ParamsEditor 组件

每行编辑 name + type + default + required。default 控件按 type 切换：
string→text, number→number, boolean→checkbox, object→textarea(JSON 校验)。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 5: WorkflowMetaCard 用 ParamsEditor 替换 JSON textarea

**Files:**
- Modify: `web/src/pages/workflow/components/WorkflowMetaCard.tsx`

- [ ] **Step 5.1: 修改 WorkflowMetaCard.tsx**

打开 `web/src/pages/workflow/components/WorkflowMetaCard.tsx`，做以下改动：

1. 顶部 import 区加 ParamsEditor：

```typescript
import { ParamsEditor } from "./ParamsEditor";
```

2. 找到 params 区块（约第 47-66 行），整段替换为：

```typescript
<div className="wf-prop-section">
  <div className="wf-prop-section-title">{t("editor.params")}</div>
  <ParamsEditor
    value={meta.params}
    onChange={(val) => updateMeta({ params: val ?? {} })}
    readOnly={readOnly}
    namePlaceholder={t("editor.params_name_placeholder")}
    defaultPlaceholder={t("editor.params_default_placeholder")}
    addLabel={t("editor.params_add")}
  />
</div>
```

删除原来的 JSON textarea（包含 `JSON.stringify(meta.params, null, 2)` 和 `JSON.parse` 那段）。

- [ ] **Step 5.2: 验证 tsc 通过**

```bash
bun run precheck 2>&1 | tail -20
```

预期：tsc 通过。如果报 `meta.params` 类型不匹配，确认 ParamsEditor 的 value prop 接受 `Record<string, any>`（Step 4.1 中已用 biome-ignore 处理）。

- [ ] **Step 5.3: 手动验证**

```bash
bun run dev:web
```

打开浏览器，进入 workflow 编辑器，点击右下角齿轮，确认 params 区块已从 JSON textarea 变为字段表单。能增删参数、切换 type、default 控件随之变化。验证后 Ctrl+C 停止 dev server。

- [ ] **Step 5.4: 提交**

```bash
git add web/src/pages/workflow/components/WorkflowMetaCard.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): WorkflowMetaCard 的 params 改为字段表单编辑

用 ParamsEditor 替换原 JSON textarea，每行编辑 name/type/default/required。
default 控件按 type 动态切换，object 类型实时 JSON 校验。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 6: NodeConfigCard 改造（outputs + custom datalist + start 显示 WorkflowMetaCard）

**Files:**
- Modify: `web/src/pages/workflow/components/NodeConfigCard.tsx`

此 task 改动较多，分 4 步：扩展 props、isStartNode 改用 WorkflowMetaCard、custom tool datalist、各类型加 outputs 区块。

- [ ] **Step 6.1: 扩展 NodeConfigCard props**

打开 `web/src/pages/workflow/components/NodeConfigCard.tsx`。

修改 `NodeConfigCardProps` 接口（约第 8-18 行），新增 3 个 props：

```typescript
import type { CustomToolItem } from "../../../api/workflow-defs";
// ... 其他 import
import { WorkflowMetaCard } from "./WorkflowMetaCard";
import { OutputsEditor, type OutputEntry } from "./OutputsEditor";
import type { WfMeta } from "../yaml-utils";

export interface NodeConfigCardProps {
  readOnly: boolean;
  selectedNode: Node;
  sd: Record<string, unknown> | undefined;
  nodeType: string;
  handleIdChange: (newId: string) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setSelectedNode: React.Dispatch<React.SetStateAction<Node | null>>;
  updateNodeData: (patch: Record<string, unknown>) => void;
  agentList: AgentNodeOption[];
  // 新增 props
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
  customTools: CustomToolItem[];
}
```

在函数签名解构中加入这 3 个 props（约第 20-30 行）：

```typescript
export function NodeConfigCard({
  readOnly,
  selectedNode,
  sd,
  nodeType,
  handleIdChange,
  setNodes,
  setSelectedNode,
  updateNodeData,
  agentList,
  meta,           // 新增
  updateMeta,     // 新增
  customTools,    // 新增
}: NodeConfigCardProps) {
```

- [ ] **Step 6.2: isStartNode 分支改用 WorkflowMetaCard**

找到 isStartNode 分支（约第 37-44 行），整段替换为：

```tsx
{isStartNode ? (
  <WorkflowMetaCard readOnly={readOnly} meta={meta} updateMeta={updateMeta} />
) : (
  // 原节点配置逻辑保持不变
  <>
    {/* ... */}
  </>
)}
```

- [ ] **Step 6.3: custom 类型的 tool 字段改为 datalist**

找到 custom 类型的渲染区块（约第 401-426 行的 `nodeType === "custom"` 分支），把 `<input>` 改为带 datalist 的版本：

```tsx
{nodeType === "custom" && (
  <>
    <div className="wf-prop-field">
      <label>{t("editor.custom_tool")}</label>
      <input
        list="custom-tools-list"
        value={String(sd?.tool ?? "")}
        onChange={(e) => updateNodeData({ tool: e.target.value || undefined })}
        placeholder={t("editor.custom_tool_placeholder")}
        readOnly={readOnly}
      />
      <datalist id="custom-tools-list">
        {customTools.map((tool) => (
          <option key={tool.name} value={tool.name}>
            {tool.description}
          </option>
        ))}
      </datalist>
    </div>
    <div className="wf-prop-field">
      <label>{t("editor.inputs_title")}</label>
      <InputsEditor
        value={sd?.inputs as Record<string, string> | undefined}
        onChange={(val) => {
          updateNodeData({ inputs: val && Object.keys(val).length > 0 ? val : undefined });
        }}
        readOnly={readOnly}
        keyPlaceholder={t("editor.inputs_key_placeholder")}
        valuePlaceholder={t("editor.inputs_value_hint")}
        addLabel={t("editor.inputs_add")}
      />
    </div>
    <div className="wf-prop-field">
      <label>{t("editor.outputs_title")}</label>
      <OutputsEditor
        value={sd?.outputs as Record<string, OutputEntry> | undefined}
        onChange={(val) => updateNodeData({ outputs: val })}
        readOnly={readOnly}
        keyPlaceholder={t("editor.outputs_key_placeholder")}
        patternPlaceholder={t("editor.outputs_pattern_placeholder")}
        addLabel={t("editor.outputs_add")}
      />
    </div>
  </>
)}
```

- [ ] **Step 6.4: 其他 7 种类型（shell/python/agent/api/audit/workflow/loop）加 outputs 区块**

对每种非 start、非 transform、非 custom 的类型，在节点配置区块的最末尾字段之后、闭合 `</>` 之前加 outputs 编辑区块。

以 shell 为例（约第 91-127 行的 `nodeType === "shell"` 分支），在 InputsEditor 后追加：

```tsx
<div className="wf-prop-field">
  <label>{t("editor.outputs_title")}</label>
  <OutputsEditor
    value={sd?.outputs as Record<string, OutputEntry> | undefined}
    onChange={(val) => updateNodeData({ outputs: val })}
    readOnly={readOnly}
    keyPlaceholder={t("editor.outputs_key_placeholder")}
    patternPlaceholder={t("editor.outputs_pattern_placeholder")}
    addLabel={t("editor.outputs_add")}
  />
</div>
```

对 python / agent / api / audit / workflow / loop 重复同样追加（位置都是各 type 分支的最末字段后）。

**注意**：transform 类型**不**加 outputs（它有自己的 `output` 表达式 map，语义不同）。

- [ ] **Step 6.5: 验证 tsc 通过**

```bash
bun run precheck 2>&1 | tail -30
```

预期：tsc 通过。如果报 CustomToolItem 或 OutputEntry 类型缺失，确认 import 路径正确。

- [ ] **Step 6.6: 提交**

```bash
git add web/src/pages/workflow/components/NodeConfigCard.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): NodeConfigCard 支持 outputs 编辑 / custom 工具下拉 / start 全局设置

- 所有非 start 非 transform 类型新增 outputs 字段编辑区块
- custom 类型 tool 字段从 input 改为 datalist，下拉已注册工具
- isStartNode 分支从 hint 改为 WorkflowMetaCard，复用全局设置表单

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 7: NodeConfigPopover 透传 props + header 标题

**Files:**
- Modify: `web/src/pages/workflow/components/NodeConfigPopover.tsx`

- [ ] **Step 7.1: 扩展 NodeConfigPopover props**

打开 `web/src/pages/workflow/components/NodeConfigPopover.tsx`。

修改 import 区（约第 9-11 行），加入：

```typescript
import type { CustomToolItem } from "../../../api/workflow-defs";
import type { WfMeta } from "../yaml-utils";
```

修改 `NodeConfigPopoverProps` 接口（约第 13-31 行），新增 3 个 props：

```typescript
export interface NodeConfigPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedNode: Node | null;
  sd: Record<string, unknown> | undefined;
  nodeType: string;
  readOnly: boolean;
  handleIdChange: (newId: string) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setSelectedNode: React.Dispatch<React.SetStateAction<Node | null>>;
  updateNodeData: (patch: Record<string, unknown>) => void;
  agentList: AgentNodeOption[];
  onDeleteRequest: (nodeId: string) => void;
  // 新增 props
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
  customTools: CustomToolItem[];
}
```

在函数签名解构中加入这 3 个 props（约第 33-46 行）。

- [ ] **Step 7.2: header 标题在 isStartNode 时改为 workflow_settings**

找到 popover header（约第 66-80 行），把 `<span className="wf-popover-title">{selectedNode.id}</span>` 改为：

```tsx
<span className="wf-popover-title">
  {isStartNode ? t("editor.workflow_settings") : selectedNode.id}
</span>
```

注意 `isStartNode` 已在文件中定义（约第 59 行：`const isStartNode = selectedNode.id === START_NODE_ID;`）。

- [ ] **Step 7.3: NodeConfigCard 调用处透传新 props**

找到 `<NodeConfigCard ... />` 调用（约第 81-91 行），在 agentList 后追加 3 个 props：

```tsx
<NodeConfigCard
  readOnly={readOnly}
  selectedNode={selectedNode}
  sd={sd}
  nodeType={nodeType}
  handleIdChange={handleIdChange}
  setNodes={setNodes}
  setSelectedNode={setSelectedNode}
  updateNodeData={updateNodeData}
  agentList={agentList}
  meta={meta}
  updateMeta={updateMeta}
  customTools={customTools}
/>
```

- [ ] **Step 7.4: 验证 tsc 通过（预期失败，因为 WorkflowEditor 还没传 props）**

```bash
bun run precheck 2>&1 | tail -20
```

预期：tsc 报错 `Property 'meta' is missing in type ... NodeConfigPopover`（来自 WorkflowEditor.tsx 的调用）。这个错误会在 Task 9 修复。**暂时不提交**，连同 Task 8/9 一起提交。

---

## Task 8: nodes.tsx 让 custom 节点主标题显示 tool 名

**Files:**
- Modify: `web/src/pages/workflow/nodes.tsx`

- [ ] **Step 8.1: 调整 nodeSubtitle 优先级**

打开 `web/src/pages/workflow/nodes.tsx`。找到 nodeSubtitle 定义（约第 96-97 行）：

```typescript
const description = typeof d.description === "string" ? d.description.trim() : "";
const nodeSubtitle = isStart ? "" : description || id;
```

替换为：

```typescript
const description = typeof d.description === "string" ? d.description.trim() : "";
// 优先级：description > tool 名（仅 custom）> id
// 让 custom 节点没填 description 时至少能看到 tool 名（如 "trim_galore"），
// 而不是冷冰冰的 "custom_2"。其他类型不受影响。
const toolName = typeof d.tool === "string" ? d.tool.trim() : "";
const nodeSubtitle = isStart
  ? ""
  : description || (nodeType === "custom" && toolName ? toolName : id);
```

- [ ] **Step 8.2: 验证 tsc 通过**

```bash
bun run precheck 2>&1 | tail -10
```

预期：tsc 通过。nodeSubtitle 已在前面 useMemo/变量声明中使用，改动只影响优先级，无类型变化。

- [ ] **Step 8.3: 暂不提交，与 Task 9-10 一起提交**

---

## Task 9: useWorkflowCanvas 扩展 addNode 支持 tool 参数

**Files:**
- Modify: `web/src/pages/workflow/hooks/useWorkflowCanvas.ts`

- [ ] **Step 9.1: 扩展 UseWorkflowCanvasReturn 接口**

打开 `web/src/pages/workflow/hooks/useWorkflowCanvas.ts`。

找到 `addNode` 接口声明（约第 60-64 行）：

```typescript
addNode: (
  type: string,
  presetOrPosition?: string | { x: number; y: number },
  positionFallback?: { x: number; y: number },
) => void;
```

改为：

```typescript
addNode: (
  type: string,
  presetOrPosition?: string | { x: number; y: number },
  positionFallback?: { x: number; y: number },
  tool?: string,
) => void;
```

- [ ] **Step 9.2: 修改 addNode 实现**

找到 `addNode` 实现函数（约第 229-263 行），修改签名和实现：

```typescript
const addNode = useCallback(
  (
    type: string,
    presetOrPosition?: string | { x: number; y: number },
    positionFallback?: { x: number; y: number },
    tool?: string,
  ) => {
    // 参数兼容处理：第二个参数可能是 preset 字符串或 position 对象
    let preset: string | undefined;
    let position: { x: number; y: number } | undefined;
    if (typeof presetOrPosition === "string") {
      preset = presetOrPosition;
      position = positionFallback;
    } else {
      position = presetOrPosition;
    }

    const presetConfig = preset ? getPresetById(preset) : undefined;
    const id = nextNodeId(type);
    const newNode: Node = {
      id,
      type,
      position: position ?? { x: 300 + Math.random() * 200, y: 100 + Math.random() * 200 },
      data: {
        ...(presetConfig
          ? {
              output: { ...presetConfig.defaultOutput },
              _preset: preset,
            }
          : {}),
        // custom 类型携带 tool 字段
        ...(type === "custom" && tool ? { tool } : {}),
      },
    };
    setNodes((nds) => [...nds, newNode]);
  },
  [setNodes],
);
```

- [ ] **Step 9.3: 修改 onDrop 适配 tool**

找到 `onDrop` 实现（约第 270-283 行），改为：

```typescript
const onDrop = useCallback(
  (event: React.DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/workflow-node");
    if (!type) return;
    const preset = event.dataTransfer.getData("application/workflow-preset");
    const tool = event.dataTransfer.getData("application/workflow-tool") || undefined;
    const position = screenToFlowPosition({
      x: event.clientX,
      y: event.clientY,
    });
    if (type === "custom" && tool) {
      addNode("custom", position, undefined, tool);
    } else {
      addNode(type, preset || position, preset ? position : undefined);
    }
  },
  [screenToFlowPosition, addNode],
);
```

- [ ] **Step 9.4: 验证 tsc 通过**

```bash
bun run precheck 2>&1 | tail -10
```

预期：tsc 通过。addNode 新参数可选，现有调用方（BASIC_PALETTE_ITEMS.onClick、TRANSFORM_PRESETS.onClick、WorkflowEditor 中其他调用）不破坏。

- [ ] **Step 9.5: 暂不提交，与 Task 10 一起提交**

---

## Task 10: 前端 API client + WorkflowEditor 集成（customTools + palette + props 透传）

**Files:**
- Modify: `web/src/api/workflow-defs.ts`
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

- [ ] **Step 10.1: 在 workflow-defs.ts 加 customToolsApi 和 CustomToolItem 类型**

打开 `web/src/api/workflow-defs.ts`。在文件末尾追加：

```typescript
/** CustomNode 工具元数据，对应后端 registry.list() 返回结构 */
export interface CustomToolInputDef {
  type: string;
  description?: string;
  // registry 中 InputDef 其他字段按需扩展
  [key: string]: unknown;
}

export interface CustomToolItem {
  name: string;
  description: string;
  inputs: Record<string, CustomToolInputDef>;
  produces: string[];
}

export const customToolsApi = {
  list: async (): Promise<CustomToolItem[]> => {
    const r = await fetch("/web/workflow-custom-tools", { credentials: "include" });
    if (!r.ok) {
      throw new Error(`Failed to load custom tools: ${r.status}`);
    }
    const json = (await r.json()) as { success?: boolean; data?: CustomToolItem[] };
    return Array.isArray(json.data) ? json.data : [];
  },
};
```

- [ ] **Step 10.2: 在 WorkflowEditor.tsx 加 customTools state 和拉取**

打开 `web/src/pages/workflow/WorkflowEditor.tsx`。

在 import 区（约第 41-49 行附近）加：

```typescript
import { customToolsApi, type CustomToolItem } from "../../api/workflow-defs";
import { Rocket } from "lucide-react";
```

注意 `Rocket` 加入到现有 lucide-react import 列表中（约第 19-35 行），而不是新建一行 import。

在 state 区（约第 113-118 行的 popover state 附近）加：

```typescript
const [customTools, setCustomTools] = useState<CustomToolItem[]>([]);
const [publishConfirmOpen, setPublishConfirmOpen] = useState(false);
```

在 useEffect 区（约第 273-275 行附近）加：

```typescript
// 拉取已注册的 custom 工具，供 palette 和节点配置下拉使用
// 失败时静默退化（palette 不显示 custom 分区），不阻塞编辑器
useEffect(() => {
  customToolsApi.list().then(setCustomTools).catch((err) => {
    console.error("Failed to load custom tools:", err);
  });
}, []);
```

- [ ] **Step 10.3: 在左侧 palette 加 custom 工具分区**

找到 palette 渲染区（约第 614-658 行的 `BASIC_PALETTE_ITEMS` 后），在 `wf-palette-divider` 与 `TRANSFORM_PRESETS` 之间插入 custom 工具分区。

当前结构是：

```tsx
{/* 基础节点 */}
{BASIC_PALETTE_ITEMS.map(...)}
{/* 分隔线 */}
<div className="wf-palette-divider" />
{/* 数据变换预设 */}
{TRANSFORM_PRESETS.map(...)}
```

改为：

```tsx
{/* 基础节点 */}
{BASIC_PALETTE_ITEMS.map(...)}
{/* 分隔线 */}
<div className="wf-palette-divider" />
{/* 自定义工具（仅当 registry 非空时显示） */}
{customTools.length > 0 && (
  <>
    <div className="wf-palette-group-title">{t("editor.palette_custom_tools")}</div>
    {customTools.map((tool) => (
      <button
        key={tool.name}
        type="button"
        className="wf-palette-btn"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/workflow-node", "custom");
          e.dataTransfer.setData("application/workflow-tool", tool.name);
          e.dataTransfer.effectAllowed = "move";
        }}
        onClick={() => addNode("custom", undefined, undefined, tool.name)}
        title={tool.description}
      >
        <span className="wf-palette-icon" style={{ background: "#8b5cf6" }}>
          <Boxes size={14} />
        </span>
        {tool.name}
      </button>
    ))}
    <div className="wf-palette-divider" />
  </>
)}
{/* 数据变换预设 */}
{TRANSFORM_PRESETS.map(...)}
```

注意：需要在文件顶部 lucide-react import 中加入 `Boxes` 图标。

- [ ] **Step 10.4: 在 NodeConfigPopover 调用处透传新 props**

找到 `<NodeConfigPopover ... />` 调用（约第 753-769 行），在 `onDeleteRequest={setDeleteConfirmNodeId}` 后追加：

```tsx
<NodeConfigPopover
  open={popoverOpen}
  onOpenChange={(open) => {
    setPopoverOpen(open);
    if (!open) setSelectedNode(null);
  }}
  selectedNode={selectedNode}
  sd={sd}
  nodeType={nodeType}
  readOnly={effectiveReadOnly}
  handleIdChange={handleIdChange}
  setNodes={setNodes}
  setSelectedNode={setSelectedNode}
  updateNodeData={updateNodeData}
  agentList={agentList}
  onDeleteRequest={setDeleteConfirmNodeId}
  meta={meta}
  updateMeta={updateMeta}
  customTools={customTools}
/>
```

- [ ] **Step 10.5: 验证 tsc 通过（修复 Task 7 留下的临时错误）**

```bash
bun run precheck 2>&1 | tail -20
```

预期：tsc 全部通过。如果 Boxes 报"未导入"，确认已加入 lucide-react import。

- [ ] **Step 10.6: 手动验证**

```bash
bun run dev:web
```

打开 workflow 编辑器：

1. 确认左侧 palette 有"自定义工具"分区（如果 registry 为空则不显示，正常）
2. 拖一个 custom 工具到画布，节点头应显示 tool 名
3. 点击节点，popover 中 tool 字段是 datalist，能下拉
4. 点击 start 节点，popover 显示 WorkflowMetaCard（不是 hint）
5. 在 params 表单中增删改参数

验证后 Ctrl+C 停止 dev server。

- [ ] **Step 10.7: 提交（合并 Task 7-10 的改动）**

```bash
git add web/src/pages/workflow/components/NodeConfigPopover.tsx web/src/pages/workflow/nodes.tsx web/src/pages/workflow/hooks/useWorkflowCanvas.ts web/src/api/workflow-defs.ts web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): 集成 custom 工具 palette + 节点头显示 tool 名

- 前端 API client 新增 customToolsApi.list() 和 CustomToolItem 类型
- WorkflowEditor mount 时拉取 custom tools，存入 state
- 左侧 palette 新增"自定义工具"分区（registry 非空时显示）
- custom 节点头主标题优先显示 tool 名（无 description 时）
- NodeConfigPopover 透传 meta/updateMeta/customTools 到 NodeConfigCard
- useWorkflowCanvas 的 addNode 支持 tool 参数，onDrop 适配

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 11: 右下角发布按钮 + ConfirmDialog

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

- [ ] **Step 11.1: 在 wf-bottom-actions 中插入发布按钮**

打开 `web/src/pages/workflow/WorkflowEditor.tsx`。找到 wf-bottom-actions 中的 VersionIndicator 和刷新按钮之间（约第 839-863 行）。

当前结构：

```tsx
<VersionIndicator ... />

{/* 刷新草稿 */}
{workflowId && (
  <button ...>
    <RefreshCw size={14} />
  </button>
)}
```

在 VersionIndicator 后、刷新按钮前插入发布按钮：

```tsx
<VersionIndicator ... />

{/* 发布按钮：复用 handlePublish，ConfirmDialog 二次确认 */}
{workflowId && (
  <button
    type="button"
    className="wf-meta-trigger-btn"
    disabled={!workflowId || publishing || effectiveReadOnly}
    title={t("editor.tooltip_publish")}
    onClick={() => setPublishConfirmOpen(true)}
    style={{
      width: 32,
      background: publishing ? "#d1d5db" : "#22c55e",
      color: "#fff",
      borderColor: publishing ? "#d1d5db" : "#22c55e",
    }}
  >
    <Rocket size={14} />
  </button>
)}

{/* 刷新草稿 */}
{workflowId && (
  <button ...>
    <RefreshCw size={14} />
  </button>
)}
```

注意：publishing 已从 useWorkflowPersistence 解构（约第 167 行）。effectiveReadOnly 已定义（约第 278 行）。

- [ ] **Step 11.2: 添加 ConfirmDialog（与删除确认同级）**

找到删除确认 ConfirmDialog（约第 909-923 行），在其后追加发布确认：

```tsx
<ConfirmDialog
  open={publishConfirmOpen}
  onOpenChange={setPublishConfirmOpen}
  title={t("editor.publish_confirm_title")}
  description={t("editor.publish_confirm_desc", {
    latest: wfData?.latestVersion ? `v${wfData.latestVersion}` : t("editor.no_published"),
  })}
  variant="default"
  onConfirm={async () => {
    setPublishConfirmOpen(false);
    await handlePublish();
  }}
/>
```

- [ ] **Step 11.3: 验证 tsc 通过**

```bash
bun run precheck 2>&1 | tail -10
```

预期：tsc 通过。

- [ ] **Step 11.4: 手动验证**

```bash
bun run dev:web
```

打开 workflow 编辑器：

1. 确认右下角 VersionIndicator 和刷新按钮之间有绿色发布按钮
2. 点击发布按钮 → 弹 ConfirmDialog
3. 点确认 → 调用 handlePublish → toast 显示"已发布为 vN"
4. 进入 previewVersion 模式，发布按钮应 disabled

验证后 Ctrl+C 停止 dev server。

- [ ] **Step 11.5: 提交**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "$(cat <<'EOF'
feat(workflow): 右下角新增一键发布按钮

位于 VersionIndicator 和刷新按钮之间，绿色醒目样式。
点击弹 ConfirmDialog 二次确认，复用现有 handlePublish（先存草稿再 createVersion）。
previewVersion / run 模式下按钮 disabled。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 12: 补 i18n keys（en + zh）

**Files:**
- Modify: `web/src/i18n/locales/en/workflows.json`
- Modify: `web/src/i18n/locales/zh/workflows.json`

- [ ] **Step 12.1: 在 en/workflows.json 加新 key**

打开 `web/src/i18n/locales/en/workflows.json`。在 `"editor": { ... }` 对象内（找一处合适位置，例如 `"type_loop"` 后），追加以下 key（保持 JSON 格式正确，注意逗号）：

```json
"outputs_title": "Outputs",
"outputs_add": "Add output",
"outputs_key_placeholder": "field name",
"outputs_pattern_placeholder": "path pattern (e.g. /tmp/out)",
"params_add": "Add parameter",
"params_name_placeholder": "param name",
"params_default_placeholder": "default value",
"params_default_label": "default",
"params_required_label": "required",
"custom_tool_placeholder": "Select or type tool name",
"workflow_settings": "Workflow Settings",
"palette_custom_tools": "Custom Tools",
"tooltip_publish": "Publish new version",
"publish_confirm_title": "Publish New Version",
"publish_confirm_desc": "A new version will be created from the current draft. Latest: {{latest}}. Continue?"
```

- [ ] **Step 12.2: 在 zh/workflows.json 加新 key**

打开 `web/src/i18n/locales/zh/workflows.json`。在 `"editor": { ... }` 对象内对应位置，追加：

```json
"outputs_title": "输出声明",
"outputs_add": "添加产出",
"outputs_key_placeholder": "字段名",
"outputs_pattern_placeholder": "路径模式（如 /tmp/out）",
"params_add": "添加参数",
"params_name_placeholder": "参数名",
"params_default_placeholder": "默认值",
"params_default_label": "默认",
"params_required_label": "必填",
"custom_tool_placeholder": "选择或输入工具名",
"workflow_settings": "工作流设置",
"palette_custom_tools": "自定义工具",
"tooltip_publish": "发布新版本",
"publish_confirm_title": "发布新版本",
"publish_confirm_desc": "将以当前草稿创建新版本，当前最新版本：{{latest}}。是否继续？"
```

- [ ] **Step 12.3: 验证 JSON 合法**

```bash
node -e "JSON.parse(require('fs').readFileSync('web/src/i18n/locales/en/workflows.json', 'utf8')); JSON.parse(require('fs').readFileSync('web/src/i18n/locales/zh/workflows.json', 'utf8')); console.log('OK')"
```

预期：输出 `OK`。如果报 `Unexpected token` 之类的错误，定位到对应文件检查逗号。

- [ ] **Step 12.4: 验证 precheck 通过**

```bash
bun run precheck 2>&1 | tail -10
```

预期：全部通过。

- [ ] **Step 12.5: 提交**

```bash
git add web/src/i18n/locales/en/workflows.json web/src/i18n/locales/zh/workflows.json
git commit -m "$(cat <<'EOF'
i18n(workflow): 补 outputs/params/custom/publish 相关 key

新增 15 个 i18n key（en + zh），覆盖 OutputsEditor、ParamsEditor、
custom 工具下拉、start 节点 popover 标题、palette custom 分区、
发布按钮 tooltip 和确认弹窗。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 13: 前端关键流程测试

**Files:**
- Create: `web/src/__tests__/workflow-params-outputs-flow.test.tsx`

参照 `web/src/__tests__/confirm-dialog.test.tsx`（ReactDOMServer 渲染不抛错 + 源码字符串检查）和 `web/src/__tests__/trigger-panel.test.tsx`（源码包含 i18n key）模式。项目**未安装** `@testing-library/react`，禁止引入；只用 `react-dom/server` + `fs.readFileSync` + `import.meta.dirname` 构建路径。覆盖：
- OutputsEditor / ParamsEditor 能在 i18n provider 下渲染不抛错
- 两个组件源码含关键 prop（onChange/keyPlaceholder/addLabel 等）
- NodeConfigCard 在 `isStartNode` 时源码引用 WorkflowMetaCard

- [ ] **Step 13.1: 创建测试文件**

新建 `web/src/__tests__/workflow-params-outputs-flow.test.tsx`：

```tsx
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import ReactDOMServer from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { OutputsEditor } from "../pages/workflow/components/OutputsEditor";
import { ParamsEditor } from "../pages/workflow/components/ParamsEditor";

// import.meta.dirname = web/src/__tests__
const webSrc = join(import.meta.dirname, "..");
const readSrc = (rel: string) => readFileSync(join(webSrc, rel), "utf-8");

// 用动态 import 避免 i18n 模块级副作用阻塞测试加载
const i18nPromise = import("../i18n");

describe("OutputsEditor", () => {
  // 组件导出是函数
  test("exports OutputsEditor as a function", () => {
    expect(typeof OutputsEditor).toBe("function");
  });

  // 在 i18n provider 下能渲染不抛错
  test("renders without throwing with minimal props", async () => {
    const { default: i18n } = await i18nPromise;
    expect(() => {
      ReactDOMServer.renderToString(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(OutputsEditor, {
            value: undefined,
            onChange: () => {},
            readOnly: false,
            keyPlaceholder: "key",
            patternPlaceholder: "pattern",
            addLabel: "Add",
          }),
        ),
      );
    }).not.toThrow();
  });

  // 已有 entry 也能渲染
  test("renders with existing value without throwing", async () => {
    const { default: i18n } = await i18nPromise;
    expect(() => {
      ReactDOMServer.renderToString(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(OutputsEditor, {
            value: { foo: { pattern: "/tmp/x", type: "file" } },
            onChange: () => {},
            readOnly: false,
            keyPlaceholder: "key",
            patternPlaceholder: "pattern",
            addLabel: "Add",
          }),
        ),
      );
    }).not.toThrow();
  });

  // 源码包含 onChange 调用与 add 按钮触发逻辑
  test("source wires onChange and add button", () => {
    const src = readSrc("pages/workflow/components/OutputsEditor.tsx");
    expect(src).toContain("onChange");
    expect(src).toContain("addLabel");
    expect(src).toContain("patternPlaceholder");
    // type 切换通过 select，至少应包含 type="file" / "dir" / "file-list" 之一
    expect(src).toMatch(/file-list|"file"|'file'/);
  });
});

describe("ParamsEditor", () => {
  // 组件导出是函数
  test("exports ParamsEditor as a function", () => {
    expect(typeof ParamsEditor).toBe("function");
  });

  // 在 i18n provider 下能渲染不抛错（无 default 值）
  test("renders without throwing with minimal props", async () => {
    const { default: i18n } = await i18nPromise;
    expect(() => {
      ReactDOMServer.renderToString(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ParamsEditor, {
            value: undefined,
            onChange: () => {},
            readOnly: false,
            namePlaceholder: "name",
            defaultPlaceholder: "default",
            addLabel: "Add",
          }),
        ),
      );
    }).not.toThrow();
  });

  // type=boolean 时 default 渲染为 checkbox，源码应含 "checkbox"
  test("source renders checkbox default for boolean type", () => {
    const src = readSrc("pages/workflow/components/ParamsEditor.tsx");
    expect(src).toContain('"checkbox"');
    // type=number 时 default 应切换为 number input
    expect(src).toMatch(/type.*number|"number"|'number'/);
  });

  // 源码用 t() 走 i18n
  test("source uses i18n via useTranslation", () => {
    const src = readSrc("pages/workflow/components/ParamsEditor.tsx");
    expect(src).toContain("useTranslation");
  });
});

describe("NodeConfigCard start node branch", () => {
  // start 节点点开应渲染 WorkflowMetaCard
  test("NodeConfigCard renders WorkflowMetaCard for start node", () => {
    const src = readSrc("pages/workflow/components/NodeConfigCard.tsx");
    expect(src).toContain("WorkflowMetaCard");
    expect(src).toMatch(/isStartNode|START_NODE_ID/);
  });
});
```

- [ ] **Step 13.2: 运行测试，确认通过**

```bash
bun test web/src/__tests__/workflow-params-outputs-flow.test.tsx
```

预期：9 个测试 PASS。

调试提示：
- 如果 i18n import 报错，确认 `web/src/i18n/index.ts` 默认导出 i18n 实例
- 如果 `OutputsEditor is not defined`，确认 Task 3 已完成（组件已导出）
- 如果 `ParamsEditor is not defined`，确认 Task 4 已完成（组件已导出）
- 源码字符串断言失败时，先读对应组件源码，按实际内容调整断言（例如 `type.*number` 写法可能因 biome format 调整为 `"number"` 单引号或双引号）

- [ ] **Step 13.3: 提交**

```bash
git add web/src/__tests__/workflow-params-outputs-flow.test.tsx
git commit -m "$(cat <<'EOF'
test(workflow): 补 OutputsEditor/ParamsEditor/NodeConfigCard 关键流程测试

覆盖：组件在 i18n provider 下渲染不抛错、源码含关键 prop 与分支
（OutputsEditor 的 onChange/addLabel、ParamsEditor 的 checkbox/number
default、NodeConfigCard 的 start 节点渲染 WorkflowMetaCard 分支）。
参照 confirm-dialog.test.tsx + trigger-panel.test.tsx 模式，
未引入 @testing-library/react（项目未安装）。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 14: 全量验证 + 最终回归

**Files:** 无修改，纯验证。

- [ ] **Step 14.1: 全量 precheck**

```bash
bun run precheck
```

预期：格式化 → import 排序 → tsc server + tsc web → biome check → 全部 PASS。

- [ ] **Step 14.2: 后端测试**

```bash
bun test src/__tests__/
```

预期：全部 PASS（包含 Task 2 新增的 workflow-custom-tools.test.ts）。

- [ ] **Step 14.3: 前端测试**

```bash
bun test web/src/__tests__/
```

预期：全部 PASS（包含 Task 13 新增的 workflow-params-outputs-flow.test.tsx）。

- [ ] **Step 14.4: workflow-engine 包测试**

```bash
cd packages/workflow-engine && bun test
```

预期：全部 PASS（包含 Task 1 新增的 shell+outputs 测试）。

- [ ] **Step 14.5: 手动验收（按 spec §5.5 验收清单）**

```bash
bun run dev:web
```

打开浏览器逐项核对：

- [ ] shell 节点编辑面板有 outputs 区块
- [ ] custom 节点编辑面板的 tool 字段是 datalist
- [ ] custom 节点头主标题显示 tool 名（无 description 时）
- [ ] 左侧 palette 在基础节点和 transform 预设之间有"自定义工具"分区
- [ ] 点击 start 节点 → popover 显示 name/description/timeout/params 表单/secrets
- [ ] params 表单每行有 name/type/default/required
- [ ] 右下角 VersionIndicator 和刷新按钮之间有绿色发布按钮
- [ ] 点发布按钮 → ConfirmDialog → 确认后调用 handlePublish + toast
- [ ] previewVersion / run 模式下发布按钮 disabled

验证后 Ctrl+C 停止 dev server。

- [ ] **Step 14.6: 最终状态确认**

```bash
git status && git log --oneline -15
```

预期：working tree clean，最近 15 条 commit 包含本次 9 个 commit（Task 1-13 提交）。

---

## Self-Review

**1. Spec coverage（对照 spec §1-§5 各节）**

| spec 节 | 覆盖 task |
|---------|-----------|
| §1.1-1.2 dag.ts + yaml-parser.ts schema 提升 | Task 1（Step 1.1-1.4） |
| §1.3 测试影响 | Task 1（Step 1.5-1.7） |
| §1.4 flowToYaml 兼容性 | 文档已说明，无需改代码（OutputsEditor 返回 undefined 而非 `{}` 已在 Step 3.1 实现） |
| §2.1-2.4 后端 API + 前端 client | Task 2（后端） + Task 10.1（前端 client） |
| §3.1 OutputsEditor | Task 3 |
| §3.2 ParamsEditor | Task 4 |
| §3.3 NodeConfigCard | Task 6 |
| §3.4 WorkflowMetaCard | Task 5 |
| §3.5 NodeConfigPopover | Task 7 |
| §3.6 i18n keys | Task 12 |
| §3.7 边界情况 | 已在各组件实现中处理（空对象返回 undefined、type 切换清空 default 等） |
| §4.1 nodes.tsx 主标题 | Task 8 |
| §4.2 WorkflowEditor palette | Task 10（Step 10.3） |
| §4.2.3-4.2.4 addNode + onDrop | Task 9 |
| §4.3 NodeConfigCard custom datalist | Task 6（Step 6.3） |
| §5.1 发布按钮 | Task 11 |
| §5.3 测试覆盖 | Task 1（yaml-parser）+ Task 2（routes）+ Task 13（前端） |

**所有 spec 节都有对应 task。无遗漏。**

**2. Placeholder scan**

- 无 TBD / TODO / "implement later"
- 无 "Add appropriate error handling"（所有错误处理都给了具体代码）
- 无 "Similar to Task N"（每个 task 的代码都完整展示）
- 所有 step 都有具体代码或具体命令

**3. Type consistency**

- `CustomToolItem` 在 Task 10.1 定义，在 Task 6.1 / Task 7.1 / Task 10.2 引用 ✓
- `OutputEntry` / `OutputType` 在 Task 3.1 定义，在 Task 6.1 / Task 6.3 / Task 6.4 引用 ✓
- `ParamEntry` / `ParamType` 在 Task 4.1 定义，无外部引用（仅 ParamsEditor 内部） ✓
- `customToolsApi` 在 Task 10.1 定义，在 Task 10.2 引用 ✓
- `addNode` 新签名（含 tool 参数）在 Task 9.1 定义，在 Task 9.2 / Task 9.3 / Task 10.3 引用 ✓
- `publishConfirmOpen` state 在 Task 10.2 定义，在 Task 11.1 / Task 11.2 引用 ✓

**类型一致性 OK。**

**4. 风险点提醒**

- Task 6 改动 NodeConfigCard.tsx 较多，建议实施时分 4 步逐步验证 tsc（每改完一个 type 分支就跑一次 precheck）
- Task 10 改动 WorkflowEditor.tsx 多处，建议 Step 10.5 一次 precheck 通过后再做手动验证
- Task 7 留下的临时 tsc 错误（NodeConfigPopover 调用方未传 props）会在 Task 10.4 修复，**不要在 Task 7 提交**

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-23-workflow-editor-ux.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每个 task 派发独立 subagent，task 间我做两阶段 review，迭代快、上下文干净

**2. Inline Execution** — 在当前会话用 executing-plans skill 批量执行，关键节点 checkpoint

**Which approach?**
