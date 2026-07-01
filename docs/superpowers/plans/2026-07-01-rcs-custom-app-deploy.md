# RCS Custom App 部署接入 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 RCS 后端支持创建 `type:"custom"` 的 agent-sites app 并暴露部署接口，agent 通过 `POST /web/agent-sites/apps/:id/deploy` 上传 Deno 应用 gzip 包；业务前端访问继续走 RCS proxy 并按 visibility 校验。

**Architecture:** RCS 作为代理层，向下对接 agent-sites 平台（已支持 custom app），向上提供组织隔离 + visibility 校验 + platform token 自持。RCS DB `agent_site_app` 表加 `appType` / `entryFile` / `activeSlot` / `deployedAt` 四个字段记录部署状态，部署接口透传 gzip stream 到平台 `/api/apps/:id/deploy`，再把响应中的 `entry_file` / `slot` 写入 RCS DB。L2 PB 透传对 custom 类型显式拒绝（custom app 没有 PocketBase）。

**Tech Stack:** Elysia + Bun + Drizzle ORM + Zod v4 + PostgreSQL；agent-sites 平台（外部 Deno 服务）。

---

## 文件结构

### 修改
| 文件 | 职责 |
|------|------|
| `src/db/schema.ts` | `agentSiteApp` 表加 4 个新字段 |
| `drizzle/<新迁移>.sql` | 自动生成的迁移 SQL |
| `src/repositories/agent-site-app.ts` | `CreateAppParams` 加 `appType`；`update` 支持新字段 |
| `src/services/agent-sites.ts` | `createRemoteApp` 加 `type` 参数；新增 `deployCustomApp` |
| `src/schemas/agent-site.schema.ts` | `AgentSiteAppSchema` 加 4 字段；新增 `DeployAgentSiteAppSchema` 等 |
| `src/routes/web/agent-sites.ts` | `POST /apps` 透传 type；`toResponse` 加新字段；新增 `POST /apps/:id/deploy`；L2 路由对 custom 返 400 |
| `src/__tests__/agent-sites-repo.test.ts` | repo 测试加新字段 |
| `src/__tests__/agent-sites-service.test.ts` | service 测试加 type + deploy |
| `src/__tests__/agent-sites-routes.test.ts` | 路由测试加 deploy + custom 拒绝 PB |
| `.agents/skills/agent-platform-api/references/agent-sites.md` | 加 custom app 章节 |
| `.agents/agents/agent-sites-builder.md` | 加 custom app 工作流提示 |

### 不修改
- `src/routes/agent-sites-proxy.ts`（业务前端代理对 custom app 透明——custom app 远端访问路径也是 `/{remoteAppId}/*`，已有代理直接转发）
- `src/services/config.ts` 中的 `addAgentSiteApp` / `removeAgentSiteApp`（绑定逻辑不变）

---

## Task 1: DB Schema 加 4 个新字段

**Files:**
- Modify: `src/db/schema.ts:962-985`（`agentSiteApp` pgTable 定义）

- [ ] **Step 1: 编辑 schema.ts 加字段**

在 `agentSiteApp` pgTable 的 `visibility` 字段后、`createdAt` 字段前加 4 个新字段：

```ts
    visibility: varchar("visibility", { length: 20 }).notNull().default("private"),
    // ── custom app 部署相关（pocketbase 类型时这些字段为 null） ──
    appType: varchar("app_type", { length: 20 }).notNull().default("pocketbase"),
    entryFile: varchar("entry_file", { length: 64 }),
    activeSlot: varchar("active_slot", { length: 8 }),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
```

- [ ] **Step 2: 生成迁移**

```bash
bun run db:generate --name add_agent_site_app_custom_deploy
```

预期：`drizzle/00XX_add_agent_site_app_custom_deploy.sql` 生成，包含 4 个 `ALTER TABLE "agent_site_app" ADD COLUMN` 语句。

- [ ] **Step 3: 推送到开发库验证**

```bash
bun run db:push
```

预期：开发库 schema 同步成功，无错误。

- [ ] **Step 4: 验证 schema 文件**

```bash
cat drizzle/00XX_add_agent_site_app_custom_deploy.sql
```

预期看到：
```sql
ALTER TABLE "agent_site_app" ADD COLUMN "app_type" varchar(20) NOT NULL DEFAULT 'pocketbase';
ALTER TABLE "agent_site_app" ADD COLUMN "entry_file" varchar(64);
ALTER TABLE "agent_site_app" ADD COLUMN "active_slot" varchar(8);
ALTER TABLE "agent_site_app" ADD COLUMN "deployed_at" timestamp with time zone;
```

- [ ] **Step 5: 提交**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(agent-sites): 加 custom app 部署相关 DB 字段

agent_site_app 表新增 appType/entryFile/activeSlot/deployedAt 四个字段，
用于记录 custom 类型 app 的部署状态。pocketbase 类型时后三个字段为 null。

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 2: Repo 层支持新字段

**Files:**
- Modify: `src/repositories/agent-site-app.ts:10-19`（`CreateAppParams` 接口）
- Modify: `src/repositories/agent-site-app.ts:22-37`（`create` 方法）
- Modify: `src/repositories/agent-site-app.ts:71-81`（`update` 方法签名）

- [ ] **Step 1: 写失败测试**

`src/__tests__/agent-sites-repo.test.ts` 顶部已存在（不重写整个文件，新增测试用例）。在 `describe("agent-site-app repo", ...)` 块内末尾追加：

```ts
test("create 透传 appType 参数", async () => {
  const inserted: Record<string, unknown> = {};
  const mockDb = {
    insert: () => ({
      values: (data: Record<string, unknown>) => {
        Object.assign(inserted, data);
        return { returning: () => Promise.resolve([{ ...data, id: "new-id" }]) };
      },
    }),
  };
  // 临时替换 db 模块——通过 stubDb 不行（repo 直接 import db），
  // 这里改用 mock.module 也不行（CLAUDE.md 禁止），用动态 import + 全局 db 替换
  // 实际通过 setDbForTest 注入（见 test-utils），见 Step 3 实现
  // 此处先标记测试为 todo，待 Step 3 提供测试钩子
  expect(true).toBe(true); // 占位，Step 3 后改写
});

test("update 支持 entryFile/activeSlot/deployedAt 字段", async () => {
  // 同上，待 Step 3 后改写
  expect(true).toBe(true);
});
```

