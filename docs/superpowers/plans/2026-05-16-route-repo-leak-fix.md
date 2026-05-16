# Routes 直访 Repository 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 ACP 和 MCP 路由中直接调用 `environmentRepo.getBySecret()` 的认证逻辑，改为通过 Service 层访问。

**Architecture:** ADR-0001 要求 Route 通过 Service 访问 Repository。当前 `routes/acp/index.ts` 和 `routes/mcp/knowledge.ts` 绕过 Service 直接查 repo 做认证。在 `environment.ts` 中暴露 `getEnvironmentBySecret()` 方法封装认证逻辑。

**Tech Stack:** TypeScript, Elysia

---

### Task 1: 在 environment service 中添加 getBySecret

**Files:**
- Modify: `src/services/environment.ts`

- [ ] **Step 1: 添加 `getEnvironmentBySecret` 函数**

在 environment service 中添加：

```typescript
export async function getEnvironmentBySecret(secret: string): Promise<{ id: string; userId: string | null; agentName: string | null; secret: string } | null> {
  const env = await environmentRepo.getBySecret(secret);
  if (!env) return null;
  return {
    id: env.id,
    userId: env.userId,
    agentName: env.agentName,
    secret: env.secret,
  };
}
```

返回值只暴露认证所需的字段，不返回完整 record。

- [ ] **Step 2: Commit**

```bash
git add src/services/environment.ts
git commit -m "refactor: environment service 添加 getEnvironmentBySecret 方法"
```

### Task 2: 迁移 ACP 路由

**Files:**
- Modify: `src/routes/acp/index.ts`

- [ ] **Step 1: 更新 `resolveTokenAuth` 函数**

将 `resolveTokenAuth` 中的直接 repo 调用：
```typescript
const { environmentRepo } = await import("../../repositories");
const envRecord = await environmentRepo.getBySecret(token);
```

替换为 service 调用：
```typescript
const { getEnvironmentBySecret } = await import("../../services/environment");
const envRecord = await getEnvironmentBySecret(token);
```

- [ ] **Step 2: 更新返回值字段**

`resolveTokenAuth` 返回 `{ userId, envId }`。`getEnvironmentBySecret` 返回 `{ id, userId, agentName, secret }`，适配字段名 `id` → `envId`。

- [ ] **Step 3: 移除 `environmentRepo` import**

从 `import { environmentRepo } from "../../repositories"` 中移除 `environmentRepo`（如果该路由其他地方仍需要则保留）。

检查文件中其他 `environmentRepo` 引用（`listAcpAgentsByUserId`、`getById` 等）——这些是路由层的业务查询，如果还在使用则保留 import。

- [ ] **Step 4: 运行 typecheck**

Run: `bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/routes/acp/index.ts
git commit -m "refactor: ACP 路由认证改用 environment service，消除 repo 直访"
```

### Task 3: 迁移 MCP Knowledge 路由

**Files:**
- Modify: `src/routes/mcp/knowledge.ts`

- [ ] **Step 1: 更新 MCP 路由的认证逻辑**

将 `environmentRepo.getBySecret(token)` 替换为 `getEnvironmentBySecret(token)`。

- [ ] **Step 2: 适配 `createKnowledgeMcpServer` 的参数**

当前签名：
```typescript
function createKnowledgeMcpServer(environment: { agentName: string | null; userId: string | null; secret: string })
```

`getEnvironmentBySecret` 返回的类型已包含这些字段，直接传入即可。

- [ ] **Step 3: 移除 `environmentRepo` import**

- [ ] **Step 4: 运行 typecheck**

Run: `bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/routes/mcp/knowledge.ts
git commit -m "refactor: MCP knowledge 路由认证改用 environment service，消除 repo 直访"
```
