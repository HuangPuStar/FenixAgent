# 系统 Admin 初始化与内置 Skill 统一托管 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。

**目标：** 启动时自动初始化系统 `admin` 用户与 `admin` 组织，并将 builtin skill 改为只同步到系统组织下，再通过公开可读能力共享给其他组织。

**架构：** 新增 `system-admin.ts` 负责首次创建系统账号、组织、membership 和密码文件写入；`meta-agent.ts` 保留扫描与同步 builtin skill 的底层能力，但启动入口改为 `syncBuiltin()`，当前只调 `syncBuiltinSkillsToSystemAdmin()`。`index.ts` 启动链路从“遍历所有组织复制 builtin skill”切换为“确保系统 admin 存在后，统一同步到 admin 组织并公开”。

**技术栈：** TypeScript、Bun、better-auth、Drizzle ORM、PostgreSQL、Biome

---

## 文件结构

**创建：**
- `src/services/system-admin.ts`
  - 首次创建系统 admin 用户、admin 组织、owner membership，并写入密码文件
- `src/__tests__/system-admin.test.ts`
  - 覆盖首次创建、已存在跳过、密码文件写入

**修改：**
- `src/env.ts`
  - 新增 `RCS_SYSTEM_ADMIN_PASSWORD_FILE`
- `src/config.ts`
  - 暴露 `systemAdminPasswordFile`
- `src/index.ts`
  - 启动顺序改为 `ensureSystemAdmin()` → `runDataMigrations()` → `syncBuiltin()`
- `src/services/meta-agent.ts`
  - 提供 `syncBuiltin()` 和 `syncBuiltinSkillsToSystemAdmin()`，移除启动期“遍历所有组织同步”的假设
- `src/services/config/skill.ts`
  - 若当前没有统一的公开读设置入口，补充/复用 `setPublicRead` 之类的调用点，让 builtin skill 同步后统一公开
- `src/__tests__/meta-agent.test.ts`
  - 覆盖 builtin skill 只同步到系统 admin 组织、同步后为公开可读、`ensureMetaConfig()` 不再给业务组织灌副本
- `src/__tests__/env.test.ts`
  - 如已有 env/config 相关测试，补充密码文件配置项断言

---

### 任务 1：补系统 admin 密码文件配置

**文件：**
- 修改：`src/env.ts`
- 修改：`src/config.ts`
- 测试：`src/__tests__/env.test.ts`

- [x] **步骤 1：先写失败测试，锁定新配置项会进入运行时 config**

```ts
import { describe, expect, test } from "bun:test";
import { applyEnv, config } from "../config";

describe("system admin password file config", () => {
  // 系统 admin 的密码文件路径需要可配置，不能和 skillDir 语义耦合
  test("applies RCS_SYSTEM_ADMIN_PASSWORD_FILE into runtime config", () => {
    applyEnv({
      DATABASE_URL: "postgres://test",
      RCS_API_KEYS: "secret",
      RCS_SYSTEM_ADMIN_PASSWORD_FILE: "./data/custom-password.txt",
    } as never);

    expect(config.systemAdminPasswordFile.endsWith("data/custom-password.txt")).toBe(true);
  });
});
```

- [x] **步骤 2：运行测试验证当前配置还不支持该字段**

运行：`bun test src/__tests__/env.test.ts`
预期：FAIL，提示 `RCS_SYSTEM_ADMIN_PASSWORD_FILE` 或 `config.systemAdminPasswordFile` 不存在

- [x] **步骤 3：在 env 和 config 中补齐显式配置项**

```ts
// src/env.ts
RCS_SYSTEM_ADMIN_PASSWORD_FILE: z.string().default("./data/password.txt"),

// src/config.ts
systemAdminPasswordFile: resolve(env.RCS_SYSTEM_ADMIN_PASSWORD_FILE ?? "./data/password.txt"),
```

- [x] **步骤 4：运行测试确认配置项可用**

运行：`bun test src/__tests__/env.test.ts`
预期：PASS，`config.systemAdminPasswordFile` 正确反映 env 值

- [x] **步骤 5：Commit**

```bash
git add src/env.ts src/config.ts src/__tests__/env.test.ts
git commit -m "feat(system): 新增系统 admin 密码文件配置"
```

