# Meta Agent 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在工作流编辑器右侧新增可折叠 Chat 侧边栏，通过 Meta Agent（复用现有 Agent 体系）让用户用自然语言编排工作流。

**Architecture:** Meta Agent 本质上是一个内置 AgentConfig（名为 `meta`），每个 user/team 按需创建一个 `meta-agent` Environment 并 spawn opencode 实例。Agent 通过一个专属 Skill 学习如何读写文件系统上的 `draft.yaml` 来操作工作流。前端复用现有 `ChatPanel` 组件，通过 ACP relay WebSocket 与 Agent 通信。

**Tech Stack:** Elysia (后端路由)、Drizzle ORM (数据库)、React + ReactFlow (前端)、ACP Relay WebSocket (通信)、opencode (Agent 引擎)、Skill Markdown (Agent 能力定义)

---

## 文件结构

### 后端新增/修改

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/services/config/agent-config.ts` | 修改 | `BUILT_IN_AGENTS` 集合添加 `"meta"` |
| `src/routes/web/meta-agent.ts` | 新增 | `POST /web/meta-agent/ensure` 路由 |
| `src/services/meta-agent.ts` | 新增 | 查找或创建 meta environment + spawn 实例的业务逻辑 |
| `src/services/config/skill-meta-content.ts` | 新增 | meta agent 专属 Skill 的 Markdown 内容常量 + 文件写入 |
| `src/index.ts` | 修改 | 挂载 meta-agent 路由 |
| `src/__tests__/meta-agent.test.ts` | 新增 | meta agent 服务层测试 |

### 前端新增/修改

| 文件 | 操作 | 职责 |
|------|------|------|
| `web/src/api/meta-agent.ts` | 新增 | `POST /web/meta-agent/ensure` 前端 API client |
| `web/src/pages/workflow/WorkflowEditor.tsx` | 修改 | 添加 Chat 侧边栏状态、工具栏按钮、Chat 面板渲染 |
| `web/src/pages/workflow/workflow-chat.tsx` | 新增 | 工作流专用 Chat 侧边栏组件（封装 ChatPanel + ensure + 刷新逻辑） |
| `web/src/pages/workflow/workflow.css` | 修改 | 添加 Chat 侧边栏布局样式 |

---

## Task 1: 后端 — 注册 `meta` 为内置 Agent

**Files:**
- Modify: `src/services/config/agent-config.ts:113`
- Test: `src/__tests__/config-agents.test.ts`（已有测试，验证不破坏）

- [ ] **Step 1: 修改 BUILT_IN_AGENTS 集合**

在 `src/services/config/agent-config.ts` 的 `BUILT_IN_AGENTS` 集合中添加 `"meta"`：

```typescript
const BUILT_IN_AGENTS = new Set(["build", "plan", "general", "explore", "title", "summary", "compaction", "meta"]);
```

- [ ] **Step 2: 运行现有测试确认不破坏**

Run: `bun test src/__tests__/config-agents.test.ts`
Expected: 所有测试通过

- [ ] **Step 3: Commit**

```bash
git add src/services/config/agent-config.ts
git commit -m "feat(meta-agent): 注册 meta 为内置 AgentConfig"
```

---

## Task 2: 后端 — 创建 meta agent 专属 Skill 内容

**Files:**
- Create: `src/services/config/skill-meta-content.ts`

- [ ] **Step 1: 创建 Skill Markdown 内容常量和文件写入函数**

创建 `src/services/config/skill-meta-content.ts`：

```typescript
/**
 * Meta Agent 专属 Skill 的 Markdown 内容和文件写入。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const META_SKILL_NAME = "workflow-editor";

export const META_SKILL_DESCRIPTION = "工作流编排助手 — 通过读写 draft.yaml 文件来操作工作流定义";

export const META_SKILL_MARKDOWN = `# workflow-editor

你是一个工作流编排助手。你的职责是帮助用户通过修改工作流 YAML 文件来编排 DAG 工作流。

## 工作流文件位置

当前用户正在编辑的工作流草稿文件路径会在会话开始时告诉你。文件格式为 YAML，存储在文件系统上。
路径格式为：\`~/.agents/workflows/{teamId}/{workflowId}/draft.yaml\`

## YAML 结构

工作流 YAML 文件结构如下：

\`\`\`yaml
schema_version: "1"          # 必填，固定为 "1"
name: "workflow-name"        # 必填
description: "..."           # 可选
timeout: 300                 # 可选，全局超时秒数
params:                      # 可选，参数定义
  param_name:
    type: string | number | boolean | object
    default: ...
    required: true | false
secrets:                     # 可选，密钥名列表
  - SECRET_NAME
nodes:                       # 必填，节点数组
  - id: "node_id"
    type: "shell | python | agent | api | audit | workflow | loop"
    depends_on: ["upstream_node_id"]  # 可选，省略或空数组 = 根节点
    # ... 各类型特有字段
\`\`\`

## 节点类型

### shell — 执行命令
\`\`\`yaml
- id: "shell_1"
  type: "shell"
  depends_on: []
  command: "echo hello"
  cwd: "/workspace"
\`\`\`

### python — 执行 Python 脚本
\`\`\`yaml
- id: "python_1"
  type: "python"
  depends_on: ["shell_1"]
  code: |
    import json
    print(json.dumps({"result": "ok"}))
  requirements: ["requests"]
  cwd: "/workspace"
\`\`\`

### agent — 调用 AI Agent
\`\`\`yaml
- id: "agent_1"
  type: "agent"
  depends_on: ["python_1"]
  prompt: "分析数据"
  agent: "general"
  skill: "optional-skill-name"
  model: "model-name"
  temperature: 0.7
  steps: 10
\`\`\`

### api — HTTP 请求
\`\`\`yaml
- id: "api_1"
  type: "api"
  depends_on: []
  url: "https://api.example.com/data"
  method: "GET"
  headers:
    Authorization: "Bearer token"
  body: '{"key": "value"}'
\`\`\`

### audit — 人工审批
\`\`\`yaml
- id: "audit_1"
  type: "audit"
  depends_on: []
  display_data:
    message: "请确认"
  expires_in: 3600
\`\`\`

## 操作指引

1. **读取文件**：先读取当前 draft.yaml 文件，了解现有结构
2. **修改文件**：根据用户需求修改 YAML 内容，直接写回 draft.yaml
3. **保持格式**：确保修改后的 YAML 格式正确、字段完整
4. **ID 规则**：新增节点的 id 格式建议为 \`{type}_{n}\`，n 为递增数字
5. **依赖关系**：修改 depends_on 时确保不产生循环依赖
6. **告知用户**：修改完成后，简要说明做了什么变更，提示用户刷新画布查看

## 注意事项

- 不要执行工作流，只负责编排和修改 YAML
- 不要删除 __start__ 节点
- 修改前先备份当前内容（可选）
- 如果用户需求不明确，主动询问细节
`;

/** Skill 文件在文件系统上的目录 */
export function getMetaSkillDir(): string {
  return join(homedir(), ".agents", "skills", "meta", META_SKILL_NAME);
}

