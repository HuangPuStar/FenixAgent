import type { ResourceQueryConstraint } from "@fenix/platform-sdk";
import type { SQL } from "drizzle-orm";
import type {
  AgentConfigRepository,
  AgentConfigRow,
  AgentConfigWriteData,
  ScopedAgentConfigRow,
} from "../repositories/agent-config-resource";

/**
 * AgentConfig 资源行的领域服务。
 *
 * 只承载领域规则（资源键解析、受控读取与写入的编排）与持久化编排；不接收 actor、不做任何权限
 * 判断——授权在 Facade 完成，受控读取把不透明的 `access` 条件原样交给仓储下推。
 *
 * 关联资源（Skill / MCP / SiteApp / 知识库）不在这里：见 `agent-associations.ts`。两个模块的边界
 * 就是"资源行"与"绑定关系"，删除或重建资源行不会自动改动绑定表，回滚顺序由 Facade 决定。
 *
 * 这里的每个方法都假定调用方已完成授权：Facade 是用户请求路径的唯一合法调用方；系统路径
 * （LaunchSpec 构建、Observer 展示、acp-ws 归属解析）单独命名并单独注释。
 */

/** 资源键：`<organizationId>/<resourceId>`，跨组织可见资源的稳定定位方式。 */
export interface ParsedAgentConfigResourceKey {
  readonly organizationId: string;
  readonly resourceId: string;
}

/** 解析资源键；格式不合法返回 null（不是异常：路由把它当作"找不到该名称的资源"）。 */
export function parseAgentConfigResourceKey(resourceKey: string): ParsedAgentConfigResourceKey | null {
  const slashIndex = resourceKey.indexOf("/");
  if (slashIndex <= 0 || slashIndex === resourceKey.length - 1) return null;
  return {
    organizationId: resourceKey.slice(0, slashIndex),
    resourceId: resourceKey.slice(slashIndex + 1),
  };
}

/** 受控读取的公共输入：`access` 必须是 Facade 产出的不透明条件。 */
export interface AgentConfigReadInput {
  readonly access: ResourceQueryConstraint;
  /** 业务排序（下推到 ORDER BY）；由调用方从仓库导出的 `AGENT_CONFIG_LIST_ORDER` 选取。 */
  readonly order?: readonly SQL[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface AgentConfigService {
  list(input: AgentConfigReadInput): Promise<{ items: readonly ScopedAgentConfigRow[]; total: number }>;
  findById(input: { access: ResourceQueryConstraint; resourceId: string }): Promise<ScopedAgentConfigRow | undefined>;
  findByName(input: {
    access: ResourceQueryConstraint;
    name: string;
    organizationId?: string;
  }): Promise<ScopedAgentConfigRow | undefined>;
  findByResourceKey(input: {
    access: ResourceQueryConstraint;
    resourceKey: string;
  }): Promise<ScopedAgentConfigRow | undefined>;
  /** 幂等创建；同组织同名冲突不抛错——冲突分支只更新可写列，归属列保持不变。 */
  create(input: {
    name: string;
    data: AgentConfigWriteData;
    organizationId: string;
    ownerUserId: string;
    visibility: string;
  }): Promise<string | undefined>;
  update(input: { resourceId: string; data: AgentConfigWriteData }): Promise<boolean>;
  /** 删除资源行与其绑定 Environment（同一事务）；实例停止由 Facade 在此之前完成。 */
  remove(input: { resourceId: string; organizationId: string }): Promise<boolean>;
  /** 枚举绑定 Environment；停止实例与定位待重启实例都要用。 */
  listBoundEnvironmentIds(input: { resourceId: string; organizationId: string }): Promise<readonly string[]>;
  /**
   * 无授权读取单行；仅供已完成归属校验的系统路径使用（LaunchSpec 构建、Observer 展示、
   * acp-ws 归属解析）。
   *
   * 单独命名而不是复用受控入口：调用点必须显式写出 `Unscoped` 字样，代码评审时一眼可见这是
   * 绕过授权的路径，不会与「Facade 已授权后调用的领域方法」混在一起。
   */
  findRowUnscoped(resourceId: string): Promise<AgentConfigRow | undefined>;
  /**
   * 无授权按名称读取指定组织内的单行；供系统编排路径（meta AgentConfig 引导）与创建期唯一性预检
   * （`existsInOrganization`）使用。
   *
   * 与 {@link AgentConfigService.findRowUnscoped} 同属"读资源给用户看"之外的用途，但定位方式不同：
   * 名称只在组织内唯一，因此这里强制要求 `organizationId`，不会退化成跨组织按名查找。唯一性预检刻意
   * 不走授权入口：唯一性是主表约束而非授权事实，挂在授权上会让判定口径随动作声明漂移（详见仓储侧
   * `findByNameUnscoped` 的说明）。
   */
  findByNameUnscoped(input: { name: string; organizationId: string }): Promise<AgentConfigRow | undefined>;
}

export function createAgentConfigService(repository: AgentConfigRepository): AgentConfigService {
  return {
    async list(input) {
      const page = await repository.listReadable({
        access: input.access,
        ...(input.order === undefined ? {} : { order: input.order }),
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
      const parsed = parseAgentConfigResourceKey(input.resourceKey);
      if (!parsed) return;
      // 键里的组织必须与行的归属组织一致：否则 `orgA/<orgB 的资源 id>` 会读到别人的资源。
      return repository.findReadableByKey({
        organizationId: parsed.organizationId,
        resourceId: parsed.resourceId,
        access: input.access,
      });
    },

    async create(input) {
      return repository.create(input);
    },

    async update(input) {
      return repository.updateById({ resourceId: input.resourceId, data: input.data });
    },

    async remove(input) {
      return repository.removeWithEnvironments(input);
    },

    async listBoundEnvironmentIds(input) {
      return repository.listBoundEnvironmentIds(input);
    },

    async findRowUnscoped(resourceId) {
      return repository.findByIdUnscoped({ resourceId });
    },

    async findByNameUnscoped(input) {
      return repository.findByNameUnscoped(input);
    },
  };
}
