/** 根目录源码最终归属的模块 owner 清单。 */
export const ROOT_OWNERS = [
  "apps-server",
  "apps-web",
  "agent-runtime",
  "chat-channel",
  "resource-machine",
  "resource-sandbox",
  "model-management",
  "agent-config",
  "resource-knowledge",
  "platform-identity",
  "platform-access-control",
  "delete",
] as const;

/** 根目录源码最终归属的模块 owner。 */
export type RootOwner = (typeof ROOT_OWNERS)[number];

/** 未迁出的 apps/server 测试必须逐条说明其直接验证的宿主入口或跨领域边界。 */
export const RETAINED_HOST_TEST_RATIONALES: Readonly<Record<string, string>> = {
  "src/__tests__/agent-platform-api-reference.test.ts":
    "Agent Platform API 参考文档与 apps/server 路由契约的宿主一致性。",
  "src/__tests__/architecture-check.test.ts": "scripts/check-architecture.ts 对全仓 apps/server 分层约束的检查。",
  "src/__tests__/build-info.test.ts": "apps/server build-info 服务读取构建元数据的宿主入口。",
  "src/__tests__/capabilities-coalescing.test.ts": "服务端 capability 聚合的跨模块协议装配。",
  "src/__tests__/config-integration.test.ts": "apps/server config 集成、环境变量与持久化配置装配。",
  "src/__tests__/config-validators.test.ts": "apps/server config validator 的共享宿主配置契约。",
  "src/__tests__/data-migrate.test.ts": "apps/server data-migrate 启动迁移编排。",
  "src/__tests__/engine-type-schema.test.ts": "apps/server engine type 通用 schema 契约。",
  "src/__tests__/error-class-semantics.test.ts": "apps/server AppError 分类及 HTTP 错误语义。",
  "src/__tests__/error-handler.test.ts": "apps/server error-handler 插件及 Elysia 响应边界。",
  "src/__tests__/migrate-agent-config-model-id.test.ts": "apps/server 历史 agent-config model-id 数据迁移入口。",
  "src/__tests__/pagination-bounds.test.ts": "apps/server API 分页通用参数边界。",
  "src/__tests__/peri-task-detail-service.test.ts": "apps/server peri-task detail 跨服务投影装配。",
  "src/__tests__/phone-signup-route.test.ts": "apps/server phone signup 路由与 better-auth 插件集成。",
  "src/__tests__/round15-isolated-service-boundaries.test.ts": "apps/server service 边界隔离审计基线。",
  "src/__tests__/round16-isolated-protocol-boundaries.test.ts": "apps/server ACP/API 协议边界隔离审计基线。",
  "src/__tests__/round18-agent-config-model-migration-boundaries.test.ts":
    "agent-config model migration 与 apps/server 数据迁移边界。",
  "src/__tests__/round19-isolated-repository-boundaries.test.ts": "apps/server repository 分层边界审计基线。",
  "src/__tests__/round21-isolated-service-coverage.test.ts": "apps/server 服务覆盖率隔离审计基线。",
  "src/__tests__/round22-launch-spec-isolation.test.ts": "launchSpec 与 apps/server 启动装配隔离边界。",
  "src/__tests__/round29-cache-isolation.test.ts": "apps/server 缓存隔离与全局生命周期边界。",
  "src/__tests__/round37-service-boundaries.test.ts": "apps/server service 层依赖方向审计基线。",
  "src/__tests__/round45-auth-plugin.test.ts": "apps/server better-auth 插件注册与请求上下文。",
  "src/__tests__/round52-agent-model-migration.test.ts": "agent model migration 的 apps/server 数据兼容入口。",
  "src/__tests__/sanitize-execution-log.test.ts": "apps/server 执行日志脱敏的安全宿主边界。",
  "src/__tests__/structured-logger.test.ts": "apps/server structured logger 的进程级观测装配。",
  "src/__tests__/task-schema.test.ts": "apps/server task 通用 schema 与 API 参数契约。",
  "src/__tests__/test-openai-chat.sh": "apps/server OpenAI chat HTTP 入口的端到端脚本。",
  "src/__tests__/workspace-symlink-escape.test.ts": "apps/server workspace 文件 API 的 symlink 安全边界。",
};