/** 将 Skill Markdown 内容写入文件系统 */
export async function writeMetaSkillFile(): Promise<string> {
  const dir = getMetaSkillDir();
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "SKILL.md");
  await writeFile(filePath, META_SKILL_MARKDOWN, "utf-8");
  return filePath;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/config/skill-meta-content.ts
git commit -m "feat(meta-agent): 添加 meta agent 专属 Skill 内容定义和文件写入"
```

---

## Task 3: 后端 — 创建 meta-agent 服务层

**Files:**
- Create: `src/services/meta-agent.ts`
- Create: `src/__tests__/meta-agent.test.ts`

注意：`createWebEnvironment` 接受 `CreateWebEnvironmentParams` 对象参数，且 name 必须是 kebab-case 格式。所以 meta environment 的名称使用 `meta-agent`（而非 `__meta__`）。

- [ ] **Step 1: 编写测试**

创建 `src/__tests__/meta-agent.test.ts`：

```typescript
import { describe, expect, test, mock, beforeEach } from "bun:test";

const mockCreateWebEnvironment = mock<(params: any) => Promise<any>>();
const mockListEnvironmentsWithInstances = mock<(teamId: string) => Promise<any[]>>();
const mockSpawnInstanceFromEnvironment = mock<(userId: string, envId: string) => Promise<any>>();
const mockUpsertSkill = mock<(ctx: any, name: string, data: any) => Promise<string>>();
const mockGetAgentConfig = mock<(ctx: any, name: string) => Promise<any>>();
const mockCreateAgentConfig = mock<(ctx: any, name: string, data: any) => Promise<any>>();
const mockWriteMetaSkillFile = mock<() => Promise<string>>();

