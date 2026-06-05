# Launch Spec Refactor 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 重构实例启动配置链路，强制要求 `environment.agentConfigId` 存在，删除 `getAgentFullConfig` 聚合层，并在 `buildLaunchSpec` 中按 `agentConfig` 精准取数且对缺失配置直接失败。

**架构：** 保留 `spawnInstanceFromEnvironment -> buildLaunchSpec` 两层结构，但移除中间的 `aggregate full config` 半成品数据模型。`instance.ts` 负责环境与 agentConfig 入口校验，`launch-spec-builder.ts` 负责按 agentConfig 直接查询 provider、skill、MCP、knowledge 并构造最终 `AgentLaunchSpec`。所有关键资源解析失败都统一记录日志并抛出 `AppError("INVALID_CONFIG")`。

**技术栈：** TypeScript、Bun test、Drizzle ORM、Elysia、Biome

---

## 文件结构

**创建：**
- `src/__tests__/launch-spec-builder-errors.test.ts`
  - 覆盖无 `agentConfigId`、缺 model、缺 provider、缺 skill、非法 MCP 等直接失败路径。

**修改：**
- `src/services/instance.ts`
  - 删除无 `agentConfigId` 的 fallback 启动分支。
  - 删除 `getAgentFullConfig`、`validateLaunchSpecResources` 相关依赖。
  - 改为只读取 `agentConfig` 并调用新的 `buildLaunchSpec` 入参结构。
- `src/services/launch-spec-builder.ts`
  - 删除 `AgentFullConfig` 输入模式。
  - 在 builder 内直接按 `agentConfig` 精准取数并严格校验。
  - 去掉所有 fallback / continue / skip 的静默容错。
- `src/services/config/index.ts`
  - 删除 `getAgentFullConfig` 导出。
- `src/__tests__/launch-spec-agent-sharing-access.test.ts`
  - 去掉对 `getAgentFullConfig` 的断言，改为围绕新的 `buildLaunchSpec` 直接取数行为断言。
- `src/__tests__/launch-spec-mcp-resource-access.test.ts`
  - 删除 `getAgentFullConfig(null)` 相关测试，改为 builder 严格失败或严格翻译测试。

**删除：**
- `src/services/config/aggregate.ts`
  - 彻底移除半成品聚合层。

---

### 任务 1：先锁定失败语义和入口约束

**文件：**
- 修改：`src/services/instance.ts`
- 测试：`src/__tests__/launch-spec-builder-errors.test.ts`

- [ ] **步骤 1：编写无 `agentConfigId` 时失败的测试**

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { spawnInstanceFromEnvironment } from "../services/instance";
import { environmentRepo } from "../repositories";
import { resetAllStubs } from "../test-utils/helpers";

