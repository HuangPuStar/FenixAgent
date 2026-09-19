import type { ResourceQueryConstraint } from "@fenix/platform-sdk";
import type { SQL } from "drizzle-orm";
import type {
  ProviderRepository,
  ProviderRow,
  ProviderWriteData,
  ScopedProviderRow,
} from "../repositories/provider-resource";

/**
 * Provider 资源行的领域服务。
 *
 * 只承载领域规则（资源键解析、受控读取与写入的编排）与持久化编排；不接收 actor、不做任何权限
 * 判断——授权在 Facade 完成，受控读取把不透明的 `access` 条件原样交给仓储下推。
 *
 * Model 子表没有自己的领域服务：它除"跟随父资源"之外没有任何领域规则（决策 D6：Provider 是唯一授权
 * 聚合根，Model 严格继承它的归属与动作集合），为它建一个只做转发的服务层只会多一层空壳。Facade 与
 * 系统路径（模型网关的模型投影同步）直接依赖 `ModelRepository`，先对 Provider 授权再落子表。
 *
 * 这里的每个方法都假定调用方已完成授权：Facade 是用户请求路径的唯一合法调用方；系统路径
 * （LaunchSpec 构建、模型网关 provider 同步）单独命名并单独注释。
 */

/** 资源键：`<organizationId>/<resourceId>`，跨组织可见资源的稳定定位方式。 */
export interface ParsedProviderResourceKey {
  readonly organizationId: string;
  readonly resourceId: string;
}

/** 解析资源键；格式不合法返回 null（不是异常：路由把它当作"找不到该名称的 Provider"）。 */
export function parseProviderResourceKey(resourceKey: string): ParsedProviderResourceKey | null {
  const slashIndex = resourceKey.indexOf("/");
  if (slashIndex <= 0 || slashIndex === resourceKey.length - 1) return null;
  return {
    organizationId: resourceKey.slice(0, slashIndex),
    resourceId: resourceKey.slice(slashIndex + 1),
  };
}

/** 受控读取的公共输入：`access` 必须是 Facade 产出的不透明条件。 */
export interface ProviderServiceReadInput {
  readonly access: ResourceQueryConstraint;
  /** 业务排序（下推到 ORDER BY）；由调用方从仓储导出的 `PROVIDER_LIST_ORDER` 选取。 */
  readonly order?: readonly SQL[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface ProviderService {
  list(input: ProviderServiceReadInput): Promise<{ items: readonly ScopedProviderRow[]; total: number }>;
  findById(input: { access: ResourceQueryConstraint; resourceId: string }): Promise<ScopedProviderRow | undefined>;
  findByName(input: {
    access: ResourceQueryConstraint;
    name: string;
    organizationId?: string;
  }): Promise<ScopedProviderRow | undefined>;
  findByResourceKey(input: {
    access: ResourceQueryConstraint;
    resourceKey: string;
  }): Promise<ScopedProviderRow | undefined>;
  /** 幂等创建；同组织同名冲突不抛错——冲突分支只更新可写列，归属列保持不变。 */
  create(input: {
    name: string;
    data: ProviderWriteData;
    organizationId: string;
    ownerUserId: string;
    visibility: string;
  }): Promise<string | undefined>;
  update(input: { resourceId: string; data: ProviderWriteData }): Promise<boolean>;
  /** 删除资源行；`model` 子表由外键 `ON DELETE CASCADE` 一并清理。 */
  remove(input: { resourceId: string }): Promise<boolean>;
  /**
   * 无授权读取单行。
   *
   * 命名里带 `Unscoped` 是为了让调用点在代码评审中一眼可见：它绕过授权谓词，只允许系统路径调用
   * （LaunchSpec 构建、模型网关 provider 同步）。用户请求路径一律经 `findById` / `findByName`。
   */
  findRowUnscoped(resourceId: string): Promise<ProviderRow | undefined>;
}

export function createProviderService(repository: ProviderRepository): ProviderService {
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
      const parsed = parseProviderResourceKey(input.resourceKey);
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
      return repository.removeById({ resourceId: input.resourceId });
    },

    async findRowUnscoped(resourceId) {
      return repository.findByIdUnscoped({ resourceId });
    },
  };
}