mock.module("../services/environment-web", () => ({
  createWebEnvironment: mockCreateWebEnvironment,
  listEnvironmentsWithInstances: mockListEnvironmentsWithInstances,
}));

mock.module("../services/instance", () => ({
  spawnInstanceFromEnvironment: mockSpawnInstanceFromEnvironment,
}));

mock.module("../services/config/skill", () => ({
  upsertSkill: mockUpsertSkill,
}));

mock.module("../services/config/agent-config", () => ({
  getAgentConfig: mockGetAgentConfig,
  createAgentConfig: mockCreateAgentConfig,
}));

mock.module("../services/config/skill-meta-content", () => ({
  META_SKILL_NAME: "workflow-editor",
  META_SKILL_DESCRIPTION: "test",
  writeMetaSkillFile: mockWriteMetaSkillFile,
}));

import {
  META_ENVIRONMENT_NAME,
  findMetaEnvironment,
  ensureMetaEnvironment,
} from "../services/meta-agent";

const testCtx = {
  teamId: "team-001",
  userId: "user-001",
  role: "owner" as const,
};

beforeEach(() => {
  mockCreateWebEnvironment.mockReset();
  mockListEnvironmentsWithInstances.mockReset();
  mockSpawnInstanceFromEnvironment.mockReset();
  mockUpsertSkill.mockReset();
  mockGetAgentConfig.mockReset();
  mockCreateAgentConfig.mockReset();
  mockWriteMetaSkillFile.mockReset().mockResolvedValue("/tmp/SKILL.md");
});

// 常量校验
test("META_ENVIRONMENT_NAME 为 meta-agent（kebab-case）", () => {
  expect(META_ENVIRONMENT_NAME).toBe("meta-agent");
});

// findMetaEnvironment
describe("findMetaEnvironment", () => {
  test("从环境列表中找到 name=meta-agent 的环境", async () => {
    mockListEnvironmentsWithInstances.mockResolvedValueOnce([
      { id: "env-1", name: "my-agent" },
      { id: "env-meta-1", name: "meta-agent" },
      { id: "env-2", name: "another" },
    ]);
    const result = await findMetaEnvironment(testCtx);
    expect(result).toEqual({ id: "env-meta-1", name: "meta-agent" });
  });

  test("列表中不存在 meta-agent 时返回 null", async () => {
    mockListEnvironmentsWithInstances.mockResolvedValueOnce([
      { id: "env-1", name: "my-agent" },
    ]);
    const result = await findMetaEnvironment(testCtx);
    expect(result).toBeNull();
  });
});