type RootOwnerTask = `RMD-${number}`;
declare const NON_EMPTY_TARGET_ROOT: unique symbol;
type NonEmptyTargetRoot = string & { readonly [NON_EMPTY_TARGET_ROOT]: true };

/**
 * 删除规则不应声明迁移目标。
 */
export interface DeleteRootOwnerRule {
  prefix: string;
  owner: "delete";
  targetRoot: null;
  task: RootOwnerTask;
  targetPrefix: string;
}

/** 迁移规则必须指向一个非空的目标根目录。 */
export interface RelocateRootOwnerRule {
  prefix: string;
  owner: Exclude<RootOwner, "delete">;
  targetRoot: NonEmptyTargetRoot;
  task: RootOwnerTask;
  targetPrefix: string;
}

/** 后续根目录清单校验器使用的最长前缀匹配规则。 */
export type RootOwnerRule = DeleteRootOwnerRule | RelocateRootOwnerRule;

/** 最长前缀选择无法唯一决定最终 owner 时抛出的可诊断错误。 */
export class AmbiguousRootOwnerRuleError extends Error {
  /** 创建包含路径和竞争规则的歧义错误。 */
  constructor(
    readonly path: string,
    readonly competingRules: readonly RootOwnerRule[],
  ) {
    super(`根目录源码路径 ${path} 存在多个最长归属规则：${competingRules.map((rule) => rule.prefix).join(", ")}`);
    this.name = "AmbiguousRootOwnerRuleError";
  }
}

/** 为静态规则清单构造已验证的非空迁移目标。 */
function targetRoot(value: string): NonEmptyTargetRoot {
  if (value.length === 0) {
    throw new Error("root owner rule 的 targetRoot 不能为空");
  }

  return value as NonEmptyTargetRoot;
}

