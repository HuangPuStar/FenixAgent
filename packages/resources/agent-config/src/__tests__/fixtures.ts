import type { ModelRow, ProviderRow } from "@fenix/model-management/server";
import { createModelService } from "@fenix/model-management/server";
import { createStubModelRepository, createStubProviderRepository } from "@fenix/model-management/server/testing";
import {
  type AccessControlModule,
  type ActorContext,
  type IdentityDirectory,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  type ResourceAccess,
  ResourceAccessDeniedError,
  type ResourceAction,
  type ResourceQueryConstraint,
  type ResourceScope,
  type ResourceScopeStore,
  type ResourceVisibility,
} from "@fenix/platform-sdk";
import type { McpServerRow } from "@fenix/resource-mcp/server";
import { createStubMcpServerService } from "@fenix/resource-mcp/server/testing";
import { createStubSkillService } from "@fenix/resource-skill/server/testing";
import { agentConfigResource } from "../server/access/agent-config-resource";
import type { AgentConfigFacadeApi, AuthorizedAgentConfig } from "../server/facades/agent-config-facade";
import type {
  UserAgentPreferencesPatch,
  UserAgentPreferencesPort,
  UserAgentPreferencesSnapshot,
  UserAgentPreferencesSubject,
} from "../server/ports/user-agent-preferences";
import type { AgentConfigRow, ScopedAgentConfigRow } from "../server/repositories/agent-config-resource";
import type { AgentAssociations } from "../server/services/agent-associations";
import type { AgentConfigService } from "../server/services/agent-config-service";
import type { AgentLaunchSpecAssemblerDeps } from "../server/services/agent-launch-spec";
import {
  createStubAgentAssociations,
  createStubAgentConfigFacade,
  createStubAgentConfigServerModule,
  createStubAgentConfigService,
  createStubIdentityDirectory,
  installAgentConfigModule,
  resetAgentConfigModuleForTesting,
} from "../server/testing";

/**
 * AgentConfig 协议层与 Facade 测试的公共 fixture。
 *
 * 位置说明：这些构造只服务测试，因此留在 `__tests__/`，不加入 `@fenix/agent-config/server/testing`
 * 的对外面；后者只导出"替身工厂"这类消费方也会复用的接缝。
 *
 * 与 mcp / skill 的 fixture 同形是有意的：四个资源包的协议层测试都按同一套接缝编写，读一个包的
 * 用例即可理解另一个包。
 */

/** 固定时间戳：让断言不依赖运行时刻。 */
export const FIXTURE_NOW = new Date("2026-09-01T00:00:00.000Z");

/** 构造可信主体；默认是 org-1 的 owner。 */
export function testActor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    kind: "user",
    userId: "user-1",
    activeOrganizationId: "org-1",
    memberships: [{ organizationId: "org-1", role: "owner" }],
    ...overrides,
  };
}

export interface AgentFixtureOptions {
  readonly id?: string;
  readonly name?: string;
  readonly organizationId?: string;
  readonly ownerUserId?: string;
  readonly visibility?: ResourceVisibility;
  readonly model?: string | null;
  readonly modelId?: string | null;
  readonly prompt?: string | null;
  readonly description?: string | null;
  readonly extra?: Record<string, unknown> | null;
  readonly agentNode?: unknown;
  readonly machineId?: string | null;
  readonly engineType?: string | null;
}

/** 构造带归属范围的资源行（Domain Service 的产出形状）。 */
export function scopedAgent(options: AgentFixtureOptions = {}): ScopedAgentConfigRow {
  const organizationId = options.organizationId ?? "org-1";
  const ownerUserId = options.ownerUserId ?? "user-1";
  const visibility = options.visibility ?? "private";
  const row: AgentConfigRow = {
    id: options.id ?? "agent-1",
    userId: ownerUserId,
    organizationId,
    name: options.name ?? "demo-agent",
    model: options.model ?? null,
    modelId: options.modelId ?? null,
    prompt: options.prompt ?? null,
    description: options.description ?? null,
    extra: options.extra ?? null,
    agentNode: options.agentNode ?? {},
    machineId: options.machineId ?? null,
    engineType: options.engineType ?? null,
    visibility,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
  };
  return { ...row, scope: { organizationId, ownerUserId, visibility } };
}

