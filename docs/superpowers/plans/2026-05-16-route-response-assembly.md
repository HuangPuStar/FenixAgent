# 路由层响应组装下沉到 Service — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将路由层中散落的数据转换和响应组装逻辑（"查询 N 个实体 + 关联 M 个子实体 + 映射字段"模式）下沉到 Service 层的视图函数中，使路由处理器只做 `{ return serviceResult; }`。

**Architecture:** 为每个需要复杂响应组装的端点创建对应的 Service 视图函数。这些函数负责：查询主实体、关联子实体、映射为 API 响应格式。路由处理器只解析 HTTP 参数、调用 Service、返回结果。

**Tech Stack:** TypeScript、Elysia

---

## 受影响文件总览

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/services/environment.ts` | 修改 | 新增 `listEnvironmentsWithInstances`（已在计划 #1 中定义） |
| `src/routes/web/environments.ts` | 修改 | GET /environments 简化为调用 Service |
| `src/routes/v1/environments.ts` | 修改 | POST /bridge 响应构建已在计划 #1 的 registerBridge 中处理 |
| `src/routes/web/instances.ts` | 修改 | 列表端点响应组装下沉 |

**注意**：`listEnvironmentsWithInstances` 和 `registerBridge` 已在计划 `2026-05-16-route-repo-bypass.md` 的 Task 2 和 Task 1 中定义。本计划聚焦于**剩余的**响应组装点。

---

### Task 1: web/environments — enter 端点响应组装下沉

**Files:**
- Modify: `src/services/instance.ts`
- Modify: `src/routes/web/environments.ts`

当前 `web/environments.ts` 第 110-143 行的 `POST /environments/:id/enter` 在路由中做了实例查找/创建 + 响应映射：

```typescript
const runningInstances = getRunningInstancesByEnvironment(params.id);
inst = runningInstances.find((i) => i.instanceNumber === b.instance_number);
// ... 错误处理
return {
  session_id: inst.sessionId ?? null,
  instance_id: inst.id,
  instance_number: inst.instanceNumber,
  instance_status: inst.status,
  environment_id: params.id,
};
```

- [ ] **Step 1: 在 instance.ts 中新增 `enterEnvironment` 函数**

在 `src/services/instance.ts` 末尾添加：

```typescript
export interface EnterEnvironmentResult {
  session_id: string | null;
  instance_id: string;
  instance_number: number;
  instance_status: string;
  environment_id: string;
}

/**
 * 进入环境：查找指定实例或确保有运行中的实例。
 * 返回标准化的 API 响应格式。
 */
export async function enterEnvironment(
  userId: string,
  environmentId: string,
  instanceNumber?: number,
): Promise<EnterEnvironmentResult> {
  let inst: SpawnedInstance | undefined;

  if (instanceNumber !== undefined) {
    const runningInstances = getRunningInstancesByEnvironment(environmentId);
    inst = runningInstances.find((i) => i.instanceNumber === instanceNumber);
    if (!inst) {
      throw Object.assign(
        new Error(`实例 ${instanceNumber} 不存在或未运行`),
        { code: "NOT_FOUND" },
      );
    }
  } else {
    const result = await ensureRunning(userId, environmentId);
    inst = result.instance;
  }

  if (!inst) {
    throw Object.assign(
      new Error("无法创建实例"),
      { code: "INTERNAL_ERROR" },
    );
  }

  return {
    session_id: inst.sessionId ?? null,
    instance_id: inst.id,
    instance_number: inst.instanceNumber,
    instance_status: inst.status,
    environment_id: environmentId,
  };
}
```

- [ ] **Step 2: 简化 web/environments.ts 的 enter 端点**

将第 110-143 行替换为：

```typescript
/** POST /web/environments/:id/enter — Enter an environment */
app.post("/environments/:id/enter", async ({ store, params, body, error }) => {
  const user = store.user!;
  await getOwnedEnvironment(params.id, user.id);

  const b = body as { instance_number?: number };
  try {
    return await enterEnvironment(user.id, params.id, b.instance_number);
  } catch (err: any) {
    if (err.code === "NOT_FOUND") {
      return error(404, { error: { type: "NOT_FOUND", message: err.message } });
    }
    return error(500, { error: { type: "CONFIG_WRITE_ERROR", message: err.message } });
  }
}, { sessionAuth: true, body: "enter-environment-request" });
```

在文件顶部添加导入：

```typescript
import { enterEnvironment } from "../../services/instance";
```

- [ ] **Step 3: Commit**

```bash
git add src/services/instance.ts src/routes/web/environments.ts
git commit -m "refactor: web/environments enter 端点响应组装下沉到 instance service"
```

---

### Task 2: web/environments — instances 列表端点响应组装下沉

**Files:**
- Modify: `src/services/instance.ts`
- Modify: `src/routes/web/environments.ts`

当前第 145-162 行的 `GET /environments/:id/instances` 在路由中做了实例列表映射。

- [ ] **Step 1: 在 instance.ts 中新增 `listInstancesForEnvironmentResponse` 函数**

在 `src/services/instance.ts` 末尾添加：

```typescript
export interface InstanceListItem {
  id: string;
  instance_number: number;
  status: string;
  session_id: string | null;
  port: number | undefined;
  created_at: number;
}

