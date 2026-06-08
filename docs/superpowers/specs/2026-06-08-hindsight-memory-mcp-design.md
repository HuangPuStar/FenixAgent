# Agent 记忆 MCP（Hindsight）设计

## 概述

在 Agent 创建/编辑流程中增加「智能体记忆」勾选框，勾选后后端自动创建 Hindsight MCP server 条目（写入 mcpServer 表）并调用 Hindsight Bank API 确保 bank 存在。

## 前置条件

- Hindsight 服务通过 Docker Compose 部署，提供 MCP 端点和 Bank 管理 API
- 环境变量 `HINDSIGHT_MCP_URL` 配置了 Hindsight 服务完整 URL（如 `http://localhost:8888`）
- 未配置时整个功能不出现

## 数据流

```
前端打开对话框 → GET /web/hindsight/status → { enabled }
  ↓
创建/编辑 Agent → 勾选「智能体记忆」
  ↓
前端提交 enableMemory: true 标记随 Agent payload
  ↓
POST /web/config/agents { action: "create"|"set", data: { ..., enableMemory: true } }
  ↓
后端 handleCreate/handleSet → 检测 data.enableMemory → ensureHindsightMcpServer()
  → 查 member 表获取 member ID
  → 写入 mcpServer 表（name: "hindsight", type: "remote", url: "{HINDSIGHT_URL}/mcp/{memberId}"）
  → PUT Hindsight API 确保 bank 存在
  ↓
完成（bank 创建失败仅 warning，不阻断 Agent 创建）
```

## 后端变更

### 1. 环境变量（`src/env.ts`）

新增可选环境变量：

```typescript
HINDSIGHT_MCP_URL: z.string().optional(),
```

### 2. Hindsight 服务（`src/services/hindsight.ts`）

核心函数：

- **`getHindsightConfig()`**：读取 `HINDSIGHT_MCP_URL` 环境变量，未配置返回 null
- **`ensureBank(bankId)`**：调用 Hindsight API `PUT /v1/default/banks/{bankId}`，幂等创建 bank
- **`ensureHindsightMcpServer(ctx)`**：组合操作——查 member 表获取 member ID → 写入 mcpServer 表 → 调 ensureBank

关键实现细节：

```typescript
// 从 member 表查询 (organizationId, userId) 获取 member ID 作为 bank ID
async function resolveMemberId(ctx: AuthContext): Promise<string | null> {
  const rows = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, ctx.organizationId), eq(member.userId, ctx.userId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

// 写入 mcpServer 表（onConflictDoUpdate，幂等）
await configPg.createMcpServer(ctx, "hindsight", "remote", {
  type: "remote",
  url: `${config.url}/mcp/${memberId}`,
});
```

### 3. 状态端点（`src/routes/web/hindsight.ts`）

遵循 `branding.ts` 模式：无认证、轻量级。

```typescript
GET /web/hindsight/status → { success: true, data: { enabled: true, url: "..." } }
                        或 → { success: true, data: { enabled: false } }
```

注册到 `src/routes/web/index.ts`。

### 4. Agent 创建/更新拦截（`src/routes/web/config/agents.ts`）

在 `handleCreate` 和 `handleSet` 末尾，检查 `data.enableMemory` 标记：

```typescript
import { ensureHindsightMcpServer } from "../../../services/hindsight";

// 在 configPg 操作成功后：
if (data.enableMemory === true) {
  const result = await ensureHindsightMcpServer(ctx);
  if (!result.ok) {
    console.warn(`[hindsight] Failed for agent '${name}': ${result.error}`);
  }
}
```

注意：`enableMemory` 不在 `AGENT_SETTABLE_FIELDS` 白名单中，通过原始 `data` 参数访问（白名单过滤前），不写入 agentConfig 表。MCP 配置通过 `mcpServer` 表独立存储。

## 前端变更

### 1. 获取 Hindsight 状态

`AgentFormDialog` 通过 `fetch("/web/hindsight/status")` 获取可用性，仅当 `enabled: true` 时显示勾选框。

### 2. 新增勾选框

在 basic tab Skills 绑定区块下方，条件渲染 Switch 组件：

- `hindsightEnabled` 控制可见性
- `formEnableMemory` 控制勾选状态
- `formEnableMemory` 必须加入 `handleSave` 的 `useCallback` deps（否则闭包捕获初始值）

### 3. 提交逻辑

`handleSave` 中通过 `...(formEnableMemory ? { enableMemory: true } : {})` 将标记附加到 payload。

### 4. 编辑回显

编辑模式下加载 Agent 数据后，调用 `mcpApi.list()` 检查是否已有名称含 `hindsight` 的 MCP server。注意 `mcpApi.list()` 返回 `{ servers: [...] }` 不是裸数组，需要兼容解析：

```typescript
const raw = mcpResult.data;
const servers = Array.isArray(raw) ? raw : ((raw as Record<string, unknown>)?.servers ?? []);
const hasHindsight = servers.some((s) => s.name.toLowerCase().includes("hindsight"));
setFormEnableMemory(hasHindsight);
```

### 5. i18n 翻译

| 语言 | 标题 | 描述 |
|------|------|------|
| EN | Agent Memory | Enable agent memory across conversations |
| ZH | 智能体记忆 | 启用跨会话记忆能力 |

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/env.ts` | 修改 | 新增 `HINDSIGHT_MCP_URL` 可选环境变量 |
| `src/services/hindsight.ts` | 新建 | getHindsightConfig + ensureBank + resolveMemberId + ensureHindsightMcpServer |
| `src/routes/web/hindsight.ts` | 新建 | `GET /web/hindsight/status` 端点 |
| `src/routes/web/index.ts` | 修改 | 注册 hindsight 路由 |
| `src/routes/web/config/agents.ts` | 修改 | handleCreate/handleSet 中检测 enableMemory 标记 |
| `web/src/pages/agent-panel/AgentFormDialog.tsx` | 修改 | 新增勾选框 + enableMemory 标记 + 编辑回显 |
| `web/src/i18n/locales/en/agents.json` | 修改 | 新增 memory 翻译 |
| `web/src/i18n/locales/zh/agents.json` | 修改 | 新增 memory 翻译 |

## 踩坑记录

1. **useCallback deps 遗漏**：`formEnableMemory` 必须加入 `handleSave` 的依赖数组，否则闭包捕获初始值 `false`，导致 `enableMemory` 永远不会传到后端
2. **mcpApi.list 返回结构**：返回 `{ servers: [...] }` 而非裸数组，需要 `Array.isArray` 兼容解析
3. **MCP 写入 mcpServer 表**：不能只传 MCP 配置在 payload 里（会被 AGENT_SETTABLE_FIELDS 白名单过滤），必须由后端直接操作 mcpServer 表
4. **编辑回显异步时序**：`hindsightEnabled` 的 fetch 和 edit 的 `Promise.all` 是并行的，回显检查不能依赖 `hindsightEnabled` state