// ensureMetaEnvironment
describe("ensureMetaEnvironment", () => {
  test("已存在 meta 环境时直接返回，不重复创建", async () => {
    mockListEnvironmentsWithInstances.mockResolvedValueOnce([
      { id: "env-meta-1", name: "meta-agent" },
    ]);
    mockGetAgentConfig.mockResolvedValueOnce({ id: "ac-meta" });
    mockUpsertSkill.mockResolvedValueOnce("skill-1");
    mockSpawnInstanceFromEnvironment.mockResolvedValueOnce({ id: "inst-1", status: "running" });

    const result = await ensureMetaEnvironment(testCtx);
    expect(result.environmentId).toBe("env-meta-1");
    expect(result.status).toBe("reused");
    expect(mockCreateWebEnvironment).not.toHaveBeenCalled();
  });

  test("不存在 meta 环境时创建并返回", async () => {
    mockListEnvironmentsWithInstances.mockResolvedValueOnce([]);
    mockGetAgentConfig.mockResolvedValueOnce({ id: "ac-meta" });
    mockCreateWebEnvironment.mockResolvedValueOnce({ id: "env-new-meta", name: "meta-agent" });
    mockSpawnInstanceFromEnvironment.mockResolvedValueOnce({ id: "inst-1", status: "running" });
    mockUpsertSkill.mockResolvedValueOnce("skill-1");

    const result = await ensureMetaEnvironment(testCtx);
    expect(result.environmentId).toBe("env-new-meta");
    expect(result.status).toBe("created");
    expect(mockCreateWebEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ name: "meta-agent" }),
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/__tests__/meta-agent.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 meta-agent 服务层**

创建 `src/services/meta-agent.ts`：

```typescript
/**
 * Meta Agent 服务层。
 *
 * 管理 meta agent 的 Environment 生命周期：
 * - 查找或创建名为 meta-agent 的 Environment（kebab-case，通过校验）
 * - 确保 meta AgentConfig 存在
 * - 确保 meta 专属 Skill 已注册并写入文件系统
 * - 按需 spawn 实例
 */

import { createWebEnvironment, listEnvironmentsWithInstances } from "./environment-web";
import { spawnInstanceFromEnvironment } from "./instance";
import { upsertSkill } from "./config/skill";
import { getAgentConfig, createAgentConfig } from "./config/agent-config";
import type { AuthContext } from "../plugins/auth";
import {
  META_SKILL_NAME,
  META_SKILL_DESCRIPTION,
  writeMetaSkillFile,
} from "./config/skill-meta-content";

export const META_ENVIRONMENT_NAME = "meta-agent";
const META_AGENT_CONFIG_NAME = "meta";

export interface EnsureMetaResult {
  environmentId: string;
  instanceId?: string;
  status: "created" | "reused";
}

/** 从环境列表中查找名为 meta-agent 的环境 */
export async function findMetaEnvironment(
  ctx: AuthContext,
): Promise<{ id: string; name: string } | null> {
  const envs = await listEnvironmentsWithInstances(ctx.teamId);
  const meta = envs.find((e: any) => e.name === META_ENVIRONMENT_NAME);
  return meta ? { id: meta.id, name: meta.name } : null;
}

/** 确保环境中存在 meta agent 所需的 AgentConfig 和 Skill */
async function ensureMetaConfig(ctx: AuthContext): Promise<string> {
  // 确保 AgentConfig 存在
  let agentConfig = await getAgentConfig(ctx, META_AGENT_CONFIG_NAME);
  if (!agentConfig) {
    agentConfig = await createAgentConfig(ctx, META_AGENT_CONFIG_NAME, {
      description: "Meta Agent — 工作流编排助手",
      model: null,
      prompt: null,
      steps: null,
    });
  }

  // 将 Skill Markdown 写入文件系统
  await writeMetaSkillFile();

  // 在数据库中注册 Skill
  await upsertSkill(ctx, META_SKILL_NAME, {
    description: META_SKILL_DESCRIPTION,
    contentPath: `meta/${META_SKILL_NAME}/SKILL.md`,
    enabled: true,
    agentConfigId: agentConfig.id,
  });

  return agentConfig.id;
}

/** 查找或创建 meta environment + spawn 实例 */
export async function ensureMetaEnvironment(ctx: AuthContext): Promise<EnsureMetaResult> {
  const agentConfigId = await ensureMetaConfig(ctx);

  // 查找已有 meta environment
  const existing = await findMetaEnvironment(ctx);
  if (existing) {
    try {
      const inst = await spawnInstanceFromEnvironment(ctx.userId, existing.id);
      return {
        environmentId: existing.id,
        instanceId: inst.id,
        status: "reused",
      };
    } catch {
      return {
        environmentId: existing.id,
        status: "reused",
      };
    }
  }

  // 创建新的 meta environment（name 为 kebab-case，通过校验）
  const env = await createWebEnvironment({
    name: META_ENVIRONMENT_NAME,
    description: "Meta Agent — 工作流编排助手（自动创建）",
    agentConfigId,
    workspacePath: process.env.HOME ?? "/tmp",
    userId: ctx.userId,
    teamId: ctx.teamId,
  });

  try {
    const inst = await spawnInstanceFromEnvironment(ctx.userId, env.id);
    return {
      environmentId: env.id,
      instanceId: inst.id,
      status: "created",
    };
  } catch {
    return {
      environmentId: env.id,
      status: "created",
    };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/__tests__/meta-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/meta-agent.ts src/__tests__/meta-agent.test.ts
git commit -m "feat(meta-agent): 实现 meta-agent 服务层（查找/创建/spawn）"
```

---

## Task 4: 后端 — 创建 meta-agent 路由

**Files:**
- Create: `src/routes/web/meta-agent.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 创建 meta-agent 路由**

创建 `src/routes/web/meta-agent.ts`：

```typescript
/**
 * Meta Agent API 路由。
 *
 * POST /web/meta-agent/ensure — 查找或创建 meta environment + spawn 实例
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { loadTeamContext } from "../../services/team-context";
import { ensureMetaEnvironment } from "../../services/meta-agent";

const app = new Elysia({ name: "web-meta-agent", prefix: "/web" }).use(authGuardPlugin);

app.post(
  "/meta-agent/ensure",
  async ({ store, request, error }: any) => {
    const user = store.user!;
    const authCtx = await loadTeamContext(user, request);
    if (!authCtx) {
      return error(401, { error: { type: "UNAUTHORIZED", message: "No team context" } });
    }

    try {
      const result = await ensureMetaEnvironment(authCtx);
      return { success: true, data: result };
    } catch (err: unknown) {
      console.error("[meta-agent] ensure failed:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(500, { error: { type: "INTERNAL_ERROR", message } });
    }
  },
  { sessionAuth: true },
);

export default app;
```

- [ ] **Step 2: 在 src/index.ts 中挂载路由**

在 `src/index.ts` 中找到其他 web 路由的挂载位置（搜索 `webWorkflowDefs` 或类似 import），添加 meta-agent 路由：

```typescript
import metaAgentRoute from "./routes/web/meta-agent";
// ...
.use(metaAgentRoute)
```

- [ ] **Step 3: 运行类型检查**

Run: `bun run typecheck`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/meta-agent.ts src/index.ts
git commit -m "feat(meta-agent): 添加 POST /web/meta-agent/ensure 路由"
```

---

## Task 5: 前端 — 创建 meta-agent API client

**Files:**
- Create: `web/src/api/meta-agent.ts`

- [ ] **Step 1: 创建 API client**

创建 `web/src/api/meta-agent.ts`：

```typescript
/**
 * Meta Agent API Client。
 *
 * 对接后端 POST /web/meta-agent/ensure。
 */

export interface EnsureMetaResult {
  environmentId: string;
  instanceId?: string;
  status: "created" | "reused";
}

export async function ensureMetaAgent(): Promise<EnsureMetaResult> {
  const res = await fetch("/web/meta-agent/ensure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });

  const json = await res.json();

  if (!res.ok) {
    const errInfo = json.error ?? { message: res.statusText };
    throw new Error(errInfo.message ?? errInfo.type ?? `请求失败 (${res.status})`);
  }

  return json.data as EnsureMetaResult;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/api/meta-agent.ts
git commit -m "feat(meta-agent): 添加前端 meta-agent API client"
```

---

## Task 6: 前端 — 创建 WorkflowChat 侧边栏组件（完整版）

**Files:**
- Create: `web/src/pages/workflow/workflow-chat.tsx`

这个组件直接写最终版本，包含 ensure 逻辑、ChatPanel 渲染、以及 Agent 回复后的刷新回调。

- [ ] **Step 1: 创建 WorkflowChat 组件**

创建 `web/src/pages/workflow/workflow-chat.tsx`：

```typescript
import { Bot, Loader2, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { ChatPanel } from "../agent-panel/ChatPanel";
import { ensureMetaAgent } from "../../api/meta-agent";

interface WorkflowChatProps {
  /** 当前工作流 ID */
  workflowId: string;
  /** 关闭 Chat 面板回调 */
  onClose: () => void;
  /** Agent 回复后调用，前端拉取最新 YAML 刷新画布 */
  onRefreshNeeded?: () => void;
}

export function WorkflowChat({ workflowId, onClose, onRefreshNeeded }: WorkflowChatProps) {
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 确保 meta agent 实例存在
  useEffect(() => {
    let abort = false;
    (async () => {
      try {
        const result = await ensureMetaAgent();
        if (abort) return;
        setEnvironmentId(result.environmentId);
      } catch (err) {
        if (abort) return;
        console.error(err);
        setError((err as Error).message);
      } finally {
        if (!abort) setLoading(false);
      }
    })();
    return () => { abort = true; };
  }, []);

  return (
    <div className="wf-chat-sidebar">
      {/* 头部 */}
      <div className="wf-chat-header">
        <span className="wf-chat-title">
          <Bot size={14} />
          Meta Agent
        </span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {onRefreshNeeded && (
            <button
              type="button"
              className="wf-chat-close-btn"
              onClick={onRefreshNeeded}
              title="手动刷新工作流画布"
            >
              <RefreshCw size={13} />
            </button>
          )}
          <button
            type="button"
            className="wf-chat-close-btn"
            onClick={onClose}
            title="收起 Chat 面板"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* 工作流上下文提示 */}
      {workflowId && (
        <div className="wf-chat-context">
          工作流: {workflowId.slice(0, 8)}...
        </div>
      )}

      {/* 主体 */}
      <div className="wf-chat-body">
        {loading && (
          <div className="wf-chat-loading">
            <Loader2 size={20} className="animate-spin" />
            <p>正在启动 Meta Agent...</p>
          </div>
        )}
        {error && (
          <div className="wf-chat-error">
            <p>启动失败: {error}</p>
            <button type="button" onClick={() => window.location.reload()}>
              重试
            </button>
          </div>
        )}
        {environmentId && !loading && (
          <ChatPanel agentId={environmentId} />
        )}
      </div>
    </div>
  );
}
```

设计说明：
- 提供手动刷新按钮（`RefreshCw` 图标），用户点击后调用 `onRefreshNeeded` 拉取最新 YAML
- 暂不实现自动监听 Agent 回复（ACP client 的消息回调机制需要更深入了解 ACPMain 内部实现），先用手动刷新 + Agent 在回复中提示"请点击刷新"的方式
- 后续可以增强为自动检测 assistant 消息后触发刷新

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/workflow-chat.tsx
git commit -m "feat(meta-agent): 创建 WorkflowChat 侧边栏组件（含手动刷新）"
```

---

## Task 7: 前端 — 集成到 WorkflowEditor

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`
- Modify: `web/src/pages/workflow/workflow.css`

这是最关键的改动——在 WorkflowEditor 中添加 Chat 侧边栏的状态管理、工具栏按钮和面板渲染。

- [ ] **Step 1: 添加 CSS 样式**

在 `web/src/pages/workflow/workflow.css` 末尾添加：

```css
/* ── Meta Agent Chat 侧边栏 ── */

.wf-chat-sidebar {
  width: 340px;
  min-width: 340px;
  display: flex;
  flex-direction: column;
  background: #1e293b;
  border-left: 2px solid #3b82f6;
  height: 100%;
  overflow: hidden;
}

.wf-chat-header {
  padding: 8px 12px;
  border-bottom: 1px solid #334155;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: white;
}

.wf-chat-title {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

.wf-chat-close-btn {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}
.wf-chat-close-btn:hover {
  background: #334155;
  color: white;
}

.wf-chat-context {
  padding: 4px 12px;
  background: #1e3a5f;
  font-size: 11px;
  color: #60a5fa;
  border-bottom: 1px solid #334155;
}

.wf-chat-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.wf-chat-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #94a3b8;
  gap: 8px;
  font-size: 13px;
}

.wf-chat-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #f87171;
  gap: 8px;
  font-size: 13px;
  padding: 16px;
  text-align: center;
}
.wf-chat-error button {
  background: #3b82f6;
  color: white;
  border: none;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.wf-chat-error button:hover {
  background: #2563eb;
}

/* Chat 面板内的 ACPMain 暗色适配 */
.wf-chat-sidebar .agent-welcome-empty {
  color: #94a3b8;
}
```

- [ ] **Step 2: 修改 WorkflowEditor 组件**

在 `web/src/pages/workflow/WorkflowEditor.tsx` 中做以下修改：

**2a. 添加 import**（文件顶部 import 区域）：

```typescript
import { MessageSquare } from "lucide-react";
import { WorkflowChat } from "./workflow-chat";
```

**2b. 添加状态变量**（在 `WorkflowEditorInner` 函数的 state 声明区域，约 L95-118 附近）：

```typescript
const [chatOpen, setChatOpen] = useState(() => {
  const saved = localStorage.getItem("wf-editor:chat-open");
  return saved === "true";
});
```

**2c. 持久化 chatOpen 状态**（state 声明后添加 effect）：

```typescript
useEffect(() => {
  localStorage.setItem("wf-editor:chat-open", String(chatOpen));
}, [chatOpen]);
```

**2d. 添加工具栏按钮**（在 `<Panel position="top-center">` 内，最后一个 `<div className="wf-toolbar-divider" />` 之后、历史运行 `<List>` 按钮之前插入）：

```typescript
<button
  type="button"
  className={`wf-toolbar-btn ${chatOpen ? "active" : ""}`}
  onClick={() => setChatOpen(!chatOpen)}
  data-tooltip="打开 / 关闭 Meta Agent Chat 助手"
>
  <MessageSquare size={15} />
</button>
```

**2e. 在外层 flex 容器中添加 Chat 面板**（找到 `</ReactFlow>` 闭合标签之后、外层容器 `</div>` 之前，添加）：

```tsx
{chatOpen && workflowId && (
  <WorkflowChat
    workflowId={workflowId}
    onClose={() => setChatOpen(false)}
    onRefreshNeeded={async () => {
      try {
        const wf = await workflowDefApi.get(workflowId);
        if (wf.draftYaml && wf.draftYaml !== lastSavedYaml) {
          const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(wf.draftYaml);
          setNodes(newNodes);
          setEdges(newEdges);
          setMeta(newMeta);
          setLastSavedYaml(wf.draftYaml);
          setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
        }
      } catch (err) {
        console.error("刷新工作流失败:", err);
      }
    }}
  />
)}
```

确保外层容器是 `display: flex`，ReactFlow 区域是 `flex: 1`，这样 Chat 面板展开时 ReactFlow 自动缩窄。

- [ ] **Step 3: 构建前端验证**

Run: `bun run build:web`
Expected: 构建成功，无类型错误

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx web/src/pages/workflow/workflow.css
git commit -m "feat(meta-agent): 工作流编辑器右侧 Chat 侧边栏集成 + 刷新画布"
```

---

## Task 8: 最终集成测试与 lint

**Files:** 无新增

- [ ] **Step 1: 运行后端测试**

Run: `bun test src/__tests__/meta-agent.test.ts`
Expected: PASS

- [ ] **Step 2: 运行类型检查**

Run: `bun run typecheck`
Expected: 无错误

- [ ] **Step 3: 运行 lint**

Run: `bun run lint`
Expected: 无错误（如有格式问题运行 `bun run format`）

- [ ] **Step 4: 构建前端**

Run: `bun run build:web`
Expected: 构建成功

- [ ] **Step 5: 最终 commit（如有 lint 修复）**

```bash
git add -A
git commit -m "chore: meta-agent 集成测试与 lint 修复"
```