export interface InstanceListResponse {
  environment_id: string;
  instances: InstanceListItem[];
}

/**
 * 获取环境的实例列表（API 响应格式）。
 */
export function listInstancesResponse(environmentId: string): InstanceListResponse {
  const activeInstances = listInstancesByEnvironment(environmentId);
  return {
    environment_id: environmentId,
    instances: activeInstances.map((inst) => ({
      id: inst.id,
      instance_number: inst.instanceNumber,
      status: inst.status,
      session_id: inst.sessionId ?? null,
      port: inst.port,
      created_at: Math.floor(inst.createdAt.getTime() / 1000),
    })),
  };
}
```

- [ ] **Step 2: 简化 web/environments.ts 的 instances 列表端点**

将第 145-162 行替换为：

```typescript
/** GET /web/environments/:id/instances — List active instances for an environment */
app.get("/environments/:id/instances", async ({ store, params }) => {
  const user = store.user!;
  await getOwnedEnvironment(params.id, user.id);
  return listInstancesResponse(params.id);
}, { sessionAuth: true });
```

在导入中添加 `listInstancesResponse`。

- [ ] **Step 3: Commit**

```bash
git add src/services/instance.ts src/routes/web/environments.ts
git commit -m "refactor: web/environments instances 列表端点响应组装下沉到 instance service"
```

---

### Task 3: web/instances — 列表端点响应组装下沉

**Files:**
- Modify: `src/services/instance.ts`
- Modify: `src/routes/web/instances.ts`

- [ ] **Step 1: 读取 web/instances.ts 确认响应组装位置**

Run: `cat -n src/routes/web/instances.ts`

查看 GET /instances 和其他列表端点中是否有内联的数据映射逻辑。如果发现类似的 `map((inst) => ({ ... }))` 模式，按相同方式下沉。

- [ ] **Step 2: 在 instance.ts 中新增对应的响应函数（如需要）**

如果 `web/instances.ts` 有响应组装逻辑，在 `src/services/instance.ts` 中新增 `listUserInstancesResponse(userId: string)` 函数，封装查询 + 映射逻辑。

- [ ] **Step 3: 简化路由处理器**

- [ ] **Step 4: Commit**

```bash
git add src/services/instance.ts src/routes/web/instances.ts
git commit -m "refactor: web/instances 列表端点响应组装下沉到 instance service"
```

---

### Task 4: 最终验证

- [ ] **Step 1: 搜索路由中残留的 map 响应映射**

Run: `grep -rn "\.map(.*=>.*{" src/routes/web/`
Expected: 大幅减少 — 仅剩简单的类型转换，不再有跨实体关联的映射逻辑

- [ ] **Step 2: 运行全量测试和类型检查**

Run: `bun run typecheck && bun test src/__tests__/`
Expected: 零错误，全部 PASS

---

## 与其他计划的依赖关系

本计划与 `2026-05-16-route-repo-bypass.md` 有重叠：
- `listEnvironmentsWithInstances` 在两个计划中都出现了。建议先执行 route-repo-bypass 计划的 Task 2，本计划的 Task 1-2 再在此基础上继续。
- `registerBridge` 的响应组装已在 route-repo-bypass 中完成，本计划不再重复。

**推荐执行顺序**：先完成 `route-repo-bypass`，再执行本计划。