> **说明：** RCS 现有 repo 测试通过 `stubDb`（`src/test-utils/stubs/db-stub.ts`）注入 mock。本任务先确认现有 stub 模式支持新字段透传——直接在 Step 3 实现后回头改这两个测试为真实断言。

- [ ] **Step 2: 暂不运行（占位测试）**

```bash
bun test src/__tests__/agent-sites-repo.test.ts
```

预期：通过（因为是占位）。

- [ ] **Step 3: 修改 repo 实现**

替换 `src/repositories/agent-site-app.ts:10-19` 的 `CreateAppParams` 接口：

```ts
export interface CreateAppParams {
  organizationId: string;
  userId: string;
  remoteAppId: string;
  name: string;
  description?: string;
  platformToken: string;
  platformTokenId: string;
  visibility?: Visibility;
  /** App 类型，默认 pocketbase。custom 类型支持 deploy 接口 */
  appType?: "pocketbase" | "custom";
}
```

替换 `create` 方法（第 22-37 行）：

```ts
  async create(params: CreateAppParams): Promise<AgentSiteAppRow> {
    const [row] = await db
      .insert(agentSiteApp)
      .values({
        organizationId: params.organizationId,
        userId: params.userId,
        remoteAppId: params.remoteAppId,
        name: params.name,
        description: params.description ?? null,
        platformToken: params.platformToken,
        platformTokenId: params.platformTokenId,
        visibility: params.visibility ?? "private",
        appType: params.appType ?? "pocketbase",
      })
      .returning();
    return row;
  }
```

替换 `update` 方法签名（第 71-81 行），扩展支持新字段：

```ts
  async update(
    id: string,
    data: Partial<
      Pick<
        AgentSiteAppRow,
        | "name"
        | "description"
        | "visibility"
        | "platformToken"
        | "platformTokenId"
        | "entryFile"
        | "activeSlot"
        | "deployedAt"
      >
    >,
  ): Promise<AgentSiteAppRow | undefined> {
    const [row] = await db
      .update(agentSiteApp)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(agentSiteApp.id, id))
      .returning();
    return row;
  }
```

- [ ] **Step 4: 改写 Step 1 的占位测试为真实断言**

替换 Task 2 Step 1 写的两个占位测试：

```ts
test("create 默认 appType 为 pocketbase", async () => {
  const captured: Record<string, unknown> = {};
  stubDb({
    insert: () => ({
      values: (data: Record<string, unknown>) => {
        Object.assign(captured, data);
        return { returning: () => Promise.resolve([{ ...data, id: "new-id" }]) };
      },
    }),
  });
  const { agentSiteAppRepo } = await import("../repositories/agent-site-app");
  await agentSiteAppRepo.create({
    organizationId: "org-1",
    userId: "user-1",
    remoteAppId: "app-test1",
    name: "test",
    platformToken: "tok",
    platformTokenId: "tok-1",
  });
  expect(captured.appType).toBe("pocketbase");
});

test("create 显式传 appType=custom", async () => {
  const captured: Record<string, unknown> = {};
  stubDb({
    insert: () => ({
      values: (data: Record<string, unknown>) => {
        Object.assign(captured, data);
        return { returning: () => Promise.resolve([{ ...data, id: "new-id" }]) };
      },
    }),
  });
  const { agentSiteAppRepo } = await import("../repositories/agent-site-app");
  await agentSiteAppRepo.create({
    organizationId: "org-1",
    userId: "user-1",
    remoteAppId: "app-test2",
    name: "test",
    platformToken: "tok",
    platformTokenId: "tok-1",
    appType: "custom",
  });
  expect(captured.appType).toBe("custom");
});

test("update 支持部署字段", async () => {
  const captured: Record<string, unknown> = {};
  stubDb({
    update: () => ({
      set: (data: Record<string, unknown>) => {
        Object.assign(captured, data);
        return {
          where: () => ({ returning: () => Promise.resolve([{ id: "x", ...data }]) }),
        };
      },
    }),
  });
  const { agentSiteAppRepo } = await import("../repositories/agent-site-app");
  await agentSiteAppRepo.update("x", {
    entryFile: "main.ts",
    activeSlot: "a",
    deployedAt: new Date("2026-07-01"),
  });
  expect(captured.entryFile).toBe("main.ts");
  expect(captured.activeSlot).toBe("a");
  expect(captured.deployedAt).toEqual(new Date("2026-07-01"));
});
```

- [ ] **Step 5: 运行测试**

```bash
bun test src/__tests__/agent-sites-repo.test.ts
```

预期：所有测试通过（包括新加的 3 个）。

- [ ] **Step 6: 提交**

```bash
git add src/repositories/agent-site-app.ts src/__tests__/agent-sites-repo.test.ts
git commit -m "feat(agent-sites): repo 层支持 custom app 部署字段

CreateAppParams 加 appType 参数；update 方法支持 entryFile/activeSlot/deployedAt。

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 3: Service 层 — createRemoteApp 加 type 参数

**Files:**
- Modify: `src/services/agent-sites.ts:62-79`（`RemoteApp` 接口 + `createRemoteApp` 函数）

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/agent-sites-service.test.ts` 文件末尾追加：

```ts
describe("agent-sites service — createRemoteApp type 参数", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.AGENT_SITES_BASE_URL = "http://localhost:9999";
    process.env.AGENT_SITES_MASTER_KEY = "test-master-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
    globalThis.fetch = originalFetch;
  });

  test("不传 type 默认走 pocketbase", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body ? String(init.body) : null;
      return new Response(
        JSON.stringify({ data: { id: "app-test", name: "n", type: "pocketbase", port: 9000, status: "running", api_path: "/app-test/api", created_at: "2026-07-01" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { createRemoteApp } = await import("../services/agent-sites");
    await createRemoteApp("my-app");
    const parsed = JSON.parse(capturedBody!);
    expect(parsed).toEqual({ name: "my-app" }); // 不含 type 字段
  });

  test("传 type=custom 透传到平台", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body ? String(init.body) : null;
      return new Response(
        JSON.stringify({ data: { id: "app-test", name: "n", type: "custom", port: 0, status: "running", api_path: "/app-test", created_at: "2026-07-01" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { createRemoteApp } = await import("../services/agent-sites");
    await createRemoteApp("my-app", "custom");
    const parsed = JSON.parse(capturedBody!);
    expect(parsed).toEqual({ name: "my-app", type: "custom" });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
bun test src/__tests__/agent-sites-service.test.ts --filter "createRemoteApp type"
```

