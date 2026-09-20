import type { ResourceQueryConstraint } from "@fenix/platform-sdk";
import { mcpServer } from "@server/db/schema";
import { asc } from "drizzle-orm";
import type { McpServerRepository, McpServerRow, McpToolRow, ScopedMcpServerRow } from "../repositories/mcp-server";
import type { McpServerConfig, McpServerType } from "./config/mcp-config";
import { VALID_MCP_TYPES } from "./config/mcp-config";

/**
 * MCP Server 的领域服务。
 *
 * 只承载领域规则（资源键解析、类型归一、工具缓存的生命周期）与持久化编排；不接收 actor、不做任何
 * 权限判断——授权在 Facade 完成，受控读取把不透明的 `access` 条件原样交给仓储下推。
 *
 * 这里的每个方法都假定调用方已完成授权：Facade 是唯一的合法调用方，系统路径（`upsertSystemServer`）
 * 由宿主在系统初始化中调用，因此单独命名并单独注释，避免与受控创建路径混用。
 */

/** 资源键：`<organizationId>/<resourceId>`，跨组织可见资源的稳定定位方式。 */
export interface ParsedResourceKey {
  readonly organizationId: string;
  readonly resourceId: string;
}

/** 解析资源键；格式不合法返回 null（不是异常：路由把它当作"找不到该名称的资源"）。 */
export function parseMcpResourceKey(resourceKey: string): ParsedResourceKey | null {
  const slashIndex = resourceKey.indexOf("/");
  if (slashIndex <= 0 || slashIndex === resourceKey.length - 1) return null;
  return {
    organizationId: resourceKey.slice(0, slashIndex),
    resourceId: resourceKey.slice(slashIndex + 1),
  };
}

/** 从配置对象推导要写入 `type` 列的取值；配置未声明类型时保留原有取值。 */
export function resolveConfigType(config: unknown): McpServerType | undefined {
  if (typeof config !== "object" || config === null) return;
  const type = (config as Record<string, unknown>).type;
  if (typeof type !== "string") return;
  return VALID_MCP_TYPES.find((candidate) => candidate === type);
}

/** 受控读取的公共输入：`access` 必须是 Facade 产出的不透明条件。 */
export interface McpReadInput {
  readonly access: ResourceQueryConstraint;
  readonly limit?: number;
  readonly offset?: number;
}

export interface McpServerService {
  list(input: McpReadInput): Promise<{ items: readonly ScopedMcpServerRow[]; total: number }>;
  findById(input: { access: ResourceQueryConstraint; resourceId: string }): Promise<ScopedMcpServerRow | undefined>;
  findByName(input: {
    access: ResourceQueryConstraint;
    name: string;
    organizationId?: string;
  }): Promise<ScopedMcpServerRow | undefined>;
  findByResourceKey(input: {
    access: ResourceQueryConstraint;
    resourceKey: string;
  }): Promise<ScopedMcpServerRow | undefined>;
  /** 创建受控资源；名称冲突（同组织同名）返回 undefined，由 Facade 映射为 409。 */
  create(input: {
    name: string;
    type: string;
    config: McpServerConfig;
    organizationId: string;
    ownerUserId: string;
    visibility: string;
  }): Promise<string | undefined>;
  /**
   * 无授权读取单行。
   *
   * 命名里带 `Unscoped` 是为了让调用点在代码评审中一眼可见：它绕过授权谓词，只允许系统路径调用
   * （launch spec 构建按绑定表给出的 ID 取回 MCP 配置）。用户请求路径一律经 `findById`。
   */
  findRowUnscoped(resourceId: string): Promise<McpServerRow | undefined>;
  /**
   * 无授权按 ID 批量读取（launch spec 构建）；缺失的 ID 不出现在结果里，比对由调用方完成。
   */
  listRowsByIdsUnscoped(resourceIds: readonly string[]): Promise<readonly McpServerRow[]>;
  /** 系统托管资源的幂等写入（如 Hindsight MCP）；不做授权，只能由系统路径调用。 */
  upsertSystemServer(input: {
    name: string;
    type: string;
    config: McpServerConfig;
    organizationId: string;
    ownerUserId: string;
  }): Promise<string>;
  update(input: { resourceId: string; config: McpServerConfig }): Promise<boolean>;
  setEnabled(input: { resourceId: string; enabled: boolean }): Promise<boolean>;
  /** 删除资源及其缓存的 tools。 */
  remove(input: { resourceId: string; organizationId: string; serverName: string }): Promise<boolean>;
  countTools(input: { organizationId: string; serverName: string }): Promise<number>;
  listTools(input: { organizationId: string; serverName: string }): Promise<McpToolRow[]>;
  replaceTools(input: {
    organizationId: string;
    serverName: string;
    tools: readonly { name: string; description?: string; inputSchema?: unknown }[];
  }): Promise<void>;
}

export function createMcpServerService(repository: McpServerRepository): McpServerService {
  return {
    async list(input) {
      const page = await repository.listReadable({
        access: input.access,
        // 确定性排序：列表顺序属于对外可观测行为，不能依赖数据库的物理返回顺序。
        order: [asc(mcpServer.name)],
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
      });
      return { items: page.items, total: page.total ?? page.items.length };
    },

    async findById(input) {
      return repository.findReadableById({ resourceId: input.resourceId, access: input.access });
    },

    async findByName(input) {
      return repository.findReadableByName({
        name: input.name,
        access: input.access,
        ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
      });
    },

    async findByResourceKey(input) {
      const parsed = parseMcpResourceKey(input.resourceKey);
      if (!parsed) return;
      // 键里的组织必须与行的归属组织一致：否则 `orgA/<orgB 的资源 id>` 会读到别人的资源。
      return repository.findReadableByKey({
        organizationId: parsed.organizationId,
        resourceId: parsed.resourceId,
        access: input.access,
      });
    },

    async create(input) {
      return repository.insert(input);
    },

    async findRowUnscoped(resourceId) {
      // 无授权读取：调用方必须已自行完成权限校验（launch spec 构建等系统路径）。
      return repository.findByIdUnscoped({ resourceId });
    },

    async listRowsByIdsUnscoped(resourceIds) {
      return repository.listByIdsUnscoped({ resourceIds });
    },

    async upsertSystemServer(input) {
      const id = await repository.upsertByOrgAndName(input);
      if (!id) throw new Error(`系统托管 MCP server '${input.name}' 写入失败`);
      return id;
    },

    async update(input) {
      const type = resolveConfigType(input.config);
      return repository.updateById({
        resourceId: input.resourceId,
        patch: { config: input.config, ...(type === undefined ? {} : { type }) },
      });
    },

    async setEnabled(input) {
      return repository.setEnabledById(input);
    },

    async remove(input) {
      return repository.deleteWithTools(input);
    },

    countTools(input) {
      return repository.countTools(input);
    },

    listTools(input) {
      return repository.listTools(input);
    },

    replaceTools(input) {
      return repository.replaceTools(input);
    },
  };
}