describe("spawnInstanceFromEnvironment errors", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // 没绑定 agentConfig 的 environment 应直接报配置错误，而不是进入默认 general fallback
  test("environment missing agentConfigId throws INVALID_CONFIG", async () => {
    environmentRepo.getById = async () =>
      ({
        id: "env_1",
        name: "demo",
        description: null,
        workspacePath: "/tmp/demo",
        agentConfigId: null,
        secret: "sec_1",
        machineName: null,
        directory: null,
        branch: null,
        gitRepoUrl: null,
        maxSessions: 1,
        workerType: "acp",
        capabilities: null,
        status: "idle",
        username: null,
        userId: "user_1",
        organizationId: "org_1",
        autoStart: true,
        lastPollAt: null,
        createdAt: new Date("2026-06-05T00:00:00.000Z"),
        updatedAt: new Date("2026-06-05T00:00:00.000Z"),
      }) as never;

    await expect(spawnInstanceFromEnvironment("user_1", "env_1")).rejects.toMatchObject<AppError>({
      code: "INVALID_CONFIG",
      message: "Environment has no agentConfig bound",
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test src/__tests__/launch-spec-builder-errors.test.ts`
预期：FAIL，报错表明 `spawnInstanceFromEnvironment` 仍然走了默认分支，没有抛出 `INVALID_CONFIG`

- [ ] **步骤 3：在 `instance.ts` 实现无 `agentConfigId` 直接失败**

```ts
if (!env.agentConfigId) {
  logError(
    `[instance] spawnInstanceFromEnvironment: environmentId='${environmentId}' missing agentConfigId, org='${env.organizationId ?? ""}', user='${userId}'`,
  );
  throw new AppError("Environment has no agentConfig bound", "INVALID_CONFIG", 400);
}

const accessCtx = { organizationId: env.organizationId ?? "", userId, role: "owner" as const };
const resolvedAgentConfig = await getReadableAgentConfigById(accessCtx, env.agentConfigId);
if (!resolvedAgentConfig) {
  logError(
    `[instance] spawnInstanceFromEnvironment: agentConfigId='${env.agentConfigId}' not found for environmentId='${environmentId}'`,
  );
  throw new NotFoundError(`AgentConfig '${env.agentConfigId}' not found`);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test src/__tests__/launch-spec-builder-errors.test.ts`
预期：PASS，测试显示无 `agentConfigId` 时直接抛出 `INVALID_CONFIG`

- [ ] **步骤 5：Commit**

```bash
git add src/services/instance.ts src/__tests__/launch-spec-builder-errors.test.ts
git commit -m "test(instance): 明确无 agentConfig 启动失败"
```

### 任务 2：移除 `getAgentFullConfig`，收缩 `instance.ts` 到最小输入

**文件：**
- 修改：`src/services/instance.ts`
- 修改：`src/services/config/index.ts`
- 删除：`src/services/config/aggregate.ts`
- 测试：`src/__tests__/launch-spec-agent-sharing-access.test.ts`
- 测试：`src/__tests__/launch-spec-mcp-resource-access.test.ts`

- [ ] **步骤 1：编写接口迁移测试，禁止旧聚合层参与 builder**

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { buildLaunchSpec } from "../services/launch-spec-builder";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

describe("buildLaunchSpec direct resolution", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // buildLaunchSpec 必须直接依赖 agentConfig，而不是依赖 fullConfig 半成品聚合结果
  test("buildLaunchSpec resolves provider and MCP directly from agentConfig", async () => {
    let selectCount = 0;
    stubDb({
      select: () => ({
        from: () => ({
          where: () => {
            selectCount += 1;
            if (selectCount === 1) {
              return Promise.resolve([
                {
                  id: "prov_source",
                  userId: "user_source",
                  organizationId: "org_source",
                  name: "openai",
                  displayName: "OpenAI",
                  protocol: "openai",
                  baseUrl: "https://source.example.com",
                  apiKey: "source-key",
                  extraOptions: {},
                  createdAt: new Date("2026-06-05T00:00:00.000Z"),
                  updatedAt: new Date("2026-06-05T00:00:00.000Z"),
                },
              ]);
            }
            return Promise.resolve([]);
          },
        }),
      }),
    });

    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      environmentId: "env_shared",
      environmentSecret: "secret",
      extraEnv: {},
      agentConfig: {
        id: "agc_external",
        userId: "user_source",
        organizationId: "org_source",
        name: "shared-agent",
        prompt: "shared prompt",
        model: "org_source/prov_source/shared-model",
        steps: 10,
        mode: "primary",
        permission: null,
        variant: null,
        temperature: null,
        topP: null,
        disable: false,
        hidden: false,
        color: null,
        description: null,
        knowledge: null,
        machineId: null,
        createdAt: new Date("2026-06-05T00:00:00.000Z"),
        updatedAt: new Date("2026-06-05T00:00:00.000Z"),
        resourceAccess: {
          ownership: "shared",
          sourceOrganizationId: "org_source",
          sourceOrganizationName: "Source Team",
          resourceUid: "agc_external",
          resourceKey: "org_source/agc_external",
          manageable: false,
          writable: false,
          publicReadable: true,
        },
      },
    });

    expect(spec.model).toMatchObject({
      provider: "openai",
      baseUrl: "https://source.example.com",
      apiKey: "source-key",
      model: "shared-model",
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test src/__tests__/launch-spec-agent-sharing-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts`
预期：FAIL，报错显示测试仍依赖 `getAgentFullConfig` 或 `buildLaunchSpec` 入参仍要求 `fullConfig`

- [ ] **步骤 3：删除聚合层并改 `instance.ts` 调用签名**

```ts
const launchSpec = await buildLaunchSpec({
  organizationId: env.organizationId ?? userId,
  userId: env.userId ?? userId,
  environmentId,
  environmentSecret: env.secret,
  extraEnv: mergedExtraEnv,
  agentConfig: resolvedAgentConfig,
});
```

```ts
export {
  AGENT_SETTABLE_FIELDS,
  assertAgentConfigInternalWritable,
  createAgentConfig,
  deleteAgentConfig,
  getAgentConfig,
  getAgentConfigById,
  getAgentConfigByResourceKey,
  getReadableAgentConfigById,
  isBuiltInAgent,
  listAgentConfigs,
  normalizeKnowledgeConfig,
  toolsToPermission,
  updateAgentConfig,
  validateAgentData,
} from "./agent-config";
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test src/__tests__/launch-spec-agent-sharing-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts`
预期：PASS，测试不再引用 `getAgentFullConfig`，`buildLaunchSpec` 直接消费 `agentConfig`

- [ ] **步骤 5：Commit**

```bash
git add src/services/instance.ts src/services/config/index.ts src/__tests__/launch-spec-agent-sharing-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts
git rm src/services/config/aggregate.ts
git commit -m "refactor(instance): 删除 agent full config 聚合层"
```

### 任务 3：在 `buildLaunchSpec` 中按 `agentConfig` 精准取 model / skill / MCP / knowledge

**文件：**
- 修改：`src/services/launch-spec-builder.ts`
- 测试：`src/__tests__/launch-spec-agent-sharing-access.test.ts`
- 测试：`src/__tests__/launch-spec-mcp-resource-access.test.ts`

- [ ] **步骤 1：编写 builder 直接取数的失败测试**

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { buildLaunchSpec } from "../services/launch-spec-builder";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

describe("buildLaunchSpec strict resolution", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // agentConfig.model 缺失时应在 builder 直接失败，而不是 fallback 到硬编码 gpt-4o
  test("missing modelRef throws INVALID_CONFIG", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    });

    await expect(
      buildLaunchSpec({
        organizationId: "org_1",
        userId: "user_1",
        environmentId: "env_1",
        environmentSecret: "sec_1",
        extraEnv: {},
        agentConfig: {
          id: "agc_1",
          userId: "user_1",
          organizationId: "org_1",
          name: "demo",
          prompt: null,
          model: null,
          steps: 10,
          mode: "primary",
          permission: null,
          variant: null,
          temperature: null,
          topP: null,
          disable: false,
          hidden: false,
          color: null,
          description: null,
          knowledge: null,
          machineId: null,
          createdAt: new Date("2026-06-05T00:00:00.000Z"),
          updatedAt: new Date("2026-06-05T00:00:00.000Z"),
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org_1",
            sourceOrganizationName: "Org 1",
            resourceUid: "agc_1",
            resourceKey: "org_1/agc_1",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
        },
      }),
    ).rejects.toMatchObject<AppError>({
      code: "INVALID_CONFIG",
      message: "AgentConfig 'agc_1' has no model configured",
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test src/__tests__/launch-spec-builder-errors.test.ts src/__tests__/launch-spec-agent-sharing-access.test.ts`
预期：FAIL，报错表明 `resolveModelConfig()` 仍然会 fallback 到硬编码默认模型

- [ ] **步骤 3：在 builder 中实现精准取数与强校验**

```ts
function assertModelRef(agentConfig: AgentConfigDetailWithAccess): string {
  if (!agentConfig.model) {
    logError(
      `[launch-spec-builder] buildLaunchSpec: agentConfig='${agentConfig.id}' missing modelRef, org='${agentConfig.organizationId}'`,
    );
    throw new AppError(`AgentConfig '${agentConfig.id}' has no model configured`, "INVALID_CONFIG", 400);
  }
  return agentConfig.model;
}

async function loadBoundSkills(agentConfigId: string) {
  const bindings = await db
    .select({ skillId: agentConfigSkill.skillId })
    .from(agentConfigSkill)
    .where(eq(agentConfigSkill.agentConfigId, agentConfigId));

  if (bindings.length === 0) return [];

  const skillIds = bindings.map((binding) => binding.skillId);
  const skillRows = await db.select().from(skill).where(inArray(skill.id, skillIds));
  if (skillRows.length !== skillIds.length) {
    logError(
      `[launch-spec-builder] buildLaunchSpec: agentConfig='${agentConfigId}' missing skill rows, expected=${JSON.stringify(skillIds)}, actual=${JSON.stringify(skillRows.map((row) => row.id))}`,
    );
    throw new AppError(`AgentConfig '${agentConfigId}' references missing skills`, "INVALID_CONFIG", 400);
  }
  return skillRows;
}
```

```ts
const modelRef = assertModelRef(agentConfig);
const providerRow = await loadProviderForModelRef(agentConfig.organizationId, modelRef);
const skillRows = await loadBoundSkills(agentConfig.id);
const mcpRows = await loadEnabledMcpServers(agentConfig.organizationId);
const knowledgeBindings = await listAgentKnowledgeBindingsById(agentConfig.id);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test src/__tests__/launch-spec-builder-errors.test.ts src/__tests__/launch-spec-agent-sharing-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts`
预期：PASS，builder 直接查表并严格解析，不再依赖 `fullConfig`

- [ ] **步骤 5：Commit**

```bash
git add src/services/launch-spec-builder.ts src/__tests__/launch-spec-builder-errors.test.ts src/__tests__/launch-spec-agent-sharing-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts
git commit -m "refactor(launch-spec): 按 agentConfig 精准解析启动资源"
```

### 任务 4：删除所有 fallback / silent skip，统一配置错误日志与异常

**文件：**
- 修改：`src/services/launch-spec-builder.ts`
- 修改：`src/services/instance.ts`
- 测试：`src/__tests__/launch-spec-builder-errors.test.ts`

- [ ] **步骤 1：编写非法配置不再静默跳过的测试**

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { buildLaunchSpec } from "../services/launch-spec-builder";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

describe("buildLaunchSpec invalid config handling", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // 非法 MCP 配置应直接中断启动，而不是写日志后 continue
  test("invalid MCP config throws INVALID_CONFIG", async () => {
    let selectCount = 0;
    stubDb({
      select: () => ({
        from: () => ({
          where: async () => {
            selectCount += 1;
            if (selectCount === 1) {
              return [
                {
                  id: "prov_1",
                  userId: "user_1",
                  organizationId: "org_1",
                  name: "openai",
                  displayName: "OpenAI",
                  protocol: "openai",
                  baseUrl: "https://api.example.com",
                  apiKey: "key_1",
                  extraOptions: {},
                  createdAt: new Date("2026-06-05T00:00:00.000Z"),
                  updatedAt: new Date("2026-06-05T00:00:00.000Z"),
                },
              ];
            }
            if (selectCount === 2) return [];
            return [
              {
                id: "mcp_bad",
                userId: "user_1",
                organizationId: "org_1",
                name: "broken",
                type: "remote",
                config: "{bad-json}",
                enabled: true,
                createdAt: new Date("2026-06-05T00:00:00.000Z"),
                updatedAt: new Date("2026-06-05T00:00:00.000Z"),
              },
            ];
          },
        }),
      }),
    });

    await expect(
      buildLaunchSpec({
        organizationId: "org_1",
        userId: "user_1",
        environmentId: "env_1",
        environmentSecret: "sec_1",
        extraEnv: {},
        agentConfig: {
          id: "agc_1",
          userId: "user_1",
          organizationId: "org_1",
          name: "demo",
          prompt: null,
          model: "openai/gpt-4o",
          steps: 10,
          mode: "primary",
          permission: null,
          variant: null,
          temperature: null,
          topP: null,
          disable: false,
          hidden: false,
          color: null,
          description: null,
          knowledge: null,
          machineId: null,
          createdAt: new Date("2026-06-05T00:00:00.000Z"),
          updatedAt: new Date("2026-06-05T00:00:00.000Z"),
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org_1",
            sourceOrganizationName: "Org 1",
            resourceUid: "agc_1",
            resourceKey: "org_1/agc_1",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
        },
      }),
    ).rejects.toMatchObject<AppError>({
      code: "INVALID_CONFIG",
      message: "MCP server 'broken' has invalid config",
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bun test src/__tests__/launch-spec-builder-errors.test.ts`
预期：FAIL，当前实现仍会跳过无效 MCP 或 skill 打包错误

- [ ] **步骤 3：把所有 fallback / continue 改为记录日志并抛错**

```ts
if (!modelRef) {
  logError(`[launch-spec-builder] buildLaunchSpec: agentConfig='${agentConfig.id}' missing modelRef`);
  throw new AppError(`AgentConfig '${agentConfig.id}' has no model configured`, "INVALID_CONFIG", 400);
}
```

```ts
try {
  raw = typeof server.config === "string" ? JSON.parse(server.config) : (server.config as Record<string, unknown>);
} catch (err) {
  logError(`[launch-spec-builder] Invalid MCP JSON config for '${server.name}':`, err);
  throw new AppError(`MCP server '${server.name}' has invalid config`, "INVALID_CONFIG", 400);
}
```

```ts
if (isSkillStale(sourceDir, archivePath)) {
  if (!existsSync(sourceDir)) {
    logError(`[launch-spec-builder] Skill source directory missing: ${s.name} (${sourceDir})`);
    throw new AppError(`Skill '${s.name}' source directory is missing`, "INVALID_CONFIG", 400);
  }
  const { buildSkillArchive } = await import("./skill-fs");
  await buildSkillArchive(sourceDir, archivePath);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bun test src/__tests__/launch-spec-builder-errors.test.ts`
预期：PASS，所有配置错误都直接失败且不再静默降级

- [ ] **步骤 5：Commit**

```bash
git add src/services/launch-spec-builder.ts src/services/instance.ts src/__tests__/launch-spec-builder-errors.test.ts
git commit -m "fix(launch-spec): 去除启动配置静默 fallback"
```

### 任务 5：全量回归并清理旧断言

**文件：**
- 修改：`src/__tests__/launch-spec-agent-sharing-access.test.ts`
- 修改：`src/__tests__/launch-spec-mcp-resource-access.test.ts`
- 修改：`src/__tests__/relay-handler-machine.test.ts`

- [ ] **步骤 1：更新仍依赖旧语义的测试**

```ts
// 旧测试：允许 agentConfigId 为 null 并继续 buildLaunchSpec
// 新测试：relay / instance 路径下如果 environment.agentConfigId 为空，应在启动阶段直接失败
test("spawnInstanceFromEnvironment missing agentConfigId fails fast", async () => {
  await expect(spawnInstanceFromEnvironment("user_1", "env_1")).rejects.toMatchObject({
    code: "INVALID_CONFIG",
  });
});
```

- [ ] **步骤 2：运行相关测试验证失败**

运行：`bun test src/__tests__/launch-spec-agent-sharing-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts src/__tests__/relay-handler-machine.test.ts`
预期：FAIL，旧断言仍假设 `agentConfigId: null` 可以参与 build 或 relay 初始化

- [ ] **步骤 3：调整测试数据和断言以匹配新语义**

```ts
const spec = await buildLaunchSpec({
  organizationId: "org_source",
  userId: "user_source",
  environmentId: "env_shared",
  environmentSecret: "secret",
  extraEnv: {},
  agentConfig: sharedAgentConfig,
});

expect(spec.agent).toEqual({
  name: "shared-agent",
  prompt: "shared prompt",
});
expect(spec.model.model).toBe("shared-model");
expect(spec.mcpServers[0]?.name).toBe("external-enabled");
```

- [ ] **步骤 4：运行回归测试验证通过**

运行：`bun test src/__tests__/launch-spec-builder-errors.test.ts src/__tests__/launch-spec-agent-sharing-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts src/__tests__/relay-handler-machine.test.ts`
预期：PASS，所有断言与新失败前置语义一致

运行：`bun run precheck`
预期：PASS，格式化、类型检查、Biome 检查全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/__tests__/launch-spec-builder-errors.test.ts src/__tests__/launch-spec-agent-sharing-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts src/__tests__/relay-handler-machine.test.ts
git commit -m "test(launch-spec): 更新严格启动配置回归用例"
```

---

## 自检结果

- 规格覆盖度：
  - 无 `agentConfigId` 直接失败：任务 1
  - 删除 `getAgentFullConfig`：任务 2
  - `buildLaunchSpec` 按 agentConfig 精准取数：任务 3
  - 去除 fallback / 吞错：任务 4
  - 更新回归测试与 precheck：任务 5
- 占位符扫描：
  - 已避免 `TODO` / “后续实现” / “补充细节”等空泛描述
  - 每个任务都包含具体文件、代码示例、测试命令和预期结果
- 类型一致性：
  - 全文统一使用 `agentConfig` 作为 `buildLaunchSpec` 新输入
  - 统一异常码为 `INVALID_CONFIG`
  - 不再混用 `fullConfig` / `default general` 旧语义