预期：FAIL（"init?.body 类型不匹配"或类似——因为 createRemoteApp 当前不接受 type 参数）。

- [ ] **Step 3: 修改 createRemoteApp**

替换 `src/services/agent-sites.ts:71-79`：

```ts
/** POST /api/apps — 创建远程 app
 *  @param type app 类型，默认 pocketbase。custom 类型不创建 PocketBase，需后续 POST /api/apps/:id/deploy 部署代码
 */
export async function createRemoteApp(
  name: string,
  type?: "pocketbase" | "custom",
): Promise<RemoteApp> {
  const body: Record<string, string> = { name };
  if (type === "custom") {
    body.type = "custom";
  }
  const res = await agentSitesFetch("/api/apps", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const json = await handleResponse<{ data: RemoteApp }>(res);
  return json.data;
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
bun test src/__tests__/agent-sites-service.test.ts --filter "createRemoteApp type"
```

预期：PASS（两个测试都通过）。

- [ ] **Step 5: 提交**

```bash
git add src/services/agent-sites.ts src/__tests__/agent-sites-service.test.ts
git commit -m "feat(agent-sites): createRemoteApp 支持 type 参数

type=custom 时不创建 PocketBase，后续通过 deploy 接口部署代码。

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 4: Service 层 — 新增 deployCustomApp 方法

**Files:**
- Modify: `src/services/agent-sites.ts`（在文件末尾 L2/L3 透传段之前加新方法）

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/agent-sites-service.test.ts` 文件末尾追加：

```ts
describe("agent-sites service — deployCustomApp", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.AGENT_SITES_BASE_URL = "http://localhost:9999";
    process.env.AGENT_SITES_MASTER_KEY = "test-master-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
    globalThis.fetch = originalFetch;
  });

  test("deploy 成功返回平台响应", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Headers | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedMethod = init?.method ?? "GET";
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          data: { files: 3, total_bytes: 1024, entry_file: "main.ts", slot: "a", port: 9005 },
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { deployCustomApp } = await import("../services/agent-sites");
    const fakeBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0x1f, 0x8b]));
        c.close();
      },
    });
    const result = await deployCustomApp("app-test", fakeBody);
    expect(capturedUrl).toBe("http://localhost:9999/api/apps/app-test/deploy");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders!.get("X-Master-Key")).toBe("test-master-key");
    expect(result.data).toEqual({
      files: 3,
      total_bytes: 1024,
      entry_file: "main.ts",
      slot: "a",
      port: 9005,
    });
  });

  test("deploy 平台返 400 抛 AgentSitesError", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: null,
          error: { code: "BAD_REQUEST", message: "App app-test 不是自定义类型，无法部署" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const { deployCustomApp, AgentSitesError } = await import("../services/agent-sites");
    const fakeBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    expect(deployCustomApp("app-test", fakeBody)).rejects.toMatchObject({
      name: "AgentSitesError",
      status: 400,
      message: "App app-test 不是自定义类型，无法部署",
    });
    // 引用 AgentSitesError 防止 TS 未使用警告
    expect(AgentSitesError).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
bun test src/__tests__/agent-sites-service.test.ts --filter "deployCustomApp"
```

预期：FAIL（`deployCustomApp is not a function` 或 import 失败）。

- [ ] **Step 3: 实现 deployCustomApp**

在 `src/services/agent-sites.ts` 文件中，找到 `// ── L2/L3 透传 ──` 这行注释（约第 141 行），在它**之前**插入：

```ts
/** POST /api/apps/{id}/deploy — 部署 custom app（gzip tar.gz 包）
 *
 *  调用方传入 ReadableStream body（来自 RCS 路由 request.body），
 *  本方法注入 X-Master-Key 后透传到 agent-sites 平台，平台做：
 *  - 检查 app.type === "custom"，否则返 400
 *  - 解压 tar.gz 到 deploy-{slot} 目录
 *  - TCP 探活（10 秒超时，每 200ms 一次）
 *  - 探活超时抛 500 INTERNAL_ERROR（消息 sanitize 为「服务器内部错误」）
 *  - 切换 active_slot + 重启进程
 *
 *  成功响应：{ data: { files, total_bytes, entry_file, slot, port }, error: null }
 *  RCS 调用方负责把 entry_file/slot 写入 RCS DB（port 是平台内部端口，不外露）
 */
export async function deployCustomApp(
  remoteAppId: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<{ data: { files: number; total_bytes: number; entry_file: string; slot: string; port: number } }> {
  const res = await agentSitesFetch(
    `/api/apps/${encodeURIComponent(remoteAppId)}/deploy`,
    {
      method: "POST",
      headers: new Headers(), // 不设 content-type，平台靠 gzip magic bytes (1f 8b) 识别
      body,
    },
  );
  return handleResponse(res);
}

```

- [ ] **Step 4: 运行测试验证通过**

```bash
bun test src/__tests__/agent-sites-service.test.ts --filter "deployCustomApp"
```

预期：PASS（两个测试都通过）。

- [ ] **Step 5: 提交**