/** 构造带有效动作的资源行（Facade 的产出形状，`/web` 与 `/api` 视图的共同输入）。 */
export function authorizedAgent(
  options: AgentFixtureOptions & { readonly actions?: readonly ResourceAction[] } = {},
): AuthorizedAgentConfig {
  const row = scopedAgent(options);
  return { ...row, access: { actions: options.actions ?? ["read", "create", "update", "delete", "use"] } };
}

/** 装入资源模块替身；未打桩的方法调用即失败，避免路由调用了未预期的方法而断言失真。 */
export function installAgentModuleStub(
  deps: {
    readonly facade?: Partial<AgentConfigFacadeApi>;
    readonly service?: Partial<AgentConfigService>;
    readonly associations?: Partial<AgentAssociations>;
    readonly identity?: Partial<IdentityDirectory>;
  } = {},
): void {
  installAgentConfigModule(
    createStubAgentConfigServerModule({
      facade: createStubAgentConfigFacade(deps.facade),
      service: createStubAgentConfigService(deps.service),
      associations: createStubAgentAssociations(deps.associations),
      identity: createStubIdentityDirectory(deps.identity),
    }),
  );
}

/** 清除模块装配结果；测试结束必须调用，避免跨用例共享状态。 */
export function resetAgentModuleStub(): void {
  resetAgentConfigModuleForTesting();
}

/**
 * 当前用户的默认 Agent 偏好替身（迁移前宿主 `stubConfigPg` 的接缝，收窄为一个端口）。
 *
 * `user_config` 属身份族表，不由本包拥有：宿主经 {@link UserAgentPreferencesPort} 注入读写实现。
 * 路由实例在模块加载期构造，因此这里保持一份**可变实现**并让端口方法在请求期转发——用例才能在
 * `beforeEach` 里改变行为而不必重建路由。默认读「未设置默认 Agent」、写丢弃。
 */
let agentPreferences: {
  readonly read: (subject: UserAgentPreferencesSubject) => Promise<UserAgentPreferencesSnapshot>;
  readonly write: (subject: UserAgentPreferencesSubject, patch: UserAgentPreferencesPatch) => Promise<void>;
} = {
  read: async () => ({ defaultAgent: null }),
  write: async () => undefined,
};

/** 替换偏好读写实现；未提供的部分保持默认（读 null、写丢弃）。 */
export function stubAgentPreferences(overrides: Partial<typeof agentPreferences>): void {
  agentPreferences = {
    read: overrides.read ?? (async () => ({ defaultAgent: null })),
    write: overrides.write ?? (async () => undefined),
  };
}

/** 复位偏好替身；测试结束必须调用，避免写入断言泄漏到下一条用例。 */
export function resetAgentPreferences(): void {
  stubAgentPreferences({});
}

/** 构造测试用的偏好端口；方法在请求期读取当前替身实现。 */
export function createTestAgentPreferencesPort(): UserAgentPreferencesPort {
  return {
    read: (subject) => agentPreferences.read(subject),
    write: (subject, patch) => agentPreferences.write(subject, patch),
  };
}