---

### 任务 2：实现系统 admin 首次初始化服务

**文件：**
- 创建：`src/services/system-admin.ts`
- 测试：`src/__tests__/system-admin.test.ts`

- [x] **步骤 1：先写失败测试，锁定首次创建行为**

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config";
import { ensureSystemAdmin } from "../services/system-admin";

describe("ensureSystemAdmin", () => {
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fenix-system-admin-"));
    setConfig({ systemAdminPasswordFile: join(tempDir, "password.txt") });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // 首次启动需要创建 admin 用户、admin 组织，并把密码写到文件中
  test("creates system admin account and writes password file on first boot", async () => {
    const result = await ensureSystemAdmin();

    expect(result.email).toBe("admin@fenix.com");
    expect(result.organization.slug).toBe("admin");
    expect(result.created).toBe(true);
    expect(existsSync(join(tempDir, "password.txt"))).toBe(true);
    expect(readFileSync(join(tempDir, "password.txt"), "utf-8")).toContain("admin@fenix.com");
  });
});
```

- [x] **步骤 2：补“已存在即跳过”的失败测试**

```ts
// 同一邮箱已存在时必须完全跳过，不能修复、重置或覆盖密码文件
test("skips when admin user already exists", async () => {
  await ensureSystemAdmin();
  const firstContent = readFileSync(join(tempDir, "password.txt"), "utf-8");

  const result = await ensureSystemAdmin();
  const secondContent = readFileSync(join(tempDir, "password.txt"), "utf-8");

  expect(result.created).toBe(false);
  expect(secondContent).toBe(firstContent);
});
```

- [x] **步骤 3：运行测试确认服务尚未实现**

运行：`bun test src/__tests__/system-admin.test.ts`
预期：FAIL，提示 `ensureSystemAdmin` 文件或导出不存在

- [x] **步骤 4：实现最小系统 admin 初始化服务**

```ts
// src/services/system-admin.ts
const SYSTEM_ADMIN_NAME = "admin";
const SYSTEM_ADMIN_EMAIL = "admin@fenix.com";
const SYSTEM_ADMIN_ORG_SLUG = "admin";