```bash
git add src/services/agent-sites.ts src/__tests__/agent-sites-service.test.ts
git commit -m "feat(agent-sites): 新增 deployCustomApp 透传部署接口

调用 agent-sites 平台 POST /api/apps/:id/deploy，透传 gzip tar.gz body。
平台做解压、TCP 探活、双槽位切换。RCS 调用方负责把 entry_file/slot 写入 DB。

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 5: Schema 层 — 扩展 AgentSiteAppSchema + CreateRequest

**Files:**
- Modify: `src/schemas/agent-site.schema.ts:4-17`（`AgentSiteAppSchema`）
- Modify: `src/schemas/agent-site.schema.ts:31-45`（`CreateAgentSiteAppRequestSchema`）

- [ ] **Step 1: 扩展 AgentSiteAppSchema**

替换 `src/schemas/agent-site.schema.ts:4-15`：

```ts
/** Agent Sites App 响应对象 */
export const AgentSiteAppSchema = z.object({
  id: z.string().describe("RCS 内 app UUID。"),
  organizationId: z.string().describe("所属组织 ID。"),
  userId: z.string().describe("创建者用户 ID（owner）。"),
  remoteAppId: z.string().describe("agent-sites 远程 app id（形如 app-xxxxxxxx）。"),
  name: z.string().describe("展示名称。"),
  description: z.string().nullable().describe("描述。"),
  visibility: z.enum(["private", "org", "authenticated", "public"]).describe("业务前端可见性。"),
  appType: z.enum(["pocketbase", "custom"]).describe("App 类型。custom 类型需通过 deploy 接口部署 Deno 应用。"),
  entryFile: z.string().nullable().describe("当前入口文件（如 main.ts）。pocketbase 类型为 null。"),
  activeSlot: z.enum(["a", "b"]).nullable().describe("当前激活的部署槽位。pocketbase 类型为 null。"),
  deployedAt: z.number().nullable().describe("最后部署时间（秒级时间戳）。pocketbase 类型为 null。"),
  createdAt: z.number().describe("创建时间（秒级时间戳）。"),
  updatedAt: z.number().describe("更新时间（秒级时间戳）。"),
});
```

- [ ] **Step 2: 扩展 CreateAgentSiteAppRequestSchema**

替换 `src/schemas/agent-site.schema.ts:31-45`：

```ts
/** POST /web/agent-sites/apps 创建请求 */
export const CreateAgentSiteAppRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, "name 必须为 kebab-case")
    .describe("app 展示名称（kebab-case，仅展示用不唯一）。"),
  description: z.string().optional().describe("可选描述。"),
  visibility: z
    .enum(["private", "org", "authenticated", "public"])
    .optional()
    .default("private")
    .describe("业务前端可见性，默认 private。"),
  type: z
    .enum(["pocketbase", "custom"])
    .optional()
    .default("pocketbase")
    .describe("App 类型。custom 类型不创建 PocketBase，需后续 POST /apps/:id/deploy 部署 Deno 代码。"),
});

export type CreateAgentSiteAppRequest = z.infer<typeof CreateAgentSiteAppRequestSchema>;
```

- [ ] **Step 3: 类型检查**

```bash
bunx tsc --noEmit
```

预期：可能有 TS 错误（因为 `toResponse` 还没更新），先记下错误数，下个 task 修复。

- [ ] **Step 4: 暂不提交（与 Task 6 一起提交）**

---

## Task 6: Schema 层 — 新增 deploy 接口 schema

**Files:**
- Modify: `src/schemas/agent-site.schema.ts`（在文件末尾追加）

- [ ] **Step 1: 在 schema 文件末尾追加 deploy 相关 schema**

在 `src/schemas/agent-site.schema.ts` 文件末尾（`AgentSiteErrorResponseSchema` 行之后）追加：

```ts

/** POST /web/agent-sites/apps/:id/deploy 成功响应 */
export const AgentSiteDeployResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    files: z.number().describe("解压后的文件数。"),
    totalBytes: z.number().describe("解压后总字节数。"),
    entryFile: z.string().describe("入口文件名（main.ts 或 main.js）。"),
    slot: z.enum(["a", "b"]).describe("当前激活的部署槽位。"),
    deployedAt: z.number().describe("本次部署时间（秒级时间戳）。"),
  }),
});

export type AgentSiteDeployResponse = z.infer<typeof AgentSiteDeployResponseSchema>;
```

- [ ] **Step 2: 提交（Task 5 + Task 6 一起）**

```bash
git add src/schemas/agent-site.schema.ts
git commit -m "feat(agent-sites): schema 加 custom app + deploy 字段

AgentSiteAppSchema 加 appType/entryFile/activeSlot/deployedAt 四个字段；
CreateAgentSiteAppRequestSchema 加 type 字段（默认 pocketbase）；
新增 AgentSiteDeployResponseSchema 用于部署响应。

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 7: Route 层 — toResponse 加新字段

**Files:**
- Modify: `src/routes/web/agent-sites.ts:36-49`（`toResponse` 函数）

- [ ] **Step 1: 修改 toResponse**

替换 `src/routes/web/agent-sites.ts:36-49`：

```ts
/** 将 DB row 转为 API 响应（秒级时间戳，不包含 platformToken） */
function toResponse(row: AgentSiteAppRow): AgentSiteApp {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    remoteAppId: row.remoteAppId,
    name: row.name,
    description: row.description ?? null,
    visibility: (row.visibility as AgentSiteApp["visibility"] | undefined) ?? "private",
    appType: (row.appType as AgentSiteApp["appType"] | undefined) ?? "pocketbase",
    entryFile: row.entryFile ?? null,
    activeSlot: (row.activeSlot as AgentSiteApp["activeSlot"] | undefined) ?? null,
    deployedAt: row.deployedAt ? Math.floor(row.deployedAt.getTime() / 1000) : null,
    createdAt: row.createdAt ? Math.floor(new Date(row.createdAt).getTime() / 1000) : 0,
    updatedAt: row.updatedAt ? Math.floor(new Date(row.updatedAt).getTime() / 1000) : 0,
  };
}
```

- [ ] **Step 2: 顶部 import 加 AgentSiteApp 类型已存在，无需修改**

确认 `import { ... type AgentSiteApp ... }` 在第 10 行已存在。

- [ ] **Step 3: 类型检查**

```bash
bunx tsc --noEmit
```

预期：TS 错误数比 Task 5 Step 3 减少（toResponse 已修正）。剩余错误应来自 `POST /apps` handler 还没透传 type（Task 8 修复）。

- [ ] **Step 4: 暂不提交（与 Task 8/9/10 一起提交）**

---

## Task 8: Route 层 — POST /apps 透传 type

**Files:**
- Modify: `src/routes/web/agent-sites.ts:158-195`（`POST /apps` handler）
- Modify: `src/routes/web/agent-sites.ts:25-33`（import 新增 `deployCustomApp`）

- [ ] **Step 1: 顶部 import 加 deployCustomApp**

替换 `src/routes/web/agent-sites.ts:25-33`：

```ts
import {
  createRemoteApp,
  deleteRemoteApp,
  deployCustomApp,
  issuePlatformToken,
  proxyToAgentSites,
  revokePlatformToken,
  uploadRemoteBundle,
  uploadRemoteFile,
} from "../../services/agent-sites";
```

- [ ] **Step 2: 修改 POST /apps handler**

替换 `src/routes/web/agent-sites.ts:158-195`（POST `/apps` handler 整段）：