/** 构造平台授权条件句柄；形状与 `DefaultAccessControl` 产出的条件一致（含私有载荷键）。 */
export function testListConstraint(action: "read" | "use" = "read"): ResourceQueryConstraint {
  return {
    resourceType: agentConfigResource.definition.type,
    action,
    provider: "test-access-control",
    [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: { action },
  };
}

/**
 * 授权实现替身：默认放行全部动作。
 *
 * Facade 用例只验证"授权编排"（何时调用、调用结果如何映射），权限规则本身由 `access-control` 的
 * 用例与谓词一致性 contract test 覆盖；因此这里默认全放行，拒绝路径由用例显式覆盖。
 */
export function createFakeAccessControl(overrides: Partial<AccessControlModule> = {}): AccessControlModule {
  const allActions: readonly ResourceAction[] = ["read", "create", "update", "delete", "use"];
  const access: ResourceAccess = { actions: allActions };
  return {
    id: "test-access-control",
    resolveInitialScope: async ({ actor }) => {
      if (actor.activeOrganizationId === undefined) {
        throw new ResourceAccessDeniedError("当前主体无权创建该资源");
      }
      return { organizationId: actor.activeOrganizationId, ownerUserId: actor.userId, visibility: "private" };
    },
    initializeResourceAccess: async () => undefined,
    authorize: async () => undefined,
    createListConstraint: async ({ action }) => testListConstraint(action),
    resolveAccess: async () => access,
    resolveAccessMany: async ({ resourceIds }) => new Map(resourceIds.map((id) => [id, access])),
    ...overrides,
  };
}

/** 构造并记录调用的 scope store 替身；`update` 的入参是 `visibility` 变更的断言点。 */
export function createRecordingScopeStore(initial: ResourceScope = { visibility: "private" }): {
  readonly store: ResourceScopeStore;
  readonly updates: ResourceScope[];
} {
  const updates: ResourceScope[] = [];
  return {
    store: {
      initialize: async () => undefined,
      getMany: async ({ resourceIds }) => new Map(resourceIds.map((id) => [id, initial])),
      update: async (input) => {
        updates.push(input.scope);
      },
      remove: async () => undefined,
    },
    updates,
  };
}

/**
 * 抛出平台授权拒绝错误（与实现抛出的类型一致），用来覆盖 Facade 的 403 映射。
 *
 * 返回类型是 `never`，因此可直接写成 `authorize: async () => denied()`。
 */
export function denied(): never {
  throw new ResourceAccessDeniedError("当前主体无权执行资源动作");
}

// ── 启动参数组装（`server/services/agent-launch-spec/`）的公共 fixture ──
//
// 该目录的四个用例文件（assembler / model-resolution / mcp-resolution / memory-env）都要构造同一份
// `AgentLaunchSpecAssemblerDeps`，以及指向同一批表（provider / model / mcp_server）的行替身。行构造器
// 集中在此，是为了让「模型行与 Provider 行长什么样」只有一份定义：它们随 model-management 的表结构
// 演进，分散到各用例文件里改漏一处，只有那一个文件会安静地失败。

/** Provider 行替身：默认是 openai 直连，`apiKey` 走 `{env:...}` 引用（解引用能力由宿主注入）。 */
export function providerRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: "provider-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "openai",
    displayName: "OpenAI",
    kind: "direct",
    gatewayType: null,
    protocol: "openai",
    baseUrl: "https://api.example.com",
    apiKey: "{env:PROVIDER_KEY}",
    extraOptions: null,
    visibility: "private",
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

/** 模型行替身：默认挂在 {@link providerRow} 的 Provider 上。 */
export function modelRow(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id: "model-1",
    providerId: "provider-1",
    organizationId: "org-1",
    modelId: "gpt-4o",
    displayName: "GPT-4o",
    modalities: null,
    limitConfig: null,
    cost: null,
    options: null,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

/** MCP 行替身：默认一条启用的 stdio 行；`config` 是结构体，字符串形态由用例自行构造。 */
export function mcpRow(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: "mcp-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "filesystem",
    type: "stdio",
    config: { type: "stdio", command: "npx", args: ["-y", "fs-mcp"] },
    enabled: true,
    visibility: "private",
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

/**
 * 组装依赖替身：默认一个已绑定 Provider 的模型、无 skill / MCP / 知识库绑定、Langfuse 三键齐全。
 *
 * 默认值刻意都是「能跑通」的一档：需要覆盖失败路径的用例改一项即可，不必从零搭一份 deps。
 * `resolveProviderApiKey` 复刻宿主 `resolveApiKey` 的真实语义：只认完整的 `{env:VAR}` 引用，解析不到
 * 返回 null（组装器再退化为空串）——写成"解析不到就把引用式原样返回"会让用例无法钉住这条边界。
 */
export function launchSpecDeps(overrides: Partial<AgentLaunchSpecAssemblerDeps> = {}): AgentLaunchSpecAssemblerDeps {
  return {
    associations: createStubAgentAssociations(),
    skills: createStubSkillService(),
    mcp: createStubMcpServerService(),
    models: createModelService({
      modelRepository: createStubModelRepository({ findRowUnscoped: async () => modelRow() }),
      providerRepository: createStubProviderRepository({
        findRowByOrganizationUnscoped: async () => providerRow(),
      }),
    }),
    env: {
      agentSystemPrompt: "你当前的 Agent 名称是「{{agentName}}」。",
      baseUrl: "https://platform.example.com",
      langfuse: { publicKey: "pk-1", secretKey: "sk-1", baseUrl: "https://lf.example.com" },
    },
    resolveProviderApiKey: (raw) => {
      if (raw === null) return null;
      const reference = /^\{env:([^}]+)\}$/.exec(raw);
      if (!reference) return raw;
      return reference[1] === "PROVIDER_KEY" ? "resolved-key" : null;
    },
    ...overrides,
  };
}