/** 根目录 `src/` 与 `web/` 源码的最终 owner 和迁移任务。 */
const ROOT_OWNER_RULES_BASE: readonly Omit<RootOwnerRule, "targetPrefix">[] = [
  {
    prefix: "src/.DS_Store",
    owner: "delete",
    targetRoot: null,
    task: "RMD-09",
  },
  {
    prefix: "web/dist/",
    owner: "delete",
    targetRoot: null,
    task: "RMD-09",
  },
  // Runtime、relay 和交互式 Chat 必须优先于 server 通用子族匹配。
  {
    prefix: "src/routes/acp/",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/routes/api/openai-chat.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/routes/api/instances.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/services/acp-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/services/agent-chat-service.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/services/agent-concurrency.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/services/environment",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/services/instance-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/services/orchestration-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/services/session.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/services/launch-spec-builder.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/transport/agent-node-bridge.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/transport/event-bus.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/schemas/acp.schema.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/schemas/environment.schema.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/schemas/instance.schema.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/schemas/openai-chat.schema.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/services/chat-channel-error-classify.ts",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "src/services/doc-manager-instance.ts",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },

  {
    prefix: "src/routes/api/workspaces.ts",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/routes/web/fs.ts",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/routes/web/registry.ts",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/routes/web/file-events.ts",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/schemas/file",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/schemas/registry.schema.ts",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/services/local-node-service.ts",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/services/event-service.ts",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },

  {
    prefix: "src/routes/api/sandbox",
    owner: "resource-sandbox",
    targetRoot: targetRoot("packages/resources/sandbox"),
    task: "RMD-03",
  },
  {
    prefix: "web/src/api/sandbox-pools.ts",
    owner: "resource-sandbox",
    targetRoot: targetRoot("packages/resources/sandbox"),
    task: "RMD-03",
  },
  {
    prefix: "web/src/api/system-sandbox.ts",
    owner: "resource-sandbox",
    targetRoot: targetRoot("packages/resources/sandbox"),
    task: "RMD-03",
  },
  {
    prefix: "web/src/pages/admin/",
    owner: "resource-sandbox",
    targetRoot: targetRoot("packages/resources/sandbox"),
    task: "RMD-03",
  },

  {
    prefix: "src/routes/api/models.ts",
    owner: "model-management",
    targetRoot: targetRoot("packages/resources/model-management"),
    task: "RMD-04",
  },
  {
    prefix: "src/routes/web/config/models.ts",
    owner: "model-management",
    targetRoot: targetRoot("packages/resources/model-management"),
    task: "RMD-04",
  },
  {
    prefix: "src/services/peri-task-",
    owner: "model-management",
    targetRoot: targetRoot("packages/resources/model-management"),
    task: "RMD-04",
  },
  {
    prefix: "web/src/pages/agent-panel/pages/Algorithm",
    owner: "model-management",
    targetRoot: targetRoot("packages/resources/model-management"),
    task: "RMD-04",
  },
  {
    prefix: "web/src/pages/agent-panel/components/Embedding",
    owner: "model-management",
    targetRoot: targetRoot("packages/resources/model-management"),
    task: "RMD-04",
  },
  {
    prefix: "src/services/meta-agent.ts",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-04",
  },
  {
    prefix: "src/schemas/meta-agent.schema.ts",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-04",
  },
  {
    prefix: "src/routes/web/sidebar-config.ts",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-04",
  },
  {
    prefix: "src/services/sidebar-config.ts",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-04",
  },
  {
    prefix: "web/src/api/meta-agent.ts",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-04",
  },
  {
    prefix: "web/src/api/sidebar-config.ts",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-04",
  },

  {
    prefix: "web/src/pages/agent-panel/components/Chunk",
    owner: "resource-knowledge",
    targetRoot: targetRoot("packages/resources/knowledge"),
    task: "RMD-05",
  },
  {
    prefix: "web/src/pages/agent-panel/components/Retrieval",
    owner: "resource-knowledge",
    targetRoot: targetRoot("packages/resources/knowledge"),
    task: "RMD-05",
  },
  {
    prefix: "web/components/ChatInterface.tsx",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "web/components/ACPMain.tsx",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "web/components/ContextPanel.tsx",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "web/src/pages/agent-panel/ChatArea.tsx",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "web/src/pages/agent-panel/chat-design-",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "web/src/pages/agent-panel/chat-layout.css",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "web/src/pages/agent-panel/chat-design.css",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "web/src/components/agent-panel/SiteFrame.tsx",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-05",
  },
  {
    prefix: "web/src/components/agent-panel/SiteTabsBar.tsx",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-05",
  },

  // RMD-06 的旧授权栈文件（仓储、协议 schema、3 个专项测试）在 CE 阶段 2 任务 1.2 被删除：
  // 新授权栈把归属收敛到资源主表的 `organization_id` + `visibility` 列，这些文件失去全部消费者。
  // 规则保留最近一次的 owner 以便追溯历史归属；`delete` 只用于 Finder 元数据与构建产物，不适用于此。
  {
    prefix: "src/repositories/resource-permission.ts",
    owner: "platform-access-control",
    targetRoot: targetRoot("packages/platform/access-control"),
    task: "RMD-06",
  },
  {
    prefix: "src/schemas/resource-access.schema.ts",
    owner: "platform-access-control",
    targetRoot: targetRoot("packages/platform/access-control"),
    task: "RMD-06",
  },
  // RMD-06 的 6 个 owner 目标在 CE 阶段 2 任务 1.2 之后再次变化：`control.ts` 先落宿主、
  // 1.5c 又归 agent-runtime（见本条的说明），`user.ts` / `ChangePasswordDialog.tsx` 随身份职责迁入
  // `packages/platform/identity`，`share-link.ts` 与 `token.ts` 因无任何调用方被删除。
  // `control.ts` 两次改判的完整依据：RMD-06 原计划迁入身份包；1.2 实施时改判为宿主路由，理由是它
  // 同时依赖 Agent Runtime 的会话服务与 Machine 的事件服务，放进任一模块都会与既有的
  // `resource-machine → agent-runtime` 形成环，只有宿主能同时持有两侧；1.4 W6b 把 EventBus 与
  // `environmentRepo` 收敛回 agent-runtime（Machine 的同名薄封装删除）后该前提消失，1.5c 按
  // review/task-1.5-host-aggregation.md §四 分片表迁入 agent-runtime——会话事件与状态、实例归属、
  // 环境组织归属三件事的 owner 本就在该包，路由自身没有跨领域依赖。
  {
    prefix: "src/routes/web/control.ts",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-06",
  },
  {
    prefix: "src/repositories/share-link.ts",
    owner: "platform-identity",
    targetRoot: targetRoot("packages/platform/identity"),
    task: "RMD-06",
  },
  {
    prefix: "src/repositories/token.ts",
    owner: "platform-identity",
    targetRoot: targetRoot("packages/platform/identity"),
    task: "RMD-06",
  },
  {
    prefix: "src/repositories/user.ts",
    owner: "platform-identity",
    targetRoot: targetRoot("packages/platform/identity"),
    task: "RMD-06",
  },
  {
    prefix: "web/components/ChangePasswordDialog.tsx",
    owner: "platform-identity",
    targetRoot: targetRoot("packages/platform/identity"),
    task: "RMD-06",
  },

  // 以下是不可再拆分到资源模块的宿主、共享协议和测试基础设施子族。
  {
    prefix: "src/__tests__/acp-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/agent-chat-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/agent-concurrency",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/agent-node-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/api-instance-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/environment-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/instance-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/launch-spec-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/openai-chat",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/openai-response",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/orchestration-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/session-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/transport-",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/external-relay",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/event-bus",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/doc-manager",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/api-agent-schema",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-04",
  },
  {
    prefix: "src/__tests__/sidebar-config-service",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-04",
  },
  {
    prefix: "src/__tests__/web-sidebar-config-routes",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-04",
  },
  {
    prefix: "src/__tests__/api-sandbox-schema",
    owner: "resource-sandbox",
    targetRoot: targetRoot("packages/resources/sandbox"),
    task: "RMD-03",
  },
  {
    prefix: "src/__tests__/api-sandbox-server",
    owner: "resource-sandbox",
    targetRoot: targetRoot("packages/resources/sandbox"),
    task: "RMD-03",
  },
  {
    prefix: "src/__tests__/fs-upload-escape",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/registry-filews-cleanup",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/registry-machine-stages",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/registry-routes-isolation",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/registry-routes",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/registry-schema",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/round19-registry-service-boundaries",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/round36-registry-service-coverage",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/round39-registry-service",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/round68-registry-heartbeat",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/instances-delete-idempotent",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/local-instance-death-cleanup",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/registry-environment-isolation-coverage",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/yjs-frontend-snapshot-persist",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/chat-channel-",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/extract-acp-event",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/round43-launch-spec-builder",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/round44-environments-routes",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/round44-launch-spec-builder-config",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/round45-environment-acp",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/machine-cleanup-node-dispatch",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "src/__tests__/fs-symlink-escape",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/local-node-service",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/registry-service",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/machine-",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "src/__tests__/sandbox-",
    owner: "resource-sandbox",
    targetRoot: targetRoot("packages/resources/sandbox"),
    task: "RMD-03",
  },
  {
    prefix: "src/__tests__/model-gateway-",
    owner: "model-management",
    targetRoot: targetRoot("packages/resources/model-management"),
    task: "RMD-04",
  },
  {
    prefix: "src/__tests__/meta-agent",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-04",
  },
  {
    prefix: "src/__tests__/resource-permission",
    owner: "platform-access-control",
    targetRoot: targetRoot("packages/platform/access-control"),
    task: "RMD-06",
  },
  {
    prefix: "src/__tests__/round23-resource-permission-isolation",
    owner: "platform-access-control",
    targetRoot: targetRoot("packages/platform/access-control"),
    task: "RMD-06",
  },
  {
    prefix: "src/__tests__/round64-resource-permission-repository",
    owner: "platform-access-control",
    targetRoot: targetRoot("packages/platform/access-control"),
    task: "RMD-06",
  },
  { prefix: "src/__tests__/", owner: "apps-server", targetRoot: targetRoot("apps/server"), task: "RMD-07" },
  { prefix: "src/errors/", owner: "apps-server", targetRoot: targetRoot("apps/server"), task: "RMD-07" },
  { prefix: "src/repositories/", owner: "apps-server", targetRoot: targetRoot("apps/server"), task: "RMD-07" },
  { prefix: "src/routes/api/", owner: "apps-server", targetRoot: targetRoot("apps/server"), task: "RMD-07" },
  { prefix: "src/routes/web/", owner: "apps-server", targetRoot: targetRoot("apps/server"), task: "RMD-07" },
  { prefix: "src/routes/hooks.ts", owner: "apps-server", targetRoot: targetRoot("apps/server"), task: "RMD-07" },
  { prefix: "src/schemas/", owner: "apps-server", targetRoot: targetRoot("apps/server"), task: "RMD-07" },
  { prefix: "src/services/", owner: "apps-server", targetRoot: targetRoot("apps/server"), task: "RMD-07" },
  { prefix: "src/transport/", owner: "apps-server", targetRoot: targetRoot("apps/server"), task: "RMD-07" },
  { prefix: "src/types/", owner: "apps-server", targetRoot: targetRoot("apps/server"), task: "RMD-07" },
  { prefix: "src/utils/", owner: "apps-server", targetRoot: targetRoot("apps/server"), task: "RMD-07" },
  { prefix: "src/main.ts", owner: "apps-server", targetRoot: targetRoot("apps/server"), task: "RMD-07" },

  { prefix: "web/components/", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
  {
    prefix: "web/src/__tests__/chat-",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "web/src/__tests__/acp-main-session-recovery",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "web/src/__tests__/message.ssr",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "web/src/__tests__/tool-semantic",
    owner: "agent-runtime",
    targetRoot: targetRoot("packages/agent-runtime"),
    task: "RMD-01",
  },
  {
    prefix: "web/src/__tests__/structured-to-thread",
    owner: "chat-channel",
    targetRoot: targetRoot("packages/chat-channel"),
    task: "RMD-01",
  },
  {
    prefix: "web/src/__tests__/file-",
    owner: "resource-machine",
    targetRoot: targetRoot("packages/resources/machine"),
    task: "RMD-02",
  },
  {
    prefix: "web/src/__tests__/agent-editor-model",
    owner: "model-management",
    targetRoot: targetRoot("packages/resources/model-management"),
    task: "RMD-04",
  },
  {
    prefix: "web/src/__tests__/agent-sidebar-config",
    owner: "agent-config",
    targetRoot: targetRoot("packages/resources/agent-config"),
    task: "RMD-04",
  },
  {
    prefix: "web/src/__tests__/context-panel",
    owner: "resource-knowledge",
    targetRoot: targetRoot("packages/resources/knowledge"),
    task: "RMD-05",
  },
  {
    prefix: "web/src/__tests__/token-",
    owner: "platform-identity",
    targetRoot: targetRoot("packages/platform/identity"),
    task: "RMD-06",
  },
  { prefix: "web/src/__tests__/", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
  { prefix: "web/src/api/", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
  { prefix: "web/src/components/", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
  { prefix: "web/src/hooks/", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
  { prefix: "web/src/i18n/", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
  { prefix: "web/src/lib/", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
  { prefix: "web/src/pages/agent-panel/", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
  { prefix: "web/src/pages/", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
  { prefix: "web/src/types/", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
  { prefix: "web/src/App.tsx", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
  { prefix: "web/src/vite-env.d.ts", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
  { prefix: "web/tsconfig.json", owner: "apps-web", targetRoot: targetRoot("apps/web"), task: "RMD-08" },
];

/** 为每条可审查的静态归属规则补齐迁移目标。消费者与测试入口从实际 import 图生成。 */
const TARGET_PREFIX_OVERRIDES: Readonly<Record<string, string>> = {
  "web/src/components/agent-panel/SiteFrame.tsx":
    "packages/resources/agent-config/web/components/agent-panel/SiteFrame.tsx",
  "web/src/components/agent-panel/SiteTabsBar.tsx":
    "packages/resources/agent-config/web/components/agent-panel/SiteTabsBar.tsx",
};

export const ROOT_OWNER_RULES: readonly RootOwnerRule[] = ROOT_OWNER_RULES_BASE.map((rule) => ({
  ...rule,
  targetPrefix:
    TARGET_PREFIX_OVERRIDES[rule.prefix] ??
    (rule.owner === "delete"
      ? ""
      : rule.owner === "apps-web"
        ? `apps/web/${rule.prefix.slice("web/".length)}`
        : `${rule.targetRoot}/${rule.prefix}`),
}));

/** 返回路径的最长匹配规则；没有归属规则时返回 `undefined`。 */
export function getMostSpecificRootOwnerRule(path: string): RootOwnerRule | undefined {
  const matches = ROOT_OWNER_RULES.filter((rule) => path === rule.prefix || path.startsWith(rule.prefix));
  const longestPrefixLength = Math.max(...matches.map((rule) => rule.prefix.length));
  const mostSpecificRules = matches.filter((rule) => rule.prefix.length === longestPrefixLength);

  if (mostSpecificRules.length > 1) {
    throw new AmbiguousRootOwnerRuleError(path, mostSpecificRules);
  }

  return mostSpecificRules[0];
}