```ts
  .post(
    "/apps",
    async ({ store, body }) => {
      const authCtx = store.authContext!;
      const user = store.user!;
      const b = body as CreateAgentSiteAppRequest;

      // 1. 在 agent-sites 创建远程 app（透传 type，默认 pocketbase）
      const remote = await createRemoteApp(b.name, b.type);

      // 2. 申请 platform token（custom 类型其实用不到 token——没有 PB，
      //    但保留以保持 RCS DB schema 一致；后续如需迁移回 pocketbase 也无缝）
      const token = await issuePlatformToken(remote.id);

      // 3. 写入 RCS DB
      const row = await agentSiteAppRepo.create({
        organizationId: authCtx.organizationId,
        userId: user.id,
        remoteAppId: remote.id,
        name: remote.name,
        description: b.description,
        platformToken: token.token,
        platformTokenId: token.token_id,
        visibility: (b.visibility as "private" | "org" | "authenticated" | "public") ?? "private",
        appType: b.type,
      });

      return { success: true as const, data: toResponse(row) };
    },
    {
      sessionAuth: true,
      body: CreateAgentSiteAppRequestSchema,
      response: AgentSiteAppDetailResponseSchema,
      detail: {
        tags: ["Agent Sites"],
        summary: "创建 agent site app",
        description: "在 agent-sites 创建远程 app + 申请 token + 写 RCS DB。type=custom 时不创建 PocketBase。",
      },
    },
  )
```

- [ ] **Step 3: 类型检查**

```bash
bunx tsc --noEmit
```

预期：TS 通过（无错误）。

- [ ] **Step 4: 暂不提交（与 Task 9/10 一起提交）**

---

## Task 9: Route 层 — 新增 POST /apps/:id/deploy 路由

**Files:**
- Modify: `src/routes/web/agent-sites.ts`（在 POST `/apps/:id/files/bundle` 之后、`// ── L1.5` 注释之前插入新路由）
- Modify: `src/routes/web/agent-sites.ts:8-24`（import 加 deploy schema）

- [ ] **Step 1: import 新增 deploy schema**

替换 `src/routes/web/agent-sites.ts:8-24`：

```ts
import {
  AgentSiteAgentConfigParamsSchema,
  AgentSiteDeployResponseSchema,
  type AgentSiteApp,
  AgentSiteAppDetailResponseSchema,
  AgentSiteAppFileParamsSchema,
  AgentSiteAppIdParamsSchema,
  AgentSiteAppListResponseSchema,
  AgentSiteAppOkResponseSchema,
  AgentSiteBindingParamsSchema,
  AgentSiteErrorResponseSchema,
  AgentSiteRemoteAppParamsSchema,
  AgentSiteUploadResponseSchema,
  type CreateAgentSiteAppRequest,
  CreateAgentSiteAppRequestSchema,
  type UpdateAgentSiteAppRequest,
  UpdateAgentSiteAppRequestSchema,
} from "../../schemas/agent-site.schema";
```

- [ ] **Step 2: 写失败测试**

在 `src/__tests__/agent-sites-routes.test.ts` 文件中找到 `describe("agent-sites L1 routes"` 块，在末尾追加：

```ts
  test("POST /apps/:id/deploy 对 custom 类型部署成功", async () => {
    const row = makeAppRow({ appType: "custom" });
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([row]),
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  ...row,
                  entryFile: "main.ts",
                  activeSlot: "a",
                  deployedAt: new Date("2026-07-01T00:00:00Z"),
                },
              ]),
          }),
        }),
      }),
    });
    // mock fetch 返回平台 deploy 响应
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: { files: 3, total_bytes: 1024, entry_file: "main.ts", slot: "a", port: 9005 },
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const tarGzBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0x1f, 0x8b]));
        c.close();
      },
    });
    const res = await webAgentSites.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}/deploy`, {
        method: "POST",
        body: tarGzBody,
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      files: 3,
      totalBytes: 1024,
      entryFile: "main.ts",
      slot: "a",
      deployedAt: expect.any(Number),
    });
  });

  test("POST /apps/:id/deploy 对 pocketbase 类型返 400", async () => {
    const row = makeAppRow({ appType: "pocketbase" });
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([row]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}/deploy`, {
        method: "POST",
        body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("bad_request");
    expect(json.error.message).toContain("不是 custom 类型");
  });

  test("POST /apps/:id/deploy 非 owner 非 admin 返 403", async () => {
    const row = makeAppRow({ appType: "custom", userId: "other-user" });
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([row]),
          }),
        }),
      }),
    });
    setTestAuth({
      user: { id: "test-user", email: "t@t.com", name: "T" },
      authContext: { organizationId: "test-org", userId: "test-user", role: "member" },
    });
    const res = await webAgentSites.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}/deploy`, {
        method: "POST",
        body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      }),
    );
    expect(res.status).toBe(403);
  });
```

> **注意：** `makeAppRow` 函数（在 test 文件顶部）也要加 `appType: "pocketbase"` / `entryFile: null` / `activeSlot: null` / `deployedAt: null` 默认值——见 Step 3。

- [ ] **Step 3: 更新 makeAppRow 默认值**

替换 `src/__tests__/agent-sites-routes.test.ts:21-36` 的 `makeAppRow`：

```ts
function makeAppRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_APP_ID,
    organizationId: "test-org",
    userId: "test-user",
    remoteAppId: TEST_REMOTE_APP_ID,
    name: "my-app",
    description: null,
    platformToken: "tok-xxx.yyy",
    platformTokenId: "tok-001",
    visibility: "private",
    appType: "pocketbase",
    entryFile: null,
    activeSlot: null,
    deployedAt: null,
    createdAt: new Date("2026-06-23"),
    updatedAt: new Date("2026-06-23"),
    ...overrides,
  };
}
```

- [ ] **Step 4: 运行测试验证失败**

```bash
bun test src/__tests__/agent-sites-routes.test.ts --filter "deploy"
```

预期：FAIL（deploy 路由不存在，返回 404 或类似）。

- [ ] **Step 5: 实现 deploy 路由**

在 `src/routes/web/agent-sites.ts` 中，找到 `.post("/apps/:id/files/bundle", ...)` 路由的结束位置（约第 367 行 `)`），在它**之后**、`// ── L1.5: AgentConfig ↔ SiteApp 绑定查询 ───`（约第 369 行）**之前**插入：