export async function ensureSystemAdmin(): Promise<{
  created: boolean;
  userId: string;
  email: string;
  organization: { id: string; slug: string };
}> {
  const existing = await db.query.user.findFirst({
    where: (user, { eq }) => eq(user.email, SYSTEM_ADMIN_EMAIL),
  });
  if (existing) {
    return {
      created: false,
      userId: existing.id,
      email: SYSTEM_ADMIN_EMAIL,
      organization: { id: "", slug: SYSTEM_ADMIN_ORG_SLUG },
    };
  }

  const password = randomBytes(12).toString("base64url").slice(0, 16);
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(user).values({
      id: userId,
      name: SYSTEM_ADMIN_NAME,
      email: SYSTEM_ADMIN_EMAIL,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await tx.insert(account).values({
      id: crypto.randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: await auth.api.hashPassword({ password }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await tx.insert(organization).values({
      id: organizationId,
      name: SYSTEM_ADMIN_NAME,
      slug: SYSTEM_ADMIN_ORG_SLUG,
      createdAt: new Date(),
    });
    await tx.insert(member).values({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
  });

  mkdirSync(dirname(config.systemAdminPasswordFile), { recursive: true });
  writeFileSync(
    config.systemAdminPasswordFile,
    `system admin account\nusername: admin\nemail: admin@fenix.com\npassword: ${password}\norganization: admin\n`,
    "utf-8",
  );

  return {
    created: true,
    userId,
    email: SYSTEM_ADMIN_EMAIL,
    organization: { id: organizationId, slug: SYSTEM_ADMIN_ORG_SLUG },
  };
}
```

- [x] **步骤 5：运行测试确认首次创建与幂等跳过通过**

运行：`bun test src/__tests__/system-admin.test.ts`
预期：PASS，首次创建写出文件，第二次调用不重写文件

- [x] **步骤 6：Commit**

```bash
git add src/services/system-admin.ts src/__tests__/system-admin.test.ts
git commit -m "feat(system): 初始化系统 admin 账号与组织"
```

---

### 任务 3：把 builtin skill 同步入口改为系统托管模式

**文件：**
- 修改：`src/services/meta-agent.ts`
- 测试：`src/__tests__/meta-agent.test.ts`

- [x] **步骤 1：先写失败测试，锁定 `syncBuiltin()` 只会走系统 admin 组织**

```ts
import { describe, expect, mock, test } from "bun:test";
import { syncBuiltin } from "../services/meta-agent";

describe("syncBuiltin", () => {
  // 启动同步 builtin 时，只应把 skill 托管到系统 admin 组织，而不是复制到所有业务组织
  test("syncs builtin skills only to system admin organization", async () => {
    const spy = mock();
    await syncBuiltin({
      ensureSystemAdmin: async () => ({
        created: false,
        userId: "user_admin",
        email: "admin@fenix.com",
        organization: { id: "org_admin", slug: "admin" },
      }),
      syncBuiltinSkillsToSystemAdmin: spy,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      organizationId: "org_admin",
      userId: "user_admin",
      role: "owner",
    });
  });
});
```

- [x] **步骤 2：再补失败测试，要求同步后自动公开**

```ts
// 内置 skill 统一托管到 admin 组织后，必须对其他组织公开可读
test("marks synced builtin skills as public readable", async () => {
  const listBuiltinSkillIds = mock(async () => ["skill_a", "skill_b"]);
  const setPublicReadable = mock(async () => {});

  await syncBuiltinSkillsToSystemAdmin(
    { organizationId: "org_admin", userId: "user_admin", role: "owner" },
    { listBuiltinSkillIds, setPublicReadable },
  );

  expect(setPublicReadable).toHaveBeenCalledTimes(2);
  expect(setPublicReadable.mock.calls[0]?.[0]).toBe("skill_a");
  expect(setPublicReadable.mock.calls[1]?.[0]).toBe("skill_b");
});
```

- [x] **步骤 3：运行测试确认还没有新的入口和公开逻辑**

运行：`bun test src/__tests__/meta-agent.test.ts`
预期：FAIL，提示 `syncBuiltin` / `syncBuiltinSkillsToSystemAdmin` 不存在，或同步后未设置公开读

- [x] **步骤 4：在 `meta-agent.ts` 中拆出启动入口与系统 admin 同步函数**

```ts
export async function syncBuiltin(): Promise<void> {
  const admin = await ensureSystemAdmin();
  await syncBuiltinSkillsToSystemAdmin({
    organizationId: admin.organization.id,
    userId: admin.userId,
    role: "owner",
  });
}

export async function syncBuiltinSkillsToSystemAdmin(
  ctx: AuthContext,
  deps = {
    listBuiltinSkillIds: async () => {
      const ids: string[] = [];
      for (const builtin of scanBuiltinSkills()) {
        const row = await getSkill(ctx, builtin.name);
        if (row?.id) ids.push(row.id);
      }
      return ids;
    },
    setPublicReadable: async (skillId: string) => {
      await setPublicRead(ctx, "skill", ctx.organizationId, skillId, true);
    },
  },
): Promise<void> {
  await syncBuiltinSkills(ctx);
  for (const skillId of await deps.listBuiltinSkillIds()) {
    await deps.setPublicReadable(skillId);
  }
}
```

- [x] **步骤 5：移除 `ensureMetaConfig()` 对业务组织的隐式 builtin 副作用**

```ts
async function ensureMetaConfig(ctx: AuthContext): Promise<string> {
  let agentConfig = await getAgentConfig(ctx, META_AGENT_CONFIG_NAME);
  if (!agentConfig) {
    // ...创建逻辑保持不变
  }

  const skillIds: string[] = [];
  for (const builtin of scanBuiltinSkills()) {
    const existing = await getSkill(ctx, builtin.name);
    if (existing?.id) skillIds.push(existing.id);
  }
  await syncAgentSkills(agentConfig.id, skillIds);
  return agentConfig.id;
}
```

- [x] **步骤 6：运行测试确认 builtin 统一托管逻辑通过**

运行：`bun test src/__tests__/meta-agent.test.ts`
预期：PASS，启动入口只同步 admin 组织，且 builtin skill 被标记为公开可读

- [x] **步骤 7：Commit**

```bash
git add src/services/meta-agent.ts src/__tests__/meta-agent.test.ts
git commit -m "feat(meta-agent): 统一托管 builtin skill 到系统组织"
```

---

### 任务 4：改启动顺序，移除“遍历所有组织复制 builtin skill”

**文件：**
- 修改：`src/index.ts`
- 测试：`src/__tests__/meta-agent.test.ts`
- 测试：`src/__tests__/system-admin.test.ts`

- [x] **步骤 1：先写失败测试，锁定启动只调用一次 `syncBuiltin()`**

```ts
import { describe, expect, mock, test } from "bun:test";

describe("startup builtin sync", () => {
  // 启动阶段 builtin 只应统一同步一次，不能再遍历 member 表给每个组织复制副本
  test("invokes syncBuiltin once instead of syncing per organization", async () => {
    const syncBuiltin = mock(async () => {});
    await startBootSequence({ syncBuiltin });
    expect(syncBuiltin).toHaveBeenCalledTimes(1);
  });
});
```

- [x] **步骤 2：运行测试确认 index 仍然依赖 member 表循环**

运行：`bun test src/__tests__/meta-agent.test.ts src/__tests__/system-admin.test.ts`
预期：FAIL，启动链路仍需 `member` 表遍历，或不存在可测试的 boot helper

- [x] **步骤 3：在 `index.ts` 中切换启动顺序**

```ts
await initDb();
startupLog.info("Database initialized");

const systemAdmin = await ensureSystemAdmin();
startupLog.info(`System admin ready: ${systemAdmin.email}`);

await runDataMigrations();
startupLog.info("Data migrations completed");

await syncBuiltin();
startupLog.info("Builtin resources synced");
```

- [x] **步骤 4：删除旧的 member 遍历同步逻辑**

```ts
// 删除这整段：查询 member 表、按 organizationId 去重、循环调用 syncBuiltinSkills(ctx)
// 启动时不再为每个组织复制 builtin skill
```

- [x] **步骤 5：运行测试确认启动期只走系统入口**

运行：`bun test src/__tests__/meta-agent.test.ts src/__tests__/system-admin.test.ts`
预期：PASS，启动不再依赖 member 表同步 builtin skill

- [x] **步骤 6：Commit**

```bash
git add src/index.ts src/__tests__/meta-agent.test.ts src/__tests__/system-admin.test.ts
git commit -m "refactor(startup): 改为系统级 builtin 同步入口"
```

---

### 任务 5：做一轮端到端验证并清理文档/日志细节

**文件：**
- 修改：`src/services/system-admin.ts`
- 修改：`src/services/meta-agent.ts`
- 修改：`src/index.ts`
- 测试：`src/__tests__/system-admin.test.ts`
- 测试：`src/__tests__/meta-agent.test.ts`

- [x] **步骤 1：补日志细节，确保首次创建和跳过分支都可追踪**

```ts
if (existing) {
  log(`[system-admin] Skip bootstrap: ${SYSTEM_ADMIN_EMAIL} already exists`);
  return { created: false, userId: existing.id, email: SYSTEM_ADMIN_EMAIL, organization: { id: "", slug: "admin" } };
}

log(`[system-admin] Created system admin ${SYSTEM_ADMIN_EMAIL} and wrote password file to ${config.systemAdminPasswordFile}`);
log(`[meta-agent] Builtin skills hosted under admin organization ${ctx.organizationId}`);
```

- [x] **步骤 2：运行后端相关测试**

运行：`bun test src/__tests__/system-admin.test.ts src/__tests__/meta-agent.test.ts src/__tests__/skill-resource-access.test.ts`
预期：PASS，系统 admin 初始化、builtin 同步、外部共享 skill 读取全部通过

- [x] **步骤 3：运行类型检查**

运行：`bunx tsc --noEmit`
预期：PASS，没有新的类型错误

- [x] **步骤 4：运行提交前检查**

运行：`bun run precheck`
预期：PASS，Biome、TypeScript、前端类型检查全部通过

- [x] **步骤 5：Commit**

```bash
git add src/services/system-admin.ts src/services/meta-agent.ts src/index.ts src/__tests__/system-admin.test.ts src/__tests__/meta-agent.test.ts src/env.ts src/config.ts
git commit -m "feat(system): 托管 builtin skill 到系统 admin 组织"
```