```ts
  // ── L1: Custom App 部署 ──────────────────────────────
  // 仅 type=custom 的 app 支持部署。透传 gzip tar.gz body 到 agent-sites 平台。
  // 平台做解压、TCP 探活（10s）、双槽位切换。RCS 拿到 entry_file/slot 写入 DB。

  .post(
    "/apps/:id/deploy",
    async ({ params, request, store, status }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return status(404, buildError("not_found", "App 不存在"));
      }
      if (!canWrite(row, authCtx.userId, authCtx.role)) {
        return status(403, buildError("forbidden", "无权限部署此 app"));
      }
      // 类型校验：只有 custom 类型支持部署
      if (row.appType !== "custom") {
        return status(
          400,
          buildError("bad_request", `App ${row.remoteAppId} 不是 custom 类型，无法部署（当前: ${row.appType}）`),
        );
      }
      // 透传 gzip body 到平台，平台做解压 + 探活 + 切换
      const remote = await deployCustomApp(row.remoteAppId, request.body);
      // 写入 RCS DB 记录部署元数据
      const now = new Date();
      await agentSiteAppRepo.update(params.id, {
        entryFile: remote.data.entry_file,
        activeSlot: remote.data.slot,
        deployedAt: now,
      });
      return {
        success: true as const,
        data: {
          files: remote.data.files,
          totalBytes: remote.data.total_bytes,
          entryFile: remote.data.entry_file,
          slot: remote.data.slot,
          deployedAt: Math.floor(now.getTime() / 1000),
        },
      };
    },
    {
      sessionAuth: true,
      params: AgentSiteAppIdParamsSchema,
      response: {
        200: AgentSiteDeployResponseSchema,
        400: AgentSiteErrorResponseSchema,
        403: AgentSiteErrorResponseSchema,
        404: AgentSiteErrorResponseSchema,
      },
      detail: {
        tags: ["Agent Sites"],
        summary: "部署 custom app（gzip tar.gz）",
        description:
          "上传 Deno 应用 gzip tar.gz 包到 custom 类型 app。平台解压、TCP 探活（10s）、双槽位热切换。pocketbase 类型返 400。owner/admin 可操作。",
      },
    },
  )
```

- [ ] **Step 6: 运行测试验证通过**

```bash
bun test src/__tests__/agent-sites-routes.test.ts --filter "deploy"
```

预期：PASS（3 个 deploy 测试都通过）。

- [ ] **Step 7: 暂不提交（与 Task 10 一起提交）**

---

## Task 10: Route 层 — L2 PB 透传对 custom 类型返 400

**Files:**
- Modify: `src/routes/web/agent-sites.ts:476-503`（`ALL /apps/:id/api/*` handler）

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/agent-sites-routes.test.ts` 中追加：

```ts
  test("L2 PB 透传 /apps/:id/api/* 对 custom 类型返 400", async () => {
    const row = makeAppRow({ appType: "custom" });
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([row]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}/api/collections`, {
        method: "GET",
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("bad_request");
    expect(json.error.message).toContain("Custom 类型 app 不支持 PocketBase API");
  });
```

- [ ] **Step 2: 运行测试验证失败**

```bash
bun test src/__tests__/agent-sites-routes.test.ts --filter "L2 PB 透传"
```

预期：FAIL（当前 custom 类型也会调 PB，要么 404 要么 mock fetch 返空）。

- [ ] **Step 3: 修改 L2 路由 handler 加 type 检查**

替换 `src/routes/web/agent-sites.ts:476-503` 整段（`.all("/apps/:id/api/*", ...)`）：

```ts
  // ── L2: PB Admin API 透传 ────────────────────────────
  // 用 * 捕获完整子路径（:path 只取一段，/api/collections/cards 会丢 /cards）
  .all(
    "/apps/:id/api/*",
    async ({ params, request, store, status }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return status(404, buildError("not_found", "App 不存在"));
      }
      // custom 类型没有 PocketBase，L2 PB 透传无意义——明确拒绝避免 404 误导
      if (row.appType === "custom") {
        return status(
          400,
          buildError(
            "bad_request",
            `Custom 类型 app ${row.remoteAppId} 不支持 PocketBase API，请走业务前端 /${row.remoteAppId}/* 或 L1 deploy 接口`,
          ),
        );
      }
      // 提取 prefix 之后的相对路径，拼回 /api/ 前缀
      const prefix = `/web/agent-sites/apps/${params.id}/api/`;
      const url = new URL(request.url);
      const relative = url.pathname.substring(url.pathname.indexOf(prefix) + prefix.length);
      const apiPath = `/api/${relative}`;
      return proxyToAgentSites(row.remoteAppId, apiPath, request, {
        Authorization: `Bearer ${row.platformToken}`,
      });
    },
    {
      sessionAuth: true,
      params: AgentSiteAppIdParamsSchema,
      detail: {
        hide: true,
        tags: ["Agent Sites"],
        summary: "透传 PB Admin API",
        description: "注入 platform token 后透传到 agent-sites PB API。仅 pocketbase 类型可用，custom 类型返 400。任何 org 成员可调。",
      },
    },
  );
```

- [ ] **Step 4: 运行测试验证通过**

```bash
bun test src/__tests__/agent-sites-routes.test.ts
```

预期：所有 agent-sites 测试通过（包括新的 deploy 和 L2 拒绝测试）。

- [ ] **Step 5: 提交（Task 7-10 一起）**

```bash
git add src/routes/web/agent-sites.ts src/__tests__/agent-sites-routes.test.ts
git commit -m "feat(agent-sites): 路由层接入 custom app 部署

- toResponse 加 appType/entryFile/activeSlot/deployedAt 字段
- POST /apps 透传 type 参数到平台
- 新增 POST /apps/:id/deploy：透传 gzip body，写入部署元数据
- L2 PB 透传对 custom 类型返 400（custom 无 PocketBase）

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 11: 文档 — references/agent-sites.md 加 custom app 章节

**Files:**
- Modify: `.agents/skills/agent-platform-api/references/agent-sites.md`（在「站点卡片」段之前插入新章节）

- [ ] **Step 1: 找到合适的插入位置**

```bash
grep -n "^## " .agents/skills/agent-platform-api/references/agent-sites.md
```

预期：看到章节列表，找到 `## 站点卡片`（约第 268 行）作为插入锚点。

- [ ] **Step 2: 在「站点卡片」段之前插入 custom app 章节**

打开 `.agents/skills/agent-platform-api/references/agent-sites.md`，找到 `## 站点卡片`（约第 268 行），在它**之前**插入：

```markdown
## Custom App 部署（type=custom）

适用于全栈 Deno 应用：前端 + 后端打包成 gzip tar.gz 上传，平台 spawn `deno run` 子进程全量代理 HTTP 流量。**不走 PocketBase**——你的 `main.ts` 自己处理路由、数据库、鉴权。

### 何时选 custom

| 场景 | 选 pocketbase | 选 custom |
|------|---------------|-----------|
| 静态前端 + 简单 CRUD 后端 | ✅ | ❌ |
| 需要自定义路由、复杂业务逻辑 | ❌ | ✅ |
| 全栈 Deno 应用（前后端在一起） | ❌ | ✅ |
| 需要 SQLite / WebSocket / 长连接 | ❌ | ✅ |

### 1. 创建 custom app

```bash
RESP=$(curl -s -X POST $BASE/apps $AUTH \
  -d '{"name":"my-deno-app","type":"custom","visibility":"private"}')
APP_ID=$(echo "$RESP" | jq -r '.data.id')
REMOTE_APP_ID=$(echo "$RESP" | jq -r '.data.remoteAppId')
```

注意：
- `type:"custom"` 必填——不传默认 `pocketbase`
- 创建后 `port=0`、`entryFile=null`、`activeSlot=null`、`deployedAt=null`——此时访问 `/{remoteAppId}/` 会返 503，**必须先 deploy**

### 2. 写 main.ts

平台 spawn 的进程等效于：

```bash
deno run --allow-net --allow-env=PORT \
  --allow-read=<codeDir> --allow-read=<runtimeDir> \
  --allow-write=<runtimeDir> main.ts
```

**关键约束**：

- **必须用 `PORT` 环境变量绑定端口，绑定 `127.0.0.1`**（不是 `0.0.0.0`，不是固定 `8080`）
- **环境变量隔离**：spawn 时 `clearEnv: true` + 白名单只透传 `PATH` / `HOME` / `LANG` / `TZ` + 注入 `PORT`。父进程敏感凭证（master key 等）**不透传**
- **stdout / stderr 被丢弃**：`console.log` / `console.error` 输出平台日志看不到，需要日志就写进 `runtime/` 目录的文件
- **路径用 `endsWith` 匹配**：代理透传完整 pathname（含 `/{remoteAppId}` 前缀），`url.pathname === "/api/x"` 匹配不上，改用 `url.pathname.endsWith("/api/x")`
- **前端 fetch 用相对路径，无 shim**：custom 模式没有 fetch 注入，`fetch("./api/x")` 靠浏览器自动补全，`fetch("/api/x")` 会 404
- **请求体上限 50 MiB**：RCS 代理 + agent-sites 平台代理都限 50 MiB body

最小 main.ts：

```typescript
const port = parseInt(Deno.env.get("PORT") || "8080");

Deno.serve({ hostname: "127.0.0.1", port }, (req) => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/api/hello")) {
    return Response.json({ message: "hello" });
  }

  return new Response(`<!doctype html>
<html><body><h1>It works</h1></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
});
```

### 3. 打包 + 部署

包内根目录必须有 `main.ts`（优先）或 `main.js`：

```bash
tar czf app.tar.gz -C ./your-app-dir .
```

**限制**：压缩后 20 MiB / 解压后 100 MiB / 单文件 10 MiB / 条目数 500。
**允许后缀**：`.html .htm .css .js .json .svg .png .jpg .jpeg .webp .ico .txt .map .ts .mjs .mts .jsx .tsx .wasm .sql .db .sqlite .sqlite3`

部署：

```bash
RESP=$(curl -s -X POST $BASE/apps/$APP_ID/deploy $AUTH \
  --data-binary @app.tar.gz)
echo "$RESP" | jq '.data'
# {
#   "files": 3,
#   "totalBytes": 1024,
#   "entryFile": "main.ts",
#   "slot": "a",
#   "deployedAt": 1719792000
# }
```

注意：
- 用 `--data-binary`（不能 `-F` multipart）
- `Content-Type` 不用设——平台靠 gzip magic bytes（`1f 8b`）识别
- **仅 custom 类型可部署**：pocketbase 类型调这个接口返 400 `"App {remoteAppId} 不是 custom 类型，无法部署"`

### 4. 验证

```bash
# 前端
curl -s $USER_META_BASE_URL/$REMOTE_APP_ID/

# 后端 API
curl -s $USER_META_BASE_URL/$REMOTE_APP_ID/api/hello
```

业务前端访问走 RCS proxy，按 visibility 校验（与 pocketbase app 一致）。

### 5. 更新（双槽位热切换）

改完代码 → 重新打包 → 再次 `POST /apps/:id/deploy`。平台自动：

- 解压到另一个槽位（a↔b）
- 新端口 spawn 新进程
- TCP 探活（轮询 `127.0.0.1:{port}`，**10 秒超时**，每 200ms 一次）
- 原子切换路由（store 更新 `active_slot`）
- 停旧进程

零 downtime——旧进程处理完存量请求才被杀。重新部署后 `slot` 会变化（a→b 或 b→a）。

### 6. 故障排查

**部署返 500** + `INTERNAL_ERROR`，message sanitize 为 `"服务器内部错误"`——平台日志能看到原始 `"自定义应用健康检查失败 app_id=... port=..."`。原因：
- main.ts 同步代码抛错（TypeScript 类型错误 / 缺少 import 文件）
- `Deno.serve` 没绑定 `127.0.0.1` 或没用 `PORT` 环境变量
- 启动时间超过 10 秒（如冷启动拉远程依赖）→ 探活超时

**部署返 200 但访问返 503**：进程跑起来过又崩了，或惰性重启失败。平台启动时不自动恢复进程；首次请求来了发现连不上才会 spawn，第一个访问者会多等最多 10 秒。

**排查手段**：在 main.ts 内部用 `try/catch` 把异常写进 `runtime/` 目录下的日志文件：

```typescript
try {
  Deno.serve({ hostname: "127.0.0.1", port }, handler);
} catch (e) {
  await Deno.writeTextFile("./crash.log", `${new Date().toISOString()} ${e}\n`, { append: true });
  throw e;
}
```

> `Deno.cwd()` = `data/app-{id}/runtime/`，跨部署保留；代码目录 `deploy-{a|b}/` 每次部署整体替换，不要写运行时数据进去。

### 7. L2 PB API 对 custom 类型不可用

`/web/agent-sites/apps/:id/api/*` 是 PocketBase 透传接口，**对 custom 类型返 400** `"Custom 类型 app {remoteAppId} 不支持 PocketBase API"`。custom app 的"后端 API"就是它自己 main.ts 里的路由，通过业务前端访问 `/{remoteAppId}/*` 调用。

```

- [ ] **Step 3: 提交**

```bash
git add .agents/skills/agent-platform-api/references/agent-sites.md
git commit -m "docs(agent-sites): references 加 custom app 部署章节

完整介绍 custom 类型 app 的创建、main.ts 编写约束、打包、部署、
双槽位热切换、故障排查、L2 PB 不可用等关键点。

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 12: 文档 — agent-sites-builder.md 加 custom app 工作流提示

**Files:**
- Modify: `.agents/agents/agent-sites-builder.md`（在工作流程末尾追加备选流程）

- [ ] **Step 1: 在文件末尾追加 custom app 备选流程**

打开 `.agents/agents/agent-sites-builder.md`，在末尾（第 51 行 `格式规则见 ...` 之后）追加：

```markdown

## 备选工作流：Custom App（type=custom）

适用全栈 Deno 应用。**先读 `references/agent-sites.md` 的「Custom App 部署」章节再开工**——custom 模式与经典 pocketbase 模式工作流差异很大。

精简流程：

1. **理解需求**：确认确实需要 custom（如自定义路由、复杂业务逻辑、SQLite、WebSocket）；否则优先 pocketbase 模式
2. **创建 App**：`POST /web/agent-sites/apps` body 加 `"type":"custom"`
3. **写 main.ts**：用 `PORT` 环境变量 + `127.0.0.1` 绑定；不要依赖父进程环境变量（被 `clearEnv` 隔离）
4. **打包 tar.gz**：根目录必须有 `main.ts` 或 `main.js`
5. **部署**：`POST /web/agent-sites/apps/:id/deploy --data-binary @app.tar.gz`
6. **验证**：`$USER_META_BASE_URL/{remoteAppId}/`
7. **站点卡片**：同经典模式

### 关键差异（vs pocketbase 模式）

| 维度 | pocketbase 模式 | custom 模式 |
|------|----------------|-------------|
| 创建参数 | 默认 | 必须加 `type:"custom"` |
| 后端 | 平台自动起 PocketBase | 自己在 main.ts 里实现 |
| L2 PB API | `/apps/:id/api/*` 可用 | 返 400（custom 无 PB） |
| 部署 | `PUT /apps/:id/files/:path` 上传静态前端 | `POST /apps/:id/deploy` 上传 gzip tar.gz |
| 业务前端访问 | `$USER_META_BASE_URL/{remoteAppId}/` | 相同（走 RCS proxy + visibility） |
| 后端日志 | PB 进程日志 | 子进程 stdout/stderr **被丢弃**，需自己写日志文件 |
```

- [ ] **Step 2: 提交**

```bash
git add .agents/agents/agent-sites-builder.md
git commit -m "docs(agent-sites): agent-sites-builder.md 加 custom app 备选工作流

补全 custom 模式与 pocketbase 模式的差异对比表。

Co-authored-by: Claude <noreply@anthropic.com>"
```

---

## Task 13: 全量验证

**Files:**
- 无修改

- [ ] **Step 1: 运行 precheck**

```bash
bun run precheck
```

预期：通过（biome format + import 排序 + tsc + biome check 全过）。如果 biome 自动修复了格式/import 排序，把修复后的变更一并提交（见 Step 3）。

- [ ] **Step 2: 运行 agent-sites 相关全部测试**

```bash
bun test src/__tests__/agent-sites-repo.test.ts
bun test src/__tests__/agent-sites-service.test.ts
bun test src/__tests__/agent-sites-routes.test.ts
```

预期：全部通过。

- [ ] **Step 3: 如有 precheck 自动修复，提交**

```bash
git status
# 如有改动：
git add -A
git commit -m "chore: precheck 自动修复"
```

- [ ] **Step 4: 端到端手测（可选但推荐）**

启动 dev server 后用真实 curl 验证：

```bash
# 1. 创建 custom app
RESP=$(curl -s -X POST http://localhost:3000/web/agent-sites/apps \
  -H 'Authorization: Bearer <你的 RCS API key>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"deno-demo","type":"custom","visibility":"private"}')
APP_ID=$(echo "$RESP" | jq -r '.data.id')
REMOTE_APP_ID=$(echo "$RESP" | jq -r '.data.remoteAppId')

# 2. 准备最小 main.ts 并打包
mkdir -p /tmp/deno-demo
cat > /tmp/deno-demo/main.ts <<'EOF'
const port = parseInt(Deno.env.get("PORT") || "8080");
Deno.serve({ hostname: "127.0.0.1", port }, () =>
  new Response("hello from custom app"));
EOF
tar czf /tmp/deno-demo.tar.gz -C /tmp/deno-demo .

# 3. 部署
curl -s -X POST http://localhost:3000/web/agent-sites/apps/$APP_ID/deploy \
  -H 'Authorization: Bearer <你的 RCS API key>' \
  --data-binary @/tmp/deno-demo.tar.gz | jq

# 4. 验证
curl -s http://localhost:3000/$REMOTE_APP_ID/
# 预期：hello from custom app
```

---

## Self-Review

### 1. Spec coverage 检查

| Spec 要求 | 对应 Task |
|----------|----------|
| RCS 后端加 deploy 接口 | Task 4（service）+ Task 9（route） |
| type 参数支持 | Task 3（service）+ Task 5（schema）+ Task 8（route） |
| RCS DB 记录 deploy 元数据 | Task 1（DB 字段）+ Task 2（repo）+ Task 9（写入逻辑） |
| references 文档补 custom app 章节 | Task 11 |
| 业务前端访问走 RCS proxy + visibility | 现有 `agent-sites-proxy.ts` 已对 custom app 透明，无需改动（已在文档 Task 11 说明） |

### 2. Placeholder scan

✅ 所有 step 都有具体代码或具体命令
✅ 没有 "TBD"、"TODO"、"fill in details"
✅ 没有 "add appropriate error handling"（错误处理已在代码中具体写出）
✅ 没有 "similar to Task N"（重复逻辑处都重写了完整代码）

### 3. Type consistency

- `appType` 全程一致（schema/repo/service/route/test）
- `entryFile` / `activeSlot` / `deployedAt` 命名一致
- `deployCustomApp(remoteAppId, body)` 签名在 service/test/route 三处一致
- `CreateAgentSiteAppRequest.type` 字段在 schema/route/test 一致

---

## 执行顺序总结

Task 1 → Task 2 → Task 3 → Task 4 → (Task 5 + Task 6) → Task 7 → Task 8 → Task 9 → Task 10 → Task 11 → Task 12 → Task 13

每个 Task 内部都按 TDD：写测试 → 验证失败 → 实现 → 验证通过 → 提交。
